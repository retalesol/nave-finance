/*
  Public aggregate stats for the marketing site (and any anon caller).

  Eligibility rules are tightened in migration `1781450000_prune_unfunded_solana_daos_and_tighten_platform_stats.sql`
  (Solana: latest snapshot SOL >= 0.01; EVM: latest NAV >= $1). Fresh databases should run both migrations in order.

  Exposes a single RPC that returns:
  - treasury_count: rows in dao_registry (every treasury registered with Nave)
  - tvl_usd: sum of each treasury's latest snapshot total_value_usd (registered DAOs only)
  - yield_generated_usd: sum of all monthly_reports.yield_earned (cumulative since reporting began)

  SECURITY DEFINER + locked search_path: aggregates bypass per-table RLS so private DAO
  rows do not leak per-treasury detail — only protocol-level totals are returned.
*/

CREATE OR REPLACE FUNCTION public.get_platform_treasury_stats()
RETURNS TABLE (
  treasury_count bigint,
  tvl_usd numeric,
  yield_generated_usd numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    (SELECT count(*)::bigint FROM public.dao_registry) AS treasury_count,
    (
      SELECT COALESCE(sum(latest.total_value_usd), 0)::numeric
      FROM (
        SELECT DISTINCT ON (s.dao_onchain_address)
          s.dao_onchain_address,
          s.total_value_usd
        FROM public.treasury_snapshots s
        INNER JOIN public.dao_registry d ON d.dao_onchain_address = s.dao_onchain_address
        ORDER BY s.dao_onchain_address, s.snapshot_at DESC
      ) latest
    ) AS tvl_usd,
    (
      SELECT COALESCE(sum(m.yield_earned), 0)::numeric
      FROM public.monthly_reports m
      INNER JOIN public.dao_registry d ON d.dao_onchain_address = m.dao_onchain_address
    ) AS yield_generated_usd;
$$;

REVOKE ALL ON FUNCTION public.get_platform_treasury_stats() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_platform_treasury_stats() TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.get_platform_treasury_stats() IS
  'Protocol-wide treasury count, TVL (latest snapshot NAV per DAO), and cumulative yield from monthly_reports.';
