import assert from 'node:assert/strict';
import test from 'node:test';
import { refusesClosedMainnetBridge, wnaveMintWouldExceedCustody } from './bridgeSupplyGuard.js';

test('mint within custody is allowed', () => {
  assert.equal(wnaveMintWouldExceedCustody(100n, 50n, 150n), false);
  assert.equal(wnaveMintWouldExceedCustody(0n, 1n, 1n), false);
});

test('mint that would exceed custody is refused', () => {
  assert.equal(wnaveMintWouldExceedCustody(100n, 51n, 150n), true);
  assert.equal(wnaveMintWouldExceedCustody(150n, 1n, 150n), true);
});

test('closed mainnet bridge id is refused only on a mainnet RPC', () => {
  const closed = 'Fu3ZpX1SMvqVhuo7E4uKGvJxe6cJDFDxxmSCET6de9u6';
  assert.equal(refusesClosedMainnetBridge(closed, 'https://api.mainnet-beta.solana.com'), true);
  assert.equal(refusesClosedMainnetBridge(closed, 'https://api.devnet.solana.com'), false);
  assert.equal(refusesClosedMainnetBridge('11111111111111111111111111111111', 'https://api.mainnet-beta.solana.com'), false);
});

test('negative inputs fail closed', () => {
  assert.equal(wnaveMintWouldExceedCustody(-1n, 1n, 10n), true);
});
