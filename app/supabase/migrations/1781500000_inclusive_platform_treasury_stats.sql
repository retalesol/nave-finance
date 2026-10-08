/*
  # Inclusive platform stats RPC (all chains, all registered treasuries)

  `get_platform_treasury_stats()` now reports:
  - treasury_count: every row in `dao_registry` (Solana + Ethereum + Base).
  - tvl_usd: sum of each treasury's latest `treasury_snapshots.total_value_usd`
    (left join → missing snapshot counts as 0). NAV is the on-chain aggregate
    across SOL / SPL / USDC (Solana) and ERC assets (EVM) once snapshot-treasury
    writes rows for that chain.
  - yield_generated_usd: sum of all `monthly_reports.yield_earned` (full history).

  Replaces the restrictive eligibility filter from migration 1781450000.
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
  WITH latest_snap AS (
    SELECT DISTINCT ON (s.dao_onchain_address)
      s.dao_onchain_address,
      s.total_value_usd
    FROM public.treasury_snapshots s
    ORDER BY s.dao_onchain_address, s.snapshot_at DESC
  )
  SELECT
    (SELECT count(*)::bigint FROM public.dao_registry) AS treasury_count,
    (
      SELECT COALESCE(sum(COALESCE(ls.total_value_usd, 0)), 0)::numeric
      FROM public.dao_registry d
      LEFT JOIN latest_snap ls ON ls.dao_onchain_address = d.dao_onchain_address
    ) AS tvl_usd,
    (
      SELECT COALESCE(sum(m.yield_earned), 0)::numeric
      FROM public.monthly_reports m
    ) AS yield_generated_usd;
$$;

REVOKE ALL ON FUNCTION public.get_platform_treasury_stats() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_platform_treasury_stats() TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.get_platform_treasury_stats() IS
  'All registered treasuries; TVL = sum of latest snapshot NAV per DAO (all assets/chains); yield = sum of all monthly_reports.yield_earned.';
