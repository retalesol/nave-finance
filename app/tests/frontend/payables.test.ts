import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { postingBalances } from '../../src/lib/pay/invoiceMath';
import {
  billJournal,
  billPaymentJournal,
  billState,
  billVoidBlocked,
  cashAccountCode,
  cashLedger,
  cashMovementJournal,
  expenseCodeForBill,
  incomeCodeForDeposit,
  inputMatchesCents,
  payableActivityText,
  samePayee,
  vendorYearCashCents,
} from '../../src/lib/pay/payables';

const today = '2026-10-25';

test('bill status is partial, overdue, or paid from payments', () => {
  const open = billState({ status: 'open', amountCents: 10000, paidCents: 0, dueDate: '2026-11-01' }, today);
  assert.equal(open.displayStatus, 'open');
  assert.equal(open.balanceCents, 10000);

  const dueToday = billState({ status: 'open', amountCents: 10000, paidCents: 0, dueDate: today }, today);
  assert.equal(dueToday.displayStatus, 'open');

  const partial = billState({ status: 'open', amountCents: 10000, paidCents: 4000, dueDate: '2026-11-01' }, today);
  assert.equal(partial.displayStatus, 'partial');
  assert.equal(partial.balanceCents, 6000);

  const overduePartial = billState({ status: 'open', amountCents: 10000, paidCents: 2500, dueDate: '2026-10-20' }, today);
  assert.equal(overduePartial.displayStatus, 'overdue');
  assert.equal(overduePartial.balanceCents, 7500);
  assert.equal(overduePartial.daysOverdue, 5);

  const paid = billState({ status: 'open', amountCents: 10000, paidCents: 10000, dueDate: '2026-10-01' }, today);
  assert.equal(paid.displayStatus, 'paid');
  assert.equal(paid.balanceCents, 0);

  const voided = billState({ status: 'void', amountCents: 10000, paidCents: 0, dueDate: '2026-10-01' }, today);
  assert.equal(voided.displayStatus, 'void');
  assert.equal(voided.balanceCents, 0);
});

test('void is blocked once a bill has payments', () => {
  assert.equal(billVoidBlocked(0), null);
  assert.equal(billVoidBlocked(1), 'Bill has payments. Delete them before voiding.');
});

test('bill journals debit expense and credit AP, then debit AP and credit cash', () => {
  assert.equal(expenseCodeForBill('Legal', null), '6030');
  assert.equal(expenseCodeForBill('legal', '6050'), '6050');
  assert.equal(expenseCodeForBill('Nope', null), '6900');

  const opened = billJournal('open', 12500, expenseCodeForBill('Legal', null));
  assert.deepEqual(opened.map((line) => [line.code, line.debitCents, line.creditCents]), [
    ['6030', 12500, 0],
    ['2000', 0, 12500],
  ]);
  assert.equal(postingBalances(opened), true);
  assert.deepEqual(billJournal('void', 12500, '6030'), []);

  assert.equal(cashAccountCode('Treasury', null), '1200');
  assert.equal(cashAccountCode('USDC', null), '1200');
  assert.equal(cashAccountCode('Other crypto', null), '1200');
  assert.equal(cashAccountCode('ACH', null), '1000');
  assert.equal(cashAccountCode('Treasury', '1010'), '1010');

  const treasuryPay = billPaymentJournal(4000, cashAccountCode('Treasury', null));
  assert.deepEqual(treasuryPay.map((line) => [line.code, line.debitCents, line.creditCents]), [
    ['2000', 4000, 0],
    ['1200', 0, 4000],
  ]);
  assert.equal(postingBalances(treasuryPay), true);

  const achPay = billPaymentJournal(4000, cashAccountCode('ACH', null));
  assert.deepEqual(achPay.map((line) => [line.code, line.debitCents, line.creditCents]), [
    ['2000', 4000, 0],
    ['1000', 0, 4000],
  ]);
});

test('deposits debit cash and expenses credit cash', () => {
  const deposit = cashMovementJournal('in', 8000, incomeCodeForDeposit('Grants', null), cashAccountCode('Wire', null));
  assert.deepEqual(deposit.map((line) => [line.code, line.debitCents, line.creditCents]), [
    ['1000', 8000, 0],
    ['7010', 0, 8000],
  ]);
  assert.equal(postingBalances(deposit), true);

  const expense = cashMovementJournal('out', 1500, expenseCodeForBill('Software & SaaS', null), '1200');
  assert.deepEqual(expense.map((line) => [line.code, line.debitCents, line.creditCents]), [
    ['6000', 1500, 0],
    ['1200', 0, 1500],
  ]);
  assert.equal(postingBalances(expense), true);
});

test('cash ledger keeps a running balance and a yearly vendor total', () => {
  const ledger = cashLedger([
    {
      date: '2026-01-02', direction: 'in', amountCents: 5000, type: 'Deposit', ref: '', party: 'Grant',
      category: 'Grants', method: 'Wire', reference: '', linkType: 'transaction', linkId: 'd1', src: 'transaction', srcId: 'd1',
    },
    {
      date: '2026-02-01', direction: 'in', amountCents: 3000, type: 'Invoice payment', ref: 'INV-1', party: 'Ada',
      category: 'Invoice payments', method: 'USDC', reference: '', linkType: 'invoice', linkId: 'i1', src: 'payment', srcId: 'p1',
    },
    {
      date: '2026-02-02', direction: 'out', amountCents: 1200, type: 'Bill payment', ref: 'B-9', party: 'Acme',
      category: 'Legal', method: 'ACH', reference: '', linkType: 'bill', linkId: 'b1', src: 'bill_payment', srcId: 'bp1',
    },
  ], '2026-02-01', '2026-12-31');
  assert.equal(ledger.openingCents, 5000);
  assert.equal(ledger.rows.length, 2);
  assert.equal(ledger.rows[0].balanceCents, 8000);
  assert.equal(ledger.rows[1].balanceCents, 6800);

  const paid = vendorYearCashCents([
    { vendorId: 'v1', amountCents: 1200, method: 'ACH', date: '2026-02-02' },
    { vendorId: 'v1', amountCents: 500, method: 'Card', date: '2026-03-01' },
    { vendorId: 'v1', amountCents: 900, method: 'Treasury', date: '2025-12-01' },
    { vendorId: 'v2', amountCents: 100, method: 'ACH', date: '2026-04-01' },
  ], 'v1', 2026);
  assert.equal(paid, 1200);
});

test('activity text and proposal matching leave tax ids out', () => {
  const tin = '12-3456789';
  const summary = payableActivityText('bill_payment', 'Acme Hosting', 'B-9');
  assert.equal(summary.includes(tin), false);
  assert.equal(summary, 'Bill payment B-9 to Acme Hosting');
  assert.equal(samePayee('0xAbC', '0xabc'), true);
  assert.equal(samePayee('So11111111111111111111111111111111111111112', 'so11111111111111111111111111111111111111112'), false);
  assert.equal(inputMatchesCents('40.00', 4000), true);
  assert.equal(inputMatchesCents('40.000000', 4000), true);
  assert.equal(inputMatchesCents('40.01', 4000), false);

  const sql = readFileSync(new URL('../../supabase/migrations/20261025231000_nave_pay_payables.sql', import.meta.url), 'utf8');
  assert.equal(/pay_activity_add\([\s\S]{0,240}tax_id/.test(sql), false);
  const sync = sql.split('FUNCTION public.pay_sync_payable_journals')[1]?.split('CREATE OR REPLACE FUNCTION')[0] ?? '';
  assert.equal(sync.includes('tax_id'), false);
  const api = readFileSync(new URL('../../src/lib/pay/payablesApi.ts', import.meta.url), 'utf8');
  assert.equal(api.includes('pay_bill_payments!pay_bill_payments_bill_id_fkey'), true);
});
