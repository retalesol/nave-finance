// ─── Persistent EVM reward-accrual memory ────────────────────────────────────
// When an EVM staking pool's local drip window is empty (mirror hasn't
// delivered wNAVE yet), useStaking projects the user's claimable rewards from
// their share of the Solana reward vault. That projection is display-side —
// the EVM contract has no record of it — so without an anchor it would restart
// from zero on every page load. This module persists the accrual per
// (chainId, wallet) in localStorage: the folded amount earned so far, the rate
// it was accruing at, and the timestamp it was last folded. On each sync the
// hook folds `rate × elapsed` into the stored amount, so refreshes and the
// 18-second poll continue the counter instead of resetting it.

interface AccrualRecord {
  /** User's staked principal (base units, stringified) the accrual belongs to. */
  stakedRaw: string;
  /** Folded accrued reward so far (base units, stringified). */
  accruedRaw: string;
  /** Rate (base units/sec, float) in effect since `anchorMs`. */
  ratePerSec: number;
  /** Timestamp (ms) the accrual was last folded. */
  anchorMs: number;
}

function storageKey(chainId: number, wallet: string): string {
  return `nave_stake_accrual_v1:${chainId}:${wallet.toLowerCase()}`;
}

function load(chainId: number, wallet: string): AccrualRecord | null {
  try {
    const raw = localStorage.getItem(storageKey(chainId, wallet));
    if (!raw) return null;
    const rec = JSON.parse(raw) as AccrualRecord;
    if (
      typeof rec.stakedRaw !== 'string' ||
      typeof rec.accruedRaw !== 'string' ||
      typeof rec.ratePerSec !== 'number' ||
      typeof rec.anchorMs !== 'number'
    ) {
      return null;
    }
    return rec;
  } catch {
    return null;
  }
}

function save(chainId: number, wallet: string, rec: AccrualRecord): void {
  try {
    localStorage.setItem(storageKey(chainId, wallet), JSON.stringify(rec));
  } catch {
    // Storage unavailable (private mode / quota) — accrual falls back to
    // session-only behavior.
  }
}

/** Drop the stored accrual (full unstake, successful claim, wallet switch). */
export function clearAccrual(chainId: number, wallet: string): void {
  try {
    localStorage.removeItem(storageKey(chainId, wallet));
  } catch {
    // ignore
  }
}

/**
 * Fold elapsed accrual and return the up-to-date pending amount (base units).
 *
 * Called on every sync while the projection is active. Folds the previously
 * stored `ratePerSec × elapsed` into the persistent total, re-anchors at
 * `nowMs`, records the new rate, and returns the folded total. Starting a new
 * position (no record, or the staked principal changed after an unstake to a
 * different amount) begins from the existing folded total when the principal
 * grew (staking more keeps what you earned) or from zero when there was no
 * prior record.
 */
export function foldAccrual(
  chainId: number,
  wallet: string,
  stakedRaw: bigint,
  ratePerSec: number,
  nowMs: number,
): bigint {
  const rec = load(chainId, wallet);

  let accrued = 0n;
  if (rec) {
    accrued = BigInt(rec.accruedRaw);
    // Fold what the previous rate earned since it was anchored. Cap elapsed at
    // 0 to tolerate clock skew.
    const elapsedSec = Math.max(0, (nowMs - rec.anchorMs) / 1000);
    if (rec.ratePerSec > 0 && Number.isFinite(rec.ratePerSec)) {
      accrued += BigInt(Math.floor(rec.ratePerSec * elapsedSec));
    }
  }

  save(chainId, wallet, {
    stakedRaw: stakedRaw.toString(),
    accruedRaw: accrued.toString(),
    ratePerSec,
    anchorMs: nowMs,
  });
  return accrued;
}
