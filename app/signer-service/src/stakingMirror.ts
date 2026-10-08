// ─── Staking global-parity mirror (worker tick) ──────────────────────────────
//
// The bridge's 1% staking fee leg accumulates as NAVE in a neutral,
// relayer-owned COLLECTOR token account on Solana (BRIDGE_SOLANA_STAKING_COLLECTOR
// — the account BRIDGE_SOLANA_STAKING_POOL_ACCOUNT points at after the
// staking-mirror cutover). Each tick this module:
//
//   1. Reads the collector balance. Below the distribution threshold it only
//      sends a permissionless `nave_staking.sync` poke (keeps the 365-day drip
//      window advancing) and returns.
//   2. Reads each chain's stake weight — Solana `StakePool.total_staked` plus
//      every configured EVM `NaveStaking.totalStaked()` — and splits the
//      collector balance proportionally. The Solana share absorbs the integer
//      rounding remainder; chains with zero stake get zero; when the GLOBAL
//      stake is zero nothing moves (fees wait in the collector).
//   3. Solana share: SPL-transfer collector → pool reward_vault and `sync` in
//      the same transaction, so the new balance folds into the drip window
//      immediately.
//   4. Each EVM share: wNAVE must remain fully custody-backed, so the share is
//      first transferred collector → nave_bridge custody, then the equivalent
//      wNAVE is minted to the relayer EOA via the lockbox `bridgeIn` (replay
//      key = (STAKING_MIRROR_SRC_CHAIN_ID, mirror nonce) — a dedicated
//      srcChainId, default 901, so mirror mints can never collide with bridge
//      mints which use 900), then `approve` + `notifyReward` on that chain's
//      NaveStaking (the relayer EOA is the on-chain `rewarder`).
//   5. Audit trail: every leg writes a `reward_topup` row to
//      `bridge_stake_events`; EVM Staked/Unstaked events are mirrored into the
//      same table (audit-only — weights are read live on-chain).
//
// Mirror nonce: derived from the audit table itself — the count of prior
// `reward_topup` rows for the destination chain (`source_chain_id` = the EVM
// chain id) + 1. Rows are inserted BEFORE the EVM mint, so a failed mint burns
// its nonce (the lockbox never saw it — safe) and the next tick derives a
// fresh, never-reused one. Cross-replica races are excluded by the worker's
// DB lease around the tick.

import { createHash } from 'crypto';
import { createClient } from '@supabase/supabase-js';
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { createTransferInstruction } from '@solana/spl-token';
import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  type Chain,
  type Hash,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, baseSepolia, mainnet, sepolia } from 'viem/chains';
import { robinhood, robinhoodTestnet } from './evmChains.js';
import { DEVNET_DEFAULT_PROGRAM_IDS, isMainnetCluster, resolveSolanaRpcUrl } from './programs.js';
import { confirmSolanaTransactionRobust, parseSolanaKeypair } from './solanaTxUtils.js';
import { deriveCustody, NAVE_BRIDGE_LOCKBOX_ABI } from './bridgePrograms.js';

/** Tag audit rows so the Bridge page can filter mainnet vs testnet history. */
function bridgeNetwork(): 'mainnet' | 'testnet' {
  return isMainnetCluster() ? 'mainnet' : 'testnet';
}

// ─── Constants / defaults ────────────────────────────────────────────────────

/**
 * DEVNET fallbacks for BRIDGE_SOLANA_STAKING_PROGRAM / BRIDGE_SOLANA_BRIDGE_PROGRAM
 * (single source of truth: programs.ts DEVNET_DEFAULT_PROGRAM_IDS, which the
 * /health endpoint and the mainnet boot check use to flag a mainnet deploy
 * that is still running on these ids). Mainnet MUST set both envs.
 */
export const DEFAULT_STAKING_PROGRAM_ID = DEVNET_DEFAULT_PROGRAM_IDS.BRIDGE_SOLANA_STAKING_PROGRAM;
export const DEFAULT_BRIDGE_PROGRAM_ID = DEVNET_DEFAULT_PROGRAM_IDS.BRIDGE_SOLANA_BRIDGE_PROGRAM;
/** Minimum collector balance (base units, 6 decimals) before distributing: 1 NAVE. */
export const DEFAULT_STAKING_MIRROR_MIN_RAW = 1_000_000n;
/** Lockbox srcChainId reserved for staking-mirror mints (bridge mints use 900). */
export const DEFAULT_STAKING_MIRROR_SRC_CHAIN_ID = 901;
/** How many blocks back to scan for EVM Staked/Unstaked events each tick. */
export const DEFAULT_EVM_STAKE_EVENT_LOOKBACK_BLOCKS = 5_000;

/**
 * chainId → { viem chain, RPC env var, bridge_stake_events source_chain label }.
 * Keep in lockstep with BRIDGE_EVM_CHAINS in bridgeRelayer.ts. Env
 * (BRIDGE_EVM_STAKING_<id>) selects which chains are live on a given deploy.
 */
export const STAKING_EVM_CHAINS: Record<number, { chain: Chain; rpcEnv: string; name: string }> = {
  // Testnets
  11155111: { chain: sepolia, rpcEnv: 'EVM_SEPOLIA_RPC_URL', name: 'ethereum' },
  84532: { chain: baseSepolia, rpcEnv: 'EVM_BASE_SEPOLIA_RPC_URL', name: 'base' },
  46630: { chain: robinhoodTestnet, rpcEnv: 'EVM_ROBINHOOD_TESTNET_RPC_URL', name: 'robinhood' },
  // Mainnets
  1: { chain: mainnet, rpcEnv: 'EVM_ETHEREUM_RPC_URL', name: 'ethereum' },
  8453: { chain: base, rpcEnv: 'EVM_BASE_RPC_URL', name: 'base' },
  4663: { chain: robinhood, rpcEnv: 'EVM_ROBINHOOD_RPC_URL', name: 'robinhood' },
};

// ─── nave_staking PDA derivation + account decode (server-side mirror) ───────
// Mirrors src/lib/staking/solanaStakingProgram.ts (frontend) — the signer
// service must not import frontend code, so the seeds/offsets live here too.

const STAKE_POOL_SEED = Buffer.from('stake_pool');
const POOL_AUTHORITY_SEED = Buffer.from('stake_pool_authority');
const STAKE_VAULT_SEED = Buffer.from('stake_vault');
const REWARD_VAULT_SEED = Buffer.from('reward_vault');

export function deriveStakePool(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([STAKE_POOL_SEED], programId)[0];
}
export function derivePoolAuthority(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([POOL_AUTHORITY_SEED], programId)[0];
}
export function deriveStakeVault(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([STAKE_VAULT_SEED], programId)[0];
}
export function deriveRewardVault(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([REWARD_VAULT_SEED], programId)[0];
}

/** StakePool account byte size after the drip upgrade (reserved shrunk to 24). */
export const STAKE_POOL_ACCOUNT_SIZE = 299;

export interface StakePoolAccount {
  totalStaked: bigint;
  accRewardPerShare: bigint;
  lastRewardBalance: bigint;
  paused: boolean;
  /** Emission per second scaled by RATE_SCALE (1e12). */
  rewardRate: bigint;
  periodFinish: bigint;
  lastUpdateTime: bigint;
  rewardDuration: bigint;
}

function readU128LE(data: Buffer, offset: number): bigint {
  return data.readBigUInt64LE(offset) + (data.readBigUInt64LE(offset + 8) << 64n);
}

/**
 * Decode the StakePool account at its post-drip-upgrade absolute offsets
 * (including the 8-byte Anchor discriminator): total_staked u64 @202,
 * acc_reward_per_share u128 @210, last_reward_balance u64 @226, paused u8
 * @234, reward_rate u128 @235, period_finish i64 @251, last_update_time i64
 * @259, reward_duration i64 @267.
 */
export function decodeStakePoolAccount(data: Buffer): StakePoolAccount {
  if (data.length < 275) {
    throw new Error(`StakePool account too small (${data.length} bytes; need >= 275)`);
  }
  return {
    totalStaked: data.readBigUInt64LE(202),
    accRewardPerShare: readU128LE(data, 210),
    lastRewardBalance: data.readBigUInt64LE(226),
    paused: data.readUInt8(234) === 1,
    rewardRate: readU128LE(data, 235),
    periodFinish: data.readBigInt64LE(251),
    lastUpdateTime: data.readBigInt64LE(259),
    rewardDuration: data.readBigInt64LE(267),
  };
}

const SYNC_IX_DISCRIMINATOR = createHash('sha256').update('global:sync').digest().subarray(0, 8);

/**
 * Build the permissionless `nave_staking.sync` poke: advances the time drip
 * and rolls any newly-arrived reward-vault balance into a fresh window.
 * Accounts: [pool (writable), reward_vault (readonly)].
 */
export function buildSyncInstruction(stakingProgramId: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: stakingProgramId,
    keys: [
      { pubkey: deriveStakePool(stakingProgramId), isSigner: false, isWritable: true },
      { pubkey: deriveRewardVault(stakingProgramId), isSigner: false, isWritable: false },
    ],
    data: Buffer.from(SYNC_IX_DISCRIMINATOR),
  });
}

// ─── EVM ABIs ─────────────────────────────────────────────────────────────────

export const NAVE_STAKING_EVM_ABI = [
  {
    type: 'function',
    name: 'totalStaked',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'notifyReward',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'amount', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'rewardRate',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'periodFinish',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'rewardsDuration',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'event',
    name: 'Staked',
    inputs: [
      { name: 'user', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'totalStaked', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'Unstaked',
    inputs: [
      { name: 'user', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'totalStaked', type: 'uint256', indexed: false },
    ],
  },
] as const;

const ERC20_APPROVE_ABI = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const;

// ─── Config ───────────────────────────────────────────────────────────────────

export interface StakingMirrorConfig {
  enabled: boolean;
  /** Solana RPC (falls back to the bridge RPC, then the service-wide one). */
  solanaRpcUrl: string;
  /** Neutral relayer-owned NAVE token account receiving the bridge's 1% staking leg. */
  collectorAccount: string;
  /** nave_staking program id (pool/vault PDAs derive from it). */
  stakingProgramId: string;
  /** nave_bridge program id (custody PDA derives from it — wNAVE backing). */
  bridgeProgramId: string;
  /** Relayer keypair secret — owner of the collector token account. */
  relayerSecret: string | undefined;
  /** Minimum collector balance (base units) before a distribution runs. */
  minDistributionRaw: bigint;
  /** Lockbox srcChainId reserved for mirror mints (default 901; bridge uses 900). */
  mirrorSrcChainId: number;
  /** chainId → NaveStaking address (the drip pool the relayer is `rewarder` of). */
  evmStaking: Record<number, string>;
  /** chainId → NaveBridge lockbox address (wNAVE minter for the reward wrap). */
  evmLockbox: Record<number, string>;
  /** chainId → WrappedNave token address (approve target asset). */
  wrappedNave: Record<number, string>;
  /** 0x EOA private key — the lockbox relayer AND the staking `rewarder`. */
  evmMinterPrivateKey: string | undefined;
  /** Blocks scanned back per tick for the Staked/Unstaked audit mirror. */
  evmLookbackBlocks: number;
}

function envBool(name: string): boolean {
  return (process.env[name] || '').trim().toLowerCase() === 'true';
}

function envNum(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw && Number.isFinite(Number(raw)) ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function envBigInt(name: string, fallback: bigint): bigint {
  const raw = (process.env[name] || '').trim();
  if (!raw) return fallback;
  try {
    const v = BigInt(raw);
    return v >= 0n ? v : fallback;
  } catch {
    return fallback;
  }
}

function envAddrMap(prefix: string): Record<number, string> {
  const out: Record<number, string> = {};
  for (const chainId of Object.keys(STAKING_EVM_CHAINS).map(Number)) {
    const v = process.env[`${prefix}_${chainId}`]?.trim();
    if (v) out[chainId] = v;
  }
  return out;
}

/**
 * Read the staking-mirror configuration from the environment. Reuses the
 * bridge relayer's Solana RPC/keypair and EVM lockbox/wNAVE/minter envs; the
 * mirror-specific keys are STAKING_MIRROR_* and BRIDGE_SOLANA_STAKING_COLLECTOR
 * / BRIDGE_SOLANA_STAKING_PROGRAM / BRIDGE_EVM_STAKING_<chainId>.
 */
export function readStakingMirrorConfig(): StakingMirrorConfig {
  return {
    enabled: envBool('STAKING_MIRROR_ENABLED'),
    solanaRpcUrl: (process.env.BRIDGE_SOLANA_RPC_URL || resolveSolanaRpcUrl()).trim(),
    collectorAccount: (process.env.BRIDGE_SOLANA_STAKING_COLLECTOR || '').trim(),
    stakingProgramId: (process.env.BRIDGE_SOLANA_STAKING_PROGRAM || DEFAULT_STAKING_PROGRAM_ID).trim(),
    bridgeProgramId: (process.env.BRIDGE_SOLANA_BRIDGE_PROGRAM || DEFAULT_BRIDGE_PROGRAM_ID).trim(),
    relayerSecret: process.env.BRIDGE_SOLANA_RELAYER_AUTHORITY || process.env.BRIDGE_SOLANA_CUSTODY_AUTHORITY,
    minDistributionRaw: envBigInt('STAKING_MIRROR_MIN_RAW', DEFAULT_STAKING_MIRROR_MIN_RAW),
    mirrorSrcChainId: envNum('STAKING_MIRROR_SRC_CHAIN_ID', DEFAULT_STAKING_MIRROR_SRC_CHAIN_ID),
    evmStaking: envAddrMap('BRIDGE_EVM_STAKING'),
    evmLockbox: envAddrMap('BRIDGE_EVM_LOCKBOX'),
    wrappedNave: envAddrMap('BRIDGE_EVM_WRAPPED_NAVE'),
    evmMinterPrivateKey: process.env.BRIDGE_EVM_MINTER_PRIVATE_KEY,
    evmLookbackBlocks: envNum('STAKING_MIRROR_EVM_LOOKBACK_BLOCKS', DEFAULT_EVM_STAKE_EVENT_LOOKBACK_BLOCKS),
  };
}

// ─── Proportional split math (pure) ──────────────────────────────────────────

export interface StakeWeights {
  solanaStaked: bigint;
  /** chainId → total staked on that EVM chain's NaveStaking. */
  evmStaked: Record<number, bigint>;
}

export interface CollectorSplit {
  totalStaked: bigint;
  solanaShare: bigint;
  evmShares: Record<number, bigint>;
  /** Dust that stays in the collector (only when Solana stake is zero). */
  undistributed: bigint;
}

/**
 * Split the collector balance proportionally to each chain's stake weight.
 * EVM shares are floor(balance * staked / total); the Solana share absorbs the
 * rounding remainder (so every distributed base unit lands somewhere). Chains
 * with zero stake get zero. When Solana itself has zero stake it cannot absorb
 * the remainder, so the dust stays undistributed in the collector and rolls
 * into the next tick. Zero global stake ⇒ everything stays in the collector.
 */
export function splitCollectorBalance(balanceRaw: bigint, weights: StakeWeights): CollectorSplit {
  const evmShares: Record<number, bigint> = {};
  let evmTotal = 0n;
  for (const staked of Object.values(weights.evmStaked)) evmTotal += staked;
  const totalStaked = weights.solanaStaked + evmTotal;

  if (totalStaked === 0n || balanceRaw <= 0n) {
    for (const chainId of Object.keys(weights.evmStaked)) evmShares[Number(chainId)] = 0n;
    return { totalStaked, solanaShare: 0n, evmShares, undistributed: balanceRaw > 0n ? balanceRaw : 0n };
  }

  let evmSum = 0n;
  for (const [chainId, staked] of Object.entries(weights.evmStaked)) {
    const share = staked > 0n ? (balanceRaw * staked) / totalStaked : 0n;
    evmShares[Number(chainId)] = share;
    evmSum += share;
  }

  const solanaShare = weights.solanaStaked > 0n ? balanceRaw - evmSum : 0n;
  return {
    totalStaked,
    solanaShare,
    evmShares,
    undistributed: balanceRaw - solanaShare - evmSum,
  };
}

/** Threshold gate: distribute only once the collector holds at least `minRaw`. */
export function shouldDistribute(balanceRaw: bigint, minRaw: bigint): boolean {
  return balanceRaw >= minRaw;
}

/**
 * Truncation-floor gate for an EVM delivery: NaveStaking.notifyReward sets
 * `rewardRate = (amount + leftover) / rewardsDuration` (integer division), so
 * a share smaller than the floor produces rate 0 — the tokens land in the
 * contract but never drip (they become sweep-only dust) AND the call resets
 * `periodFinish` a full window out, blocking `setRewardsDuration` until then.
 * Only deliver when the share actually moves the rate.
 */
export function meetsRateFloor(shareRaw: bigint, leftoverRaw: bigint, rewardsDurationSecs: bigint): boolean {
  if (rewardsDurationSecs <= 0n) return false;
  return (shareRaw + leftoverRaw) / rewardsDurationSecs > 0n;
}

// ─── Shared clients ───────────────────────────────────────────────────────────

let _mirrorConnection: Connection | null = null;
function getMirrorConnection(cfg: StakingMirrorConfig): Connection {
  if (_mirrorConnection) return _mirrorConnection;
  _mirrorConnection = new Connection(cfg.solanaRpcUrl, 'confirmed');
  return _mirrorConnection;
}

let _mirrorKeypair: Keypair | null = null;
function getRelayerKeypair(cfg: StakingMirrorConfig): Keypair {
  if (_mirrorKeypair) return _mirrorKeypair;
  if (!cfg.relayerSecret) throw new Error('BRIDGE_SOLANA_RELAYER_AUTHORITY is not configured');
  _mirrorKeypair = parseSolanaKeypair(cfg.relayerSecret);
  return _mirrorKeypair;
}

let _mirrorSupabase: ReturnType<typeof createClient> | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getMirrorSupabase(): any {
  if (_mirrorSupabase) return _mirrorSupabase;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured');
  _mirrorSupabase = createClient(url, key);
  return _mirrorSupabase;
}

function evmRpcUrl(chainId: number): string {
  const meta = STAKING_EVM_CHAINS[chainId];
  const url = process.env[meta.rpcEnv];
  if (!url) throw new Error(`Staking mirror RPC not configured: set ${meta.rpcEnv} for chain ${chainId}`);
  return url;
}

function evmPublicClient(chainId: number): PublicClient {
  const meta = STAKING_EVM_CHAINS[chainId];
  return createPublicClient({ chain: meta.chain, transport: http(evmRpcUrl(chainId)) }) as PublicClient;
}

function evmWallet(cfg: StakingMirrorConfig, chainId: number) {
  if (!cfg.evmMinterPrivateKey) throw new Error('BRIDGE_EVM_MINTER_PRIVATE_KEY is not configured');
  const key = cfg.evmMinterPrivateKey.startsWith('0x')
    ? cfg.evmMinterPrivateKey
    : `0x${cfg.evmMinterPrivateKey}`;
  const account = privateKeyToAccount(key as `0x${string}`);
  const meta = STAKING_EVM_CHAINS[chainId];
  const transport = http(evmRpcUrl(chainId));
  const publicClient = createPublicClient({ chain: meta.chain, transport }) as PublicClient;
  const wallet = createWalletClient({ account, chain: meta.chain, transport });
  return { account, publicClient, wallet, chain: meta.chain };
}

/** Wait for a receipt, tolerating viem's polling timeout (same rationale as bridgeRelayer). */
async function waitForReceiptRobust(
  publicClient: PublicClient,
  hash: Hash,
): Promise<{ status: 'success' | 'reverted' }> {
  try {
    return await publicClient.waitForTransactionReceipt({ hash });
  } catch (err) {
    try {
      const receipt = await publicClient.getTransactionReceipt({ hash });
      if (receipt) return receipt;
    } catch {
      // Not found yet either — surface the original error.
    }
    throw err;
  }
}

async function sendSolanaTx(
  connection: Connection,
  payer: Keypair,
  instructions: TransactionInstruction[],
): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  tx.sign([payer]);
  const signature = await connection.sendTransaction(tx, { skipPreflight: false, maxRetries: 5 });
  await confirmSolanaTransactionRobust(connection, signature, blockhash, lastValidBlockHeight);
  return signature;
}

// ─── Mirror nonce (lockbox replay key) ────────────────────────────────────────

/**
 * Derive the next lockbox mint nonce for a destination EVM chain: 1 + the
 * count of prior `reward_topup` rows whose `source_chain_id` is that chain.
 * The audit row is inserted BEFORE `bridgeIn`, so every attempt (including
 * failed ones) permanently consumes its nonce — nonces are monotonic and never
 * reused, satisfying the lockbox `processed[srcChainId, srcNonce]` guard.
 */
export async function nextMirrorNonce(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  destChainId: number,
): Promise<bigint> {
  const { count, error } = await supabase
    .from('bridge_stake_events')
    .select('id', { count: 'exact', head: true })
    .eq('kind', 'reward_topup')
    .eq('source_chain_id', destChainId);
  if (error) throw new Error(`failed to derive mirror nonce for chain ${destChainId}: ${error.message}`);
  return BigInt((count ?? 0) + 1);
}

// ─── Tick ─────────────────────────────────────────────────────────────────────

export interface StakingMirrorEvmLegResult {
  chainId: number;
  shareRaw: string;
  /** Solana collector → custody transfer signature (the audit row's source_tx). */
  sourceTx?: string;
  /** Final notifyReward tx hash on the EVM chain. */
  notifyTx?: string;
  error?: string;
}

export interface StakingMirrorTickResult {
  /** Set when the tick short-circuited (disabled / below threshold / zero stake). */
  skipped?: string;
  collectorBalanceRaw?: string;
  /** Standalone sync-poke signature (below-threshold path). */
  syncSignature?: string;
  solana?: { shareRaw: string; signature: string } | null;
  evm?: StakingMirrorEvmLegResult[];
  stakeEventsMirrored?: number;
}

function sanitizeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/0x[0-9a-fA-F]{64}/g, '0x…').slice(0, 300);
}

/** Read every configured EVM chain's totalStaked(). */
async function readEvmStakeWeights(cfg: StakingMirrorConfig): Promise<Record<number, bigint>> {
  const out: Record<number, bigint> = {};
  await Promise.all(
    Object.entries(cfg.evmStaking).map(async ([chainIdStr, address]) => {
      const chainId = Number(chainIdStr);
      const client = evmPublicClient(chainId);
      out[chainId] = (await client.readContract({
        address: getAddress(address),
        abi: NAVE_STAKING_EVM_ABI,
        functionName: 'totalStaked',
      })) as bigint;
    }),
  );
  return out;
}

/**
 * Deliver one EVM chain's reward share:
 *   collector →(SPL transfer)→ bridge custody   (keeps wNAVE fully backed)
 *   lockbox.bridgeIn(relayer EOA, share, 901, nonce)   (mints wNAVE)
 *   wNAVE.approve(staking, share) + staking.notifyReward(share)
 * with a bridge_stake_events `reward_topup` audit row bracketing the EVM side.
 */
async function deliverEvmShare(
  cfg: StakingMirrorConfig,
  connection: Connection,
  relayer: Keypair,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  chainId: number,
  shareRaw: bigint,
): Promise<StakingMirrorEvmLegResult> {
  const nonce = await nextMirrorNonce(supabase, chainId);

  // 1. Move the share into bridge custody so the minted wNAVE stays backed.
  const custody = deriveCustody(new PublicKey(cfg.bridgeProgramId));
  const sourceTx = await sendSolanaTx(connection, relayer, [
    createTransferInstruction(
      new PublicKey(cfg.collectorAccount),
      custody,
      relayer.publicKey,
      shareRaw,
    ),
  ]);

  // 2. Audit row BEFORE the mint — inserting it consumes this nonce forever.
  const nowIso = new Date().toISOString();
  const { error: insertErr } = await supabase.from('bridge_stake_events').insert({
    kind: 'reward_topup',
    source_chain: 'solana',
    source_chain_id: chainId, // destination EVM chain — doubles as the nonce partition key
    source_tx: sourceTx,
    amount_raw: shareRaw.toString(),
    network: bridgeNetwork(),
    status: 'pending',
    updated_at: nowIso,
  });
  if (insertErr) {
    // The NAVE already reached custody but no wNAVE was minted; surface the
    // error so operators can reconcile (the collector→custody sig is logged).
    throw new Error(`audit insert failed after custody transfer ${sourceTx}: ${insertErr.message}`);
  }

  try {
    const { account, publicClient, wallet, chain } = evmWallet(cfg, chainId);
    // Mint via whichever lockbox currently holds wNAVE.minter() (v1 until Safe
    // rotates to the shared-wNAVE v2 lockbox).
    const { resolveMintLockbox } = await import('./bridgeRelayer.js');
    const lockbox = getAddress(await resolveMintLockbox(chainId));
    const wnave = getAddress(cfg.wrappedNave[chainId]);
    const staking = getAddress(cfg.evmStaking[chainId]);

    // 3. Mint the wrapped reward to the relayer EOA (replay key 901/nonce).
    const mintTx = await wallet.writeContract({
      address: lockbox,
      abi: NAVE_BRIDGE_LOCKBOX_ABI,
      functionName: 'bridgeIn',
      args: [account.address, shareRaw, BigInt(cfg.mirrorSrcChainId), nonce],
      chain,
      account,
    });
    const mintReceipt = await waitForReceiptRobust(publicClient, mintTx);
    if (mintReceipt.status !== 'success') throw new Error(`bridgeIn reverted (tx ${mintTx})`);

    // 4. approve + notifyReward (relayer EOA is the on-chain rewarder).
    const approveTx = await wallet.writeContract({
      address: wnave,
      abi: ERC20_APPROVE_ABI,
      functionName: 'approve',
      args: [staking, shareRaw],
      chain,
      account,
    });
    const approveReceipt = await waitForReceiptRobust(publicClient, approveTx);
    if (approveReceipt.status !== 'success') throw new Error(`approve reverted (tx ${approveTx})`);

    const notifyTx = await wallet.writeContract({
      address: staking,
      abi: NAVE_STAKING_EVM_ABI,
      functionName: 'notifyReward',
      args: [shareRaw],
      chain,
      account,
    });
    const notifyReceipt = await waitForReceiptRobust(publicClient, notifyTx);
    if (notifyReceipt.status !== 'success') throw new Error(`notifyReward reverted (tx ${notifyTx})`);

    await supabase
      .from('bridge_stake_events')
      .update({ status: 'completed', dest_tx: notifyTx, updated_at: new Date().toISOString() })
      .eq('source_tx', sourceTx);

    return { chainId, shareRaw: shareRaw.toString(), sourceTx, notifyTx };
  } catch (err) {
    const message = sanitizeError(err);
    await supabase
      .from('bridge_stake_events')
      .update({ status: 'failed', error: message, updated_at: new Date().toISOString() })
      .eq('source_tx', sourceTx);
    return { chainId, shareRaw: shareRaw.toString(), sourceTx, error: message };
  }
}

/**
 * Mirror recent EVM Staked/Unstaked events into bridge_stake_events. Audit
 * only — stake weights are read live from totalStaked(), so no on-chain
 * mirroring transaction is needed. Idempotent via unique(source_tx) +
 * ignoreDuplicates upsert; the fixed lookback window means a tx is re-seen
 * (and ignored) across several ticks before scrolling out of range.
 */
async function mirrorEvmStakeEvents(
  cfg: StakingMirrorConfig,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  chainId: number,
): Promise<number> {
  const meta = STAKING_EVM_CHAINS[chainId];
  const client = evmPublicClient(chainId);
  const address = getAddress(cfg.evmStaking[chainId]);
  const latest = await client.getBlockNumber();
  const lookback = BigInt(Math.max(0, cfg.evmLookbackBlocks));
  const fromBlock = latest > lookback ? latest - lookback : 0n;

  const [stakedLogs, unstakedLogs] = await Promise.all([
    client.getContractEvents({ address, abi: NAVE_STAKING_EVM_ABI, eventName: 'Staked', fromBlock, toBlock: latest }),
    client.getContractEvents({ address, abi: NAVE_STAKING_EVM_ABI, eventName: 'Unstaked', fromBlock, toBlock: latest }),
  ]);

  const rows = [
    ...stakedLogs.map((log) => ({ kind: 'stake', log })),
    ...unstakedLogs.map((log) => ({ kind: 'unstake', log })),
  ]
    .filter(({ log }) => log.transactionHash)
    .map(({ kind, log }) => ({
      kind,
      source_chain: meta.name,
      source_chain_id: chainId,
      source_tx: log.transactionHash as string,
      staker: (log.args.user as string | undefined)?.toLowerCase() ?? null,
      amount_raw: ((log.args.amount as bigint | undefined) ?? 0n).toString(),
      network: bridgeNetwork(),
      status: 'completed',
    }));

  if (rows.length === 0) return 0;
  const { error } = await supabase
    .from('bridge_stake_events')
    .upsert(rows, { onConflict: 'source_tx', ignoreDuplicates: true });
  if (error) throw new Error(`stake-event mirror upsert failed for chain ${chainId}: ${error.message}`);
  return rows.length;
}

/**
 * One staking-mirror tick. See the module header for the full flow. Never
 * called concurrently — the worker wraps it in an in-process mutex + a
 * cross-replica DB lease.
 */
export async function runStakingMirror(): Promise<StakingMirrorTickResult> {
  const cfg = readStakingMirrorConfig();
  if (!cfg.enabled) return { skipped: 'disabled (STAKING_MIRROR_ENABLED != true)' };
  if (!cfg.collectorAccount) throw new Error('BRIDGE_SOLANA_STAKING_COLLECTOR is not configured');

  // Fail fast on partial EVM config BEFORE any funds move: a staking address
  // without its lockbox/wNAVE/RPC/minter key would silently strand that
  // chain's share.
  for (const chainIdStr of Object.keys(cfg.evmStaking)) {
    const chainId = Number(chainIdStr);
    if (!STAKING_EVM_CHAINS[chainId]) throw new Error(`Unsupported staking-mirror EVM chain ${chainId}`);
    if (!cfg.evmLockbox[chainId]) throw new Error(`BRIDGE_EVM_LOCKBOX_${chainId} is required for the staking mirror`);
    if (!cfg.wrappedNave[chainId]) throw new Error(`BRIDGE_EVM_WRAPPED_NAVE_${chainId} is required for the staking mirror`);
    evmRpcUrl(chainId); // throws when the RPC env is missing
    if (!cfg.evmMinterPrivateKey) throw new Error('BRIDGE_EVM_MINTER_PRIVATE_KEY is required for the staking mirror');
  }

  const connection = getMirrorConnection(cfg);
  const relayer = getRelayerKeypair(cfg);
  const stakingProgramId = new PublicKey(cfg.stakingProgramId);
  const collector = new PublicKey(cfg.collectorAccount);

  const balanceRaw = BigInt((await connection.getTokenAccountBalance(collector)).value.amount);
  const result: StakingMirrorTickResult = { collectorBalanceRaw: balanceRaw.toString() };

  // Below threshold: keep the drip window fresh with a permissionless sync
  // poke, but leave the fees accumulating in the collector.
  if (!shouldDistribute(balanceRaw, cfg.minDistributionRaw)) {
    try {
      result.syncSignature = await sendSolanaTx(connection, relayer, [buildSyncInstruction(stakingProgramId)]);
    } catch (err) {
      console.warn(`[staking-mirror] sync poke failed: ${sanitizeError(err)}`);
    }
    result.skipped = `below threshold (${balanceRaw} < ${cfg.minDistributionRaw})`;
    return result;
  }

  // ── Stake weights ───────────────────────────────────────────────────────────
  const poolInfo = await connection.getAccountInfo(deriveStakePool(stakingProgramId));
  if (!poolInfo) throw new Error(`nave_staking pool account not found for program ${cfg.stakingProgramId}`);
  const pool = decodeStakePoolAccount(Buffer.from(poolInfo.data));
  const evmStaked = await readEvmStakeWeights(cfg);

  const split = splitCollectorBalance(balanceRaw, { solanaStaked: pool.totalStaked, evmStaked });
  if (split.totalStaked === 0n) {
    result.skipped = 'zero global stake — leaving fees in the collector';
    return result;
  }

  const supabase = getMirrorSupabase();

  // ── Solana leg: collector → reward_vault + sync (one atomic tx) ─────────────
  result.solana = null;
  if (split.solanaShare > 0n) {
    const signature = await sendSolanaTx(connection, relayer, [
      createTransferInstruction(collector, deriveRewardVault(stakingProgramId), relayer.publicKey, split.solanaShare),
      buildSyncInstruction(stakingProgramId),
    ]);
    result.solana = { shareRaw: split.solanaShare.toString(), signature };
    const { error } = await supabase.from('bridge_stake_events').insert({
      kind: 'reward_topup',
      source_chain: 'solana',
      source_chain_id: null,
      source_tx: signature,
      dest_tx: signature, // funding + sync land in the same Solana tx
      amount_raw: split.solanaShare.toString(),
      network: bridgeNetwork(),
      status: 'completed',
      updated_at: new Date().toISOString(),
    });
    if (error) console.warn(`[staking-mirror] Solana audit insert failed (tx ${signature}): ${error.message}`);
  }

  // ── EVM legs ─────────────────────────────────────────────────────────────────
  result.evm = [];
  const claimReserve = (process.env.STAKE_CLAIM_RESERVE || '').trim();
  const claimOnDemand = (process.env.STAKE_CLAIM_ENABLED || '').trim().toLowerCase() === 'true';

  if (claimOnDemand && claimReserve) {
    // Claim-on-demand model: EVM shares are NOT wrapped into the per-chain
    // drip contracts. The combined share parks in the relayer-owned Solana
    // reserve; stakeClaims.ts wraps and mints wNAVE straight to each staker
    // when they claim, bounded by the accrual ledger and this reserve.
    let evmTotal = 0n;
    for (const shareRaw of Object.values(split.evmShares)) evmTotal += shareRaw;
    if (evmTotal > 0n) {
      const reserveTx = await sendSolanaTx(connection, relayer, [
        createTransferInstruction(collector, new PublicKey(claimReserve), relayer.publicKey, evmTotal),
      ]);
      result.evm.push({ chainId: 0, shareRaw: evmTotal.toString(), sourceTx: reserveTx, notifyTx: 'reserved-for-claims' });
      const { error } = await supabase.from('bridge_stake_events').insert({
        kind: 'reward_reserve',
        source_chain: 'solana',
        source_chain_id: null,
        source_tx: reserveTx,
        dest_tx: reserveTx,
        amount_raw: evmTotal.toString(),
        network: bridgeNetwork(),
        status: 'completed',
        updated_at: new Date().toISOString(),
      });
      if (error) console.warn(`[staking-mirror] reserve audit insert failed (tx ${reserveTx}): ${error.message}`);
    }
  } else {
    // Legacy batched delivery (sequential — each derives its own nonce).
    for (const [chainIdStr, shareRaw] of Object.entries(split.evmShares)) {
      const chainId = Number(chainIdStr);
      if (shareRaw <= 0n) continue;
      // Skip shares below the drip's integer floor: notifyReward would accept
      // the tokens but compute rewardRate = 0 (share / rewardsDuration truncates),
      // stranding them as sweep-only dust. Left in the collector they roll into
      // the next tick until the accumulated share actually moves the rate.
      try {
        const client = evmPublicClient(chainId);
        const staking = cfg.evmStaking[chainId] as `0x${string}`;
        const [rate, finish, duration] = await Promise.all([
          client.readContract({ address: staking, abi: NAVE_STAKING_EVM_ABI, functionName: 'rewardRate' }) as Promise<bigint>,
          client.readContract({ address: staking, abi: NAVE_STAKING_EVM_ABI, functionName: 'periodFinish' }) as Promise<bigint>,
          client.readContract({ address: staking, abi: NAVE_STAKING_EVM_ABI, functionName: 'rewardsDuration' }) as Promise<bigint>,
        ]);
        const nowSec = BigInt(Math.floor(Date.now() / 1000));
        const leftover = finish > nowSec ? rate * (finish - nowSec) : 0n;
        if (!meetsRateFloor(shareRaw, leftover, duration)) {
          console.log(
            `[staking-mirror] chain ${chainId}: share ${shareRaw} below rate floor ` +
            `((share+leftover)/duration=0 with duration ${duration}s) — leaving in collector to accumulate.`,
          );
          result.evm.push({ chainId, shareRaw: shareRaw.toString(), error: 'below rate floor — deferred' });
          continue;
        }
      } catch (err) {
        // Pre-check is best-effort; on read failure proceed with delivery as before.
        console.warn(`[staking-mirror] chain ${chainId}: rate-floor pre-check failed (${sanitizeError(err)}); delivering anyway.`);
      }
      result.evm.push(await deliverEvmShare(cfg, connection, relayer, supabase, chainId, shareRaw));
    }
  }

  // ── Audit-only Staked/Unstaked mirror ───────────────────────────────────────
  let mirrored = 0;
  for (const chainIdStr of Object.keys(cfg.evmStaking)) {
    try {
      mirrored += await mirrorEvmStakeEvents(cfg, supabase, Number(chainIdStr));
    } catch (err) {
      console.warn(`[staking-mirror] event mirror failed for chain ${chainIdStr}: ${sanitizeError(err)}`);
    }
  }
  result.stakeEventsMirrored = mirrored;

  return result;
}
