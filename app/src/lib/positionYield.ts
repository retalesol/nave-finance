/**
 * Yield measured from on-chain position marks. Treasury snapshots record each
 * position's principal (`deposited_base_units`) and mark
 * (`current_value_base_units`); value per unit of principal across snapshots
 * gives a realized APY that does not depend on any quoted venue rate.
 */

export interface PositionMark {
  atSecs: number;
  deposited: number;
  current: number;
}

const YEAR_SECS = 365 * 86_400;
/** Shorter windows annualize noise from a single mark into absurd rates. */
export const MIN_APY_WINDOW_SECS = 86_400;

/** Snapshot row key for a position: `protocol|mint` (lower-cased). */
export function positionKey(protocolId: string, mint: string): string {
  return `${protocolId.toLowerCase()}|${mint.toLowerCase()}`;
}

function protocolMintKey(row: Record<string, unknown>): string | null {
  return typeof row.protocol_id === 'string' && typeof row.mint === 'string'
    ? positionKey(row.protocol_id, row.mint)
    : null;
}

/** EVM positions are keyed by adapter on-chain. */
export function adapterKey(row: Record<string, unknown>): string | null {
  return typeof row.adapter === 'string' ? row.adapter.toLowerCase() : null;
}

/**
 * Collect marks per position from snapshot `strategy_positions` arrays
 * (oldest first). Rows without principal are skipped.
 */
export function marksFromSnapshots(
  snapshots: Array<{ snapshotAt: string; strategyPositions: unknown[] }>,
  keyOf: (row: Record<string, unknown>) => string | null = protocolMintKey,
): Map<string, PositionMark[]> {
  const out = new Map<string, PositionMark[]>();
  for (const snap of snapshots) {
    const atSecs = Math.floor(new Date(snap.snapshotAt).getTime() / 1000);
    if (!Number.isFinite(atSecs)) continue;
    for (const raw of snap.strategyPositions ?? []) {
      const row = raw as Record<string, unknown>;
      const key = keyOf(row);
      const deposited = Number(row.deposited_base_units ?? 0);
      const current = Number(row.current_value_base_units ?? 0);
      if (!key || !(deposited > 0) || !Number.isFinite(current)) continue;
      const list = out.get(key) ?? [];
      list.push({ atSecs, deposited, current });
      out.set(key, list);
    }
  }
  for (const list of out.values()) list.sort((a, b) => a.atSecs - b.atSecs);
  return out;
}

/**
 * Annualized growth of value per unit of principal between the oldest mark and
 * `latest`, in percent. Null when the window is under a day or a ratio is
 * undefined.
 */
export function measuredApy(marks: PositionMark[], latest?: PositionMark): number | null {
  const end = latest ?? marks[marks.length - 1];
  const start = marks[0];
  if (!start || !end || !(start.deposited > 0) || !(end.deposited > 0)) return null;
  const window = end.atSecs - start.atSecs;
  if (window < MIN_APY_WINDOW_SECS) return null;
  const startRatio = start.current / start.deposited;
  const endRatio = end.current / end.deposited;
  if (!(startRatio > 0)) return null;
  return (endRatio / startRatio - 1) * (YEAR_SECS / window) * 100;
}

/** Value-weighted APY over the strategies that have a measured rate; null if none. */
export function blendedApy(rows: Array<{ value: number; apy: number | null }>): number | null {
  let weight = 0;
  let sum = 0;
  for (const r of rows) {
    if (r.apy == null || !(r.value > 0)) continue;
    weight += r.value;
    sum += r.value * r.apy;
  }
  return weight > 0 ? sum / weight : null;
}
