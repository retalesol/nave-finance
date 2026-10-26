import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyStablePar,
  journalDraft,
  prorateCents,
  remainingAtomic,
  replayLots,
  stableParCents,
  type CryptoEvent,
} from '../../src/lib/pay/lots';

function event(partial: Partial<CryptoEvent> & Pick<CryptoEvent, 'id' | 'direction' | 'assetId' | 'qtyAtomic'>): CryptoEvent {
  return {
    at: partial.at ?? '2024-06-01T00:00:00Z',
    date: partial.date ?? '2024-06-01',
    chain: partial.chain ?? 'solana',
    txHash: partial.txHash ?? partial.id,
    container: partial.container ?? 'wallet-a',
    usdCents: partial.usdCents ?? null,
    feeAssetId: partial.feeAssetId ?? null,
    feeQtyAtomic: partial.feeQtyAtomic ?? '0',
    feeUsdCents: partial.feeUsdCents ?? 0,
    kind: partial.kind ?? 'unclassified',
    pairEventId: partial.pairEventId ?? null,
    status: partial.status ?? 'confirmed',
    ...partial,
  };
}

test('FIFO consumes the oldest lot first and splits the next lot', () => {
  const replay = replayLots([
    event({ id: 'a', at: '2024-01-01T00:00:00Z', date: '2024-01-01', direction: 'in', assetId: 'sol', qtyAtomic: '10', usdCents: 100, kind: 'capital' }),
    event({ id: 'b', at: '2024-02-01T00:00:00Z', date: '2024-02-01', direction: 'in', assetId: 'sol', qtyAtomic: '10', usdCents: 300, kind: 'capital' }),
    event({ id: 'c', at: '2024-03-01T00:00:00Z', date: '2024-03-01', direction: 'out', assetId: 'sol', qtyAtomic: '15', usdCents: 400, kind: 'expense' }),
  ]);

  const spent = replay.disposals.filter((row) => row.role === 'disposal');
  assert.deepEqual(spent.map((row) => [row.lotId, row.qtyAtomic, row.basisCents]), [
    ['1', '10', 100],
    ['2', '5', prorateCents(300, 5n, 10n)],
  ]);
  assert.equal(spent.reduce((sum, row) => sum + row.basisCents, 0), 250);
  assert.equal(remainingAtomic(replay.lots, 'wallet-a', 'sol'), '5');
  const second = replay.lots.find((lot) => lot.id === '2');
  assert.equal(second?.remainingCostCents, 150);
  assert.equal(replay.lots.find((lot) => lot.id === '1')?.remainingAtomic, '0');
});

test('an internal transfer carries basis and the original acquisition date', () => {
  const replay = replayLots([
    event({
      id: 'buy',
      at: '2024-01-01T00:00:00Z',
      date: '2024-01-01',
      direction: 'in',
      assetId: 'sol',
      qtyAtomic: '10',
      usdCents: 100,
      kind: 'capital',
    }),
    event({
      id: 'in',
      at: '2024-04-01T00:00:00Z',
      date: '2024-04-01',
      direction: 'in',
      container: 'wallet-b',
      assetId: 'sol',
      qtyAtomic: '4',
      kind: 'transfer',
      txHash: 'bridge',
    }),
    event({
      id: 'out',
      at: '2024-04-01T00:00:00Z',
      date: '2024-04-01',
      direction: 'out',
      container: 'wallet-a',
      assetId: 'sol',
      qtyAtomic: '4',
      kind: 'transfer',
      txHash: 'bridge',
    }),
  ]);

  const moved = replay.disposals.find((row) => row.eventId === 'out');
  assert.equal(moved?.role, 'transfer');
  assert.equal(moved?.basisCents, 40);
  assert.equal(moved?.gainCents, 0);
  assert.equal(moved?.proceedsCents, 0);
  assert.equal(remainingAtomic(replay.lots, 'wallet-a', 'sol'), '6');

  const carried = replay.lots.filter((lot) => lot.container === 'wallet-b' && BigInt(lot.remainingAtomic) > 0n);
  assert.equal(carried.length, 1);
  assert.equal(carried[0].qtyAtomic, '4');
  assert.equal(carried[0].costCents, 40);
  assert.equal(carried[0].acquired, '2024-01-01');
  assert.equal(carried[0].originEventId, 'buy');
  assert.equal(carried[0].viaEventId, 'in');
  assert.equal(journalDraft(replay.events.find((row) => row.id === 'out')!, replay.disposals).length, 0);
});

test('a stablecoin at par disposes with no gain', () => {
  assert.equal(stableParCents('1000000', 6), 100);
  const priced = applyStablePar(
    [
      event({ id: 'in', direction: 'in', assetId: 'usdc', qtyAtomic: '1000000', kind: 'income' }),
      event({ id: 'out', at: '2024-07-01T00:00:00Z', date: '2024-07-01', direction: 'out', assetId: 'usdc', qtyAtomic: '1000000', kind: 'expense' }),
    ],
    [{ id: 'usdc', decimals: 6, isStable: true }],
  );
  const replay = replayLots(priced);
  const disposal = replay.disposals.find((row) => row.eventId === 'out');
  assert.equal(priced[0].usdCents, 100);
  assert.equal(priced[1].usdCents, 100);
  assert.equal(disposal?.basisCents, 100);
  assert.equal(disposal?.proceedsCents, 100);
  assert.equal(disposal?.gainCents, 0);
  assert.deepEqual(
    journalDraft(replay.events.find((row) => row.id === 'out')!, replay.disposals).map((line) => [line.role, line.debitCents, line.creditCents]),
    [
      ['offset', 100, 0],
      ['asset', 0, 100],
    ],
  );
});

test('gain is proceeds minus basis when the sale price differs from cost', () => {
  const replay = replayLots([
    event({ id: 'in', direction: 'in', assetId: 'sol', qtyAtomic: '100', usdCents: 1000, kind: 'capital' }),
    event({ id: 'out', at: '2025-08-01T00:00:00Z', date: '2025-08-01', direction: 'out', assetId: 'sol', qtyAtomic: '100', usdCents: 1500, kind: 'expense' }),
  ]);
  const disposal = replay.disposals.find((row) => row.eventId === 'out');
  assert.equal(disposal?.basisCents, 1000);
  assert.equal(disposal?.proceedsCents, 1500);
  assert.equal(disposal?.gainCents, 500);
  assert.equal(disposal?.term, 'long');
  assert.deepEqual(
    journalDraft(replay.events.find((row) => row.id === 'out')!, replay.disposals).map((line) => [line.role, line.debitCents, line.creditCents]),
    [
      ['offset', 1500, 0],
      ['asset', 0, 1000],
      ['gain', 0, 500],
    ],
  );
});

test('HIFO consumes the highest unit cost first', () => {
  const replay = replayLots([
    event({ id: 'cheap', at: '2024-01-01T00:00:00Z', date: '2024-01-01', direction: 'in', assetId: 'sol', qtyAtomic: '10', usdCents: 100, kind: 'capital' }),
    event({ id: 'rich', at: '2024-02-01T00:00:00Z', date: '2024-02-01', direction: 'in', assetId: 'sol', qtyAtomic: '10', usdCents: 300, kind: 'capital' }),
    event({ id: 'sell', at: '2024-03-01T00:00:00Z', date: '2024-03-01', direction: 'out', assetId: 'sol', qtyAtomic: '10', usdCents: 300, kind: 'expense' }),
  ], 'HIFO');
  assert.equal(replay.disposals[0].basisCents, 300);
  assert.equal(remainingAtomic(replay.lots, 'wallet-a', 'sol'), '10');
  assert.equal(replay.lots.find((lot) => lot.originEventId === 'cheap')?.remainingAtomic, '10');
});

test('gas is a disposal of the fee asset', () => {
  const replay = replayLots([
    event({ id: 'sol', direction: 'in', assetId: 'sol', qtyAtomic: '1000000000', usdCents: 10000, kind: 'capital' }),
    event({ id: 'usdc', at: '2024-06-02T00:00:00Z', direction: 'in', assetId: 'usdc', qtyAtomic: '1000000', usdCents: 100, kind: 'income' }),
    event({
      id: 'pay',
      at: '2024-06-03T00:00:00Z',
      date: '2024-06-03',
      direction: 'out',
      assetId: 'usdc',
      qtyAtomic: '1000000',
      usdCents: 100,
      kind: 'expense',
      feeAssetId: 'sol',
      feeQtyAtomic: '100000000',
      feeUsdCents: 1500,
    }),
  ]);
  const fee = replay.disposals.find((row) => row.role === 'fee');
  assert.equal(fee?.assetId, 'sol');
  assert.equal(fee?.basisCents, 1000);
  assert.equal(fee?.proceedsCents, 1500);
  assert.equal(fee?.gainCents, 500);
  assert.equal(remainingAtomic(replay.lots, 'wallet-a', 'sol'), '900000000');
  const lines = journalDraft(replay.events.find((row) => row.id === 'pay')!, replay.disposals);
  assert.deepEqual(lines.map((line) => [line.role, line.debitCents, line.creditCents]), [
    ['offset', 100, 0],
    ['asset', 0, 100],
    ['gas', 1500, 0],
    ['fee_asset', 0, 1000],
    ['gain', 0, 500],
  ]);
});
