// ─── EVM claim-on-demand rewards client ───────────────────────────────────────
// EVM staking rewards accrue in a server-side ledger (the staker's pro-rata
// share of the ONE Solana reward pool); nothing sits in the per-chain drip
// contracts. The relayer wraps and mints wNAVE straight to the staker at claim
// time. Same trust posture as the bridge relay client: no secret in the
// browser — the claim is authorized by an EIP-191 signature from the staking
// wallet itself over a freshness-bounded message the relayer verifies.

import { NAVE_BRIDGE_RELAYER_URL } from '../programConfig';

/** Mirrors stakeClaims.ts `claimMessage` — byte-identical format required. */
export function stakeClaimMessage(chainId: number, staker: string, issuedAtSec: number): string {
  return `nave-stake-claim\nchain:${chainId}\nstaker:${staker.toLowerCase()}\nissued:${issuedAtSec}`;
}

export interface StakeClaimPending {
  claimableRaw: bigint;
  ratePerSecFloat: number;
}

export interface StakeClaimOutcome {
  status: 'completed' | 'nothing_to_claim' | 'reserve_empty' | 'failed';
  claimedRaw?: bigint;
  mintTx?: string;
  /** Solana reserve→custody wrap tx. */
  wrapTx?: string;
  /** bridge_stake_events row id for live phase polling. */
  claimId?: string;
  error?: string;
}

function relayerBase(): string | null {
  return NAVE_BRIDGE_RELAYER_URL ? NAVE_BRIDGE_RELAYER_URL.replace(/\/+$/, '') : null;
}

/**
 * Server-folded claimable rewards for a staker on an EVM chain. Returns null
 * when the relayer is unreachable or claims are disabled (callers fall back
 * to the local projection).
 */
export async function fetchStakeClaimPending(
  chainId: number,
  staker: string,
): Promise<StakeClaimPending | null> {
  const base = relayerBase();
  if (!base) return null;
  try {
    const res = await fetch(
      `${base}/stake-claim/pending?chainId=${chainId}&staker=${encodeURIComponent(staker)}`,
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { claimableRaw?: string; ratePerSecFloat?: number };
    if (body.claimableRaw == null) return null;
    return {
      claimableRaw: BigInt(body.claimableRaw),
      ratePerSecFloat: typeof body.ratePerSecFloat === 'number' ? body.ratePerSecFloat : 0,
    };
  } catch {
    return null;
  }
}

/**
 * Balance of the relayer-owned Solana reward reserve that EVM claims pay out
 * of. The UI's "Reward pool" tile shows reward vault + reserve so the pool
 * visibly shrinks when rewards are claimed on ANY chain. Null when the
 * relayer is unreachable or claims are disabled.
 */
export async function fetchStakeClaimReserve(): Promise<bigint | null> {
  const base = relayerBase();
  if (!base) return null;
  try {
    const res = await fetch(`${base}/stake-claim/pool`);
    if (!res.ok) return null;
    const body = (await res.json()) as { reserveRaw?: string };
    return body.reserveRaw != null ? BigInt(body.reserveRaw) : null;
  } catch {
    return null;
  }
}

/**
 * Execute a claim: `signMessage` must be the staking wallet's signer (wagmi's
 * signMessage action). The relayer verifies, folds the ledger, and mints
 * wNAVE to the staker; errors map to `{ status: 'failed', error }`.
 */
export async function submitStakeClaim(
  chainId: number,
  staker: string,
  signMessage: (message: string) => Promise<string>,
): Promise<StakeClaimOutcome> {
  const base = relayerBase();
  if (!base) return { status: 'failed', error: 'Reward relayer is not configured for this environment.' };

  try {
    const issuedAtSec = Math.floor(Date.now() / 1000);
    const signature = await signMessage(stakeClaimMessage(chainId, staker, issuedAtSec));

    const res = await fetch(`${base}/stake-claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chainId, staker, issuedAtSec, signature }),
    });
    let body: {
      status?: StakeClaimOutcome['status'];
      claimedRaw?: string;
      mintTx?: string;
      wrapTx?: string;
      claimId?: string;
      error?: string;
    } = {};
    try {
      body = await res.json();
    } catch {
      // Non-JSON (gateway error page) — fall through to status handling.
    }
    if (!res.ok) {
      return { status: 'failed', error: body.error || `Relayer responded ${res.status}` };
    }
    return {
      status: body.status ?? 'failed',
      claimedRaw: body.claimedRaw != null ? BigInt(body.claimedRaw) : undefined,
      mintTx: body.mintTx,
      wrapTx: body.wrapTx,
      claimId: body.claimId,
      error: body.error,
    };
  } catch (err) {
    return {
      status: 'failed',
      error: err instanceof Error ? err.message : 'Failed to reach the reward relayer.',
    };
  }
}
