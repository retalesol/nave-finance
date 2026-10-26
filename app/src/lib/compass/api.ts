import { SUPABASE_ANON_KEY, SUPABASE_FUNCTIONS_URL } from '../programConfig';

const SESSION_KEY = 'nave.compass.session';

export class CompassError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string) {
    super(code);
    this.name = 'CompassError';
    this.status = status;
    this.code = code;
  }
}

export interface CompassSession {
  token: string;
  expiresAt: string;
}

export interface CompassDeployment {
  chain: string;
  chain_id: number | null;
  network: string | null;
  dao_onchain_address: string;
  governance_type: string;
  name: string;
  creator_wallet?: string;
  voting_token_mint?: string | null;
  created_at?: string;
}

export interface CompassTreasuryRow {
  treasury_group_id: string;
  name: string;
  slug: string | null;
  privacy_enabled: boolean;
  created_at: string;
  deployments: CompassDeployment[];
  pay_enabled: boolean;
  subscription_state: string;
  period_end: string | null;
  term_months: number | null;
  subscription_source: string | null;
  latest_value_usd: string | null;
  snapshot_at: string | null;
}

export interface CompassOverview {
  generated_at: string;
  treasuries: {
    deployments: number;
    groups: number;
    private_groups: number;
    created_7d: number;
    created_30d: number;
  };
  chains: { chain: string; chain_id: number | null; network: string | null; deployments: number }[];
  pay: {
    enabled: number;
    subscriptions: { active: number; grace: number; locked: number; purged: number; none: number };
    collected_cents: number;
    granted_cents: number;
  };
  upcoming: {
    treasury_group_id: string;
    name: string;
    state: string;
    period_end: string;
    source: string;
    term_months: number;
  }[];
  books: {
    invoices_by_status: Record<string, number>;
    invoice_total_cents: number;
    customers: number;
    vendors: number;
    bills: number;
    employees: number;
    active_employees: number;
  };
  activity_24h: number;
  activity_7d: number;
  proposals: Record<string, number>;
  bridges: Record<string, number>;
  snapshotted_value_usd: string;
  watchers: number;
  withheld: string[];
}

export interface CompassSnapshot {
  chain: string;
  chain_id: number | null;
  dao_onchain_address: string;
  total_value_usd: string;
  sol_balance: string;
  usdc_balance: string;
  snapshot_at: string;
  reconciliation_status: string;
}

export interface CompassEvent {
  at: string;
  event_type: string;
  detail: string;
  chain: string;
  chain_id: number | null;
}

export interface CompassTreasuryDetail {
  treasury_group_id: string;
  name: string;
  slug: string | null;
  privacy_enabled: boolean;
  created_at: string;
  description: string;
  website: string;
  deployments: CompassDeployment[];
  pay: {
    enabled: boolean;
    enabled_at: string | null;
    subscription: {
      state: string;
      period_end: string | null;
      term_months: number | null;
      price_cents: number;
      source: string;
      updated_at: string;
    } | null;
  };
  counts: {
    invoices: number;
    invoices_by_status: Record<string, number>;
    invoice_total_cents: number;
    customers: number;
    vendors: number;
    bills: number;
    employees: number;
    active_employees: number;
    journal_entries: number;
    watchers: number;
    authorized_wallets: number;
  };
  snapshots: CompassSnapshot[];
  recent_events: CompassEvent[];
}

export interface CompassHappening {
  at: string;
  kind: string;
  title: string;
  detail: string;
  treasury_group_id: string | null;
  treasury_name: string | null;
  private: boolean;
}

export interface CompassAuditRow {
  id: string;
  actor: string;
  action: string;
  treasury_group_id: string | null;
  treasury_name: string | null;
  detail: {
    reason?: string;
    term_months?: number;
    price_cents?: number;
    period_end?: string;
    previous_source?: string | null;
    previous_period_end?: string | null;
  };
  created_at: string;
}

export interface CompassGrant {
  treasury_group_id: string;
  term_months: number;
  price_cents: number;
  period_end: string;
  state: string;
  source: string;
  extended: boolean;
}

export function loadCompassSession(): CompassSession | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CompassSession;
    if (!parsed?.token || !parsed.expiresAt || Date.parse(parsed.expiresAt) <= Date.now()) {
      sessionStorage.removeItem(SESSION_KEY);
      return null;
    }
    return parsed;
  } catch {
    sessionStorage.removeItem(SESSION_KEY);
    return null;
  }
}

export function storeCompassSession(session: CompassSession) {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function clearCompassSession() {
  sessionStorage.removeItem(SESSION_KEY);
}

export async function compassRequest<T>(
  session: CompassSession | null,
  action: string,
  body: Record<string, unknown> = {},
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    apikey: SUPABASE_ANON_KEY,
  };
  if (session?.token) headers['X-Compass-Session'] = session.token;

  let response: Response;
  try {
    response = await fetch(`${SUPABASE_FUNCTIONS_URL}/compass`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ action, ...body }),
      cache: 'no-store',
    });
  } catch {
    throw new CompassError(0, 'network');
  }

  let payload: { error?: string } = {};
  try {
    payload = await response.json();
  } catch {
    throw new CompassError(response.status, 'bad_response');
  }
  if (!response.ok) {
    throw new CompassError(response.status, payload.error || 'request_failed');
  }
  return payload as T;
}

export function explainCompassError(error: unknown): string {
  if (!(error instanceof CompassError)) return 'Compass could not be reached.';
  if (error.status === 429 || error.code === 'too_many_requests' || error.code === 'Too many requests' || error.code === 'grant_rate_limited') {
    return error.code === 'grant_rate_limited'
      ? 'Compass has already recorded 30 grants in the last hour.'
      : 'Too many attempts. Wait a few minutes and try again.';
  }
  if (error.code === 'compass_not_configured') return 'Compass is not configured on the server yet.';
  if (error.code === 'invalid_credentials' || error.code === 'unauthorized') return 'Those credentials were not accepted.';
  if (error.code === 'invalid_reason') return 'Write a short reason for the grant.';
  if (error.code === 'invalid_term') return 'Choose a 1, 3, or 12 month term.';
  if (error.code === 'unknown_treasury') return 'That treasury is not in the registry.';
  if (error.code === 'network') return 'Compass could not be reached.';
  return 'Compass could not complete that request.';
}
