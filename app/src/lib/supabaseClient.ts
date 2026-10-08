import { createClient } from '@supabase/supabase-js';
import { SUPABASE_ANON_KEY, SUPABASE_URL } from './programConfig';

// The connected wallet address is attached to every Supabase request as the
// `x-wallet-address` header so wallet-scoped RLS policies (e.g. watched_daos)
// can isolate rows per wallet. This is a soft boundary (the header is not
// cryptographically authenticated) appropriate for low-sensitivity personal
// data; sensitive tables stay service-role-only.
let currentWalletAddress: string | null = null;

/** Update the wallet header used for subsequent Supabase requests. */
export function setSupabaseWalletAddress(address: string | null): void {
  currentWalletAddress = address;
}

const walletHeaderFetch: typeof fetch = (input, init) => {
  const headers = new Headers(init?.headers ?? {});
  if (currentWalletAddress) {
    headers.set('x-wallet-address', currentWalletAddress);
  }
  return fetch(input, { ...init, headers });
};

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  global: { fetch: walletHeaderFetch },
});

// ─── Dev-only leak guard ─────────────────────────────────────────────────────
// Anything prefixed `VITE_` is a candidate for inlining into the browser bundle.
// A Supabase service/secret key must NEVER carry that prefix (use
// `SUPABASE_SECRET_KEY` / `SUPABASE_SERVICE_ROLE_KEY` server-side only). This
// whole block is gated on `import.meta.env.DEV`, which Vite replaces with
// `false` in production so esbuild drops it — the value is never referenced in
// a shipped bundle. A build-time guard in vite.config.ts (fail the build when
// `VITE_SUPABASE_SECRET_KEY` / `VITE_*SERVICE_ROLE*` is set) is still
// recommended as defense-in-depth.
if (import.meta.env.DEV) {
  const leaked = import.meta.env.VITE_SUPABASE_SECRET_KEY;
  if (typeof leaked === 'string' && leaked.length > 0) {
    console.error(
      '[nave] SECURITY: VITE_SUPABASE_SECRET_KEY is defined in this environment. ' +
        'Any VITE_-prefixed variable can be inlined into the public bundle — remove it ' +
        'from .env.local/.env.* immediately and rotate the key. Server-side code must ' +
        'read the secret from a non-VITE variable.',
    );
  }
}

// ─── Database types matching Supabase schema ─────────────────────────────────

export interface DaoRegistryRow {
  id: string;
  dao_onchain_address: string;
  dao_id: number | null;
  name: string;
  description: string;
  logo_url: string;
  governance_type: 'wallet' | 'token';
  privacy_enabled: boolean;
  voting_token_mint: string | null;
  creator_wallet: string;
  social_twitter: string;
  social_discord: string;
  social_website: string;
  slug: string | null;
  created_at: string;
  updated_at: string;
  /** Chain family discriminator ('solana' | 'ethereum' | 'base'); may be null on legacy rows. */
  chain?: string | null;
  /** EVM numeric chain id (1/8453/11155111/84532); null for Solana / legacy rows. */
  chain_id?: number | null;
}

export interface WatchedDaoRow {
  id: string;
  wallet_address: string;
  dao_onchain_address: string;
  label: string;
  added_at: string;
}

export interface EncryptedAgentKeyRow {
  id: string;
  dao_onchain_address: string;
  agent_role: 'executive' | 'financial' | 'oversight' | 'operational';
  encrypted_private_key: string;
  encryption_iv: string;
  encryption_tag: string;
  public_key: string;
  is_active: boolean;
  created_at: string;
  rotated_at: string | null;
}

export interface ActivityLogRow {
  id: string;
  dao_onchain_address: string;
  event_type: string;
  description: string;
  actor: string;
  agent_role: string | null;
  tx_signature: string;
  slot: number | null;
  block_time: string | null;
  raw_data: Record<string, unknown>;
  created_at: string;
}

export interface TreasurySnapshotRow {
  id: string;
  dao_onchain_address: string;
  total_value_usd: number;
  sol_balance: number;
  usdc_balance: number;
  strategy_positions: unknown[];
  token_balances: unknown[];
  snapshot_at: string;
}

export interface MonthlyReportRow {
  id: string;
  dao_onchain_address: string;
  year: number;
  month: number;
  capital_start: number;
  capital_end: number;
  yield_earned: number;
  fees_collected: number;
  agent_actions_count: number;
  wallet_actions_count: number;
  proposals_count: number;
  summary: Record<string, unknown>;
  created_at: string;
}

export interface AgentActionLogRow {
  id: string;
  dao_onchain_address: string;
  agent_role: 'executive' | 'financial' | 'oversight' | 'operational';
  action_type: string;
  reasoning: string;
  constitution_check: Record<string, unknown>;
  payload_hash: string;
  execution_request_address: string;
  status: string;
  error_message: string;
  created_at: string;
  completed_at: string | null;
  // Claude AI fields
  confidence_score: number | null;
  risk_flags: string[];
  decision: string | null;
  claude_model: string | null;
  /**
   * Full model transcript. Server-only — the browser never selects this column
   * (see AGENT_ACTION_LOG_PUBLIC_COLUMNS) so it can be REVOKEd from anon/authed
   * roles without breaking the UI.
   */
  raw_claude_response?: string | null;
  retry_count: number;
  // Phase 7: deterministic reasoning-hash integrity + on-chain signer outcome.
  reasoning_hash?: string | null;
  tx_signature?: string | null;
}

/**
 * Explicit `agent_action_logs` column list for browser reads. Deliberately
 * EXCLUDES `raw_claude_response` (bulky + operator-only). Keep in sync with the
 * fields consumed by `useAgentStatus`.
 */
export const AGENT_ACTION_LOG_PUBLIC_COLUMNS = [
  'id',
  'dao_onchain_address',
  'agent_role',
  'action_type',
  'reasoning',
  'constitution_check',
  'payload_hash',
  'execution_request_address',
  'status',
  'error_message',
  'created_at',
  'completed_at',
  'confidence_score',
  'risk_flags',
  'decision',
  'claude_model',
  'retry_count',
  'reasoning_hash',
  'tx_signature',
].join(', ');

/** `AgentActionLogRow` as returned by a `AGENT_ACTION_LOG_PUBLIC_COLUMNS` select. */
export type AgentActionLogPublicRow = Omit<AgentActionLogRow, 'raw_claude_response'>;

export interface SignerLabelRow {
  id: string;
  dao_onchain_address: string;
  wallet_address: string;
  label: string;
  updated_at: string;
}