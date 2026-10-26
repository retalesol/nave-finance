export type BalanceRange = '30D' | '90D' | '1Y';

export type BalancePoint = {
  key: string;
  axisLabel: string;
  tipLabel: string;
  value: number;
};

const RANGE_DAYS: Record<BalanceRange, number> = {
  '30D': 30,
  '90D': 90,
  '1Y': 365,
};

const DAY_MS = 86_400_000;

export function buildBalanceSeries(
  history: { snapshotAt: string; totalValueUsd: number }[],
  range: BalanceRange,
  now = Date.now(),
): BalancePoint[] {
  const cutoff = now - RANGE_DAYS[range] * DAY_MS;
  const rows = history
    .map((row) => ({ at: new Date(row.snapshotAt).getTime(), value: row.totalValueUsd }))
    .filter((row) => Number.isFinite(row.at) && row.at >= cutoff && Number.isFinite(row.value))
    .sort((a, b) => a.at - b.at);
  if (rows.length === 0) return [];

  const span = rows[rows.length - 1].at - rows[0].at;
  if (span < 36 * 60 * 60 * 1000) {
    return downsample(rows, 48).map((row) => ({
      key: String(row.at),
      axisLabel: formatClock(row.at),
      tipLabel: formatStamp(row.at),
      value: row.value,
    }));
  }

  const byDay = new Map<string, { at: number; value: number }>();
  for (const row of rows) {
    byDay.set(dayKey(row.at), row);
  }
  const days = [...byDay.keys()].sort();
  const daySpan = days.length < 2 ? 0 : (byDay.get(days[days.length - 1])!.at - byDay.get(days[0])!.at) / DAY_MS;
  return days.map((day) => {
    const row = byDay.get(day)!;
    return {
      key: day,
      axisLabel: formatDay(row.at, range === '1Y' && daySpan > 180),
      tipLabel: formatStamp(row.at),
      value: row.value,
    };
  });
}

export function xTickCount(pointCount: number, range: BalanceRange, narrow: boolean): number {
  if (pointCount <= 1) return pointCount;
  const target = narrow ? 3 : range === '1Y' ? 6 : 5;
  return Math.min(pointCount, target);
}

export function pickCategoryTicks(points: BalancePoint[], count: number): string[] {
  if (points.length === 0 || count <= 0) return [];
  if (points.length <= count) return points.map((point) => point.key);
  const last = points.length - 1;
  const keys: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const key = points[Math.round((i * last) / (count - 1))].key;
    if (keys[keys.length - 1] !== key) keys.push(key);
  }
  return keys;
}

/** Tick text for the chosen marks. Repeating month names gain the day. */
export function tickLabels(points: BalancePoint[], keys: string[]): Map<string, string> {
  const byKey = new Map(points.map((point) => [point.key, point.axisLabel]));
  const labels = keys.map((key) => byKey.get(key) ?? key);
  const counts = new Map<string, number>();
  for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
  const collide = [...counts.values()].some((count) => count > 1);
  const resolved = new Map<string, string>();
  keys.forEach((key, index) => {
    const point = points.find((item) => item.key === key);
    if (collide && point) {
      const at = Number(point.key);
      resolved.set(key, Number.isFinite(at) && point.key.length > 10 ? formatClock(at) : formatDay(dateFromDay(point.key), false));
      return;
    }
    resolved.set(key, labels[index]);
  });
  return resolved;
}

export function yDomain(values: number[]): [number, number] {
  if (values.length === 0) return [0, 1];
  const floor = Math.min(...values);
  let min = floor;
  let max = Math.max(...values);
  if (min === max) {
    const pad = Math.max(Math.abs(max) * 0.25, max === 0 ? 1 : 0.01);
    min -= pad;
    max += pad;
  } else {
    const pad = (max - min) * 0.16;
    min -= pad;
    max += pad;
  }
  if (min < 0 && floor >= 0) min = 0;
  return [min, max];
}

export function formatAxisUsd(value: number, scale: number): string {
  if (value === 0) return '$0';
  const ceiling = Math.max(Math.abs(scale), Math.abs(value));
  if (ceiling < 0.01) return `$${value.toFixed(4)}`;
  if (ceiling < 1) return `$${value.toFixed(3)}`;
  if (ceiling < 100) return `$${value.toFixed(2)}`;
  if (ceiling < 1000) return `$${Math.round(value)}`;
  if (ceiling < 10_000) return `$${(value / 1000).toFixed(1)}k`;
  return `$${Math.round(value / 1000)}k`;
}

export function formatBalanceUsd(value: number): string {
  const abs = Math.abs(value);
  const digits = abs < 1 ? 3 : abs < 100 ? 2 : 0;
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function axisWidth(domain: [number, number]): number {
  const scale = Math.max(Math.abs(domain[0]), Math.abs(domain[1]));
  const longest = Math.max(
    formatAxisUsd(domain[0], scale).length,
    formatAxisUsd(domain[1], scale).length,
  );
  return Math.min(84, Math.max(52, Math.round(longest * 7.2 + 16)));
}

function downsample(rows: { at: number; value: number }[], maxPoints: number) {
  if (rows.length <= maxPoints) return rows;
  const last = rows.length - 1;
  const picked: { at: number; value: number }[] = [];
  for (let i = 0; i < maxPoints; i += 1) {
    const row = rows[Math.round((i * last) / (maxPoints - 1))];
    if (picked[picked.length - 1]?.at !== row.at) picked.push(row);
  }
  return picked;
}

function dayKey(at: number): string {
  const date = new Date(at);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function dateFromDay(day: string): number {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(year, (month || 1) - 1, date || 1).getTime();
}

function formatDay(at: number, monthOnly: boolean): string {
  return new Date(at).toLocaleDateString('en-US', monthOnly
    ? { month: 'short' }
    : { month: 'short', day: 'numeric' });
}

function formatClock(at: number): string {
  return new Date(at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function formatStamp(at: number): string {
  return new Date(at).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
