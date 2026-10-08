// Runs under NAVE_TEST_PROFILE=unconfigured (see support/register.mjs): the
// relayer URL, custody, and wNAVE tokens are all UNSET. This is the deployment
// state that drives the "bridge not configured" banner and the no-supported-
// routes empty state in the UI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { NAVE_BRIDGE_ENABLED } from '../../../src/lib/programConfig';
import { getSupportedBridgeRoutes, hasWrappedNave } from '../../../src/lib/bridge/routes';
import { submitBridgeRelay } from '../../../src/lib/bridge/relayer';

test('NAVE_BRIDGE_ENABLED is false when relayer URL + custody are unset', () => {
  assert.equal(NAVE_BRIDGE_ENABLED, false);
});

test('no WrappedNave tokens → getSupportedBridgeRoutes is empty (no-route state)', () => {
  assert.equal(hasWrappedNave(11155111), false);
  assert.equal(hasWrappedNave(84532), false);
  assert.equal(hasWrappedNave(46630), false);
  assert.deepEqual(getSupportedBridgeRoutes(), []);
});

test('submitBridgeRelay fails fast with a "not configured" message (no fetch)', async () => {
  let fetched = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetched = true;
    throw new Error('should not be called');
  }) as typeof fetch;
  try {
    const res = await submitBridgeRelay({
      direction: 'solana_to_evm',
      sourceChain: 'solana',
      destChain: 'ethereum',
      sourceTx: 'sig',
    });
    assert.equal(res.status, 'failed');
    assert.match(res.error ?? '', /not configured/i);
    assert.equal(fetched, false, 'no network call is attempted when unconfigured');
  } finally {
    globalThis.fetch = realFetch;
  }
});
