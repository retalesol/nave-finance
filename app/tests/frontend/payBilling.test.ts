import test from 'node:test';
import assert from 'node:assert/strict';

import {
  INVOICE_FOOTER,
  PAY_MONTHLY_CENTS,
  subscriptionPriceCents,
  subscriptionState,
  subscriptionUsable,
  usdCentsToTokenUnits,
} from '../../src/lib/pay/billing';
import { invoiceDocumentHtml } from '../../src/lib/pay/invoiceDocument';
import type { PayInvoice } from '../../src/lib/pay/booksApi';

const day = 24 * 60 * 60 * 1000;
const end = Date.parse('2026-11-01T00:00:00Z');

test('subscription prices are $49, 10% off for 3 months, and 25% off for 12 months', () => {
  assert.equal(PAY_MONTHLY_CENTS, 4900);
  assert.equal(subscriptionPriceCents(1), 4900);
  assert.equal(subscriptionPriceCents(3), 13230);
  assert.equal(subscriptionPriceCents(12), 44100);
});

test('service stays open for 7 days, locks, then is due for deletion at 30 days', () => {
  assert.equal(subscriptionState(null, end, false), 'none');
  assert.equal(subscriptionState(end, end - 1000, false), 'active');
  assert.equal(subscriptionState(end, end + 6 * day, false), 'grace');
  assert.equal(subscriptionState(end, end + 7 * day, false), 'locked');
  assert.equal(subscriptionState(end, end + 29 * day, false), 'locked');
  assert.equal(subscriptionState(end, end + 30 * day, false), 'purged');
  assert.equal(subscriptionUsable('active'), true);
  assert.equal(subscriptionUsable('grace'), true);
  assert.equal(subscriptionUsable('locked'), false);
});

test('$49.00 of 6-decimal USDC is 49_000_000 base units', () => {
  assert.equal(usdCentsToTokenUnits(4900, 6), 49_000_000n);
  assert.equal(usdCentsToTokenUnits(100, 6), 1_000_000n);
});

test('printed invoices show the treasury logo and the Nave Pay footer', () => {
  const invoice = {
    number: 'INV-1001',
    company_snapshot: { legal_name: 'Atlas', address: '1 Market', logo_url: 'https://cdn.example/logo.png' },
    customer_snapshot: { name: 'Fin', address: '' },
    customer: null,
    rails_snapshot: { wire_instructions: '', ach_instructions: '', reference_code: 'REF' },
    items: [{ id: '1', description: 'Work', qty_e4: 10000, rate_cents: 4900, taxable: false, amount_cents: 4900, position: 0 }],
    issue_date: '2026-10-01',
    due_date: '2026-10-31',
    po_number: '',
    discount_cents: 0,
    tax_cents: 0,
    tax_label: 'Tax',
    subtotal_cents: 4900,
    total_cents: 4900,
    reference_code: 'REF',
    notes: '',
    terms: '',
  } as PayInvoice;
  const html = invoiceDocumentHtml(invoice, [{ chain: 'Base', address: '0xabc' }]);
  assert.match(html, /https:\/\/cdn\.example\/logo\.png/);
  assert.match(html, new RegExp(INVOICE_FOOTER));
});
