import test from 'node:test';
import assert from 'node:assert/strict';
import {
  axisWidth,
  buildBalanceSeries,
  formatAxisUsd,
  pickCategoryTicks,
  tickLabels,
  xTickCount,
  yDomain,
} from '../../src/lib/balanceChart';

const now = Date.parse('2026-10-26T18:00:00Z');

test('same-day snapshots are not labeled with the same date', () => {
  const history = Array.from({ length: 40 }, (_, index) => ({
    snapshotAt: new Date(Date.parse('2026-10-25T12:00:00Z') + index * 15 * 60 * 1000).toISOString(),
    totalValueUsd: 0.08 + index * 0.0002,
  }));
  const series = buildBalanceSeries(history, '90D', now);
  assert.ok(series.length > 1);
  assert.ok(series.length <= 48);
  const ticks = pickCategoryTicks(series, xTickCount(series.length, '90D', false));
  const labels = [...tickLabels(series, ticks).values()];
  assert.ok(labels.length <= 5);
  assert.equal(new Set(labels).size, labels.length);
  assert.ok(labels.every((label) => !label.startsWith('Oct')));
});

test('a year of days keeps a handful of month labels', () => {
  const history = Array.from({ length: 200 }, (_, index) => ({
    snapshotAt: new Date(now - (199 - index) * 86_400_000).toISOString(),
    totalValueUsd: 1000 + index,
  }));
  const series = buildBalanceSeries(history, '1Y', now);
  assert.ok(series.length > 100);
  const ticks = pickCategoryTicks(series, xTickCount(series.length, '1Y', false));
  assert.ok(ticks.length <= 6);
  const labels = [...tickLabels(series, ticks).values()];
  assert.equal(new Set(labels).size, labels.length);
});

test('axis money follows the amounts in view', () => {
  assert.equal(formatAxisUsd(0.086, 0.09), '$0.086');
  assert.equal(formatAxisUsd(0, 0.09), '$0');
  assert.equal(formatAxisUsd(12500, 140000), '$13k');
  const cents = yDomain([0.08, 0.086, 0.09]);
  assert.ok(cents[0] < 0.08);
  assert.ok(cents[1] > 0.09);
  assert.ok(cents[0] >= 0);
  const flat = yDomain([0.086, 0.086]);
  assert.ok(flat[1] - flat[0] > 0.01);
  assert.ok(axisWidth(cents) >= 52);
});
