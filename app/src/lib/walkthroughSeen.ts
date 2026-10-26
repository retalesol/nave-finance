/** Per-treasury first-run intro + walkthrough completion. */

const KEY = 'nave_walkthrough_seen';

function normalizeTreasuryKey(daoAddress: string): string {
  const trimmed = daoAddress.trim();
  if (trimmed.startsWith('0x')) return trimmed.toLowerCase();
  return trimmed;
}

export function walkthroughSeenStorageKey(daoAddress: string): string {
  return `${KEY}_${normalizeTreasuryKey(daoAddress)}`;
}

export function hasSeenWalkthrough(daoAddress: string | null | undefined): boolean {
  if (!daoAddress || typeof localStorage === 'undefined') return false;
  try {
    return localStorage.getItem(walkthroughSeenStorageKey(daoAddress)) === '1';
  } catch {
    return false;
  }
}

export function markWalkthroughSeen(daoAddress: string): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(walkthroughSeenStorageKey(daoAddress), '1');
  } catch {
    // ignore quota / private mode
  }
}
