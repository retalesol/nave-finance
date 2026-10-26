import { sha256 } from '@noble/hashes/sha256';

/**
 * General ledger reports for one treasury.
 *
 * Figures come from pay_journal_lines. Money is integer cents. The fiscal year
 * starts in January, matching the desktop default. A trial balance is in
 * balance when total debits equal total credits.
 */

export class BooksError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'BooksError';
    this.code = code;
  }
}

export type AccountType = 'asset' | 'liability' | 'equity' | 'income' | 'expense';
export type PnlGroup = 'revenue' | 'cogs' | 'expense' | 'other_income' | 'other_expense';

export interface GlAccount {
  id: string;
  code: string;
  name: string;
  accountType: AccountType;
  subtype: string;
  archived: boolean;
  systemKey: string | null;
  taxLine: string;
  description: string;
}

export interface GlJournalLine {
  lineNo: number;
  accountId: string;
  debitCents: number;
  creditCents: number;
  memo: string;
  code?: string;
  name?: string;
}

export interface GlJournalEntry {
  id: string;
  date: string;
  memo: string;
  ref: string;
  party: string;
  sourceType: string;
  sourceId: string | null;
  lines: GlJournalLine[];
}

export interface TrialBalanceRow {
  accountId: string;
  code: string;
  name: string;
  accountType: AccountType;
  debitCents: number;
  creditCents: number;
}

export interface TrialBalance {
  asOf: string;
  rows: TrialBalanceRow[];
  totalDebit: number;
  totalCredit: number;
  balanced: boolean;
}

export interface BalanceRow {
  accountId: string | null;
  code: string;
  name: string;
  subtype: string;
  balanceCents: number;
}

export interface BalanceSheet {
  asOf: string;
  fyStart: string;
  sections: { asset: BalanceRow[]; liability: BalanceRow[]; equity: BalanceRow[] };
  totals: { asset: number; liability: number; equity: number };
  liabilitiesAndEquity: number;
  balanced: boolean;
}

export interface PnlRow {
  accountId: string;
  code: string;
  name: string;
  amountCents: number;
}

export interface ProfitAndLoss {
  from: string;
  to: string;
  groups: Record<PnlGroup, PnlRow[]>;
  revenue: number;
  grossProfit: number;
  operatingIncome: number;
  netIncome: number;
  basis: 'accrual';
}

export interface ManualJournalLine {
  accountId: string;
  debitCents: number;
  creditCents: number;
  memo: string;
}

export interface ManualJournalDraft {
  date: string;
  memo: string;
  ref: string;
  lines: ManualJournalLine[];
}

export interface AuditHashInput {
  prevHash: string;
  seq: number;
  at: string;
  documentType: string;
  op: string;
  documentId: string | null;
  before: unknown | null;
  payload: unknown | null;
}

const PNL_GROUPS: PnlGroup[] = ['revenue', 'cogs', 'expense', 'other_income', 'other_expense'];

export function normalDebit(accountType: string): boolean {
  return accountType === 'asset' || accountType === 'expense';
}

export function fiscalYearStart(asOf: string, fyStartMonth = 1): string {
  const month = Math.min(12, Math.max(1, fyStartMonth));
  const year = Number(asOf.slice(0, 4));
  const start = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-01`;
  if (start > asOf) return `${String(year - 1).padStart(4, '0')}-${String(month).padStart(2, '0')}-01`;
  return start;
}

export function dayBefore(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

export function assertOpenPeriod(date: string, lockedThrough: string | null | undefined): void {
  const lock = lockedThrough?.trim() || null;
  if (lock && date <= lock) throw new BooksError('PERIOD_LOCKED');
}

export function validateManualJournal(input: {
  date: string;
  memo: string;
  ref?: string;
  lockedThrough?: string | null;
  lines: Array<{
    accountId: string;
    debitCents: number;
    creditCents: number;
    memo?: string;
    archived?: boolean;
  }>;
}): ManualJournalDraft {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new BooksError('invalid_date');
  const memo = input.memo.trim();
  if (!memo) throw new BooksError('memo_required');
  assertOpenPeriod(input.date, input.lockedThrough ?? null);
  const lines: ManualJournalLine[] = [];
  for (const line of input.lines) {
    const debit = line.debitCents;
    const credit = line.creditCents;
    if (!Number.isInteger(debit) || !Number.isInteger(credit) || debit < 0 || credit < 0) {
      throw new BooksError('invalid_amount');
    }
    if (debit === 0 && credit === 0) continue;
    if (debit > 0 && credit > 0) throw new BooksError('line_both_sides');
    if (!line.accountId) throw new BooksError('invalid_account');
    if (line.archived) throw new BooksError('account_archived');
    lines.push({
      accountId: line.accountId,
      debitCents: debit,
      creditCents: credit,
      memo: (line.memo ?? '').trim(),
    });
  }
  if (lines.length < 2) throw new BooksError('journal_lines');
  const debit = lines.reduce((sum, line) => sum + line.debitCents, 0);
  const credit = lines.reduce((sum, line) => sum + line.creditCents, 0);
  if (debit !== credit) throw new BooksError('journal_unbalanced');
  return { date: input.date, memo, ref: (input.ref ?? '').trim(), lines };
}

function inRange(date: string, from: string | null, to: string | null): boolean {
  if (from && date < from) return false;
  if (to && date > to) return false;
  return true;
}

function sums(entries: GlJournalEntry[], from: string | null, to: string | null): Map<string, { dr: number; cr: number }> {
  const out = new Map<string, { dr: number; cr: number }>();
  for (const entry of entries) {
    if (!inRange(entry.date, from, to)) continue;
    for (const line of entry.lines) {
      const current = out.get(line.accountId) ?? { dr: 0, cr: 0 };
      current.dr += line.debitCents;
      current.cr += line.creditCents;
      out.set(line.accountId, current);
    }
  }
  return out;
}

function byCode<T extends { code: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => a.code.localeCompare(b.code));
}

export function trialBalance(accounts: GlAccount[], entries: GlJournalEntry[], asOf: string): TrialBalance {
  const activity = sums(entries, null, asOf);
  const rows: TrialBalanceRow[] = [];
  let totalDebit = 0;
  let totalCredit = 0;
  for (const account of accounts) {
    const activityRow = activity.get(account.id) ?? { dr: 0, cr: 0 };
    const net = activityRow.dr - activityRow.cr;
    if (net === 0 && activityRow.dr === 0) continue;
    const row: TrialBalanceRow = {
      accountId: account.id,
      code: account.code,
      name: account.name,
      accountType: account.accountType,
      debitCents: net > 0 ? net : 0,
      creditCents: net < 0 ? -net : 0,
    };
    totalDebit += row.debitCents;
    totalCredit += row.creditCents;
    rows.push(row);
  }
  return {
    asOf,
    rows: byCode(rows),
    totalDebit,
    totalCredit,
    balanced: totalDebit === totalCredit,
  };
}

export function balanceSheet(accounts: GlAccount[], entries: GlJournalEntry[], asOf: string): BalanceSheet {
  const fyStart = fiscalYearStart(asOf);
  const all = sums(entries, null, asOf);
  const prior = sums(entries, null, dayBefore(fyStart));
  const sections: BalanceSheet['sections'] = { asset: [], liability: [], equity: [] };
  const totals = { asset: 0, liability: 0, equity: 0 };
  let incomeAll = 0;
  let incomePrior = 0;
  for (const account of accounts) {
    const activity = all.get(account.id) ?? { dr: 0, cr: 0 };
    if (account.accountType === 'income' || account.accountType === 'expense') {
      const earlier = prior.get(account.id) ?? { dr: 0, cr: 0 };
      incomeAll += activity.cr - activity.dr;
      incomePrior += earlier.cr - earlier.dr;
      continue;
    }
    const balance = normalDebit(account.accountType) ? activity.dr - activity.cr : activity.cr - activity.dr;
    if (balance === 0) continue;
    const section = account.accountType as 'asset' | 'liability' | 'equity';
    sections[section].push({
      accountId: account.id,
      code: account.code,
      name: account.name,
      subtype: account.subtype,
      balanceCents: balance,
    });
    totals[section] += balance;
  }
  for (const key of ['asset', 'liability', 'equity'] as const) sections[key] = byCode(sections[key]);
  const yearToDate = incomeAll - incomePrior;
  sections.equity.push(
    { accountId: null, code: '', name: 'Retained earnings (prior years, computed)', subtype: 'computed', balanceCents: incomePrior },
    { accountId: null, code: '', name: 'Net income (current fiscal year)', subtype: 'computed', balanceCents: yearToDate },
  );
  totals.equity += incomeAll;
  const liabilitiesAndEquity = totals.liability + totals.equity;
  return {
    asOf,
    fyStart,
    sections,
    totals,
    liabilitiesAndEquity,
    balanced: totals.asset === liabilitiesAndEquity,
  };
}

export function profitAndLoss(accounts: GlAccount[], entries: GlJournalEntry[], from: string, to: string): ProfitAndLoss {
  const activity = sums(entries, from, to);
  const groups: Record<PnlGroup, PnlRow[]> = {
    revenue: [], cogs: [], expense: [], other_income: [], other_expense: [],
  };
  for (const account of accounts) {
    const group = pnlGroup(account);
    if (!group) continue;
    const row = activity.get(account.id) ?? { dr: 0, cr: 0 };
    const amount = account.accountType === 'income' ? row.cr - row.dr : row.dr - row.cr;
    if (amount === 0) continue;
    groups[group].push({ accountId: account.id, code: account.code, name: account.name, amountCents: amount });
  }
  for (const group of PNL_GROUPS) groups[group] = byCode(groups[group]);
  const sum = (group: PnlGroup) => groups[group].reduce((total, row) => total + row.amountCents, 0);
  const revenue = sum('revenue');
  const grossProfit = revenue - sum('cogs');
  const operatingIncome = grossProfit - sum('expense');
  const netIncome = operatingIncome + sum('other_income') - sum('other_expense');
  return { from, to, groups, revenue, grossProfit, operatingIncome, netIncome, basis: 'accrual' };
}

function pnlGroup(account: GlAccount): PnlGroup | null {
  if (account.accountType === 'income') return account.subtype === 'other_income' ? 'other_income' : 'revenue';
  if (account.accountType !== 'expense') return null;
  if (account.subtype === 'cogs') return 'cogs';
  if (account.subtype === 'other_expense') return 'other_expense';
  return 'expense';
}

export interface LedgerDetailRow {
  date: string;
  sourceType: string;
  sourceId: string | null;
  entryId: string;
  ref: string;
  party: string;
  memo: string;
  lineMemo: string;
  debitCents: number;
  creditCents: number;
  balanceCents: number;
}

export interface LedgerDetail {
  accountId: string;
  code: string;
  name: string;
  accountType: AccountType;
  openingCents: number;
  closingCents: number;
  rows: LedgerDetailRow[];
}

export function generalLedger(
  accounts: GlAccount[],
  entries: GlJournalEntry[],
  from: string,
  to: string,
  accountId: string | null = null,
): LedgerDetail[] {
  const selected = accountId ? accounts.filter((account) => account.id === accountId) : accounts;
  const details: LedgerDetail[] = [];
  for (const account of byCode(selected)) {
    const sign = normalDebit(account.accountType) ? 1 : -1;
    const openingFrom = account.accountType === 'income' || account.accountType === 'expense'
      ? fiscalYearStart(from)
      : null;
    let open = 0;
    const rows: LedgerDetailRow[] = [];
    const ordered = [...entries].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
    for (const entry of ordered) {
      for (const line of [...entry.lines].sort((a, b) => a.lineNo - b.lineNo)) {
        if (line.accountId !== account.id) continue;
        const delta = line.debitCents - line.creditCents;
        if (entry.date < from && (openingFrom === null || entry.date >= openingFrom)) open += delta;
        if (!inRange(entry.date, from, to)) continue;
        rows.push({
          date: entry.date,
          sourceType: entry.sourceType,
          sourceId: entry.sourceId,
          entryId: entry.id,
          ref: entry.ref,
          party: entry.party,
          memo: entry.memo,
          lineMemo: line.memo,
          debitCents: line.debitCents,
          creditCents: line.creditCents,
          balanceCents: 0,
        });
      }
    }
    if (rows.length === 0 && open === 0 && accountId === null) continue;
    let running = open;
    for (const row of rows) {
      running += row.debitCents - row.creditCents;
      row.balanceCents = running * sign;
    }
    details.push({
      accountId: account.id,
      code: account.code,
      name: account.name,
      accountType: account.accountType,
      openingCents: open * sign,
      closingCents: running * sign,
      rows,
    });
  }
  return details;
}

export interface ChartRow extends GlAccount {
  balanceCents: number;
  used: boolean;
}

export function chartBalances(accounts: GlAccount[], entries: GlJournalEntry[]): ChartRow[] {
  const activity = sums(entries, null, null);
  return byCode(accounts).map((account) => {
    const row = activity.get(account.id) ?? { dr: 0, cr: 0 };
    return {
      ...account,
      balanceCents: normalDebit(account.accountType) ? row.dr - row.cr : row.cr - row.dr,
      used: row.dr + row.cr > 0,
    };
  });
}

export function journalInRange(entries: GlJournalEntry[], from: string, to: string): GlJournalEntry[] {
  return [...entries]
    .filter((entry) => inRange(entry.date, from, to))
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))
    .map((entry) => ({ ...entry, lines: [...entry.lines].sort((a, b) => a.lineNo - b.lineNo) }));
}

/** Postgres jsonb text: shorter keys first, then byte order, with a space after ":" and ",". */
export function jsonbText(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new BooksError('invalid_amount');
    if (Number.isInteger(value)) return String(value);
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => jsonbText(item)).join(', ')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
    return `{${keys.map((key) => `${JSON.stringify(key)}: ${jsonbText(record[key])}`).join(', ')}}`;
  }
  return JSON.stringify(value);
}

export function auditCanonical(row: AuditHashInput): string {
  return [
    row.prevHash,
    String(row.seq),
    row.at,
    row.documentType,
    row.op,
    row.documentId ?? '',
    row.before == null ? '' : jsonbText(row.before),
    row.payload == null ? '' : jsonbText(row.payload),
  ].join('|');
}

export function auditRowHash(row: AuditHashInput): string {
  const digest = sha256(new TextEncoder().encode(auditCanonical(row)));
  let hex = '';
  for (const byte of digest) hex += byte.toString(16).padStart(2, '0');
  return hex;
}
