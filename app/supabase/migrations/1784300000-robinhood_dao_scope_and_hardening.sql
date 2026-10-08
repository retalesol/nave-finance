/*
  # Robinhood DAO scope + DB hardening (pre-redeploy)

  Context (docs/PLATFORM_STATE_AND_REDEPLOY_PLAN_2026-09-05.md §2.1, §2.5):

  1. The app now creates DAO treasuries on Robinhood Chain (mainnet 4663 /
     testnet 46630) — `USER_CHAINS` in the frontend and `register-dao`,
     `generate-evm-agent-keys`, `snapshot-treasury` all write chain='robinhood'.
     Migration 1783400000 deliberately fenced Robinhood to bridge/indexer
     tables only, so every Robinhood DAO write currently fails the CHECK
     constraints on dao_registry, watched_daos, treasury_snapshots,
     monthly_reports, agent_action_logs and encrypted_evm_keys. Widen them.

  2. `dao-logos` storage policies (1783100000) compare
     `(storage.foldername(name))[1]` inside a subquery `FROM dao_registry r`;
     the unqualified `name` binds to `r.name` (the DAO display name), not
     `storage.objects.name`, so the founder upload/update policies can never
     match. Re-create them against `objects.name`.

  3. `nave_refresh_simulation_batch()` is SECURITY DEFINER and was executable
     by anon/authenticated (Supabase advisor). Only pg_cron and the
     service-role `simulation-data` function need it. Revoke public EXECUTE.

  Not changed here (needs frontend coordination first — tracked in the plan):
    - `agent_action_logs.raw_claude_response` column exposure (frontend does
      `select('*')` in useAgentStatus.ts; revoking the column would break it).
    - Header-gated (`x-wallet-address`) RLS writes on dao_token_images /
      dao_hidden_assets / watched_daos — moving behind signed edge functions.
    - `dao_registry.dao_onchain_address` stays globally UNIQUE: cross-chain
      address collisions are prevented at the contract layer (factory salts
      clones with block.chainid) rather than by re-keying every table.

  Idempotent: constraints and policies are dropped-if-exists then re-added.
*/

-- ── 1. Widen DAO-scoped chain constraints to include Robinhood ───────────────

-- Tables with the composite (chain, chain_id) discriminator from 1781300000.
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
          chain IN ('solana', 'ethereum', 'base', 'robinhood')
          AND (
            (chain = 'solana'    AND chain_id IS NULL)
            OR (chain = 'ethereum'  AND chain_id IN (1, 11155111))
            OR (chain = 'base'      AND chain_id IN (8453, 84532))
            OR (chain = 'robinhood' AND chain_id IN (4663, 46630))
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
    CHECK (chain IN ('ethereum', 'base', 'robinhood')),
  ADD CONSTRAINT encrypted_evm_keys_chain_id_check
    CHECK (chain_id IN (1, 8453, 4663, 11155111, 84532, 46630)),
  ADD CONSTRAINT encrypted_evm_keys_chain_pair CHECK (
    (chain = 'ethereum'  AND chain_id IN (1, 11155111))
    OR (chain = 'base'      AND chain_id IN (8453, 84532))
    OR (chain = 'robinhood' AND chain_id IN (4663, 46630))
  );

-- ── 2. Fix dao-logos storage policies (bind to objects.name) ─────────────────

DROP POLICY IF EXISTS "dao-logos founder upload (scoped)" ON storage.objects;
DROP POLICY IF EXISTS "dao-logos founder update (scoped)" ON storage.objects;

CREATE POLICY "dao-logos founder upload (scoped)"
  ON storage.objects FOR INSERT TO anon, authenticated
  WITH CHECK (
    bucket_id = 'dao-logos'
    AND EXISTS (
      SELECT 1 FROM public.dao_registry r
      WHERE r.dao_onchain_address = (storage.foldername(objects.name))[1]
        AND r.creator_wallet = current_setting('request.headers', true)::json->>'x-wallet-address'
    )
  );

CREATE POLICY "dao-logos founder update (scoped)"
  ON storage.objects FOR UPDATE TO anon, authenticated
  USING (
    bucket_id = 'dao-logos'
    AND EXISTS (
      SELECT 1 FROM public.dao_registry r
      WHERE r.dao_onchain_address = (storage.foldername(objects.name))[1]
        AND r.creator_wallet = current_setting('request.headers', true)::json->>'x-wallet-address'
    )
  )
  WITH CHECK (
    bucket_id = 'dao-logos'
    AND EXISTS (
      SELECT 1 FROM public.dao_registry r
      WHERE r.dao_onchain_address = (storage.foldername(objects.name))[1]
        AND r.creator_wallet = current_setting('request.headers', true)::json->>'x-wallet-address'
    )
  );

-- ── 3. Lock down the SECURITY DEFINER simulation refresh ─────────────────────

REVOKE EXECUTE ON FUNCTION public.nave_refresh_simulation_batch() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.nave_refresh_simulation_batch() TO service_role;

COMMENT ON FUNCTION public.nave_refresh_simulation_batch() IS
  'Refreshes simulation tables. SECURITY DEFINER; executable only by pg_cron (postgres) and service_role (simulation-data edge function).';
