import { PublicKey } from '@solana/web3.js';
import {
  EVM_CHAIN_IDS,
  evmChainIdFor,
  type EvmChainFamily,
  type EvmChainId,
  type EvmDeploymentMode,
  type EvmNetwork,
  type ChainFamily,
  chainFamilyLabelWithNetwork,
  targetForFamily,
  type ChainTarget,
} from './chain/types';
import { getSelectableSolanaStrategyIds, isMarginfiStrategyEnabled } from './strategyReadiness';
import { readViteEnv, type ViteEnvKey } from './viteEnv';

// ─── Environment configuration ───────────────────────────────────────────────
// All configuration comes from VITE_-prefixed environment variables (see
// .env.example). There are NO hardcoded credentials, endpoints, or program IDs
// in source: the app fails fast at boot with a clear error if anything required
// is missing. This keeps secrets out of the bundle/git history and forces each
// deployment (localnet/devnet/mainnet) to declare its own addresses.

// NOTE: all reads go through the STATIC table in `viteEnv.ts` — never
// `import.meta.env[key]`, which makes Vite inline every `VITE_*` var present at
// build time (including unrelated secrets that happen to carry the prefix).

/** Read a required string env var, throwing a clear error when absent. */
function requireEnvString(key: ViteEnvKey): string {
  const val = readViteEnv(key);
  if (typeof val !== 'string' || val.trim() === '') {
    throw new Error(
      `Missing required environment variable: ${key}. Configure it in .env.local (see .env.example).`,
    );
  }
  return val;
}

/** Read an optional string env var, returning undefined when unset/empty. */
function optionalEnvString(key: ViteEnvKey): string | undefined {
  const val = readViteEnv(key);
  if (typeof val !== 'string' || val.trim() === '') return undefined;
  return val.trim();
}

/** Read an optional numeric env var with a bounded, explicit fallback. */
function optionalEnvNumber(key: ViteEnvKey, fallback: number): number {
  const raw = optionalEnvString(key);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric value for ${key}: ${raw}`);
  }
  return parsed;
}

/** Read a required public-key env var. */
function requireEnvPubkey(key: ViteEnvKey): PublicKey {
  const val = requireEnvString(key);
  try {
    return new PublicKey(val);
  } catch {
    throw new Error(`Invalid public key for ${key}: ${val}`);
  }
}

// ─── Program IDs ─────────────────────────────────────────────────────────────
// See contracts/solana/Anchor.toml and the embedded `address` in each IDL.

/** nave_core program ID */
export const NAVE_CORE_PROGRAM_ID = requireEnvPubkey('VITE_NAVE_CORE_PROGRAM_ID');

/** nave_governance program ID */
export const NAVE_GOVERNANCE_PROGRAM_ID = requireEnvPubkey('VITE_NAVE_GOVERNANCE_PROGRAM_ID');

/** nave_execution program ID */
export const NAVE_EXECUTION_PROGRAM_ID = requireEnvPubkey('VITE_NAVE_EXECUTION_PROGRAM_ID');

// ─── Adapter program IDs ─────────────────────────────────────────────────────

export const NAVE_JITO_ADAPTER_ID = requireEnvPubkey('VITE_NAVE_JITO_ADAPTER_ID');
export const NAVE_KAMINO_ADAPTER_ID = requireEnvPubkey('VITE_NAVE_KAMINO_ADAPTER_ID');
export const NAVE_MARGINFI_ADAPTER_ID = requireEnvPubkey('VITE_NAVE_MARGINFI_ADAPTER_ID');

// ─── Jupiter Lend (Earn) program IDs ────────────────────────────────────────
// The lending program ID differs between devnet and mainnet (feature-gated on-chain).
// The liquidity program is forwarded as a runtime account (not pinned on-chain).
// Devnet defaults are set here; production overrides these via .env:
//   VITE_JUPITER_LENDING_PROGRAM_ID   mainnet: jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9
//   VITE_JUPITER_LIQUIDITY_PROGRAM_ID mainnet: jupeiUmn818Jg1ekPURTpr4mFo29p46vygyykFJ3wZC

export const JUPITER_LENDING_PROGRAM_ID: string =
  import.meta.env.VITE_JUPITER_LENDING_PROGRAM_ID
  ?? '7tjE28izRUjzmxC1QNXnNwcc4N82CNYCexf3k8mw67s3';

export const JUPITER_LIQUIDITY_PROGRAM_ID: string =
  import.meta.env.VITE_JUPITER_LIQUIDITY_PROGRAM_ID
  ?? '5uDkCoM96pwGYhAUucvCzLfm5UcjVRuxz6gH81RnRBmL';

/**
 * MarginFi v2 lending program ID — the target of `configure_marginfi_position`
 * / `marginfi_deposit` / `marginfi_withdraw`. Differs devnet vs mainnet
 * (mirrors `nave_core::constants::marginfi_program`, built with `--features
 * mainnet` for the real deployment). Devnet default matches the pinned devnet
 * id in that module; production overrides via .env:
 *   VITE_MARGINFI_PROGRAM_ID mainnet: MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA
 */
export const MARGINFI_PROGRAM_ID = new PublicKey(
  import.meta.env.VITE_MARGINFI_PROGRAM_ID ?? 'A7vUDErNPCTt9qrB6SSM4F6GkxzUe9d8P3cXSmRg4eY4',
);

/**
 * Jupiter v6 aggregator program ID — the target of the nave_core `jupiter_swap`
 * operational-agent instruction. MAINNET-ONLY: Jupiter v6 is deployed on mainnet
 * (there is no devnet aggregator), so the swap builder/instruction only works
 * against a mainnet RPC. The same address is pinned in the nave_core IDL.
 */
export const NAVE_JUPITER_SWAP_PROGRAM_ID = new PublicKey(
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
);

// ─── RPC endpoint ────────────────────────────────────────────────────────────

export const SOLANA_RPC_URL: string = requireEnvString('VITE_SOLANA_RPC_URL');

/** Network label derived from the RPC URL (mainnet/devnet/localnet). */
export const SOLANA_NETWORK: 'mainnet' | 'devnet' | 'localnet' = (() => {
  const u = SOLANA_RPC_URL.toLowerCase();
  if (u.includes('mainnet')) return 'mainnet';
  if (u.includes('127.0.0.1') || u.includes('localhost')) return 'localnet';
  return 'devnet';
})();

// ─── NAVE token / stake foundation ───────────────────────────────────────────

export const SOLANA_NAVE_MAINNET_MINT = new PublicKey(
  optionalEnvString('VITE_SOLANA_NAVE_MAINNET_MINT')
  ?? 'EGg56E1YtL5YapzkF7vkRThHR8i5FeRvm2LLuySdYory',
);

export const SOLANA_NAVE_DEVNET_MINT = new PublicKey(
  optionalEnvString('VITE_SOLANA_NAVE_DEVNET_MINT')
  ?? 'GmBMZuXsXpe7TZK27PTcXUyNGcuw9Ew8v3fxys7wM9Wa',
);

/** Active Solana NAVE mint for the configured RPC environment. */
export const SOLANA_NAVE_MINT = new PublicKey(
  optionalEnvString('VITE_SOLANA_NAVE_MINT')
  ?? (SOLANA_NETWORK === 'mainnet'
    ? SOLANA_NAVE_MAINNET_MINT.toBase58()
    : SOLANA_NAVE_DEVNET_MINT.toBase58()),
);

/** Devnet/testnet fixed NAVE price until the central cross-chain oracle ships. */
export const NAVE_DEVNET_PRICE_USD = optionalEnvNumber('VITE_NAVE_DEVNET_PRICE_USD', 10);
if (NAVE_DEVNET_PRICE_USD <= 0) {
  throw new Error(`VITE_NAVE_DEVNET_PRICE_USD must be greater than zero; got ${NAVE_DEVNET_PRICE_USD}.`);
}

/** Creation stake target in USD value. Operators can change on-chain via Safe
 *  `setNaveStakeConfig`; keep this env in sync for Solana quotes / UI labels. */
export const NAVE_DAO_CREATION_STAKE_USD = optionalEnvNumber('VITE_NAVE_DAO_CREATION_STAKE_USD', 19);
if (NAVE_DAO_CREATION_STAKE_USD <= 0) {
  throw new Error(
    `VITE_NAVE_DAO_CREATION_STAKE_USD must be greater than zero; got ${NAVE_DAO_CREATION_STAKE_USD}.`,
  );
}
export const NAVE_DEVNET_DAO_CREATION_STAKE_AMOUNT =
  NAVE_DAO_CREATION_STAKE_USD / NAVE_DEVNET_PRICE_USD;

/** Mainnet pricing intentionally comes from the later central oracle phase. */
export const NAVE_MAINNET_PRICE_MODE = 'central-oracle-average' as const;

/**
 * Nave bridge fee target: 2.5% (250 bps), charged ON TOP of the bridged amount.
 * A user bridging `A` NAVE parts with `A + A*bps/10000`. The fee is split (and
 * resolved on-chain by the nave_bridge program) into three legs below. Wormhole
 * Executor FeeArgs uses tenths of bps (`dbps`).
 */
export const NAVE_BRIDGE_FEE_BPS = optionalEnvNumber('VITE_NAVE_BRIDGE_FEE_BPS', 250);
if (NAVE_BRIDGE_FEE_BPS < 0 || NAVE_BRIDGE_FEE_BPS > 10_000) {
  throw new Error(`VITE_NAVE_BRIDGE_FEE_BPS must be between 0 and 10000; got ${NAVE_BRIDGE_FEE_BPS}.`);
}
export const NAVE_BRIDGE_FEE_DBPS = optionalEnvNumber(
  'VITE_NAVE_BRIDGE_FEE_DBPS',
  NAVE_BRIDGE_FEE_BPS * 10,
);
if (NAVE_BRIDGE_FEE_DBPS !== NAVE_BRIDGE_FEE_BPS * 10) {
  throw new Error(
    `VITE_NAVE_BRIDGE_FEE_DBPS must equal VITE_NAVE_BRIDGE_FEE_BPS * 10; ` +
      `got ${NAVE_BRIDGE_FEE_DBPS} dbps for ${NAVE_BRIDGE_FEE_BPS} bps.`,
  );
}

/** Staking-pool share of the bridged amount (default 1% = 100 bps). */
export const NAVE_BRIDGE_STAKING_BPS = optionalEnvNumber('VITE_NAVE_BRIDGE_STAKING_BPS', 100);
/** Protocol-revenue share of the bridged amount (default 1% = 100 bps). */
export const NAVE_BRIDGE_PROTOCOL_BPS = optionalEnvNumber('VITE_NAVE_BRIDGE_PROTOCOL_BPS', 100);
/** Auto-burn share of the bridged amount (default 0.5% = 50 bps). */
export const NAVE_BRIDGE_BURN_BPS = optionalEnvNumber('VITE_NAVE_BRIDGE_BURN_BPS', 50);
// The three legs MUST sum to the total fee bps — this mirrors the on-chain
// `validate_fee_config` invariant so the UI quote can never drift from what the
// program actually charges/splits.
if (NAVE_BRIDGE_STAKING_BPS + NAVE_BRIDGE_PROTOCOL_BPS + NAVE_BRIDGE_BURN_BPS !== NAVE_BRIDGE_FEE_BPS) {
  throw new Error(
    `Bridge fee split must sum to the total fee: staking(${NAVE_BRIDGE_STAKING_BPS}) + ` +
      `protocol(${NAVE_BRIDGE_PROTOCOL_BPS}) + burn(${NAVE_BRIDGE_BURN_BPS}) != ${NAVE_BRIDGE_FEE_BPS} bps.`,
  );
}

/**
 * On-chain `BridgeConfig.per_tx_cap` / EVM `perTxCap` (net amount, 6 decimals).
 * Mainnet init used 1_000_000_000 (= 1,000 NAVE). Keep the UI preflight aligned
 * so users see a clear message instead of Anchor Custom:6006.
 */
export const NAVE_BRIDGE_PER_TX_CAP_RAW = BigInt(
  optionalEnvNumber('VITE_NAVE_BRIDGE_PER_TX_CAP_RAW', 1_000_000_000),
);

/**
 * Mainnet protocol-revenue wallet (owner of the protocol-fee NAVE account the
 * bridge routes the 1% protocol leg to). Defaults to the launch wallet; override
 * via env. Display/telemetry only — the on-chain program enforces the actual
 * destination configured on `BridgeConfig`.
 */
export const NAVE_BRIDGE_PROTOCOL_WALLET: string = optionalEnvString(
  'VITE_NAVE_BRIDGE_PROTOCOL_WALLET',
) ?? '6N5JiWP2zF6VXhG6hwgYEYhxBEARAV5P6WRgfYb2zskC';

// ─── NAVE bridge (trusted-relayer MVP) ───────────────────────────────────────
// Testnet-only cross-chain bridge for the NAVE token between Solana devnet and
// the supported EVM testnets (Ethereum Sepolia 11155111, Base Sepolia 84532).
// This is a TRUSTED-RELAYER design: the browser locks/burns on the source chain
// and then notifies an off-chain Nave relayer (the signer-service) which mints/
// releases on the destination chain after independently verifying the source tx.
// The whole feature stays disabled unless both the relayer URL and the Solana
// custody account are configured, so a deployment without them simply hides the
// Bridge UI rather than offering a non-functional path.

/** Base URL of the Nave bridge relayer (signer-service). Bridge is disabled when unset. */
export const NAVE_BRIDGE_RELAYER_URL: string | undefined = optionalEnvString(
  'VITE_NAVE_BRIDGE_RELAYER_URL',
);

/**
 * Solana SPL token account that custodies locked NAVE. Users transfer NAVE here
 * (a plain SPL transfer) to lock it before the relayer mints WrappedNave on EVM.
 * May be any base58 token-account pubkey; validated lazily where it is consumed.
 */
export const NAVE_BRIDGE_SOLANA_CUSTODY: string | undefined = optionalEnvString(
  'VITE_NAVE_BRIDGE_SOLANA_CUSTODY',
);

/** EVM fee wallet that receives the bridge fee on EVM-side mints. Display/note only. */
export const NAVE_BRIDGE_FEE_PAYEE_EVM: string | undefined = optionalEnvString(
  'VITE_NAVE_BRIDGE_REFERRER_FEE_PAYEE_EVM',
);

/** Solana fee wallet that receives the bridge fee on Solana-side releases. Display/note only. */
export const NAVE_BRIDGE_FEE_PAYEE_SOLANA: string | undefined = optionalEnvString(
  'VITE_NAVE_BRIDGE_FEE_PAYEE_SOLANA',
);

/**
 * Whether the trusted-relayer bridge is usable in this deployment. Requires both
 * the relayer endpoint and the Solana custody account; without either, the Bridge
 * page renders a clear "not configured" notice and disables the action.
 */
export const NAVE_BRIDGE_ENABLED: boolean =
  !!NAVE_BRIDGE_RELAYER_URL && !!NAVE_BRIDGE_SOLANA_CUSTODY;

/** EVM burn confirmations required before the relayer releases on Solana (matches BRIDGE_EVM_CONFIRMATIONS). */
export const NAVE_BRIDGE_EVM_CONFIRMATIONS = optionalEnvNumber(
  'VITE_NAVE_BRIDGE_EVM_CONFIRMATIONS',
  5,
);

/** NAVE token precision. The Solana SPL mint and every WrappedNave ERC-20 use 6 decimals. */
export const NAVE_DECIMALS = 6;

/**
 * Compute the 2.5%-on-top bridge fee for a `netRaw` amount (the amount the user
 * wants to bridge / receive on the far side). The user parts with
 * `grossRaw = netRaw + feeRaw`. The fee splits into three legs (staking 1%,
 * protocol 1%, burn 0.5%), matching what the nave_bridge program resolves
 * on-chain; the protocol leg absorbs integer-division dust so the legs always
 * sum to `feeRaw`. All integer bigint math.
 */
export function computeBridgeFee(netRaw: bigint): {
  grossRaw: bigint;
  feeRaw: bigint;
  netRaw: bigint;
  stakingRaw: bigint;
  protocolRaw: bigint;
  burnRaw: bigint;
} {
  if (netRaw < 0n) {
    throw new Error('computeBridgeFee: netRaw must be non-negative.');
  }
  const feeRaw = (netRaw * BigInt(NAVE_BRIDGE_FEE_BPS)) / 10_000n;
  const stakingRaw = (netRaw * BigInt(NAVE_BRIDGE_STAKING_BPS)) / 10_000n;
  const burnRaw = (netRaw * BigInt(NAVE_BRIDGE_BURN_BPS)) / 10_000n;
  const protocolRaw = feeRaw - stakingRaw - burnRaw; // remainder-safe
  const grossRaw = netRaw + feeRaw;
  return { grossRaw, feeRaw, netRaw, stakingRaw, protocolRaw, burnRaw };
}

// ─── Protocol revenue wallet ─────────────────────────────────────────────────
// On-chain fee routing:
//   • DAO formation fee (2 SOL) → global_config.treasury (this wallet)
//   • Token mint fee (0.5 SOL)  → protocol_fee_vault PDA (program-owned; sweep manually)
//   • Token revoke reward       → paid from protocol_fee_vault to the DAO vault
// DAO management/performance fees stay in each DAO's fee_recipient — not protocol revenue.

/**
 * Wallet that receives the 2 SOL DAO formation fee (`global_config.treasury`).
 * Must match the on-chain treasury at deploy time.
 */
export const NAVE_PROTOCOL_FEE_WALLET = requireEnvPubkey('VITE_NAVE_PROTOCOL_FEE_WALLET');

/** Returns true when the configured fee wallet matches the on-chain global config treasury. */
export function protocolFeeWalletMatchesOnChain(onChainTreasury: PublicKey): boolean {
  return NAVE_PROTOCOL_FEE_WALLET.equals(onChainTreasury);
}

// ─── Supabase ────────────────────────────────────────────────────────────────

export const SUPABASE_URL = requireEnvString('VITE_SUPABASE_URL');

export const SUPABASE_FUNCTIONS_URL = `${SUPABASE_URL}/functions/v1`;

// The anon key is a public client credential, but it must still be supplied per
// deployment (and rotated independently) rather than baked into source.
export const SUPABASE_ANON_KEY: string = requireEnvString('VITE_SUPABASE_ANON_KEY');

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Demo/mock mode. When VITE_USE_MOCKS === 'true', hooks render bundled mock
 * data instead of querying the chain.
 */
export const USE_MOCKS: boolean = import.meta.env.VITE_USE_MOCKS === 'true';

/**
 * Program configuration is required at boot (requireEnvPubkey throws otherwise),
 * so once the module loads successfully the programs are always configured.
 * Retained for call-site compatibility.
 */
export function isProgramConfigured(): boolean {
  return true;
}

/** Adapters are likewise required at boot. */
export function hasAdaptersConfigured(): boolean {
  return true;
}

// ─── System constants ────────────────────────────────────────────────────────

export const MAX_GUARDIANS = 10;
export const MAX_THRESHOLD = 7;
export const MAX_PROPOSALS_PER_DAO = 88;
export const MAX_TOKENS_PER_DAO = 3;
export const MAX_PROTOCOLS_PER_DAO = 10;

/**
 * True only for the production mainnet deployment. All non-mainnet networks
 * (devnet/localnet) use minimized fees that mirror the on-chain devnet build
 * (default features) of nave_core's fee constants. Keeping this aligned with the
 * on-chain feature gate ensures the UI cost display matches what the program
 * actually charges.
 */
const IS_MAINNET = SOLANA_NETWORK === 'mainnet';

/** Parse VITE_EVM_NETWORK: mainnet | testnet | mixed (Base+RH mainnet, ETH Sepolia). */
function parseEvmDeploymentMode(raw: string | undefined): EvmDeploymentMode {
  if (raw === 'mainnet' || raw === 'mixed') return raw;
  return 'testnet';
}

const CONFIGURED_EVM_DEPLOYMENT_MODE: EvmDeploymentMode = parseEvmDeploymentMode(
  optionalEnvString('VITE_EVM_NETWORK'),
);

/**
 * SOL seeded into each of the 4 agent wallets at DAO creation (from the
 * formation fee). Mainnet: 0.05 SOL. Devnet: 0.01 SOL (minimized for testing).
 */
export const AGENT_WALLET_SEED_SOL = IS_MAINNET ? 0.05 : 0.01;
/** Total SOL allocated to agent wallets during creation (4 × AGENT_WALLET_SEED_SOL). */
export const AGENT_WALLET_TOTAL_SEED_SOL = AGENT_WALLET_SEED_SOL * 4; // mainnet 0.2 SOL / devnet 0.04 SOL
/**
 * Protocol profit (SOL) taken at DAO creation. DAO formation is now FEE-FREE on
 * every network: there is no SOL/native protocol fee — creation instead requires
 * a recoverable NAVE stake sized by `NAVE_DAO_CREATION_STAKE_USD` (and the
 * stake oracle). Kept as a named export (zero) so existing fee-display references
 * compile; do NOT reintroduce a SOL formation fee here.
 */
export const PROTOCOL_PROFIT_SOL = 0;
/**
 * TREASURY-SEED portion of the old fee carve-out model. Now 0 on all networks:
 * the user's seed is a separate input (deposited into their own treasury vault,
 * not charged as a fee). Kept as a named export (zero) so existing references
 * compile without changes. Do NOT include in fee totals or fee display.
 */
export const TREASURY_SEED_SOL = 0;
/**
 * Total non-recoverable native (SOL) cost at DAO creation. Formation is fee-free,
 * so this is just agent-wallet seeding (PROTOCOL_PROFIT_SOL is 0). The recoverable
 * NAVE creation stake and the user's treasury seed are NOT included here.
 * Mainnet: 0.2 SOL. Devnet: 0.04 SOL.
 */
export const DAO_FORMATION_FEE_SOL = PROTOCOL_PROFIT_SOL + AGENT_WALLET_TOTAL_SEED_SOL;
/**
 * Default treasury value floor, in whole US dollars, that the treasury NAV must
 * reach before agents auto-deploy or swap any strategy. Enforced on-chain in
 * micro-USD (USD × 1_000_000) against the DAO's USD NAV — see the constitution's
 * `agent_threshold_usd` (default $100 = 100_000_000). Agents skip execution
 * until NAV exceeds this floor, so the initial seed stays protected until the
 * treasury is meaningfully funded.
 */
export const AGENT_THRESHOLD_DEFAULT_USD = 100;
/** Agent wallet balance threshold (SOL) below which yield replenishment begins. */
export const AGENT_WALLET_MIN_SOL = 0.25;
/** Agent wallet target balance (SOL) — replenishment tops up to this level. */
export const AGENT_WALLET_TARGET_SOL = 0.5;
/**
 * Cost (SOL) to mint a new DAO token, charged from the treasury (mirrors
 * on-chain TOKEN_MINT_FEE_LAMPORTS). Mainnet: 0.5 SOL. Devnet: 0.01 SOL.
 */
export const TOKEN_MINT_FEE_SOL = IS_MAINNET ? 0.5 : 0.01;
/**
 * Cost (ETH) to mint a new DAO token on EVM chains. Mainnet: 0.05 ETH.
 * Testnets currently keep this at 0 so Sepolia/Base Sepolia beta flows remain
 * gas-only while the same UI can display the network-specific fee model.
 */
export const TOKEN_MINT_FEE_ETH =
  CONFIGURED_EVM_DEPLOYMENT_MODE === 'mainnet' || CONFIGURED_EVM_DEPLOYMENT_MODE === 'mixed'
    ? 0.05
    : 0;
/**
 * Reward (SOL) returned to the treasury when it revokes all token authorities
 * (mirrors on-chain TOKEN_REVOKE_REWARD_LAMPORTS). Mainnet: 0.2 SOL. Devnet:
 * 0.001 SOL.
 */
export const TOKEN_REVOKE_REWARD_SOL = IS_MAINNET ? 0.2 : 0.001;
/**
 * Reward (ETH) returned to the treasury after all EVM token permissions are
 * revoked. The current Solidity contracts do not implement an EVM revoke reward,
 * so this remains 0 on every EVM network until a contract-backed value exists.
 */
export const TOKEN_REVOKE_REWARD_ETH = 0;
/**
 * Canonical title for an "enable autonomous agents" governance proposal.
 * Resuming the agents is gated behind a passed DAO vote: the Agent page creates
 * a General proposal with this exact title, and the Governance page detects it
 * by this prefix to surface the founder-only "Execute: Enable Agents" action.
 */
export const AGENT_ENABLE_PROPOSAL_TITLE = 'Enable Autonomous Agents';

/** Quorum (%) required for a token-mint governance proposal. */
export const TOKEN_MINT_QUORUM_PCT = 25;
/** Quorum (%) required to switch the voting system. */
export const SWITCH_VOTING_QUORUM_PCT = 70;
export const MANAGEMENT_FEE_BPS_NORMAL = 65; // 0.65%
export const MANAGEMENT_FEE_BPS_FROZEN = 35; // 0.35%
export const FROZEN_FEE_DURATION_YEARS = 5;
export const REVIEW_WINDOW_SECONDS = 48 * 3600; // 48-hour operational review window
/**
 * Configurable agent-pipeline review-window bounds (seconds), enforced on-chain
 * by `set_review_window` (`MIN/MAX_REVIEW_WINDOW_SECONDS` in nave_core::constants)
 * and the EVM `NaveTreasury.setReviewWindow`. A DAO may set any value in
 * [60s, 7d]; the Settings control clamps to this range. Default is 24h.
 */
/**
 * Default guardian M-of-N threshold for a freshly created DAO.
 *
 * `custodiedGuardians` counts Nave-held guardian keys in the set (EVM DAOs seed
 * one). The threshold is at least the number of human guardians, so the
 * custodied guardian can only add to a quorum the humans are already close to;
 * with one human it is 2-of-2. Without custodied guardians the threshold is
 * `max(2, ceil(n/2))`, capped at `n` (a single-guardian DAO keeps threshold 1).
 */
export function defaultGuardianThreshold(guardianCount: number, custodiedGuardians = 0): number {
  const n = Math.max(1, Math.floor(guardianCount));
  if (n <= 1) return 1;
  const custodied = Math.min(Math.max(0, Math.floor(custodiedGuardians)), n - 1);
  if (custodied > 0) {
    return Math.min(n, Math.max(2, n - custodied));
  }
  return Math.min(n, Math.max(2, Math.ceil(n / 2)));
}

/**
 * System-wide AI decision confidence (0–100). Written on-chain with every
 * constitution; not a founder-facing control — Nave sets this so agents only
 * act at a production-grade bar.
 */
export const SYSTEM_CONFIDENCE_THRESHOLD = 70;

export const MIN_REVIEW_WINDOW_SECONDS = 60; // 1 minute (Solana nave_core)
/**
 * EVM `NaveTreasury.setReviewWindow` floor (1h). Reductions below the current
 * value are additionally DELAYED — they land after the current window elapses;
 * `pendingReviewWindow()` exposes the queued value/effective time.
 */
export const MIN_REVIEW_WINDOW_SECONDS_EVM = 3600; // 1 hour
export const MAX_REVIEW_WINDOW_SECONDS = 7 * 24 * 3600; // 7 days
export const DEFAULT_REVIEW_WINDOW_SECONDS = 24 * 3600; // 24 hours

/**
 * EVM treasury-seed carve-out from the formation fee. Set to 0: users supply
 * their own treasury seed as a separate wizard input (mirrors TREASURY_SEED_SOL).
 * Live mainnet amounts may still be read from `NaveProtocol.treasurySeed()` where
 * needed; this constant is for UI fee totals only.
 */
export const TREASURY_SEED_ETH = 0;

/**
 * OPTIONAL posted Pyth SOL/USD PriceUpdateV2 account used to revalue the wSOL
 * treasury seed during the unified creation flow. When unset, the in-wizard
 * revalue step is skipped and the off-chain snapshot/revalue pipeline computes
 * NAV before the first agent execution (the wizard never blocks on it).
 */
export const SOL_USD_PRICE_UPDATE: string | undefined = optionalEnvString(
  'VITE_SOL_USD_PRICE_UPDATE',
);

/**
 * Whether the redeployed nave_execution + nave_core programs that support the
 * one-time founder BOOTSTRAP path are live on the configured network.
 *
 * The bootstrap feature changed the on-chain `create_execution_request`
 * instruction (added a `bootstrap` arg + the `nave_core_program` /
 * `execution_program` accounts for the `record_bootstrap_usage` CPI). That new
 * shape is INCOMPATIBLE with the previously-deployed programs, so until the
 * programs are redeployed the client MUST emit the legacy instruction shape.
 *
 * Default `false` (current devnet runs the pre-bootstrap programs). After
 * redeploying nave_execution + nave_core with the bootstrap instructions, set
 * `VITE_NAVE_BOOTSTRAP_DEPLOYED=true` to enable:
 *   • the new `create_execution_request(amount, protocol_program, mint, bootstrap)`
 *     account/arg shape, and
 *   • the unified-creation wizard's one-time auto-activation bootstrap step.
 *
 * When `false`, normal (non-bootstrap) strategy execution requests are built
 * with the legacy shape so they keep working against the deployed program, and
 * the wizard's bootstrap step is skipped cleanly (the treasury is still created,
 * seeded, ratified, and agent-enabled — only the immediate first-deploy is
 * deferred to a normal governance vote).
 */
export const BOOTSTRAP_PROGRAMS_DEPLOYED: boolean =
  optionalEnvString('VITE_NAVE_BOOTSTRAP_DEPLOYED')?.toLowerCase() === 'true';

/**
 * Solana/EVM strategy support, availability, badges, and mainnet-readiness are
 * now centralized in `src/lib/strategyReadiness.ts` (backed by the
 * runtime-agnostic `strategyReadinessData.mjs`, also consumed directly by
 * `scripts/mainnet-cutover.mjs`). `MARGINFI_STRATEGY_ENABLED` and
 * `SELECTABLE_SOLANA_PROTOCOLS` are kept here as thin re-exports purely for
 * backward compatibility with existing call sites (`ProposalCard.tsx`,
 * `PolicyEngine.tsx`) — new code should import from `strategyReadiness.ts`
 * directly, which is what `ConstitutionStep.tsx` and `Assets.tsx` now do.
 */
export const MARGINFI_STRATEGY_ENABLED: boolean = isMarginfiStrategyEnabled();

/** Selectable Solana strategy protocol keys, excluding any gated-off protocols. */
export const SELECTABLE_SOLANA_PROTOCOLS: readonly string[] = getSelectableSolanaStrategyIds();

// ─── EVM configuration (Ethereum + Base + Robinhood) ─────────────────────────
// All EVM vars are OPTIONAL: a Solana-only deployment must still boot. EVM
// support activates only once the per-chain Factory + Protocol addresses are
// supplied. The keys are intentionally restricted to the six supported chain
// ids (1, 8453, 4663, 11155111, 84532, 46630) — there is no slot for any other
// EVM chain. Robinhood Chain (4663/46630, Arbitrum Nitro L2) hosts DAO stacks
// as well as bridge + staking; primary yield is via bridges to Ethereum.
/**
 * Deployment-wide EVM posture from `VITE_EVM_NETWORK`.
 * - `testnet` — Sepolia / Base Sepolia / Robinhood Testnet
 * - `mainnet` — Ethereum / Base / Robinhood mainnets
 * - `mixed` — Base + Robinhood mainnet, Ethereum Sepolia (Solana stays on its RPC)
 */
export const EVM_DEPLOYMENT_MODE: EvmDeploymentMode = CONFIGURED_EVM_DEPLOYMENT_MODE;

/** Per-family mainnet/testnet resolution for the active deployment profile. */
export const EVM_NETWORK_BY_FAMILY: Record<EvmChainFamily, EvmNetwork> =
  EVM_DEPLOYMENT_MODE === 'mainnet'
    ? { ethereum: 'mainnet', base: 'mainnet', robinhood: 'mainnet', arc: 'testnet' }
    : EVM_DEPLOYMENT_MODE === 'mixed'
      ? { ethereum: 'testnet', base: 'mainnet', robinhood: 'mainnet', arc: 'testnet' }
      : { ethereum: 'testnet', base: 'testnet', robinhood: 'testnet', arc: 'testnet' };

/**
 * Legacy uniform network flag. Prefer `EVM_NETWORK_BY_FAMILY` / `activeEvmChainId`.
 * Equal to `mainnet` only when EVERY family is on mainnet; otherwise `testnet`
 * (including the `mixed` profile).
 */
export const EVM_NETWORK: EvmNetwork =
  EVM_DEPLOYMENT_MODE === 'mainnet' ? 'mainnet' : 'testnet';

/** True when at least one active EVM family is on mainnet (mixed or full mainnet). */
export const EVM_HAS_MAINNET_CHAINS: boolean =
  Object.values(EVM_NETWORK_BY_FAMILY).some((n) => n === 'mainnet');

/** Resolve the active chain id for an EVM family under this deployment. */
export function activeEvmChainId(family: EvmChainFamily): EvmChainId {
  return evmChainIdFor(family, EVM_NETWORK_BY_FAMILY[family]);
}

/** Build the ChainTarget for a family under this deployment (incl. Solana). */
export function activeTargetForFamily(family: ChainFamily): ChainTarget {
  if (family === 'solana') return targetForFamily('solana', 'testnet');
  return targetForFamily(family, EVM_NETWORK_BY_FAMILY[family]);
}

/** Switcher / banner label for a family under this deployment. */
export function chainDisplayLabel(family: ChainFamily): string {
  return chainFamilyLabelWithNetwork(family, EVM_NETWORK_BY_FAMILY, SOLANA_NETWORK);
}

/**
 * Per-chain RPC URL overrides. Optional on testnet (falls back to the chain's
 * public RPC); REQUIRED on mainnet for every active chain that has a Factory
 * configured (see the mainnet RPC guard below — there is no public-RPC fallback
 * for mainnet). NOTE: these are VITE_-exposed (visible in the browser bundle) —
 * only ever set PUBLIC or domain-allowlisted URLs here, never a secret-keyed
 * provider URL (Alchemy/Helius keys stay server-side).
 */
export const EVM_RPC_URLS: Partial<Record<EvmChainId, string>> = {
  1: optionalEnvString('VITE_EVM_ETHEREUM_RPC_URL'),
  8453: optionalEnvString('VITE_EVM_BASE_RPC_URL'),
  4663: optionalEnvString('VITE_EVM_ROBINHOOD_RPC_URL'),
  11155111: optionalEnvString('VITE_EVM_SEPOLIA_RPC_URL'),
  84532: optionalEnvString('VITE_EVM_BASE_SEPOLIA_RPC_URL'),
  46630: optionalEnvString('VITE_EVM_ROBINHOOD_TESTNET_RPC_URL'),
  5042002: optionalEnvString('VITE_EVM_ARC_TESTNET_RPC_URL'),
};

/** Wrapped NAVE token contracts, populated after NTT mint/burn deployments. */
export const EVM_WRAPPED_NAVE_ADDRESSES: Partial<Record<EvmChainId, string>> = {
  1: optionalEnvString('VITE_EVM_ETHEREUM_WRAPPED_NAVE_ADDRESS'),
  8453: optionalEnvString('VITE_EVM_BASE_WRAPPED_NAVE_ADDRESS'),
  4663: optionalEnvString('VITE_EVM_ROBINHOOD_WRAPPED_NAVE_ADDRESS'),
  11155111: optionalEnvString('VITE_EVM_SEPOLIA_WRAPPED_NAVE_ADDRESS'),
  84532: optionalEnvString('VITE_EVM_BASE_SEPOLIA_WRAPPED_NAVE_ADDRESS'),
  46630: optionalEnvString('VITE_EVM_ROBINHOOD_TESTNET_WRAPPED_NAVE_ADDRESS'),
  5042002: optionalEnvString('VITE_EVM_ARC_TESTNET_WRAPPED_NAVE_ADDRESS'),
};

/**
 * NaveBridge lockbox addresses per EVM chain — preferred mint path (v2 UUPS
 * shared-wNAVE lockbox). Solana→EVM minting follows on-chain `wNAVE.minter()`;
 * until Safe rotates minter, the legacy lockbox in `EVM_BRIDGE_LOCKBOX_V1_ADDRESSES`
 * remains authoritative.
 */
export const EVM_BRIDGE_LOCKBOX_ADDRESSES: Partial<Record<EvmChainId, string>> = {
  1: optionalEnvString('VITE_EVM_ETHEREUM_BRIDGE_LOCKBOX_ADDRESS'),
  8453: optionalEnvString('VITE_EVM_BASE_BRIDGE_LOCKBOX_ADDRESS'),
  4663: optionalEnvString('VITE_EVM_ROBINHOOD_BRIDGE_LOCKBOX_ADDRESS'),
  11155111: optionalEnvString('VITE_EVM_SEPOLIA_BRIDGE_LOCKBOX_ADDRESS'),
  84532: optionalEnvString('VITE_EVM_BASE_SEPOLIA_BRIDGE_LOCKBOX_ADDRESS'),
  46630: optionalEnvString('VITE_EVM_ROBINHOOD_TESTNET_BRIDGE_LOCKBOX_ADDRESS'),
  5042002: optionalEnvString('VITE_EVM_ARC_TESTNET_BRIDGE_LOCKBOX_ADDRESS'),
};

/** Legacy immutable lockboxes (still live for burns/exit; mint until minter rotation). */
export const EVM_BRIDGE_LOCKBOX_V1_ADDRESSES: Partial<Record<EvmChainId, string>> = {
  8453: optionalEnvString('VITE_EVM_BASE_BRIDGE_LOCKBOX_V1_ADDRESS'),
  4663: optionalEnvString('VITE_EVM_ROBINHOOD_BRIDGE_LOCKBOX_V1_ADDRESS'),
};

/** NaveStaking mirror addresses per EVM chain (stake wNAVE, earn wNAVE rewards). */
export const EVM_STAKING_ADDRESSES: Partial<Record<EvmChainId, string>> = {
  1: optionalEnvString('VITE_EVM_ETHEREUM_STAKING_ADDRESS'),
  8453: optionalEnvString('VITE_EVM_BASE_STAKING_ADDRESS'),
  4663: optionalEnvString('VITE_EVM_ROBINHOOD_STAKING_ADDRESS'),
  11155111: optionalEnvString('VITE_EVM_SEPOLIA_STAKING_ADDRESS'),
  84532: optionalEnvString('VITE_EVM_BASE_SEPOLIA_STAKING_ADDRESS'),
  46630: optionalEnvString('VITE_EVM_ROBINHOOD_TESTNET_STAKING_ADDRESS'),
  5042002: optionalEnvString('VITE_EVM_ARC_TESTNET_STAKING_ADDRESS'),
};

/**
 * nave_bridge program id (Solana). The custody + config + replay PDAs derive
 * from it. When set, the app builds the single-signature `lock` instruction
 * against this program (recipient embedded), superseding the plain SPL transfer.
 */
export const NAVE_BRIDGE_PROGRAM_ID: PublicKey | undefined = (() => {
  const raw = optionalEnvString('VITE_NAVE_BRIDGE_PROGRAM_ID');
  if (!raw) return undefined;
  try {
    return new PublicKey(raw);
  } catch {
    throw new Error(`Invalid public key for VITE_NAVE_BRIDGE_PROGRAM_ID: ${raw}`);
  }
})();

/** Closed Solana nave_bridge deployment. Locks against this id cannot be redeemed. */
const CLOSED_SOLANA_BRIDGE_PROGRAM_ID = 'Fu3ZpX1SMvqVhuo7E4uKGvJxe6cJDFDxxmSCET6de9u6';

/**
 * True when a Solana lock can still be redeemed for wNAVE. False when the
 * bridge flag is off, the program id is unset, or it is the closed deployment.
 */
export function bridgeCanRedeemNave(): boolean {
  if (!NAVE_BRIDGE_ENABLED) return false;
  if (!NAVE_BRIDGE_PROGRAM_ID) return false;
  if (NAVE_BRIDGE_PROGRAM_ID.toBase58() === CLOSED_SOLANA_BRIDGE_PROGRAM_ID) return false;
  return true;
}

/** nave_staking program id (Solana central reward pool). */
export const NAVE_STAKING_PROGRAM_ID: PublicKey | undefined = (() => {
  const raw = optionalEnvString('VITE_NAVE_STAKING_PROGRAM_ID');
  if (!raw) return undefined;
  try {
    return new PublicKey(raw);
  } catch {
    throw new Error(`Invalid public key for VITE_NAVE_STAKING_PROGRAM_ID: ${raw}`);
  }
})();

/**
 * Protocol-revenue NAVE token account the bridge `lock` routes the 1% protocol
 * leg to (owned by `NAVE_BRIDGE_PROTOCOL_WALLET`). Required by the on-chain
 * `lock` instruction's account list.
 */
export const NAVE_BRIDGE_PROTOCOL_FEE_ACCOUNT: string | undefined = optionalEnvString(
  'VITE_NAVE_BRIDGE_PROTOCOL_FEE_ACCOUNT',
);

/**
 * Staking-pool reward-vault NAVE token account the bridge `lock` routes the 1%
 * staking leg to (the nave_staking pool's reward vault).
 */
export const NAVE_BRIDGE_STAKING_POOL_ACCOUNT: string | undefined = optionalEnvString(
  'VITE_NAVE_BRIDGE_STAKING_POOL_ACCOUNT',
);

/**
 * EVM per-DAO `protocolRevenueWallet` (the address a DAO's protocol-revenue
 * share of performance fees routes to). PRODUCT DECISION: to mirror the Solana
 * model — where protocol revenue accrues to a Nave-controlled wallet
 * (`global_config.treasury` / VITE_NAVE_PROTOCOL_FEE_WALLET), NOT the founder —
 * set this to a Nave-controlled EVM fee wallet. PRODUCT DECISION (2026-07):
 * Nave fee wallet on mainnet (required by cutover); founder fallback only when
 * unset (testnets). When unset (e.g. testnets), the
 * DAO-creation flow falls back to the founder address so creation still works.
 * Note: the current create flow sets performanceFeeBps = 0, so this wallet
 * receives nothing until performance fees are enabled; configuring it now makes
 * the routing correct the moment fees are turned on.
 */
export const EVM_PROTOCOL_REVENUE_WALLET: string | undefined = optionalEnvString(
  'VITE_EVM_PROTOCOL_REVENUE_WALLET',
);

// ── Devnet / testnet fallback addresses ───────────────────────────────────────
// Matches contracts/evm deployments/11155111.json and deployments/84532.json.
// Env vars always take precedence.
const TESTNET_PROTOCOL_FALLBACKS: Partial<Record<EvmChainId, string>> = {
  11155111: '0x8D6dFa14Ac28077E3C746C10Fb40C0C424f848D1',
  84532: '0xF37271a4A120eD904543bbE648D2f64Fa27b3bC6',
  46630: '0xcA99d4A75A41C3aff5F3Fc2c2Dfd241129B1e093',
  5042002: '0x3334fBe32eEe1F9f34C047d90762b3030B5Fe255',
};
const TESTNET_FACTORY_FALLBACKS: Partial<Record<EvmChainId, string>> = {
  11155111: '0x4F01c9616A48F14009EC083Ff4bb6e47EdDE0890',
  84532: '0xF53dE95ae1Fed92FFd9C9305E1716FD48EFcB776',
  46630: '0x303cE551De723cad43e1575C4D981C0E2b662b7F',
  5042002: '0xa7bd919a5249DD1Da6E02a6716D2Db2B2e0A99f0',
};

/** Per-chain NaveProtocol singleton addresses. Env var overrides the fallback. */
export const EVM_PROTOCOL_ADDRESSES: Partial<Record<EvmChainId, string>> = {
  1:        optionalEnvString('VITE_EVM_ETHEREUM_PROTOCOL_ADDRESS'),
  8453:     optionalEnvString('VITE_EVM_BASE_PROTOCOL_ADDRESS'),
  4663:     optionalEnvString('VITE_EVM_ROBINHOOD_PROTOCOL_ADDRESS'),
  11155111: optionalEnvString('VITE_EVM_SEPOLIA_PROTOCOL_ADDRESS')   ?? TESTNET_PROTOCOL_FALLBACKS[11155111],
  84532:    optionalEnvString('VITE_EVM_BASE_SEPOLIA_PROTOCOL_ADDRESS') ?? TESTNET_PROTOCOL_FALLBACKS[84532],
  46630:    optionalEnvString('VITE_EVM_ROBINHOOD_TESTNET_PROTOCOL_ADDRESS') ?? TESTNET_PROTOCOL_FALLBACKS[46630],
  5042002: optionalEnvString('VITE_EVM_ARC_TESTNET_PROTOCOL_ADDRESS') ?? TESTNET_PROTOCOL_FALLBACKS[5042002],
};

/** Per-chain NaveDAOFactory singleton addresses. Env var overrides the fallback. */
export const EVM_FACTORY_ADDRESSES: Partial<Record<EvmChainId, string>> = {
  1:        optionalEnvString('VITE_EVM_ETHEREUM_FACTORY_ADDRESS'),
  8453:     optionalEnvString('VITE_EVM_BASE_FACTORY_ADDRESS'),
  4663:     optionalEnvString('VITE_EVM_ROBINHOOD_FACTORY_ADDRESS'),
  11155111: optionalEnvString('VITE_EVM_SEPOLIA_FACTORY_ADDRESS')   ?? TESTNET_FACTORY_FALLBACKS[11155111],
  84532:    optionalEnvString('VITE_EVM_BASE_SEPOLIA_FACTORY_ADDRESS') ?? TESTNET_FACTORY_FALLBACKS[84532],
  46630:    optionalEnvString('VITE_EVM_ROBINHOOD_TESTNET_FACTORY_ADDRESS') ?? TESTNET_FACTORY_FALLBACKS[46630],
  5042002: optionalEnvString('VITE_EVM_ARC_TESTNET_FACTORY_ADDRESS') ?? TESTNET_FACTORY_FALLBACKS[5042002],
};

// EVM adapter type/status re-exports (see strategyReadiness.ts for the source
// of truth): kept here so existing imports (`EvmAdapterProtocolId`,
// `getEvmAdapterStatus(es)`, `getEvmAdapterAddress`, `getConfiguredEvmAdapters`,
// `isConfiguredEvmAdapterAddress`) keep working unchanged.
export type { EvmAdapterProtocolId, EvmAdapterAddressEntry } from './strategyReadiness';
export {
  getEvmAdapterStatus,
  getEvmAdapterStatuses,
  getEvmAdapterAddress,
  getConfiguredEvmAdapters,
  isConfiguredEvmAdapterAddress,
} from './strategyReadiness';

/** Active EVM chain ids for this deployment (e.g. mixed → [11155111, 8453, 4663]). */
export const ACTIVE_EVM_CHAIN_IDS: EvmChainId[] = [
  activeEvmChainId('ethereum'),
  activeEvmChainId('base'),
  activeEvmChainId('robinhood'),
  ...(EVM_DEPLOYMENT_MODE === 'testnet' ? [activeEvmChainId('arc')] : []),
];

/**
 * True when at least one active EVM chain has its Factory address configured.
 * Gates EVM-only UX (chain selectors, EVM writers) without affecting Solana.
 */
export const EVM_ENABLED: boolean = ACTIVE_EVM_CHAIN_IDS.some(
  (id) => !!EVM_FACTORY_ADDRESSES[id],
);

/** Returns true when a specific EVM chain id has its core singletons configured. */
export function isEvmChainConfigured(chainId: EvmChainId): boolean {
  return !!EVM_FACTORY_ADDRESSES[chainId] && !!EVM_PROTOCOL_ADDRESSES[chainId];
}

// Devnet WalletConnect project id — used when VITE_WALLETCONNECT_PROJECT_ID is
// not set in the deployment environment. This is the same key used locally and
// is safe to bake for testnet / devnet. Replace with a production key at
// mainnet launch via the VITE_WALLETCONNECT_PROJECT_ID env var.
const DEVNET_WALLETCONNECT_PROJECT_ID = 'aadbffc0abee5085ab04536e5f81c6d8';

/**
 * WalletConnect Cloud project id used by RainbowKit's default connectors.
 * Env var takes precedence; testnet deployments fall back to the baked devnet
 * key so the site boots without requiring every deployer to configure WC.
 * Replace for mainnet via VITE_WALLETCONNECT_PROJECT_ID.
 */
export const WALLETCONNECT_PROJECT_ID: string = (() => {
  const configured = optionalEnvString('VITE_WALLETCONNECT_PROJECT_ID');
  if (configured) return configured;
  if (EVM_ENABLED) {
    // Use the baked devnet key rather than hard-crashing; a missing key only
    // matters on mainnet where the devnet key should be replaced anyway.
    if (!EVM_HAS_MAINNET_CHAINS) return DEVNET_WALLETCONNECT_PROJECT_ID;
    throw new Error(
      'Missing required environment variable: VITE_WALLETCONNECT_PROJECT_ID. ' +
        'EVM support is enabled (an EVM Factory address is configured) but no ' +
        'WalletConnect Cloud project id was provided. Get one at ' +
        'https://cloud.walletconnect.com and set VITE_WALLETCONNECT_PROJECT_ID.',
    );
  }
  // EVM disabled for this deployment — the value is never used to open a
  // WalletConnect session (no EVM chains are reachable without a Factory).
  return 'evm-disabled';
})();

// ── Mainnet RPC requirement ──────────────────────────────────────────────────
// On mainnet there is no public-RPC fallback: every active mainnet chain that
// has a Factory configured MUST supply its own RPC URL. This prevents the app
// from silently routing mainnet reads/writes through viem's rate-limited public
// endpoints. Testnets may still use the public fallback.
// On any mainnet-family chain there is no public-RPC fallback once a Factory is
// configured. Mixed deployments require Base (and Ethereum mainnet, if ever
// enabled) RPCs; Sepolia may still use public fallback.
if (EVM_HAS_MAINNET_CHAINS) {
  for (const id of ACTIVE_EVM_CHAIN_IDS) {
    if (EVM_FACTORY_ADDRESSES[id] && !EVM_RPC_URLS[id]) {
      throw new Error(
        `Missing required EVM mainnet RPC URL for chain ${id}. Public RPC ` +
          `fallback is not allowed on mainnet — set the corresponding ` +
          `VITE_EVM_*_RPC_URL (Ethereum: VITE_EVM_ETHEREUM_RPC_URL, Base: ` +
          `VITE_EVM_BASE_RPC_URL).`,
      );
    }
  }
}

/** All EVM chain ids the app knows about (closed set; useful for validation loops). */
export const KNOWN_EVM_CHAIN_IDS: readonly EvmChainId[] = EVM_CHAIN_IDS;

// ─── Adapter lookup map ─────────────────────────────────────────────────────
// Maps human-readable protocol IDs (matching constitution.approvedProtocols[].protocolId)
// to their on-chain adapter program IDs.

export const ADAPTER_PROGRAM_IDS: Record<string, PublicKey> = {
  jito: NAVE_JITO_ADAPTER_ID,
  kamino: NAVE_KAMINO_ADAPTER_ID,
  marginfi: NAVE_MARGINFI_ADAPTER_ID,
  // No Nave adapter: requests and the constitution bind the Jupiter Lend program.
  jupiter: new PublicKey(JUPITER_LENDING_PROGRAM_ID),
};

/**
 * Protocols with no Nave adapter program. `execute_strategy` moves the funds
 * into the strategy escrow, then the Operational agent places them with
 * nave_core::jupiter_deposit (and redeems with jupiter_withdraw).
 */
export const DIRECT_CPI_PROTOCOLS: ReadonlySet<string> = new Set(['jupiter']);

/** True if the protocol has no Nave adapter and is placed by a direct nave_core CPI. */
export function isDirectCpiProtocol(protocolId: string): boolean {
  return DIRECT_CPI_PROTOCOLS.has(protocolId.toLowerCase());
}

/** Resolve a protocol name to its adapter program ID, or null if unknown/unconfigured. */
export function getAdapterProgramId(protocolId: string): PublicKey | null {
  const pk = ADAPTER_PROGRAM_IDS[protocolId.toLowerCase()];
  if (!pk || pk.equals(new PublicKey('11111111111111111111111111111111'))) {
    return null;
  }
  return pk;
}