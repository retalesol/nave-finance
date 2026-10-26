import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MERCURY_PROD,
  MERCURY_SANDBOX,
  addIsoDays,
  assertMercuryReadOnly,
  mercuryCall,
  mercuryCents,
  mercuryEnvironment,
  mercuryGlCode,
  mercuryPublicView,
  mercuryShouldAutoMatch,
  mercurySuggest,
  mercurySyncStart,
  normalizeMercuryToken,
  redactMercurySecrets,
  type OpenInvoiceMatch,
} from '../../supabase/functions/_shared/mercury.ts';

const invoice = (overrides: Partial<OpenInvoiceMatch> = {}): OpenInvoiceMatch => ({
  id: 'inv-1',
  number: 'INV-1042',
  customer_name: 'Northwind LLC',
  balance_cents: 12500,
  ...overrides,
});

test('exact invoice number and amount auto-matches', () => {
  const suggestion = mercurySuggest(
    {
      amount_cents: 12500,
      external_memo: 'ACH payment INV-1042',
      bank_description: 'Incoming wire',
      counterparty: 'Northwind LLC',
    },
    [invoice()],
    [],
    [],
  );
  assert.equal(suggestion?.type, 'invoice');
  assert.equal(suggestion?.id, 'inv-1');
  assert.equal(suggestion?.confidence, 'high');
  assert.equal(suggestion?.auto, true);
  assert.equal(mercuryShouldAutoMatch(suggestion), true);
});

test('amount-only does not auto-match', () => {
  const suggestion = mercurySuggest(
    {
      amount_cents: 12500,
      external_memo: 'payment received',
      bank_description: 'Incoming ACH',
      counterparty: 'Someone else',
    },
    [invoice()],
    [],
    [],
  );
  assert.notEqual(suggestion?.confidence, 'high');
  assert.equal(suggestion?.auto ?? false, false);
  assert.equal(mercuryShouldAutoMatch(suggestion), false);
});

test('a longer invoice number is not treated as the shorter one', () => {
  const suggestion = mercurySuggest(
    { amount_cents: 12500, external_memo: 'INV-10420' },
    [invoice()],
    [],
    [],
  );
  assert.equal(mercuryShouldAutoMatch(suggestion), false);
});

test('sandbox and production tokens validate and pick a read-only host', () => {
  const production = normalizeMercuryToken('Bearer secret-token:mercury_production_abcdefgh');
  const sandbox = normalizeMercuryToken('secret-token:mercury_sandbox_abcdefgh');
  assert.equal(production, 'secret-token:mercury_production_abcdefgh');
  assert.equal(mercuryEnvironment(production), 'production');
  assert.equal(mercuryEnvironment(sandbox), 'sandbox');

  const productionCall = mercuryCall('/accounts', {}, production);
  assert.equal(productionCall.method, 'GET');
  assert.equal(productionCall.url.startsWith(`${MERCURY_PROD}/`), true);
  assert.equal(new URL(productionCall.url).hostname, 'api.mercury.com');

  const sandboxCall = mercuryCall('/accounts', { limit: 1000 }, sandbox);
  assert.equal(sandboxCall.method, 'GET');
  assert.equal(sandboxCall.url.startsWith(`${MERCURY_SANDBOX}/accounts`), true);
  assert.equal(new URL(sandboxCall.url).hostname, 'api-sandbox.mercury.com');

  assert.throws(() => normalizeMercuryToken('secret-token:mercury_test_abcdefgh'));
  assert.throws(() => normalizeMercuryToken('sk_live_not_mercury'));
  assert.throws(() => mercuryCall('/accounts', {}, 'secret-token:mercury_production_short'));
});

test('Mercury client rejects every write method', () => {
  const token = 'secret-token:mercury_production_abcdefgh';
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.throws(() => assertMercuryReadOnly(method), /GET/);
    assert.throws(() => {
      assertMercuryReadOnly(method);
      mercuryCall('/accounts', {}, token);
    });
  }
  const call = mercuryCall('/account/abc/transactions', { start: '2026-07-27', end: '2026-10-26' }, token);
  assert.equal(call.method, 'GET');
  assert.equal(call.headers.Authorization.startsWith('Bearer secret-token:mercury_production_'), true);
  assert.equal('body' in call, false);
});

test('public responses keep the hint and drop the token', () => {
  const view = mercuryPublicView({
    connected: true,
    token_hint: '••••cdef',
    token: 'secret-token:mercury_production_abcdefgh',
    token_ciphertext: 'cipher',
    environment: 'production',
  });
  assert.equal(view.token_hint, '••••cdef');
  assert.equal('token' in view, false);
  assert.equal('token_ciphertext' in view, false);
  assert.equal(redactMercurySecrets('rejected secret-token:mercury_sandbox_abcdefgh'), 'rejected secret-token:[redacted]');
});

test('sync window is 90 days, then a 14-day overlap, and savings map to 1010', () => {
  assert.equal(mercurySyncStart('2026-10-25', null, null), addIsoDays('2026-10-25', -90));
  assert.equal(mercurySyncStart('2026-10-25', '', '2026-10-20T15:00:00Z'), '2026-10-06');
  assert.equal(mercurySyncStart('2026-10-25', '2026-10-15', '2026-10-20T15:00:00Z'), '2026-10-15');
  assert.equal(mercuryGlCode({ kind: 'checking', name: 'Checking' }), '1000');
  assert.equal(mercuryGlCode({ kind: 'savings', name: 'Savings' }), '1010');
  assert.equal(mercuryGlCode({ kind: 'checking', name: 'Operating', nickname: 'Treasury' }), '1010');
  assert.equal(mercuryCents(12.5), 1250);
  assert.equal(mercuryCents(10), 1000);
  assert.equal(mercuryCents('-3.01'), -301);
});
