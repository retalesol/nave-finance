// Phase-4 focused tests for the signer distributed rate limiter + circuit
// breaker (signer-service/src/rateLimit.ts).
//
// These prove, deterministically and hermetically (in-memory fallback path, no
// Upstash required):
//   1. fixed-window limits HOLD — the (N+1)-th request in a window is rejected,
//      and the window resets afterwards;
//   2. multi-dimension limit specs reject on the FIRST exceeded dimension;
//   3. the per-DAO circuit breaker OPENS under a burst of rejections/failures
//      and a success resets the running failure count;
//   4. on mainnet WITHOUT a distributed store the limiter + breaker FAIL CLOSED
//      (no silent per-replica under-counting).
//
// Run with:  npm test   (added below)  — or:
//   node --import tsx --test src/rateLimit.test.ts
//
// IMPORTANT: env that the module reads at import time (the circuit-breaker
// thresholds) is set BEFORE the dynamic import so the run is deterministic.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Deterministic, small circuit-breaker config (read once at module import).
process.env.NAVE_SIGNER_CB_THRESHOLD = '3';
process.env.NAVE_SIGNER_CB_WINDOW_MS = '60000';
process.env.NAVE_SIGNER_CB_COOLDOWN_MS = '120000';
// Ensure no Upstash + non-mainnet => in-memory fallback for the default tests.
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
process.env.NAVE_CLUSTER = 'devnet';

// Deferred import so the env above is in effect when the module initializes.
const rl = await import('./rateLimit.js');

function uniq(prefix: string): string {
  return `${prefix}:${Math.random().toString(36).slice(2)}`;
}

test('memory mode is selected without Upstash on non-mainnet', () => {
  process.env.NAVE_CLUSTER = 'devnet';
  assert.equal(rl.limiterMode(), 'memory');
});

test('fixed-window limit holds: Nth allowed, (N+1)th rejected', async () => {
  process.env.NAVE_CLUSTER = 'devnet';
  const key = uniq('dao-action');
  const spec = { key, limit: 5, windowMs: 60_000 };

  for (let i = 0; i < 5; i++) {
    const res = await rl.enforceLimits([spec]);
    assert.equal(res, null, `request ${i + 1} of 5 must be allowed`);
  }
  const blocked = await rl.enforceLimits([spec]);
  assert.ok(blocked && blocked.allowed === false, '6th request must be rejected');
  assert.equal(blocked!.key, key);
  assert.ok(blocked!.retryAfterSeconds > 0, 'a retry-after must be advertised');
});

test('window reset re-admits after the window elapses', async () => {
  process.env.NAVE_CLUSTER = 'devnet';
  const key = uniq('dao-window');
  // 1ms window so it self-expires immediately between calls.
  const spec = { key, limit: 1, windowMs: 1 };
  assert.equal(await rl.enforceLimits([spec]), null);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(await rl.enforceLimits([spec]), null, 'new window must re-admit');
});

test('multi-dimension specs reject on the first exceeded dimension', async () => {
  process.env.NAVE_CLUSTER = 'devnet';
  const globalKey = uniq('global');
  const daoKey = uniq('dao');
  // global allows 10, dao allows 1: the per-DAO dimension trips first.
  const specs = [
    { key: globalKey, limit: 10, windowMs: 60_000 },
    { key: daoKey, limit: 1, windowMs: 60_000 },
  ];
  assert.equal(await rl.enforceLimits(specs), null);
  const blocked = await rl.enforceLimits(specs);
  assert.ok(blocked && blocked.allowed === false);
  assert.equal(blocked!.key, daoKey, 'rejection must name the per-DAO dimension');
});

test('circuit breaker opens after a burst of failures and resets on success', async () => {
  process.env.NAVE_CLUSTER = 'devnet';
  const dao = uniq('cb-dao');

  // Fewer than threshold (3) failures keep the breaker closed.
  await rl.recordSignerOutcome(dao, false);
  await rl.recordSignerOutcome(dao, false);
  let st = await rl.circuitStatus(dao);
  assert.equal(st.open, false, 'breaker stays closed below threshold');

  // The threshold-th failure trips it open.
  await rl.recordSignerOutcome(dao, false);
  st = await rl.circuitStatus(dao);
  assert.equal(st.open, true, 'breaker opens at the failure threshold');
  assert.ok(st.retryAfterSeconds > 0);

  // A different DAO is unaffected (per-DAO isolation).
  const otherDao = uniq('cb-other');
  assert.equal((await rl.circuitStatus(otherDao)).open, false);

  // A success on a fresh DAO clears the running failure count (stays closed).
  const dao2 = uniq('cb-dao2');
  await rl.recordSignerOutcome(dao2, false);
  await rl.recordSignerOutcome(dao2, false);
  await rl.recordSignerOutcome(dao2, true); // success resets
  await rl.recordSignerOutcome(dao2, false);
  assert.equal((await rl.circuitStatus(dao2)).open, false, 'success reset the counter');
});

test('FAIL CLOSED on mainnet without a distributed store', async () => {
  // No Upstash configured + mainnet cluster => limiter rejects everything and
  // the circuit reports open, rather than silently relying on a per-replica
  // counter (effective limit would otherwise be limit x replicas).
  process.env.NAVE_CLUSTER = 'mainnet';
  assert.equal(rl.limiterMode(), 'fail-closed');

  const res = await rl.enforceLimits([{ key: uniq('m'), limit: 1000, windowMs: 60_000 }]);
  assert.ok(res && res.allowed === false, 'mainnet w/o Redis must reject');
  assert.match(res!.key, /distributed-store-unconfigured-on-mainnet/);

  const st = await rl.circuitStatus(uniq('m-dao'));
  assert.equal(st.open, true, 'circuit reports open (fail closed) on mainnet w/o Redis');

  // Restore for any later tests.
  process.env.NAVE_CLUSTER = 'devnet';
});
