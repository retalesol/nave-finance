// Bridge fee math — the UI quote must match the on-chain nave_bridge program:
// 2.5% ON TOP, split 1% staking / 1% protocol / 0.5% burn (100/100/50 bps), with
// the protocol leg absorbing integer-division dust so the legs always sum to the
// total fee. Mirrors programs/nave_bridge/src/{constants,fees}.rs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeBridgeFee,
  NAVE_BRIDGE_FEE_BPS,
  NAVE_BRIDGE_STAKING_BPS,
  NAVE_BRIDGE_PROTOCOL_BPS,
  NAVE_BRIDGE_BURN_BPS,
  NAVE_BRIDGE_ENABLED,
  NAVE_BRIDGE_EVM_CONFIRMATIONS,
  NAVE_DECIMALS,
  defaultGuardianThreshold,
} from '../../src/lib/programConfig';

test('config constants: 2.5% fee split 1% / 1% / 0.5%, 6-decimal NAVE, bridge enabled', () => {
  assert.equal(NAVE_BRIDGE_FEE_BPS, 250);
  assert.equal(NAVE_BRIDGE_STAKING_BPS, 100);
  assert.equal(NAVE_BRIDGE_PROTOCOL_BPS, 100);
  assert.equal(NAVE_BRIDGE_BURN_BPS, 50);
  assert.equal(NAVE_BRIDGE_STAKING_BPS + NAVE_BRIDGE_PROTOCOL_BPS + NAVE_BRIDGE_BURN_BPS, NAVE_BRIDGE_FEE_BPS);
  assert.equal(NAVE_DECIMALS, 6);
  assert.equal(NAVE_BRIDGE_EVM_CONFIRMATIONS, 5);
  assert.equal(NAVE_BRIDGE_ENABLED, true);
});

test('computeBridgeFee: fee is on-top (gross = net + fee), never deducted from net', () => {
  const net = 1_000_000n; // 1 NAVE
  const q = computeBridgeFee(net);
  assert.equal(q.netRaw, net, 'net is preserved — the user receives the full net on the far side');
  assert.equal(q.feeRaw, 25_000n, '2.5% of 1 NAVE');
  assert.equal(q.grossRaw, 1_025_000n, 'gross = net + fee');
  assert.equal(q.grossRaw, q.netRaw + q.feeRaw);
});

test('computeBridgeFee: legs equal 1% / 1% / 0.5% and always sum to feeRaw', () => {
  const net = 10_000_000n; // 10 NAVE — clean division
  const q = computeBridgeFee(net);
  assert.equal(q.stakingRaw, 100_000n, '1% staking leg');
  assert.equal(q.protocolRaw, 100_000n, '1% protocol leg');
  assert.equal(q.burnRaw, 50_000n, '0.5% burn leg');
  assert.equal(q.stakingRaw + q.protocolRaw + q.burnRaw, q.feeRaw, 'legs sum to total fee');
});

test('computeBridgeFee: protocol leg absorbs integer-division dust (legs still sum exactly)', () => {
  // Pick amounts where staking/burn truncate so the remainder lands in protocol.
  for (const net of [1n, 3n, 7n, 99n, 12_345n, 1_000_001n, 987_654_321n]) {
    const q = computeBridgeFee(net);
    assert.equal(
      q.stakingRaw + q.protocolRaw + q.burnRaw,
      q.feeRaw,
      `legs must sum to feeRaw for net=${net}`,
    );
    assert.ok(q.protocolRaw >= 0n, `protocol leg is non-negative for net=${net}`);
    assert.equal(q.grossRaw, q.netRaw + q.feeRaw, `gross invariant for net=${net}`);
    // Staking and burn are exact floor(net*bps/10000); protocol = fee - staking - burn.
    assert.equal(q.stakingRaw, (net * BigInt(NAVE_BRIDGE_STAKING_BPS)) / 10_000n);
    assert.equal(q.burnRaw, (net * BigInt(NAVE_BRIDGE_BURN_BPS)) / 10_000n);
  }
});

test('computeBridgeFee: zero amount yields a zero quote', () => {
  const q = computeBridgeFee(0n);
  assert.equal(q.feeRaw, 0n);
  assert.equal(q.grossRaw, 0n);
  assert.equal(q.stakingRaw + q.protocolRaw + q.burnRaw, 0n);
});

test('computeBridgeFee: rejects a negative amount', () => {
  assert.throws(() => computeBridgeFee(-1n), /non-negative/);
});

test('defaultGuardianThreshold: a custodied guardian never completes a quorum of a human minority', () => {
  // EVM: humans + one Nave-custodied guardian.
  assert.equal(defaultGuardianThreshold(2, 1), 2); // founder + custodied: both required
  assert.equal(defaultGuardianThreshold(3, 1), 2); // 2 humans: both humans suffice
  assert.equal(defaultGuardianThreshold(4, 1), 3); // 3 humans: custodied + 1 human is not enough
  assert.equal(defaultGuardianThreshold(6, 1), 5);
  // Solana: no custodied guardian.
  assert.equal(defaultGuardianThreshold(1), 1);
  assert.equal(defaultGuardianThreshold(2), 2);
  assert.equal(defaultGuardianThreshold(5), 3);
});
