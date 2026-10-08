/*
  # Prune Solana registry rows that never held meaningful SOL, and tighten platform stats

  Problem: dao_registry accumulated UI/test registrations and factory-seeded treasuries
  (~0.00117 SOL) while headline stats counted every row and summed NAV — including
  bogus high NAV on dust SOL.

  This migration:
  1. Deletes Solana `dao_registry` rows whose *latest* treasury snapshot shows
     `sol_balance < 0.01` SOL (or no snapshot). Removes seed-only and never-funded rows.
     EVM registry rows are not deleted.
  2. Rewrites `get_platform_treasury_stats()` so aggregates only include:
     - Solana: latest snapshot with `sol_balance >= 0.01` SOL
     - Ethereum/Base: latest snapshot with `total_value_usd >= 1` USD

  Threshold 0.01 SOL is above recurring factory seed (~0.00117624 SOL) on devnet.
*/

CREATE TEMP TABLE _dead_solan (addr text PRIMARY KEY);

INSERT INTO _dead_solan (addr)
SELECT d.dao_onchain_address
FROM public.dao_registry d
LEFT JOIN LATERAL (
  SELECT s.sol_balance
  FROM public.treasury_snapshots s
  WHERE s.dao_onchain_address = d.dao_onchain_address
  ORDER BY s.snapshot_at DESC
  LIMIT 1
) ls ON true
WHERE d.chain = 'solana'
  AND (ls.sol_balance IS NULL OR ls.sol_balance < 0.01::numeric);

DELETE FROM public.yield_opportunities         WHERE dao_onchain_address IN (SELECT addr FROM _dead_solan);
DELETE FROM public.rebalance_recommendations   WHERE dao_onchain_address IN (SELECT addr FROM _dead_solan);
DELETE FROM public.dispatch_nonces             WHERE dao_onchain_address IN (SELECT addr FROM _dead_solan);
DELETE FROM public.agent_proposals             WHERE dao_onchain_address IN (SELECT addr FROM _dead_solan);
DELETE FROM public.agent_sessions              WHERE dao_onchain_address IN (SELECT addr FROM _dead_solan);
DELETE FROM public.agent_action_logs           WHERE dao_onchain_address IN (SELECT addr FROM _dead_solan);
DELETE FROM public.encrypted_agent_keys        WHERE dao_onchain_address IN (SELECT addr FROM _dead_solan);
DELETE FROM public.encrypted_evm_keys          WHERE dao_onchain_address IN (SELECT addr FROM _dead_solan);
DELETE FROM public.dao_authorized_wallets      WHERE dao_onchain_address IN (SELECT addr FROM _dead_solan);
DELETE FROM public.dao_token_images            WHERE dao_address IN (SELECT addr FROM _dead_solan);
DELETE FROM public.signer_labels               WHERE dao_onchain_address IN (SELECT addr FROM _dead_solan);
DELETE FROM public.activity_logs               WHERE dao_onchain_address IN (SELECT addr FROM _dead_solan);
DELETE FROM public.monthly_reports             WHERE dao_onchain_address IN (SELECT addr FROM _dead_solan);
DELETE FROM public.treasury_snapshots          WHERE dao_onchain_address IN (SELECT addr FROM _dead_solan);
DELETE FROM public.watched_daos                WHERE dao_onchain_address IN (SELECT addr FROM _dead_solan);
DELETE FROM public.dao_registry                WHERE dao_onchain_address IN (SELECT addr FROM _dead_solan);

DROP TABLE _dead_solan;

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
      s.total_value_usd,
      s.sol_balance
    FROM public.treasury_snapshots s
    ORDER BY s.dao_onchain_address, s.snapshot_at DESC
  ),
  qualified AS (
    SELECT d.dao_onchain_address
    FROM public.dao_registry d
    INNER JOIN latest_snap ls ON ls.dao_onchain_address = d.dao_onchain_address
    WHERE
      (d.chain = 'solana' AND ls.sol_balance >= 0.01::numeric)
      OR (d.chain IN ('ethereum', 'base') AND ls.total_value_usd >= 1::numeric)
  )
  SELECT
    (SELECT count(*)::bigint FROM qualified) AS treasury_count,
    (
      SELECT COALESCE(sum(ls.total_value_usd), 0)::numeric
      FROM qualified q
      INNER JOIN latest_snap ls ON ls.dao_onchain_address = q.dao_onchain_address
    ) AS tvl_usd,
    (
      SELECT COALESCE(sum(m.yield_earned), 0)::numeric
      FROM public.monthly_reports m
      INNER JOIN qualified q ON q.dao_onchain_address = m.dao_onchain_address
    ) AS yield_generated_usd;
$$;

REVOKE ALL ON FUNCTION public.get_platform_treasury_stats() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_platform_treasury_stats() TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.get_platform_treasury_stats() IS
  'Protocol stats: treasuries with latest snapshot SOL >= 0.01 (Solana) or NAV >= $1 (EVM); TVL and yield only for those DAOs.';
