// ─── EVM claim-on-demand staking rewards ──────────────────────────────────────
//
// EVM stakers earn a pro-rata share of the ONE Solana reward pool. Nothing is
// pre-funded into the per-chain drip contracts (whose 365-day integer rate
// floor strands small deliveries as dust — see AUDIT_LOG). Instead:
//
//   • ACCRUAL — an authoritative ledger row per (chainId, staker) in
//     `evm_reward_accounts`. Every fold advances it by
//       stake / globalTVL × solanaRatePerSec × elapsed
//     where globalTVL = Solana totalStaked + Σ every EVM totalStaked, and the
//     rate/periodFinish come from the Solana pool's live drip. This is the
//     same math the UI counter runs — the ledger is the server-side truth the
//     payout trusts.
//
//   • BACKING — the staking mirror parks each tick's EVM fee share in a
//     relayer-owned Solana RESERVE token account (STAKE_CLAIM_RESERVE). Funds
//     only move at claim time, so nothing gets stranded in EVM contracts.
//
//   • CLAIM — the staker signs a freshness-bounded message with the staking
//     wallet; the relayer verifies it, folds the ledger, caps the payout at
//     the reserve balance, moves NAVE reserve → bridge custody (wNAVE stays
//     fully backed), and mints wNAVE straight to the staker via the lockbox
//     `bridgeIn` with replay partition STAKE_CLAIM_SRC_CHAIN_ID (default 902 —
//     bridge transfers use 900, mirror top-ups 901, so nonces never collide).
//     Audit rows land in bridge_stake_events with kind='reward_claim'; their
//     per-chain count derives the nonce, and rows are inserted BEFORE the
//     mint so every attempt permanently consumes its nonce.
//
// Concurrency: each claim runs under the cross-replica `try_acquire_worker_lock`
// lease keyed per (chain, staker), so two replicas can never double-pay. As a
// second, lease-independent guard the ledger is settled BEFORE funds move
// (settle → wrap → mint) and refunded only when the payout provably failed —
// a claim that outlives its lease still can't be paid twice.

import { createClient } from '@supabase/supabase-js';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { createTransferInstruction } from '@solana/spl-token';
import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  isAddress,
  verifyMessage,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { deriveCustody, NAVE_BRIDGE_LOCKBOX_ABI } from './bridgePrograms.js';
import { evmChainNetwork, resolveMintLockbox } from './bridgeRelayer.js';
import { confirmSolanaTransactionRobust, parseSolanaKeypair } from './solanaTxUtils.js';
import {
  decodeStakePoolAccount,
  deriveStakePool,
  NAVE_STAKING_EVM_ABI,
  readStakingMirrorConfig,
  STAKING_EVM_CHAINS,
  type StakingMirrorConfig,
} from './stakingMirror.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Lockbox srcChainId reserved for claim-on-demand reward mints. */
export const DEFAULT_STAKE_CLAIM_SRC_CHAIN_ID = 902;
/** Solana pool reward_rate fixed-point scale (matches the on-chain program). */
export const SOLANA_RATE_SCALE = 1_000_000_000_000n; // 1e12
/** Claim-signature freshness window (seconds). */
export const CLAIM_SIGNATURE_MAX_AGE_SECS = 600;

const USERS_ABI = [
  {
    type: 'function',
    name: 'users',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'address' }],
    outputs: [
      { name: 'amount', type: 'uint256' },
      { name: 'rewardDebt', type: 'uint256' },
      { name: 'pending', type: 'uint256' },
    ],
  },
] as const;

// ─── Config ───────────────────────────────────────────────────────────────────

export interface StakeClaimConfig {
  enabled: boolean;
  /** Relayer-owned Solana token account backing EVM reward payouts. */
  reserveAccount: string;
  /** Lockbox replay partition for claim mints (default 902). */
  claimSrcChainId: number;
  /** Optional per-claim cap (base units); 0 = uncapped (reserve still caps). */
  maxClaimRaw: bigint;
  /**
   * Optional minimum claimable (base units) before a claim executes; 0 = no
   * floor. Every payout costs the relayer real money (Solana wrap fee + EVM
   * mint gas — meaningful on Ethereum mainnet), so dust claims are a griefing
   * vector without this.
   */
  minClaimRaw: bigint;
  mirror: StakingMirrorConfig;
}

function envBigInt(name: string): bigint {
  const raw = (process.env[name] || '').trim();
  if (!raw) return 0n;
  try {
    const v = BigInt(raw);
    return v >= 0n ? v : 0n;
  } catch {
    return 0n;
  }
}

export function readStakeClaimConfig(): StakeClaimConfig {
  const mirror = readStakingMirrorConfig();
  return {
    enabled: (process.env.STAKE_CLAIM_ENABLED || '').trim().toLowerCase() === 'true',
    reserveAccount: (process.env.STAKE_CLAIM_RESERVE || '').trim(),
    claimSrcChainId: Number(process.env.STAKE_CLAIM_SRC_CHAIN_ID || DEFAULT_STAKE_CLAIM_SRC_CHAIN_ID),
    maxClaimRaw: envBigInt('STAKE_CLAIM_MAX_RAW'),
    minClaimRaw: envBigInt('STAKE_CLAIM_MIN_RAW'),
    mirror,
  };
}

// ─── Pure accrual math (unit-tested) ─────────────────────────────────────────

/**
 * Reward earned by `userStaked` over `elapsedSecs` as its share of the global
 * TVL against the Solana pool's drip. `solanaRateScaled` is the pool's
 * fixed-point reward_rate (base-units/sec × 1e12). All-integer:
 *   floor(rate × elapsed × userStaked / (RATE_SCALE × globalStaked))
 */
export function computeOwedDeltaRaw(
  userStaked: bigint,
  globalStaked: bigint,
  solanaRateScaled: bigint,
  elapsedSecs: bigint,
): bigint {
  if (userStaked <= 0n || globalStaked <= 0n || solanaRateScaled <= 0n || elapsedSecs <= 0n) return 0n;
  return (solanaRateScaled * elapsedSecs * userStaked) / (SOLANA_RATE_SCALE * globalStaked);
}

/** Drip-active seconds between `fromSec` and `nowSec`, capped at `periodFinish`. */
export function elapsedWithinWindow(fromSec: bigint, nowSec: bigint, periodFinish: bigint): bigint {
  const to = nowSec < periodFinish ? nowSec : periodFinish;
  return to > fromSec ? to - fromSec : 0n;
}

/** The message a staker signs to authorize a claim (exact format matters). */
export function claimMessage(chainId: number, staker: string, issuedAtSec: number): string {
  return `nave-stake-claim\nchain:${chainId}\nstaker:${staker.toLowerCase()}\nissued:${issuedAtSec}`;
}

// ─── On-chain reads ───────────────────────────────────────────────────────────

function evmRpcUrl(chainId: number): string {
  const meta = STAKING_EVM_CHAINS[chainId];
  const url = process.env[meta.rpcEnv];
  if (!url) throw new Error(`RPC not configured: set ${meta.rpcEnv} for chain ${chainId}`);
  return url;
}

function evmClient(chainId: number): PublicClient {
  const meta = STAKING_EVM_CHAINS[chainId];
  return createPublicClient({ chain: meta.chain, transport: http(evmRpcUrl(chainId)) }) as PublicClient;
}

interface GlobalStakeSnapshot {
  userStaked: bigint;
  globalStaked: bigint;
  solanaRateScaled: bigint;
  periodFinish: bigint;
}

/** Read everything the fold needs: user stake, global TVL, Solana drip. */
async function readGlobalSnapshot(
  cfg: StakeClaimConfig,
  connection: Connection,
  chainId: number,
  staker: `0x${string}`,
): Promise<GlobalStakeSnapshot> {
  const stakingProgramId = new PublicKey(cfg.mirror.stakingProgramId);
  const poolPromise = connection.getAccountInfo(deriveStakePool(stakingProgramId));

  const evmTotals = await Promise.all(
    Object.keys(cfg.mirror.evmStaking).map(async (idStr) => {
      const id = Number(idStr);
      const client = evmClient(id);
      const address = getAddress(cfg.mirror.evmStaking[id]);
      const total = (await client.readContract({
        address,
        abi: NAVE_STAKING_EVM_ABI,
        functionName: 'totalStaked',
      })) as bigint;
      const user =
        id === chainId
          ? ((await client.readContract({ address, abi: USERS_ABI, functionName: 'users', args: [staker] })) as [
              bigint,
              bigint,
              bigint,
            ])[0]
          : null;
      return { total, user };
    }),
  );

  const poolInfo = await poolPromise;
  if (!poolInfo) throw new Error('Solana staking pool account not found');
  const pool = decodeStakePoolAccount(Buffer.from(poolInfo.data));

  let userStaked = 0n;
  let globalStaked = pool.totalStaked;
  for (const { total, user } of evmTotals) {
    globalStaked += total;
    if (user !== null) userStaked = user;
  }
  return {
    userStaked,
    globalStaked,
    solanaRateScaled: pool.rewardRate,
    periodFinish: BigInt(pool.periodFinish),
  };
}

// ─── Ledger fold ──────────────────────────────────────────────────────────────

export interface RewardAccount {
  chainId: number;
  staker: string;
  accruedRaw: bigint;
  claimedRaw: bigint;
  stakedRaw: bigint;
  anchorSec: number;
}

/** Staged lifecycle of one claim (bridge_stake_events.status for reward_claim rows). */
export type StakeClaimPhase = 'submitted' | 'wrapping' | 'delivering' | 'completed' | 'failed';

/** Claimable = accrued − claimed. */
export function claimableRaw(acct: RewardAccount): bigint {
  const v = acct.accruedRaw - acct.claimedRaw;
  return v > 0n ? v : 0n;
}

function toBigInt(v: unknown): bigint {
  if (typeof v === 'bigint') return v;
  if (v == null) return 0n;
  // numeric columns arrive as strings; guard against float formatting.
  return BigInt(String(v).split('.')[0] || '0');
}

/**
 * Fold a staker's accrual up to now and persist it. Returns the updated
 * account. The fold uses the CURRENT stake for the whole elapsed interval —
 * the worker folds every tick, bounding the approximation error to one tick
 * even when stake changes between folds.
 *
 * Race safety: the write goes through the `fold_evm_reward_accrual` DB
 * function, which (a) applies the delta only when the row's anchor still
 * matches the one this fold read (two concurrent folds can never double-count
 * an interval) and (b) NEVER writes claimed_raw — so a fold racing a claim
 * settle cannot resurrect already-claimed rewards (the bug where the UI
 * offered the same claim twice).
 */
export async function foldRewardAccount(
  cfg: StakeClaimConfig,
  connection: Connection,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  chainId: number,
  stakerRaw: string,
): Promise<RewardAccount> {
  const staker = stakerRaw.toLowerCase();
  const nowSec = Math.floor(Date.now() / 1000);
  const nowIso = new Date(nowSec * 1000).toISOString();

  const { data: row, error: readErr } = await supabase
    .from('evm_reward_accounts')
    .select('accrued_raw, claimed_raw, staked_raw, anchor_ts')
    .eq('chain_id', chainId)
    .eq('staker', staker)
    .maybeSingle();
  if (readErr) throw new Error(`reward ledger read failed: ${readErr.message}`);

  const snapshot = await readGlobalSnapshot(cfg, connection, chainId, getAddress(staker) as `0x${string}`);

  const anchorSec = row?.anchor_ts ? Math.floor(new Date(row.anchor_ts as string).getTime() / 1000) : nowSec;
  const elapsed = elapsedWithinWindow(BigInt(anchorSec), BigInt(nowSec), snapshot.periodFinish);
  // Accrue on the SMALLER of (stake at last fold, stake now): a mid-interval
  // increase only earns from this fold onward, and a mid-interval decrease
  // never over-credits the old balance.
  const prevStaked = toBigInt(row?.staked_raw);
  const effectiveStake = row ? (prevStaked < snapshot.userStaked ? prevStaked : snapshot.userStaked) : 0n;
  const delta = computeOwedDeltaRaw(effectiveStake, snapshot.globalStaked, snapshot.solanaRateScaled, elapsed);

  const { data: folded, error: rpcErr } = await supabase.rpc('fold_evm_reward_accrual', {
    p_chain_id: chainId,
    p_staker: staker,
    p_delta: delta.toString(),
    p_staked: snapshot.userStaked.toString(),
    p_expected_anchor: row?.anchor_ts ?? nowIso,
    p_new_anchor: nowIso,
  });
  if (rpcErr) throw new Error(`reward ledger fold failed: ${rpcErr.message}`);
  const current = Array.isArray(folded) ? folded[0] : folded;
  if (!current) throw new Error('reward ledger fold returned no row');

  return {
    chainId,
    staker,
    accruedRaw: toBigInt(current.accrued_raw),
    claimedRaw: toBigInt(current.claimed_raw),
    stakedRaw: snapshot.userStaked,
    anchorSec: Math.floor(new Date(current.anchor_ts as string).getTime() / 1000),
  };
}

/**
 * Worker tick: fold every known ledger account plus any staker seen in the
 * audit trail's stake events, so accrual stays fresh (≤ one tick stale) even
 * for users who never open the app.
 */
export async function runStakeClaimAccrualTick(): Promise<{ folded: number; skipped?: string }> {
  const cfg = readStakeClaimConfig();
  if (!cfg.enabled) return { folded: 0, skipped: 'disabled (STAKE_CLAIM_ENABLED != true)' };
  const supabase = getSupabase();
  const connection = getConnection(cfg);

  // Union of ledger rows and stakers from mirrored stake events.
  const keys = new Map<string, { chainId: number; staker: string }>();
  const { data: ledgerRows } = await supabase.from('evm_reward_accounts').select('chain_id, staker');
  for (const r of ledgerRows ?? []) {
    keys.set(`${r.chain_id}:${r.staker}`, { chainId: Number(r.chain_id), staker: String(r.staker) });
  }
  const { data: eventRows } = await supabase
    .from('bridge_stake_events')
    .select('source_chain_id, staker')
    .eq('kind', 'stake')
    .not('staker', 'is', null);
  for (const r of eventRows ?? []) {
    if (r.source_chain_id == null) continue;
    keys.set(`${r.source_chain_id}:${String(r.staker).toLowerCase()}`, {
      chainId: Number(r.source_chain_id),
      staker: String(r.staker).toLowerCase(),
    });
  }

  let folded = 0;
  for (const { chainId, staker } of keys.values()) {
    if (!cfg.mirror.evmStaking[chainId]) continue;
    try {
      await foldRewardAccount(cfg, connection, supabase, chainId, staker);
      folded += 1;
    } catch (err) {
      console.warn(`[stake-claim] fold ${chainId}:${staker} failed: ${err instanceof Error ? err.message : err}`);
    }
  }
  return { folded };
}

// ─── Claim execution ──────────────────────────────────────────────────────────

export interface StakeClaimRequest {
  chainId: number;
  staker: string;
  /** Unix seconds the message was signed (freshness-bounded). */
  issuedAtSec: number;
  /** EIP-191 signature over `claimMessage(chainId, staker, issuedAtSec)`. */
  signature: string;
}

export interface StakeClaimResult {
  status: 'completed' | 'nothing_to_claim' | 'reserve_empty';
  claimedRaw?: string;
  /** wNAVE mint tx on the destination chain. */
  mintTx?: string;
  /** Reserve→custody wrap tx on Solana. */
  wrapTx?: string;
  /** bridge_stake_events row id — the app polls it for live phase updates. */
  claimId?: string;
  claimableRaw?: string;
  reserveRaw?: string;
}

let _connection: Connection | null = null;
function getConnection(cfg: StakeClaimConfig): Connection {
  if (!_connection) _connection = new Connection(cfg.mirror.solanaRpcUrl, 'confirmed');
  return _connection;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _supabase: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getSupabase(): any {
  if (_supabase) return _supabase;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured');
  _supabase = createClient(url, key);
  return _supabase;
}

function getRelayer(cfg: StakeClaimConfig): Keypair {
  if (!cfg.mirror.relayerSecret) throw new Error('BRIDGE_SOLANA_RELAYER_AUTHORITY is not configured');
  return parseSolanaKeypair(cfg.mirror.relayerSecret);
}

/** Next lockbox nonce for claim mints: 1 + count of prior reward_claim rows for the chain. */
export async function nextClaimNonce(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  chainId: number,
): Promise<bigint> {
  const { count, error } = await supabase
    .from('bridge_stake_events')
    .select('id', { count: 'exact', head: true })
    .eq('kind', 'reward_claim')
    .eq('source_chain_id', chainId);
  if (error) throw new Error(`failed to derive claim nonce for chain ${chainId}: ${error.message}`);
  return BigInt((count ?? 0) + 1);
}

async function sendReserveToCustody(
  cfg: StakeClaimConfig,
  connection: Connection,
  relayer: Keypair,
  amountRaw: bigint,
): Promise<string> {
  const { TransactionMessage, VersionedTransaction } = await import('@solana/web3.js');
  const custody = deriveCustody(new PublicKey(cfg.mirror.bridgeProgramId));
  const ix = createTransferInstruction(new PublicKey(cfg.reserveAccount), custody, relayer.publicKey, amountRaw);
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const msg = new TransactionMessage({
    payerKey: relayer.publicKey,
    recentBlockhash: blockhash,
    instructions: [ix],
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([relayer]);
  const sig = await connection.sendTransaction(tx, { skipPreflight: false, maxRetries: 5 });
  await confirmSolanaTransactionRobust(connection, sig, blockhash, lastValidBlockHeight);
  return sig;
}

/**
 * Verify + execute one claim. Caller (index.ts) must hold the per-staker
 * cross-replica lease before invoking.
 */
export async function handleStakeClaim(req: StakeClaimRequest): Promise<StakeClaimResult> {
  const cfg = readStakeClaimConfig();
  if (!cfg.enabled) throw new Error('Stake claims are disabled (STAKE_CLAIM_ENABLED != true)');
  if (!cfg.reserveAccount) throw new Error('STAKE_CLAIM_RESERVE is not configured');
  if (!Number.isInteger(req.chainId) || !cfg.mirror.evmStaking[req.chainId]) {
    throw new Error(`Unsupported staking chain ${req.chainId}`);
  }
  if (!isAddress(req.staker)) throw new Error('Invalid staker address');
  const staker = getAddress(req.staker);

  // Freshness + signature: only the staking wallet can trigger its own claim.
  const nowSec = Math.floor(Date.now() / 1000);
  if (!Number.isInteger(req.issuedAtSec) || Math.abs(nowSec - req.issuedAtSec) > CLAIM_SIGNATURE_MAX_AGE_SECS) {
    throw new Error('Claim signature expired — please retry');
  }
  const ok = await verifyMessage({
    address: staker,
    message: claimMessage(req.chainId, staker, req.issuedAtSec),
    signature: req.signature as `0x${string}`,
  });
  if (!ok) throw new Error('Claim signature verification failed');

  const supabase = getSupabase();
  const connection = getConnection(cfg);
  const relayer = getRelayer(cfg);

  // Fold to now, then pay what the ledger owes — capped by the reserve.
  const acct = await foldRewardAccount(cfg, connection, supabase, req.chainId, staker);
  let payout = claimableRaw(acct);
  if (cfg.maxClaimRaw > 0n && payout > cfg.maxClaimRaw) payout = cfg.maxClaimRaw;
  if (payout <= 0n) {
    return { status: 'nothing_to_claim', claimableRaw: '0' };
  }
  // Dust floor: every payout costs relayer gas (Solana wrap + EVM mint), so
  // reject sub-minimum claims with an explanation instead of eating the cost.
  if (cfg.minClaimRaw > 0n && payout < cfg.minClaimRaw) {
    throw new Error(
      `Claimable ${payout} is below the minimum claim of ${cfg.minClaimRaw} base units — keep accruing and claim later`,
    );
  }

  const reserveRaw = BigInt((await connection.getTokenAccountBalance(new PublicKey(cfg.reserveAccount))).value.amount);
  if (reserveRaw <= 0n) {
    return { status: 'reserve_empty', claimableRaw: payout.toString(), reserveRaw: '0' };
  }
  if (payout > reserveRaw) payout = reserveRaw;

  // 1. Audit row FIRST, status 'submitted' — its per-chain count consumes this
  //    nonce forever, and the app polls the row for live phase updates.
  //    source_tx is a synthetic stable id (the wrap tx doesn't exist yet);
  //    the Solana wrap lands in wrap_tx, the EVM mint in dest_tx. The
  //    unique(source_tx) constraint makes the nonce race-safe: two stakers
  //    claiming at once on the same chain can derive the same count, but only
  //    one insert wins — the loser recounts and retries.
  let nonce = 0n;
  let claimId = '';
  for (let attempt = 0; attempt < 3 && !claimId; attempt++) {
    nonce = await nextClaimNonce(supabase, req.chainId);
    const { data: inserted, error: insertErr } = await supabase
      .from('bridge_stake_events')
      .insert({
        kind: 'reward_claim',
        source_chain: 'solana',
        source_chain_id: req.chainId,
        source_tx: `stake-claim:${req.chainId}:${nonce}`,
        staker: staker.toLowerCase(),
        amount_raw: payout.toString(),
        network: evmChainNetwork(req.chainId),
        status: 'submitted' satisfies StakeClaimPhase,
        updated_at: new Date().toISOString(),
      })
      .select('id')
      .single();
    if (!insertErr) {
      claimId = inserted.id as string;
    } else if (!/duplicate|unique/i.test(insertErr.message)) {
      throw new Error(`claim audit insert failed: ${insertErr.message}`);
    }
  }
  if (!claimId) throw new Error('claim audit insert failed: nonce contention — please retry');

  const setPhase = async (patch: Record<string, string | null>) => {
    const { error } = await supabase
      .from('bridge_stake_events')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', claimId);
    if (error) console.warn(`[stake-claim] phase update failed for ${claimId}: ${error.message}`);
  };

  // 2. Settle the ledger BEFORE any funds move (double-pay guard): if this
  //    claim outlives its cross-replica lease, a second attempt folds a
  //    ledger that already shows the payout as claimed and pays nothing. On
  //    a provably-failed payout we refund the ledger (negative settle) below.
  const { error: settleErr } = await supabase.rpc('settle_evm_reward_claim', {
    p_chain_id: req.chainId,
    p_staker: staker.toLowerCase(),
    p_amount: payout.toString(),
  });
  if (settleErr) {
    await setPhase({ status: 'failed' satisfies StakeClaimPhase, error: `ledger settle failed: ${settleErr.message}`.slice(0, 500) });
    throw new Error(`claim ledger settle failed: ${settleErr.message}`);
  }

  // ORDER (audit HIGH): the EVM mint runs FIRST and must be receipt-confirmed
  // before any Solana reserve→custody move. The previous order (wrap, then
  // mint) left custody over-collateralized — reserve NAVE stranded in custody
  // with no wNAVE minted — every time the mint failed. Now:
  //   3. mint wNAVE to the staker (lockbox bridgeIn, replay key
  //      claimSrcChainId/nonce) and wait for a successful receipt;
  //   4. only then wrap: move `payout` NAVE reserve → bridge custody so the
  //      just-minted wNAVE is custody-backed.
  // If step 4 fails after step 3 succeeded, the row is left in 'wrapping' with
  // dest_tx set and wrap_tx null — a PERSISTED two-phase record that
  // {@link reconcileStakeClaimWraps} completes on the next worker tick /
  // restart (the wrap is a plain SPL transfer from the relayer's own reserve
  // and is safe to retry). The user has already been paid, so the ledger is
  // never refunded in that case.
  //
  // Refund is only safe when the mint provably did NOT happen: nothing was
  // broadcast, or the tx landed and REVERTED. A broadcast with an unknown
  // outcome (receipt timeout, RPC drop) is NOT refunded — under-crediting is
  // reconcilable from the audit row; double-paying is not.
  let mintBroadcast = false;
  let mintReverted = false;
  let mintTx: string | undefined;
  try {
    // 3. Mint wNAVE straight to the staker via whichever lockbox currently
    //    holds wNAVE.minter() (never a static env address — the v1→v2 rotation
    //    made that silently wrong).
    await setPhase({ status: 'delivering' satisfies StakeClaimPhase });
    const meta = STAKING_EVM_CHAINS[req.chainId];
    const lockbox = getAddress(await resolveMintLockbox(req.chainId));
    const key = cfg.mirror.evmMinterPrivateKey!.startsWith('0x')
      ? cfg.mirror.evmMinterPrivateKey!
      : `0x${cfg.mirror.evmMinterPrivateKey}`;
    const account = privateKeyToAccount(key as `0x${string}`);
    const transport = http(evmRpcUrl(req.chainId));
    const publicClient = createPublicClient({ chain: meta.chain, transport }) as PublicClient;
    const wallet = createWalletClient({ account, chain: meta.chain, transport });

    mintTx = await wallet.writeContract({
      address: lockbox,
      abi: NAVE_BRIDGE_LOCKBOX_ABI,
      functionName: 'bridgeIn',
      args: [staker, payout, BigInt(cfg.claimSrcChainId), nonce],
      chain: meta.chain,
      account,
    });
    mintBroadcast = true;
    const receipt = await publicClient.waitForTransactionReceipt({ hash: mintTx as `0x${string}` });
    if (receipt.status !== 'success') {
      mintReverted = true;
      throw new Error(`bridgeIn reverted (tx ${mintTx})`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const refundSafe = !mintBroadcast || mintReverted;
    let refundNote = '';
    if (refundSafe) {
      const { error: refundErr } = await supabase.rpc('settle_evm_reward_claim', {
        p_chain_id: req.chainId,
        p_staker: staker.toLowerCase(),
        p_amount: (-payout).toString(),
      });
      refundNote = refundErr ? ` (ledger refund FAILED: ${refundErr.message})` : ' (ledger refunded)';
      if (refundErr) {
        // User stays under-credited — the safe direction. Reconcile from this row.
        console.error(
          `[stake-claim] ledger refund failed for claim ${claimId} (chain ${req.chainId}, ${staker}, ${payout}): ${refundErr.message}`,
        );
      }
    } else {
      refundNote = ' (mint outcome unknown — ledger NOT refunded; reconcile manually)';
      console.error(
        `[stake-claim] CRITICAL: mint broadcast with unknown outcome for claim ${claimId} (chain ${req.chainId}, ${staker}, ${payout}) — verify on-chain before any manual refund.`,
      );
    }
    // Nothing moved on Solana (the wrap never ran), so custody is untouched.
    await setPhase({
      status: 'failed' satisfies StakeClaimPhase,
      error: `mint failed: ${message}${refundNote}`.slice(0, 500),
      ...(mintTx ? { dest_tx: mintTx } : {}),
    });
    throw err;
  }

  // 4. Wrap: back the confirmed mint by moving NAVE reserve → bridge custody.
  //    Persist the mint FIRST so a crash between here and the wrap leaves a
  //    reconcilable two-phase record ('wrapping' + dest_tx, no wrap_tx).
  await setPhase({ status: 'wrapping' satisfies StakeClaimPhase, dest_tx: mintTx! });
  let wrapTx: string | undefined;
  try {
    wrapTx = await sendReserveToCustody(cfg, connection, relayer, payout);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[stake-claim] mint ${mintTx} landed but reserve→custody wrap failed for claim ${claimId} ` +
        `(chain ${req.chainId}, ${staker}, ${payout}); left in 'wrapping' for reconciliation: ${message}`,
    );
    // Stay in 'wrapping' (NOT failed): the staker has been paid; only the
    // custody backing is outstanding and the reconciler retries it.
    await setPhase({ error: `wrap pending (mint ${mintTx} landed): ${message}`.slice(0, 500) });
    return { status: 'completed', claimedRaw: payout.toString(), mintTx, claimId };
  }

  await setPhase({ status: 'completed' satisfies StakeClaimPhase, wrap_tx: wrapTx, error: null });
  return { status: 'completed', claimedRaw: payout.toString(), mintTx, wrapTx, claimId };
}

/**
 * Two-phase reconciliation (worker tick / restart): complete the Solana
 * reserve→custody wrap for reward_claim rows whose EVM mint landed
 * (`dest_tx` set) but whose wrap never did (`status='wrapping'`,
 * `wrap_tx` null). Rows younger than `minAgeMs` are skipped so an in-flight
 * claim on another replica is not raced. The wrap is a plain SPL transfer from
 * the relayer-owned reserve, so retrying it is safe; the amount comes from the
 * persisted audit row (`amount_raw`), never recomputed.
 */
export async function reconcileStakeClaimWraps(
  minAgeMs = 5 * 60_000,
): Promise<{ reconciled: number; pending: number; skipped?: string }> {
  const cfg = readStakeClaimConfig();
  if (!cfg.enabled) return { reconciled: 0, pending: 0, skipped: 'disabled (STAKE_CLAIM_ENABLED != true)' };
  if (!cfg.reserveAccount) return { reconciled: 0, pending: 0, skipped: 'STAKE_CLAIM_RESERVE not configured' };
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('bridge_stake_events')
    .select('id, amount_raw, dest_tx, wrap_tx, updated_at')
    .eq('kind', 'reward_claim')
    .eq('status', 'wrapping')
    .not('dest_tx', 'is', null)
    .is('wrap_tx', null);
  if (error) throw new Error(`reconcile query failed: ${error.message}`);
  const cutoff = Date.now() - minAgeMs;
  let reconciled = 0;
  let pending = 0;
  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    const updatedAt = row.updated_at ? new Date(String(row.updated_at)).getTime() : 0;
    if (updatedAt > cutoff) {
      pending += 1;
      continue;
    }
    const amount = BigInt(String(row.amount_raw));
    try {
      const connection = getConnection(cfg);
      const relayer = getRelayer(cfg);
      const wrapTx = await sendReserveToCustody(cfg, connection, relayer, amount);
      await supabase
        .from('bridge_stake_events')
        .update({ status: 'completed' satisfies StakeClaimPhase, wrap_tx: wrapTx, error: null, updated_at: new Date().toISOString() })
        .eq('id', String(row.id));
      reconciled += 1;
      console.log(`[stake-claim] reconciled wrap for claim ${row.id}: ${wrapTx}`);
    } catch (err) {
      pending += 1;
      console.warn(`[stake-claim] wrap reconciliation for claim ${row.id} failed: ${err instanceof Error ? err.message : err}`);
    }
  }
  return { reconciled, pending };
}

/**
 * Reward-reserve snapshot for the UI's "Reward pool" stat. EVM claims pay out
 * of this relayer-owned Solana token account (reserve → custody → mint), so
 * the visible reward pool = Solana reward vault + this reserve, and it goes
 * DOWN when EVM stakers claim.
 */
export async function getStakeClaimReserve(): Promise<{ reserveRaw: string; reserveAccount: string }> {
  const cfg = readStakeClaimConfig();
  // When claims are disabled or the reserve isn't wired yet, return a zero
  // snapshot so the public "Reward pool" tile can still load (vault-only)
  // instead of 400-spamming the browser console.
  if (!cfg.enabled || !cfg.reserveAccount) {
    return { reserveRaw: '0', reserveAccount: cfg.reserveAccount || '' };
  }
  const connection = getConnection(cfg);
  const bal = await connection.getTokenAccountBalance(new PublicKey(cfg.reserveAccount));
  return { reserveRaw: bal.value.amount, reserveAccount: cfg.reserveAccount };
}

/** Read-only pending view for the UI: folds and returns the live claimable. */
export async function getStakeClaimPending(
  chainId: number,
  stakerRaw: string,
): Promise<{ claimableRaw: string; accruedRaw: string; claimedRaw: string; ratePerSecFloat: number }> {
  const cfg = readStakeClaimConfig();
  if (!cfg.enabled) throw new Error('Stake claims are disabled');
  if (!Number.isInteger(chainId) || !cfg.mirror.evmStaking[chainId]) throw new Error(`Unsupported staking chain ${chainId}`);
  if (!isAddress(stakerRaw)) throw new Error('Invalid staker address');

  const supabase = getSupabase();
  const connection = getConnection(cfg);
  const acct = await foldRewardAccount(cfg, connection, supabase, chainId, getAddress(stakerRaw));

  // Live rate for the UI odometer: user share of the Solana drip right now.
  const snapshot = await readGlobalSnapshot(cfg, connection, chainId, getAddress(stakerRaw) as `0x${string}`);
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const active = snapshot.periodFinish > nowSec && snapshot.globalStaked > 0n && snapshot.userStaked > 0n;
  const ratePerSecFloat = active
    ? (Number(snapshot.solanaRateScaled) / 1e12) * (Number(snapshot.userStaked) / Number(snapshot.globalStaked))
    : 0;

  return {
    claimableRaw: claimableRaw(acct).toString(),
    accruedRaw: acct.accruedRaw.toString(),
    claimedRaw: acct.claimedRaw.toString(),
    ratePerSecFloat,
  };
}
