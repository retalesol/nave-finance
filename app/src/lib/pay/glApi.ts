import { supabase, setSupabaseWalletAddress } from '../supabaseClient';
import { asCents } from './payables';
import type { GlAccount, GlJournalEntry, GlJournalLine } from './gl';
import type { ExportParty } from './glExports';

export interface BooksLock {
  lockedThrough: string | null;
  lockedAt: string | null;
  note: string;
}

export interface AuditHead {
  ok: boolean;
  rows: number;
  headHash: string;
  headSeq: number;
  brokenAt?: number;
  reason?: string;
}

function fail(error: { message: string } | null): void {
  if (error) throw new Error(error.message);
}

function one<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

export function glMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (message.includes('PERIOD_LOCKED')) return 'That date is in a closed period. Reopen the books before posting into it.';
  if (message.includes('trial_balance_unbalanced')) return 'The trial balance does not balance through that date. Fix it before closing.';
  if (message.includes('reopen_confirm')) return 'Reopening a closed period needs confirmation. That change is written to the audit chain.';
  if (message.includes('future_lock')) return 'You cannot lock a future date.';
  if (message.includes('memo_required')) return 'A memo is required on a manual journal entry.';
  if (message.includes('journal_unbalanced')) return 'Debits have to equal credits.';
  if (message.includes('journal_lines')) return 'A journal entry needs at least two lines.';
  if (message.includes('line_both_sides')) return 'Enter a debit or a credit on each line, not both.';
  if (message.includes('account_archived')) return 'That account is inactive.';
  if (message.includes('system_account')) return 'A system account stays active. Posters still use its number.';
  if (message.includes('account_code_in_use')) return 'This account is already used on a journal, so its number stays.';
  if (message.includes('invalid_account')) return 'Choose an active account from this treasury.';
  if (message.includes('manual_only')) return 'Only a manual journal entry can be changed here.';
  if (message.includes('name_required')) return 'An account name is required.';
  if (message.includes('invalid_date')) return 'Enter a valid date.';
  if (message.includes('invalid_amount') || message.includes('invalid amount')) return 'Enter an amount with at most two decimals.';
  if (message.includes('not_authorized')) return 'This wallet cannot change the books for this treasury.';
  if (!message) return 'The books could not be saved.';
  return message;
}

export async function fetchGlAccounts(treasuryGroupId: string, wallet: string | null): Promise<GlAccount[]> {
  setSupabaseWalletAddress(wallet);
  const { data, error } = await supabase
    .from('pay_accounts')
    .select('id, code, name, account_type, subtype, system_key, tax_line, description, archived')
    .eq('treasury_group_id', treasuryGroupId)
    .order('code', { ascending: true });
  fail(error);
  return (data ?? []).map((row) => ({
    id: String(row.id),
    code: String(row.code),
    name: String(row.name),
    accountType: row.account_type as GlAccount['accountType'],
    subtype: String(row.subtype ?? ''),
    archived: Boolean(row.archived),
    systemKey: row.system_key == null ? null : String(row.system_key),
    taxLine: String(row.tax_line ?? ''),
    description: String(row.description ?? ''),
  }));
}

export async function fetchGlEntries(treasuryGroupId: string, wallet: string | null): Promise<GlJournalEntry[]> {
  setSupabaseWalletAddress(wallet);
  const { data, error } = await supabase
    .from('pay_journal_entries')
    .select(`
      id, entry_date, memo, ref, party, source_type, source_id,
      pay_journal_lines (
        line_no, account_id, debit_cents, credit_cents, memo,
        pay_accounts ( code, name )
      )
    `)
    .eq('treasury_group_id', treasuryGroupId)
    .order('entry_date', { ascending: true });
  fail(error);
  return (data ?? []).map((row) => {
    const rawLines = (row.pay_journal_lines ?? []) as Array<Record<string, unknown>>;
    const lines: GlJournalLine[] = rawLines.map((line) => {
      const account = one(line.pay_accounts as { code: string; name: string } | { code: string; name: string }[] | null);
      return {
        lineNo: asCents(line.line_no as number | string),
        accountId: String(line.account_id),
        debitCents: asCents(line.debit_cents as number | string),
        creditCents: asCents(line.credit_cents as number | string),
        memo: String(line.memo ?? ''),
        code: account?.code,
        name: account?.name,
      };
    }).sort((a, b) => a.lineNo - b.lineNo);
    return {
      id: String(row.id),
      date: String(row.entry_date),
      memo: String(row.memo ?? ''),
      ref: String(row.ref ?? ''),
      party: String(row.party ?? ''),
      sourceType: String(row.source_type),
      sourceId: row.source_id == null ? null : String(row.source_id),
      lines,
    };
  });
}

export async function fetchBooksLock(treasuryGroupId: string, wallet: string | null): Promise<BooksLock> {
  setSupabaseWalletAddress(wallet);
  const { data, error } = await supabase
    .from('pay_books_lock')
    .select('locked_through, locked_at, note')
    .eq('treasury_group_id', treasuryGroupId)
    .maybeSingle();
  fail(error);
  return {
    lockedThrough: data?.locked_through ? String(data.locked_through) : null,
    lockedAt: data?.locked_at ? String(data.locked_at) : null,
    note: data?.note ? String(data.note) : '',
  };
}

export async function saveBooksLock(
  treasuryGroupId: string,
  wallet: string | null,
  through: string,
  note: string,
  confirmReopen: boolean,
): Promise<string | null> {
  setSupabaseWalletAddress(wallet);
  const { data, error } = await supabase.rpc('pay_set_books_lock', {
    p_treasury: treasuryGroupId,
    p_through: through,
    p_note: note,
    p_confirm_reopen: confirmReopen,
  });
  fail(error);
  const body = data as { locked_through?: string | null } | null;
  return body?.locked_through ? String(body.locked_through) : null;
}

export async function updateGlAccount(
  wallet: string | null,
  accountId: string,
  name: string,
  active: boolean,
): Promise<void> {
  setSupabaseWalletAddress(wallet);
  const { error } = await supabase.rpc('pay_update_account', {
    p_account: accountId,
    p_name: name,
    p_active: active,
  });
  fail(error);
}

export async function postManualJournal(
  treasuryGroupId: string,
  wallet: string | null,
  body: {
    id?: string;
    date: string;
    memo: string;
    ref: string;
    lines: Array<{ accountId: string; debit: string; credit: string; memo: string }>;
  },
): Promise<string> {
  setSupabaseWalletAddress(wallet);
  const { data, error } = await supabase.rpc('pay_post_manual_journal', {
    p_treasury: treasuryGroupId,
    p_body: {
      id: body.id ?? '',
      date: body.date,
      memo: body.memo,
      ref: body.ref,
      lines: body.lines.map((line) => ({
        account_id: line.accountId,
        debit: line.debit,
        credit: line.credit,
        memo: line.memo,
      })),
    },
  });
  fail(error);
  return String(data);
}

export async function deleteManualJournal(wallet: string | null, entryId: string): Promise<void> {
  setSupabaseWalletAddress(wallet);
  const { error } = await supabase.rpc('pay_delete_manual_journal', { p_entry: entryId });
  fail(error);
}

export async function fetchExportParties(
  treasuryGroupId: string,
  wallet: string | null,
): Promise<{ customers: string[]; vendors: ExportParty[] }> {
  setSupabaseWalletAddress(wallet);
  const [customers, vendors] = await Promise.all([
    supabase.from('pay_customers').select('name').eq('treasury_group_id', treasuryGroupId).order('name'),
    supabase.from('pay_vendors').select('name, is_1099').eq('treasury_group_id', treasuryGroupId).order('name'),
  ]);
  fail(customers.error);
  fail(vendors.error);
  return {
    customers: (customers.data ?? []).map((row) => String(row.name)),
    vendors: (vendors.data ?? []).map((row) => ({ name: String(row.name), is1099: Boolean(row.is_1099) })),
  };
}

export async function verifyAuditChain(treasuryGroupId: string, wallet: string | null): Promise<AuditHead> {
  setSupabaseWalletAddress(wallet);
  const { data, error } = await supabase.rpc('pay_audit_verify', { p_treasury: treasuryGroupId });
  fail(error);
  const body = (data ?? {}) as Record<string, unknown>;
  return {
    ok: body.ok === true,
    rows: Number(body.rows ?? 0),
    headHash: String(body.head_hash ?? 'GENESIS'),
    headSeq: Number(body.head_seq ?? 0),
    brokenAt: body.broken_at == null ? undefined : Number(body.broken_at),
    reason: body.reason == null ? undefined : String(body.reason),
  };
}

export interface AuditListRow {
  seq: number;
  at: string;
  documentType: string;
  op: string;
  documentId: string;
  prevHash: string;
  hash: string;
  payload: string;
}

export async function fetchAuditRows(treasuryGroupId: string, wallet: string | null): Promise<AuditListRow[]> {
  setSupabaseWalletAddress(wallet);
  const { data, error } = await supabase
    .from('pay_audit_log')
    .select('seq, at_text, document_type, op, document_id, prev_hash, hash, payload')
    .eq('treasury_group_id', treasuryGroupId)
    .order('seq', { ascending: false })
    .limit(200);
  fail(error);
  return (data ?? []).map((row) => ({
    seq: Number(row.seq),
    at: String(row.at_text ?? ''),
    documentType: String(row.document_type),
    op: String(row.op),
    documentId: row.document_id == null ? '' : String(row.document_id),
    prevHash: String(row.prev_hash ?? ''),
    hash: String(row.hash ?? ''),
    payload: JSON.stringify(row.payload ?? {}),
  }));
}
