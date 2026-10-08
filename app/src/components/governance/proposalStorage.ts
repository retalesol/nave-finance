import { PublicKey } from '@solana/web3.js';
import type { EvmChainId } from '@/lib/chain/types';
import {
  loadEvmProposalPayloadRemote,
} from '@/lib/evmProposalPayloadStore';
import type { ProposalType } from './types';

// ── Vote persistence (localStorage) ─────────────────────────────────────────
// Cast votes are stored per (DAO, wallet, proposalId) so they survive reloads
// and never collide across treasuries (same proposal index on another DAO).
// Key: "nave_vote::<dao>::<wallet>::<proposalId>"  proposalId is e.g. "p1".
// Value: "for" | "against" | "abstain"
// Entries are cleared when the proposal is finalized (status transitions away from active).

export function normalizeDaoStorageKey(dao: string): string {
  const d = dao.trim();
  return d.startsWith('0x') ? d.toLowerCase() : d;
}

export function voteStorageKey(daoAddress: string | null, wallet: string, proposalId: string): string | null {
  if (!daoAddress) return null;
  return `nave_vote::${normalizeDaoStorageKey(daoAddress)}::${wallet}::${proposalId}`;
}

export function loadPersistedVote(
  daoAddress: string | null,
  wallet: string | null,
  proposalId: string,
): 'for' | 'against' | 'abstain' | null {
  if (!wallet) return null;
  const key = voteStorageKey(daoAddress, wallet, proposalId);
  if (!key) return null;
  try {
    const val = localStorage.getItem(key);
    return val === 'for' || val === 'against' || val === 'abstain' ? val : null;
  } catch { return null; }
}

export function persistVote(
  daoAddress: string,
  wallet: string,
  proposalId: string,
  vote: 'for' | 'against' | 'abstain',
): void {
  const key = voteStorageKey(daoAddress, wallet, proposalId);
  if (!key) return;
  try { localStorage.setItem(key, vote); } catch { /* ignore */ }
}

export function clearPersistedVote(daoAddress: string | null, wallet: string, proposalId: string): void {
  const key = voteStorageKey(daoAddress, wallet, proposalId);
  if (!key) return;
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}

// EVM governors store only keccak256(payload). Browsers persist the raw bytes
// here so token-mint ratification, constitution updates, strategy requests, and
// direct transfer execution can rebuild the preimage. Clearing site data or
// using another device drops this copy — recreate the proposal or add a
// server-side payload index later.
export function evmPayloadStorageKey(daoAddress: string, proposalIndex: number): string {
  return `nave_evm_payload::${daoAddress.toLowerCase()}::${proposalIndex}`;
}

export function persistEvmProposalPayload(
  daoAddress: string,
  proposalIndex: number,
  type: ProposalType,
  payload: number[],
): void {
  try {
    localStorage.setItem(
      evmPayloadStorageKey(daoAddress, proposalIndex),
      JSON.stringify({ type, payload }),
    );
  } catch { /* best effort only */ }
}

export function loadEvmProposalPayload(
  daoAddress: string | null,
  proposalIndex: number,
  expectedType?: ProposalType,
): number[] | null {
  if (!daoAddress) return null;
  try {
    const raw = localStorage.getItem(evmPayloadStorageKey(daoAddress, proposalIndex));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { type?: ProposalType; payload?: unknown };
    if (expectedType && parsed.type && parsed.type !== expectedType) return null;
    return Array.isArray(parsed.payload)
      ? parsed.payload.map((b) => Number(b) & 0xff)
      : null;
  } catch {
    return null;
  }
}

/**
 * Recover an EVM proposal payload: try the local cache first, then fall back to
 * the server-side payload index (verified against the on-chain payload hash).
 * Recovered remote payloads are written back to localStorage so subsequent
 * actions on this device are instant. Returns null only if no source has a
 * payload that matches the on-chain hash.
 */
export async function resolveEvmProposalPayload(
  daoAddress: string | null,
  chainId: number | null,
  proposalIndex: number,
  expectedType?: ProposalType,
): Promise<number[] | null> {
  const local = loadEvmProposalPayload(daoAddress, proposalIndex, expectedType);
  if (local && local.length) return local;
  if (!daoAddress || !chainId) return null;
  const remote = await loadEvmProposalPayloadRemote(chainId as EvmChainId, daoAddress, proposalIndex);
  if (remote && remote.length) {
    // Backfill the local cache for fast subsequent access.
    if (expectedType) persistEvmProposalPayload(daoAddress, proposalIndex, expectedType, remote);
    return remote;
  }
  return null;
}

// ── Solana strategy proposal payload ─────────────────────────────────────────
// When a Solana strategy proposal is created, the raw amount/adapter/mint are
// stored in localStorage so handleFinalize can auto-bundle create_execution_request
// in the same transaction (avoiding a separate manual step).

export function solanaStrategyPayloadKey(daoAddress: string, proposalIndex: number): string {
  return `nave:strategyPayload:${daoAddress}:${proposalIndex}`;
}

export function persistSolanaStrategyPayload(
  daoAddress: string,
  proposalIndex: number,
  amount: bigint,
  adapter: string,
  mint: string,
): void {
  try {
    localStorage.setItem(
      solanaStrategyPayloadKey(daoAddress, proposalIndex),
      JSON.stringify({ amount: amount.toString(), adapter, mint }),
    );
  } catch { /* best effort only */ }
}

export function loadSolanaStrategyPayload(
  daoAddress: string | null,
  proposalIndex: number,
): { amount: bigint; adapter: string; mint: string } | null {
  if (!daoAddress) return null;
  try {
    const raw = localStorage.getItem(solanaStrategyPayloadKey(daoAddress, proposalIndex));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { amount?: string; adapter?: string; mint?: string };
    if (!parsed.amount || !parsed.adapter || !parsed.mint) return null;
    return { amount: BigInt(parsed.amount), adapter: parsed.adapter, mint: parsed.mint };
  } catch {
    return null;
  }
}

/** Returns true when a finalize+execReq auto-chain was stored for this proposal. */
export function hasStoredStrategyPayload(daoAddress: string | null, proposalNumber: number): boolean {
  return loadSolanaStrategyPayload(daoAddress, proposalNumber) !== null;
}

/** Decode the encoded strategy proposal payload bytes into (adapter, amount, mint).
 *  Layout: [0..32] protocolProgram | [32..40] amount u64 LE | [40..72] mint */
export function decodeSolanaStrategyPayload(
  payload: number[],
): { amount: bigint; adapter: string; mint: string } | null {
  if (payload.length < 72) return null;
  try {
    const buf = new Uint8Array(payload);
    const adapter = new PublicKey(buf.slice(0, 32)).toBase58();
    const amountView = new DataView(buf.buffer, buf.byteOffset + 32, 8);
    const amount = amountView.getBigUint64(0, true /* little-endian */);
    const mint = new PublicKey(buf.slice(40, 72)).toBase58();
    return { amount, adapter, mint };
  } catch {
    return null;
  }
}