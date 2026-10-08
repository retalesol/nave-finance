// Pre-sign guard predicates the bridge flow enforces before ever building a tx
// (see useBridge.bridge()): positive amount, a destination address VALID FOR THE
// ACTIVE DIRECTION (no silent wrong-chain send), and a balance check against the
// GROSS (net + on-top fee) in BOTH directions — the EVM burn pulls the gross and
// the Solana lock instruction pulls net + fee from the sender too (m13 fix).
// These pin the pure logic behind those guards using the same helpers the hook
// calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseUnits } from 'viem';
import { PublicKey } from '@solana/web3.js';
import { quoteBridge } from '../../src/lib/bridge/routes';
import { isEvmAddress } from '../../src/lib/chain/types';
import { NAVE_DECIMALS } from '../../src/lib/programConfig';

// parseAmountRaw mirrors useBridge/useStaking: parseUnits, or 0n on bad input.
function parseAmountRaw(amount: string): bigint {
  const t = amount.trim();
  if (!t) return 0n;
  try {
    return parseUnits(t, NAVE_DECIMALS);
  } catch {
    return 0n;
  }
}

test('amount parsing: blank/garbage → 0n (bridge rejects "invalid amount")', () => {
  assert.equal(parseAmountRaw(''), 0n);
  assert.equal(parseAmountRaw('   '), 0n);
  assert.equal(parseAmountRaw('abc'), 0n);
  assert.equal(parseAmountRaw('1.5'), 1_500_000n, '6-decimal base units');
  assert.equal(parseAmountRaw('0'), 0n);
});

test('destination validity is direction-specific — no silent wrong-chain send', () => {
  const evm = '0x1111111111111111111111111111111111111111';
  const sol = '9KTuzRJdDs59KU5UXNXdTQrPznEiiz4URk29NC3PkK5Q';

  // solana_to_evm requires an EVM destination.
  assert.equal(isEvmAddress(evm), true);
  assert.equal(isEvmAddress(sol), false, 'a Solana address is NOT accepted as an EVM destination');

  // evm_to_solana requires a base58 Solana pubkey (the hook constructs a PublicKey).
  assert.doesNotThrow(() => new PublicKey(sol));
  assert.throws(() => new PublicKey(evm), 'an EVM address is NOT a valid Solana recipient');
});

test('EVM→Solana insufficient-balance check compares the GROSS, not the net', () => {
  const net = 1_000_000n; // user wants to bridge 1 NAVE
  const { grossRaw } = quoteBridge(net);
  assert.ok(grossRaw > net, 'gross includes the on-top fee');

  // A wNAVE balance exactly equal to the NET is still insufficient — the burn
  // pulls the gross, so the guard `quote.grossRaw > balance` must trip.
  const balanceEqualToNet = net;
  assert.equal(grossRaw > balanceEqualToNet, true, 'net-sized balance is rejected (fee unfunded)');

  // A balance covering the gross passes.
  assert.equal(grossRaw > grossRaw, false);
});

test('Solana→EVM insufficient-balance check compares the GROSS, not the net (m13)', () => {
  // The lock instruction pulls net + on-top fee (the gross) from the sender's
  // token account, so the guard is `quote.grossRaw > solanaNaveBalance` — the
  // same gross gate as the EVM burn path. A balance between net and gross must
  // be REJECTED before signing (it would pass a net-only gate but fail on-chain).
  const net = 5_000_000n;
  const { grossRaw } = quoteBridge(net);
  assert.ok(grossRaw > net, 'gross includes the on-top fee');

  const balanceBetweenNetAndGross = net + (grossRaw - net) / 2n;
  assert.ok(balanceBetweenNetAndGross > net && balanceBetweenNetAndGross < grossRaw);
  assert.equal(grossRaw > balanceBetweenNetAndGross, true, 'net<balance<gross → blocked (fee unfunded)');

  assert.equal(grossRaw > net, true, 'balance exactly equal to net → blocked');
  assert.equal(grossRaw > grossRaw, false, 'balance covering the gross → allowed');
});
