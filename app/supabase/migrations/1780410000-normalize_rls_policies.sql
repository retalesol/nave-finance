/*
  # Normalize RLS policies (production hardening)

  Two issues are resolved here:

  1. watched_daos had TWO conflicting policy sets:
     - header-scoped (x-wallet-address) from 1779924597 (the intended model)
     - permissive using(true)/with check(true) from 1779924760
     RLS is OR across policies, so the permissive set let ANY caller read,
     insert, or delete ANY wallet's watchlist. We drop the permissive set and
     keep a single wallet-header-scoped model (the frontend now sends the
     `x-wallet-address` header on every request). An UPDATE policy is added so
     upserts work under the scoped model.

  2. agent_sessions had RLS enabled with ZERO policies (default-deny), which
     silently broke the dashboard. We mirror the agent_action_logs model:
     public read for non-private DAOs, service_role full access for writes.
*/

-- ─── watched_daos: drop permissive policies ──────────────────────────────────
DROP POLICY IF EXISTS "Users can read their own watched DAOs" ON public.watched_daos;
DROP POLICY IF EXISTS "Users can insert their own watched DAOs" ON public.watched_daos;
DROP POLICY IF EXISTS "Users can delete their own watched DAOs" ON public.watched_daos;

-- ─── watched_daos: ensure canonical header-scoped policies exist ──────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'watched_daos' AND policyname = 'Users read own watched DAOs'
  ) THEN
    CREATE POLICY "Users read own watched DAOs"
      ON public.watched_daos FOR SELECT TO anon, authenticated
      USING (wallet_address = current_setting('request.headers', true)::json->>'x-wallet-address');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'watched_daos' AND policyname = 'Users insert own watched DAOs'
  ) THEN
    CREATE POLICY "Users insert own watched DAOs"
      ON public.watched_daos FOR INSERT TO anon, authenticated
      WITH CHECK (wallet_address = current_setting('request.headers', true)::json->>'x-wallet-address');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'watched_daos' AND policyname = 'Users update own watched DAOs'
  ) THEN
    CREATE POLICY "Users update own watched DAOs"
      ON public.watched_daos FOR UPDATE TO anon, authenticated
      USING (wallet_address = current_setting('request.headers', true)::json->>'x-wallet-address')
      WITH CHECK (wallet_address = current_setting('request.headers', true)::json->>'x-wallet-address');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'watched_daos' AND policyname = 'Users delete own watched DAOs'
  ) THEN
    CREATE POLICY "Users delete own watched DAOs"
      ON public.watched_daos FOR DELETE TO anon, authenticated
      USING (wallet_address = current_setting('request.headers', true)::json->>'x-wallet-address');
  END IF;
END $$;

-- ─── agent_sessions: add read + service_role policies ─────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'agent_sessions' AND policyname = 'Public read agent sessions'
  ) THEN
    CREATE POLICY "Public read agent sessions"
      ON public.agent_sessions FOR SELECT TO anon, authenticated
      USING (
        EXISTS (
          SELECT 1 FROM dao_registry
          WHERE dao_registry.dao_onchain_address = agent_sessions.dao_onchain_address
            AND dao_registry.privacy_enabled = false
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'agent_sessions' AND policyname = 'Service role manages agent sessions'
  ) THEN
    CREATE POLICY "Service role manages agent sessions"
      ON public.agent_sessions FOR ALL TO service_role
      USING (true) WITH CHECK (true);
  END IF;
END $$;
