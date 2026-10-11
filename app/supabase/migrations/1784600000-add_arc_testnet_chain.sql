/*
  # Add Arc Testnet (chain id 5042002)

  Arc Testnet joins the DAO chain set the way Robinhood did in
  1784300000, plus the indexer/activity checks from 1783400000.

  Arc mainnet (5042) is intentionally absent.

  If `genlayer_reviews` does not exist yet (1784500000 not applied), the
  chain_family widen is skipped. Re-run this constraint block after that
  table is created, or the inline check from 1784500000 will still omit arc.

  Idempotent: constraints are dropped-if-exists then re-added.
*/

SET lock_timeout = '5s';

-- ── DAO-scoped composite (chain, chain_id) checks ───────────────────────────
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'dao_registry', 'watched_daos', 'treasury_snapshots', 'monthly_reports', 'agent_action_logs'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS %I', t, t || '_chain_check');
    EXECUTE format($sql$
      ALTER TABLE public.%I
        ADD CONSTRAINT %I CHECK (
          chain IN ('solana', 'ethereum', 'base', 'robinhood', 'arc')
          AND (
            (chain = 'solana'    AND chain_id IS NULL)
            OR (chain = 'ethereum'  AND chain_id IN (1, 11155111))
            OR (chain = 'base'      AND chain_id IN (8453, 84532))
            OR (chain = 'robinhood' AND chain_id IN (4663, 46630))
            OR (chain = 'arc'       AND chain_id = 5042002)
          )
        )
    $sql$, t, t || '_chain_check');
  END LOOP;
END $$;

-- encrypted_evm_keys has three separate constraints.
ALTER TABLE public.encrypted_evm_keys
  DROP CONSTRAINT IF EXISTS encrypted_evm_keys_chain_check,
  DROP CONSTRAINT IF EXISTS encrypted_evm_keys_chain_id_check,
  DROP CONSTRAINT IF EXISTS encrypted_evm_keys_chain_pair;

ALTER TABLE public.encrypted_evm_keys
  ADD CONSTRAINT encrypted_evm_keys_chain_check
    CHECK (chain IN ('ethereum', 'base', 'robinhood', 'arc')),
  ADD CONSTRAINT encrypted_evm_keys_chain_id_check
    CHECK (chain_id IN (1, 8453, 4663, 11155111, 84532, 46630, 5042002)),
  ADD CONSTRAINT encrypted_evm_keys_chain_pair CHECK (
    (chain = 'ethereum'  AND chain_id IN (1, 11155111))
    OR (chain = 'base'      AND chain_id IN (8453, 84532))
    OR (chain = 'robinhood' AND chain_id IN (4663, 46630))
    OR (chain = 'arc'       AND chain_id = 5042002)
  );

-- ── evm_indexer_cursors ──────────────────────────────────────────────────────
ALTER TABLE public.evm_indexer_cursors
  DROP CONSTRAINT IF EXISTS evm_indexer_cursors_chain_id_check;
ALTER TABLE public.evm_indexer_cursors
  ADD CONSTRAINT evm_indexer_cursors_chain_id_check
  CHECK (chain_id IN (1, 8453, 4663, 11155111, 84532, 46630, 5042002));

ALTER TABLE public.evm_indexer_cursors
  DROP CONSTRAINT IF EXISTS evm_indexer_cursors_chain_check;
ALTER TABLE public.evm_indexer_cursors
  ADD CONSTRAINT evm_indexer_cursors_chain_check
  CHECK (chain IN ('ethereum', 'base', 'robinhood', 'arc'));

-- ── activity_logs ────────────────────────────────────────────────────────────
ALTER TABLE public.activity_logs
  DROP CONSTRAINT IF EXISTS activity_logs_chain_check;
ALTER TABLE public.activity_logs
  ADD CONSTRAINT activity_logs_chain_check
  CHECK (
    chain IN ('solana', 'ethereum', 'base', 'robinhood', 'arc')
    AND (
      (chain = 'solana'    AND chain_id IS NULL)
      OR (chain = 'ethereum'  AND chain_id IN (1, 11155111))
      OR (chain = 'base'      AND chain_id IN (8453, 84532))
      OR (chain = 'robinhood' AND chain_id IN (4663, 46630))
      OR (chain = 'arc'       AND chain_id = 5042002)
    )
  );

-- ── genlayer_reviews.chain_family, only when that table already exists ──────
DO $$
DECLARE
  cname text;
BEGIN
  IF to_regclass('public.genlayer_reviews') IS NULL THEN
    RAISE NOTICE 'genlayer_reviews is not present; arc chain_family widen skipped';
    RETURN;
  END IF;

  FOR cname IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'public'
      AND rel.relname = 'genlayer_reviews'
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%chain_family%'
  LOOP
    EXECUTE format('ALTER TABLE public.genlayer_reviews DROP CONSTRAINT %I', cname);
  END LOOP;

  ALTER TABLE public.genlayer_reviews
    ADD CONSTRAINT genlayer_reviews_chain_family_check
    CHECK (chain_family IN ('solana', 'ethereum', 'base', 'robinhood', 'arc'));
END $$;
