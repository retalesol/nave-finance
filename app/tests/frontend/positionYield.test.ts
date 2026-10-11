import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  adapterKey,
  blendedApy,
  marksFromSnapshots,
  measuredApy,
  positionKey,
} from '../../src/lib/positionYield';

const DAY = 86_400;

test('measuredApy annualizes value per unit of principal', () => {
  const marks = [
    { atSecs: 0, deposited: 1_000_000, current: 1_000_000 },
    { atSecs: 30 * DAY, deposited: 1_000_000, current: 1_004_000 },
  ];
  const apy = measuredApy(marks);
  assert.ok(apy != null);
  assert.ok(Math.abs(apy - 0.4 * (365 / 30)) < 1e-9);
});

test('measuredApy ignores principal changes and needs a full day', () => {
  const marks = [
    { atSecs: 0, deposited: 100, current: 100 },
    { atSecs: 10 * DAY, deposited: 300, current: 303 },
  ];
  assert.ok(Math.abs((measuredApy(marks) ?? 0) - 1 * 36.5) < 1e-9);
  assert.equal(measuredApy([{ atSecs: 0, deposited: 1, current: 1 }, { atSecs: DAY - 1, deposited: 1, current: 2 }]), null);
  assert.equal(measuredApy([]), null);
});

test('marksFromSnapshots keys Solana rows by protocol and mint, EVM rows by adapter', () => {
  const snaps = [
    {
      snapshotAt: new Date(2 * DAY * 1000).toISOString(),
      strategyPositions: [
        { protocol_id: 'kamino', mint: 'MintA', deposited_base_units: '10', current_value_base_units: '11' },
        { protocol_id: 'aave', mint: '0xUSDC', adapter: '0xAdApTeR', deposited_base_units: '5', current_value_base_units: '5' },
        { protocol_id: 'jito', mint: 'MintB', deposited_base_units: '0', current_value_base_units: '0' },
      ],
    },
    {
      snapshotAt: new Date(0).toISOString(),
      strategyPositions: [
        { protocol_id: 'kamino', mint: 'MintA', deposited_base_units: '10', current_value_base_units: '10' },
      ],
    },
  ];
  const marks = marksFromSnapshots(snaps);
  const kamino = marks.get(positionKey('kamino', 'MintA'));
  assert.deepEqual(kamino?.map((m) => m.atSecs), [0, 2 * DAY]);
  assert.equal(marks.has(positionKey('jito', 'MintB')), false);
  assert.equal(marksFromSnapshots(snaps, adapterKey).get('0xadapter')?.length, 1);
});

test('blendedApy weights measured rates by value and skips unmeasured ones', () => {
  assert.equal(blendedApy([{ value: 100, apy: null }]), null);
  assert.equal(blendedApy([{ value: 300, apy: 4 }, { value: 100, apy: 8 }, { value: 500, apy: null }]), 5);
});
