import { createClient } from '@supabase/supabase-js';
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
} from '@solana/spl-token';
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  getAddress,
  http,
  type Chain,
  type Hash,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, baseSepolia, mainnet, sepolia } from 'viem/chains';
import { robinhood, robinhoodTestnet } from './evmChains.js';
import { resolveSolanaRpcUrl } from './programs.js';
import { refusesClosedMainnetBridge, wnaveMintWouldExceedCustody } from './bridgeSupplyGuard.js';
import bs58 from 'bs58';
import { confirmSolanaTransactionRobust, parseSolanaKeypair } from './solanaTxUtils.js';
import {
  buildReleaseInstruction,
  decodeAttributedBridgeLock,
  decodeBridgeConfigFees,
  deriveBridgeConfig,
  deriveCustody,
  deriveCustodyAuthority,
  deriveProcessedRelease,
  NAVE_BRIDGE_LOCKBOX_ABI,
  WRAPPED_NAVE_BRIDGE_BURN_ABI,
  type BridgeLockEvent,
} from './bridgePrograms.js';

// ─── Cross-chain NAVE token bridge relayer (trusted-relayer MVP) ──────────────
//
// NAVE is a Solana SPL token (6 decimals), home chain. A wrapped ERC-20
// "WrappedNave" (6 decimals) exists on each supported EVM chain whose mint/burn
// is controlled SOLELY by the Nave relayer minter EOA this service custodies.
//
// Supported EVM routes (env selects which are live via BRIDGE_EVM_LOCKBOX_<id>):
//   Testnet: Sepolia 11155111 / Base Sepolia 84532 / Robinhood Testnet 46630
//   Mainnet: Ethereum 1 / Base 8453 / Robinhood Chain 4663
//
// Two directions, both verified INDEPENDENTLY on-chain (the relayer never
// trusts the caller's claim — it re-reads the source tx):
//   • Solana → EVM (lock):  user locks NAVE in nave_bridge custody; relayer
//       verifies, then MINTS WrappedNave via the lockbox on the dest chain.
//   • EVM → Solana (burn):  user burns WrappedNave on EVM; relayer verifies,
//       then RELEASES NAVE from custody to the user's Solana ATA.
//
// Fee (BRIDGE_FEE_BPS, default 250 = 2.5%) is resolved on-chain by nave_bridge
// (staking / protocol / burn legs). Trust is concentrated in the minter/custody
// keys — there is NO light-client or multi-sig attestation.

// ─── Config ──────────────────────────────────────────────────────────────────

export type EvmNetwork = 'mainnet' | 'testnet';
export type EvmChainFamily = 'ethereum' | 'base' | 'robinhood';

export interface BridgeEvmChainMeta {
  chain: Chain;
  rpcEnv: string;
  /** Family name shared by the mainnet and testnet deployments ('base', ...). */
  family: EvmChainFamily;
  network: EvmNetwork;
  /**
   * Safe default confirmation depth before acting on a burn (reorg guard).
   * Rationale: Ethereum L1 ~12 blocks (~2.5 min) is the conventional
   * probabilistic-finality depth; Base (2s blocks) 30 ≈ 1 min of sequencer
   * blocks; Robinhood Chain is an Arbitrum-Nitro L2 with ~250ms blocks whose
   * soft-confirmed sequencer output can be reordered until L1 posting, so 60
   * blocks (~15s) is the floor rather than a handful of blocks. Testnets mirror
   * their mainnet counterpart so behaviour is exercised end-to-end before
   * cutover. Override per chain via BRIDGE_EVM_CONFIRMATIONS_<chainId>.
   */
  defaultConfirmations: number;
  /** Approximate block time in seconds (for lookback seconds→blocks conversion). */
  blockTimeSeconds: number;
}

/** chainId → chain metadata. Testnet + mainnet; env selects live routes. */
export const BRIDGE_EVM_CHAINS: Record<number, BridgeEvmChainMeta> = {
  // Testnets
  11155111: { chain: sepolia, rpcEnv: 'EVM_SEPOLIA_RPC_URL', family: 'ethereum', network: 'testnet', defaultConfirmations: 12, blockTimeSeconds: 12 },
  84532: { chain: baseSepolia, rpcEnv: 'EVM_BASE_SEPOLIA_RPC_URL', family: 'base', network: 'testnet', defaultConfirmations: 30, blockTimeSeconds: 2 },
  46630: { chain: robinhoodTestnet, rpcEnv: 'EVM_ROBINHOOD_TESTNET_RPC_URL', family: 'robinhood', network: 'testnet', defaultConfirmations: 60, blockTimeSeconds: 0.25 },
  // Mainnets
  1: { chain: mainnet, rpcEnv: 'EVM_ETHEREUM_RPC_URL', family: 'ethereum', network: 'mainnet', defaultConfirmations: 12, blockTimeSeconds: 12 },
  8453: { chain: base, rpcEnv: 'EVM_BASE_RPC_URL', family: 'base', network: 'mainnet', defaultConfirmations: 30, blockTimeSeconds: 2 },
  4663: { chain: robinhood, rpcEnv: 'EVM_ROBINHOOD_RPC_URL', family: 'robinhood', network: 'mainnet', defaultConfirmations: 60, blockTimeSeconds: 0.25 },
};

/** Every chain id this binary knows about, sorted. */
export const KNOWN_BRIDGE_EVM_CHAIN_IDS: readonly number[] = Object.keys(BRIDGE_EVM_CHAINS)
  .map(Number)
  .sort((a, b) => a - b);

/**
 * Explicit EVM network selector (`NAVE_EVM_NETWORK=mainnet|testnet`). This is
 * the ONLY signal used to resolve family names ('base', 'ethereum',
 * 'robinhood') to a concrete chain id — never the Solana cluster/RPC, which
 * is a different network with no necessary relationship to the EVM side.
 * Returns null when unset/invalid (callers fail closed on ambiguity).
 */
export function readEvmNetwork(): EvmNetwork | null {
  const raw = (process.env.NAVE_EVM_NETWORK || '').trim().toLowerCase();
  if (raw === 'mainnet') return 'mainnet';
  if (raw === 'testnet') return 'testnet';
  return null;
}

/**
 * The set of EVM chain ids this deployment is allowed to relay to/from.
 * `BRIDGE_EVM_CHAIN_IDS` (comma-separated) narrows it explicitly; otherwise it
 * defaults to every known chain on `NAVE_EVM_NETWORK` (or every known chain
 * when that is unset too). A chain id outside this set is rejected up-front
 * even if a lockbox happens to be configured for it.
 */
export function readBridgeEvmChainIds(): Set<number> {
  const raw = (process.env.BRIDGE_EVM_CHAIN_IDS || '').trim();
  if (raw) {
    const out = new Set<number>();
    for (const part of raw.split(',')) {
      const n = Number(part.trim());
      if (Number.isInteger(n) && BRIDGE_EVM_CHAINS[n]) out.add(n);
    }
    return out;
  }
  const network = readEvmNetwork();
  return new Set(
    KNOWN_BRIDGE_EVM_CHAIN_IDS.filter((id) => !network || BRIDGE_EVM_CHAINS[id].network === network),
  );
}

/** Sorted chain-id list for error messages. */
function supportedChainIdList(): string {
  return [...readBridgeEvmChainIds()].sort((a, b) => a - b).join(', ');
}

export type BridgeDirection = 'solana_to_evm' | 'evm_to_solana';

/**
 * Default mainnet protocol-revenue wallet (25%→1% leg destination owner). The
 * fee split itself is resolved ON-CHAIN by the nave_bridge program; this value
 * is surfaced for config/telemetry and to seed the on-chain config at cutover.
 */
export const DEFAULT_PROTOCOL_REVENUE_WALLET = '6N5JiWP2zF6VXhG6hwgYEYhxBEARAV5P6WRgfYb2zskC';

/** Internal source-chain id the EVM lockbox stamps on Solana-origin mints. */
export const DEFAULT_SOLANA_SRC_CHAIN_ID = 900;

/**
 * Legacy global confirmation depth (BRIDGE_EVM_CONFIRMATIONS). Retained only as
 * a FLOOR that can raise — never lower — a chain's safe default; per-chain
 * `BRIDGE_EVM_CONFIRMATIONS_<chainId>` is the operator override.
 */
export const DEFAULT_EVM_CONFIRMATIONS = 5;

/** Default missed-event lookback window in seconds (2 hours). */
export const DEFAULT_BRIDGE_LOOKBACK_SECONDS = 2 * 60 * 60;

/**
 * Chain-aware confirmation depth used by BOTH the burn verifier and the
 * watcher. Precedence:
 *   1. `BRIDGE_EVM_CONFIRMATIONS_<chainId>` — explicit per-chain operator value;
 *   2. otherwise `max(chain safe default, BRIDGE_EVM_CONFIRMATIONS if set)`.
 * A fixed global count is NOT chain-aware — 5 blocks is ~1 minute on Ethereum
 * but ~1 second on Robinhood (4663) — so the global value can only ever
 * deepen the per-chain default, never shallow it.
 */
export function evmConfirmationsForChain(chainId: number, globalFloor?: number): number {
  const raw = (process.env[`BRIDGE_EVM_CONFIRMATIONS_${chainId}`] || '').trim();
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return Math.trunc(n);
  }
  const meta = BRIDGE_EVM_CHAINS[chainId];
  const chainDefault = meta ? meta.defaultConfirmations : DEFAULT_EVM_CONFIRMATIONS;
  const globalRaw = (process.env.BRIDGE_EVM_CONFIRMATIONS || '').trim();
  const floor = globalFloor ?? (globalRaw && Number.isFinite(Number(globalRaw)) ? Number(globalRaw) : 0);
  return Math.max(chainDefault, Math.trunc(floor));
}

/** chainId → effective confirmation depth for every known chain (health/ops). */
export function evmConfirmationsByChain(): Record<number, number> {
  const out: Record<number, number> = {};
  for (const id of KNOWN_BRIDGE_EVM_CHAIN_IDS) out[id] = evmConfirmationsForChain(id);
  return out;
}

/** Missed-event lookback window in seconds (`BRIDGE_LOOKBACK_SECONDS`, default 2h). */
export function bridgeLookbackSeconds(): number {
  const raw = (process.env.BRIDGE_LOOKBACK_SECONDS || '').trim();
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : DEFAULT_BRIDGE_LOOKBACK_SECONDS;
}

/**
 * Convert the lookback window into blocks for a chain using its approximate
 * block time (ceil, at least 1 block). Robinhood's ~250ms blocks make a 2h
 * window ~28,800 blocks; Ethereum's 12s blocks make it ~600.
 */
export function lookbackBlocksForChain(chainId: number, seconds: number = bridgeLookbackSeconds()): bigint {
  const meta = BRIDGE_EVM_CHAINS[chainId];
  const blockTime = meta?.blockTimeSeconds && meta.blockTimeSeconds > 0 ? meta.blockTimeSeconds : 12;
  return BigInt(Math.max(1, Math.ceil(seconds / blockTime)));
}

export interface BridgeConfig {
  enabled: boolean;
  /** Solana RPC (falls back to the service-wide SOLANA_RPC_URL). */
  solanaRpcUrl: string;
  /** NAVE SPL mint (base58). */
  naveMint: string;
  /** nave_bridge program id (base58). Custody + config PDAs are derived from it. */
  bridgeProgramId: string;
  /** Relayer keypair secret — the on-chain `config.relayer` that signs release. */
  relayerSecret: string | undefined;
  /** Protocol-revenue NAVE token account (release fee-split destination). */
  protocolFeeAccount: string;
  /** Staking-pool reward-vault NAVE token account (release fee-split destination). */
  stakingPoolAccount: string;
  /** Protocol-revenue wallet OWNER pubkey (telemetry / cutover seeding). */
  protocolRevenueWallet: string;
  /** chainId → NaveBridge lockbox address (v2 UUPS — preferred mint path). */
  evmLockbox: Record<number, string>;
  /** chainId → canonical WrappedNave (single shared token; typically v1 address). */
  wrappedNave: Record<number, string>;
  /**
   * Optional legacy v1 lockbox per chain. Used as mint fallback while wNAVE.minter()
   * still points at v1 (before Safe rotates minter to the v2 lockbox). Burns always
   * go through `wrappedNave` (same token).
   */
  evmLockboxV1: Record<number, string>;
  /** 0x EOA private key the relayer uses to call the EVM lockbox `bridgeIn`. */
  evmMinterPrivateKey: string | undefined;
  /** Internal chain id stamped as `srcChainId` on Solana→EVM mints. */
  solanaSrcChainId: number;
  /** EVM confirmation depth required before releasing on Solana. */
  evmConfirmations: number;
  /** Fee in basis points charged ON TOP of the bridged amount (default 250 = 2.5%). */
  feeBps: number;
}

function envBool(name: string): boolean {
  return (process.env[name] || '').trim().toLowerCase() === 'true';
}

function envNum(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw && Number.isFinite(Number(raw)) ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Read the bridge configuration from the environment. All keys are namespaced
 * under BRIDGE_*; EVM RPC URLs reuse the existing EVM_SEPOLIA_RPC_URL /
 * EVM_BASE_SEPOLIA_RPC_URL names already consumed by evmRelayer.ts.
 */
export function readBridgeConfig(): BridgeConfig {
  // Canonical wNAVE + preferred v2 lockbox: BRIDGE_EVM_WRAPPED_NAVE_<id> / BRIDGE_EVM_LOCKBOX_<id>
  // Legacy v1 lockbox (mint fallback until minter rotation): BRIDGE_EVM_LOCKBOX_V1_<id>
  const wrappedNave: Record<number, string> = {};
  const evmLockbox: Record<number, string> = {};
  const evmLockboxV1: Record<number, string> = {};
  for (const chainId of Object.keys(BRIDGE_EVM_CHAINS).map(Number)) {
    const w = process.env[`BRIDGE_EVM_WRAPPED_NAVE_${chainId}`]?.trim();
    if (w) wrappedNave[chainId] = w;
    const l = process.env[`BRIDGE_EVM_LOCKBOX_${chainId}`]?.trim();
    if (l) evmLockbox[chainId] = l;
    const l1 = process.env[`BRIDGE_EVM_LOCKBOX_V1_${chainId}`]?.trim();
    if (l1) evmLockboxV1[chainId] = l1;
  }

  const feeBps = envNum('BRIDGE_FEE_BPS', 250);

  return {
    enabled: envBool('BRIDGE_RELAYER_ENABLED'),
    solanaRpcUrl: (process.env.BRIDGE_SOLANA_RPC_URL || resolveSolanaRpcUrl()).trim(),
    naveMint: (process.env.BRIDGE_SOLANA_NAVE_MINT || '').trim(),
    bridgeProgramId: (process.env.BRIDGE_SOLANA_BRIDGE_PROGRAM || '').trim(),
    // Prefer the new dedicated relayer key; fall back to the legacy custody
    // authority env name for a smooth cutover.
    relayerSecret: process.env.BRIDGE_SOLANA_RELAYER_AUTHORITY || process.env.BRIDGE_SOLANA_CUSTODY_AUTHORITY,
    protocolFeeAccount: (process.env.BRIDGE_SOLANA_PROTOCOL_FEE_ACCOUNT || '').trim(),
    stakingPoolAccount: (process.env.BRIDGE_SOLANA_STAKING_POOL_ACCOUNT || '').trim(),
    protocolRevenueWallet: (process.env.BRIDGE_SOLANA_PROTOCOL_WALLET || DEFAULT_PROTOCOL_REVENUE_WALLET).trim(),
    evmLockbox,
    wrappedNave,
    evmLockboxV1,
    evmMinterPrivateKey: process.env.BRIDGE_EVM_MINTER_PRIVATE_KEY,
    solanaSrcChainId: envNum('BRIDGE_SOLANA_SRC_CHAIN_ID', DEFAULT_SOLANA_SRC_CHAIN_ID),
    evmConfirmations: envNum('BRIDGE_EVM_CONFIRMATIONS', DEFAULT_EVM_CONFIRMATIONS),
    feeBps: feeBps >= 0 && feeBps < 10_000 ? feeBps : 250,
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

let _relayerKeypair: Keypair | null = null;
function getRelayerKeypair(cfg: BridgeConfig): Keypair {
  if (_relayerKeypair) return _relayerKeypair;
  if (!cfg.relayerSecret) {
    throw new Error('BRIDGE_SOLANA_RELAYER_AUTHORITY is not configured');
  }
  _relayerKeypair = parseSolanaKeypair(cfg.relayerSecret);
  return _relayerKeypair;
}

let _bridgeConnection: Connection | null = null;
function getBridgeConnection(cfg: BridgeConfig): Connection {
  if (_bridgeConnection) return _bridgeConnection;
  _bridgeConnection = new Connection(cfg.solanaRpcUrl, 'confirmed');
  return _bridgeConnection;
}

let _bridgeSupabase: ReturnType<typeof createClient> | null = null;
function getBridgeSupabase(): ReturnType<typeof createClient> {
  if (_bridgeSupabase) return _bridgeSupabase;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured');
  _bridgeSupabase = createClient(url, key);
  return _bridgeSupabase;
}

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const EVM_TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

export interface ResolveEvmChainOptions {
  /**
   * Network hint used ONLY to disambiguate a legacy family name when
   * NAVE_EVM_NETWORK is unset (e.g. the `network` column of an existing
   * bridge_transfers row the watcher is re-driving). Never applied to numeric
   * ids, which are validated against the configured chain set instead.
   */
  network?: EvmNetwork | null;
}

const deprecationWarned = new Set<string>();
function warnFamilyNameDeprecated(name: string, resolved: number): void {
  if (deprecationWarned.has(name)) return;
  deprecationWarned.add(name);
  console.warn(
    `[bridge] DEPRECATED: chain family name '${name}' supplied to /bridge-relay (resolved to ${resolved} via ` +
      `NAVE_EVM_NETWORK). Send the numeric chainId (destChainId / sourceChainId) instead — family-name input ` +
      'will be removed in the next release.',
  );
}

/**
 * Resolve an EVM chain id from the canonical numeric id or a legacy chain name.
 *
 * Numeric ids (number or digit string) are unambiguous and are validated
 * against {@link readBridgeEvmChainIds} — the configured allow-list, which by
 * default is every known chain on `NAVE_EVM_NETWORK`. Family names
 * ('ethereum' / 'base' / 'robinhood') are DEPRECATED: they are resolved ONLY
 * through the explicit `NAVE_EVM_NETWORK` env (or `opts.network`), never via
 * the Solana cluster, and fail closed when neither is set. Explicit
 * *-sepolia / *-testnet / *-mainnet aliases pin their network but are still
 * deprecated in favour of the numeric id.
 */
export function resolveEvmChainId(input: string | number, opts: ResolveEvmChainOptions = {}): number {
  const allowed = readBridgeEvmChainIds();
  const acceptId = (id: number): number => {
    if (!BRIDGE_EVM_CHAINS[id]) {
      throw new Error(`Unsupported EVM chain ${id} (supported: ${supportedChainIdList()})`);
    }
    if (!allowed.has(id)) {
      const network = readEvmNetwork();
      throw new Error(
        `EVM chain ${id} is not enabled on this relayer` +
          (network ? ` (NAVE_EVM_NETWORK=${network}` : ' (BRIDGE_EVM_CHAIN_IDS') +
          `; supported: ${supportedChainIdList()})`,
      );
    }
    return id;
  };

  if (typeof input === 'number') return acceptId(input);
  const s = input.trim().toLowerCase();
  if (/^\d+$/.test(s)) return acceptId(Number(s));

  // Explicit network-pinned aliases (legacy; unambiguous but deprecated).
  const pinned: Record<string, number> = {
    sepolia: 11155111, 'ethereum-sepolia': 11155111, 'eth-sepolia': 11155111,
    'base-sepolia': 84532, basesepolia: 84532, base_sepolia: 84532,
    'robinhood-testnet': 46630, robinhoodtestnet: 46630, robinhood_testnet: 46630,
    'ethereum-mainnet': 1, 'eth-mainnet': 1,
    'base-mainnet': 8453,
    'robinhood-mainnet': 4663, robinhoodmainnet: 4663, robinhood_mainnet: 4663,
  };
  if (pinned[s] !== undefined) {
    const id = acceptId(pinned[s]);
    warnFamilyNameDeprecated(s, id);
    return id;
  }

  // Family names: resolved through the EXPLICIT EVM network only (fail closed).
  const family: EvmChainFamily | null =
    s === 'ethereum' || s === 'eth' ? 'ethereum' : s === 'base' ? 'base' : s === 'robinhood' ? 'robinhood' : null;
  if (!family) {
    throw new Error(
      `Unsupported EVM chain '${input}' (send the numeric chainId; supported: ${supportedChainIdList()})`,
    );
  }
  const network = opts.network ?? readEvmNetwork();
  if (!network) {
    throw new Error(
      `Ambiguous EVM chain '${input}': family names resolve only via NAVE_EVM_NETWORK (mainnet|testnet), ` +
        'which is not set. Send the numeric chainId instead.',
    );
  }
  const match = KNOWN_BRIDGE_EVM_CHAIN_IDS.find(
    (id) => BRIDGE_EVM_CHAINS[id].family === family && BRIDGE_EVM_CHAINS[id].network === network,
  );
  if (match === undefined) throw new Error(`No ${network} chain configured for family '${family}'`);
  const id = acceptId(match);
  warnFamilyNameDeprecated(s, id);
  return id;
}

/** Network ('mainnet' | 'testnet') of a known EVM chain id. */
export function evmChainNetwork(chainId: number): EvmNetwork {
  const meta = BRIDGE_EVM_CHAINS[chainId];
  if (!meta) throw new Error(`Unsupported EVM chain ${chainId}`);
  return meta.network;
}

function isSolanaChain(input: string | number): boolean {
  return typeof input === 'string' && input.trim().toLowerCase() === 'solana';
}

function evmRpcUrl(chainId: number): string {
  const cfg = BRIDGE_EVM_CHAINS[chainId];
  const url = process.env[cfg.rpcEnv];
  if (!url) throw new Error(`Bridge RPC not configured: set ${cfg.rpcEnv} for chain ${chainId}`);
  return url;
}

// ─── Fee-bps drift guard ──────────────────────────────────────────────────────

export interface FeeBpsDriftResult {
  /** True when no drift was detected (or the check was skipped). */
  ok: boolean;
  /** Set when the check could not run (disabled / unconfigured / RPC error). */
  skipped?: string;
  envFeeBps: number;
  onChainFeeBps?: number;
  onChainStakingBps?: number;
  onChainProtocolBps?: number;
  onChainBurnBps?: number;
  error?: string;
}

/**
 * Preflight fee-bps drift guard: the fee is duplicated in three places — the
 * on-chain `BridgeConfig.fee_bps` (what the program actually charges on lock/
 * release), this service's `BRIDGE_FEE_BPS` (used for EVM→Solana net-from-
 * gross math), and the app's `VITE_NAVE_BRIDGE_FEE_BPS` (the quote users see).
 * If they drift, the relayer's computed net diverges from what the program
 * pays out (releases start failing or mis-splitting) and quotes lie to users.
 *
 * This check compares the two the signer can see at runtime: env vs on-chain.
 * (env-vs-app agreement is enforced by feeBpsDrift.test.ts in CI, since the
 * app's VITE_* env is not present in the signer's environment.) NON-FATAL by
 * design: it reports/logs the drift so operators can fix config, but never
 * blocks startup — availability of already-verified relays is preferable to a
 * hard crash-loop on a config mismatch.
 */
export async function checkBridgeFeeBpsDrift(): Promise<FeeBpsDriftResult> {
  const cfg = readBridgeConfig();
  const base: FeeBpsDriftResult = { ok: true, envFeeBps: cfg.feeBps };
  if (!cfg.enabled) return { ...base, skipped: 'bridge relayer disabled' };
  if (!cfg.bridgeProgramId) return { ...base, skipped: 'BRIDGE_SOLANA_BRIDGE_PROGRAM not configured' };
  try {
    const connection = getBridgeConnection(cfg);
    const configPda = deriveBridgeConfig(new PublicKey(cfg.bridgeProgramId));
    const info = await connection.getAccountInfo(configPda);
    if (!info) return { ...base, skipped: `BridgeConfig account ${configPda.toBase58()} not found` };
    const fees = decodeBridgeConfigFees(Buffer.from(info.data));
    const result: FeeBpsDriftResult = {
      ok: fees.feeBps === cfg.feeBps,
      envFeeBps: cfg.feeBps,
      onChainFeeBps: fees.feeBps,
      onChainStakingBps: fees.stakingBps,
      onChainProtocolBps: fees.protocolBps,
      onChainBurnBps: fees.burnBps,
    };
    if (!result.ok) {
      result.error =
        `FEE BPS DRIFT: on-chain BridgeConfig.fee_bps=${fees.feeBps} != BRIDGE_FEE_BPS env=${cfg.feeBps}. ` +
        'EVM→Solana net math and app quotes will diverge from what the program charges. ' +
        'Align BRIDGE_FEE_BPS / VITE_NAVE_BRIDGE_FEE_BPS with the on-chain config (or update it).';
    }
    return result;
  } catch (err) {
    return { ...base, skipped: `drift check failed: ${sanitizeError(err)}` };
  }
}

// ─── Fee math ──────────────────────────────────────────────────────────────────

/**
 * Legacy split (fee taken OUT of the amount). Retained for reference/tests; the
 * mainnet-hardened bridge charges the fee ON TOP and resolves it on-chain.
 */
export function feeSplit(amountRaw: bigint, bps: number): { feeRaw: bigint; netRaw: bigint } {
  const b = BigInt(Math.trunc(bps));
  const feeRaw = (amountRaw * b) / 10_000n;
  return { feeRaw, netRaw: amountRaw - feeRaw };
}

/**
 * Fee-on-top math for the EVM→Solana direction: the user burned `gross`
 * (net + fee) wNAVE, so the net they receive on Solana is
 * `net = gross * 10000 / (10000 + feeBps)`. The remaining `gross - net` is the
 * fee, resolved on Solana by the nave_bridge program.
 */
export function netFromGross(grossRaw: bigint, bps: number): { netRaw: bigint; feeRaw: bigint } {
  const b = BigInt(Math.trunc(bps));
  const netRaw = (grossRaw * 10_000n) / (10_000n + b);
  return { netRaw, feeRaw: grossRaw - netRaw };
}

const ZERO_BYTES32 = '0x0000000000000000000000000000000000000000000000000000000000000000';

// ─── Source verification ─────────────────────────────────────────────────────

/**
 * Verify a Solana lock by decoding the `nave_bridge.BridgeLock` event emitted
 * in the FINALIZED transaction `sig`. The lock instruction embeds the EVM
 * recipient + destination chain and emits a monotonic outbound `nonce`; because
 * the recipient is bound INTO the user's single signed transaction, no separate
 * off-chain recipient signature is needed to authorize the payout. Returns the
 * decoded event. Throws if the tx is missing/failed or has no BridgeLock.
 *
 * ATTRIBUTION (audit CRITICAL): the event is only accepted when it is provably
 * emitted BY `bridgeProgramId` — the program must appear in the transaction's
 * account keys and be the target of the outer instruction or an inner CPI, and
 * the `Program data:` line must sit inside that program's `invoke`/`success`
 * log bracket. A foreign program logging an identically-shaped payload is
 * rejected (see bridgePrograms.decodeAttributedBridgeLock).
 */
export async function verifySolanaLock(
  connection: Connection,
  sig: string,
  bridgeProgramId: PublicKey | string,
): Promise<BridgeLockEvent> {
  const parsed = await connection.getParsedTransaction(sig, {
    commitment: 'finalized',
    maxSupportedTransactionVersion: 0,
  });
  if (!parsed) throw new Error('source transaction not found or not finalized');
  if (parsed.meta?.err) throw new Error('source transaction failed on-chain');

  const event = decodeAttributedBridgeLock(parsed, bridgeProgramId);
  if (!event) {
    throw new Error('no nave_bridge BridgeLock event found in the source transaction');
  }
  if (event.netAmount <= 0n) throw new Error('locked net amount is zero');
  return event;
}

export interface EvmBurnResult {
  /** Gross wNAVE burned (net + fee). */
  grossRaw: bigint;
  /** Embedded Solana recipient (base58), decoded from the 32-byte event field. */
  solanaRecipient: string;
  /** EVM sender that burned. */
  sender: string;
}

/**
 * Verify an EVM burn against the canonical WrappedNave (single shared token).
 */
export async function verifyEvmBurn(
  publicClient: PublicClient,
  txHash: Hash,
  wrappedNaveAddress: string,
  minConfirmations: number,
): Promise<EvmBurnResult> {
  const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
  if (receipt.status !== 'success') throw new Error('burn transaction reverted on-chain');

  // Reorg guard: require the burn to be buried under `minConfirmations` blocks.
  if (minConfirmations > 0) {
    const latest = await publicClient.getBlockNumber();
    const confirmations = latest >= receipt.blockNumber ? latest - receipt.blockNumber + 1n : 0n;
    if (confirmations < BigInt(minConfirmations)) {
      throw new Error(
        `burn transaction has ${confirmations} confirmations; need ${minConfirmations} before releasing`,
      );
    }
  }

  const wrapped = getAddress(wrappedNaveAddress);
  let result: EvmBurnResult | undefined;

  for (const log of receipt.logs) {
    if (getAddress(log.address) !== wrapped) continue;
    let decoded: { eventName: string; args: Record<string, unknown> } | undefined;
    try {
      decoded = decodeEventLog({
        abi: WRAPPED_NAVE_BRIDGE_BURN_ABI,
        data: log.data,
        topics: log.topics,
      }) as { eventName: string; args: Record<string, unknown> };
    } catch {
      continue;
    }
    if (decoded.eventName === 'BridgeBurnTo') {
      const solRecipientHex = String(decoded.args.solanaRecipient);
      if (solRecipientHex === ZERO_BYTES32) continue;
      const solanaRecipient = bs58.encode(Buffer.from(solRecipientHex.slice(2), 'hex'));
      result = {
        grossRaw: BigInt(decoded.args.amount as bigint),
        solanaRecipient,
        sender: String(decoded.args.from).toLowerCase(),
      };
      break; // BridgeBurnTo is authoritative (recipient embedded)
    }
  }

  if (!result || result.grossRaw === 0n) {
    throw new Error(
      'no WrappedNave BridgeBurnTo (recipient-embedded burn) found in the source transaction',
    );
  }
  return result;
}

// ─── Destination execution ───────────────────────────────────────────────────

/**
 * Resolve which lockbox may mint on this chain: prefer the configured v2
 * lockbox when it is the on-chain wNAVE.minter(); otherwise fall back to the
 * legacy v1 lockbox. Keeps Solana→EVM live across Safe minter rotation.
 */
export async function resolveMintLockbox(
  chainId: number,
  cfg: BridgeConfig = readBridgeConfig(),
): Promise<string> {
  const wnave = cfg.wrappedNave[chainId];
  const primary = cfg.evmLockbox[chainId];
  const legacy = cfg.evmLockboxV1[chainId];
  if (!wnave) throw new Error(`WrappedNave not configured for chain ${chainId}`);
  if (!primary && !legacy) throw new Error(`NaveBridge lockbox not configured for chain ${chainId}`);

  const chainCfg = BRIDGE_EVM_CHAINS[chainId];
  if (!chainCfg) throw new Error(`Unsupported EVM chain ${chainId}`);
  const client = createPublicClient({
    chain: chainCfg.chain,
    transport: http(evmRpcUrl(chainId)),
  }) as PublicClient;

  const minter = (await client.readContract({
    address: getAddress(wnave),
    abi: [{ type: 'function', name: 'minter', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }],
    functionName: 'minter',
  })) as string;
  const minterLc = getAddress(minter).toLowerCase();

  if (primary && getAddress(primary).toLowerCase() === minterLc) return getAddress(primary);
  if (legacy && getAddress(legacy).toLowerCase() === minterLc) return getAddress(legacy);

  throw new Error(
    `wNAVE minter ${minter} on chain ${chainId} matches neither BRIDGE_EVM_LOCKBOX_${chainId}` +
      (legacy ? ` nor BRIDGE_EVM_LOCKBOX_V1_${chainId}` : '') +
      '. Complete Safe setMinter → acceptMinterRole, or set the matching lockbox env.',
  );
}

const ERC20_TOTAL_SUPPLY_ABI = [
  {
    type: 'function',
    name: 'totalSupply',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
] as const;

async function readSolanaCustodyRaw(cfg: BridgeConfig): Promise<bigint> {
  if (!cfg.bridgeProgramId || !cfg.naveMint || !cfg.solanaRpcUrl) {
    throw new Error('bridge program, NAVE mint, or Solana RPC is unset');
  }
  const connection = new Connection(cfg.solanaRpcUrl, 'confirmed');
  const custody = deriveCustody(new PublicKey(cfg.bridgeProgramId));
  const bal = await connection.getTokenAccountBalance(custody);
  return BigInt(bal.value.amount);
}

async function readErc20TotalSupply(chainId: number, token: string): Promise<bigint> {
  const chainCfg = BRIDGE_EVM_CHAINS[chainId];
  if (!chainCfg) throw new Error(`Unsupported EVM chain ${chainId}`);
  const client = createPublicClient({ chain: chainCfg.chain, transport: http(evmRpcUrl(chainId)) });
  return client.readContract({
    address: getAddress(token),
    abi: ERC20_TOTAL_SUPPLY_ABI,
    functionName: 'totalSupply',
  });
}

/**
 * Refuse a wNAVE mint that would push outstanding wrapped supply above Solana
 * custody. On mainnet, a missing custody read or an unreadable configured
 * wNAVE `totalSupply` fails closed. On testnet, an unreadable check is logged
 * and skipped so local mock RPCs can still exercise the mint path.
 */
export async function assertWnaveMintWithinCustody(
  chainId: number,
  mintRaw: bigint,
  cfg: BridgeConfig = readBridgeConfig(),
): Promise<void> {
  const network = evmChainNetwork(chainId);
  const mainnet = network === 'mainnet';

  let custodyRaw: bigint;
  try {
    custodyRaw = await readSolanaCustodyRaw(cfg);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (mainnet) {
      throw new Error(`refusing to mint wNAVE: Solana custody cannot be read (${detail})`);
    }
    console.warn(`[bridge] wNAVE supply guard skipped on testnet: custody unreadable (${detail})`);
    return;
  }

  const sameNetwork = KNOWN_BRIDGE_EVM_CHAIN_IDS.filter((id) => BRIDGE_EVM_CHAINS[id].network === network);
  let outstanding = 0n;
  for (const id of sameNetwork) {
    const token = cfg.wrappedNave[id];
    if (!token) {
      if (mainnet && id === chainId) {
        throw new Error(`refusing to mint wNAVE: WrappedNave not configured for chain ${id}`);
      }
      continue;
    }
    try {
      outstanding += await readErc20TotalSupply(id, token);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      if (mainnet) {
        throw new Error(`refusing to mint wNAVE: wNAVE totalSupply unreadable on chain ${id} (${detail})`);
      }
      console.warn(`[bridge] wNAVE supply guard skipped on testnet: totalSupply unreadable on ${id} (${detail})`);
      return;
    }
  }

  if (wnaveMintWouldExceedCustody(outstanding, mintRaw, custodyRaw)) {
    throw new Error(
      `refusing to mint wNAVE: outstanding + mint exceeds Solana custody (outstanding ${outstanding}, mint ${mintRaw}, custody ${custodyRaw})`,
    );
  }
}

/**
 * Mint wNAVE on the destination EVM chain via the NaveBridge lockbox's
 * relayer-only `bridgeIn` — bounded on-chain by pause + per-tx + rolling daily
 * caps + a per-message replay guard keyed on `(srcChainId, srcNonce)`. The fee
 * was already resolved on Solana when the user locked, so only the NET is
 * minted here. Returns the mint tx hash.
 */
export async function mintWrappedOnEvm(
  chainId: number,
  recipient: string,
  netRaw: bigint,
  srcChainId: number,
  srcNonce: bigint,
): Promise<{ mintTx: Hash }> {
  const cfg = readBridgeConfig();
  if (!cfg.evmMinterPrivateKey) throw new Error('BRIDGE_EVM_MINTER_PRIVATE_KEY is not configured');
  const chainCfg = BRIDGE_EVM_CHAINS[chainId];
  if (!chainCfg) throw new Error(`Unsupported EVM chain ${chainId}`);
  await assertWnaveMintWithinCustody(chainId, netRaw, cfg);
  const lockboxAddr = await resolveMintLockbox(chainId, cfg);
  if (!EVM_ADDRESS_RE.test(recipient)) throw new Error('recipient must be a 20-byte EVM address');

  const key = cfg.evmMinterPrivateKey.startsWith('0x')
    ? cfg.evmMinterPrivateKey
    : `0x${cfg.evmMinterPrivateKey}`;
  const account = privateKeyToAccount(key as `0x${string}`);

  const transport = http(evmRpcUrl(chainId));
  const publicClient = createPublicClient({ chain: chainCfg.chain, transport }) as PublicClient;
  const wallet = createWalletClient({ account, chain: chainCfg.chain, transport });

  const mintTx = await wallet.writeContract({
    address: getAddress(lockboxAddr),
    abi: NAVE_BRIDGE_LOCKBOX_ABI,
    functionName: 'bridgeIn',
    args: [getAddress(recipient), netRaw, BigInt(srcChainId), srcNonce],
    chain: chainCfg.chain,
    account,
  });
  const mintReceipt = await waitForReceiptRobust(publicClient, mintTx);
  if (mintReceipt.status !== 'success') throw new Error(`NaveBridge bridgeIn reverted (tx ${mintTx})`);
  return { mintTx };
}

/**
 * Wait for an EVM transaction receipt, tolerating viem's polling timeout: if
 * `waitForTransactionReceipt` gives up before seeing the receipt (RPC lag,
 * slow block times), the transaction can still be mined moments later. Do one
 * direct `getTransactionReceipt` check before treating it as a real failure —
 * mirrors `confirmSolanaTransactionRobust`'s rationale on the Solana side.
 */
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
      // Not found yet either — fall through and surface the original error.
    }
    throw err;
  }
}

/**
 * Release NAVE on Solana via the `nave_bridge.release` instruction: the program
 * pays `netRaw` to the recipient out of custody and resolves the 2.5% fee on
 * Solana (burn / staking / protocol), bounded by the on-chain pause + per-tx +
 * daily caps and a `ProcessedRelease` replay guard keyed on the EVM burn tx
 * hash. The relayer signs (as `config.relayer`) and pays rent for the
 * recipient ATA + replay PDA. Returns the confirmed signature.
 */
export async function releaseNaveOnSolana(
  recipient: string,
  netRaw: bigint,
  sourceChainId: number,
  sourceMessageIdHex: string,
): Promise<{ signature: string }> {
  const cfg = readBridgeConfig();
  if (!cfg.naveMint) throw new Error('BRIDGE_SOLANA_NAVE_MINT is not configured');
  if (!cfg.bridgeProgramId) throw new Error('BRIDGE_SOLANA_BRIDGE_PROGRAM is not configured');
  if (!cfg.protocolFeeAccount) throw new Error('BRIDGE_SOLANA_PROTOCOL_FEE_ACCOUNT is not configured');
  if (!cfg.stakingPoolAccount) throw new Error('BRIDGE_SOLANA_STAKING_POOL_ACCOUNT is not configured');

  const connection = getBridgeConnection(cfg);
  const relayer = getRelayerKeypair(cfg);
  const programId = new PublicKey(cfg.bridgeProgramId);
  const mint = new PublicKey(cfg.naveMint);
  const recipientOwner = new PublicKey(recipient);

  const config = deriveBridgeConfig(programId);
  const custody = deriveCustody(programId);
  const custodyAuthority = deriveCustodyAuthority(programId);
  const recipientAta = getAssociatedTokenAddressSync(mint, recipientOwner, true);

  const messageId = Uint8Array.from(Buffer.from(sourceMessageIdHex.replace(/^0x/, ''), 'hex'));
  if (messageId.length !== 32) throw new Error('sourceMessageId must be a 32-byte EVM tx hash');
  const processedRelease = deriveProcessedRelease(programId, config, BigInt(sourceChainId), messageId);

  const instructions: TransactionInstruction[] = [];
  if (!(await accountExists(connection, recipientAta))) {
    instructions.push(
      createAssociatedTokenAccountInstruction(
        relayer.publicKey,
        recipientAta,
        recipientOwner,
        mint,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
    );
  }

  instructions.push(
    buildReleaseInstruction({
      programId,
      accounts: {
        relayer: relayer.publicKey,
        config,
        naveMint: mint,
        custody,
        custodyAuthority,
        recipientNaveAccount: recipientAta,
        protocolFeeAccount: new PublicKey(cfg.protocolFeeAccount),
        stakingPoolAccount: new PublicKey(cfg.stakingPoolAccount),
        processedRelease,
      },
      sourceChainId: BigInt(sourceChainId),
      sourceMessageId: messageId,
      netAmount: netRaw,
      recipient: recipientOwner,
    }),
  );

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const message = new TransactionMessage({
    payerKey: relayer.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  tx.sign([relayer]);

  const signature = await connection.sendTransaction(tx, { skipPreflight: false, maxRetries: 5 });
  await confirmSolanaTransactionRobust(connection, signature, blockhash, lastValidBlockHeight);
  return { signature };
}

async function accountExists(connection: Connection, address: PublicKey): Promise<boolean> {
  try {
    await getAccount(connection, address);
    return true;
  } catch {
    return false;
  }
}

// ─── Orchestration ─────────────────────────────────────────────────────────────

export interface BridgeRelayBody {
  direction?: string;
  /**
   * CANONICAL route input: the numeric EVM chain id of the non-Solana side.
   * `destChainId` for solana_to_evm, `sourceChainId` for evm_to_solana;
   * `chainId` is accepted as a direction-agnostic alias. Validated against the
   * relayer's configured chain set (BRIDGE_EVM_CHAIN_IDS / NAVE_EVM_NETWORK).
   */
  chainId?: string | number;
  destChainId?: string | number;
  sourceChainId?: string | number;
  /**
   * LEGACY route input (deprecated, removed next release): 'solana' on one
   * side and a chain family name ('base' | 'ethereum' | 'robinhood') or
   * numeric id on the other. Family names are resolved ONLY via
   * NAVE_EVM_NETWORK and log a deprecation warning.
   */
  sourceChain?: string | number;
  destChain?: string | number;
  sourceTx?: string;
  recipient?: string;
  amountRaw?: string | number;
  /**
   * When true, a caller (the Bridge page's "Retry relay" button) explicitly asks
   * to re-execute a transfer whose row already exists in a non-completed state
   * (e.g. a prior attempt whose destination broadcast failed on a transient RPC
   * error). This maps to `handleBridgeRelay(body, { allowRetry: true })`, which
   * re-verifies the source tx on-chain and re-drives the destination, bounded by
   * `retry_count < DEFAULT_MAX_BRIDGE_RETRIES`. The recipient is still taken from
   * the on-chain event, never from this body, so retry is as safe as the first
   * attempt. The HTTP layer additionally rate-limits this path.
   */
  retry?: boolean;
}

// DESIGN DECISION — permissionless relay, no `senderSignature` (audit MEDIUM):
// An earlier iteration required the source-chain sender to sign a
// (sourceTx, recipient) message so a third party could not redirect a relay.
// That became dead code once the recipient was embedded IN the source
// transaction itself (nave_bridge `lock.evm_recipient` / WrappedNave
// `bridgeBurnTo.solanaRecipient`): the relayer now takes the recipient from
// the on-chain event and ignores the body, so there is nothing an observer can
// redirect — replaying a victim's public sourceTx can only complete the
// victim's own transfer to the victim's own embedded recipient. Relay is
// therefore intentionally PERMISSIONLESS for already-finalized locks/burns.
// This is also a hard requirement of the recovery path: the independent
// bridge watcher (bridgeWatcher.ts) re-drives lost/failed transfers and
// enqueues missed on-chain events with NO user present to sign anything.
// Enforcing a sender signature would break that recovery and the frontend's
// automatic relay after confirmation (src/hooks/useBridge.tsx never signs a
// relay message). The former `bridgeRelayMessage` / `verify*SenderSignature`
// helpers and the `senderSignature` body field have been deleted; an
// unexpected `senderSignature` in the body is simply ignored.

export interface BridgeRelayResult {
  id: string;
  status: string;
  direction: BridgeDirection;
  source_chain: string;
  dest_chain: string;
  /** Numeric EVM chain id of the non-Solana side of the route. */
  evm_chain_id: number | null;
  source_tx: string;
  dest_tx: string | null;
  sender: string | null;
  recipient: string;
  amount_raw: string;
  fee_raw: string | null;
  net_raw: string | null;
  /** True when this source_tx was already processed (idempotent replay). */
  duplicate?: boolean;
}

function normalizeDirection(raw: string | undefined): BridgeDirection {
  const s = (raw || '').trim().toLowerCase();
  if (s === 'solana_to_evm' || s === 'sol_to_evm' || s === 'lock') return 'solana_to_evm';
  if (s === 'evm_to_solana' || s === 'evm_to_sol' || s === 'burn') return 'evm_to_solana';
  throw new Error("direction must be 'solana_to_evm' (lock) or 'evm_to_solana' (burn)");
}

function rowToResult(row: Record<string, unknown>, evmChainId: number | null, duplicate = false): BridgeRelayResult {
  return {
    id: String(row.id),
    status: String(row.status),
    direction: String(row.direction) as BridgeDirection,
    source_chain: String(row.source_chain),
    dest_chain: String(row.dest_chain),
    evm_chain_id: evmChainId,
    source_tx: String(row.source_tx),
    dest_tx: row.dest_tx == null ? null : String(row.dest_tx),
    sender: row.sender == null ? null : String(row.sender),
    recipient: String(row.recipient),
    amount_raw: String(row.amount_raw),
    fee_raw: row.fee_raw == null ? null : String(row.fee_raw),
    net_raw: row.net_raw == null ? null : String(row.net_raw),
    duplicate,
  };
}

/** Sanitize an error message for the HTTP response (no secrets / stack). */
function sanitizeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/0x[0-9a-fA-F]{64}/g, '0x…').slice(0, 300);
}

/**
 * Orchestrate a bridge relay end-to-end:
 *   1. validate the body + resolve the route;
 *   2. INDEPENDENTLY verify the source tx on-chain (lock event / burn event)
 *      BEFORE touching the DB;
 *   3. insert a 'pending' row keyed by unique source_tx (idempotent — a
 *      conflict returns the existing row, preventing a double mint/release);
 *   4. execute the destination (lockbox mint / program release);
 *   5. mark the row 'completed' with the dest tx + fee/net amounts.
 * On failure after the row exists, the row is marked 'failed' and a
 * sanitized error is rethrown; failures before the row exists (bad/missing
 * verification) never touch the DB at all.
 *
 * RECIPIENT AUTHENTICATION is now intrinsic: the destination address is
 * embedded IN the user's single signed source transaction (the nave_bridge
 * `lock` instruction's `evm_recipient`, or WrappedNave `bridgeBurn`'s
 * `solanaRecipient`), so the relayer takes the recipient FROM the on-chain
 * event, never from an unauthenticated HTTP field. A third party who replays a
 * victim's public sourceTx can therefore only ever complete the victim's OWN
 * transfer to the victim's OWN embedded recipient — there is nothing to steal,
 * which is why no separate off-chain `senderSignature` is required anymore.
 * On-chain replay guards (lockbox `processed[srcChainId,srcNonce]` /
 * nave_bridge `ProcessedRelease`) are the primary double-spend protection; the
 * unique(source_tx) DB row is a secondary idempotency layer.
 */
/** Default cap on automatic re-executions of a single stuck transfer. */
export const DEFAULT_MAX_BRIDGE_RETRIES = 5;

/**
 * Options for {handleBridgeRelay}. When `allowRetry` is unset (the default for a
 * plain user re-POST), a `failed`/`pending` row stays idempotent and returns
 * `duplicate: true` — it is never re-executed. `allowRetry` is opted into by the
 * trusted, leased, backoff-bounded bridge watcher (bridgeWatcher.ts) AND by the
 * public `/bridge-relay` path when the caller explicitly passes `retry: true`
 * (the Bridge page's "Retry relay" button). Public retries are safe because
 * re-execution (a) re-verifies the live source tx, (b) always takes the
 * recipient from the on-chain event, (c) is bounded by
 * `retry_count < DEFAULT_MAX_BRIDGE_RETRIES`, (d) is IP-rate-limited at a tighter
 * ceiling, and (e) cannot double-spend because the on-chain replay guards make
 * any duplicate destination leg revert. It only ever re-drives the victim's own
 * transfer to the victim's own embedded recipient.
 */
export interface HandleBridgeRelayOptions {
  allowRetry?: boolean;
  maxRetries?: number;
}

export async function handleBridgeRelay(
  body: BridgeRelayBody,
  opts: HandleBridgeRelayOptions = {},
): Promise<BridgeRelayResult> {
  const cfg = readBridgeConfig();
  // Defense-in-depth (audit Info-1): the HTTP 503 gate in index.ts is the
  // primary kill switch, but any caller of this handler (e.g. the watcher) must
  // also respect it so the flag can never be bypassed by a second entry point.
  if (!cfg.enabled) throw new Error('bridge relayer is disabled (BRIDGE_RELAYER_ENABLED)');
  if (refusesClosedMainnetBridge(cfg.bridgeProgramId, cfg.solanaRpcUrl)) {
    throw new Error('bridge relayer refuses the closed mainnet nave_bridge program');
  }
  const direction = normalizeDirection(body.direction);
  const sourceTx = (body.sourceTx || '').trim();
  if (!sourceTx) throw new Error('sourceTx is required');

  // ── Step 1: resolve + validate the route up-front (fail before any DB write).
  // Canonical input is the numeric EVM chain id (destChainId / sourceChainId /
  // chainId). Legacy sourceChain/destChain names are still accepted for one
  // release (family names resolve via NAVE_EVM_NETWORK only, with a
  // deprecation warning). The recipient is taken from the on-chain event
  // below, NOT from the body.
  const present = (v: unknown): v is string | number => v !== undefined && v !== null && v !== '';
  const evmSideName = direction === 'solana_to_evm' ? body.destChain : body.sourceChain;
  const solanaSideName = direction === 'solana_to_evm' ? body.sourceChain : body.destChain;
  const numericInput =
    direction === 'solana_to_evm'
      ? (present(body.destChainId) ? body.destChainId : body.chainId)
      : (present(body.sourceChainId) ? body.sourceChainId : body.chainId);

  let evmChainId: number;
  if (present(numericInput)) {
    if (!/^\d+$/.test(String(numericInput).trim())) {
      throw new Error(`${direction === 'solana_to_evm' ? 'destChainId' : 'sourceChainId'} must be a numeric EVM chain id`);
    }
    evmChainId = resolveEvmChainId(Number(String(numericInput).trim()));
    // A legacy name supplied alongside the id must not contradict it.
    if (present(evmSideName) && !isSolanaChain(evmSideName)) {
      let named: number | null = null;
      try {
        named = resolveEvmChainId(evmSideName, { network: evmChainNetwork(evmChainId) });
      } catch {
        named = null;
      }
      if (named !== null && named !== evmChainId) {
        throw new Error(`${direction === 'solana_to_evm' ? 'destChain' : 'sourceChain'} does not match the supplied chain id ${evmChainId}`);
      }
    }
  } else {
    if (!present(body.sourceChain)) {
      throw new Error(direction === 'solana_to_evm' ? 'sourceChain is required' : 'sourceChainId (or legacy sourceChain) is required');
    }
    if (!present(body.destChain)) {
      throw new Error(direction === 'solana_to_evm' ? 'destChainId (or legacy destChain) is required' : 'destChain is required');
    }
    evmChainId = resolveEvmChainId(evmSideName as string | number);
  }
  if (present(solanaSideName) && !isSolanaChain(solanaSideName)) {
    throw new Error(
      direction === 'solana_to_evm' ? "solana_to_evm requires sourceChain 'solana'" : "evm_to_solana requires destChain 'solana'",
    );
  }

  if (direction === 'solana_to_evm') {
    if (!cfg.bridgeProgramId) throw new Error('BRIDGE_SOLANA_BRIDGE_PROGRAM is not configured');
    if (!cfg.evmLockbox[evmChainId] && !cfg.evmLockboxV1[evmChainId]) {
      throw new Error(`NaveBridge lockbox not configured for chain ${evmChainId}`);
    }
  } else {
    if (!EVM_TX_HASH_RE.test(sourceTx)) throw new Error('sourceTx must be a 32-byte EVM tx hash for evm_to_solana');
    if (!cfg.wrappedNave[evmChainId]) throw new Error(`WrappedNave address not configured for chain ${evmChainId}`);
  }

  // Row labels: keep whatever legacy name the caller sent (the Bridge page
  // filters history by these strings), else the canonical family name.
  const evmFamily = BRIDGE_EVM_CHAINS[evmChainId].family;
  const evmSideStr = present(evmSideName) && !isSolanaChain(evmSideName) ? String(evmSideName).toLowerCase() : evmFamily;
  const sourceChainStr = direction === 'solana_to_evm' ? 'solana' : evmSideStr;
  const destChainStr = direction === 'solana_to_evm' ? evmSideStr : 'solana';

  // The generated Supabase types don't include bridge_transfers (added by
  // migration 1782000000); cast to a loose surface for these reads/writes.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase = getBridgeSupabase() as any;
  const nowIso = new Date().toISOString();

  // ── Step 2: independent on-chain source verification (no DB writes yet) ────
  // Both branches read only the source chain and derive the authoritative
  // recipient + amounts from the on-chain event.
  let recipient: string; // destination recipient, from the on-chain event
  let sender: string; // source-chain sender, from the on-chain event
  let grossRaw: bigint; // gross (net + fee) moved on the source side
  let netRaw: bigint; // net delivered on the destination side
  let feeRaw: bigint; // fee resolved on Solana
  // solana_to_evm: the lockbox replay key is (solanaSrcChainId, lock nonce).
  let lockNonce = 0n;
  // Fee legs for telemetry (authoritative values come from the on-chain event
  // for lock; the burn direction's legs are resolved on-chain by `release` and
  // recorded there, so they stay null here).
  let stakingRaw: bigint | null = null;
  let protocolRaw: bigint | null = null;
  let burnRaw: bigint | null = null;

  if (direction === 'solana_to_evm') {
    const connection = getBridgeConnection(cfg);
    const ev = await verifySolanaLock(connection, sourceTx, cfg.bridgeProgramId);
    // Cross-check the destination chain matches what the user embedded on-chain.
    if (ev.destChainId !== BigInt(evmChainId)) {
      throw new Error('destChain does not match the destination embedded in the lock transaction');
    }
    recipient = ev.evmRecipient;
    sender = ev.sender;
    grossRaw = ev.grossAmount;
    netRaw = ev.netAmount;
    feeRaw = ev.feeAmount;
    lockNonce = ev.nonce;
    stakingRaw = ev.stakingAmount;
    protocolRaw = ev.protocolAmount;
    burnRaw = ev.burnAmount;
    if (!EVM_ADDRESS_RE.test(recipient)) throw new Error('lock event carried an invalid EVM recipient');
  } else {
    const chainCfg = BRIDGE_EVM_CHAINS[evmChainId];
    const publicClient = createPublicClient({
      chain: chainCfg.chain,
      transport: http(evmRpcUrl(evmChainId)),
    }) as PublicClient;
    const ev = await verifyEvmBurn(
      publicClient,
      sourceTx as Hash,
      cfg.wrappedNave[evmChainId],
      evmConfirmationsForChain(evmChainId),
    );
    recipient = ev.solanaRecipient;
    sender = ev.sender;
    grossRaw = ev.grossRaw;
    const split = netFromGross(ev.grossRaw, cfg.feeBps);
    netRaw = split.netRaw;
    feeRaw = split.feeRaw;
    try {
      // eslint-disable-next-line no-new
      new PublicKey(recipient);
    } catch {
      throw new Error('burn event carried an invalid Solana recipient');
    }
  }

  if (netRaw <= 0n) throw new Error('net amount after fee is zero');

  // ── Step 3: idempotent 'pending' insert keyed by unique(source_tx) ──────────
  const insertRow = {
    direction,
    source_chain: sourceChainStr,
    dest_chain: destChainStr,
    source_tx: sourceTx,
    recipient,
    amount_raw: grossRaw.toString(),
    staking_raw: stakingRaw?.toString() ?? null,
    protocol_raw: protocolRaw?.toString() ?? null,
    burn_raw: burnRaw?.toString() ?? null,
    source_nonce: direction === 'solana_to_evm' ? lockNonce.toString() : null,
    source_message_id: direction === 'evm_to_solana' ? sourceTx : null,
    // Family names ('ethereum'/'base') collide across networks — tag the row
    // with the EVM chain's network so the Bridge page can filter mainnet vs
    // testnet history/stats (and the watcher can re-resolve legacy names).
    network: evmChainNetwork(evmChainId),
    status: 'pending',
    retry_count: 0,
    updated_at: nowIso,
  };
  const { data: inserted, error: insertErr } = await supabase
    .from('bridge_transfers')
    .insert(insertRow)
    .select()
    .single();

  let retryRow: Record<string, unknown> | null = null;
  if (insertErr) {
    // Unique violation on source_tx → already processed (or concurrently
    // in-flight). By default this is idempotent: return the existing row so a
    // user re-POST never double-executes. The watcher opts into re-executing a
    // non-completed row (bounded by maxRetries) to recover a lost/failed relay.
    if ((insertErr as { code?: string }).code === '23505') {
      const { data: existing } = await supabase
        .from('bridge_transfers')
        .select('*')
        .eq('source_tx', sourceTx)
        .single();
      if (existing) {
        const existingRow = existing as Record<string, unknown>;
        const maxRetries = opts.maxRetries ?? DEFAULT_MAX_BRIDGE_RETRIES;
        const canRetry =
          opts.allowRetry === true &&
          String(existingRow.status) !== 'completed' &&
          Number(existingRow.retry_count ?? 0) < maxRetries;
        if (!canRetry) return rowToResult(existingRow, evmChainId, true);
        // Re-execute on the existing row: verification (above) already re-ran
        // against the live source tx, so we only need to drive the destination.
        retryRow = existingRow;
      }
    }
    if (!retryRow) throw new Error(`failed to record bridge transfer: ${sanitizeError(insertErr)}`);
  }

  const row = (inserted ?? retryRow) as Record<string, unknown>;
  const rowId = String(row.id);

  if (retryRow) {
    // Reset the adopted row to 'pending', bump the retry counter, and clear the
    // prior error before re-driving the destination.
    await supabase
      .from('bridge_transfers')
      .update({
        status: 'pending',
        error: null,
        retry_count: Number(retryRow.retry_count ?? 0) + 1,
        updated_at: new Date().toISOString(),
      })
      .eq('id', rowId);
  }

  try {
    // ── Step 4: destination execution (fee is resolved on-chain) ─────────────
    let destTx: string;
    if (direction === 'solana_to_evm') {
      const { mintTx } = await mintWrappedOnEvm(evmChainId, recipient, netRaw, cfg.solanaSrcChainId, lockNonce);
      destTx = mintTx;
    } else {
      const { signature } = await releaseNaveOnSolana(recipient, netRaw, evmChainId, sourceTx);
      destTx = signature;
    }

    // ── Step 5: mark completed ───────────────────────────────────────────────
    const { data: updated, error: updateErr } = await supabase
      .from('bridge_transfers')
      .update({
        status: 'completed',
        dest_tx: destTx,
        sender: sender || null,
        amount_raw: grossRaw.toString(),
        fee_raw: feeRaw.toString(),
        net_raw: netRaw.toString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', rowId)
      .select()
      .single();
    if (updateErr || !updated) {
      // The destination tx already executed; surface a clear (non-fatal) note.
      return rowToResult(
        { ...row, status: 'completed', dest_tx: destTx, sender, amount_raw: grossRaw.toString(), fee_raw: feeRaw.toString(), net_raw: netRaw.toString() },
        evmChainId,
      );
    }
    return rowToResult(updated as Record<string, unknown>, evmChainId);
  } catch (err) {
    const message = sanitizeError(err);
    await supabase
      .from('bridge_transfers')
      .update({ status: 'failed', error: message, updated_at: new Date().toISOString() })
      .eq('id', rowId);
    throw new Error(message);
  }
}
