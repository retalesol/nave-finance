// ─── DAO creation recovery — "Resume setup" persistence ──────────────────────
// The unified creation wizard runs several ON-CHAIN transactions to create a
// treasury, followed by a handful of POST-CREATION steps (agent key binding,
// governance token registration, off-chain metadata registration, constitution
// activation). Once the treasury exists on-chain there is no "undo" — if any
// post-creation step fails, the DAO is a real, funded, on-chain entity that
// the founder should be able to finish setting up rather than re-run the whole
// wizard (which would try to create a SECOND DAO).
//
// This module persists a small, JSON-serializable checkpoint to localStorage
// whenever a post-creation step fails, keyed by (chain, founder wallet), so a
// "Resume setup" banner can rehydrate it — even across a page reload — and
// retry ONLY the remaining steps. Every step re-run from a checkpoint MUST be
// idempotent (checked against on-chain/off-chain state) so a resume can never
// double-submit a step that already landed; see `createDaoActivation.ts` /
// `createDaoActivationEvm.ts` for the on-chain idempotency checks this relies
// on, and `resumeDaoCreation.ts` for the resume-side step implementations.

import type { PolicyState } from '../components/ConstitutionStep';
import type { ChainFamily } from './chain/types';

/** A `GovernanceType`/`TokenMode` snapshot mirrors CreateDAO.tsx's local types
 *  (kept as plain strings here so this module has no UI dependency). */
export interface PendingDaoCreation {
  chain: ChainFamily;
  /** EVM only — numeric chain id (1/8453/11155111/84532). */
  chainId?: number;
  /** Treasury address (EVM) or DAO registry PDA (Solana), base58/0x string. */
  daoAddress: string;
  /** Solana only — the DAO's sequential id (needed to re-derive PDAs). */
  daoId?: number;
  /** EVM only — the pending agent-key generation ref used before the treasury existed. */
  daoRef?: string;
  /** Connected wallet that started this flow (base58 or 0x, lowercase for EVM). */
  founder: string;
  name: string;
  slug: string;
  description: string;
  governanceType: 'wallets' | 'token' | null;
  tokenMode: 'existing' | 'new' | null;
  existingTokenCA: string;
  newTokenName: string;
  newTokenSupply: string;
  /** Resolved governance token mint/address once known (null until registered). */
  votingTokenMint: string | null;
  guardianWallets: string[];
  seedAmount: string;
  policy: PolicyState;
  website: string;
  twitter: string;
  discord: string;
  /** Uploaded logo URL, if the upload completed before the failure (best-effort — the
   *  original Blob cannot be persisted, so a resume after a reload skips re-uploading). */
  logoUrl: string;
  /** Human-readable label of the step that failed (for the resume banner). */
  failedStep: string;
  /** Error from the failed step. Empty while a signature is still in flight —
   *  that checkpoint can be resumed, but it is not a failure yet. */
  failedError: string;
  /** ISO timestamp of the failure. */
  failedAt: string;
}

const STORAGE_KEY = 'nave.pendingDaoCreation.v1';
/** Same-tab signal so a remounted wizard can show the banner after a real error. */
export const PENDING_DAO_CREATION_EVENT = 'nave:pending-dao-creation';

/** The Resume setup banner is a failure notice. An in-progress checkpoint
 *  (saved before the wallet returns) has no error and must not show that copy. */
export function daoCreationFailureMessage(
  record: Pick<PendingDaoCreation, 'failedError'> | null | undefined,
): string | null {
  const message = record?.failedError?.trim() ?? '';
  return message ? message : null;
}
/** Stale checkpoints older than this are ignored (avoids resurrecting a very old, likely-abandoned flow). */
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

type Store = Record<string, PendingDaoCreation>;

function hasLocalStorage(): boolean {
  try {
    return typeof window !== 'undefined' && !!window.localStorage;
  } catch {
    return false;
  }
}

function readStore(): Store {
  if (!hasLocalStorage()) return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed as Store : {};
  } catch {
    return {};
  }
}

function writeStore(store: Store): void {
  if (!hasLocalStorage()) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Storage full or unavailable (e.g. private browsing) — resumability is a
    // best-effort convenience, never block the deploy flow on it.
  }
}

function notifyPendingDaoCreation(): void {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  window.dispatchEvent(new CustomEvent(PENDING_DAO_CREATION_EVENT));
}

function keyFor(chain: string, founder: string): string {
  return `${chain}:${founder.toLowerCase()}`;
}

function isFresh(record: PendingDaoCreation): boolean {
  const t = Date.parse(record.failedAt);
  return Number.isFinite(t) && Date.now() - t <= MAX_AGE_MS;
}

/** Persist (or overwrite) the in-progress checkpoint for this (chain, founder). */
export function savePendingDaoCreation(record: PendingDaoCreation): void {
  const store = readStore();
  store[keyFor(record.chain, record.founder)] = record;
  writeStore(store);
  notifyPendingDaoCreation();
}

/** Load the checkpoint for a specific (chain, founder), or null if none/stale. */
export function loadPendingDaoCreation(chain: string, founder: string | null | undefined): PendingDaoCreation | null {
  if (!founder) return null;
  const record = readStore()[keyFor(chain, founder)];
  if (!record || !isFresh(record)) return null;
  return record;
}

/** Clear the checkpoint once the flow completes successfully (or the user dismisses it). */
export function clearPendingDaoCreation(chain: string, founder: string | null | undefined): void {
  if (!founder) return;
  const store = readStore();
  delete store[keyFor(chain, founder)];
  writeStore(store);
  notifyPendingDaoCreation();
}

/**
 * Find ANY fresh pending creation for this wallet, across chains — used for a
 * wallet-scoped "Resume setup" banner regardless of which chain tab happens to
 * be selected when the wizard reopens. Prunes stale entries opportunistically.
 */
export function findPendingDaoCreationForWallet(founder: string | null | undefined): PendingDaoCreation | null {
  if (!founder) return null;
  const store = readStore();
  let mutated = false;
  let match: PendingDaoCreation | null = null;
  for (const [key, record] of Object.entries(store)) {
    if (!isFresh(record)) {
      delete store[key];
      mutated = true;
      continue;
    }
    if (record.founder.toLowerCase() === founder.toLowerCase()) {
      match = record;
    }
  }
  if (mutated) writeStore(store);
  return match;
}
