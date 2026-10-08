/*
  # Homepage platform stats: mainnet only

  `get_platform_treasury_stats()` was counting every `dao_registry` row, including
  Sepolia / Base Sepolia / Robinhood testnet and historical Solana devnet DAOs.
  The marketing homepage must show mainnet treasuries only:

    - Base 8453
    - Robinhood 4663
    - Ethereum 1 (when create is re-enabled)
    - Solana mainnet (when create is re-enabled; tagged via `network`)

  Adds `dao_registry.network` ('mainnet' | 'testnet' | 'devnet'), backfills from
  chain_id / chain, and restricts the RPC to `network = 'mainnet'`.
*/

ALTER TABLE public.dao_registry
  ADD COLUMN IF NOT EXISTS network text;

UPDATE public.dao_registry
SET network = CASE
  WHEN chain_id IN (1, 8453, 4663) THEN 'mainnet'
  WHEN chain_id IN (11155111, 84532, 46630) THEN 'testnet'
  WHEN chain = 'solana' THEN 'devnet'
  ELSE 'testnet'
END
WHERE network IS NULL;

ALTER TABLE public.dao_registry
  ALTER COLUMN network SET DEFAULT 'mainnet';

UPDATE public.dao_registry
SET network = 'testnet'
WHERE network IS NULL;

ALTER TABLE public.dao_registry
  ALTER COLUMN network SET NOT NULL;

ALTER TABLE public.dao_registry
  DROP CONSTRAINT IF EXISTS dao_registry_network_check;

ALTER TABLE public.dao_registry
  ADD CONSTRAINT dao_registry_network_check
  CHECK (network IN ('mainnet', 'testnet', 'devnet'));

CREATE INDEX IF NOT EXISTS idx_dao_registry_network
  ON public.dao_registry (network);

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
  WITH mainnet_daos AS (
    SELECT d.dao_onchain_address
    FROM public.dao_registry d
    WHERE d.network = 'mainnet'
  ),
  latest_snap AS (
    SELECT DISTINCT ON (s.dao_onchain_address)
      s.dao_onchain_address,
      s.total_value_usd
    FROM public.treasury_snapshots s
    INNER JOIN mainnet_daos m ON m.dao_onchain_address = s.dao_onchain_address
    ORDER BY s.dao_onchain_address, s.snapshot_at DESC
  )
  SELECT
    (SELECT count(*)::bigint FROM mainnet_daos) AS treasury_count,
    (
      SELECT COALESCE(sum(COALESCE(ls.total_value_usd, 0)), 0)::numeric
      FROM mainnet_daos m
      LEFT JOIN latest_snap ls ON ls.dao_onchain_address = m.dao_onchain_address
    ) AS tvl_usd,
    (
      SELECT COALESCE(sum(mr.yield_earned), 0)::numeric
      FROM public.monthly_reports mr
      INNER JOIN mainnet_daos m ON m.dao_onchain_address = mr.dao_onchain_address
    ) AS yield_generated_usd;
$$;

REVOKE ALL ON FUNCTION public.get_platform_treasury_stats() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_platform_treasury_stats() TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.get_platform_treasury_stats() IS
  'Mainnet-only protocol stats: dao_registry.network = mainnet (Base 8453, Robinhood 4663, Ethereum 1, Solana mainnet when tagged). TVL = sum of latest snapshot NAV; yield = sum of monthly_reports for those DAOs.';
