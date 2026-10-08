/*
  # Add multi-chain discriminator (chain / chain_id)

  Nave is going multi-chain: Solana (existing) plus EVM on Ethereum and Base
  only — mainnets (1 / 8453) and their testnets Sepolia (11155111) and Base
  Sepolia (84532). NO other EVM network (no BSC/Polygon/Arbitrum) is in scope.

  Each DAO/treasury lives on exactly ONE chain. To keep one shared backend we
  add a discriminator to every off-chain table that is keyed by a DAO:

    - `chain`    text   — chain KIND: 'solana' | 'ethereum' | 'base'
    - `chain_id` bigint — EVM numeric chain id (1 | 8453 | 11155111 | 84532);
                          NULL for Solana (which has no EVM chain id).

  All existing rows default to 'solana' (chain_id stays NULL) so nothing breaks.

  Tables: dao_registry, treasury_snapshots, agent_action_logs, activity_logs,
  monthly_reports, watched_daos.

  CHECK constraints fence the values to the supported set so a stray BSC-style
  id (56) or mismatched (chain, chain_id) pair can never be written.
*/

-- =============================================
-- Reusable value fences (declared inline per table below).
--   chain ∈ {solana, ethereum, base}
--   chain_id ∈ {NULL (solana), 1, 8453, 11155111, 84532 (EVM)}
--   pairing: solana ⇒ chain_id IS NULL;
--            ethereum ⇒ chain_id ∈ {1, 11155111};
--            base     ⇒ chain_id ∈ {8453, 84532}
-- =============================================

DO $$
DECLARE
  tbl text;
  tables text[] := ARRAY[
    'dao_registry',
    'treasury_snapshots',
    'agent_action_logs',
    'activity_logs',
    'monthly_reports',
    'watched_daos'
  ];
BEGIN
  FOREACH tbl IN ARRAY tables LOOP
    -- Add columns (idempotent). Existing rows backfill to 'solana' / NULL.
    EXECUTE format(
      'ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS chain text NOT NULL DEFAULT ''solana''',
      tbl
    );
    EXECUTE format(
      'ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS chain_id bigint',
      tbl
    );

    -- Value + pairing fence (idempotent: drop-if-exists then add).
    EXECUTE format(
      'ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS %I',
      tbl, tbl || '_chain_check'
    );
    EXECUTE format(
      $f$ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (
        chain IN ('solana', 'ethereum', 'base')
        AND (
          (chain = 'solana'   AND chain_id IS NULL)
          OR (chain = 'ethereum' AND chain_id IN (1, 11155111))
          OR (chain = 'base'     AND chain_id IN (8453, 84532))
        )
      )$f$,
      tbl, tbl || '_chain_check'
    );

    -- Index for chain-scoped queries (idempotent).
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON public.%I (chain, chain_id)',
      'idx_' || tbl || '_chain', tbl
    );
  END LOOP;
END $$;
