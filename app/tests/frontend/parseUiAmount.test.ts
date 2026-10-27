import assert from 'node:assert/strict';
import test from 'node:test';
import { formatBaseUnits, parseUiAmount } from '../../src/lib/parseUiAmount.ts';

test('0.5 SOL is 500000000 lamports', () => {
  assert.equal(parseUiAmount('0.5', 9), 500_000_000n);
  assert.equal(parseUiAmount('.5', 9), 500_000_000n);
  assert.equal(parseUiAmount('0,5', 9), 500_000_000n);
  assert.equal(parseUiAmount('0.50', 9), 500_000_000n);
  assert.equal(parseUiAmount('0.5000000000000001', 9), 500_000_000n);
  assert.equal(formatBaseUnits(500_000_000n, 9), '0.5');
});
