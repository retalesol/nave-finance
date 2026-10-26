import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  auditRowHash,
  balanceSheet,
  BooksError,
  profitAndLoss,
  trialBalance,
  validateManualJournal,
  type GlAccount,
  type GlJournalEntry,
} from '../../src/lib/pay/gl';

const cash: GlAccount = {
  id: 'cash', code: '1000', name: 'Mercury Checking', accountType: 'asset', subtype: 'bank',
  archived: false, systemKey: 'cash_default', taxLine: '', description: '',
};
const revenue: GlAccount = {
  id: 'rev', code: '4000', name: 'Revenue - services', accountType: 'income', subtype: 'revenue',
  archived: false, systemKey: 'revenue', taxLine: '', description: '',
};
const expense: GlAccount = {
  id: 'exp', code: '6030', name: 'Legal', accountType: 'expense', subtype: 'expense',
  archived: false, systemKey: null, taxLine: '', description: '',
};
const accounts = [cash, revenue, expense];

function entry(id: string, date: string, lines: GlJournalEntry['lines']): GlJournalEntry {
  return { id, date, memo: '', ref: '', party: '', sourceType: 'manual', sourceId: id, lines };
}

test('a manual journal balances debits and credits', () => {
  const draft = validateManualJournal({
    date: '2026-03-15',
    memo: 'March accrual',
    ref: 'JE-1',
    lockedThrough: null,
    lines: [
      { accountId: 'exp', debitCents: 12500, creditCents: 0, memo: 'Legal' },
      { accountId: 'cash', debitCents: 0, creditCents: 12500, memo: '' },
      { accountId: 'rev', debitCents: 0, creditCents: 0 },
    ],
  });
  const debit = draft.lines.reduce((sum, line) => sum + line.debitCents, 0);
  const credit = draft.lines.reduce((sum, line) => sum + line.creditCents, 0);
  assert.equal(draft.lines.length, 2);
  assert.equal(debit, 12500);
  assert.equal(credit, 12500);
  assert.equal(debit - credit, 0);

  assert.throws(
    () => validateManualJournal({
      date: '2026-03-15',
      memo: 'Off',
      lines: [
        { accountId: 'exp', debitCents: 100, creditCents: 0 },
        { accountId: 'cash', debitCents: 0, creditCents: 90 },
      ],
    }),
    (error: unknown) => error instanceof BooksError && error.code === 'journal_unbalanced',
  );
});

test('trial balance debits and credits sum to zero', () => {
  const entries: GlJournalEntry[] = [
    entry('e1', '2026-01-10', [
      { lineNo: 0, accountId: 'cash', debitCents: 5000, creditCents: 0, memo: '' },
      { lineNo: 1, accountId: 'rev', debitCents: 0, creditCents: 5000, memo: '' },
    ]),
    entry('e2', '2026-02-02', [
      { lineNo: 0, accountId: 'exp', debitCents: 1250, creditCents: 0, memo: '' },
      { lineNo: 1, accountId: 'cash', debitCents: 0, creditCents: 1250, memo: '' },
    ]),
  ];
  const report = trialBalance(accounts, entries, '2026-10-25');
  assert.equal(report.totalDebit, 5000);
  assert.equal(report.totalCredit, 5000);
  assert.equal(report.totalDebit - report.totalCredit, 0);
  assert.equal(report.balanced, true);

  const sheet = balanceSheet(accounts, entries, '2026-10-25');
  assert.equal(sheet.balanced, true);
  assert.equal(sheet.totals.asset, sheet.liabilitiesAndEquity);
  const pnl = profitAndLoss(accounts, entries, '2026-01-01', '2026-10-25');
  assert.equal(pnl.netIncome, 3750);
});

test('a locked period rejects a backdated journal', () => {
  assert.throws(
    () => validateManualJournal({
      date: '2026-01-15',
      memo: 'Backdated accrual',
      lockedThrough: '2026-01-31',
      lines: [
        { accountId: 'exp', debitCents: 100, creditCents: 0 },
        { accountId: 'cash', debitCents: 0, creditCents: 100 },
      ],
    }),
    (error: unknown) => error instanceof BooksError && error.code === 'PERIOD_LOCKED',
  );

  const open = validateManualJournal({
    date: '2026-02-01',
    memo: 'After the lock',
    lockedThrough: '2026-01-31',
    lines: [
      { accountId: 'exp', debitCents: 100, creditCents: 0 },
      { accountId: 'cash', debitCents: 0, creditCents: 100 },
    ],
  });
  assert.equal(open.date, '2026-02-01');

  const sql = readFileSync(join(
    dirname(fileURLToPath(import.meta.url)),
    '../../supabase/migrations/20261025234000_nave_pay_close.sql',
  ), 'utf8');
  assert.match(sql, /BEFORE INSERT ON public\.pay_journal_entries/);
  assert.match(sql, /RAISE EXCEPTION 'PERIOD_LOCKED'/);
  assert.equal(sql.includes('NEW.tax_id'), false);
  assert.match(sql, /'tin_ciphertext'/);
  assert.match(sql, /'mercury_token'/);
});

test('an audit row hash changes when the payload changes', () => {
  const base = {
    prevHash: 'GENESIS',
    seq: 1,
    at: '2026-10-25T00:00:00.000Z',
    documentType: 'journal',
    op: 'I',
    documentId: null,
    before: null,
    payload: { debit_cents: 100, memo: 'Accrual' },
  };
  const changed = { ...base, payload: { debit_cents: 100, memo: 'Reversal' } };
  const first = auditRowHash(base);
  const second = auditRowHash(changed);
  assert.equal(first.length, 64);
  assert.notEqual(first, second);
  assert.equal(first, '0f0704eb2e6a5be123ba1ca0631f80e4bbbaa4011f29ae72c68ffaec9db5d38c');
  assert.equal(second, 'cd251042005fd9e10d6f54d07de653fff3171331db657720bbef1a45945008ae');
  assert.equal(first, auditRowHash({ ...base, payload: { memo: 'Accrual', debit_cents: 100 } }));
  assert.notEqual(first, auditRowHash({ ...base, prevHash: 'abc' }));
});
