/**
 * useNaveStakeQuote — fetch the current canonical DAO-creation NAVE stake quote.
 *
 * Wraps the central price oracle (`fetchNaveStakeQuote`) so any UI can show the
 * recoverable NAVE stake a founder must lock (`NAVE_DAO_CREATION_STAKE_USD`) and gate
 * "can this wallet stake enough?" without ever hardcoding a NAVE price.
 *
 * The creation wizard owns its own page/UI; it consumes this hook (and the
 * pure `naveStakeOracle` utils) rather than re-deriving the amount.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  canCoverStake,
  fetchNaveStakeQuote,
  type NaveOracleAttestation,
  type NaveStakeQuote,
} from '../lib/naveStakeOracle';

export interface UseNaveStakeQuoteOptions {
  /** Override the staked USD value (defaults to the configured stake target). */
  stakeUsd?: number;
  /** When false, the hook does not fetch (e.g. before a chain is selected). */
  enabled?: boolean;
  /** Auto-refresh interval (ms). 0/undefined disables polling. */
  refreshMs?: number;
}

export interface UseNaveStakeQuoteResult {
  quote: NaveStakeQuote | null;
  attestation: NaveOracleAttestation | null;
  /** True when the quote came from the local fallback (only ever off mainnet). */
  fallback: boolean;
  loading: boolean;
  error: string | null;
  refetch: () => void;
  /** Whether a NAVE balance (base units) covers the enforced on-chain minimum. */
  canCover: (naveBalanceBaseUnits: bigint | string) => boolean;
}

export function useNaveStakeQuote(
  opts: UseNaveStakeQuoteOptions = {},
): UseNaveStakeQuoteResult {
  const { stakeUsd, enabled = true, refreshMs } = opts;

  const [quote, setQuote] = useState<NaveStakeQuote | null>(null);
  const [attestation, setAttestation] = useState<NaveOracleAttestation | null>(null);
  const [fallback, setFallback] = useState(false);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const refetch = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();

    async function load() {
      setLoading(true);
      setError(null);
      const result = await fetchNaveStakeQuote({ stakeUsd, signal: controller.signal });
      if (cancelled) return;
      if (!result.ok || !result.quote) {
        setQuote(null);
        setAttestation(null);
        setFallback(false);
        setError(result.error ?? 'Unable to fetch NAVE stake quote');
        setLoading(false);
        return;
      }
      setQuote(result.quote);
      setAttestation(result.attestation);
      setFallback(result.fallback);
      setLoading(false);
    }

    void load();

    let interval: ReturnType<typeof setInterval> | null = null;
    if (refreshMs && refreshMs > 0) {
      interval = setInterval(() => setTick((t) => t + 1), refreshMs);
    }

    return () => {
      cancelled = true;
      controller.abort();
      if (interval) clearInterval(interval);
    };
  }, [enabled, stakeUsd, refreshMs, tick]);

  const canCover = useCallback(
    (naveBalanceBaseUnits: bigint | string) =>
      quote ? canCoverStake(quote, naveBalanceBaseUnits) : false,
    [quote],
  );

  return { quote, attestation, fallback, loading, error, refetch, canCover };
}
