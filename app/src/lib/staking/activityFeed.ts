// ─── Wallet activity feed (stakes / unstakes / claims) ───────────────────────
// Powers the "Your Transactions" list on the Bridge & Stake page alongside
// bridge transfers. Two sources merge here:
//
//   • DB rows — bridge_stake_events (public read): EVM Staked/Unstaked events
//     mirrored by the worker, and reward_claim rows the relayer walks through
//     submitted → wrapping → delivering → completed/failed.
//   • LOCAL entries — recorded by useStaking the moment an action happens
//     (Solana actions are never mirrored to the DB; EVM stake/unstake rows
//     lag the ~10-minute mirror tick; an in-flight claim needs live status
//     before its DB row settles). Persisted in localStorage per wallet and
//     reconciled against DB rows by tx hash / claim row id.
//
// Components subscribe via the `nave-activity` window event, fired whenever a
// local entry is written, so the feed updates in real time during a claim.

import { ACTIVE_EVM_CHAIN_IDS, EVM_DEPLOYMENT_MODE } from '../programConfig';
import { EVM_CHAIN_IDS, type EvmChainId } from '../chain/types';

export type ActivityKind = 'stake' | 'unstake' | 'claim';

/** Claim lifecycle phases (mirrors the relayer's bridge_stake_events.status). */
export type ClaimPhase = 'signing' | 'submitted' | 'wrapping' | 'delivering' | 'completed' | 'failed';

export interface ActivityEntry {
  /** Stable local id (uuid). DB-derived rows use the DB row id. */
  id: string;
  kind: ActivityKind;
  /** 'solana' | 'ethereum' | 'base' | 'robinhood' */
  chainFamily: string;
  /** EVM chain id when applicable. */
  chainId?: number;
  wallet: string;
  amountRaw?: string;
  /** Primary tx (stake/unstake tx, or the claim's EVM mint once known). */
  tx?: string;
  /** Claim only: the Solana reserve→custody wrap tx. */
  wrapTx?: string;
  /** Claim only: bridge_stake_events row id, once known (dedupe key vs DB). */
  claimId?: string;
  /** 'completed' | 'failed' | a ClaimPhase for in-flight claims. */
  status: string;
  error?: string;
  createdAt: string;
}

/** Per-profile store so mixed/mainnet/testnet local rows never collide. */
const STORE_KEY = `nave_activity_v1_${EVM_DEPLOYMENT_MODE}`;
const MAX_ENTRIES = 30;
export const ACTIVITY_EVENT = 'nave-activity';

/** EVM chain ids that are NOT in the active deployment — drop from local merges. */
const FOREIGN_EVM_CHAIN_IDS = new Set<number>(
  (EVM_CHAIN_IDS as readonly EvmChainId[]).filter((id) => !ACTIVE_EVM_CHAIN_IDS.includes(id)),
);

function isActivityForActiveNetwork(entry: ActivityEntry): boolean {
  if (typeof entry.chainId === 'number' && FOREIGN_EVM_CHAIN_IDS.has(entry.chainId)) {
    return false;
  }
  return true;
}

function readAll(): ActivityEntry[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as ActivityEntry[];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function writeAll(entries: ActivityEntry[]): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)));
  } catch {
    // Storage unavailable — feed falls back to DB rows only.
  }
  try {
    window.dispatchEvent(new Event(ACTIVITY_EVENT));
  } catch {
    // Non-browser environment (tests).
  }
}

/** Insert or update (by id) a local activity entry and notify subscribers. */
export function upsertActivity(entry: ActivityEntry): void {
  const all = readAll();
  const idx = all.findIndex((e) => e.id === entry.id);
  if (idx >= 0) all[idx] = entry;
  else all.unshift(entry);
  writeAll(all);
}

export function removeActivity(id: string): void {
  writeAll(readAll().filter((e) => e.id !== id));
}

/** Local entries for any of the given wallets (case-insensitive). */
export function readLocalActivity(wallets: (string | null | undefined)[]): ActivityEntry[] {
  const set = new Set(wallets.filter(Boolean).map((w) => (w as string).toLowerCase()));
  if (set.size === 0) return [];
  return readAll().filter((e) => set.has(e.wallet.toLowerCase()) && isActivityForActiveNetwork(e));
}

/**
 * Merge local entries with DB-derived rows: a DB row supersedes the local
 * entry that produced it (matched by claim row id or tx hash), because the DB
 * carries the authoritative status. Result is newest-first.
 */
export function mergeActivity(local: ActivityEntry[], db: ActivityEntry[]): ActivityEntry[] {
  const dbClaimIds = new Set(db.map((e) => e.claimId ?? e.id));
  const dbTxs = new Set(db.flatMap((e) => [e.tx, e.wrapTx].filter(Boolean) as string[]));
  const kept = local.filter((e) => {
    if (!isActivityForActiveNetwork(e)) return false;
    if (e.claimId && dbClaimIds.has(e.claimId)) return false;
    if (e.tx && dbTxs.has(e.tx)) return false;
    return true;
  });
  return [...kept, ...db.filter(isActivityForActiveNetwork)].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
}

/** Human status pill label for an activity entry. */
export function activityStatusLabel(entry: ActivityEntry, destChainLabel: string): string {
  if (entry.kind !== 'claim') return entry.status;
  switch (entry.status) {
    case 'signing':
      return 'Awaiting signature…';
    case 'submitted':
    case 'pending': // legacy rows written before staged statuses
      return 'Claim submitted';
    case 'wrapping':
      return 'Wrapping on Solana…';
    case 'delivering':
      return `Delivering to ${destChainLabel}…`;
    default:
      return entry.status; // completed | failed
  }
}

/** True while a claim entry is still moving (spinner + polling). */
export function isActivityInFlight(entry: ActivityEntry): boolean {
  return (
    entry.kind === 'claim' &&
    ['signing', 'submitted', 'pending', 'wrapping', 'delivering'].includes(entry.status)
  );
}
