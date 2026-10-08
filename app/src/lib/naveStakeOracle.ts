import {
  NAVE_DAO_CREATION_STAKE_USD,
  NAVE_DEVNET_PRICE_USD,
  SOLANA_NAVE_MINT,
  SOLANA_NETWORK,
  SUPABASE_ANON_KEY,
  SUPABASE_FUNCTIONS_URL,
} from './programConfig';

// ─── Central NAVE price oracle client ─────────────────────────────────────────
// Thin browser/server client for the `nave-price-oracle` edge function — the ONE
// canonical NAVE/USD creation price. The UI never hardcodes a NAVE price or a
// stake amount: it asks the oracle how much NAVE `NAVE_DAO_CREATION_STAKE_USD` is worth and
// gets back both a human-readable amount and the exact u64 base units to stake.
//
// This util is intentionally side-effect free and UI-agnostic so it can be used
// by hooks, transaction builders, and tests alike. (The creation wizard owns its
// own UI; it consumes `useNaveStakeQuote` / `fetchNaveStakeQuote` from here.)

/** NAVE mint base-unit precision (USD -> NAVE base-unit conversion). */
export const NAVE_ORACLE_DECIMALS: number = (() => {
  const raw = import.meta.env.VITE_NAVE_ORACLE_NAVE_DECIMALS;
  const n = typeof raw === 'string' ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 6;
})();

/** Default USD value of the DAO-creation stake (mirrors the on-chain target). */
export const NAVE_ORACLE_STAKE_USD: number = (() => {
  const raw = import.meta.env.VITE_NAVE_ORACLE_STAKE_USD;
  const n = typeof raw === 'string' ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : NAVE_DAO_CREATION_STAKE_USD;
})();

/** Default downward tolerance applied when computing a local fallback floor. */
const FALLBACK_TOLERANCE_BPS = 100;

/** Resolved oracle endpoint. Override with VITE_NAVE_ORACLE_ENDPOINT. */
export const NAVE_ORACLE_ENDPOINT: string =
  (typeof import.meta.env.VITE_NAVE_ORACLE_ENDPOINT === 'string' &&
  import.meta.env.VITE_NAVE_ORACLE_ENDPOINT.trim() !== ''
    ? import.meta.env.VITE_NAVE_ORACLE_ENDPOINT.trim()
    : `${SUPABASE_FUNCTIONS_URL}/nave-price-oracle`);

/** Canonical stake quote shape (mirrors the edge function `StakeQuote`). */
export interface NaveStakeQuote {
  network: string;
  naveMint: string;
  naveDecimals: number;
  /** Canonical NAVE/USD price the quote was computed at. */
  priceUsd: number;
  /** USD value the stake must reach. */
  stakeUsd: number;
  /** Human-readable NAVE amount. */
  requiredNave: number;
  /** Exact NAVE base units (u64 string) the founder should transfer to escrow. */
  requiredNaveBaseUnits: string;
  /** Minimum NAVE base units (u64 string) the on-chain stake instruction enforces. */
  minNaveBaseUnits: string;
  quoteToleranceBps: number;
  source: 'fixed' | 'multi-chain';
  issuedAt: string;
  expiresAt: string;
}

export interface NaveOracleAttestation {
  payloadHash: string;
  signature: string | null;
  signed: boolean;
  algorithm: string;
}

export interface NaveStakeQuoteResult {
  ok: boolean;
  quote: NaveStakeQuote | null;
  attestation: NaveOracleAttestation | null;
  /** True when the quote came from a local fallback (only ever off mainnet). */
  fallback: boolean;
  error: string | null;
}

interface OracleResponse {
  ok: boolean;
  network?: string;
  naveMint?: string;
  priceUsd?: number;
  source?: 'fixed' | 'multi-chain';
  quote?: NaveStakeQuote;
  attestation?: NaveOracleAttestation;
  error?: string;
}

function isMainnetNetwork(): boolean {
  return SOLANA_NETWORK === 'mainnet';
}

/**
 * Local, fail-CLOSED-on-mainnet fallback. Off mainnet the canonical price is a
 * fixed constant, so if the oracle endpoint is unreachable we can still compute
 * the exact same quote the function would have returned. On mainnet there is NO
 * fallback — the price is live and a guessed number could under-collateralize a
 * real stake, so we surface an error instead.
 */
function localFallbackQuote(stakeUsd: number): NaveStakeQuote | null {
  if (isMainnetNetwork()) return null;
  const priceUsd = NAVE_DEVNET_PRICE_USD;
  if (!(priceUsd > 0)) return null;
  const scale = 10 ** NAVE_ORACLE_DECIMALS;
  const required = BigInt(Math.ceil((stakeUsd / priceUsd) * scale));
  const min = (required * BigInt(10_000 - FALLBACK_TOLERANCE_BPS)) / 10_000n;
  const now = Date.now();
  return {
    network: SOLANA_NETWORK,
    naveMint: SOLANA_NAVE_MINT.toBase58(),
    naveDecimals: NAVE_ORACLE_DECIMALS,
    priceUsd,
    stakeUsd,
    requiredNave: stakeUsd / priceUsd,
    requiredNaveBaseUnits: required.toString(),
    minNaveBaseUnits: min.toString(),
    quoteToleranceBps: FALLBACK_TOLERANCE_BPS,
    source: 'fixed',
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 300_000).toISOString(),
  };
}

export interface FetchStakeQuoteOptions {
  /** Override the staked USD value (defaults to the configured stake target). */
  stakeUsd?: number;
  /** Skip persisting a snapshot row server-side (default: persist). */
  persist?: boolean;
  /** AbortSignal for cancellation (e.g. React effect cleanup). */
  signal?: AbortSignal;
}

/**
 * Fetch the current canonical NAVE creation-stake quote (USD -> NAVE amount).
 * Returns a structured result; never throws for expected failures.
 */
export async function fetchNaveStakeQuote(
  opts: FetchStakeQuoteOptions = {},
): Promise<NaveStakeQuoteResult> {
  const stakeUsd = opts.stakeUsd && opts.stakeUsd > 0 ? opts.stakeUsd : NAVE_ORACLE_STAKE_USD;
  const url = new URL(NAVE_ORACLE_ENDPOINT);
  // SEC-M6: the oracle signs the quote it returns, so it only accepts the
  // canonical stake target from unauthenticated (browser) callers. Only send
  // an explicit caller override; the server otherwise quotes its own config.
  if (opts.stakeUsd && opts.stakeUsd > 0) {
    url.searchParams.set('stake_usd', String(opts.stakeUsd));
  }
  if (opts.persist === false) url.searchParams.set('persist', '0');

  try {
    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: { Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
      signal: opts.signal,
    });
    const data = (await res.json()) as OracleResponse;
    if (!res.ok || !data.ok || !data.quote) {
      const error = data?.error || `HTTP ${res.status}`;
      const fallback = localFallbackQuote(stakeUsd);
      if (fallback) {
        return { ok: true, quote: fallback, attestation: null, fallback: true, error: null };
      }
      return { ok: false, quote: null, attestation: null, fallback: false, error };
    }
    return {
      ok: true,
      quote: data.quote,
      attestation: data.attestation ?? null,
      fallback: false,
      error: null,
    };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return { ok: false, quote: null, attestation: null, fallback: false, error: 'aborted' };
    }
    const fallback = localFallbackQuote(stakeUsd);
    if (fallback) {
      return { ok: true, quote: fallback, attestation: null, fallback: true, error: null };
    }
    return {
      ok: false,
      quote: null,
      attestation: null,
      fallback: false,
      error: err instanceof Error ? err.message : 'oracle fetch failed',
    };
  }
}

/** Shown when the oracle quote, on-chain stake, and configured USD target do not match. */
export const CREATION_STAKE_MISMATCH_SENTENCE =
  'Creation waits until the chain stake matches the quoted dollars.';

/**
 * True when the oracle quote, the chain's `requiredNaveStake`, and
 * `VITE_NAVE_DAO_CREATION_STAKE_USD` do not describe the same stake.
 * Callers fail closed and must not invent a NAVE price to paper over the gap.
 */
export function creationStakeSourcesDisagree(
  quote: NaveStakeQuote,
  requiredNaveStake: bigint,
  configuredStakeUsd: number,
): boolean {
  if (!Number.isFinite(quote.stakeUsd) || !Number.isFinite(configuredStakeUsd)) return true;
  if (Math.round(quote.stakeUsd * 100) !== Math.round(configuredStakeUsd * 100)) return true;
  try {
    return BigInt(quote.requiredNaveBaseUnits) !== requiredNaveStake;
  } catch {
    return true;
  }
}

/**
 * True when a wallet's NAVE balance (in base units) can cover the on-chain
 * minimum the stake instruction will enforce for `quote`.
 */
export function canCoverStake(quote: NaveStakeQuote, naveBalanceBaseUnits: bigint | string): boolean {
  try {
    const have = typeof naveBalanceBaseUnits === 'bigint'
      ? naveBalanceBaseUnits
      : BigInt(naveBalanceBaseUnits);
    return have >= BigInt(quote.minNaveBaseUnits);
  } catch {
    return false;
  }
}

/** Convert a NAVE base-unit string to a human-readable amount for display. */
export function naveBaseUnitsToUi(baseUnits: string, decimals = NAVE_ORACLE_DECIMALS): number {
  try {
    return Number(BigInt(baseUnits)) / 10 ** decimals;
  } catch {
    return 0;
  }
}
