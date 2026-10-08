/**
 * Home-page protocol aggregates from `get_platform_treasury_stats` RPC.
 * Counts **mainnet** `dao_registry` rows only (`network = 'mainnet'`): Base 8453,
 * Robinhood 4663, and (when re-enabled) Ethereum 1 + Solana mainnet. Testnet /
 * Sepolia / Solana-devnet registrations are excluded. TVL is the sum of each
 * mainnet treasury's latest snapshot `total_value_usd`. Yield is the sum of
 * `monthly_reports.yield_earned` for those DAOs.
 */
import { useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '../lib/supabaseClient';

export interface PlatformTreasuryStats {
  treasuryCount: number;
  tvlUsd: number;
  yieldGeneratedUsd: number;
}

interface RpcRow {
  treasury_count: number | string;
  tvl_usd: number | string;
  yield_generated_usd: number | string;
}

function num(v: number | string | null | undefined): number {
  if (v == null) return 0;
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : 0;
}

async function fetchPlatformTreasuryStats(): Promise<PlatformTreasuryStats> {
  const { data, error: rpcError } = await supabase.rpc('get_platform_treasury_stats');
  if (rpcError) {
    throw new Error(rpcError.message);
  }
  const row = (Array.isArray(data) ? data[0] : data) as RpcRow | null | undefined;
  if (!row) {
    return { treasuryCount: 0, tvlUsd: 0, yieldGeneratedUsd: 0 };
  }
  return {
    treasuryCount: Math.round(num(row.treasury_count)),
    tvlUsd: num(row.tvl_usd),
    yieldGeneratedUsd: num(row.yield_generated_usd),
  };
}

/**
 * Home-page protocol aggregates, backed by React Query so every visitor
 * landing on the marketing page shares one cached fetch instead of each
 * mount re-issuing the RPC call.
 */
export function usePlatformTreasuryStats(): {
  stats: PlatformTreasuryStats | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
} {
  const query = useQuery({
    queryKey: ['platformTreasuryStats'],
    queryFn: fetchPlatformTreasuryStats,
    staleTime: 60_000,
    gcTime: 10 * 60_000,
    retry: 1,
  });

  const refetch = useCallback(() => {
    void query.refetch();
  }, [query]);

  return {
    stats: query.data ?? null,
    loading: query.isFetching,
    error: query.isError ? (query.error instanceof Error ? query.error.message : 'Failed to fetch stats') : null,
    refetch,
  };
}

/** USD formatted for large hero metrics (compact for millions+). */
export function formatHeroProtocolUsd(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '$0';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    notation: 'compact',
    maximumFractionDigits: value >= 1_000_000 ? 2 : 1,
  }).format(value);
}
