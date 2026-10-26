import { SUPABASE_ANON_KEY, SUPABASE_FUNCTIONS_URL } from '../programConfig';
import { supabase, setSupabaseWalletAddress } from '../supabaseClient';
import { redactMercurySecrets } from '../../../supabase/functions/_shared/mercury.ts';

export interface MercuryAccountRow {
  id: string;
  mercury_id: string;
  name: string;
  nickname: string;
  kind: string;
  status: string;
  account_type: string;
  last4: string;
  available_cents: number;
  current_cents: number;
  dashboard_link: string;
  gl_account_id: string | null;
}

export interface MercuryStatus {
  connected: boolean;
  token_hint: string;
  environment: 'sandbox' | 'production' | null;
  sync_start: string | null;
  auto_match: boolean;
  last_sync_at: string | null;
  last_error: string;
  payables: boolean;
  expenses: boolean;
  pending: number;
  unmatched: number;
  transactions: number;
  total_available_cents: number;
  total_current_cents: number;
  accounts: MercuryAccountRow[];
}

export interface MercuryTxnRow {
  id: string;
  mercury_id: string;
  account_id: string;
  amount_cents: number;
  status: string;
  kind: string;
  counterparty: string;
  bank_description: string;
  note: string;
  external_memo: string;
  posted_at: string | null;
  mercury_created_at: string | null;
  dashboard_link: string;
  match_type: 'payment' | 'bill_payment' | 'cash_entry' | 'feed' | null;
  match_id: string | null;
  match_created: boolean;
  ignored: boolean;
}

export interface ReconAccountRow {
  id: string;
  code: string;
  name: string;
  account_type: string;
  subtype: string;
  balance_cents: number;
  last_reconciled: string | null;
  open_recon: string | null;
  locked_through: string | null;
  mercury: { mercury_id: string; name: string; nickname: string; last4: string; current_cents: number }[];
}

export interface ReconDetail {
  recon: {
    id: string;
    account_id: string;
    statement_date: string;
    statement_balance_cents: number;
    begin_balance_cents: number;
    status: 'open' | 'finished';
    notes: string;
    finished_at: string | null;
  };
  account: { id: string; code: string; name: string; account_type: string; subtype: string };
  items: {
    clear_key: string;
    date: string;
    memo: string;
    ref: string;
    party: string;
    source_type: string;
    source_id: string;
    amount_cents: number;
    cleared: boolean;
    mercury: { id: string; status: string; posted: string | null } | null;
  }[];
  cleared_cents: number;
  cleared_balance_cents: number;
  difference_cents: number;
  flags: { level: 'error' | 'warn'; key: string | null; text: string }[];
  book_balance_cents: number;
  locked_through: string | null;
}

function fail(error: { message: string } | null): void {
  if (error) throw new Error(error.message);
}

export function mercuryMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : 'The bank feed could not be updated.';
  const text = redactMercurySecrets(raw);
  if (text.includes('not_authorized')) return 'This wallet cannot change the books for this treasury.';
  if (text.includes('invalid_mercury_token')) {
    return 'That does not look like a Mercury API token. It should start with "secret-token:mercury_production_".';
  }
  if (text.includes('payables_unavailable')) return 'Bills are not on this treasury yet. Record the line as an expense.';
  if (text.includes('difference_not_zero')) return 'The difference has to be 0.00 before this statement can be finished.';
  if (text.includes('reconciliation_unbalanced')) return 'A cleared line changed. Fix that before finishing.';
  if (text.includes('account_locked')) return 'Clear this account lock before undoing the reconciliation.';
  if (text.includes('later_reconciliation')) return 'Undo the later reconciliation on this account first.';
  if (text.includes('reconciliation_open')) return 'This account already has a reconciliation in progress.';
  if (text.includes('statement_not_after_last')) return 'The statement date has to be after the last finished statement.';
  if (text.includes('already_matched')) return 'This bank transaction is already matched.';
  if (text.includes('amounts_differ')) return 'The amounts do not match the bank transaction.';
  if (text.includes('not_posted')) return 'Only posted bank transactions can be matched.';
  if (text.includes('inflow_required')) return 'Only incoming money can pay an invoice or be recorded as a deposit.';
  if (text.includes('outflow_required')) return 'Only outgoing money can pay a bill or be recorded as an expense.';
  return text;
}

async function mercuryEdge(wallet: string, body: object): Promise<Record<string, unknown>> {
  const response = await fetch(`${SUPABASE_FUNCTIONS_URL}/pay-mercury`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'x-wallet-address': wallet,
    },
    body: JSON.stringify(body),
  });
  const data = await response.json() as { error?: string };
  if (!response.ok) throw new Error(redactMercurySecrets(data.error || `HTTP ${response.status}`));
  return data as Record<string, unknown>;
}

export async function fetchMercuryStatus(treasuryGroupId: string, wallet: string | null): Promise<MercuryStatus> {
  setSupabaseWalletAddress(wallet);
  const { data, error } = await supabase.rpc('pay_mercury_status', { p_treasury: treasuryGroupId });
  fail(error);
  return data as MercuryStatus;
}

export interface GlAccountOption {
  id: string;
  code: string;
  name: string;
  account_type: string;
  subtype: string;
}

export async function fetchGlAccounts(treasuryGroupId: string, wallet: string | null): Promise<GlAccountOption[]> {
  setSupabaseWalletAddress(wallet);
  const { data, error } = await supabase
    .from('pay_accounts')
    .select('id, code, name, account_type, subtype')
    .eq('treasury_group_id', treasuryGroupId)
    .eq('archived', false)
    .order('code');
  fail(error);
  return (data ?? []) as GlAccountOption[];
}

export async function fetchMercuryTransactions(treasuryGroupId: string, wallet: string | null): Promise<MercuryTxnRow[]> {
  setSupabaseWalletAddress(wallet);
  const { data, error } = await supabase
    .from('pay_mercury_transactions')
    .select('id, mercury_id, account_id, amount_cents, status, kind, counterparty, bank_description, note, external_memo, posted_at, mercury_created_at, dashboard_link, match_type, match_id, match_created, ignored')
    .eq('treasury_group_id', treasuryGroupId)
    .order('posted_at', { ascending: false, nullsFirst: false })
    .limit(1000);
  fail(error);
  return (data ?? []) as MercuryTxnRow[];
}

export interface MatchInvoice {
  id: string;
  number: string;
  status: string;
  total_cents: number;
  customer_name: string;
}

export interface MatchPayment {
  id: string;
  invoice_id: string;
  amount_cents: number;
  paid_on: string;
  number: string;
}

export interface MatchBill {
  id: string;
  ref: string;
  amount_cents: number;
  status: string;
  vendor_name: string;
}

export interface MatchBillPayment {
  id: string;
  bill_id: string;
  amount_cents: number;
  paid_on: string;
  vendor_name: string;
}

export interface MatchCash {
  id: string;
  direction: 'in' | 'out';
  amount_cents: number;
  entry_date: string;
  category: string;
}

function oneName(value: { name?: string } | { name?: string }[] | null | undefined): string {
  if (!value) return '';
  if (Array.isArray(value)) return value[0]?.name ?? '';
  return value.name ?? '';
}

export async function fetchMatchBooks(treasuryGroupId: string, wallet: string | null): Promise<{
  invoices: MatchInvoice[];
  payments: MatchPayment[];
  bills: MatchBill[];
  billPayments: MatchBillPayment[];
  cash: MatchCash[];
}> {
  setSupabaseWalletAddress(wallet);
  const invoicesQuery = await supabase
    .from('pay_invoices')
    .select('id, number, status, total_cents, customer:pay_customers(name)')
    .eq('treasury_group_id', treasuryGroupId)
    .in('status', ['sent', 'draft']);
  fail(invoicesQuery.error);
  const paymentsQuery = await supabase
    .from('pay_payments')
    .select('id, invoice_id, amount_cents, paid_on, invoice:pay_invoices(number)')
    .eq('treasury_group_id', treasuryGroupId);
  fail(paymentsQuery.error);
  const billsQuery = await supabase
    .from('pay_bills')
    .select('id, ref, amount_cents, status, vendor:pay_vendors(name)')
    .eq('treasury_group_id', treasuryGroupId)
    .eq('status', 'open');
  const billPayQuery = billsQuery.error
    ? { data: [], error: billsQuery.error }
    : await supabase
      .from('pay_bill_payments')
      .select('id, bill_id, amount_cents, paid_on, bill:pay_bills(vendor:pay_vendors(name))')
      .eq('treasury_group_id', treasuryGroupId);
  const cashQuery = await supabase
    .from('pay_cash_entries')
    .select('id, direction, amount_cents, entry_date, category')
    .eq('treasury_group_id', treasuryGroupId);
  return {
    invoices: ((invoicesQuery.data ?? []) as {
      id: string;
      number: string;
      status: string;
      total_cents: number;
      customer: { name?: string } | { name?: string }[] | null;
    }[]).map((row) => ({
      id: row.id,
      number: row.number,
      status: row.status,
      total_cents: row.total_cents,
      customer_name: oneName(row.customer),
    })),
    payments: ((paymentsQuery.data ?? []) as {
      id: string;
      invoice_id: string;
      amount_cents: number;
      paid_on: string;
      invoice: { number?: string } | { number?: string }[] | null;
    }[]).map((row) => ({
      id: row.id,
      invoice_id: row.invoice_id,
      amount_cents: row.amount_cents,
      paid_on: row.paid_on,
      number: Array.isArray(row.invoice) ? row.invoice[0]?.number ?? '' : row.invoice?.number ?? '',
    })),
    bills: billsQuery.error ? [] : ((billsQuery.data ?? []) as {
      id: string;
      ref: string;
      amount_cents: number;
      status: string;
      vendor: { name?: string } | { name?: string }[] | null;
    }[]).map((row) => ({
      id: row.id,
      ref: row.ref,
      amount_cents: row.amount_cents,
      status: row.status,
      vendor_name: oneName(row.vendor),
    })),
    billPayments: billPayQuery.error ? [] : ((billPayQuery.data ?? []) as {
      id: string;
      bill_id: string;
      amount_cents: number;
      paid_on: string;
      bill: { vendor?: { name?: string } | { name?: string }[] | null } | null;
    }[]).map((row) => {
      const bill = Array.isArray(row.bill) ? row.bill[0] : row.bill;
      return {
        id: row.id,
        bill_id: row.bill_id,
        amount_cents: row.amount_cents,
        paid_on: row.paid_on,
        vendor_name: oneName(bill?.vendor ?? null),
      };
    }),
    cash: cashQuery.error ? [] : (cashQuery.data ?? []) as MatchCash[],
  };
}

export async function connectMercury(treasuryGroupId: string, wallet: string, token: string): Promise<void> {
  await mercuryEdge(wallet, { action: 'connect', treasury_group_id: treasuryGroupId, token });
}

export async function syncMercury(
  treasuryGroupId: string,
  wallet: string,
): Promise<{ accounts: number; new: number; updated: number }> {
  const data = await mercuryEdge(wallet, { action: 'sync', treasury_group_id: treasuryGroupId });
  const result = data.result as { accounts?: number; new?: number; updated?: number } | undefined;
  return {
    accounts: result?.accounts ?? 0,
    new: result?.new ?? 0,
    updated: result?.updated ?? 0,
  };
}

export async function saveMercurySettings(
  treasuryGroupId: string,
  wallet: string | null,
  syncStart: string,
  autoMatch: boolean,
): Promise<void> {
  setSupabaseWalletAddress(wallet);
  const { error } = await supabase.rpc('pay_mercury_save_settings', {
    p_treasury: treasuryGroupId,
    p_sync_start: syncStart,
    p_auto_match: autoMatch,
  });
  fail(error);
}

export async function disconnectMercury(treasuryGroupId: string, wallet: string | null, forget: boolean): Promise<void> {
  setSupabaseWalletAddress(wallet);
  const { error } = await supabase.rpc('pay_mercury_disconnect', {
    p_treasury: treasuryGroupId,
    p_forget: forget,
  });
  fail(error);
}

export async function linkMercuryAccount(
  treasuryGroupId: string,
  wallet: string | null,
  mercuryId: string,
  glAccountId: string | null,
): Promise<void> {
  setSupabaseWalletAddress(wallet);
  const { error } = await supabase.rpc('pay_mercury_link_gl', {
    p_treasury: treasuryGroupId,
    p_mercury_id: mercuryId,
    p_gl: glAccountId,
  });
  fail(error);
}

export async function matchMercury(
  treasuryGroupId: string,
  wallet: string | null,
  mercuryId: string,
  body: Record<string, unknown>,
): Promise<void> {
  setSupabaseWalletAddress(wallet);
  const { error } = await supabase.rpc('pay_mercury_match', {
    p_treasury: treasuryGroupId,
    p_mercury_id: mercuryId,
    p_body: body,
  });
  fail(error);
}

export async function unmatchMercury(treasuryGroupId: string, wallet: string | null, mercuryId: string): Promise<void> {
  setSupabaseWalletAddress(wallet);
  const { error } = await supabase.rpc('pay_mercury_unmatch', {
    p_treasury: treasuryGroupId,
    p_mercury_id: mercuryId,
  });
  fail(error);
}

export async function autoMatchMercury(treasuryGroupId: string, wallet: string | null): Promise<number> {
  setSupabaseWalletAddress(wallet);
  const { data, error } = await supabase.rpc('pay_mercury_automatch', { p_treasury: treasuryGroupId });
  fail(error);
  return Number(data ?? 0);
}

export async function fetchReconAccounts(treasuryGroupId: string, wallet: string | null): Promise<ReconAccountRow[]> {
  setSupabaseWalletAddress(wallet);
  const { data, error } = await supabase.rpc('pay_recon_accounts', { p_treasury: treasuryGroupId });
  fail(error);
  return (data ?? []) as ReconAccountRow[];
}

export async function fetchReconDetail(wallet: string | null, reconId: string): Promise<ReconDetail> {
  setSupabaseWalletAddress(wallet);
  const { data, error } = await supabase.rpc('pay_recon_get', { p_recon: reconId });
  fail(error);
  return data as ReconDetail;
}

export async function startRecon(
  treasuryGroupId: string,
  wallet: string | null,
  accountId: string,
  statementDate: string,
  statementBalance: string,
  notes: string,
): Promise<string> {
  setSupabaseWalletAddress(wallet);
  const { data, error } = await supabase.rpc('pay_recon_start', {
    p_treasury: treasuryGroupId,
    p_account: accountId,
    p_statement_date: statementDate,
    p_statement_balance: statementBalance,
    p_notes: notes,
  });
  fail(error);
  return String(data);
}

export async function setReconCleared(
  wallet: string | null,
  reconId: string,
  keys: string[],
  cleared: boolean,
): Promise<void> {
  setSupabaseWalletAddress(wallet);
  const { error } = await supabase.rpc('pay_recon_set_cleared', {
    p_recon: reconId,
    p_keys: keys,
    p_cleared: cleared,
  });
  fail(error);
}

export async function autoClearRecon(wallet: string | null, reconId: string): Promise<number> {
  setSupabaseWalletAddress(wallet);
  const { data, error } = await supabase.rpc('pay_recon_autoclear', { p_recon: reconId });
  fail(error);
  return Number(data ?? 0);
}

export async function finishRecon(wallet: string | null, reconId: string, lock: boolean): Promise<{ locked_through: string | null }> {
  setSupabaseWalletAddress(wallet);
  const { data, error } = await supabase.rpc('pay_recon_finish', { p_recon: reconId, p_lock: lock });
  fail(error);
  return data as { locked_through: string | null };
}

export async function undoRecon(wallet: string | null, reconId: string): Promise<void> {
  setSupabaseWalletAddress(wallet);
  const { error } = await supabase.rpc('pay_recon_undo', { p_recon: reconId });
  fail(error);
}

export async function clearAccountLock(wallet: string | null, accountId: string): Promise<void> {
  setSupabaseWalletAddress(wallet);
  const { error } = await supabase.rpc('pay_account_lock_clear', { p_account: accountId });
  fail(error);
}
