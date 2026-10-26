import { SUPABASE_FUNCTIONS_URL, SUPABASE_ANON_KEY } from './programConfig';
import type { ChainFamily, EvmChainFamily } from './chain/types';
import { counterevidenceError } from '../../supabase/functions/_shared/genlayerCharter.ts';

// ─── Edge function client ────────────────────────────────────────────────────
// Typed wrappers for calling Nave Supabase edge functions from the frontend.
// Uses the shared SUPABASE_ANON_KEY from programConfig (single source of truth).

async function callEdgeFunction<T>(
  functionName: string,
  body: object,
  headers?: Record<string, string>,
): Promise<{ data: T | null; error: string | null }> {
  try {
    const url = `${SUPABASE_FUNCTIONS_URL}/${functionName}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        ...headers,
      },
      body: JSON.stringify(body),
    });

    const data = await response.json();

    if (!response.ok) {
      return { data: null, error: data.error || `HTTP ${response.status}` };
    }

    return { data: data as T, error: null };
  } catch (err) {
    return {
      data: null,
      error: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}

// ─── Signed-challenge helpers ────────────────────────────────────────────────
// Founder-gated edge functions verify a short pipe-delimited challenge signed
// by the wallet. Nonce-bearing challenges (`register-dao`, `generate-agent-keys`)
// are single-use server-side (dispatch_nonces) and expire after 5 minutes, so a
// FRESH message (new timestamp + nonce) must be built for every attempt — never
// re-sign or re-send a previous challenge on retry.

const NONCE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';

/** Client-chosen challenge nonce: 22 url-safe chars from `crypto.getRandomValues` (server accepts 8–64 `[A-Za-z0-9_-]`). */
export function makeChallengeNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(22));
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += NONCE_ALPHABET[bytes[i] & 63];
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════════
// generate-agent-keys
// ═══════════════════════════════════════════════════════════════════════════════

export interface AgentKeyResult {
  pubkey: string;
  // NOTE: raw decrypt keys (DEKs) are never returned to the browser. The
  // `break_glass` export mode requires the operator-only `X-Break-Glass-Secret`
  // header (NAVE_BREAK_GLASS_SECRET) and is run from the operator runbook, not
  // from this client — see docs/RUNBOOKS.md (break-glass DEK export).
}

export interface GenerateAgentKeysResponse {
  success: boolean;
  dao_address: string;
  agents: {
    executive: AgentKeyResult;
    financial: AgentKeyResult;
    oversight: AgentKeyResult;
    operational: AgentKeyResult;
    planner?: AgentKeyResult;
  };
  warning: string;
}

/**
 * Generate and securely store agent keypairs for a new DAO (Solana).
 * Called during DAO creation. The founder proves ownership by signing the
 * single-use challenge `nave-agent-keys|<dao_address>|solana|<issued_at_ms>|<nonce>`
 * (ed25519; transported as base64). A fresh challenge is built per call.
 *
 * @param daoAddress - The on-chain DAO address (base58)
 * @param creatorWallet - The creator's wallet address (base58)
 * @param signMessage - The wallet adapter's message signer
 */
export async function generateAgentKeys(
  daoAddress: string,
  creatorWallet: string,
  signMessage: (message: Uint8Array) => Promise<Uint8Array>,
  daoId?: number,
  options?: { replace?: boolean },
): Promise<{ data: GenerateAgentKeysResponse | null; error: string | null }> {
  const message = `nave-agent-keys|${daoAddress}|solana|${Date.now()}|${makeChallengeNonce()}`;
  let signature: string;
  try {
    signature = await solanaAccessSigner(signMessage)(message);
  } catch (err) {
    return { data: null, error: err instanceof Error ? err.message : 'Message signing rejected' };
  }
  return callEdgeFunction<GenerateAgentKeysResponse>('generate-agent-keys', {
    dao_address: daoAddress,
    creator_wallet: creatorWallet,
    creator_message: message,
    creator_signature: signature,
    ...(daoId !== undefined ? { dao_id: daoId } : {}),
    ...(options?.replace ? { replace: true } : {}),
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// generate-evm-agent-keys (Ethereum + Base secp256k1 agent EOAs + guardian)
// ═══════════════════════════════════════════════════════════════════════════════

export interface EvmAgentAddresses {
  executive: { address: string };
  financial: { address: string };
  oversight: { address: string };
  operational: { address: string };
}

export interface GenerateEvmAgentKeysResponse {
  success: boolean;
  dao_ref: string;
  dao_address: string;
  chain: string;
  chain_id: number;
  agents: EvmAgentAddresses;
  guardian: { address: string } | null;
  regenerated?: boolean;
  warning?: string;
}

export interface BindEvmAgentKeysResponse {
  success: boolean;
  dao_address: string;
  chain: string;
  chain_id: number;
  bound: number;
}

/**
 * Generate + store the 4 EVM agent EOAs (+ guardian) for a soon-to-be-created
 * DAO, keyed by an unguessable client ref. The founder proves wallet ownership
 * by signing the `nave-evm-keygen|<ref>|<chainId>|<ts>` challenge (EIP-191).
 * Returns the agent addresses to pass into NaveDAOFactory.createDao.
 */
export async function generateEvmAgentKeys(
  daoRef: string,
  founder: string,
  chainId: number,
  chain: EvmChainFamily,
  message: string,
  creatorSignature: string,
): Promise<{ data: GenerateEvmAgentKeysResponse | null; error: string | null }> {
  return callEdgeFunction<GenerateEvmAgentKeysResponse>('generate-evm-agent-keys', {
    action: 'generate',
    dao_ref: daoRef,
    founder,
    chain,
    chain_id: chainId,
    message,
    creator_signature: creatorSignature,
  });
}

/**
 * Rebind pending EVM agent keys to the real treasury address once it is known
 * (decoded from the DaoCreated event). The founder signs the
 * `nave-evm-keybind|<ref>|<treasury>|<chainId>|<ts>` challenge.
 */
/**
 * Replace the four custodied EVM agent keys on an existing treasury. The
 * founder signs `nave-evm-keyreplace|<treasury>|<chainId>|<ts>`. The on-chain
 * agent set does not change until updateAgentSet is mined and the delay elapses.
 */
export async function replaceEvmAgentKeys(
  treasury: string,
  founder: string,
  chainId: number,
  chain: EvmChainFamily,
  message: string,
  creatorSignature: string,
): Promise<{ data: GenerateEvmAgentKeysResponse | null; error: string | null }> {
  return callEdgeFunction<GenerateEvmAgentKeysResponse>('generate-evm-agent-keys', {
    action: 'replace',
    treasury,
    founder,
    chain,
    chain_id: chainId,
    message,
    creator_signature: creatorSignature,
  });
}

export async function bindEvmAgentKeys(
  daoRef: string,
  treasury: string,
  founder: string,
  chainId: number,
  chain: EvmChainFamily,
  message: string,
  creatorSignature: string,
): Promise<{ data: BindEvmAgentKeysResponse | null; error: string | null }> {
  return callEdgeFunction<BindEvmAgentKeysResponse>('generate-evm-agent-keys', {
    action: 'bind',
    dao_ref: daoRef,
    treasury,
    founder,
    chain,
    chain_id: chainId,
    message,
    creator_signature: creatorSignature,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// register-dao
// ═══════════════════════════════════════════════════════════════════════════════

export interface RegisterDaoPayload {
  dao_address: string;
  creator_wallet: string;
  name: string;
  description?: string;
  logo_url?: string;
  governance_type?: string;
  privacy_enabled?: boolean;
  voting_token_mint?: string;
  authorized_wallets?: string[];
  social_twitter?: string;
  social_discord?: string;
  social_website?: string;
  dao_id?: number;
  slug?: string;
  /** Chain family the DAO lives on (defaults server-side to 'solana'). */
  chain?: ChainFamily;
  /** EVM numeric chain id (1/8453/4663/11155111/84532/46630/5042002); omitted for Solana. */
  chain_id?: number;
  /**
   * Solana cluster tag. `devnet` is stored even when the edge function's RPC
   * looks like mainnet. EVM registrations ignore this and use `chain_id`.
   */
  network?: 'mainnet' | 'testnet' | 'devnet';
}

export interface RegisterDaoResponse {
  success: boolean;
  dao_address: string;
  slug?: string;
}

/**
 * Signs a founder/member challenge string; returns base64 (Solana ed25519,
 * base58 also accepted server-side) or 0x-hex (EVM EIP-191 personal_sign).
 */
export type ChallengeSigner = (message: string) => Promise<string>;

/**
 * Attach off-chain DAO metadata (name, description, socials, dao_id) to the
 * registry after on-chain deployment. The creator proves ownership by signing
 * the single-use challenge
 *   `nave-register-dao|<dao_address>|<chain_id|solana>|<issued_at_ms>|<nonce>`
 * (EVM: `dao_address` is lowercased in the message to match server
 * normalization). A fresh challenge is built per call — safe to retry.
 */
export async function registerDao(
  payload: RegisterDaoPayload,
  signChallenge: ChallengeSigner,
): Promise<{ data: RegisterDaoResponse | null; error: string | null }> {
  const evm = payload.chain !== undefined && payload.chain !== 'solana';
  const daoField = evm ? payload.dao_address.toLowerCase() : payload.dao_address;
  const chainField = evm ? String(payload.chain_id) : 'solana';
  const privacyField = payload.privacy_enabled ? '1' : '0';
  const walletField = (payload.authorized_wallets ?? [])
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean)
    .sort()
    .join(',');
  const message = `nave-register-dao|${daoField}|${chainField}|${privacyField}|${walletField}|${Date.now()}|${makeChallengeNonce()}`;
  let signature: string;
  try {
    signature = await signChallenge(message);
  } catch (err) {
    return { data: null, error: err instanceof Error ? err.message : 'Message signing rejected' };
  }
  return callEdgeFunction<RegisterDaoResponse>('register-dao', {
    ...payload,
    creator_message: message,
    creator_signature: signature,
  });
}

export interface DaoAccessCheckResponse {
  allowed: boolean;
  dao_address: string;
  reason: string;
  governance_type: 'wallet' | 'token';
  privacy_enabled: boolean;
}

/**
 * Signs a dao-access-check ownership message; returns base64 (Solana ed25519)
 * or 0x-hex (EVM EIP-191).
 */
export type DaoAccessMessageSigner = (message: string) => Promise<string>;

/** Wrap a Solana wallet-adapter `signMessage` into a DaoAccessMessageSigner. */
export function solanaAccessSigner(
  signMessage: (message: Uint8Array) => Promise<Uint8Array>,
): DaoAccessMessageSigner {
  return async (message: string) => {
    const sig = await signMessage(new TextEncoder().encode(message));
    let binary = '';
    for (let i = 0; i < sig.length; i++) binary += String.fromCharCode(sig[i]);
    return btoa(binary);
  };
}

/**
 * SEC-M6: private-DAO access checks must prove wallet ownership. Public DAOs
 * resolve without a signature; when the server answers `signature_required`
 * (private DAO), we sign a fresh `nave-access|dao|wallet|timestamp` message
 * and retry, so users are only prompted for actually-private DAOs.
 */
export async function checkDaoAccess(
  daoAddress: string,
  walletAddress: string,
  signAccessMessage?: DaoAccessMessageSigner,
): Promise<{ data: DaoAccessCheckResponse | null; error: string | null }> {
  const first = await callEdgeFunction<DaoAccessCheckResponse>('dao-access-check', {
    dao_address: daoAddress,
    wallet_address: walletAddress,
  });
  if (first.error !== 'signature_required') return first;
  if (!signAccessMessage) {
    return { data: null, error: 'This DAO is private — connect a wallet that supports message signing to verify membership.' };
  }

  let signature: string;
  const message = `nave-access|${daoAddress}|${walletAddress}|${Date.now()}`;
  try {
    signature = await signAccessMessage(message);
  } catch (err) {
    return { data: null, error: err instanceof Error ? err.message : 'Message signing rejected' };
  }

  return callEdgeFunction<DaoAccessCheckResponse>('dao-access-check', {
    dao_address: daoAddress,
    wallet_address: walletAddress,
    message,
    signature,
  });
}

export interface WatchDaoResponse {
  success: boolean;
  allowed: boolean;
  dao_address: string;
  reason: string;
  governance_type: 'wallet' | 'token';
  privacy_enabled: boolean;
}

/**
 * Add a DAO to the caller's watchlist. `watch-dao` is authenticated: the wallet
 * signs `nave-watch|<dao_address>|<wallet_address>|<unix_ms>` (single-use) so
 * nobody can write to another wallet's watchlist or probe private membership.
 * This prompts the wallet — call it ONLY from an explicit user watch action,
 * never on page load. Without a signer the server answers `signature_required`.
 */
export async function watchDaoWithAccessGate(
  daoAddress: string,
  walletAddress: string,
  label = '',
  signWatchMessage?: DaoAccessMessageSigner,
): Promise<{ data: WatchDaoResponse | null; error: string | null }> {
  if (!signWatchMessage) {
    return { data: null, error: 'signature_required' };
  }
  const message = `nave-watch|${daoAddress}|${walletAddress}|${Date.now()}`;
  let signature: string;
  try {
    signature = await signWatchMessage(message);
  } catch (err) {
    return { data: null, error: err instanceof Error ? err.message : 'Message signing rejected' };
  }
  return callEdgeFunction<WatchDaoResponse>('watch-dao', {
    dao_address: daoAddress,
    wallet_address: walletAddress,
    label,
    message,
    signature,
  });
}

export interface UpdateDaoPrivacyResponse {
  success: boolean;
  dao_address: string;
  privacy_enabled: boolean;
}

export async function updateDaoPrivacy(
  daoAddress: string,
  walletAddress: string,
  signMessage: (message: Uint8Array) => Promise<Uint8Array>,
  privacyEnabled: boolean,
): Promise<{ data: UpdateDaoPrivacyResponse | null; error: string | null }> {
  const message = `nave-privacy|${daoAddress}|${privacyEnabled ? '1' : '0'}|${Date.now()}`;
  let signatureB64: string;
  try {
    const sig = await signMessage(new TextEncoder().encode(message));
    let binary = '';
    for (let i = 0; i < sig.length; i++) binary += String.fromCharCode(sig[i]);
    signatureB64 = btoa(binary);
  } catch (err) {
    return { data: null, error: err instanceof Error ? err.message : 'Message signing rejected' };
  }

  return callEdgeFunction<UpdateDaoPrivacyResponse>('update-dao-privacy', {
    dao_address: daoAddress,
    wallet: walletAddress,
    message,
    signature: signatureB64,
    privacy_enabled: privacyEnabled,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// index-events (typically called by indexer service, not frontend)
// ═══════════════════════════════════════════════════════════════════════════════

export interface IndexEventsPayload {
  dao_onchain_address: string;
  event_type: string;
  description: string;
  actor: string;
  agent_role?: string;
  tx_signature: string;
  slot: number;
  block_time?: string;
  raw_data?: Record<string, unknown>;
}

export interface IndexEventsResponse {
  success: boolean;
  inserted: number;
  skipped: number;
  treasury_updates_flagged?: number;
}

/**
 * Submit parsed transaction events for indexing.
 * This is called by the indexer service, not the frontend directly.
 * Requires the NAVE_INDEXER_SECRET.
 */
export async function indexEvents(
  events: IndexEventsPayload[],
  indexerSecret: string,
): Promise<{ data: IndexEventsResponse | null; error: string | null }> {
  return callEdgeFunction<IndexEventsResponse>('index-events', {
    events,
    indexer_secret: indexerSecret,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// snapshot-treasury (typically called by cron, not frontend)
// ═══════════════════════════════════════════════════════════════════════════════

export interface SnapshotTreasuryResponse {
  success: boolean;
  snapshots_created: number;
  errors?: Array<{ dao: string; error: string }>;
  sol_price_usd: number;
}

/**
 * Trigger a treasury balance snapshot for all or specific DAOs.
 * Typically called by a cron job or manual trigger, not the frontend.
 */
export async function snapshotTreasury(
  indexerSecret: string,
  daoAddresses?: string[],
  vaultAuthorities?: Record<string, string>,
): Promise<{ data: SnapshotTreasuryResponse | null; error: string | null }> {
  return callEdgeFunction<SnapshotTreasuryResponse>('snapshot-treasury', {
    indexer_secret: indexerSecret,
    dao_addresses: daoAddresses,
    vault_authorities: vaultAuthorities,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// yield-data (public, GET) — live yield opportunities for strategy targeting
// ═══════════════════════════════════════════════════════════════════════════════

export interface YieldOpportunity {
  poolId: string;
  symbol: string;
  /** Protocol id (kamino / jito / marginfi / jupiter) the pool belongs to. */
  protocolId: string;
  /** Asset mint the opportunity is denominated in. */
  mint: string;
  extMarket: string;
  extReserve: string;
  collateralMint?: string;
  apyBps: number;
  riskScore: number;
  adjustedScore: number;
  tvlUsd: number;
  source: string;
}

export interface YieldDataResponse {
  opportunities: YieldOpportunity[];
}

/**
 * Fetch the live yield-opportunity feed (GET). Public endpoint authenticated with
 * the anon key. Used by the Assets page's "Discover Best Pool" to bind strategy
 * targets to a real, ranked external pool.
 */
export async function fetchYieldData(): Promise<{ data: YieldDataResponse | null; error: string | null }> {
  try {
    const res = await fetch(`${SUPABASE_FUNCTIONS_URL}/yield-data`, {
      headers: { Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
    });
    if (!res.ok) {
      return { data: null, error: `HTTP ${res.status}` };
    }
    const data = await res.json();
    return { data: data as YieldDataResponse, error: null };
  } catch (err) {
    return { data: null, error: err instanceof Error ? err.message : 'Unknown error' };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// simulation-data (public, GET) — latest 50×$1M Nave portfolio backtest batch
// ═══════════════════════════════════════════════════════════════════════════════

import type { SimulationDataResponse } from './simulation/types';
export type { SimulationDataResponse, SimulationPortfolio, SimulationSummary } from './simulation/types';

/** Fetch the latest public simulation batch + 50 portfolio runs (GET, anon key). */
export async function fetchSimulationData(): Promise<{
  data: SimulationDataResponse | null;
  error: string | null;
}> {
  try {
    const res = await fetch(`${SUPABASE_FUNCTIONS_URL}/simulation-data`, {
      headers: { Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
    });
    if (!res.ok) {
      return { data: null, error: `HTTP ${res.status}` };
    }
    const data = (await res.json()) as SimulationDataResponse;
    if (!data?.batch || !Array.isArray(data.portfolios)) {
      return { data: null, error: 'Invalid simulation payload' };
    }
    return { data, error: null };
  } catch (err) {
    return { data: null, error: err instanceof Error ? err.message : 'Unknown error' };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// nave-token-stats (public, GET) — live $NAVE market data for the homepage
// ═══════════════════════════════════════════════════════════════════════════════

export interface NaveTokenStatsResponse {
  priceUsd: number | null;
  marketCapUsd: number | null;
  holders: number | null;
  totalSupply: number | null;
  chain: { t: number; price: number }[];
  contractAddress: string;
  links: { dexscreener: string; geckoterminal: string };
  fetchedAt: string;
}

/** Fetch live $NAVE price/market-cap/holders/24h chain (GET, public, anon key). */
export async function fetchNaveTokenStats(): Promise<{ data: NaveTokenStatsResponse | null; error: string | null }> {
  try {
    const res = await fetch(`${SUPABASE_FUNCTIONS_URL}/nave-token-stats`, {
      headers: { Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
    });
    if (!res.ok) {
      return { data: null, error: `HTTP ${res.status}` };
    }
    const data = await res.json();
    return { data: data as NaveTokenStatsResponse, error: null };
  } catch (err) {
    return { data: null, error: err instanceof Error ? err.message : 'Unknown error' };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// agent-dispatcher
// ═══════════════════════════════════════════════════════════════════════════════

export type AgentRole = 'executive' | 'financial' | 'oversight' | 'operational';

export interface DispatchAgentPayload {
  dao_address: string;
  agent_role: AgentRole;
  execution_request_address: string;
  action_type: string;
  aes_decrypt_key: string;
  confidence_threshold?: number;
}

export interface DispatchAgentResponse {
  success: boolean;
  agent_role: AgentRole;
  decision: string;
  should_sign: boolean;
  confidence: number;
  reasoning_summary: string;
  risk_flags: string[];
  constitution_check: Record<string, unknown> | null;
  payload_hash: string | null;
  halt_reason: string | null;
  should_halt: boolean | null;
  guardrail_failures: string[];
  retry_count: number;
  model: string;
}

/**
 * Dispatch an agent run — calls Claude Sonnet for structured reasoning.
 * Requires the NAVE_AGENT_SECRET in the X-Agent-Secret header.
 * This is called by the agent service operator, not the frontend directly.
 */
export async function dispatchAgent(
  payload: DispatchAgentPayload,
  agentSecret: string,
): Promise<{ data: DispatchAgentResponse | null; error: string | null }> {
  return callEdgeFunction<DispatchAgentResponse>('agent-dispatcher', payload, {
    'X-Agent-Secret': agentSecret,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// agent-health
// ═══════════════════════════════════════════════════════════════════════════════

export interface AgentRoleHealth {
  role: AgentRole;
  last_action_at: string | null;
  actions_24h: number;
  errors_24h: number;
  last_decision: string | null;
  last_confidence: number | null;
  active_sessions: number;
}

export interface AgentHealthResponse {
  dao_address: string;
  agents: AgentRoleHealth[];
  system_healthy: boolean;
  checked_at: string;
}

/**
 * Fetch agent health status for a DAO.
 * Lightweight check — returns last action times, error counts, active sessions.
 */
export async function fetchAgentHealth(
  daoAddress: string,
): Promise<{ data: AgentHealthResponse | null; error: string | null }> {
  return callEdgeFunction<AgentHealthResponse>('agent-health', {
    dao_address: daoAddress,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// agent-orchestrator
// ═══════════════════════════════════════════════════════════════════════════════

export interface OrchestratorPayload {
  /** 'poll' scans recent activity; 'manual' processes one execution request. */
  mode: 'poll' | 'manual';
  dao_address?: string;
  /** Required in manual mode — the execution request PDA to process. */
  execution_request_address?: string;
  /** Required in manual mode — the current on-chain execution status. */
  execution_status?: string;
}

export interface OrchestratorStepResult {
  agent_role: string;
  decision: string;
  confidence: number;
  should_sign: boolean;
  signing_status: string;
}

export interface OrchestratorResponse {
  success: boolean;
  dao_address: string;
  execution_requests_processed: number;
  results: OrchestratorStepResult[];
  errors: string[];
}

/**
 * Trigger the agent orchestrator pipeline.
 * Can process all eligible execution requests for a DAO,
 * or target a specific execution request + agent role.
 * Requires NAVE_AGENT_SECRET.
 */
export async function triggerOrchestrator(
  payload: OrchestratorPayload,
  agentSecret: string,
): Promise<{ data: OrchestratorResponse | null; error: string | null }> {
  return callEdgeFunction<OrchestratorResponse>('agent-orchestrator', payload, {
    'X-Agent-Secret': agentSecret,
  });
}

/**
 * Trigger the orchestrator through the founder-gated proxy. The browser never
 * holds NAVE_AGENT_SECRET; instead the DAO founder signs a short challenge and
 * the server-side proxy verifies the signature + creator before forwarding.
 *
 * `signMessage` is the wallet adapter's message signer; it returns the raw
 * signature bytes which we base64-encode for transport.
 */
export async function dispatchViaProxy(
  daoAddress: string,
  walletAddress: string,
  signMessage: (message: Uint8Array) => Promise<Uint8Array>,
  executionRequestAddress?: string,
): Promise<{ data: OrchestratorResponse | null; error: string | null }> {
  const target = executionRequestAddress ?? 'poll';
  const message = `nave-dispatch|${daoAddress}|${target}|${Date.now()}`;
  let signatureB64: string;
  try {
    const sig = await signMessage(new TextEncoder().encode(message));
    let binary = '';
    for (let i = 0; i < sig.length; i++) binary += String.fromCharCode(sig[i]);
    signatureB64 = btoa(binary);
  } catch (err) {
    return { data: null, error: err instanceof Error ? err.message : 'Message signing rejected' };
  }

  return callEdgeFunction<OrchestratorResponse>('orchestrator-proxy', {
    dao_address: daoAddress,
    execution_request_address: executionRequestAddress,
    wallet: walletAddress,
    message,
    signature: signatureB64,
  });
}

export interface ToggleAgentsResponse {
  success?: boolean;
  signature?: string;
  agents_enabled?: boolean;
  error?: string;
}

/**
 * Flip the authoritative on-chain `agents_enabled` flag via the founder-gated
 * admin proxy. The browser never holds the signer secret: the DAO founder signs
 * a short challenge, the server verifies founder + replay, then the signer
 * service signs nave_core::toggle_agents with the Executive agent key.
 *
 * This is the real backing for the UI pause/resume control — it changes
 * on-chain state, not local React state.
 */
export async function setAgentsEnabledViaProxy(
  daoAddress: string,
  walletAddress: string,
  signMessage: (message: Uint8Array) => Promise<Uint8Array>,
  enabled: boolean,
): Promise<{ data: ToggleAgentsResponse | null; error: string | null }> {
  const message = `nave-admin|${daoAddress}|toggle_agents|${enabled ? '1' : '0'}|${Date.now()}`;
  let signatureB64: string;
  try {
    const sig = await signMessage(new TextEncoder().encode(message));
    let binary = '';
    for (let i = 0; i < sig.length; i++) binary += String.fromCharCode(sig[i]);
    signatureB64 = btoa(binary);
  } catch (err) {
    return { data: null, error: err instanceof Error ? err.message : 'Message signing rejected' };
  }

  return callEdgeFunction<ToggleAgentsResponse>('agent-admin', {
    dao_address: daoAddress,
    wallet: walletAddress,
    message,
    signature: signatureB64,
    enabled,
  });
}

// ─── EIP-712 GuardianAction (NaveTreasury) ───────────────────────────────────
// Mirrors signer-service/src/evmSigner.ts GUARDIAN_ACTION_TYPES and the contract
// typehash `GuardianAction(uint8 actionType,uint8 agentSlot,uint8 newStatus,
// address newKey,uint64 nonce,uint64 deadline)`. Domain is the per-clone
// treasury: { name: 'NaveTreasury', version: '1', chainId, verifyingContract }.

export const GUARDIAN_ACTION_TYPES = {
  GuardianAction: [
    { name: 'actionType', type: 'uint8' },
    { name: 'agentSlot', type: 'uint8' },
    { name: 'newStatus', type: 'uint8' },
    { name: 'newKey', type: 'address' },
    { name: 'nonce', type: 'uint64' },
    { name: 'deadline', type: 'uint64' },
  ],
} as const;

/** GuardianActionType discriminants (TreasuryGuardianLib). */
export const GUARDIAN_ACTION_TYPE = {
  FREEZE: 0,
  UNFREEZE: 1,
  UPDATE_AGENT_STATUS: 2,
  ROTATE_AGENT_KEY: 3,
  DISABLE_AGENTS: 4,
  ENABLE_AGENTS: 7,
} as const;

const ZERO_EVM_ADDRESS = `0x${'0'.repeat(40)}` as `0x${string}`;

export interface GuardianActionTypedData {
  domain: { name: 'NaveTreasury'; version: '1'; chainId: number; verifyingContract: `0x${string}` };
  types: typeof GUARDIAN_ACTION_TYPES;
  primaryType: 'GuardianAction';
  message: {
    actionType: number;
    agentSlot: number;
    newStatus: number;
    newKey: `0x${string}`;
    nonce: bigint;
    deadline: bigint;
  };
}

/**
 * Typed data for a guardian DISABLE_AGENTS vote (the M-of-N pause). Pass the
 * result straight to wagmi's `signTypedDataAsync`. All guardians — the founder
 * in-browser and the custodied signer server-side — must sign the SAME
 * nonce/deadline for `guardianAction(DISABLE_AGENTS, sigs)` to verify.
 */
export function buildGuardianDisableAgentsTypedData(
  chainId: number,
  treasury: string,
  nonce: bigint,
  deadline: bigint,
): GuardianActionTypedData {
  return {
    domain: {
      name: 'NaveTreasury',
      version: '1',
      chainId,
      verifyingContract: treasury.toLowerCase() as `0x${string}`,
    },
    types: GUARDIAN_ACTION_TYPES,
    primaryType: 'GuardianAction',
    message: {
      actionType: GUARDIAN_ACTION_TYPE.DISABLE_AGENTS,
      agentSlot: 0,
      newStatus: 0,
      newKey: ZERO_EVM_ADDRESS,
      nonce,
      deadline,
    },
  };
}

/**
 * Typed data for a guardian ENABLE_AGENTS vote (the M-of-N resume when
 * `agentsGuardianLocked` is set). Pass straight to wagmi's `signTypedDataAsync`.
 */
export function buildGuardianEnableAgentsTypedData(
  chainId: number,
  treasury: string,
  nonce: bigint,
  deadline: bigint,
): GuardianActionTypedData {
  return {
    domain: {
      name: 'NaveTreasury',
      version: '1',
      chainId,
      verifyingContract: treasury.toLowerCase() as `0x${string}`,
    },
    types: GUARDIAN_ACTION_TYPES,
    primaryType: 'GuardianAction',
    message: {
      actionType: GUARDIAN_ACTION_TYPE.ENABLE_AGENTS,
      agentSlot: 0,
      newStatus: 0,
      newKey: ZERO_EVM_ADDRESS,
      nonce,
      deadline,
    },
  };
}

/** Default GuardianAction nonce/deadline for a pause/resume: now (seconds) and now + 1h. */
export function defaultGuardianDisableAgentsWindow(): { nonce: bigint; deadline: bigint } {
  const nonce = BigInt(Math.floor(Date.now() / 1000));
  return { nonce, deadline: nonce + 3600n };
}

/**
 * EVM counterpart of {setAgentsEnabledViaProxy}. The founder signs the same
 * `nave-admin|<dao>|toggle_agents|<0|1>|<ms>` challenge with their EVM wallet
 * (EIP-191 personal_sign → 0x-hex). agent-admin verifies the signature via
 * viem `verifyMessage`, confirms the founder, and forwards to the signer's
 * `/relay-evm`, which BROADCASTS the on-chain tx from a custodied agent/guardian
 * EOA — resume → Executive `toggleAgents(true)` (or guardian `ENABLE_AGENTS`
 * when `agentsGuardianLocked` is set), pause → guardian M-of-N
 * `guardianAction(DISABLE_AGENTS, signatures)`.
 *
 * Pause / Guardian-locked resume: the founder wallet is itself a guardian
 * (CreateDAO sets guardians `[founder, custodiedGuardian]` with threshold ≥ 2),
 * so pass `opts.signGuardianAction` (wagmi `signTypedDataAsync`) and the founder's
 * EIP-712 GuardianAction(DISABLE_AGENTS / ENABLE_AGENTS) signature is forwarded as
 * `guardian_signatures` alongside the matching `guardian_nonce`/`guardian_deadline`;
 * the signer adds every custodied guardian signature and broadcasts.
 * `signMessageHex` is wagmi's `signMessageAsync`.
 */
export async function setAgentsEnabledViaProxyEvm(
  daoAddress: string,
  walletAddress: string,
  signMessageHex: (message: string) => Promise<string>,
  enabled: boolean,
  chainId: number,
  chain: EvmChainFamily,
  opts?: {
    /** Founder-as-guardian EIP-712 signer (wagmi `signTypedDataAsync`). */
    signGuardianAction?: (typedData: GuardianActionTypedData) => Promise<string>;
  },
): Promise<{ data: ToggleAgentsResponse | null; error: string | null }> {
  const message = `nave-admin|${daoAddress}|toggle_agents|${enabled ? '1' : '0'}|${Date.now()}`;
  let signature: string;
  try {
    signature = await signMessageHex(message);
  } catch (err) {
    return { data: null, error: err instanceof Error ? err.message : 'Message signing rejected' };
  }

  let guardian: { guardian_signatures: string[]; guardian_nonce: string; guardian_deadline: string } | null = null;
  if (opts?.signGuardianAction) {
    const { nonce, deadline } = defaultGuardianDisableAgentsWindow();
    const typedData = enabled
      ? buildGuardianEnableAgentsTypedData(chainId, daoAddress, nonce, deadline)
      : buildGuardianDisableAgentsTypedData(chainId, daoAddress, nonce, deadline);
    try {
      const guardianSig = await opts.signGuardianAction(typedData);
      guardian = {
        guardian_signatures: [guardianSig],
        guardian_nonce: nonce.toString(),
        guardian_deadline: deadline.toString(),
      };
    } catch (err) {
      return { data: null, error: err instanceof Error ? err.message : 'Guardian signature rejected' };
    }
  }

  const res = await callEdgeFunction<ToggleAgentsResponse>('agent-admin', {
    dao_address: daoAddress,
    wallet: walletAddress,
    message,
    signature,
    enabled,
    chain,
    chain_id: chainId,
    ...(guardian ?? {}),
  });
  if (res.error) return res;
  if (res.data && res.data.error) {
    return { data: res.data, error: res.data.error };
  }
  return {
    data: res.data ? { ...res.data, success: res.data.success ?? true } : null,
    error: null,
  };
}

export interface ClearHaltResponse {
  success?: boolean;
  signature?: string;
  tx_hash?: string;
  status?: string;
  error?: string;
}

/**
 * Founder-gated clear-halt proxy (`agent-admin` with `action: 'clear_halt'`).
 * Verifies a fresh founder wallet signature on Solana or EVM, runs the
 * deterministic operational gate, and submits `operational_clear` /
 * `operationalClear` via the custodied `operational` agent key.
 */
export async function clearHaltViaProxy(input: {
  daoAddress: string;
  walletAddress: string;
  executionRequestAddress: string;
  signChallenge: DaoAccessMessageSigner;
  chain?: ChainFamily;
  chainId?: number | null;
  executionAddress?: string;
  index?: number;
}): Promise<{ data: ClearHaltResponse | null; error: string | null }> {
  const evm = input.chain !== undefined && input.chain !== 'solana';
  const daoField = evm ? input.daoAddress.toLowerCase() : input.daoAddress;
  const targetField = input.executionRequestAddress.trim();
  const message = `nave-admin|${daoField}|clear_halt|${targetField}|${Date.now()}`;
  let signature: string;
  try {
    signature = await input.signChallenge(message);
  } catch (err) {
    return { data: null, error: err instanceof Error ? err.message : 'Message signing rejected' };
  }

  const res = await callEdgeFunction<ClearHaltResponse>('agent-admin', {
    action: 'clear_halt',
    dao_address: input.daoAddress,
    wallet: input.walletAddress,
    message,
    signature,
    execution_request_address: targetField,
    ...(input.chain ? { chain: input.chain } : {}),
    ...(input.chainId != null ? { chain_id: input.chainId } : {}),
    ...(input.executionAddress ? { execution_address: input.executionAddress } : {}),
    ...(input.index != null ? { index: input.index } : {}),
  });
  if (res.error) return res;
  if (res.data && res.data.error) {
    return { data: res.data, error: res.data.error };
  }
  return {
    data: res.data ? { ...res.data, success: res.data.success ?? true } : null,
    error: null,
  };
}
export interface EvmGuardianFreezeResponse {
  success: boolean;
  dao_address: string;
  freeze: boolean;
  nonce: string;
  deadline: string;
  signatures: `0x${string}`[];
  signers: string[];
  chain_id: number;
}

/**
 * Collect M-of-N EIP-712 guardian freeze/unfreeze signatures from custodied
 * guardian EOAs (via signer `/sign-evm`). The founder signs an EIP-191 challenge;
 * the returned signatures are submitted on-chain via `buildEmergencyFreezeEvm`.
 */
export async function collectEvmGuardianFreezeSigs(
  daoAddress: string,
  walletAddress: string,
  signMessageHex: (message: string) => Promise<string>,
  freeze: boolean,
  chainId: number,
  chain: EvmChainFamily,
  opts?: { nonce?: bigint; deadline?: bigint; guardianCount?: number },
): Promise<{ data: EvmGuardianFreezeResponse | null; error: string | null }> {
  const message = `nave-admin|${daoAddress}|emergency_freeze|${freeze ? '1' : '0'}|${Date.now()}`;
  let signature: string;
  try {
    signature = await signMessageHex(message);
  } catch (err) {
    return { data: null, error: err instanceof Error ? err.message : 'Message signing rejected' };
  }

  return callEdgeFunction<EvmGuardianFreezeResponse>('evm-guardian-freeze', {
    dao_address: daoAddress,
    wallet: walletAddress,
    message,
    signature,
    freeze,
    chain,
    chain_id: chainId,
    nonce: opts?.nonce?.toString(),
    deadline: opts?.deadline?.toString(),
    guardian_count: opts?.guardianCount ?? 3,
  });
}

export interface EvmStrategyWithdrawResponse {
  success: boolean;
  dao_address: string;
  index: string;
  amount: string;
  tx_hash: string | null;
  chain_id: number;
}

/**
 * Founder-gated EVM strategy unwind: EIP-191 challenge → edge fn → signer
 * `/relay-evm` broadcasts `withdrawFromStrategy` from the custodied Executive.
 * Pass a positive `minOut` on mainnet (see `resolveEvmMinOut`).
 */
export async function withdrawStrategyViaProxyEvm(
  daoAddress: string,
  walletAddress: string,
  signMessageHex: (message: string) => Promise<string>,
  opts: {
    chainId: number;
    chain: EvmChainFamily;
    executionAddress: string;
    index: number;
    amount: string;
    minOut?: string;
  },
): Promise<{ data: EvmStrategyWithdrawResponse | null; error: string | null }> {
  const indexStr = String(opts.index);
  const amountStr = opts.amount;
  const minOutField = opts.minOut && opts.minOut !== '' ? opts.minOut : '0';
  const message = `nave-admin|${daoAddress}|withdraw_from_strategy|${indexStr}|${amountStr}|${minOutField}|${Date.now()}`;
  let signature: string;
  try {
    signature = await signMessageHex(message);
  } catch (err) {
    return { data: null, error: err instanceof Error ? err.message : 'Message signing rejected' };
  }

  return callEdgeFunction<EvmStrategyWithdrawResponse>('evm-strategy-withdraw', {
    dao_address: daoAddress,
    wallet: walletAddress,
    message,
    signature,
    chain: opts.chain,
    chain_id: opts.chainId,
    execution_address: opts.executionAddress,
    index: indexStr,
    amount: amountStr,
    min_out: opts.minOut,
  });
}

/**
 * EVM manual dispatch via orchestrator-proxy (founder EIP-191 challenge).
 * `executionRequest` is a bare index ("3") or "0xExecution#3".
 */
export async function dispatchViaProxyEvm(
  daoAddress: string,
  walletAddress: string,
  signMessageHex: (message: string) => Promise<string>,
  executionRequest: string,
  chainId: number,
  chain: EvmChainFamily,
  index: number,
): Promise<{ data: OrchestratorResponse | null; error: string | null }> {
  const target = executionRequest || String(index);
  const message = `nave-dispatch|${daoAddress}|${target}|${Date.now()}`;
  let signature: string;
  try {
    signature = await signMessageHex(message);
  } catch (err) {
    return { data: null, error: err instanceof Error ? err.message : 'Message signing rejected' };
  }

  return callEdgeFunction<OrchestratorResponse>('orchestrator-proxy', {
    dao_address: daoAddress,
    execution_request_address: target,
    wallet: walletAddress,
    message,
    signature,
    chain,
    chain_id: chainId,
    index,
  });
}

export interface FounderMetadataResult {
  success: boolean;
  public_url?: string;
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/**
 * Founder-signed logo, token image, or hidden-asset write.
 * The signed subject is the image hash or `chain:asset`, so the body cannot
 * be swapped after the wallet signs.
 */
export async function founderMetadata(input: {
  action: 'upload_logo' | 'set_token_image' | 'hide_asset' | 'unhide_asset';
  daoAddress: string;
  wallet: string;
  signChallenge: DaoAccessMessageSigner;
  chain?: string;
  chainId?: number | null;
  image?: Blob;
  mint?: string;
  assetChain?: string;
  assetIdentifier?: string;
}): Promise<{ data: FounderMetadataResult | null; error: string | null }> {
  const evm = input.chain !== undefined && input.chain !== 'solana';
  const dao = evm ? input.daoAddress.toLowerCase() : input.daoAddress;
  const wallet = evm ? input.wallet.toLowerCase() : input.wallet;
  let subject = '';
  let image_base64: string | undefined;
  let content_type: string | undefined;
  if (input.action === 'upload_logo' || input.action === 'set_token_image') {
    if (!input.image) return { data: null, error: 'Image is required' };
    const raw = await input.image.arrayBuffer();
    const bytes = new Uint8Array(raw);
    if (bytes.length === 0 || bytes.length > 1_500_000) {
      return { data: null, error: 'Image must be under 1.5 MB' };
    }
    const hash = await sha256Hex(raw);
    const type = input.image.type === 'image/png' || input.image.type === 'image/webp'
      ? input.image.type
      : 'image/jpeg';
    subject = input.action === 'set_token_image' ? `${input.mint ?? ''}:${hash}` : hash;
    image_base64 = bytesToBase64(bytes);
    content_type = type;
  } else {
    subject = `${input.assetChain ?? ''}:${input.assetIdentifier ?? ''}`;
  }
  const message = `nave-founder-meta|${input.action}|${dao}|${subject}|${Date.now()}|${makeChallengeNonce()}`;
  let signature: string;
  try {
    signature = await input.signChallenge(message);
  } catch (err) {
    return { data: null, error: err instanceof Error ? err.message : 'Message signing rejected' };
  }
  return callEdgeFunction<FounderMetadataResult>('founder-metadata', {
    action: input.action,
    dao_address: dao,
    wallet,
    message,
    signature,
    chain: input.chain,
    chain_id: input.chainId ?? undefined,
    image_base64,
    content_type,
    mint: input.mint,
    asset_chain: input.assetChain,
    asset_identifier: input.assetIdentifier,
  });
}

/** Ask for another independent check. Sends the case id, the pause reason, and new evidence. Never a verdict, and never a blank appeal. */
export async function askForAnotherCheck(input: {
  chain_family: ChainFamily;
  network: 'mainnet' | 'testnet' | 'devnet';
  treasury: string;
  action_hash: string;
  pause_reason?: string;
  counterevidence: string;
}): Promise<{ data: { success?: boolean } | null; error: string | null }> {
  const counterevidence = input.counterevidence.trim();
  const rejected = counterevidenceError(counterevidence);
  if (rejected) return { data: null, error: rejected };
  return callEdgeFunction('genlayer-adjudicator', {
    mode: 'appeal',
    chain_family: input.chain_family,
    network: input.network,
    treasury: input.treasury,
    action_hash: input.action_hash,
    pause_reason: input.pause_reason,
    counterevidence,
    venue: 'move',
    amount: '0',
    asset: 'asset',
  });
}
