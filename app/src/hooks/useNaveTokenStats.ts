/**
 * Live $NAVE market data for the homepage tokenomics section: price, market
 * cap, holder count, and a 24h hourly price series for the background chart.
 * Backed by the `nave-token-stats` edge function, which sources price/market
 * cap from GeckoTerminal and holders directly from Solana mainnet — no
 * wallet connection or chain context required, since this is mainnet token
 * data shown on the public marketing page regardless of which network the
 * rest of the (devnet beta) app is currently pointed at.
 */
import { useCallback, useEffect, useState } from 'react';
import { fetchNaveTokenStats, type NaveTokenStatsResponse } from '../lib/edgeFunctionClient';

const REFRESH_MS = 120_000;

export function useNaveTokenStats(): {
  stats: NaveTokenStatsResponse | null;
  loading: boolean;
  error: string | null;
} {
  const [stats, setStats] = useState<NaveTokenStatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error: fetchError } = await fetchNaveTokenStats();
    if (data) {
      setStats(data);
      setError(null);
    } else {
      setError(fetchError);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
    const interval = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(interval);
  }, [load]);

  return { stats, loading, error };
}

/** Compact USD price, e.g. $0.2456. */
export function formatNavePrice(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: value < 1 ? 4 : 2,
    maximumFractionDigits: value < 1 ? 4 : 2,
  }).format(value);
}

/** Compact USD market cap, e.g. $122.8K. */
export function formatNaveMarketCap(value: number | null): string {
  if (value == null || !Number.isFinite(value) || value <= 0) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    notation: 'compact',
    maximumFractionDigits: 2,
  }).format(value);
}

/** Holder count, e.g. 383. */
export function formatNaveHolders(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('en-US').format(value);
}
