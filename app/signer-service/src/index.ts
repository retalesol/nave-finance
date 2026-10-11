import { createDecipheriv, createHash, timingSafeEqual } from 'node:crypto';
import express from 'express';
import { createClient } from '@supabase/supabase-js';
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import BN from 'bn.js';
import { jitoAccountsFromStakePool, kaminoAccountsFromReserve } from './venueAccounts.js';
import { adapterProgramId, checkJupiterProgramIds, devnetProgramIdWarnings, EXTERNAL_PROGRAM_IDS, fetchDaoRegistryTolerant, fetchExecutionRequestTolerant, getConnection, isMainnetCluster, pdas, PROGRAM_IDS, programsForAgent, resolveSolanaRpcUrl, type AgentPrograms } from './programs.js';
import { assertEvmKekPolicy, isKekConfigured, unwrapStoredDek } from './kek.js';
import { assertRoleSecretPolicy, authorizeRole, isSignerRole, type SignerRole } from './roleAuth.js';
import { circuitStatus, enforceLimits, recordSignerOutcome, releaseLimit } from './rateLimit.js';
import { feedBytesToHex, isZeroFeed, postPriceFeeds } from './pythPoster.js';
import { type EvmGuardianSignRequest, signEvmApproval } from './evmSigner.js';
import {
  type EvmRelayToggleRequest,
  type EvmRelayAgentActionRequest,
  type EvmRelayAgentAction,
  type EvmRelayUpdatePositionValueRequest,
  relayEvmAgentToggle,
  relayEvmAgentAction,
  relayEvmUpdateStrategyPositionValue,
  relayEvmCreateProposal,
  relayEvmRevalueTreasury,
  evmRelaySignerRole,
} from './evmRelayer.js';
import {
  type BridgeRelayBody,
  bridgeLookbackSeconds,
  checkBridgeFeeBpsDrift,
  evmConfirmationsByChain,
  handleBridgeRelay,
  readBridgeConfig,
  readBridgeEvmChainIds,
  readEvmNetwork,
} from './bridgeRelayer.js';
import { getBridgeQueueCounts, readBridgeWatcherConfig } from './bridgeWatcher.js';
import { readStakingMirrorConfig, runStakingMirror } from './stakingMirror.js';
import { getStakeClaimPending, getStakeClaimReserve, handleStakeClaim } from './stakeClaims.js';
import { checkMinSolBalance, readFaucetConfig, sendFaucetClaim, sendSolFaucetClaim } from './faucetRelayer.js';
import { publicCorsMiddleware } from './cors.js';
import { solanaVotingPeriodSeconds } from './actionDelays.js';

const PORT = Number(process.env.PORT || 8787);

// On-chain ProposalType::Strategy. Autonomous proposals only ever create
// Strategy proposals — capital MOVEMENTS (deploy OR withdraw) — never Policy
// proposals, which require human governance to amend the constitution. A
// withdraw is still a Strategy-type movement: same proposal primitive, same
// (protocol_program, amount, mint) payload binding; only the EXECUTION
// instruction differs (decided downstream from the persisted action_kind).
const PROPOSAL_TYPE_STRATEGY = 1;

// Fail-closed: the signer holds the agent keys and must never run without an
// auth secret. Refuse to boot if it is unset.
const SIGNER_SECRET = process.env.NAVE_SIGNER_SECRET || '';
if (!SIGNER_SECRET) {
  console.error('[signer] FATAL: NAVE_SIGNER_SECRET is not set. Refusing to start.');
  process.exit(1);
}
function skipSimulationRequested(): boolean {
  return (process.env.NAVE_SIGNER_SKIP_SIMULATION || '').toLowerCase() === 'true';
}
if (skipSimulationRequested() && (isMainnetCluster() || process.env.NODE_ENV === 'production')) {
  console.error('[signer] FATAL: NAVE_SIGNER_SKIP_SIMULATION is refused on mainnet / NODE_ENV=production');
  process.exit(1);
}
try {
  assertRoleSecretPolicy(SIGNER_SECRET);
} catch (err) {
  console.error(`[signer] FATAL: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}

// Legacy plaintext-DEK input over HTTP has been REMOVED. The envelope
// (NAVE_MASTER_KEK + wrapped DEK) flow is the only supported decrypt path.
// Honoring a raw `aes_decrypt_key` in the request body would let anyone who can
// reach /sign with a stolen DEK bypass the KEK envelope, so the field is now
// rejected unconditionally and there is no env flag to re-enable it.

// Fail-closed: on mainnet the Jupiter lending/liquidity program ids MUST be the
// canonical mainnet values. A mainnet binary still carrying the devnet
// placeholders would CPI the wrong program with real funds, so refuse to boot.
const JUPITER_ID_CHECK = checkJupiterProgramIds();
if (!JUPITER_ID_CHECK.ok) {
  console.error(
    `[signer] FATAL: Jupiter program id mismatch on mainnet:\n  - ${JUPITER_ID_CHECK.errors.join('\n  - ')}`,
  );
  process.exit(1);
}

// Fail-closed (audit 8c): the implicit `http://localhost:8899` RPC default is
// only acceptable for localnet. In production or on a public cluster
// (NAVE_CLUSTER=mainnet|devnet) a missing SOLANA_RPC_URL must stop the boot.
try {
  resolveSolanaRpcUrl();
} catch (err) {
  console.error(`[signer] FATAL: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}

// Fail-closed (audit 8g): in production the EVM signing KEK must be its own
// key — never a silent fallback to NAVE_MASTER_KEK.
try {
  assertEvmKekPolicy();
} catch (err) {
  console.error(`[signer] FATAL: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}

// Loud (non-fatal) boot warnings surfaced again on /health: devnet program ids
// on a mainnet cluster, and a Solana/EVM network mismatch. Kept non-fatal so a
// partially-cut-over deploy can still serve read-only paths while operators
// finish config, but every warning here is a release blocker.
const NAVE_CLUSTER = (process.env.NAVE_CLUSTER || '').trim() || null;
const NAVE_EVM_NETWORK = readEvmNetwork();
function runtimeConfigWarnings(): string[] {
  const warnings = devnetProgramIdWarnings();
  if (isMainnetCluster() && NAVE_EVM_NETWORK === 'testnet') {
    warnings.push('NAVE_CLUSTER is mainnet but NAVE_EVM_NETWORK=testnet — bridge family names resolve to EVM testnets');
  }
  if (!isMainnetCluster() && NAVE_EVM_NETWORK === 'mainnet') {
    warnings.push('NAVE_CLUSTER is not mainnet but NAVE_EVM_NETWORK=mainnet — bridge family names resolve to EVM mainnets');
  }
  if (readBridgeConfig().enabled && !NAVE_EVM_NETWORK) {
    warnings.push('NAVE_EVM_NETWORK is unset — /bridge-relay rejects chain family names; callers must send numeric chain ids');
  }
  return warnings;
}
for (const w of runtimeConfigWarnings()) console.error(`[signer] CONFIG WARNING: ${w}`);

// Agent swap capability (jupiter_swap). Fail-closed: the off-chain Jupiter
// aggregator swap path is DISABLED unless NAVE_SWAP_ENABLED is explicitly
// "true". This keeps the capability dark until it is intentionally rolled out
// and ensures it is never an unintentional default (the DAO creation/bootstrap
// flow deliberately does NOT depend on it — the bootstrap first action is
// SOL->Jito). NAVE_SWAP_MAX_SLIPPAGE_BPS caps the per-swap slippage bound an
// agent may request (default 1000 bps = 10%).
const SWAP_ENABLED = (process.env.NAVE_SWAP_ENABLED || '').toLowerCase() === 'true';
const SWAP_MAX_SLIPPAGE_BPS = Number(process.env.NAVE_SWAP_MAX_SLIPPAGE_BPS || 1000);

// Rate limits (per minute). Two dimensions enforced per request: caller IP and
// target DAO. Overridable via env for load testing.
const RATE_WINDOW_MS = Number(process.env.NAVE_SIGNER_RATE_WINDOW_MS || 60_000);
const RATE_PER_IP = Number(process.env.NAVE_SIGNER_RATE_PER_IP || 60);
const RATE_PER_DAO = Number(process.env.NAVE_SIGNER_RATE_PER_DAO || 30);
// Additional limiter dimensions (distributed/shared store): per-action and
// per-role within a DAO, plus a global ceiling across all DAOs/replicas.
const RATE_PER_ACTION = Number(process.env.NAVE_SIGNER_RATE_PER_ACTION || 20);
const RATE_PER_ROLE = Number(process.env.NAVE_SIGNER_RATE_PER_ROLE || 20);
const RATE_GLOBAL = Number(process.env.NAVE_SIGNER_RATE_GLOBAL || 300);

/** Expected on-chain ExecutionRequest.status for each signing action.
 *  `create_proposal` is intentionally absent — it operates on a NEW proposal,
 *  not an existing ExecutionRequest, so it has no required prior status. */
const ACTION_REQUIRED_STATUS: Partial<Record<SignAction, number[]>> = {
  executive_approve: [0], // Pending
  financial_approve: [1], // ExecutiveApproved
  oversight_approve: [2], // FinancialApproved
  operational_halt: [3, 4], // OversightApproved | InReview
  operational_clear: [6], // Halted
  execute_strategy: [3, 4], // OversightApproved | InReview (post review window)
  withdraw_from_strategy: [5], // Executed
  expire_request: [4], // InReview only (after review window)
};

/** The only agent role allowed to drive each Solana action; it is also the
 *  role whose caller credential must authorize the request. Actions absent
 *  here (permissionless executors, proposal creation) accept the claimed role. */
const ACTION_SIGNER_ROLE: Partial<Record<SignAction, SignerRole>> = {
  executive_approve: 'executive',
  financial_approve: 'financial',
  oversight_approve: 'oversight',
  operational_halt: 'operational',
  operational_clear: 'operational',
  withdraw_from_strategy: 'executive',
  toggle_agents: 'executive',
  update_strategy_position_value: 'operational',
  revalue_treasury: 'operational',
  kamino_deposit: 'operational',
  kamino_withdraw: 'operational',
  jito_deposit: 'operational',
  jito_withdraw: 'operational',
  jupiter_deposit: 'operational',
  jupiter_withdraw: 'operational',
  marginfi_deposit: 'operational',
  marginfi_withdraw: 'operational',
  jupiter_swap: 'operational',
  bundle_rebalance: 'operational',
  replenish_agents: 'operational',
};

/** Credential role for a /sign request; the planner proposes under Operational. */
function solanaCredentialRole(action: SignAction | undefined, claimed: string | undefined): SignerRole | null {
  const fixed = action ? ACTION_SIGNER_ROLE[action] : undefined;
  if (fixed) return claimed === fixed ? fixed : null;
  if (claimed === 'planner') return 'operational';
  return isSignerRole(claimed) && claimed !== 'guardian' ? claimed : null;
}

const STATUS_NAMES = [
  'Pending', 'ExecutiveApproved', 'FinancialApproved', 'OversightApproved',
  'InReview', 'Executed', 'Halted', 'Expired',
] as const;

// Lazily construct the Supabase client so the service can boot and serve
// /health even if DB credentials are not yet configured (the newer
// supabase-js throws on an empty URL at construction time).
let _supabase: ReturnType<typeof createClient> | null = null;
function getSupabase(): ReturnType<typeof createClient> {
  if (_supabase) return _supabase;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set to sign transactions.');
  }
  _supabase = createClient(url, key);
  return _supabase;
}

type AgentRole = 'executive' | 'financial' | 'oversight' | 'operational' | 'planner';

type SignAction =
  | 'executive_approve'
  | 'financial_approve'
  | 'oversight_approve'
  | 'operational_halt'
  | 'operational_clear'
  | 'execute_strategy'
  | 'withdraw_from_strategy'
  | 'update_strategy_position_value'
  | 'expire_request'
  | 'create_proposal'
  | 'toggle_agents'
  // ── multi-asset / real-protocol CPI actions (nave_core) ──
  | 'revalue_treasury'
  | 'kamino_deposit'
  | 'kamino_withdraw'
  | 'jito_deposit'
  | 'jito_withdraw'
  | 'jupiter_deposit'
  | 'jupiter_withdraw'
  | 'marginfi_deposit'
  | 'marginfi_withdraw'
  // ── off-chain aggregator swap (Jupiter swap/aggregator API) ──
  | 'jupiter_swap'
  | 'replenish_agents'
  | 'bundle_rebalance'
  | 'finalize_proposal';

interface SignRequest {
  action: SignAction;
  dao_address: string;
  execution_request_address: string;
  agent_role: AgentRole;
  /** Multi-chain discriminator. Omitted/'solana' uses this Solana path. EVM
   *  chains ('ethereum' | 'base') do NOT use this endpoint: agent approvals are
   *  relayed via /relay-evm (msg.sender tx) and guardian actions are signed via
   *  /sign-evm (EIP-712 GuardianAction). */
  chain?: string;
  chain_id?: number;
  /** Optional base64 AES-256-GCM raw key (legacy). When omitted, the signer
   *  unwraps the persisted DEK using the master KEK. */
  aes_decrypt_key?: string;
  /** Hex-encoded 32-byte SHA-256 of the agent's structured reasoning. */
  reasoning_hash?: string;
  /** Required for execute_strategy, withdraw_from_strategy and create_proposal. */
  protocol_id?: string;
  /**
   * Pyth PriceUpdateV2 account for the asset being deployed/withdrawn
   * (execute_strategy / withdraw_from_strategy). Optional: stablecoins are valued
   * at USD parity on-chain and ignore it. For SolLike/Other assets the caller
   * (orchestrator) posts a fresh Hermes update and passes its address here.
   */
  price_update_address?: string;
  // ── create_proposal-only fields ──────────────────────────────────────────
  /** Strategy deploy amount in vault-token base units (create_proposal/withdraw/update). */
  amount?: number | string;
  /**
   * Direction of the proposed Strategy capital movement (create_proposal).
   * `deploy` deposits idle capital into a protocol; `withdraw` redeems from a
   * protocol (reduce-exposure / rebalance unwind). Both are the SAME on-chain
   * ProposalType::Strategy primitive with the same payload binding — the
   * direction is carried off-chain so the downstream pipeline runs the correct
   * instruction (execute_strategy vs withdraw_from_strategy). Defaults to
   * `deploy` for backward compatibility. */
  action_kind?: 'deploy' | 'withdraw';
  /** Proposal title (create_proposal). */
  title?: string;
  /** Proposal description (create_proposal). */
  description?: string;
  /** Voting window in seconds (create_proposal). Omitted: 7 days on mainnet, 60s on devnet. */
  voting_period_seconds?: number;
  /**
   * Exactly-once key (create_proposal). The source recommendation's
   * policy_proof_hash (or per-action digest). Enforced via a UNIQUE DB index so
   * the same recommendation can never spawn two on-chain proposals.
   */
  idempotency_key?: string;
  /** Source rebalance_recommendations.id, for audit linkage (create_proposal). */
  recommendation_id?: string;
  // ── toggle_agents-only field ──────────────────────────────────────────────
  /** Desired on-chain agents_enabled state (toggle_agents). */
  enabled?: boolean;
  // ── multi-asset / real-protocol CPI fields ────────────────────────────────
  /** Asset mint for the kamino/jito CPI actions (deployed asset; wSOL for jito). */
  mint?: string;
  /** Kamino klend external accounts (kamino_deposit / kamino_withdraw). */
  kamino?: {
    reserve: string;
    lending_market: string;
    lending_market_authority: string;
    reserve_liquidity_supply: string;
    reserve_collateral_mint: string;
    /** refresh_reserve oracle slots (pyth/switchboard/scope), in order. */
    oracles?: string[];
  };
  /** SPL stake-pool external accounts (jito_deposit / jito_withdraw). */
  jito?: {
    stake_pool: string;
    stake_pool_withdraw_authority: string;
    reserve_stake: string;
    manager_fee_account: string;
    pool_mint: string;
  };
  /**
   * MarginFi v2 external accounts (marginfi_deposit / marginfi_withdraw).
   * `marginfi_account` is the DAO's single non-PDA cross-margin ledger,
   * provisioned once (per DAO) by the founder-signed `configure_marginfi_position`
   * and persisted on-chain in `strategy_position.position_token_account` — the
   * caller reads it from there rather than tracking it separately off-chain.
   * `bank_liquidity_vault[_authority]` are deterministic MarginFi PDAs
   * (`["liquidity_vault"(_auth), bank]` under the MarginFi program) — the
   * handler derives them from `bank` when omitted; only pass them to override.
   * `oracles` (withdraw only) is the health-check remaining-accounts set MarginFi
   * requires after every withdrawal: forwarded verbatim as `[bank, oracle(s)...]`
   * (the bank pubkey again, then its oracle account(s) — confirmed against the
   * deployed devnet program, which errors without it).
   */
  marginfi?: {
    marginfi_group: string;
    marginfi_account: string;
    bank: string;
    /** Optional — derived from `bank` via the deterministic MarginFi PDA when omitted. */
    bank_liquidity_vault?: string;
    /** Optional — derived from `bank` via the deterministic MarginFi PDA when omitted. */
    bank_liquidity_vault_authority?: string;
    /** Health-check remaining accounts for marginfi_withdraw: [bank, oracle(s)...]. */
    oracles?: string[];
  };
  /** revalue_treasury: every registered asset + (for non-stables) its posted
   *  Pyth PriceUpdateV2 address. Order is irrelevant; the program checks each. */
  assets?: { mint: string; price_update_address?: string }[];
  /** Optional Address Lookup Table to pack the larger CPI transactions. */
  lookup_table_address?: string;
  /**
   * Jito bundle rebalance: list of protocol CPI operations to execute atomically.
   * Used with action === 'bundle_rebalance'. Each entry is a full signer sub-request
   * (same shape as a regular SignRequest minus dao_address / agent_role which are
   * inherited from the top-level request). Up to 4 operations (leaving 1 slot for tip).
   *
   * Example — rebalance from Kamino USDC to Jito SOL in one atomic bundle:
   *   bundle_operations: [
   *     { action: 'kamino_withdraw', mint: '...USDC...', amount: 5000000, kamino: {...} },
   *     { action: 'jito_deposit',   mint: '...wSOL...', amount: 3000000000, jito: {...} },
   *   ]
   */
  bundle_operations?: Array<{
    action: string;
    mint?: string;
    amount?: number | string;
    protocol_id?: string;
    kamino?: SignRequest['kamino'];
    jito?: SignRequest['jito'];
    jupiter?: SignRequest['jupiter'];
    marginfi?: SignRequest['marginfi'];
    lookup_table_address?: string;
    execution_request_address?: string;
    purpose?: 'venue_placement';
  }>;
  /** Tip in lamports for Jito bundle (bundle_rebalance only). Defaults to JITO_TIP_LAMPORTS env. */
  jito_tip_lamports?: number;
  /** Proposal index for finalize_proposal action. */
  proposal_index?: number;
  /**
   * Jupiter Lend (Earn) external accounts (jupiter_deposit / jupiter_withdraw).
   * All accounts are resolvable from the Jupiter Earn API:
   *   POST https://api.jup.ag/lend/v1/earn/deposit-instructions  { asset, amount, signer }
   * When omitted the handler calls the API automatically using JUPITER_API_KEY.
   */
  jupiter?: {
    /** Per-asset Jupiter `lending` PDA (ext_market in strategy_position). */
    lending: string;
    /** jlToken (fToken) mint minted by the Jupiter vault for this asset. */
    f_token_mint: string;
    /** Protocol configuration PDA (singleton). */
    lending_admin: string;
    /** Liquidity-layer token reserves for this asset. */
    supply_token_reserves_liquidity: string;
    /** Lending program's supply position in the liquidity layer. */
    lending_supply_position_on_liquidity: string;
    /** Interest-rate model PDA. */
    rate_model: string;
    /** Liquidity-layer protocol vault (holds the underlying). Bound to ext_reserve. */
    vault: string;
    /** Main liquidity protocol PDA. */
    liquidity: string;
    /** Liquidity program (forwarded; differs devnet/mainnet). */
    liquidity_program: string;
    /** Rewards rate model PDA. */
    rewards_rate_model: string;
    /** Withdrawal claim-processing account (withdraw only). */
    claim_account?: string;
  };
  // ── jupiter_swap (off-chain Jupiter swap/aggregator route + signer submit) ──
  /** Input (sell) token mint, e.g. wSOL. Required for jupiter_swap. */
  input_mint?: string;
  /** Output (buy) token mint, e.g. USDC. Required for jupiter_swap. */
  output_mint?: string;
  /**
   * Slippage bound in basis points for the Jupiter route (jupiter_swap).
   * REQUIRED — the swap will never settle worse than this bound. Capped at
   * NAVE_SWAP_MAX_SLIPPAGE_BPS (default 1000 = 10%) so an agent can never submit
   * an unbounded-slippage swap.
   */
  slippage_bps?: number;
  /**
   * Optional minimum acceptable output in base units (jupiter_swap). When
   * supplied, the handler refuses to submit unless the route's
   * GUARANTEED-minimum out (quote.otherAmountThreshold for ExactIn) is >= this
   * value, giving a hard floor independent of the slippage bound.
   */
  min_out?: number | string;
}

const ZERO_HASH: number[] = Array(32).fill(0);

function hexToBytes32(hex?: string): number[] {
  // Absent hash is a legitimate "no reasoning committed" case → zero hash.
  if (!hex) return ZERO_HASH;
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  // A supplied hash MUST be exactly 32 bytes of hex (64 chars). Never silently
  // pad/truncate — that would commit a different hash on-chain than intended,
  // defeating reasoning-hash integrity. Reject malformed input loudly instead.
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) {
    throw new Error('reasoning_hash must be exactly 32 bytes (64 hex chars)');
  }
  return Array.from(Buffer.from(clean, 'hex'));
}

/** Canonical tx_payload_hash = SHA-256(proposal.payload[0..payload_len]).
 *  Shared by financial_approve, oversight_approve and the on-chain execute path. */
function computeTxPayloadHash(payload: number[] | Uint8Array, payloadLen: number): number[] {
  const bytes = Buffer.from(Array.from(payload).slice(0, payloadLen));
  return Array.from(createHash('sha256').update(bytes).digest());
}

/** Decrypt an AES-256-GCM encrypted agent secret key into a Keypair. */
function decryptAgentKeypair(
  aesKeyBase64: string,
  ciphertextBase64: string,
  ivBase64: string,
  tagBase64: string,
): Keypair {
  const key = Buffer.from(aesKeyBase64, 'base64');
  const iv = Buffer.from(ivBase64, 'base64');
  const tag = Buffer.from(tagBase64, 'base64');
  const ciphertext = Buffer.from(ciphertextBase64, 'base64');

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const secretKey = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return Keypair.fromSecretKey(new Uint8Array(secretKey));
}

interface EncryptedAgentKeyRow {
  encrypted_private_key: string;
  encryption_iv: string;
  encryption_tag: string;
  public_key: string;
  wrapped_dek: string | null;
  dek_wrap_iv: string | null;
  dek_wrap_tag: string | null;
  dek_wrap_version: number | null;
  dek_kek_ref: string | null;
}

async function loadAgentKeypair(
  daoAddress: string,
  role: AgentRole,
  // Retained for call-site compatibility but always undefined: the legacy
  // plaintext-DEK path has been removed. The DEK is resolved solely by
  // unwrapping the persisted wrapped_dek via the master KEK.
  _aesKey?: string,
): Promise<Keypair> {
  const { data, error } = await getSupabase()
    .from('encrypted_agent_keys')
    .select(
      'encrypted_private_key, encryption_iv, encryption_tag, public_key, wrapped_dek, dek_wrap_iv, dek_wrap_tag, dek_wrap_version, dek_kek_ref',
    )
    .eq('dao_onchain_address', daoAddress)
    .eq('agent_role', role)
    .eq('is_active', true)
    .maybeSingle<EncryptedAgentKeyRow>();

  if (error || !data) {
    throw new Error(`No active key for ${role}@${daoAddress}: ${error?.message ?? 'not found'}`);
  }

  // Resolve the DEK strictly by unwrapping the persisted wrapped DEK via the
  // master KEK. The legacy plaintext-DEK path has been removed.
  let dek: string;
  if (data.wrapped_dek && data.dek_wrap_iv && data.dek_wrap_tag) {
    dek = unwrapStoredDek(
      'solana',
      {
        wrapped_dek: data.wrapped_dek,
        dek_wrap_iv: data.dek_wrap_iv,
        dek_wrap_tag: data.dek_wrap_tag,
        dek_wrap_version: data.dek_wrap_version,
        dek_kek_ref: data.dek_kek_ref,
      },
      { dao: daoAddress, role, chain: 'solana' },
    );
  } else {
    throw new Error(`No wrapped DEK available for ${role}@${daoAddress} (envelope decrypt required).`);
  }

  const kp = decryptAgentKeypair(
    dek,
    data.encrypted_private_key,
    data.encryption_iv,
    data.encryption_tag,
  );

  if (kp.publicKey.toBase58() !== data.public_key) {
    throw new Error('Decrypted keypair does not match stored public key (wrong AES key).');
  }
  return kp;
}

/** Postgres unique-violation SQLSTATE. */
const PG_UNIQUE_VIOLATION = '23505';

// On-chain AssetKind discriminants (nave_core::constants::AssetKind).
const ASSET_KIND_STABLE = 0;
const ASSET_KIND_SOL_LIKE = 1;

/**
 * Mirrors nave_execution::required_asset_kind: stablecoins route to lending
 * (Kamino / MarginFi); SOL-like assets route to liquid staking (Jito).
 * Autonomous Strategy proposals only ever target these adapter protocols
 * (see adapterProgramId), so the required kind is always defined for a proposal.
 */
function requiredAssetKindForProtocol(protocolId: string): number | null {
  switch (protocolId.toLowerCase()) {
    case 'kamino':
    case 'marginfi':
      return ASSET_KIND_STABLE;
    case 'jito':
      return ASSET_KIND_SOL_LIKE;
    default:
      return null;
  }
}

/**
 * Resolve the asset mint to bind into a Strategy proposal's NE-7 payload — the
 * mint of the asset actually being DEPLOYED/WITHDRAWN for this recommendation.
 *
 * DAOs are multi-asset, so this must NOT be blindly token_registry.tokens[0]:
 * TokenRegistry tracks the tokens the DAO *issues* (its governance token), which
 * is not necessarily a held treasury asset, and even when it holds several the
 * deployed asset may be tokens[1]/tokens[2].
 *
 * Resolution order:
 *   1. `explicitMint` — threaded from the policy recommendation/opportunity (the
 *      pool scanner resolves the exact pool asset). Preferred. Best-effort
 *      validated against the protocol's required AssetKind via the on-chain
 *      AssetConfig; rejected only on a definitive kind mismatch.
 *   2. Single registered token (token_count ≤ 1): the lone token — preserves the
 *      previous single-asset DAO behavior unchanged.
 *   3. Multi-asset, no explicit mint: derive by matching each registered token's
 *      on-chain AssetConfig.asset_kind to the protocol's required kind. Exactly
 *      one match → use it; zero or multiple → throw so the caller supplies an
 *      explicit mint (we never guess between same-kind assets).
 *
 * DATA-AVAILABILITY NOTE: there is no single on-chain account that enumerates a
 * DAO's HELD treasury assets (AssetConfig is per-(dao,mint); TokenRegistry holds
 * ISSUED tokens). We therefore enumerate over the registered token set and read
 * each token's AssetConfig for its kind. The authoritative, unambiguous signal
 * for the common path is the threaded recommendation mint (case 1); the
 * by-kind derivation (case 3) only resolves when a single registered asset
 * matches the protocol's kind.
 */
async function resolveProposalAssetMint(
  readPrograms: AgentPrograms,
  dao: PublicKey,
  protocolId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registry: any,
  explicitMint?: string,
): Promise<PublicKey> {
  const requiredKind = requiredAssetKindForProtocol(protocolId);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fetchAssetKind = async (mint: PublicKey): Promise<number | null> => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cfg = await (readPrograms.core.account as any).assetConfig.fetch(pdas.assetConfig(dao, mint));
      return Number(cfg.assetKind);
    } catch {
      // No AssetConfig → not a registered treasury asset (e.g. an issued-only
      // governance token). Treat as "kind unknown" so it never matches.
      return null;
    }
  };

  // 1. Explicit mint from the recommendation — the authoritative signal.
  if (explicitMint) {
    const mint = new PublicKey(explicitMint);
    if (requiredKind !== null) {
      const kind = await fetchAssetKind(mint);
      if (kind !== null && kind !== requiredKind) {
        throw new Error(
          `supplied mint ${explicitMint} has AssetKind ${kind} but ${protocolId} requires AssetKind ${requiredKind}`,
        );
      }
    }
    return mint;
  }

  // Enumerate the DAO's registered token mints.
  const count = Number(registry.tokenCount ?? registry.token_count ?? (registry.tokens?.length ?? 0));
  const mints: PublicKey[] = [];
  for (let i = 0; i < count && i < registry.tokens.length; i++) {
    mints.push(new PublicKey(registry.tokens[i].mint));
  }
  if (mints.length === 0) {
    throw new Error('DAO has no registered tokens to bind a proposal asset mint');
  }

  // 2. Single-asset DAO: unchanged behavior.
  if (mints.length === 1) return mints[0];

  // 3. Multi-asset: derive the asset whose AssetKind matches the protocol.
  if (requiredKind === null) {
    throw new Error(
      `cannot derive an asset mint for protocol ${protocolId} (no required AssetKind); pass an explicit mint`,
    );
  }
  const matches: PublicKey[] = [];
  for (const m of mints) {
    if ((await fetchAssetKind(m)) === requiredKind) matches.push(m);
  }
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) {
    throw new Error(
      `no registered asset matches required AssetKind ${requiredKind} for ${protocolId}; ` +
      `register the asset or pass an explicit mint`,
    );
  }
  throw new Error(
    `${matches.length} registered assets match AssetKind ${requiredKind} for ${protocolId}; ` +
    `pass an explicit mint to disambiguate (multi-asset DAO with multiple same-kind assets)`,
  );
}

/**
 * Create a Strategy governance proposal from a policy recommendation. The
 * proposal can be a deploy (deposit idle capital) OR a withdraw (redeem /
 * reduce-exposure / rebalance unwind) — both are ProposalType::Strategy with
 * the same direction-agnostic payload binding. `action_kind` (persisted to
 * agent_proposals) records the intended direction for the downstream pipeline.
 *
 * Security / separation-of-duties properties:
 *   - Exactly-once: an `agent_proposals` row keyed on (dao, idempotency_key) is
 *     inserted BEFORE any on-chain submission. A concurrent/duplicate attempt
 *     collides on the UNIQUE index and is rejected (409) — the same
 *     recommendation can never spawn two proposals.
 *   - The payload is the SAME 72-byte preimage the execution program binds to
 *     (sha256(protocol_program(32) ‖ amount_le(8) ‖ mint(32))), so a downstream
 *     create_execution_request will match exactly. No ambiguity.
 *   - Proposing grants no execution power: the proposal still has to win the
 *     vote and clear the full 4-agent + guardrail + review-window pipeline.
 *   - On failure the idempotency row is removed so a later cycle can retry.
 */
async function handleCreateProposal(
  res: express.Response,
  body: SignRequest,
  dao: PublicKey,
  effectiveAesKey?: string,
): Promise<express.Response> {
  const { protocol_id, idempotency_key, recommendation_id, agent_role } = body;

  if (!protocol_id) {
    return res.status(400).json({ error: 'create_proposal requires protocol_id' });
  }
  if (!idempotency_key) {
    return res.status(400).json({ error: 'create_proposal requires idempotency_key' });
  }

  // Direction of the Strategy capital movement. Defaults to 'deploy' so older
  // callers keep their exact behavior. Validate loudly — an unknown value must
  // never be silently coerced, since the persisted action_kind routes the
  // downstream execution instruction (deposit vs redeem).
  const actionKind = body.action_kind ?? 'deploy';
  if (actionKind !== 'deploy' && actionKind !== 'withdraw') {
    return res.status(400).json({ error: "create_proposal action_kind must be 'deploy' or 'withdraw'" });
  }

  const amount = typeof body.amount === 'string' ? Number(body.amount) : body.amount;
  if (!Number.isFinite(amount as number) || (amount as number) <= 0 || !Number.isInteger(amount as number)) {
    return res.status(400).json({ error: 'create_proposal requires a positive integer amount (base units)' });
  }
  const amountBu = amount as number;

  const adapter = adapterProgramId(protocol_id);
  if (!adapter) {
    return res.status(400).json({ error: `Unknown protocol_id: ${protocol_id}` });
  }

  // Resolve two DISTINCT mints up-front (read-only, throwaway signer — no agent
  // key is decrypted here):
  //   (a) daoTokenMint — the DAO's governance VOTING token (token_registry slot
  //       0). The on-chain createProposal binds it for the vote-supply snapshot
  //       and, for token-governed DAOs, requires it to be a registered token.
  //       It is intentionally still tokens[0]: it is NOT the deployed asset.
  //   (b) assetMint — the asset actually being DEPLOYED/WITHDRAWN. DAOs are
  //       multi-asset, so this is resolved per-recommendation (explicit mint
  //       threaded from the policy opportunity, else derived by AssetKind) and
  //       is what the NE-7 payload binds. See resolveProposalAssetMint.
  const readPrograms = programsForAgent(Keypair.generate(), getConnection());
  let daoTokenMint: PublicKey;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let registry: any;
  try {
    const tokenRegistryPda = PublicKey.findProgramAddressSync(
      [Buffer.from('token_registry'), dao.toBuffer()],
      PROGRAM_IDS.core,
    )[0];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registry = await (readPrograms.core.account as any).tokenRegistry.fetch(tokenRegistryPda);
    daoTokenMint = new PublicKey(registry.tokens[0].mint);
  } catch (err) {
    return res.status(502).json({
      error: `Failed to read DAO token registry for proposal payload: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  let assetMint: PublicKey;
  try {
    assetMint = await resolveProposalAssetMint(readPrograms, dao, protocol_id, registry, body.mint);
  } catch (err) {
    // Ambiguous / missing asset signal is a caller-fixable condition (pass an
    // explicit mint), not a transient read failure → 400.
    return res.status(400).json({
      error: `Could not resolve the asset mint to bind into the proposal: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // Canonical NE-7 binding payload — MUST be byte-identical to the preimage the
  // execution program hashes at create_execution_request:
  //   sha256(protocol_program(32) ‖ amount_le(8) ‖ mint(32)) = 72 bytes.
  // The governance program commits proposal.payload_hash = sha256(payload); the
  // execution program recomputes sha256 over these exact 72 bytes (with the
  // on-chain ExecutionRequest.mint) and requires equality. Binding the WRONG
  // asset mint (e.g. tokens[0] on a multi-asset DAO) would hash differently, so
  // create_execution_request would fail with PayloadHashMismatch and the
  // proposal would be permanently unexecutable.
  // NOTE: the payload is intentionally direction-AGNOSTIC — a deploy and a
  // withdraw to the same protocol/amount/mint bind to the SAME on-chain payload.
  // The direction is persisted off-chain (action_kind) and applied by the
  // downstream pipeline (execute_strategy vs withdraw_from_strategy).
  const payload = Buffer.alloc(72);
  adapter.toBuffer().copy(payload, 0);
  payload.writeBigUInt64LE(BigInt(amountBu), 32);
  assetMint.toBuffer().copy(payload, 40);
  const payloadHash = createHash('sha256').update(payload).digest('hex');

  // The generated Supabase types don't yet include the agent_proposals table
  // (added by migration 1780800000); cast to a loose surface for these writes.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase = getSupabase() as any;

  // ── Reclaim crashed reservations (M5) ─────────────────────────────────
  // A 'creating' row is written before the on-chain submit. If the process dies
  // between submit and the status update, the row is stuck in 'creating' forever
  // and the unique idempotency_key blocks every future retry. Proactively delete
  // any 'creating' reservation for THIS idempotency_key older than the TTL so a
  // crashed cycle can be retried. ('created' rows are left intact and still
  // collide as duplicates.) The 2-minute TTL is far longer than the
  // submit→update gap, so it never races a genuinely in-flight request.
  const STALE_CREATING_MS = 120_000;
  await supabase
    .from('agent_proposals')
    .delete()
    .eq('dao_onchain_address', dao.toBase58())
    .eq('idempotency_key', idempotency_key)
    .eq('status', 'creating')
    .lt('created_at', new Date(Date.now() - STALE_CREATING_MS).toISOString());

  // ── Idempotency guard (insert-before-submit) ──────────────────────────
  const { data: inserted, error: insertErr } = await supabase
    .from('agent_proposals')
    .insert({
      dao_onchain_address: dao.toBase58(),
      idempotency_key,
      recommendation_id: recommendation_id ?? null,
      protocol_id,
      program_id: adapter.toBase58(),
      amount_base_units: amountBu,
      action_kind: actionKind,
      payload_hash: payloadHash,
      proposer_role: agent_role,
      status: 'creating',
    })
    .select('id')
    .single();

  if (insertErr) {
    if ((insertErr as { code?: string }).code === PG_UNIQUE_VIOLATION) {
      return res.status(409).json({
        error: 'Duplicate proposal: a proposal already exists for this idempotency_key',
        idempotency_key,
      });
    }
    return res.status(500).json({ error: `Failed to reserve idempotency row: ${insertErr.message}` });
  }

  const ledgerId = (inserted as { id: string }).id;

  let programs: AgentPrograms;
  try {
    const proposer = await loadAgentKeypair(dao.toBase58(), agent_role, effectiveAesKey);
    programs = programsForAgent(proposer, getConnection());

    // Resolve proposal index (dao_registry.proposal_count). The governance
    // voting token (daoTokenMint = token_registry.tokens[0]) was resolved above
    // for the createProposal account; the deployed-asset mint (assetMint) was
    // bound into the payload hash.
    const daoAcc = await fetchDaoRegistryTolerant(programs, dao);
    const proposalIndex = Number(daoAcc.proposalCount?.toString?.() ?? daoAcc.proposalCount ?? 0);

    const proposal = pdas.proposal(dao, proposalIndex);
    const votingPeriod = solanaVotingPeriodSeconds(body.voting_period_seconds, isMainnetCluster());

    const verb = actionKind === 'withdraw' ? 'Withdraw' : 'Deploy';
    const preposition = actionKind === 'withdraw' ? 'from' : 'to';
    const signature = await programs.governance.methods
      .createProposal({
        title: (body.title || `${verb} ${amountBu} ${preposition} ${protocol_id}`).slice(0, 64),
        description: (body.description || `Autonomous policy recommendation: ${verb.toLowerCase()} ${amountBu} base units ${preposition} ${protocol_id}.`).slice(0, 256),
        payload,
        proposalType: PROPOSAL_TYPE_STRATEGY,
        votingPeriodSeconds: new BN(votingPeriod),
      })
      .accountsPartial({
        proposer: programs.provider.wallet.publicKey,
        daoRegistry: dao,
        proposal,
        daoTokenMint,
      })
      .rpc();

    await supabase
      .from('agent_proposals')
      .update({
        status: 'created',
        proposal_index: proposalIndex,
        proposal_address: proposal.toBase58(),
        tx_signature: signature,
        updated_at: new Date().toISOString(),
      })
      .eq('id', ledgerId);

    return res.json({
      success: true,
      signature,
      action_kind: actionKind,
      proposal_address: proposal.toBase58(),
      proposal_index: proposalIndex,
      payload_hash: payloadHash,
      asset_mint: assetMint.toBase58(),
      proposer: programs.provider.wallet.publicKey.toBase58(),
    });
  } catch (err) {
    // Remove the reservation so a future cycle can retry this recommendation.
    await supabase.from('agent_proposals').delete().eq('id', ledgerId);
    console.error('[signer] create_proposal error:', err);
    return res.status(500).json({ error: err instanceof Error ? err.message : 'create_proposal failed' });
  }
}

// ── Agent wallet replenishment — 3-tier hysteresis model ──────────────────────
//
// Agent fee budgets are funded from the protocol ops/revenue wallet
// (NAVE_OPS_WALLET_SECRET) — the SAME wallet that receives the on-chain 8.5%
// yield fee. Replenishment uses a fixed three-tier band with hysteresis so a
// wallet that has just been filled is not topped up again on every cycle:
//
//   REQUEST  (default 0.05 SOL): below this the agent is CRITICALLY low. It
//            actively "requests" SOL — we emit an urgent log + set
//            `requestedUrgent` on the result — and top it up this cycle.
//   OPERATE  (default 0.10 SOL): at/above this the agent can operate and makes
//            NO requests.
//   CEILING  (default 0.25 SOL): the FILL target. Wallets are topped UP TO this
//            amount; a wallet already at/above CEILING is never filled.
//   TRIGGER  (default 0.10 SOL = OPERATE): the refill trigger. We only refill
//            when balance ≤ TRIGGER. Between TRIGGER (0.10) and CEILING (0.25)
//            we do nothing — this is the hysteresis band: once a wallet is
//            filled to 0.25 it is NOT refilled again until it drops back to
//            0.10, then we trickle fees back up toward 0.25.
//
// The stateless rule "refill to CEILING iff balance ≤ TRIGGER" exactly
// implements the hysteresis (we never fill while sitting between 0.10 and 0.25).

const LAMPORTS_PER_SOL = 1_000_000_000;

/** Parse a SOL-denominated env override into lamports, falling back to `defaultSol`. */
function solEnvToLamports(envName: string, defaultSol: number): number {
  const raw = process.env[envName];
  const sol = raw !== undefined && raw !== '' ? Number(raw) : defaultSol;
  if (!Number.isFinite(sol) || sol < 0) {
    console.warn(`[signer] ${envName}="${raw}" is invalid; using default ${defaultSol} SOL.`);
    return Math.round(defaultSol * LAMPORTS_PER_SOL);
  }
  return Math.round(sol * LAMPORTS_PER_SOL);
}

/** REQUEST tier — below this an agent is critically low and requests SOL. */
const AGENT_REQUEST_THRESHOLD_LAMPORTS = solEnvToLamports('NAVE_AGENT_SOL_REQUEST_THRESHOLD', 0.05);
/** OPERATE tier — at/above this an agent can operate and makes no requests. */
const AGENT_OPERATE_LEVEL_LAMPORTS = solEnvToLamports('NAVE_AGENT_SOL_OPERATE_LEVEL', 0.10);
/** FILL CEILING — top wallets up to this amount; never fill above it. */
const AGENT_FILL_CEILING_LAMPORTS = solEnvToLamports('NAVE_AGENT_SOL_FILL_CEILING', 0.25);
/**
 * Refill trigger — refill (toward CEILING) only when balance ≤ this; between
 * the trigger and CEILING nothing happens (hysteresis). Defaults to the OPERATE
 * level (0.10) so the operating band is exactly OPERATE→CEILING; override
 * independently with NAVE_AGENT_SOL_REFILL_TRIGGER.
 */
const AGENT_REFILL_TRIGGER_LAMPORTS = process.env.NAVE_AGENT_SOL_REFILL_TRIGGER
  ? solEnvToLamports('NAVE_AGENT_SOL_REFILL_TRIGGER', 0.10)
  : AGENT_OPERATE_LEVEL_LAMPORTS;

/** Conservative fee per transaction (base 5 k + typical priority fee). */
const ESTIMATED_TX_FEE_LAMPORTS = 50_000; // 0.00005 SOL per tx

/** Hard minimum used by the inline pre-sign emergency top-up (≈50 txs). */
const HARD_MIN_LAMPORTS = 50 * ESTIMATED_TX_FEE_LAMPORTS; // 2_500_000 ≈ 0.0025 SOL

/** Safety gate: if somehow below this we must refill before signing. */
const CRITICAL_MIN_LAMPORTS = 5 * ESTIMATED_TX_FEE_LAMPORTS; // 250_000 lamports

/** Per-wallet outcome of a replenishment cycle (consumed by worker.ts). */
interface AgentWalletResult {
  role: string;
  /** Balance in lamports after this cycle (-1 on read/load error). */
  balance: number;
  /** Whether the wallet was topped up this cycle. */
  toppedUp: boolean;
  /** Lamports transferred from the ops wallet this cycle. */
  topUpLamports: number;
  /** True when the wallet was below the REQUEST threshold (critically low). */
  requestedUrgent: boolean;
}

/**
 * Load the protocol operations keypair from `NAVE_OPS_WALLET_SECRET`.
 * This wallet is funded from Nave's 8.5% protocol fee revenue and is used
 * exclusively to replenish agent wallets.
 * Returns null if the env var is not configured.
 */
function loadOpsWallet(): Keypair | null {
  const secret = process.env.NAVE_OPS_WALLET_SECRET;
  if (!secret) return null;
  try {
    const decoded = Buffer.from(secret, 'base64');
    return Keypair.fromSecretKey(decoded);
  } catch {
    try {
      // Also accept comma-separated byte array (e.g. from `solana-keygen`).
      const bytes = Uint8Array.from(secret.split(',').map(Number));
      return Keypair.fromSecretKey(bytes);
    } catch {
      console.error('[signer] NAVE_OPS_WALLET_SECRET is set but could not be parsed.');
      return null;
    }
  }
}

/**
 * Read the on-chain agent gate (DaoRegistry.frozen + agents_enabled) for a
 * Solana DAO. Used by the worker (H4) to skip paused/disabled treasuries before
 * spending ops-wallet SOL on predictable failures.
 *
 * Returns `null` when the gate cannot be read (RPC miss, or a non-Solana / EVM
 * address that is not a valid PublicKey). Callers must treat `null` as
 * "unknown — do not skip" so a transient read miss never starves a live DAO.
 */
export async function readDaoAgentGate(
  daoAddress: string,
): Promise<{ frozen: boolean; agentsEnabled: boolean } | null> {
  let dao: PublicKey;
  try {
    dao = new PublicKey(daoAddress);
  } catch {
    return null; // not a Solana address (e.g. an EVM DAO) — unknown here.
  }
  try {
    // Read-only fetch: a throwaway signer is sufficient (same pattern as the
    // pre-sign validation path).
    const programs = programsForAgent(Keypair.generate(), getConnection());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const reg = await (programs.core.account as any).daoRegistry.fetch(dao);
    return { frozen: !!reg.frozen, agentsEnabled: !!reg.agentsEnabled };
  } catch {
    return null;
  }
}

/**
 * Transfer `needed` lamports from the ops wallet to `agentPubkey`.
 * Throws if the ops wallet lacks sufficient funds.
 */
async function topUpFromOpsWallet(
  agentPubkey: PublicKey,
  ops: Keypair,
  needed: number,
): Promise<string> {
  const conn = getConnection();
  const opsBalance = await conn.getBalance(ops.publicKey, 'confirmed');
  const reserve = 10_000; // fee buffer for the transfer tx itself
  if (opsBalance < needed + reserve) {
    throw new Error(
      `Ops wallet ${ops.publicKey.toBase58()} balance ${opsBalance} lamports is insufficient ` +
      `to cover ${needed} lamport top-up for ${agentPubkey.toBase58()}. ` +
      `Replenish the ops wallet from protocol fee revenue.`,
    );
  }
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  const ix = SystemProgram.transfer({ fromPubkey: ops.publicKey, toPubkey: agentPubkey, lamports: needed });
  const txMsg = new TransactionMessage({
    payerKey: ops.publicKey,
    recentBlockhash: blockhash,
    instructions: [ix],
  }).compileToV0Message();
  const vtx = new VersionedTransaction(txMsg);
  vtx.sign([ops]);
  const sig = await conn.sendTransaction(vtx, { skipPreflight: false });
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  return sig;
}

/**
 * Inline safety gate — only intervenes when a wallet is critically low
 * (< CRITICAL_MIN_LAMPORTS), meaning it can't even finish a handful of txs.
 * Full adaptive replenishment is handled proactively by the worker.
 */
async function ensureFundedFromOpsWallet(agentPubkey: PublicKey): Promise<void> {
  const conn = getConnection();
  const balance = await conn.getBalance(agentPubkey, 'confirmed');
  if (balance >= CRITICAL_MIN_LAMPORTS) return;

  const ops = loadOpsWallet();
  if (!ops) {
    throw new Error(
      `Agent wallet ${agentPubkey.toBase58()} has critically low balance (${balance} lamports) ` +
      `and NAVE_OPS_WALLET_SECRET is not configured. ` +
      `Set NAVE_OPS_WALLET_SECRET (funded from protocol fee revenue) to enable auto-replenishment.`,
    );
  }

  // In the critical path, top up to HARD_MIN_LAMPORTS (enough for ~50 txs).
  // The worker's next adaptive cycle will refill to the proper projected level.
  const needed = HARD_MIN_LAMPORTS - balance;
  console.warn(
    `[signer] Agent wallet ${agentPubkey.toBase58()} critically low (${balance} lamports) — ` +
    `emergency top-up of ${needed} lamports from ops wallet.`,
  );
  const sig = await topUpFromOpsWallet(agentPubkey, ops, needed);
  console.log(`[signer] Emergency top-up confirmed: ${sig}`);
}

/** SOL string for a lamport amount, for human-readable logs. */
function solStr(lamports: number): string {
  return (lamports / LAMPORTS_PER_SOL).toFixed(4);
}

/**
 * Agent wallet replenishment — called by the worker on a regular cadence.
 * Applies the 3-tier hysteresis model (see the constants block above) to each
 * agent in the DAO:
 *
 *   - balance < REQUEST (0.05): URGENT — agent is critically low, requests SOL
 *     (urgent log + `requestedUrgent`), and is refilled toward CEILING.
 *   - balance ≤ TRIGGER (0.10): resume trickling fees — refill toward CEILING.
 *   - TRIGGER < balance < CEILING (0.10–0.25): do nothing (hysteresis band).
 *   - balance ≥ CEILING (0.25): already full — do nothing.
 *
 * The fill target is always CEILING and the refill trigger is balance ≤ TRIGGER,
 * which is exactly the hysteresis the spec requires. Funded entirely from the
 * protocol ops/revenue wallet (the on-chain 8.5% yield-fee recipient).
 */
export async function replenishAgentWallets(
  daoAddress: string,
  effectiveAesKey?: string,
): Promise<AgentWalletResult[]> {
  const roles: AgentRole[] = ['executive', 'financial', 'oversight', 'operational'];
  const conn = getConnection();
  const ops = loadOpsWallet();
  const results: AgentWalletResult[] = [];

  for (const role of roles) {
    try {
      const kp = await loadAgentKeypair(daoAddress, role, effectiveAesKey);
      const balance = await conn.getBalance(kp.publicKey, 'confirmed');

      const requestedUrgent = balance < AGENT_REQUEST_THRESHOLD_LAMPORTS;
      // Refill trigger: refill when at/below TRIGGER (which includes the urgent
      // sub-band). Between TRIGGER and CEILING we deliberately do nothing.
      const needsRefill = balance <= AGENT_REFILL_TRIGGER_LAMPORTS;

      if (requestedUrgent) {
        console.warn(
          `[signer] URGENT replenish-needed: ${role}@${daoAddress} balance ${balance} lamports ` +
          `(${solStr(balance)} SOL) is below the REQUEST threshold of ` +
          `${AGENT_REQUEST_THRESHOLD_LAMPORTS} lamports (${solStr(AGENT_REQUEST_THRESHOLD_LAMPORTS)} SOL) — ` +
          `agent is critically low and is requesting SOL from the ops wallet.`,
        );
      }

      let toppedUp = false;
      let topUpLamports = 0;

      if (needsRefill && balance < AGENT_FILL_CEILING_LAMPORTS) {
        const needed = AGENT_FILL_CEILING_LAMPORTS - balance;
        if (ops) {
          try {
            const sig = await topUpFromOpsWallet(kp.publicKey, ops, needed);
            toppedUp = true;
            topUpLamports = needed;
            console.log(
              `[signer] Replenished ${role}@${daoAddress}: +${needed} lamports ` +
              `(balance ${solStr(balance)} → ${solStr(AGENT_FILL_CEILING_LAMPORTS)} SOL` +
              `${requestedUrgent ? ', URGENT' : ''}, sig ${sig})`,
            );
          } catch (topUpErr) {
            const msg = topUpErr instanceof Error ? topUpErr.message : String(topUpErr);
            console.error(
              `[signer] replenish ${role}@${daoAddress}${requestedUrgent ? ' (URGENT)' : ''}: ${msg}`,
            );
          }
        } else {
          console.warn(
            `[signer] ${role}@${daoAddress} balance ${balance} lamports ≤ refill trigger ` +
            `${AGENT_REFILL_TRIGGER_LAMPORTS} lamports but NAVE_OPS_WALLET_SECRET is not configured — ` +
            `cannot ${requestedUrgent ? 'URGENTLY ' : ''}refill.`,
          );
        }
      }

      const finalBalance = toppedUp ? await conn.getBalance(kp.publicKey, 'confirmed') : balance;
      results.push({ role, balance: finalBalance, toppedUp, topUpLamports, requestedUrgent });
    } catch (err) {
      console.error(`[signer] replenishAgentWallets ${role}@${daoAddress}:`, err instanceof Error ? err.message : err);
      results.push({ role, balance: -1, toppedUp: false, topUpLamports: 0, requestedUrgent: false });
    }
  }

  return results;
}

export interface ManagementFeeResult {
  mint: string;
  collected: boolean;
  signature?: string;
  /** Present when collection was skipped (usually "not yet due" — expected). */
  skippedReason?: string;
}

/**
 * Discrete annual management-fee collection for one DAO. Permissionless-but-
 * validated on-chain: the 0.65%/yr in-kind fee on each registered asset's idle
 * balance is due only once per SECONDS_PER_YEAR, anchored to a UTC-midnight
 * boundary per asset. The worker calls this on a regular cadence (default
 * hourly) so collection fires shortly after each asset's annual boundary.
 *
 * Iterates the DAO's registered mints (discovered from on-chain TreasuryAsset
 * accounts) and sends `collect_management_fee` per mint. When an asset is not
 * yet due (or the computed fee rounds to zero), the on-chain instruction errs
 * cleanly (NoManagementFeeDue / InsufficientFeeAsset) and we swallow it as a
 * graceful skip — mirroring the auto-finalize "not yet eligible" handling, so a
 * routine no-op tick is never treated as a failure.
 *
 * Each fee is paid in-kind to the protocol revenue wallet's ATA for the mint;
 * that ATA must already exist (provisioned by the revenue-wallet operator — see
 * RUNBOOKS). The ops wallet (NAVE_OPS_WALLET_SECRET) is the permissionless
 * fee_collector and pays the (tiny) tx fee.
 */
export async function collectManagementFees(daoAddress: string): Promise<ManagementFeeResult[]> {
  const ops = loadOpsWallet();
  if (!ops) return []; // no permissionless collector/payer configured → skip
  const conn = getConnection();
  const programs = programsForAgent(ops, conn);
  const dao = new PublicKey(daoAddress);
  const results: ManagementFeeResult[] = [];

  // Authoritative revenue-wallet destination is read once from FeeConfig.
  const feeConfigPda = pdas.feeConfig(dao);
  let protocolRevenueWallet: PublicKey;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fc = await (programs.core.account as any).feeConfig.fetch(feeConfigPda);
    protocolRevenueWallet = new PublicKey(fc.protocolRevenueWallet);
  } catch {
    return []; // fee_config missing/unreadable → nothing to collect
  }
  if (protocolRevenueWallet.equals(PublicKey.default)) return [];

  // Discover registered assets (one TreasuryAsset per mint). dao field sits at
  // offset 9 (8 disc + 1 bump).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let assets: any[] = [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assets = await (programs.core.account as any).treasuryAsset.all([
      { memcmp: { offset: 9, bytes: dao.toBase58() } },
    ]);
  } catch (err) {
    console.error(
      `[signer] collectManagementFees ${daoAddress}: asset discovery failed:`,
      err instanceof Error ? err.message : err,
    );
    return [];
  }

  for (const a of assets) {
    const mint = new PublicKey(a.account.mint);
    const revenueTokenAccount = getAssociatedTokenAddressSync(mint, protocolRevenueWallet, true);
    try {
      const sig = await programs.core.methods
        .collectManagementFee()
        .accountsPartial({
          feeCollector: ops.publicKey,
          globalConfig: pdas.globalConfig(),
          daoRegistry: dao,
          feeConfig: feeConfigPda,
          vaultAuthority: pdas.vaultAuthority(dao),
          mint,
          treasuryAsset: pdas.treasuryAsset(dao, mint),
          assetVault: pdas.assetVault(dao, mint),
          revenueTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
      results.push({ mint: mint.toBase58(), collected: true, signature: sig });
      console.log(`[signer] management fee collected ${daoAddress}/${mint.toBase58()}: ${sig}`);
    } catch (err) {
      // Expected most ticks: not due / zero fee / missing revenue ATA. Swallow.
      results.push({
        mint: mint.toBase58(),
        collected: false,
        skippedReason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}

/**
 * finalize_proposal — permissionless; tallies votes and marks proposal Passed/Failed.
 * Succeeds either (a) after voting_end, or (b) when the FOR lead exceeds all remaining
 * possible votes (early finalization — quorum met + lead > remaining eligibles).
 *
 * Uses the executive agent key as a convenience payer/signer — the instruction
 * itself has no authority check beyond the DAO being valid.
 */
async function handleFinalizeProposal(
  res: express.Response,
  body: SignRequest,
  dao: PublicKey,
  effectiveAesKey?: string,
): Promise<express.Response> {
  if (body.proposal_index == null || !Number.isInteger(body.proposal_index)) {
    return res.status(400).json({ error: 'finalize_proposal requires proposal_index (integer)' });
  }

  try {
    // Use executive agent as the permissionless payer/signer
    const agent = await loadAgentKeypair(dao.toBase58(), body.agent_role ?? 'executive', effectiveAesKey);
    await ensureFundedFromOpsWallet(agent.publicKey);
    const programs = programsForAgent(agent, getConnection());

    const guardianConfig = pdas.guardianConfig(dao);
    const [proposalPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from('proposal'),
        dao.toBuffer(),
        Buffer.from(new Uint8Array(new BigInt64Array([BigInt(body.proposal_index)]).buffer)),
      ],
      PROGRAM_IDS.governance,
    );

    const ix = await programs.governance.methods
      .finalizeProposal()
      .accountsPartial({
        authority: agent.publicKey,
        daoRegistry: dao,
        guardianConfig,
        proposal: proposalPda,
      })
      .instruction();

    const sig = await sendAgentV0(
      programs,
      agent,
      [ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }), ix],
    );

    console.log(`[signer] finalize_proposal #${body.proposal_index} for ${dao.toBase58()}: ${sig}`);
    return res.json({ success: true, signature: sig, agent: agent.publicKey.toBase58() });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'finalize_proposal failed';
    // Log but don't always treat as hard error — voting may still be open
    console.warn(`[signer] finalize_proposal attempt failed: ${msg}`);
    return res.status(500).json({ error: msg });
  }
}

// ── Jito Bundle support (via Helius RPC) ─────────────────────────────────────
//
// Bundles submit up to 5 signed transactions atomically — all land or none do.
// This prevents partial rebalancing failures (e.g. withdrew from Kamino but
// failed to deposit into Jito) and provides MEV protection on large moves.
//
// Submission goes through the Helius RPC endpoint (same URL as regular txs)
// using the non-standard `sendBundle` JSON-RPC method.

/** Jito tip accounts (8 mainnet; pick one at random to reduce contention). */
const JITO_TIP_ACCOUNTS_MAINNET = [
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1IfXoJ3UkHR',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HGKVAuBZtuBVCKBNqZvNvFGe6uJGkxLLMLtahBxLMuXe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1IfXoJ3UkHR',
];

/** Devnet tip accounts (use the same mainnet list — Jito devnet block engine accepts any). */
const JITO_TIP_ACCOUNTS_DEVNET = JITO_TIP_ACCOUNTS_MAINNET;

/** Default tip in lamports. Higher priority → higher tip. ~5000 = ~$0.001 at $200 SOL. */
const DEFAULT_JITO_TIP_LAMPORTS = Number(process.env.JITO_TIP_LAMPORTS ?? '5000');

/** Select a random Jito tip account to distribute contention. */
function randomTipAccount(isMainnet: boolean): PublicKey {
  const accounts = isMainnet ? JITO_TIP_ACCOUNTS_MAINNET : JITO_TIP_ACCOUNTS_DEVNET;
  return new PublicKey(accounts[Math.floor(Math.random() * accounts.length)]);
}

/**
 * Submit up to 5 signed VersionedTransactions as an atomic Jito bundle via the
 * Helius RPC endpoint. All transactions must already be signed.
 *
 * Returns the bundle_id (SHA-256 of tx signatures) or throws on submission error.
 * Use `getBundleStatuses(bundle_id)` to verify landing — bundles are not guaranteed
 * to land, similar to how regular transactions can expire.
 *
 * The LAST transaction in `txs` should include a SOL tip transfer to a Jito tip
 * account — call `buildTipInstruction()` and append it to that transaction's
 * pre-instructions before signing.
 */
async function sendJitoBundle(txs: VersionedTransaction[]): Promise<string> {
  const rpcUrl = resolveSolanaRpcUrl();
  const encoded = txs.map((tx) =>
    Buffer.from(tx.serialize()).toString('base64'),
  );

  const resp = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'sendBundle',
      params: [encoded, { encoding: 'base64' }],
    }),
  });

  const json = await resp.json() as { result?: string; error?: { message: string } };
  if (json.error || !json.result) {
    throw new Error(`Jito bundle rejected: ${json.error?.message ?? 'unknown error'}`);
  }
  return json.result; // bundle_id
}

/**
 * Poll getBundleStatuses until the bundle lands or expires (max 30 polls × 2s).
 * Returns 'landed', 'failed', or 'expired'.
 */
async function waitForBundle(
  bundleId: string,
  maxPolls = 30,
  pollMs = 2000,
): Promise<'landed' | 'failed' | 'expired'> {
  const rpcUrl = resolveSolanaRpcUrl();
  for (let i = 0; i < maxPolls; i++) {
    await new Promise((r) => setTimeout(r, pollMs));
    try {
      const resp = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getBundleStatuses',
          params: [[bundleId]],
        }),
      });
      const json = await resp.json() as {
        result?: { value?: Array<{ confirmation_status?: string; err?: unknown }> };
      };
      const status = json.result?.value?.[0];
      if (!status) continue;
      if (status.err) return 'failed';
      if (status.confirmation_status === 'confirmed' || status.confirmation_status === 'finalized') {
        return 'landed';
      }
    } catch { /* retry */ }
  }
  return 'expired';
}

/**
 * Build a SystemProgram.transfer tip instruction to a random Jito tip account.
 * Append this to the LAST transaction in the bundle.
 */
function buildTipInstruction(payer: PublicKey, lamports: number): TransactionInstruction {
  // M2: unify mainnet detection on isMainnetCluster (NAVE_CLUSTER first, RPC
  // sniff fallback) so a custom mainnet RPC without "mainnet" in the URL still
  // selects the mainnet Jito tip accounts.
  const isMainnet = isMainnetCluster();
  return SystemProgram.transfer({
    fromPubkey: payer,
    toPubkey: randomTipAccount(isMainnet),
    lamports,
  });
}

/**
 * Execute a list of protocol CPI operations as an atomic Jito bundle.
 * Each operation is built independently, signed by the Oversight agent (role operational),
 * and submitted together. A tip is appended to the last transaction.
 *
 * If the RPC endpoint doesn't support `sendBundle` (e.g. localnet), falls
 * back to submitting transactions individually in sequence.
 */
async function handleBundleRebalance(
  res: express.Response,
  body: SignRequest,
  dao: PublicKey,
  effectiveAesKey?: string,
): Promise<express.Response> {
  if (body.agent_role !== 'operational') {
    return res.status(400).json({ error: 'bundle_rebalance must be signed by the Oversight agent (agent_role "operational")' });
  }
  const ops = body.bundle_operations;
  if (!ops || ops.length === 0) {
    return res.status(400).json({ error: 'bundle_rebalance requires bundle_operations array' });
  }
  if (ops.length > 4) {
    return res.status(400).json({ error: 'bundle_rebalance supports at most 4 operations (1 slot reserved for tip)' });
  }

  try {
    const agent = await loadAgentKeypair(dao.toBase58(), 'operational', effectiveAesKey);
    await ensureFundedFromOpsWallet(agent.publicKey);
    const programs = programsForAgent(agent, getConnection());
    const conn = getConnection();

    // Build each operation into a VersionedTransaction
    const vtxs: VersionedTransaction[] = [];
    const tipLamports = body.jito_tip_lamports ?? DEFAULT_JITO_TIP_LAMPORTS;

    // H5: a Jito bundle must share ONE recent blockhash across every tx so the
    // bundle's transactions expire together (atomicity). Fetch it ONCE before
    // the build loop; fetching per-tx (the old behavior) gave each tx a slightly
    // different blockhash, weakening the all-or-none expiry guarantee.
    const { blockhash: bundleBlockhash } = await conn.getLatestBlockhash('confirmed');

    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      const isLast = i === ops.length - 1;
      const opBody: SignRequest = {
        ...body,
        action: op.action as SignAction,
        mint: op.mint,
        amount: op.amount,
        protocol_id: op.protocol_id,
        kamino: op.kamino,
        jito: op.jito,
        jupiter: op.jupiter,
        marginfi: op.marginfi,
        lookup_table_address: op.lookup_table_address,
      };

      // Resolve the instruction for this operation
      let ix: TransactionInstruction | null = null;
      const amount = typeof op.amount === 'string' ? Number(op.amount) : (op.amount ?? 0);

      if (op.action === 'execute_strategy') {
        if (!op.execution_request_address || !op.protocol_id) {
          return res.status(400).json({ error: `bundle op[${i}] execute_strategy requires execution_request_address + protocol_id` });
        }
        const check = await validateOnChainState(programs, {
          ...opBody,
          execution_request_address: op.execution_request_address,
        });
        if (!check.ok) {
          return res.status(409).json({ error: `bundle op[${i}] ${check.error}`, on_chain_status: check.status });
        }
        ix = await buildExecuteStrategyIx(
          programs, agent.publicKey, dao, new PublicKey(op.execution_request_address), op.protocol_id,
        );
      } else if (op.action === 'kamino_deposit' || op.action === 'kamino_withdraw') {
        let k = op.kamino;
        if (!k && op.mint) {
          const reserve = await boundVenueTarget(dao, 'kamino', new PublicKey(op.mint), 'extReserve');
          const info = reserve ? await conn.getAccountInfo(reserve) : null;
          if (reserve && info) k = kaminoAccountsFromReserve(reserve, info.data, EXTERNAL_PROGRAM_IDS.klend);
        }
        if (!k || !op.mint) { return res.status(400).json({ error: `bundle op[${i}] kamino requires kamino + mint` }); }
        const mint = new PublicKey(op.mint!);
        const positionTokenAccount = pdas.positionToken(dao, 'kamino', mint);
        const accounts = {
          authority: agent.publicKey,
          daoRegistry: dao,
          mint,
          positionTokenAccount,
          klendProgram: EXTERNAL_PROGRAM_IDS.klend,
          reserve: new PublicKey(k.reserve),
          lendingMarket: new PublicKey(k.lending_market),
          lendingMarketAuthority: new PublicKey(k.lending_market_authority),
          reserveLiquiditySupply: new PublicKey(k.reserve_liquidity_supply),
          reserveCollateralMint: new PublicKey(k.reserve_collateral_mint),
          tokenProgram: TOKEN_PROGRAM_ID,
        };
        const remaining = (k.oracles ?? []).map((o) => ({ pubkey: new PublicKey(o), isWritable: false, isSigner: false }));
        const method = op.action === 'kamino_deposit'
          ? programs.core.methods.kaminoDeposit(new BN(amount))
          : programs.core.methods.kaminoWithdraw(new BN(amount));
        ix = await method.accountsPartial(accounts).remainingAccounts(remaining).instruction();
      } else if (op.action === 'jito_deposit' || op.action === 'jito_withdraw') {
        let j = op.jito;
        if (!j && op.mint) {
          const pool = await boundVenueTarget(dao, 'jito', new PublicKey(op.mint), 'extMarket');
          const info = pool ? await conn.getAccountInfo(pool) : null;
          if (pool && info) j = jitoAccountsFromStakePool(pool, info.data, EXTERNAL_PROGRAM_IDS.splStakePool);
        }
        if (!j || !op.mint) { return res.status(400).json({ error: `bundle op[${i}] jito requires jito + mint` }); }
        const mint = new PublicKey(op.mint!);
        const positionTokenAccount = pdas.positionToken(dao, 'jito', mint);
        const baseAccounts = {
          authority: agent.publicKey,
          daoRegistry: dao,
          mint,
          positionTokenAccount,
          stakePoolProgram: EXTERNAL_PROGRAM_IDS.splStakePool,
          stakePool: new PublicKey(j.stake_pool),
          stakePoolWithdrawAuthority: new PublicKey(j.stake_pool_withdraw_authority),
          reserveStake: new PublicKey(j.reserve_stake),
          managerFeeAccount: new PublicKey(j.manager_fee_account),
          poolMint: new PublicKey(j.pool_mint),
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        };
        ix = op.action === 'jito_deposit'
          ? await programs.core.methods.jitoDeposit(new BN(amount)).accountsPartial(baseAccounts).instruction()
          : await programs.core.methods.jitoWithdraw(new BN(amount)).accountsPartial({ ...baseAccounts, stakeProgram: EXTERNAL_PROGRAM_IDS.stake }).instruction();
      } else if (op.action === 'jupiter_deposit' || op.action === 'jupiter_withdraw') {
        // Resolve Jupiter accounts via API if not provided
        const jupiterApiKey = process.env.JUPITER_API_KEY;
        if (!jupiterApiKey || !op.mint) { return res.status(400).json({ error: `bundle op[${i}] jupiter requires JUPITER_API_KEY + mint` }); }
        let j = op.jupiter;
        if (!j) {
          const endpoint = op.action === 'jupiter_deposit'
            ? 'https://api.jup.ag/lend/v1/earn/deposit-instructions'
            : 'https://api.jup.ag/lend/v1/earn/withdraw-instructions';
          const r = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': jupiterApiKey },
            body: JSON.stringify({ asset: op.mint, amount: String(amount), signer: dao.toBase58() }),
          });
          const ixResp = await r.json() as { instructions?: Array<{ accounts: Array<{ pubkey: string }> }> };
          const a = ixResp.instructions?.[0]?.accounts;
          if (!a || a.length < 14) { return res.status(400).json({ error: `bundle op[${i}] jupiter API returned unexpected response` }); }
          j = op.action === 'jupiter_deposit'
            ? { lending_admin: a[4].pubkey, lending: a[5].pubkey, f_token_mint: a[6].pubkey, supply_token_reserves_liquidity: a[7].pubkey, lending_supply_position_on_liquidity: a[8].pubkey, rate_model: a[9].pubkey, vault: a[10].pubkey, liquidity: a[11].pubkey, liquidity_program: a[12].pubkey, rewards_rate_model: a[13].pubkey }
            : { lending_admin: a[3].pubkey, lending: a[4].pubkey, f_token_mint: a[6].pubkey, supply_token_reserves_liquidity: a[7].pubkey, lending_supply_position_on_liquidity: a[8].pubkey, rate_model: a[9].pubkey, vault: a[10].pubkey, claim_account: a[11].pubkey, liquidity: a[12].pubkey, liquidity_program: a[13].pubkey, rewards_rate_model: a[14].pubkey };
        }
        const mint = new PublicKey(op.mint!);
        const baseAccounts = {
          authority: agent.publicKey, globalConfig: pdas.globalConfig(), daoRegistry: dao,
          agentSet: pdas.agentSet(dao), mint, fTokenMint: new PublicKey(j.f_token_mint),
          vaultAuthority: pdas.vaultAuthority(dao), strategyPosition: pdas.strategyPositionForMint(dao, 'jupiter', mint),
          jupiterLendingProgram: EXTERNAL_PROGRAM_IDS.jupiterLending,
          lendingAdmin: new PublicKey(j.lending_admin), lending: new PublicKey(j.lending),
          supplyTokenReservesLiquidity: new PublicKey(j.supply_token_reserves_liquidity),
          lendingSupplyPositionOnLiquidity: new PublicKey(j.lending_supply_position_on_liquidity),
          rateModel: new PublicKey(j.rate_model), vault: new PublicKey(j.vault),
          liquidity: new PublicKey(j.liquidity), liquidityProgram: new PublicKey(j.liquidity_program),
          rewardsRateModel: new PublicKey(j.rewards_rate_model),
          tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
        };
        ix = op.action === 'jupiter_deposit'
          ? await programs.core.methods.jupiterDeposit(new BN(amount)).accountsPartial(baseAccounts).instruction()
          : await programs.core.methods.jupiterWithdraw(new BN(amount)).accountsPartial({ ...baseAccounts, claimAccount: new PublicKey(j.claim_account!) }).instruction();
      } else if (op.action === 'marginfi_deposit' || op.action === 'marginfi_withdraw') {
        const mf = op.marginfi;
        if (!mf || !mf.marginfi_group || !mf.marginfi_account || !mf.bank || !op.mint) {
          return res.status(400).json({ error: `bundle op[${i}] marginfi requires marginfi { marginfi_group, marginfi_account, bank } + mint` });
        }
        const mint = new PublicKey(op.mint!);
        const bank = new PublicKey(mf.bank);
        const { vault, vaultAuthority } = marginfiBankVaults(bank);
        const bankLiquidityVault = mf.bank_liquidity_vault ? new PublicKey(mf.bank_liquidity_vault) : vault;
        const baseAccounts = {
          authority: agent.publicKey,
          daoRegistry: dao,
          mint,
          marginfiGroup: new PublicKey(mf.marginfi_group),
          marginfiAccount: new PublicKey(mf.marginfi_account),
          bank,
          marginfiProgram: EXTERNAL_PROGRAM_IDS.marginfi,
          tokenProgram: TOKEN_PROGRAM_ID,
        };
        if (op.action === 'marginfi_deposit') {
          ix = await programs.core.methods
            .marginfiDeposit(new BN(amount))
            .accountsPartial({ ...baseAccounts, bankLiquidityVault })
            .instruction();
        } else {
          const remaining = (mf.oracles ?? []).map((o) => ({ pubkey: new PublicKey(o), isWritable: false, isSigner: false }));
          const bankLiquidityVaultAuthority = mf.bank_liquidity_vault_authority
            ? new PublicKey(mf.bank_liquidity_vault_authority)
            : vaultAuthority;
          ix = await programs.core.methods
            .marginfiWithdraw(new BN(amount))
            .accountsPartial({ ...baseAccounts, bankLiquidityVaultAuthority, bankLiquidityVault })
            .remainingAccounts(remaining)
            .instruction();
        }
      } else {
        return res.status(400).json({ error: `bundle op[${i}] unsupported action: ${op.action}` });
      }

      // Build the transaction, adding compute budget + tip (on last tx)
      const preIxs: TransactionInstruction[] = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: PROTOCOL_CU_LIMIT }),
      ];
      if (isLast) preIxs.push(buildTipInstruction(agent.publicKey, tipLamports));

      const opIxs = [...preIxs, ix];
      const msg = new TransactionMessage({
        payerKey: agent.publicKey,
        recentBlockhash: bundleBlockhash,
        instructions: opIxs,
      }).compileToV0Message();

      // Same fail-closed protections as sendAgentV0 (M14): no ALT is used here
      // (compileToV0Message() above is called with no lookup tables), so this
      // is purely the writable-account allowlist + pre-submission simulation.
      const allow = writableAllowlist(agent, opIxs);
      const unexpectedWritable: string[] = [];
      for (let ai = 0; ai < msg.staticAccountKeys.length; ai++) {
        if (!msg.isAccountWritable(ai)) continue;
        const b58 = msg.staticAccountKeys[ai].toBase58();
        if (!allow.has(b58)) unexpectedWritable.push(b58);
      }
      if (unexpectedWritable.length > 0) {
        return res.status(500).json({
          error: `bundle op[${i}] refusing to submit: ${unexpectedWritable.length} unexpected writable account(s): ${unexpectedWritable.join(', ')}`,
        });
      }

      const vtx = new VersionedTransaction(msg);
      vtx.sign([agent]);

      const skipSim = skipSimulationRequested();
      if (!skipSim) {
        const sim = await conn.simulateTransaction(vtx, {
          sigVerify: false,
          replaceRecentBlockhash: true,
          commitment: 'confirmed',
        });
        if (sim.value.err) {
          const logs = (sim.value.logs ?? []).slice(-10).join('\n');
          return res.status(500).json({
            error: `bundle op[${i}] pre-submission simulation failed: ${JSON.stringify(sim.value.err)}\n${logs}`,
          });
        }
      }

      vtxs.push(vtx);
    }

    // Try Jito bundle submission; fall back to sequential on failure
    let bundleId: string | null = null;
    let fallbackSigs: string[] = [];
    // M2: unify mainnet detection on isMainnetCluster (NAVE_CLUSTER first, RPC
    // sniff fallback) so a custom mainnet RPC still uses real Jito bundles.
    const isDevOrLocal = !isMainnetCluster();

    if (!isDevOrLocal) {
      // Mainnet: submit as real Jito bundle
      try {
        bundleId = await sendJitoBundle(vtxs);
        const status = await waitForBundle(bundleId);
        if (status === 'failed') {
          return res.status(500).json({ error: `Jito bundle failed on-chain (bundle_id: ${bundleId})` });
        }
        console.log(`[signer] bundle_rebalance: bundle ${bundleId} ${status}`);
      } catch (bundleErr) {
        console.warn('[signer] bundle submission failed, falling back to sequential:', bundleErr instanceof Error ? bundleErr.message : bundleErr);
        bundleId = null;
      }
    }

    if (!bundleId) {
      // Devnet / localnet / fallback: submit sequentially
      const conn2 = getConnection();
      for (const vtx of vtxs) {
        const sig = await conn2.sendTransaction(vtx, { skipPreflight: false });
        const { blockhash: bh, lastValidBlockHeight: lvbh } = await conn2.getLatestBlockhash('confirmed');
        await conn2.confirmTransaction({ signature: sig, blockhash: bh, lastValidBlockHeight: lvbh }, 'confirmed');
        fallbackSigs.push(sig);
      }
    }

    return res.json({
      success: true,
      bundle_id: bundleId,
      signatures: fallbackSigs.length > 0 ? fallbackSigs : undefined,
      agent: agent.publicKey.toBase58(),
      operations: ops.length,
      atomic: !!bundleId,
    });
  } catch (err) {
    console.error('[signer] bundle_rebalance error:', err);
    return res.status(500).json({ error: err instanceof Error ? err.message : 'bundle_rebalance failed' });
  }
}

/**
 * Flip the on-chain `agents_enabled` flag (nave_core::toggle_agents). This is
 * the real operational kill switch the UI maps to — there is no local-only
 * pause. The on-chain authority is the Executive agent key, so we load it and
 * sign with it. Disabling agents on-chain stops the execution pipeline at the
 * program level (defense-in-depth with stopping the worker).
 */
async function handleToggleAgents(
  res: express.Response,
  body: SignRequest,
  dao: PublicKey,
  effectiveAesKey?: string,
): Promise<express.Response> {
  if (typeof body.enabled !== 'boolean') {
    return res.status(400).json({ error: 'toggle_agents requires a boolean "enabled"' });
  }
  // toggle_agents is gated on-chain to the Executive authority; reject any other
  // claimed role early so the request is unambiguous.
  if (body.agent_role !== 'executive') {
    return res.status(400).json({ error: 'toggle_agents must be signed by the executive agent' });
  }

  try {
    const executive = await loadAgentKeypair(dao.toBase58(), 'executive', effectiveAesKey);

    // Ensure the executive keypair has enough SOL to pay transaction fees.
    // If below threshold, tops up from the protocol ops wallet (funded by
    // Nave's 8.5% yield fee revenue). No airdrop — production-safe.
    await ensureFundedFromOpsWallet(executive.publicKey);

    const programs = programsForAgent(executive, getConnection());

    const signature = await programs.core.methods
      .toggleAgents(body.enabled)
      .accountsPartial({
        authority: executive.publicKey,
        globalConfig: pdas.globalConfig(),
        daoRegistry: dao,
        agentSet: pdas.agentSet(dao),
      })
      .rpc();

    return res.json({
      success: true,
      signature,
      agents_enabled: body.enabled,
      agent: executive.publicKey.toBase58(),
    });
  } catch (err) {
    console.error('[signer] toggle_agents error:', err);
    return res.status(500).json({ error: err instanceof Error ? err.message : 'toggle_agents failed' });
  }
}

/**
 * Send a set of instructions as a v0 (versioned) transaction signed by the
 * agent. A LUT is used when supplied so the larger Kamino/Jito CPIs (refresh +
 * deposit/withdraw + many external accounts) fit within the 1232-byte tx limit.
 */
/**
 * Build the per-call writable-account allowlist from the instructions the signer
 * itself constructed: the fee payer plus every account an instruction explicitly
 * marks writable. The compiled v0 message's writable set (after ALT resolution)
 * MUST be a subset of this. Anything writable that is NOT here was introduced by
 * the address lookup table or an unexpected account meta — a fund-loss vector
 * the plan calls out ("ALT with an unexpected writable").
 */
function writableAllowlist(agent: Keypair, ixs: TransactionInstruction[]): Set<string> {
  const allow = new Set<string>([agent.publicKey.toBase58()]);
  for (const ix of ixs) {
    for (const k of ix.keys) {
      if (k.isWritable) allow.add(k.pubkey.toBase58());
    }
  }
  return allow;
}

async function sendAgentV0(
  programs: AgentPrograms,
  agent: Keypair,
  ixs: TransactionInstruction[],
  lookupTableAddress?: string,
): Promise<string> {
  const conn = programs.connection;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const luts: any[] = [];
  if (lookupTableAddress) {
    const fetched = await conn.getAddressLookupTable(new PublicKey(lookupTableAddress));
    // ALT resolution verification: the table must exist and actually contain
    // resolvable addresses, otherwise compilation would silently mis-map keys.
    if (!fetched.value) {
      throw new Error(`Address lookup table not found: ${lookupTableAddress}`);
    }
    if (!Array.isArray(fetched.value.state.addresses) || fetched.value.state.addresses.length === 0) {
      throw new Error(`Address lookup table ${lookupTableAddress} resolved with no addresses`);
    }
    luts.push(fetched.value);
  }
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  const msg = new TransactionMessage({
    payerKey: agent.publicKey,
    recentBlockhash: blockhash,
    instructions: ixs,
  }).compileToV0Message(luts);

  // ── Writable-account allowlist (post-ALT-resolution) ──────────────────────
  // Resolve EVERY account key the message touches (static + looked-up) and
  // assert no WRITABLE key falls outside the allowlist derived from the signer's
  // own instructions. This catches an ALT (or stray account meta) that would
  // make an unintended account writable before any funds move.
  const allow = writableAllowlist(agent, ixs);
  const keys = msg.getAccountKeys({ addressLookupTableAccounts: luts });
  const unexpectedWritable: string[] = [];
  for (let i = 0; i < keys.length; i++) {
    if (!msg.isAccountWritable(i)) continue;
    const pk = keys.get(i);
    if (!pk) continue;
    const b58 = pk.toBase58();
    if (!allow.has(b58)) unexpectedWritable.push(b58);
  }
  if (unexpectedWritable.length > 0) {
    throw new Error(
      `Refusing to submit: ${unexpectedWritable.length} unexpected writable account(s) in compiled tx (possible ALT injection): ${unexpectedWritable.join(', ')}`,
    );
  }

  const tx = new VersionedTransaction(msg);
  tx.sign([agent]);

  // ── Pre-submission simulation (fail-closed) ───────────────────────────────
  // Simulate the fully-signed tx before broadcasting. A failing simulation means
  // the on-chain program would reject (or the accounts are wrong); abort rather
  // than spend fees and risk a partial/incorrect fund move. Opt-out only for
  // controlled non-mainnet runs via NAVE_SIGNER_SKIP_SIMULATION=true.
  const skipSim = skipSimulationRequested();
  if (!skipSim) {
    const sim = await conn.simulateTransaction(tx, {
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: 'confirmed',
    });
    if (sim.value.err) {
      const logs = (sim.value.logs ?? []).slice(-10).join('\n');
      throw new Error(`Pre-submission simulation failed: ${JSON.stringify(sim.value.err)}\n${logs}`);
    }
  }

  const sig = await conn.sendTransaction(tx, { skipPreflight: false, preflightCommitment: 'confirmed' });
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  return sig;
}

/** A generous CU ceiling for the multi-CPI protocol transactions. */
const PROTOCOL_CU_LIMIT = 600_000;

/** Jupiter Lend `Lending` account: f_token_mint at byte offset 40. */
const JUPITER_LENDING_FTOKEN_MINT_OFFSET = 40;

/**
 * Accounts `update_strategy_position_value` reads the mark from: the venue
 * state (klend reserve / Jupiter lending / SPL stake pool) recorded on the
 * StrategyPosition and the vault-owned receipt token account.
 */
async function resolvePositionMarkSources(
  dao: PublicKey,
  protocolId: string,
  mint: PublicKey,
): Promise<{ venueState: PublicKey; receiptTokenAccount: PublicKey } | { error: string }> {
  const readPrograms = programsForAgent(Keypair.generate(), getConnection());
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sp: any = await (readPrograms.core.account as any).strategyPosition
    .fetch(pdas.strategyPosition(dao, protocolId, mint))
    .catch(() => null);
  if (!sp) return { error: `no strategy position for ${protocolId}/${mint.toBase58()}` };
  if (sp.extMarket.equals(PublicKey.default) && sp.extReserve.equals(PublicKey.default)) {
    // Unbound position: the program values it from escrow alone.
    const escrow = pdas.strategyEscrow(dao, protocolId, mint);
    return { venueState: escrow, receiptTokenAccount: escrow };
  }
  if (protocolId === 'kamino') {
    return { venueState: sp.extReserve, receiptTokenAccount: sp.positionTokenAccount };
  }
  if (protocolId === 'jito') {
    return { venueState: sp.extMarket, receiptTokenAccount: sp.positionTokenAccount };
  }
  if (protocolId === 'jupiter') {
    const lending = await getConnection().getAccountInfo(sp.extMarket);
    if (!lending || lending.data.length < JUPITER_LENDING_FTOKEN_MINT_OFFSET + 32) {
      return { error: 'jupiter lending account not found for position' };
    }
    const fTokenMint = new PublicKey(
      lending.data.subarray(JUPITER_LENDING_FTOKEN_MINT_OFFSET, JUPITER_LENDING_FTOKEN_MINT_OFFSET + 32),
    );
    return {
      venueState: sp.extMarket,
      receiptTokenAccount: getAssociatedTokenAddressSync(fTokenMint, pdas.vaultAuthority(dao), true),
    };
  }
  return { error: `on-chain marks are not supported for protocol ${protocolId}` };
}

/** The DAO's StrategyPosition accounts that hold principal (dao at offset 9). */
async function principalPositions(programs: AgentPrograms, dao: PublicKey): Promise<PublicKey[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows: any[] = await (programs.core.account as any).strategyPosition.all([
    { memcmp: { offset: 9, bytes: dao.toBase58() } },
  ]);
  return rows
    .filter((r) => BigInt(r.account.depositedAmount?.toString?.() ?? '0') > 0n)
    .map((r) => r.publicKey as PublicKey);
}

/**
 * Revalue the treasury's USD NAV from every registered asset. Caller supplies
 * the asset list (mints + posted Pyth update for non-stables); the program
 * recomputes NAV/deployed in micro-USD and reseeds the high-water-mark. Each
 * asset contributes a 4-account remaining-accounts group:
 *   [assetConfig, treasuryAsset, assetVault, priceUpdate],
 * followed by the StrategyPosition accounts that hold principal.
 */
async function handleRevalueTreasury(
  res: express.Response,
  body: SignRequest,
  dao: PublicKey,
  effectiveAesKey?: string,
): Promise<express.Response> {
  if (body.agent_role !== 'operational') {
    return res.status(400).json({ error: 'revalue_treasury must be signed by the Oversight agent (agent_role "operational")' });
  }
  if (!Array.isArray(body.assets) || body.assets.length === 0) {
    return res.status(400).json({ error: 'revalue_treasury requires a non-empty assets[]' });
  }

  try {
    const agent = await loadAgentKeypair(dao.toBase58(), 'operational', effectiveAesKey);
    const programs = programsForAgent(agent, getConnection());

    // Resolve each asset's on-chain AssetConfig to learn its Pyth feed id +
    // stablecoin flag. Non-stable assets without an explicitly-supplied price
    // account get a FRESH persistent Pyth update posted by the signer (the
    // Oversight agent (role operational) pays the small crank fee). This makes revalue a single
    // self-contained call: callers no longer have to pre-post prices.
    type Resolved = { mint: PublicKey; feedHex: string | null; explicit: PublicKey | null };
    const resolved: Resolved[] = [];
    for (const a of body.assets) {
      const mint = new PublicKey(a.mint);
      const explicit = a.price_update_address ? new PublicKey(a.price_update_address) : null;
      let feedHex: string | null = null;
      if (!explicit) {
        const cfg = await (programs.core.account as Record<string, { fetch: (k: PublicKey) => Promise<{ pythFeedId: number[]; isStablecoin: boolean }> }>)
          .assetConfig.fetch(pdas.assetConfig(dao, mint));
        if (!cfg.isStablecoin && !isZeroFeed(cfg.pythFeedId)) {
          feedHex = feedBytesToHex(cfg.pythFeedId);
        }
      }
      resolved.push({ mint, feedHex, explicit });
    }

    const feedsToPost = Array.from(
      new Set(resolved.filter((r) => r.feedHex).map((r) => r.feedHex as string)),
    );
    const posted = feedsToPost.length
      ? await postPriceFeeds(programs.connection, agent, feedsToPost)
      : new Map<string, PublicKey>();

    const remaining = resolved.flatMap((r) => {
      const assetVault = pdas.assetVault(dao, r.mint);
      // Priority: explicit caller-supplied account > freshly-posted feed account
      // > assetVault placeholder (stablecoins ignore the 4th slot on-chain).
      let priceUpdate = assetVault;
      if (r.explicit) priceUpdate = r.explicit;
      else if (r.feedHex && posted.has(r.feedHex)) priceUpdate = posted.get(r.feedHex) as PublicKey;
      return [
        { pubkey: pdas.assetConfig(dao, r.mint), isWritable: false, isSigner: false },
        { pubkey: pdas.treasuryAsset(dao, r.mint), isWritable: true, isSigner: false },
        { pubkey: assetVault, isWritable: false, isSigner: false },
        { pubkey: priceUpdate, isWritable: false, isSigner: false },
      ];
    });
    // NAV counts each asset's marked position value; the program requires every
    // position that holds principal to be supplied after the asset groups.
    for (const pubkey of await principalPositions(programs, dao)) {
      remaining.push({ pubkey, isWritable: false, isSigner: false });
    }

    const ix = await programs.core.methods
      .revalueTreasury()
      .accountsPartial({
        authority: agent.publicKey,
        globalConfig: pdas.globalConfig(),
        daoRegistry: dao,
        treasuryVault: pdas.treasuryVault(dao),
      })
      .remainingAccounts(remaining)
      .instruction();

    const sig = await sendAgentV0(
      programs,
      agent,
      [ComputeBudgetProgram.setComputeUnitLimit({ units: PROTOCOL_CU_LIMIT }), ix],
      body.lookup_table_address,
    );
    return res.json({
      success: true,
      signature: sig,
      agent: agent.publicKey.toBase58(),
      posted_feeds: Object.fromEntries(Array.from(posted.entries()).map(([f, k]) => [f, k.toBase58()])),
    });
  } catch (err) {
    console.error('[signer] revalue_treasury error:', err);
    return res.status(500).json({ error: err instanceof Error ? err.message : 'revalue_treasury failed' });
  }
}

/**
 * Deploy/redeem a registered asset to/from a real Kamino (klend) reserve via the
 * nave_core CPI. The agent only ever moves escrowed funds into the reserve the
 * founder bound via `configure_position_targets`; the external accounts here are
 * the klend market/reserve coordinates (provided by the orchestrator from the
 * approved market config).
 */
const U64_MAX = new BN('18446744073709551615');

/**
 * Venue CPI amount. `amount: "max"` on a deposit places the whole strategy
 * escrow; on a withdraw it recalls the whole position into the escrow: the
 * receipt-token balance for Kamino (cTokens) and Jito (pool tokens),
 * u64::MAX for Jupiter Lend.
 */
async function venueAmount(body: SignRequest, dao: PublicKey, protocol: 'kamino' | 'jito' | 'jupiter'): Promise<BN | string> {
  if (body.amount === 'max') {
    const mint = new PublicKey(body.mint!);
    const deposit = body.action.endsWith('_deposit');
    if (!deposit && protocol === 'jupiter') return U64_MAX;
    const account = deposit
      ? pdas.strategyEscrowForMint(dao, protocol, mint)
      : pdas.positionToken(dao, protocol, mint);
    const bal = await getConnection().getTokenAccountBalance(account).catch(() => null);
    const units = new BN(bal?.value.amount ?? '0');
    return units.isZero() ? `${body.action}: nothing to move for ${protocol}` : units;
  }
  const amount = typeof body.amount === 'string' ? Number(body.amount) : body.amount;
  if (!Number.isFinite(amount as number) || (amount as number) <= 0 || !Number.isInteger(amount as number)) {
    return `${body.action} requires a positive integer amount (base units)`;
  }
  return new BN(amount as number);
}

async function handleKaminoCpi(
  res: express.Response,
  body: SignRequest,
  dao: PublicKey,
  effectiveAesKey?: string,
): Promise<express.Response> {
  if (body.agent_role !== 'operational') {
    return res.status(400).json({ error: `${body.action} must be signed by the Oversight agent (agent_role "operational")` });
  }
  if (!body.mint) return res.status(400).json({ error: `${body.action} requires mint` });
  let k = body.kamino;
  if (!k) {
    // Resolve from the reserve the founder bound to this position.
    try {
      const reserve = await boundVenueTarget(dao, 'kamino', new PublicKey(body.mint), 'extReserve');
      const info = reserve ? await getConnection().getAccountInfo(reserve) : null;
      if (reserve && info) k = kaminoAccountsFromReserve(reserve, info.data, EXTERNAL_PROGRAM_IDS.klend);
    } catch (err) {
      return res.status(400).json({ error: `${body.action}: could not resolve the bound reserve: ${err instanceof Error ? err.message : err}` });
    }
  }
  if (!k || !k.reserve || !k.lending_market || !k.lending_market_authority
    || !k.reserve_liquidity_supply || !k.reserve_collateral_mint) {
    return res.status(400).json({
      error: `${body.action} requires kamino { reserve, lending_market, lending_market_authority, reserve_liquidity_supply, reserve_collateral_mint }`,
    });
  }
  const amountOrError = await venueAmount(body, dao, 'kamino');
  if (typeof amountOrError === 'string') return res.status(400).json({ error: amountOrError });
  const amountBn = amountOrError;

  try {
    const agent = await loadAgentKeypair(dao.toBase58(), 'operational', effectiveAesKey);
    const programs = programsForAgent(agent, getConnection());
    const mint = new PublicKey(body.mint);
    const positionTokenAccount = pdas.positionToken(dao, 'kamino', mint);

    const accounts = {
      authority: agent.publicKey,
      daoRegistry: dao,
      mint,
      positionTokenAccount,
      klendProgram: EXTERNAL_PROGRAM_IDS.klend,
      reserve: new PublicKey(k.reserve),
      lendingMarket: new PublicKey(k.lending_market),
      lendingMarketAuthority: new PublicKey(k.lending_market_authority),
      reserveLiquiditySupply: new PublicKey(k.reserve_liquidity_supply),
      reserveCollateralMint: new PublicKey(k.reserve_collateral_mint),
      tokenProgram: TOKEN_PROGRAM_ID,
    };
    // refresh_reserve oracle slots are passed as remaining accounts (read-only).
    const remaining = (k.oracles ?? []).map((o) => ({
      pubkey: new PublicKey(o),
      isWritable: false,
      isSigner: false,
    }));

    const method = body.action === 'kamino_deposit'
      ? programs.core.methods.kaminoDeposit(amountBn)
      : programs.core.methods.kaminoWithdraw(amountBn);

    const ix = await method.accountsPartial(accounts).remainingAccounts(remaining).instruction();
    const sig = await sendAgentV0(
      programs,
      agent,
      [ComputeBudgetProgram.setComputeUnitLimit({ units: PROTOCOL_CU_LIMIT }), ix],
      body.lookup_table_address,
    );
    return res.json({ success: true, signature: sig, agent: agent.publicKey.toBase58() });
  } catch (err) {
    console.error(`[signer] ${body.action} error:`, err);
    return res.status(500).json({ error: err instanceof Error ? err.message : `${body.action} failed` });
  }
}

/** The venue target (ext_market / ext_reserve) the DAO's founder bound to a position. */
/** `nave_execution::execute_strategy` for a request; the asset mint is read from the request. */
async function buildExecuteStrategyIx(
  programs: AgentPrograms,
  executor: PublicKey,
  dao: PublicKey,
  executionRequest: PublicKey,
  protocolId: string,
  priceUpdateAddress?: string,
): Promise<TransactionInstruction> {
  const adapter = adapterProgramId(protocolId);
  if (!adapter) throw new Error(`Unknown protocol_id: ${protocolId}`);
  const erAcc = await fetchExecutionRequestTolerant(programs, executionRequest);
  const assetMint = new PublicKey(erAcc.mint);
  const vaultTokenAccount = pdas.assetVault(dao, assetMint);
  const escrowPdaEnabled = (process.env.NAVE_ESCROW_PDA_ENABLED ?? 'true').toLowerCase() === 'true';
  return programs.execution.methods
    .executeStrategy()
    .accountsPartial({
      executor,
      globalConfig: pdas.globalConfig(),
      daoRegistry: dao,
      daoLifecycle: pdas.daoLifecycle(dao),
      constitution: pdas.constitution(dao),
      vaultAuthority: pdas.vaultAuthority(dao),
      treasuryVault: pdas.treasuryVault(dao),
      mint: assetMint,
      assetConfig: pdas.assetConfig(dao, assetMint),
      treasuryAsset: pdas.treasuryAsset(dao, assetMint),
      // Stablecoins are valued at parity and ignore this account.
      priceUpdate: priceUpdateAddress ? new PublicKey(priceUpdateAddress) : assetMint,
      vaultTokenAccount,
      executionAuthority: pdas.executionAuthority(dao),
      adapterProgram: adapter,
      executionRequest,
      strategyEscrow: escrowPdaEnabled
        ? pdas.strategyEscrowForMint(dao, protocolId, assetMint)
        : vaultTokenAccount,
      strategyPosition: pdas.strategyPositionForMint(dao, protocolId, assetMint),
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      naveCoreProgram: PROGRAM_IDS.core,
    })
    .instruction();
}

async function boundVenueTarget(
  dao: PublicKey,
  protocolId: string,
  mint: PublicKey,
  field: 'extMarket' | 'extReserve',
): Promise<PublicKey | null> {
  const programs = programsForAgent(Keypair.generate(), getConnection());
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pos = await (programs.core.account as any).strategyPosition
    .fetchNullable(pdas.strategyPositionForMint(dao, protocolId, mint));
  const key = pos ? new PublicKey(pos[field]) : null;
  return key && !key.equals(PublicKey.default) ? key : null;
}

/**
 * Derive MarginFi v2's deterministic per-bank liquidity-vault PDAs
 * (`["liquidity_vault", bank]` / `["liquidity_vault_auth", bank]` under the
 * MarginFi program) — confirmed against the sibling contracts repo's live
 * devnet verification (`tests/marginfi-cpi-devnet.ts`). Callers only need to
 * know `bank`; these two accounts never need to be supplied explicitly.
 */
function marginfiBankVaults(bank: PublicKey): { vault: PublicKey; vaultAuthority: PublicKey } {
  const vault = PublicKey.findProgramAddressSync(
    [Buffer.from('liquidity_vault'), bank.toBuffer()],
    EXTERNAL_PROGRAM_IDS.marginfi,
  )[0];
  const vaultAuthority = PublicKey.findProgramAddressSync(
    [Buffer.from('liquidity_vault_auth'), bank.toBuffer()],
    EXTERNAL_PROGRAM_IDS.marginfi,
  )[0];
  return { vault, vaultAuthority };
}

/**
 * Deploy/redeem a registered asset to/from a real MarginFi v2 bank via the
 * nave_core CPI. Mirrors `handleKaminoCpi` exactly (same escrow → external
 * lending market shape); the differences are MarginFi-specific:
 *   - `marginfi_account` is a persistent, non-PDA ledger provisioned once by
 *     the founder-signed `configure_marginfi_position` (client-side; see
 *     `buildConfigureMarginfiPosition` in transactionBuilders.ts) — never
 *     created here.
 *   - `bank_liquidity_vault[_authority]` are derived from `bank` via
 *     {marginfiBankVaults} rather than requiring the caller to know them.
 *   - `marginfi_withdraw` requires MarginFi's post-withdrawal health-check
 *     remaining accounts `[bank, oracle(s)...]`; the caller supplies them via
 *     `body.marginfi.oracles` (see the field doc on `SignRequest.marginfi`).
 */
async function handleMarginfiCpi(
  res: express.Response,
  body: SignRequest,
  dao: PublicKey,
  effectiveAesKey?: string,
): Promise<express.Response> {
  if (body.agent_role !== 'operational') {
    return res.status(400).json({ error: `${body.action} must be signed by the Oversight agent (agent_role "operational")` });
  }
  if (!body.mint) return res.status(400).json({ error: `${body.action} requires mint` });
  const m = body.marginfi;
  if (!m || !m.marginfi_group || !m.marginfi_account || !m.bank) {
    return res.status(400).json({
      error: `${body.action} requires marginfi { marginfi_group, marginfi_account, bank }`,
    });
  }
  const amount = typeof body.amount === 'string' ? Number(body.amount) : body.amount;
  if (!Number.isFinite(amount as number) || (amount as number) <= 0 || !Number.isInteger(amount as number)) {
    return res.status(400).json({ error: `${body.action} requires a positive integer amount (base units)` });
  }

  try {
    const agent = await loadAgentKeypair(dao.toBase58(), 'operational', effectiveAesKey);
    const programs = programsForAgent(agent, getConnection());
    const mint = new PublicKey(body.mint);
    const bank = new PublicKey(m.bank);
    const { vault, vaultAuthority } = marginfiBankVaults(bank);
    const bankLiquidityVault = m.bank_liquidity_vault ? new PublicKey(m.bank_liquidity_vault) : vault;

    const baseAccounts = {
      authority: agent.publicKey,
      daoRegistry: dao,
      mint,
      marginfiGroup: new PublicKey(m.marginfi_group),
      marginfiAccount: new PublicKey(m.marginfi_account),
      bank,
      marginfiProgram: EXTERNAL_PROGRAM_IDS.marginfi,
      tokenProgram: TOKEN_PROGRAM_ID,
    };

    let ix: TransactionInstruction;
    if (body.action === 'marginfi_deposit') {
      ix = await programs.core.methods
        .marginfiDeposit(new BN(amount as number))
        .accountsPartial({ ...baseAccounts, bankLiquidityVault })
        .instruction();
    } else {
      // Health-check remaining accounts: [bank, oracle(s)...] per the deployed
      // devnet program's requirement (see SignRequest.marginfi doc).
      const remaining = (m.oracles ?? []).map((o) => ({
        pubkey: new PublicKey(o),
        isWritable: false,
        isSigner: false,
      }));
      const bankLiquidityVaultAuthority = m.bank_liquidity_vault_authority
        ? new PublicKey(m.bank_liquidity_vault_authority)
        : vaultAuthority;
      ix = await programs.core.methods
        .marginfiWithdraw(new BN(amount as number))
        .accountsPartial({ ...baseAccounts, bankLiquidityVaultAuthority, bankLiquidityVault })
        .remainingAccounts(remaining)
        .instruction();
    }

    const sig = await sendAgentV0(
      programs,
      agent,
      [ComputeBudgetProgram.setComputeUnitLimit({ units: PROTOCOL_CU_LIMIT }), ix],
      body.lookup_table_address,
    );
    return res.json({ success: true, signature: sig, agent: agent.publicKey.toBase58() });
  } catch (err) {
    console.error(`[signer] ${body.action} error:`, err);
    return res.status(500).json({ error: err instanceof Error ? err.message : `${body.action} failed` });
  }
}

/**
 * Deploy/redeem wSOL to/from a real SPL stake pool (Jito) via the nave_core CPI.
 * jito_deposit unwraps escrowed wSOL → native SOL funding PDA → DepositSol;
 * jito_withdraw does WithdrawSol → re-wrap into the wSOL escrow.
 */
async function handleJitoCpi(
  res: express.Response,
  body: SignRequest,
  dao: PublicKey,
  effectiveAesKey?: string,
): Promise<express.Response> {
  if (body.agent_role !== 'operational') {
    return res.status(400).json({ error: `${body.action} must be signed by the Oversight agent (agent_role "operational")` });
  }
  if (!body.mint) return res.status(400).json({ error: `${body.action} requires mint (wSOL)` });
  let j = body.jito;
  if (!j) {
    // Resolve from the stake pool the founder bound to this position.
    try {
      const pool = await boundVenueTarget(dao, 'jito', new PublicKey(body.mint), 'extMarket');
      const info = pool ? await getConnection().getAccountInfo(pool) : null;
      if (pool && info) j = jitoAccountsFromStakePool(pool, info.data, EXTERNAL_PROGRAM_IDS.splStakePool);
    } catch (err) {
      return res.status(400).json({ error: `${body.action}: could not resolve the bound stake pool: ${err instanceof Error ? err.message : err}` });
    }
  }
  if (!j || !j.stake_pool || !j.stake_pool_withdraw_authority || !j.reserve_stake
    || !j.manager_fee_account || !j.pool_mint) {
    return res.status(400).json({
      error: `${body.action} requires jito { stake_pool, stake_pool_withdraw_authority, reserve_stake, manager_fee_account, pool_mint }`,
    });
  }
  const amountOrError = await venueAmount(body, dao, 'jito');
  if (typeof amountOrError === 'string') return res.status(400).json({ error: amountOrError });
  const amountBn = amountOrError;

  try {
    const agent = await loadAgentKeypair(dao.toBase58(), 'operational', effectiveAesKey);
    const programs = programsForAgent(agent, getConnection());
    const mint = new PublicKey(body.mint);
    const positionTokenAccount = pdas.positionToken(dao, 'jito', mint);

    const baseAccounts = {
      authority: agent.publicKey,
      daoRegistry: dao,
      mint,
      positionTokenAccount,
      stakePoolProgram: EXTERNAL_PROGRAM_IDS.splStakePool,
      stakePool: new PublicKey(j.stake_pool),
      stakePoolWithdrawAuthority: new PublicKey(j.stake_pool_withdraw_authority),
      reserveStake: new PublicKey(j.reserve_stake),
      managerFeeAccount: new PublicKey(j.manager_fee_account),
      poolMint: new PublicKey(j.pool_mint),
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    };

    let ix: TransactionInstruction;
    if (body.action === 'jito_deposit') {
      ix = await programs.core.methods
        .jitoDeposit(amountBn)
        .accountsPartial(baseAccounts)
        .instruction();
    } else {
      ix = await programs.core.methods
        .jitoWithdraw(amountBn)
        .accountsPartial({
          ...baseAccounts,
          stakeProgram: EXTERNAL_PROGRAM_IDS.stake,
        })
        .instruction();
    }

    const sig = await sendAgentV0(
      programs,
      agent,
      [ComputeBudgetProgram.setComputeUnitLimit({ units: PROTOCOL_CU_LIMIT }), ix],
      body.lookup_table_address,
    );
    return res.json({ success: true, signature: sig, agent: agent.publicKey.toBase58() });
  } catch (err) {
    console.error(`[signer] ${body.action} error:`, err);
    return res.status(500).json({ error: err instanceof Error ? err.message : `${body.action} failed` });
  }
}

/**
 * Jupiter Lend (Earn) deposit / withdraw via nave_core::jupiter_deposit /
 * jupiter_withdraw (Oversight agent, role operational). Jupiter has no Nave adapter:
 * execute_strategy moves the request's funds into the strategy escrow and
 * jupiter_deposit places them from there. The vault_authority PDA is the
 * Jupiter `signer`; it signs via invoke_signed.
 *
 * Account resolution strategy:
 *   1. If the caller supplies `body.jupiter` accounts (pre-resolved), use them directly.
 *   2. Otherwise call the Jupiter Earn /deposit-instructions (or /withdraw-instructions)
 *      endpoint with JUPITER_API_KEY to fetch the instruction and extract accounts from it.
 *      This avoids requiring callers to derive Jupiter PDAs themselves.
 */
async function handleJupiterCpi(
  res: express.Response,
  body: SignRequest,
  dao: PublicKey,
  effectiveAesKey?: string,
): Promise<express.Response> {
  if (body.agent_role !== 'operational') {
    return res.status(400).json({ error: `${body.action} must be signed by the Oversight agent (agent_role "operational")` });
  }
  if (!body.mint) return res.status(400).json({ error: `${body.action} requires mint` });

  const amountOrError = await venueAmount(body, dao, 'jupiter');
  if (typeof amountOrError === 'string') return res.status(400).json({ error: amountOrError });
  const amountBn = amountOrError;

  // ── Resolve Jupiter account context ────────────────────────────────────────
  let j = body.jupiter;
  if (!j) {
    // Auto-resolve via Jupiter Earn instructions endpoint.
    const apiKey = process.env.JUPITER_API_KEY;
    if (!apiKey) {
      return res.status(400).json({
        error: `${body.action}: no jupiter accounts supplied and JUPITER_API_KEY is not set. ` +
               'Either provide body.jupiter accounts or configure JUPITER_API_KEY.',
      });
    }
    const endpoint = body.action === 'jupiter_deposit'
      ? 'https://api.jup.ag/lend/v1/earn/deposit-instructions'
      : 'https://api.jup.ag/lend/v1/earn/withdraw-instructions';
    let ixResponse: Record<string, unknown>;
    try {
      const r = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
        body: JSON.stringify({ asset: body.mint, amount: amountBn.eq(U64_MAX) ? '1' : amountBn.toString(), signer: dao.toBase58() }),
      });
      if (!r.ok) {
        const txt = await r.text().catch(() => '');
        return res.status(502).json({ error: `Jupiter Earn API ${r.status}: ${txt}` });
      }
      ixResponse = await r.json() as Record<string, unknown>;
    } catch (err) {
      return res.status(502).json({ error: `Jupiter Earn API unreachable: ${err instanceof Error ? err.message : err}` });
    }
    // Extract accounts from the instruction response.
    // The API returns { instructions: [{ programId, accounts: [{pubkey, isSigner, isWritable}], data }] }
    const instructions = (ixResponse.instructions as Array<{ accounts: Array<{ pubkey: string }> }> | undefined) ?? [];
    const earnIx = instructions[0];
    if (!earnIx?.accounts || earnIx.accounts.length < 14) {
      return res.status(502).json({ error: `Jupiter Earn API response missing expected accounts: ${JSON.stringify(ixResponse)}` });
    }
    // Account order per the Jupiter Earn CPI spec (deposit has 17 accounts; withdraw has 18):
    // deposit:  signer(0) depositorATA(1) recipientATA(2) mint(3) lendingAdmin(4)
    //           lending(5) fTokenMint(6) supplyReserves(7) supplyPosition(8) rateModel(9)
    //           vault(10) liquidity(11) liquidityProgram(12) rewardsRateModel(13) ...
    // withdraw: signer(0) ownerATA(1) recipientATA(2) lendingAdmin(3) lending(4)
    //           mint(5) fTokenMint(6) supplyReserves(7) supplyPosition(8) rateModel(9)
    //           vault(10) claimAccount(11) liquidity(12) liquidityProgram(13) rewardsRateModel(14) ...
    const a = earnIx.accounts;
    if (body.action === 'jupiter_deposit') {
      j = {
        lending_admin: a[4].pubkey, lending: a[5].pubkey, f_token_mint: a[6].pubkey,
        supply_token_reserves_liquidity: a[7].pubkey, lending_supply_position_on_liquidity: a[8].pubkey,
        rate_model: a[9].pubkey, vault: a[10].pubkey, liquidity: a[11].pubkey,
        liquidity_program: a[12].pubkey, rewards_rate_model: a[13].pubkey,
      };
    } else {
      j = {
        lending_admin: a[3].pubkey, lending: a[4].pubkey, f_token_mint: a[6].pubkey,
        supply_token_reserves_liquidity: a[7].pubkey, lending_supply_position_on_liquidity: a[8].pubkey,
        rate_model: a[9].pubkey, vault: a[10].pubkey, claim_account: a[11].pubkey,
        liquidity: a[12].pubkey, liquidity_program: a[13].pubkey, rewards_rate_model: a[14].pubkey,
      };
    }
  }

  // Validate required fields are present.
  const required = ['lending', 'f_token_mint', 'lending_admin', 'supply_token_reserves_liquidity',
    'lending_supply_position_on_liquidity', 'rate_model', 'vault', 'liquidity', 'liquidity_program',
    'rewards_rate_model'] as const;
  for (const field of required) {
    if (!j[field]) return res.status(400).json({ error: `${body.action} requires jupiter.${field}` });
  }
  if (body.action === 'jupiter_withdraw' && !j.claim_account) {
    return res.status(400).json({ error: 'jupiter_withdraw requires jupiter.claim_account' });
  }

  try {
    const agent = await loadAgentKeypair(dao.toBase58(), 'operational', effectiveAesKey);
    await ensureFundedFromOpsWallet(agent.publicKey);
    const programs = programsForAgent(agent, getConnection());
    const mint = new PublicKey(body.mint!);

    // The vault_authority PDA is the Jupiter signer; its vault-owned ATAs
    // (for the underlying mint and the jlToken mint) are init_if_needed in the instruction.
    const baseAccounts = {
      authority: agent.publicKey,
      globalConfig: pdas.globalConfig(),
      daoRegistry: dao,
      agentSet: pdas.agentSet(dao),
      mint,
      fTokenMint: new PublicKey(j.f_token_mint),
      vaultAuthority: pdas.vaultAuthority(dao),
      strategyPosition: pdas.strategyPositionForMint(dao, 'jupiter', mint),
      jupiterLendingProgram: EXTERNAL_PROGRAM_IDS.jupiterLending,
      lendingAdmin: new PublicKey(j.lending_admin),
      lending: new PublicKey(j.lending),
      supplyTokenReservesLiquidity: new PublicKey(j.supply_token_reserves_liquidity),
      lendingSupplyPositionOnLiquidity: new PublicKey(j.lending_supply_position_on_liquidity),
      rateModel: new PublicKey(j.rate_model),
      vault: new PublicKey(j.vault),
      liquidity: new PublicKey(j.liquidity),
      liquidityProgram: new PublicKey(j.liquidity_program),
      rewardsRateModel: new PublicKey(j.rewards_rate_model),
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    };

    let ix: TransactionInstruction;
    if (body.action === 'jupiter_deposit') {
      ix = await programs.core.methods
        .jupiterDeposit(amountBn)
        .accountsPartial(baseAccounts)
        .instruction();
    } else {
      ix = await programs.core.methods
        .jupiterWithdraw(amountBn)
        .accountsPartial({
          ...baseAccounts,
          claimAccount: new PublicKey(j.claim_account!),
        })
        .instruction();
    }

    const sig = await sendAgentV0(
      programs,
      agent,
      [ComputeBudgetProgram.setComputeUnitLimit({ units: PROTOCOL_CU_LIMIT }), ix],
      body.lookup_table_address,
    );
    return res.json({ success: true, signature: sig, agent: agent.publicKey.toBase58() });
  } catch (err) {
    console.error(`[signer] ${body.action} error:`, err);
    return res.status(500).json({ error: err instanceof Error ? err.message : `${body.action} failed` });
  }
}

/**
 * jupiter_swap — agent token swap. FAIL-CLOSED / NOT IMPLEMENTED (HTTP 501).
 *
 * The previous implementation fetched a fully-built transaction from the
 * Jupiter Swap API (`POST /swap/v1/swap`) for `userPublicKey = <operational
 * agent>`, signed it with the Operational key and broadcast it RAW. That was a
 * blind-signing path (audit HIGH): it bypassed the on-chain `jupiter_swap`
 * vault instruction (constitution allowlist, per-asset caps, vault-owned
 * source/destination accounts, slippage enforcement against the vault's own
 * token deltas) AND the `sendAgentV0` writable-account allowlist + simulation,
 * so a compromised orchestrator/API response could have drained any token the
 * agent key controlled. It has been DELETED — there is no reachable code path
 * that signs an aggregator-built transaction with an agent key any more.
 *
 * Why the correct on-chain route is not implemented in this pass: the
 * nave_core `jupiter_swap` instruction (IDL: accounts operational_agent,
 * vault_authority, source_token_account = treasury_asset_in.token_account (the
 * `asset_vault` PDA), destination_token_account = the asset_vault PDA of
 * mint_out, remaining_accounts = the route's accounts, args amount_in /
 * min_amount_out / expected_amount_out / route_data) requires the Jupiter
 * route to debit/credit the vault's `asset_vault` PDAs, whereas the Jupiter
 * `/swap-instructions` API always builds the route against the swapper's
 * ASSOCIATED token accounts (only `destinationTokenAccount` is overridable).
 * Rewriting the route's source-account slot per Jupiter instruction variant
 * (`route` vs `shared_accounts_route`, differing account layouts) is fragile,
 * and the on-chain SEC-H4 route-account allowlist (RouteAccountNotAllowed)
 * would additionally reject the ATA the API inserts. Closing that gap needs a
 * contract-side change (accept the vault_authority ATA as an allowed
 * intermediate, or a `source_token_account` override) which is being decided
 * in the contracts repo — tracked as a dependency in the hardening report.
 *
 * Until then the route returns 501 regardless of `NAVE_SWAP_ENABLED` (which
 * still defaults to false and still gates with 403 first so the capability
 * stays dark). Request validation is kept so callers get precise errors.
 */
async function handleJupiterSwap(
  res: express.Response,
  body: SignRequest,
  dao: PublicKey,
): Promise<express.Response> {
  // Fail-closed env gate.
  if (!SWAP_ENABLED) {
    return res.status(403).json({
      error: 'jupiter_swap is disabled. Set NAVE_SWAP_ENABLED=true to enable the agent swap capability.',
    });
  }
  if (body.agent_role !== 'operational') {
    return res.status(400).json({ error: 'jupiter_swap must be signed by the Oversight agent (agent_role "operational")' });
  }
  if (!body.input_mint || !body.output_mint) {
    return res.status(400).json({ error: 'jupiter_swap requires input_mint and output_mint' });
  }
  console.warn(
    `[signer] jupiter_swap requested for dao=${dao.toBase58()} (${body.input_mint} -> ${body.output_mint}) — ` +
      'refused: the aggregator blind-signing path was removed; on-chain jupiter_swap CPI route not yet implemented.',
  );
  return res.status(501).json({
    error:
      'jupiter_swap is not available: the off-chain aggregator-signed swap path was removed for security ' +
      '(it bypassed the on-chain jupiter_swap vault instruction and the signer allowlist). The on-chain ' +
      'jupiter_swap CPI route (Jupiter /swap-instructions for the vault_authority PDA, forwarded as ' +
      'remaining_accounts through sendAgentV0) is pending a contract-side interface change.',
    code: 'JUPITER_SWAP_NOT_IMPLEMENTED',
  });
}

const app = express();
// Reverse-proxy awareness (audit 8a): TRUSTED_PROXY_HOPS is the number of
// proxy hops in front of this service that are trusted to append to
// X-Forwarded-For (Railway's edge = 1). Express then derives `req.ip` from the
// RIGHTMOST untrusted hop instead of the caller-controlled leftmost entry, so a
// client cannot spoof its rate-limit key by prepending addresses. 0 disables
// proxy trust entirely (req.ip = socket peer).
const TRUSTED_PROXY_HOPS = (() => {
  const raw = (process.env.TRUSTED_PROXY_HOPS || '').trim();
  const n = raw ? Number(raw) : 1;
  return Number.isInteger(n) && n >= 0 ? n : 1;
})();
app.set('trust proxy', TRUSTED_PROXY_HOPS > 0 ? TRUSTED_PROXY_HOPS : false);
app.use(express.json());

app.get('/health', (_req, res) => {
  const warnings = runtimeConfigWarnings();
  res.json({
    ok: true,
    /** Non-empty when the runtime config is inconsistent (release blockers). */
    degraded: warnings.length > 0,
    warnings,
    rpc: process.env.SOLANA_RPC_URL ? 'configured' : 'default-localhost',
    config: {
      supabase: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY),
      signerSecret: Boolean(SIGNER_SECRET),
      swapEnabled: SWAP_ENABLED,
      trustedProxyHops: TRUSTED_PROXY_HOPS,
      nodeEnv: process.env.NODE_ENV || null,
    },
    programIds: Object.fromEntries(Object.entries(PROGRAM_IDS).map(([k, v]) => [k, v.toBase58()])),
    cluster: {
      naveCluster: NAVE_CLUSTER,
      isMainnet: JUPITER_ID_CHECK.isMainnet,
      evmNetwork: NAVE_EVM_NETWORK,
      jupiterLending: JUPITER_ID_CHECK.lending,
      jupiterLiquidity: JUPITER_ID_CHECK.liquidity,
      jupiterProgramIdsOk: JUPITER_ID_CHECK.ok,
    },
    // Cross-chain NAVE bridge readiness (testnet trusted-relayer MVP). No
    // secrets are leaked — only whether each piece of config is present.
    bridge: (() => {
      const b = readBridgeConfig();
      return {
        enabled: b.enabled,
        feeBps: b.feeBps,
        bridgeProgramConfigured: Boolean(b.naveMint && b.bridgeProgramId && b.relayerSecret),
        feeDestinationsConfigured: Boolean(b.protocolFeeAccount && b.stakingPoolAccount),
        evmMinterConfigured: Boolean(b.evmMinterPrivateKey),
        evmLockboxChains: Object.keys(b.evmLockbox).map(Number),
        /** Legacy global floor (BRIDGE_EVM_CONFIRMATIONS); per-chain values below are authoritative. */
        evmConfirmations: b.evmConfirmations,
        evmConfirmationsByChain: evmConfirmationsByChain(),
        evmNetwork: NAVE_EVM_NETWORK,
        enabledEvmChainIds: [...readBridgeEvmChainIds()].sort((x, y) => x - y),
        lookbackSeconds: bridgeLookbackSeconds(),
        wrappedNaveChains: Object.keys(b.wrappedNave).map(Number),
        watcher: (() => {
          const w = readBridgeWatcherConfig();
          return {
            enabled: w.enabled,
            staleMs: w.staleMs,
            maxRetries: w.maxRetries,
            scanMissedEvents: w.scanMissedEvents,
          };
        })(),
      };
    })(),
    // Staking global-parity mirror readiness (worker tick). No secrets leaked
    // — only whether each piece of config is present.
    stakingMirror: (() => {
      const m = readStakingMirrorConfig();
      return {
        enabled: m.enabled,
        collectorConfigured: Boolean(m.collectorAccount),
        stakingProgramId: m.stakingProgramId,
        minDistributionRaw: m.minDistributionRaw.toString(),
        mirrorSrcChainId: m.mirrorSrcChainId,
        evmStakingChains: Object.keys(m.evmStaking).map(Number),
      };
    })(),
    // NAVE devnet faucet readiness. No secrets leaked — only whether each
    // piece of config is present.
    faucet: (() => {
      const f = readFaucetConfig();
      return {
        enabled: f.enabled,
        walletConfigured: Boolean(f.walletSecret),
        naveMintConfigured: Boolean(f.naveMint),
        claimAmountRaw: f.claimAmountRaw.toString(),
        minSolBalanceLamports: f.minSolBalanceLamports.toString(),
        solClaimAmountLamports: f.solClaimAmountLamports.toString(),
        cooldownHours: f.cooldownHours,
      };
    })(),
  });
});

/**
 * Bridge relay queue depth (ops surface for the independent watcher, audit
 * M-1). Reports how many transfers are pending/failed/stuck so an operator can
 * alert on stuck transfers that exhausted automatic retries. Read-only; no
 * secrets. Returns zeros if Supabase is unreachable rather than erroring.
 */
app.get('/bridge-queue', async (_req, res) => {
  try {
    const counts = await getBridgeQueueCounts();
    return res.json({ ok: true, ...counts });
  } catch (err) {
    console.error('[signer] /bridge-queue error:', err instanceof Error ? err.message : err);
    return res.json({ ok: false, pending: 0, failed: 0, stuck: 0 });
  }
});

// ── Staking-mirror manual trigger ────────────────────────────────────────────
// The staking mirror (bridge-fee → per-chain reward drip) normally runs on the
// worker's interval. This guarded endpoint runs ONE tick on demand so the drip
// window on each EVM chain (and Solana) can be opened/refreshed without waiting
// for — or requiring — the full worker process. An in-process mutex prevents
// overlapping ticks; the tick itself is money-moving so it stays behind the
// signer secret. Scheduled callers (e.g. Supabase pg_cron) can hit this every
// ~10 min to keep folding accrued fees into the rolling window.
let stakingMirrorRunning = false;

app.post('/staking-mirror/run', async (req, res) => {
  if (!secretMatches(req.header('X-Signer-Secret'), SIGNER_SECRET)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!readStakingMirrorConfig().enabled) {
    return res.status(409).json({ error: 'Staking mirror disabled (STAKING_MIRROR_ENABLED != true)' });
  }
  if (stakingMirrorRunning) {
    return res.status(409).json({ error: 'Staking-mirror tick already in progress' });
  }
  stakingMirrorRunning = true;
  try {
    const result = await runStakingMirror();
    return res.json({ ok: true, result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[signer] /staking-mirror/run error:', message);
    return res.status(500).json({ ok: false, error: message });
  } finally {
    stakingMirrorRunning = false;
  }
});

/** Length-checked constant-time secret comparison. */
function secretMatches(provided: string | undefined, expected: string): boolean {
  if (!provided || provided.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  } catch {
    return false;
  }
}

/**
 * Caller IP for rate-limit keying. `req.ip` is computed by Express from the
 * `trust proxy` setting above: with TRUSTED_PROXY_HOPS=n it is the address n
 * hops from the socket (the rightmost UNtrusted X-Forwarded-For entry), never
 * the attacker-controlled leftmost value the old implementation used.
 */
function callerIp(req: express.Request): string {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

interface OnChainCheck {
  ok: boolean;
  status: number;
  error?: string;
}

/**
 * Pre-sign authorization: the signer must NEVER blindly submit whatever the
 * caller asks for. It re-reads the authoritative on-chain ExecutionRequest and
 * confirms (a) it belongs to the claimed DAO, (b) its status is the one the
 * requested action legitimately transitions from, (c) for execute_strategy the
 * review window has elapsed and the protocol matches the bound request. This
 * means a stolen NAVE_SIGNER_SECRET cannot drive arbitrary state changes — the
 * chain's own preconditions are enforced here too (defense-in-depth with the
 * program, which is still the ultimate authority).
 */
async function validateOnChainState(
  programs: AgentPrograms,
  body: SignRequest,
): Promise<OnChainCheck> {
  let er: {
    dao: PublicKey;
    status: number;
    reviewEnd: number;
    protocolProgram: PublicKey;
  };
  try {
    const acc = await fetchExecutionRequestTolerant(
      programs,
      new PublicKey(body.execution_request_address),
    );
    er = {
      dao: new PublicKey(acc.dao),
      status: Number(acc.status),
      reviewEnd: Number(acc.reviewEnd?.toString?.() ?? acc.reviewEnd ?? 0),
      protocolProgram: new PublicKey(acc.protocolProgram),
    };
  } catch (e) {
    return { ok: false, status: -1, error: `Could not read execution request: ${e instanceof Error ? e.message : 'unknown'}` };
  }

  if (er.dao.toBase58() !== body.dao_address) {
    return { ok: false, status: er.status, error: 'execution_request.dao does not match dao_address' };
  }

  const allowed = ACTION_REQUIRED_STATUS[body.action] ?? [];
  if (!allowed.includes(er.status)) {
    return {
      ok: false,
      status: er.status,
      error: `action ${body.action} not valid from status ${STATUS_NAMES[er.status] ?? er.status} (expected ${allowed.map((s) => STATUS_NAMES[s]).join(' | ')})`,
    };
  }

  if (body.action === 'execute_strategy') {
    // Only enforce the timer once InReview; OversightApproved has no window yet.
    if (er.status === 4) {
      const now = Math.floor(Date.now() / 1000);
      if (now < er.reviewEnd) {
        return { ok: false, status: er.status, error: `review window active (ends in ${er.reviewEnd - now}s)` };
      }
    }
    const adapter = body.protocol_id ? adapterProgramId(body.protocol_id) : null;
    if (!adapter || adapter.toBase58() !== er.protocolProgram.toBase58()) {
      return { ok: false, status: er.status, error: 'protocol_id does not match the bound execution request adapter' };
    }
  }

  if (body.action === 'withdraw_from_strategy') {
    const adapter = body.protocol_id ? adapterProgramId(body.protocol_id) : null;
    if (!adapter || adapter.toBase58() !== er.protocolProgram.toBase58()) {
      return { ok: false, status: er.status, error: 'protocol_id does not match the bound execution request adapter' };
    }
  }

  if (body.action === 'expire_request') {
    const now = Math.floor(Date.now() / 1000);
    if (now < er.reviewEnd) {
      return { ok: false, status: er.status, error: `review window still active (ends in ${er.reviewEnd - now}s)` };
    }
  }

  return { ok: true, status: er.status };
}

const CORE_AGENT_ACTIONS = new Set<SignAction>([
  'revalue_treasury',
  'update_strategy_position_value',
  'kamino_deposit', 'kamino_withdraw',
  'jito_deposit', 'jito_withdraw',
  'jupiter_deposit', 'jupiter_withdraw',
  'marginfi_deposit', 'marginfi_withdraw',
  'jupiter_swap',
  'bundle_rebalance',
]);

/** Actions that only record a value; the program allows them while the DAO is frozen. */
const FROZEN_OK_ACTIONS = new Set<SignAction>(['revalue_treasury', 'update_strategy_position_value']);

const BUNDLE_OP_ACTIONS = new Set<string>([
  'execute_strategy',
  'kamino_deposit', 'kamino_withdraw',
  'jito_deposit', 'jito_withdraw',
  'jupiter_deposit', 'jupiter_withdraw',
  'marginfi_deposit', 'marginfi_withdraw',
]);

const ROLE_INDEX: Record<'executive' | 'financial' | 'oversight' | 'operational', number> = {
  executive: 0, financial: 1, oversight: 2, operational: 3,
};

/**
 * Pre-sign check for nave_core agent actions that have no ExecutionRequest
 * (venue CPIs, swaps, bundles, marks, revalue). Mirrors the program's guards so
 * a stolen caller credential can't make the signer decrypt a key for an action
 * the chain would reject: protocol not paused, DAO not frozen (except marks),
 * agents enabled, and the signing slot Active and not nullified.
 */
async function validateCoreActionState(
  programs: AgentPrograms,
  body: SignRequest,
  dao: PublicKey,
  role: keyof typeof ROLE_INDEX,
): Promise<OnChainCheck> {
  const action = body.action as SignAction;
  if (action === 'bundle_rebalance') {
    for (const [i, op] of (body.bundle_operations ?? []).entries()) {
      if (!BUNDLE_OP_ACTIONS.has(op.action)) {
        return { ok: false, status: -1, error: `bundle op[${i}] action '${op.action}' is not execute_strategy or a venue deposit/withdraw` };
      }
    }
  }
  try {
    const [config, registry, agentSet] = await Promise.all([
      (programs.core.account as any).naveGlobalConfig.fetch(pdas.globalConfig()),
      fetchDaoRegistryTolerant(programs, dao),
      (programs.core.account as any).agentSet.fetch(pdas.agentSet(dao)),
    ]);
    if (config.paused) return { ok: false, status: -1, error: 'protocol is paused' };
    if (registry.frozen && !FROZEN_OK_ACTIONS.has(action)) {
      return { ok: false, status: -1, error: 'DAO is frozen' };
    }
    if (!agentSet.agentsEnabled) return { ok: false, status: -1, error: 'agents are disabled for this DAO' };
    const slot = agentSet.agents[ROLE_INDEX[role]];
    if (!slot || !slot.active || slot.nullified || Number(slot.status) !== 0) {
      return { ok: false, status: -1, error: `${role} agent slot is not active` };
    }
    return { ok: true, status: -1 };
  } catch (e) {
    return { ok: false, status: -1, error: `Could not read DAO state: ${e instanceof Error ? e.message : 'unknown'}` };
  }
}

/**
 * EVM (secp256k1 + EIP-712) GUARDIAN signing for Ethereum + Base. Separate from
 * the Solana `/sign` path so existing flows are untouched. Produces an EIP-712
 * GuardianAction signature (NaveTreasury domain) for ONE custodied guardian;
 * NaveTreasury aggregates these M-of-N via a bitmask on-chain.
 *
 * NOTE: the four agent roles do NOT sign here — their NaveExecution approvals
 * are msg.sender-gated transactions relayed via /relay-evm. A non-guardian
 * agent_role is rejected by signEvmApproval. This endpoint never broadcasts.
 */
app.post('/sign-evm', async (req, res) => {
  try {
    const guardianAuth = authorizeRole(req.header('X-Signer-Secret'), 'guardian', SIGNER_SECRET);
    if (!guardianAuth.ok) {
      return res.status(guardianAuth.status).json({ error: guardianAuth.error });
    }

    const body = req.body as EvmGuardianSignRequest;
    const { chain_id, dao_address, agent_role } = body;
    if (!chain_id || !dao_address || !agent_role) {
      return res.status(400).json({ error: 'Missing required fields: chain_id, dao_address, agent_role' });
    }

    // Reuse the multi-dimensional rate limiter (per-IP / DAO / action / role / global).
    const limited = await enforceLimits([
      { key: 'global', limit: RATE_GLOBAL, windowMs: RATE_WINDOW_MS },
      { key: `ip:${callerIp(req)}`, limit: RATE_PER_IP, windowMs: RATE_WINDOW_MS },
      { key: `dao:${dao_address}`, limit: RATE_PER_DAO, windowMs: RATE_WINDOW_MS },
      { key: `dao:${dao_address}:action:sign-evm`, limit: RATE_PER_ACTION, windowMs: RATE_WINDOW_MS },
      { key: `dao:${dao_address}:role:${agent_role}`, limit: RATE_PER_ROLE, windowMs: RATE_WINDOW_MS },
    ]);
    if (limited) {
      res.setHeader('Retry-After', String(limited.retryAfterSeconds));
      return res.status(429).json({ error: 'Too many requests', retry_after_seconds: limited.retryAfterSeconds, dimension: limited.key });
    }

    const result = await signEvmApproval(body);
    return res.json({ success: true, ...result });
  } catch (err) {
    console.error('[signer] /sign-evm error:', err instanceof Error ? err.message : err);
    return res.status(400).json({ error: err instanceof Error ? err.message : 'EVM signing failed' });
  }
});

/**
 * EVM on-chain submission/relayer (Ethereum + Base). Unlike /sign-evm (which
 * only returns EIP-712 signatures), this BROADCASTS a transaction from a
 * custodied agent/guardian EOA — required for contract calls that check
 * `msg.sender`. Two action families:
 *
 *  - toggle_agents: resume → NaveTreasury.toggleAgents(true) from the Executive
 *    EOA; pause → guardian M-of-N NaveTreasury.guardianAction(DISABLE_AGENTS)
 *    assembled from every custodied guardian plus optional external
 *    `guardian_signatures` (founder wallet) over the same nonce/deadline.
 *    Requires { chain_id, dao_address, enabled }.
 *
 *  - update_strategy_position_value: NaveExecution.syncPositionValue(adapter)
 *    from the Oversight agent (role operational); the value is read on-chain from the adapter.
 *    Requires { chain_id, dao_address, execution_address, adapter }.
 *
 *  - the four-agent pipeline on NaveExecution: executive_approve,
 *    financial_approve, oversight_approve, operational_halt, operational_clear,
 *    expire_request, execute_strategy, execute_strategy_direct,
 *    withdraw_from_strategy. These are msg.sender-gated transactions (NOT EIP-712
 *    signatures). Require { chain_id, dao_address, execution_address (or
 *    target_address), index, ... } — see relayEvmAgentAction for per-action args
 *    (reasoning_hash / tx_payload_hash / amount / min_out).
 */
const EVM_RELAY_AGENT_ACTIONS = new Set<EvmRelayAgentAction>([
  'executive_approve',
  'financial_approve',
  'oversight_approve',
  'operational_halt',
  'operational_clear',
  'expire_request',
  'execute_strategy',
  'execute_strategy_direct',
  'withdraw_from_strategy',
  'create_bridge_request',
  'bridge_outbound',
]);

app.post('/relay-evm', async (req, res) => {
  try {
    const relayAuth = authorizeRole(
      req.header('X-Signer-Secret'),
      evmRelaySignerRole(String(req.body?.action ?? 'toggle_agents')),
      SIGNER_SECRET,
    );
    if (!relayAuth.ok) {
      return res.status(relayAuth.status).json({ error: relayAuth.error });
    }

    const body = req.body as (
      Partial<EvmRelayToggleRequest>
      & Partial<EvmRelayAgentActionRequest>
      & Partial<EvmRelayUpdatePositionValueRequest>
      & { action?: string }
    );
    const action = (body.action ?? 'toggle_agents') as string;
    const { chain_id, dao_address } = body;
    if (!chain_id || !dao_address) {
      return res.status(400).json({ error: 'Missing required fields: chain_id, dao_address' });
    }

    // Rate limit identically for both families (per IP / DAO / action / global).
    const limited = await enforceLimits([
      { key: 'global', limit: RATE_GLOBAL, windowMs: RATE_WINDOW_MS },
      { key: `ip:${callerIp(req)}`, limit: RATE_PER_IP, windowMs: RATE_WINDOW_MS },
      { key: `dao:${dao_address}`, limit: RATE_PER_DAO, windowMs: RATE_WINDOW_MS },
      { key: `dao:${dao_address}:action:relay-evm`, limit: RATE_PER_ACTION, windowMs: RATE_WINDOW_MS },
    ]);
    if (limited) {
      res.setHeader('Retry-After', String(limited.retryAfterSeconds));
      return res.status(429).json({ error: 'Too many requests', retry_after_seconds: limited.retryAfterSeconds, dimension: limited.key });
    }

    // ── Agent pause/resume toggle ────────────────────────────────────────────
    if (action === 'toggle_agents') {
      const { enabled } = body;
      if (typeof enabled !== 'boolean') {
        return res.status(400).json({ error: "toggle_agents requires 'enabled' (boolean)" });
      }
      const { guardian_signatures, nonce, deadline } = body as Partial<EvmRelayToggleRequest>;
      if (guardian_signatures !== undefined && !Array.isArray(guardian_signatures)) {
        return res.status(400).json({ error: "guardian_signatures must be an array of 0x-hex EIP-712 signatures" });
      }
      const result = await relayEvmAgentToggle({ chain_id, dao_address, enabled, guardian_signatures, nonce, deadline });
      return res.json({ success: true, signature: result.tx_hash, ...result });
    }

    // ── Position-oracle tick (mirrors Solana's update_strategy_position_value) ──
    // NaveExecution reads the mark from the adapter; no caller-supplied value.
    if (action === 'update_strategy_position_value') {
      const { adapter, execution_address, target_address } = body as Partial<EvmRelayUpdatePositionValueRequest>;
      if (!adapter) {
        return res.status(400).json({ error: "update_strategy_position_value requires 'adapter' (NaveTreasury position key)" });
      }
      const result = await relayEvmUpdateStrategyPositionValue({
        chain_id,
        dao_address,
        adapter,
        execution_address: execution_address ?? target_address,
      });
      return res.json({ success: true, signature: result.tx_hash, ...result });
    }

    // Post Pyth (Hermes) then revalueTreasury. No execution_address — treasury call.
    if (action === 'revalue_treasury') {
      const result = await relayEvmRevalueTreasury({ chain_id, dao_address });
      return res.json({ success: true, signature: result.tx_hash, ...result });
    }

    // Permissionless strategy proposal. Idempotency matches the Solana path:
    // reserve agent_proposals before broadcast, 409 on unique violation, delete
    // the reservation if the tx fails so the creator can retry.
    if (action === 'create_proposal') {
      const proposalBody = body as {
        adapter?: string;
        asset?: string;
        mint?: string;
        amount?: string | number;
        title?: string;
        description?: string;
        voting_mint?: string;
        idempotency_key?: string;
        recommendation_id?: string;
        protocol_id?: string;
        action_kind?: string;
        agent_role?: string;
      };
      const adapter = proposalBody.adapter;
      const asset = proposalBody.asset ?? proposalBody.mint;
      const idempotencyKey = proposalBody.idempotency_key;
      if (!adapter || !asset) {
        return res.status(400).json({ error: "create_proposal requires 'adapter' and 'asset' (0x addresses)" });
      }
      if (proposalBody.amount === undefined || proposalBody.amount === null || proposalBody.amount === '') {
        return res.status(400).json({ error: "create_proposal requires 'amount'" });
      }
      if (!idempotencyKey) {
        return res.status(400).json({ error: "create_proposal requires 'idempotency_key'" });
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const supabase = getSupabase() as any;
      const STALE_CREATING_MS = 120_000;
      await supabase
        .from('agent_proposals')
        .delete()
        .eq('dao_onchain_address', dao_address)
        .eq('idempotency_key', idempotencyKey)
        .eq('status', 'creating')
        .lt('created_at', new Date(Date.now() - STALE_CREATING_MS).toISOString());

      const amountRaw = BigInt(proposalBody.amount);
      const amountForRow = amountRaw <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(amountRaw)
        : amountRaw.toString();

      const { data: inserted, error: insertErr } = await supabase
        .from('agent_proposals')
        .insert({
          dao_onchain_address: dao_address,
          idempotency_key: idempotencyKey,
          recommendation_id: proposalBody.recommendation_id ?? null,
          protocol_id: proposalBody.protocol_id ?? 'evm',
          program_id: adapter,
          amount_base_units: amountForRow,
          action_kind: proposalBody.action_kind ?? 'deploy',
          proposer_role: proposalBody.agent_role ?? 'operational',
          status: 'creating',
        })
        .select('id')
        .single();

      if (insertErr) {
        if ((insertErr as { code?: string }).code === PG_UNIQUE_VIOLATION) {
          return res.status(409).json({
            error: 'Duplicate proposal: a proposal already exists for this idempotency_key',
            idempotency_key: idempotencyKey,
          });
        }
        return res.status(500).json({ error: `Failed to reserve idempotency row: ${insertErr.message}` });
      }

      const ledgerId = (inserted as { id: string }).id;
      try {
        const result = await relayEvmCreateProposal({
          chain_id,
          dao_address,
          adapter,
          asset,
          amount: amountRaw,
          title: proposalBody.title,
          description: proposalBody.description,
          voting_mint: proposalBody.voting_mint,
        });
        await supabase
          .from('agent_proposals')
          .update({
            status: 'created',
            proposal_index: Number(result.proposalIndex),
            proposal_address: result.proposalAddress,
            payload_hash: result.payloadHash,
            tx_signature: result.txHash,
            updated_at: new Date().toISOString(),
          })
          .eq('id', ledgerId);
        return res.json({
          success: true,
          signature: result.txHash,
          proposal_address: result.proposalAddress,
          proposal_index: result.proposalIndex,
          payload_hash: result.payloadHash,
        });
      } catch (err) {
        await supabase.from('agent_proposals').delete().eq('id', ledgerId);
        throw err;
      }
    }

    // ── Four-agent NaveExecution pipeline relay ──────────────────────────────
    if (EVM_RELAY_AGENT_ACTIONS.has(action as EvmRelayAgentAction)) {
      // Capital bridge-out is dual-gated: orchestrator + signer must both see
      // NAVE_BRIDGE_OUTBOUND_ENABLED=true (defense in depth vs a misconfigured edge).
      if (
        (action === 'create_bridge_request' || action === 'bridge_outbound') &&
        (process.env.NAVE_BRIDGE_OUTBOUND_ENABLED ?? 'false').toLowerCase() !== 'true'
      ) {
        return res.status(503).json({
          error: 'NAVE_BRIDGE_OUTBOUND_ENABLED is false — capital bridge relay refused',
        });
      }
      const target = body.execution_address ?? body.target_address;
      if (!target) {
        return res.status(400).json({ error: `${action} requires 'execution_address' (NaveExecution contract address)` });
      }
      if (body.index === undefined || body.index === null || body.index === '') {
        return res.status(400).json({ error: `${action} requires 'index' (uint64 request key)` });
      }
      // Remaining per-action field validation (hashes / amount / min_out) is
      // enforced inside relayEvmAgentAction so the contract rules live in one place.
      const result = await relayEvmAgentAction({
        action: action as EvmRelayAgentAction,
        chain_id,
        dao_address,
        execution_address: body.execution_address,
        target_address: body.target_address,
        index: body.index,
        reasoning_hash: body.reasoning_hash,
        tx_payload_hash: body.tx_payload_hash,
        amount: body.amount,
        min_out: body.min_out,
        adapter: (body as { adapter?: string }).adapter,
        asset: (body as { asset?: string }).asset,
        dest_chain_id: (body as { dest_chain_id?: number | string }).dest_chain_id,
        dest_treasury: (body as { dest_treasury?: string }).dest_treasury,
      });
      return res.json({ success: true, signature: result.tx_hash, ...result });
    }

    return res.status(400).json({ error: `Unsupported relay action '${action}'` });
  } catch (err) {
    console.error('[signer] /relay-evm error:', err instanceof Error ? err.message : err);
    return res.status(400).json({ error: err instanceof Error ? err.message : 'EVM relay failed' });
  }
});

/**
 * Cross-chain NAVE token bridge relay (TESTNET trusted-relayer MVP).
 *
 * Unlike every other endpoint here, /bridge-relay is called DIRECTLY by the
 * public web app (the browser), so it intentionally does NOT require the
 * X-Signer-Secret header — a browser cannot hold that secret. Security comes
 * instead from INDEPENDENT on-chain verification of `sourceTx` inside
 * handleBridgeRelay (the relayer re-reads the lock/burn tx and only ever mints/
 * releases the amount it actually observed), plus the unique(source_tx) DB
 * constraint that makes replays idempotent. IP rate limiting throttles abuse.
 *
 * Body: { direction, sourceChain, destChain, sourceTx, recipient, amountRaw? }.
 * Guarded by BRIDGE_RELAYER_ENABLED (503 when disabled).
 */
app.options('/bridge-relay', publicCorsMiddleware);
app.post('/bridge-relay', publicCorsMiddleware, async (req, res) => {
  try {
    if (!readBridgeConfig().enabled) {
      return res.status(503).json({ error: 'Bridge relayer is disabled (set BRIDGE_RELAYER_ENABLED=true)' });
    }

    const body = req.body as BridgeRelayBody;
    if (!body || typeof body !== 'object') {
      return res.status(400).json({ error: 'Invalid JSON body' });
    }

    const wantsRetry = body.retry === true;

    // IP-based rate limiting only — there is no trusted caller secret here.
    // The explicit retry path gets a tighter per-IP ceiling so a stuck transfer
    // can be re-driven without opening an abuse vector.
    const rateSpecs = [
      { key: 'global', limit: RATE_GLOBAL, windowMs: RATE_WINDOW_MS },
      { key: `ip:${callerIp(req)}`, limit: RATE_PER_IP, windowMs: RATE_WINDOW_MS },
      { key: `bridge:ip:${callerIp(req)}`, limit: RATE_PER_ACTION, windowMs: RATE_WINDOW_MS },
    ];
    if (wantsRetry) {
      rateSpecs.push({
        key: `bridge-retry:ip:${callerIp(req)}`,
        limit: Math.max(1, Math.floor(RATE_PER_ACTION / 4)),
        windowMs: RATE_WINDOW_MS,
      });
    }
    const limited = await enforceLimits(rateSpecs);
    if (limited) {
      res.setHeader('Retry-After', String(limited.retryAfterSeconds));
      return res.status(429).json({ error: 'Too many requests', retry_after_seconds: limited.retryAfterSeconds, dimension: limited.key });
    }
    // The destination recipient is now embedded IN the on-chain source tx (the
    // nave_bridge lock instruction / WrappedNave bridgeBurn), so the relayer
    // derives it from the verified event — no recipient or senderSignature
    // field is required (or trusted) from the caller anymore.
    if (!body.direction || !body.sourceChain || !body.destChain || !body.sourceTx) {
      return res.status(400).json({
        error: 'Missing required fields: direction, sourceChain, destChain, sourceTx',
      });
    }

    const result = await handleBridgeRelay(body, wantsRetry ? { allowRetry: true } : {});
    return res.json({ success: true, ...result });
  } catch (err) {
    console.error('[signer] /bridge-relay error:', err instanceof Error ? err.message : err);
    return res.status(400).json({ error: err instanceof Error ? err.message : 'Bridge relay failed' });
  }
});

/**
 * EVM staking reward claim-on-demand.
 *
 * Called DIRECTLY by the public web app (same posture as /bridge-relay — no
 * signer secret in the browser). Authorization comes from an EIP-191 signature
 * by the STAKING WALLET itself over a freshness-bounded message, verified in
 * handleStakeClaim; payout always goes to that same wallet, is bounded by the
 * server-side accrual ledger, and is capped by the Solana reward reserve.
 * A per-(chain, staker) cross-replica lease excludes concurrent double-pays.
 *
 * Body: { chainId, staker, issuedAtSec, signature }.
 */
app.options('/stake-claim', publicCorsMiddleware);
app.post('/stake-claim', publicCorsMiddleware, async (req, res) => {
  const holder = `http-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  let lockKey: string | null = null;
  try {
    const body = req.body as { chainId?: number; staker?: string; issuedAtSec?: number; signature?: string };
    if (!body || typeof body !== 'object' || !body.chainId || !body.staker || !body.signature || !body.issuedAtSec) {
      return res.status(400).json({ error: 'Missing required fields: chainId, staker, issuedAtSec, signature' });
    }

    const rateSpecs = [
      { key: 'global', limit: RATE_GLOBAL, windowMs: RATE_WINDOW_MS },
      { key: `ip:${callerIp(req)}`, limit: RATE_PER_IP, windowMs: RATE_WINDOW_MS },
      { key: `stake-claim:ip:${callerIp(req)}`, limit: RATE_PER_ACTION, windowMs: RATE_WINDOW_MS },
    ];
    const limited = await enforceLimits(rateSpecs);
    if (limited) {
      res.setHeader('Retry-After', String(limited.retryAfterSeconds));
      return res.status(429).json({ error: 'Too many requests', retry_after_seconds: limited.retryAfterSeconds });
    }

    // Cross-replica lease: one in-flight claim per (chain, staker).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sb = getSupabase() as any;
    lockKey = `stakeClaim:${body.chainId}:${String(body.staker).toLowerCase()}`;
    // TTL must outlast a worst-case claim (Solana wrap confirm + Ethereum
    // mainnet mint receipt under congestion). The settle-before-mint ledger
    // guard in handleStakeClaim protects even if a claim outlives the lease.
    const { data: acquired, error: lockErr } = await sb.rpc('try_acquire_worker_lock', {
      p_lock_key: lockKey,
      p_holder: holder,
      p_ttl_seconds: 600,
    });
    if (lockErr || acquired !== true) {
      lockKey = null; // don't release someone else's lease
      return res.status(409).json({ error: 'A claim for this wallet is already in progress' });
    }

    const result = await handleStakeClaim({
      chainId: Number(body.chainId),
      staker: String(body.staker),
      issuedAtSec: Number(body.issuedAtSec),
      signature: String(body.signature),
    });
    return res.json({ success: true, ...result });
  } catch (err) {
    console.error('[signer] /stake-claim error:', err instanceof Error ? err.message : err);
    return res.status(400).json({ error: err instanceof Error ? err.message : 'Stake claim failed' });
  } finally {
    if (lockKey) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (getSupabase() as any).rpc('release_worker_lock', { p_lock_key: lockKey, p_holder: holder });
      } catch { /* lease expires on its own */ }
    }
  }
});

/**
 * Live claimable-rewards view for the EVM StakeBox. Public read (the ledger
 * table is public-read anyway); folds the accrual server-side so the counter
 * survives refreshes and is identical on every device.
 * Query: ?chainId=<evm chain id>&staker=<0x address>.
 */
app.options('/stake-claim/pending', publicCorsMiddleware);
app.get('/stake-claim/pending', publicCorsMiddleware, async (req, res) => {
  try {
    const limited = await enforceLimits([
      { key: `stake-pending:ip:${callerIp(req)}`, limit: RATE_PER_IP, windowMs: RATE_WINDOW_MS },
    ]);
    if (limited) {
      res.setHeader('Retry-After', String(limited.retryAfterSeconds));
      return res.status(429).json({ error: 'Too many requests', retry_after_seconds: limited.retryAfterSeconds });
    }
    const chainId = Number(req.query.chainId);
    const staker = String(req.query.staker || '');
    const pending = await getStakeClaimPending(chainId, staker);
    return res.json({ success: true, ...pending });
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : 'Pending lookup failed' });
  }
});

/**
 * Reward-reserve balance for the public "Reward pool" stat. The reserve is a
 * relayer-owned Solana token account that EVM claims pay out of, so the UI
 * shows reward vault + reserve (both shrink as rewards are claimed). Cached
 * briefly server-side to keep the public tile from hammering the RPC.
 */
let _reserveCache: { at: number; body: { reserveRaw: string; reserveAccount: string } } | null = null;
app.options('/stake-claim/pool', publicCorsMiddleware);
app.get('/stake-claim/pool', publicCorsMiddleware, async (req, res) => {
  try {
    const limited = await enforceLimits([
      { key: `stake-pool:ip:${callerIp(req)}`, limit: RATE_PER_IP, windowMs: RATE_WINDOW_MS },
    ]);
    if (limited) {
      res.setHeader('Retry-After', String(limited.retryAfterSeconds));
      return res.status(429).json({ error: 'Too many requests', retry_after_seconds: limited.retryAfterSeconds });
    }
    if (!_reserveCache || Date.now() - _reserveCache.at > 15_000) {
      _reserveCache = { at: Date.now(), body: await getStakeClaimReserve() };
    }
    return res.json({ success: true, ..._reserveCache.body });
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : 'Reserve lookup failed' });
  }
});

/**
 * NAVE devnet faucet claim (TESTNET ONLY).
 *
 * Called DIRECTLY by the public web app — no signer secret, same posture as
 * /bridge-relay. Anti-abuse layers:
 *   1. Dual rate limiting: one claim per cooldown window per RECIPIENT
 *      ADDRESS, independently AND simultaneously one claim per cooldown
 *      window per CALLER IP. Both must pass — rotating IPs alone cannot
 *      bypass the per-address cooldown, and claiming to many addresses from
 *      one IP cannot bypass the per-IP cooldown.
 *   2. Minimum devnet SOL balance check on the recipient address (proves it's
 *      an already-funded, real wallet rather than a fresh throwaway).
 *
 * Body: { address: string }. Guarded by FAUCET_ENABLED (503 when disabled).
 */
app.options('/faucet-claim', publicCorsMiddleware);
app.post('/faucet-claim', publicCorsMiddleware, async (req, res) => {
  try {
    // Hard fail on mainnet regardless of FAUCET_ENABLED (audit 8b): the faucet
    // hands out tokens from a hot wallet and only ever exists for devnet.
    if (isMainnetCluster()) {
      return res.status(403).json({ error: 'Faucet is not available on mainnet' });
    }
    const cfg = readFaucetConfig();
    if (!cfg.enabled) {
      return res.status(503).json({ error: 'Faucet is disabled (set FAUCET_ENABLED=true)' });
    }

    const body = req.body as { address?: string };
    const address = (body?.address || '').trim();
    if (!address) {
      return res.status(400).json({ error: 'address is required' });
    }
    let recipientKey: PublicKey;
    try {
      recipientKey = new PublicKey(address);
    } catch {
      return res.status(400).json({ error: 'address must be a valid Solana address' });
    }
    const recipient = recipientKey.toBase58();

    // Dual rate limit: per-address AND per-IP, both independently enforced.
    // Checked (and consumed) as THREE separate steps rather than one combined
    // enforceLimits([...]) call: enforceLimits consumes each spec in order as
    // it goes, so if the address check passed but the IP check then failed,
    // the address's slot would be wrongly burned for the full cooldown even
    // though no NAVE was ever sent. Roll it back if that happens.
    const cooldownMs = cfg.cooldownHours * 60 * 60 * 1000;

    const globalLimited = await enforceLimits([{ key: 'global', limit: RATE_GLOBAL, windowMs: RATE_WINDOW_MS }]);
    if (globalLimited) {
      res.setHeader('Retry-After', String(globalLimited.retryAfterSeconds));
      return res.status(429).json({ error: 'Too many requests', retry_after_seconds: globalLimited.retryAfterSeconds, dimension: 'global' });
    }

    const addrSpec = { key: `faucet:addr:${recipient}`, limit: 1, windowMs: cooldownMs };
    const addrLimited = await enforceLimits([addrSpec]);
    if (addrLimited) {
      res.setHeader('Retry-After', String(addrLimited.retryAfterSeconds));
      return res.status(429).json({
        error: `This address already claimed from the faucet in the last ${cfg.cooldownHours} hours.`,
        retry_after_seconds: addrLimited.retryAfterSeconds,
        dimension: 'address',
      });
    }

    const ipSpec = { key: `faucet:ip:${callerIp(req)}`, limit: 1, windowMs: cooldownMs };
    const ipLimited = await enforceLimits([ipSpec]);
    if (ipLimited) {
      await releaseLimit(addrSpec); // the address slot was consumed above but nothing was sent — give it back
      res.setHeader('Retry-After', String(ipLimited.retryAfterSeconds));
      return res.status(429).json({
        error: 'This IP already claimed from the faucet recently. Try again later.',
        retry_after_seconds: ipLimited.retryAfterSeconds,
        dimension: 'ip',
      });
    }

    // Both dimensions are consumed at this point. Everything past here is
    // "did the claim actually happen" — any failure means nothing was sent,
    // so release both slots before responding (an infra hiccup or an
    // insufficient-balance rejection shouldn't burn the user's 24h window).
    try {
      const balanceCheck = await checkMinSolBalance(recipient);
      if (!balanceCheck.ok) {
        const haveSOL = (Number(balanceCheck.balanceLamports) / 1_000_000_000).toFixed(4);
        const needSOL = (Number(balanceCheck.minLamports) / 1_000_000_000).toFixed(4);
        await releaseLimit(addrSpec);
        await releaseLimit(ipSpec);
        return res.status(400).json({
          error: `This address must hold at least ${needSOL} devnet SOL to claim (currently has ${haveSOL} SOL).`,
        });
      }

      const result = await sendFaucetClaim(recipient);
      return res.json({ success: true, ...result });
    } catch (err) {
      await releaseLimit(addrSpec);
      await releaseLimit(ipSpec);
      throw err;
    }
  } catch (err) {
    console.error('[signer] /faucet-claim error:', err instanceof Error ? err.message : err);
    return res.status(400).json({ error: err instanceof Error ? err.message : 'Faucet claim failed' });
  }
});

/**
 * Devnet SOL faucet claim (TESTNET ONLY).
 *
 * Same public posture and dual rate limiting as /faucet-claim, but sends a
 * small amount of devnet SOL (default 0.05) from the SAME faucet wallet via a
 * plain system transfer. Rate-limit keys are separate from the NAVE faucet's
 * (`faucet-sol:*` vs `faucet:*`), so claiming one asset never consumes the
 * other's cooldown. Unlike the NAVE faucet there is NO minimum-SOL-balance
 * eligibility check — the whole point is to fund addresses with no SOL yet.
 *
 * Body: { address: string }. Guarded by FAUCET_ENABLED (503 when disabled).
 */
app.options('/faucet-claim-sol', publicCorsMiddleware);
app.post('/faucet-claim-sol', publicCorsMiddleware, async (req, res) => {
  try {
    // Hard fail on mainnet regardless of FAUCET_ENABLED (audit 8b): the faucet
    // hands out tokens from a hot wallet and only ever exists for devnet.
    if (isMainnetCluster()) {
      return res.status(403).json({ error: 'Faucet is not available on mainnet' });
    }
    const cfg = readFaucetConfig();
    if (!cfg.enabled) {
      return res.status(503).json({ error: 'Faucet is disabled (set FAUCET_ENABLED=true)' });
    }

    const body = req.body as { address?: string };
    const address = (body?.address || '').trim();
    if (!address) {
      return res.status(400).json({ error: 'address is required' });
    }
    let recipientKey: PublicKey;
    try {
      recipientKey = new PublicKey(address);
    } catch {
      return res.status(400).json({ error: 'address must be a valid Solana address' });
    }
    const recipient = recipientKey.toBase58();

    // Same three-step consume/rollback dance as /faucet-claim — see the
    // comment there for why the specs are enforced separately.
    const cooldownMs = cfg.cooldownHours * 60 * 60 * 1000;

    const globalLimited = await enforceLimits([{ key: 'global', limit: RATE_GLOBAL, windowMs: RATE_WINDOW_MS }]);
    if (globalLimited) {
      res.setHeader('Retry-After', String(globalLimited.retryAfterSeconds));
      return res.status(429).json({ error: 'Too many requests', retry_after_seconds: globalLimited.retryAfterSeconds, dimension: 'global' });
    }

    const addrSpec = { key: `faucet-sol:addr:${recipient}`, limit: 1, windowMs: cooldownMs };
    const addrLimited = await enforceLimits([addrSpec]);
    if (addrLimited) {
      res.setHeader('Retry-After', String(addrLimited.retryAfterSeconds));
      return res.status(429).json({
        error: `This address already claimed SOL from the faucet in the last ${cfg.cooldownHours} hours.`,
        retry_after_seconds: addrLimited.retryAfterSeconds,
        dimension: 'address',
      });
    }

    const ipSpec = { key: `faucet-sol:ip:${callerIp(req)}`, limit: 1, windowMs: cooldownMs };
    const ipLimited = await enforceLimits([ipSpec]);
    if (ipLimited) {
      await releaseLimit(addrSpec); // consumed above but nothing was sent — give it back
      res.setHeader('Retry-After', String(ipLimited.retryAfterSeconds));
      return res.status(429).json({
        error: 'This IP already claimed SOL from the faucet recently. Try again later.',
        retry_after_seconds: ipLimited.retryAfterSeconds,
        dimension: 'ip',
      });
    }

    // Both dimensions consumed — release them on any failure past this point
    // so a faucet-out-of-SOL or infra error never burns the user's window.
    try {
      const result = await sendSolFaucetClaim(recipient);
      return res.json({ success: true, ...result });
    } catch (err) {
      await releaseLimit(addrSpec);
      await releaseLimit(ipSpec);
      throw err;
    }
  } catch (err) {
    console.error('[signer] /faucet-claim-sol error:', err instanceof Error ? err.message : err);
    return res.status(400).json({ error: err instanceof Error ? err.message : 'Faucet claim failed' });
  }
});

app.post('/sign', async (req, res) => {
  try {
    const body = req.body as SignRequest;
    // Fail-closed: SIGNER_SECRET is guaranteed set (boot check above). The
    // credential must belong to the one role allowed to drive this action.
    const signAuth = authorizeRole(
      req.header('X-Signer-Secret'),
      solanaCredentialRole(body?.action, body?.agent_role),
      SIGNER_SECRET,
    );
    if (!signAuth.ok) {
      return res.status(signAuth.status).json({
        error: signAuth.status === 400
          ? `agent_role '${body?.agent_role}' may not perform '${body?.action}'`
          : signAuth.error,
      });
    }

    const { action, dao_address, execution_request_address, agent_role, aes_decrypt_key } = body;

    // This endpoint is Solana-only (Anchor programs / PDAs). EVM DAOs sign
    // EIP-712 approvals via /sign-evm; their on-chain submission is handled by
    // the EVM relayer, not this Solana path. Reject EVM requests explicitly so
    // a mis-routed call can never hit a Solana handler with an EVM address.
    const reqChain = (body.chain ?? 'solana').toLowerCase();
    if (reqChain === 'ethereum' || reqChain === 'base') {
      return res.status(400).json({
        error: `chain '${reqChain}' is not supported on /sign; use /sign-evm for EVM approval signing`,
      });
    }
    if (reqChain !== 'solana') {
      return res.status(400).json({ error: `Unsupported chain '${reqChain}'` });
    }

    // create_proposal operates on a NEW proposal and toggle_agents operates on
    // the AgentSet — neither has an execution request; all other actions do.
    const requiresExecutionRequest =
      action !== 'create_proposal'
      && action !== 'toggle_agents'
      && action !== 'update_strategy_position_value'
      && action !== 'revalue_treasury'
      && action !== 'kamino_deposit'
      && action !== 'kamino_withdraw'
      && action !== 'jito_deposit'
      && action !== 'jito_withdraw'
      && action !== 'jupiter_deposit'
      && action !== 'jupiter_withdraw'
      && action !== 'jupiter_swap'
      && action !== 'marginfi_deposit'
      && action !== 'marginfi_withdraw'
      && action !== 'replenish_agents'
      && action !== 'bundle_rebalance'
      && action !== 'finalize_proposal';
    if (!action || !dao_address || !agent_role || (requiresExecutionRequest && !execution_request_address)) {
      return res.status(400).json({
        error: 'Missing required fields: action, dao_address, agent_role'
          + (requiresExecutionRequest ? ', execution_request_address' : ''),
      });
    }

    // ── Circuit breaker: pause a DAO whose signer actions are erroring out ──
    // A burst of rejections/errors for a DAO trips its breaker for a cooldown,
    // containing stuck/adversarial loops instead of retrying unbounded.
    const circuit = await circuitStatus(dao_address);
    if (circuit.open) {
      res.setHeader('Retry-After', String(circuit.retryAfterSeconds));
      return res.status(503).json({
        error: 'Signer circuit open for this DAO (recent failure burst); paused',
        retry_after_seconds: circuit.retryAfterSeconds,
      });
    }
    // Record the outcome of this attempt once the response is sent. M6: only
    // 5xx (signer / on-chain / internal failures) count toward the breaker; a
    // 2xx clears the running count; 4xx client errors (validation rejections,
    // rate limits) are NEUTRAL so a malformed-request burst cannot trip a DAO's
    // breaker and DoS its legitimate signing.
    res.on('finish', () => {
      const code = res.statusCode;
      if (code < 400) {
        void recordSignerOutcome(dao_address, true).catch(() => {});
      } else if (code >= 500) {
        void recordSignerOutcome(dao_address, false).catch(() => {});
      }
    });

    // ── Rate limit (per-IP / DAO / action / role / global dimensions) ──────
    // Distributed (Upstash) when configured; fail-closed on mainnet otherwise.
    const limited = await enforceLimits([
      { key: 'global', limit: RATE_GLOBAL, windowMs: RATE_WINDOW_MS },
      { key: `ip:${callerIp(req)}`, limit: RATE_PER_IP, windowMs: RATE_WINDOW_MS },
      { key: `dao:${dao_address}`, limit: RATE_PER_DAO, windowMs: RATE_WINDOW_MS },
      { key: `dao:${dao_address}:action:${action}`, limit: RATE_PER_ACTION, windowMs: RATE_WINDOW_MS },
      { key: `dao:${dao_address}:role:${agent_role}`, limit: RATE_PER_ROLE, windowMs: RATE_WINDOW_MS },
    ]);
    if (limited) {
      res.setHeader('Retry-After', String(limited.retryAfterSeconds));
      return res.status(429).json({ error: 'Too many requests', retry_after_seconds: limited.retryAfterSeconds, dimension: limited.key });
    }

    // Legacy plaintext-DEK input is permanently rejected — the envelope (KEK)
    // flow is the only supported decrypt path. There is no env flag to re-enable
    // it; supplying a raw DEK is always a 400.
    if (aes_decrypt_key) {
      return res.status(400).json({
        error: 'aes_decrypt_key (legacy plaintext DEK) is removed; use the envelope (KEK) flow',
      });
    }
    const effectiveAesKey: string | undefined = undefined;
    if (!isKekConfigured()) {
      return res.status(400).json({
        error: 'NAVE_MASTER_KEK is not configured (envelope decrypt required)',
      });
    }

    const dao = new PublicKey(dao_address);

    // ── create_proposal — autonomous governance proposal creation ─────────
    // Handled before the ExecutionRequest validation path because there is no
    // request to read yet. Separation of duties: this only CREATES a proposal
    // (Strategy type); it can never approve/halt/execute. The proposal must
    // still pass governance and the full 4-agent pipeline before funds move.
    if (action === 'create_proposal') {
      return await handleCreateProposal(res, body, dao, effectiveAesKey);
    }

    // ── toggle_agents — real on-chain pause/resume of autonomous agents ───
    // The on-chain authority for toggle_agents is the EXECUTIVE agent key. This
    // is the authoritative kill switch the UI maps to (no local-only pause).
    if (action === 'toggle_agents') {
      return await handleToggleAgents(res, body, dao, effectiveAesKey);
    }

    // ── replenish_agents — proactive agent wallet top-up from ops wallet ──
    // Called by the worker on a regular cadence. Checks all 4 agent wallets
    // and tops up any below AGENT_MIN_LAMPORTS using the protocol ops wallet,
    // which is funded from Nave's 8.5% yield fee revenue.
    if (action === 'replenish_agents') {
      const results = await replenishAgentWallets(dao_address, effectiveAesKey);
      return res.json({ success: true, dao_address, wallets: results });
    }

    // ── multi-asset / real-protocol CPI actions (operate on nave_core, not an
    //    ExecutionRequest) ──────────────────────────────────────────────────
    if (CORE_AGENT_ACTIONS.has(action)) {
      const coreCheck = await validateCoreActionState(
        programsForAgent(Keypair.generate(), getConnection()),
        body,
        dao,
        'operational',
      );
      if (!coreCheck.ok) {
        return res.status(409).json({ error: `Pre-sign validation failed: ${coreCheck.error}` });
      }
    }
    if (action === 'revalue_treasury') {
      return await handleRevalueTreasury(res, body, dao, effectiveAesKey);
    }
    if (action === 'kamino_deposit' || action === 'kamino_withdraw') {
      return await handleKaminoCpi(res, body, dao, effectiveAesKey);
    }
    if (action === 'jito_deposit' || action === 'jito_withdraw') {
      return await handleJitoCpi(res, body, dao, effectiveAesKey);
    }
    if (action === 'jupiter_deposit' || action === 'jupiter_withdraw') {
      return await handleJupiterCpi(res, body, dao, effectiveAesKey);
    }
    if (action === 'jupiter_swap') {
      return await handleJupiterSwap(res, body, dao);
    }
    if (action === 'marginfi_deposit' || action === 'marginfi_withdraw') {
      return await handleMarginfiCpi(res, body, dao, effectiveAesKey);
    }

    // ── finalize_proposal — tally votes, mark Passed/Failed ─────────────
    if (action === 'finalize_proposal') {
      return await handleFinalizeProposal(res, body, dao, effectiveAesKey);
    }

    // ── bundle_rebalance — atomic multi-protocol CPI via Jito bundle ──────
    // Executes up to 4 operational CPI actions atomically (mainnet: Jito bundle,
    // devnet: sequential fallback). Prevents partial-rebalance failures and
    // provides MEV protection on large treasury moves.
    if (action === 'bundle_rebalance') {
      return await handleBundleRebalance(res, body, dao, effectiveAesKey);
    }

    if (action === 'update_strategy_position_value') {
      if (!body.protocol_id) {
        return res.status(400).json({ error: 'update_strategy_position_value requires protocol_id' });
      }
      // The on-chain StrategyPosition PDA is keyed [seed, dao, protocol_id, MINT]
      // (multi-asset); `mint` is therefore required to address the position.
      if (!body.mint) {
        return res.status(400).json({ error: 'update_strategy_position_value requires mint (the position asset mint)' });
      }
      let positionMint: PublicKey;
      try {
        positionMint = new PublicKey(body.mint);
      } catch {
        return res.status(400).json({ error: 'update_strategy_position_value mint must be a valid base58 pubkey' });
      }
      if (body.agent_role !== 'operational') {
        return res.status(400).json({ error: 'update_strategy_position_value must be signed by the Oversight agent (agent_role "operational")' });
      }
      // The mark is read on-chain from the venue's exchange rate; the caller
      // only supplies which accounts hold the position.
      const markSources = await resolvePositionMarkSources(dao, body.protocol_id, positionMint);
      if ('error' in markSources) {
        return res.status(400).json({ error: markSources.error });
      }
      const operational = await loadAgentKeypair(dao_address, 'operational', effectiveAesKey);
      await ensureFundedFromOpsWallet(operational.publicKey);
      const opPrograms = programsForAgent(operational, getConnection());
      const signature = await opPrograms.core.methods
        .updateStrategyPositionValue(body.protocol_id)
        .accountsPartial({
          authority: operational.publicKey,
          globalConfig: pdas.globalConfig(),
          daoRegistry: dao,
          agentSet: pdas.agentSet(dao),
          mint: positionMint,
          strategyPosition: pdas.strategyPosition(dao, body.protocol_id, positionMint),
          vaultAuthority: pdas.vaultAuthority(dao),
          strategyEscrow: pdas.strategyEscrow(dao, body.protocol_id, positionMint),
          venueState: markSources.venueState,
          receiptTokenAccount: markSources.receiptTokenAccount,
        })
        .rpc();
      return res.json({ success: true, signature, agent: operational.publicKey.toBase58() });
    }

    // ── Pre-sign on-chain validation (defense-in-depth) ──────────────────
    // Read-only program (throwaway signer) to fetch and validate the request
    // BEFORE decrypting any agent key.
    const readPrograms = programsForAgent(Keypair.generate(), getConnection());
    const stateCheck = await validateOnChainState(readPrograms, body);
    if (!stateCheck.ok) {
      return res.status(409).json({ error: `Pre-sign validation failed: ${stateCheck.error}` });
    }

    const agent = await loadAgentKeypair(dao_address, agent_role, effectiveAesKey);
    // Ensure the signing agent has enough SOL for fees; top up from the
    // protocol ops wallet (funded from Nave's 8.5% yield fee) if needed.
    await ensureFundedFromOpsWallet(agent.publicKey);
    const programs = programsForAgent(agent, getConnection());

    const executionRequest = new PublicKey(execution_request_address);
    const globalConfig = pdas.globalConfig();
    const agentSet = pdas.agentSet(dao);
    const reasoningHash = hexToBytes32(body.reasoning_hash);

    const approvalAccounts = { authority: agent.publicKey, globalConfig, daoRegistry: dao, agentSet, executionRequest };

    let signature: string;

    switch (action) {
      case 'executive_approve': {
        signature = await programs.execution.methods
          .executiveApprove(reasoningHash)
          .accountsPartial(approvalAccounts)
          .rpc();
        break;
      }
      case 'financial_approve':
      case 'oversight_approve': {
        // Compute the canonical payload hash from the linked proposal.
        const erAcc = await fetchExecutionRequestTolerant(programs, executionRequest);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const proposalAcc = await (programs.governance.account as any).proposal.fetch(erAcc.proposal);
        const txPayloadHash = computeTxPayloadHash(proposalAcc.payload, proposalAcc.payloadLen);

        const method =
          action === 'financial_approve'
            ? programs.execution.methods.financialApprove(txPayloadHash, reasoningHash)
            : programs.execution.methods.oversightApprove(txPayloadHash, reasoningHash);

        signature = await method.accountsPartial(approvalAccounts).rpc();
        break;
      }
      case 'operational_halt': {
        signature = await programs.execution.methods
          .operationalHalt(reasoningHash)
          .accountsPartial(approvalAccounts)
          .rpc();
        break;
      }
      case 'operational_clear': {
        if (reasoningHash.every((b) => b === 0)) {
          return res.status(400).json({ error: 'operational_clear requires a non-zero reasoning_hash (the clear reason)' });
        }
        signature = await programs.execution.methods
          .operationalClear(reasoningHash)
          .accountsPartial(approvalAccounts)
          .rpc();
        break;
      }
      case 'execute_strategy':
      case 'withdraw_from_strategy': {
        if (!body.protocol_id) {
          return res.status(400).json({ error: `${action} requires protocol_id` });
        }
        if (action === 'withdraw_from_strategy' && body.agent_role !== 'executive') {
          return res.status(400).json({ error: 'withdraw_from_strategy must be signed by the executive agent' });
        }
        const adapter = adapterProgramId(body.protocol_id);
        if (!adapter) {
          return res.status(400).json({ error: `Unknown protocol_id: ${body.protocol_id}` });
        }

        // Multi-asset: the asset being deployed/withdrawn is bound to the
        // ExecutionRequest (`mint`), NOT inferred from token_registry[0]. Read it
        // from the request so every derived per-asset account is keyed correctly.
        const erAccForMint = await fetchExecutionRequestTolerant(programs, executionRequest);
        const assetMint = new PublicKey(erAccForMint.mint);

        // Per-(dao, mint) accounts. The vault token account is the asset_vault PDA
        // recorded on treasury_asset.token_account (register_asset creates it).
        const assetConfig = pdas.assetConfig(dao, assetMint);
        const treasuryAsset = pdas.treasuryAsset(dao, assetMint);
        const vaultTokenAccount = pdas.assetVault(dao, assetMint);

        // Strategy escrow/position are now mint-keyed (dao ‖ protocol ‖ mint).
        const escrowPdaEnabled = (process.env.NAVE_ESCROW_PDA_ENABLED ?? 'true').toLowerCase() === 'true';
        const strategyEscrow = escrowPdaEnabled
          ? pdas.strategyEscrowForMint(dao, body.protocol_id, assetMint)
          : vaultTokenAccount;
        const strategyPosition = pdas.strategyPositionForMint(dao, body.protocol_id, assetMint);

        // Pyth PriceUpdateV2 for non-stable assets. Stablecoins are valued at USD
        // parity on-chain and ignore this account, so we pass the mint as a
        // harmless placeholder when no explicit price_update is supplied.
        const priceUpdate = body.price_update_address
          ? new PublicKey(body.price_update_address)
          : assetMint;

        if (action === 'withdraw_from_strategy') {
          const amount = typeof body.amount === 'string' ? Number(body.amount) : body.amount;
          if (!Number.isFinite(amount as number) || (amount as number) <= 0 || !Number.isInteger(amount as number)) {
            return res.status(400).json({ error: 'withdraw_from_strategy requires a positive integer amount (base units)' });
          }

          // Fee redesign: the withdrawal path now skims the 8.5% performance fee
          // on realized yield straight into the protocol revenue wallet's ATA for
          // the withdrawn mint. Resolve the FeeConfig PDA and read the authoritative
          // `protocol_revenue_wallet` from chain, then derive the revenue ATA.
          const feeConfig = pdas.feeConfig(dao);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const feeConfigAcc = await (programs.core.account as any).feeConfig.fetch(feeConfig);
          const protocolRevenueWallet = new PublicKey(feeConfigAcc.protocolRevenueWallet);
          if (protocolRevenueWallet.equals(PublicKey.default)) {
            return res.status(400).json({ error: 'withdraw_from_strategy: fee_config.protocol_revenue_wallet is unset on-chain' });
          }
          // ATA(owner=protocol_revenue_wallet, mint=withdrawn asset). The on-chain
          // record_strategy_withdrawal CPI validates owner==revenue wallet and
          // mint==withdrawn mint; the account must already exist (provisioned by
          // the revenue-wallet operator, see RUNBOOKS).
          const revenueTokenAccount = getAssociatedTokenAddressSync(
            assetMint,
            protocolRevenueWallet,
            true,
          );

          // M14: route the actual capital-movement CPI through sendAgentV0
          // (pre-submission simulation + writable-account allowlist + verified
          // ALT resolution) instead of Anchor's .rpc(), which submits with none
          // of those fail-closed checks.
          {
            const ix = await programs.execution.methods
              .withdrawFromStrategy(new BN(amount as number))
              .accountsPartial({
                executor: agent.publicKey,
                globalConfig,
                daoRegistry: dao,
                agentSet,
                vaultAuthority: pdas.vaultAuthority(dao),
                treasuryVault: pdas.treasuryVault(dao),
                mint: assetMint,
                assetConfig,
                treasuryAsset,
                priceUpdate,
                vaultTokenAccount,
                executionAuthority: pdas.executionAuthority(dao),
                adapterProgram: adapter,
                executionRequest,
                strategyEscrow,
                strategyPosition,
                feeConfig,
                revenueTokenAccount,
                tokenProgram: TOKEN_PROGRAM_ID,
                instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
                naveCoreProgram: PROGRAM_IDS.core,
              })
              .instruction();
            signature = await sendAgentV0(
              programs,
              agent,
              [ComputeBudgetProgram.setComputeUnitLimit({ units: PROTOCOL_CU_LIMIT }), ix],
              body.lookup_table_address,
            );
          }
          break;
        }

        // M14: same treatment as withdraw_from_strategy above — build the
        // instruction and route through sendAgentV0 rather than .rpc().
        {
          const ix = await buildExecuteStrategyIx(
            programs, agent.publicKey, dao, executionRequest, body.protocol_id, body.price_update_address,
          );
          signature = await sendAgentV0(
            programs,
            agent,
            [ComputeBudgetProgram.setComputeUnitLimit({ units: PROTOCOL_CU_LIMIT }), ix],
            body.lookup_table_address,
          );
        }
        break;
      }
      case 'expire_request': {
        signature = await programs.execution.methods
          .expireRequest()
          .accountsPartial({
            authority: agent.publicKey,
            globalConfig,
            daoRegistry: dao,
            agentSet,
            executionRequest,
          })
          .rpc();
        break;
      }
      default:
        return res.status(400).json({ error: `Unsupported action: ${action}` });
    }

    return res.json({ success: true, signature, agent: agent.publicKey.toBase58() });
  } catch (err) {
    console.error('[signer] /sign error:', err);
    return res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
  }
});

// worker.ts imports helpers from this module; the worker process must not bind
// PORT or it races the HTTP server for the socket and one of them crashes.
if (process.env.NAVE_WORKER_PROCESS !== '1') app.listen(PORT, () => {
  console.log(`[signer] Nave signer service listening on :${PORT}`);

  // Fee-bps drift preflight (non-fatal): the fee is duplicated across the
  // on-chain BridgeConfig, BRIDGE_FEE_BPS here, and the app's
  // VITE_NAVE_BRIDGE_FEE_BPS — drift silently mis-quotes users and breaks the
  // EVM→Solana net-from-gross math. Loudly flag it at startup; never crash.
  void checkBridgeFeeBpsDrift()
    .then((drift) => {
      if (drift.skipped) {
        if (readBridgeConfig().enabled) {
          console.warn(`[signer] bridge fee-bps drift check skipped: ${drift.skipped}`);
        }
        return;
      }
      if (!drift.ok) {
        console.error(`[signer] ${drift.error}`);
      } else {
        console.log(
          `[signer] bridge fee-bps aligned: on-chain fee_bps=${drift.onChainFeeBps} ` +
            `(staking ${drift.onChainStakingBps} / protocol ${drift.onChainProtocolBps} / burn ${drift.onChainBurnBps}) == BRIDGE_FEE_BPS=${drift.envFeeBps}`,
        );
      }
    })
    .catch((err) => console.warn('[signer] bridge fee-bps drift check errored:', err instanceof Error ? err.message : err));
});
