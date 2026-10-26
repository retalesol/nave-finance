import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { validateDaoSlug } from '../../src/lib/daoSlug';
import {
  COMPASS_SESSION_MS,
  COMPASS_USERNAME,
  credentialsMatch,
  openSession,
  signSession,
} from '../../supabase/functions/_shared/compassAuth.ts';

const migration = readFileSync(
  new URL('../../supabase/migrations/20261026023000_compass_admin.sql', import.meta.url),
  'utf8',
);

test('compass is a reserved treasury name', () => {
  assert.equal(validateDaoSlug('compass').valid, false);
});

test('operator credentials accept only the captain username and the provided server password', async () => {
  assert.equal(await credentialsMatch('captain', 'correct-horse-battery', 'correct-horse-battery'), true);
  assert.equal(await credentialsMatch(' Captain ', 'correct-horse-battery', 'correct-horse-battery'), true);
  assert.equal(await credentialsMatch('captain', 'wrong-horse-battery', 'correct-horse-battery'), false);
  assert.equal(await credentialsMatch('admiral', 'correct-horse-battery', 'correct-horse-battery'), false);
  assert.equal(await credentialsMatch('captain', 'correct-horse-battery', ''), false);
  assert.equal(COMPASS_USERNAME, 'captain');
});

test('sessions last eight hours and fail when signed by another secret or expired', async () => {
  const now = Date.parse('2026-10-26T12:00:00Z');
  const sessionId = '11111111-1111-4111-8111-111111111111';
  const signed = await signSession('server-secret', sessionId, now);
  assert.equal(signed.expiresAtMs - now, COMPASS_SESSION_MS);
  assert.deepEqual(await openSession('server-secret', signed.token, now + 1000), { sid: sessionId });
  assert.equal(await openSession('other-secret', signed.token, now + 1000), null);
  assert.equal(await openSession('server-secret', signed.token, signed.expiresAtMs), null);
  const [body, signature] = signed.token.split('.');
  assert.equal(await openSession('server-secret', `${body}.${signature}x`, now + 1000), null);
  assert.equal(await openSession('server-secret', body ?? '', now + 1000), null);
});

test('compass migration stays service-role only and does not read private books', () => {
  assert.match(migration, /compass_require_service/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.compass_overview\(\) TO service_role/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.compass_overview\(\) FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /CHECK \(source IN \('', 'wallet', 'treasury', 'compass'\)\)/);
  assert.match(migration, /detail - 'previous_tx_hash'/);
  assert.doesNotMatch(migration, /pay_purge_treasury/);
  assert.doesNotMatch(migration, /pay_employee_secrets|pay_mercury|encrypted_agent_keys|public_token|raw_data|\bein\b/);
  assert.doesNotMatch(migration, /FROM public\.pay_activity[\s\S]{0,180}summary/);
});
