/*
  # Continuous policy loop tables (Phase 2)

  Persists the outputs of the off-chain, read-only policy loop so every
  autonomous recommendation is fully auditable and reproducible:

  1. New Tables
    - `yield_opportunities`
      - Snapshot of scanned, scored yield opportunities per evaluation cycle.
      - Only ever contains approved-protocol venues (the scanner drops the rest).
    - `rebalance_recommendations`
      - Deterministic policy-evaluator output: drift diagnostics, chosen actions,
        rejected alternatives, and a reproducible proof hash over inputs+outputs.
      - `status` starts at 'observe' (observe-only rollout). Phase 4 advances a
        recommendation to 'proposed' when it is turned into a governance proposal.

  2. Security
    - RLS enabled.
    - Public read for non-private DAOs (mirrors agent_action_logs).
    - Only service_role writes (the policy-evaluator edge function).

  NOTE: the planner NEVER signs. These rows are advisory inputs to governance;
  on-chain invariants + deterministic guardrails remain the signing authority.
*/

-- ── yield_opportunities ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.yield_opportunities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dao_onchain_address text NOT NULL,
  protocol_id text NOT NULL,
  program_id text NOT NULL,
  apy_bps integer NOT NULL,
  risk_score integer NOT NULL CHECK (risk_score BETWEEN 0 AND 100),
  asset_class text NOT NULL DEFAULT 'other' CHECK (asset_class IN ('stablecoin', 'sol', 'other')),
  liquid boolean NOT NULL DEFAULT true,
  score integer NOT NULL DEFAULT 0,
  source text DEFAULT '',
  scanned_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_yield_opps_dao_time
  ON public.yield_opportunities (dao_onchain_address, scanned_at DESC);

ALTER TABLE public.yield_opportunities ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'yield_opportunities' AND policyname = 'Public read yield opportunities'
  ) THEN
    CREATE POLICY "Public read yield opportunities"
      ON public.yield_opportunities
      FOR SELECT
      TO anon, authenticated
      USING (
        EXISTS (
          SELECT 1 FROM dao_registry
          WHERE dao_registry.dao_onchain_address = yield_opportunities.dao_onchain_address
            AND dao_registry.privacy_enabled = false
        )
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'yield_opportunities' AND policyname = 'Service role manages yield opportunities'
  ) THEN
    CREATE POLICY "Service role manages yield opportunities"
      ON public.yield_opportunities
      FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;

-- ── rebalance_recommendations ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.rebalance_recommendations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dao_onchain_address text NOT NULL,
  engine_version text NOT NULL DEFAULT '',
  intent text NOT NULL DEFAULT 'hold',
  drift jsonb NOT NULL DEFAULT '{}',
  actions jsonb NOT NULL DEFAULT '[]',
  rejected jsonb NOT NULL DEFAULT '[]',
  flags text[] NOT NULL DEFAULT '{}',
  summary text DEFAULT '',
  policy_proof_hash text NOT NULL,
  nav_base_units numeric NOT NULL DEFAULT 0,
  deployed_base_units numeric NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'observe' CHECK (status IN ('observe', 'proposed', 'superseded', 'applied', 'rejected')),
  proposal_address text DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rebal_recs_dao_time
  ON public.rebalance_recommendations (dao_onchain_address, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_rebal_recs_dao_status
  ON public.rebalance_recommendations (dao_onchain_address, status);

-- Idempotency: at most one recommendation row per (dao, proof hash). Re-running
-- the loop over unchanged state is a no-op insert instead of a duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS uq_rebal_recs_dao_proof
  ON public.rebalance_recommendations (dao_onchain_address, policy_proof_hash);

ALTER TABLE public.rebalance_recommendations ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'rebalance_recommendations' AND policyname = 'Public read rebalance recommendations'
  ) THEN
    CREATE POLICY "Public read rebalance recommendations"
      ON public.rebalance_recommendations
      FOR SELECT
      TO anon, authenticated
      USING (
        EXISTS (
          SELECT 1 FROM dao_registry
          WHERE dao_registry.dao_onchain_address = rebalance_recommendations.dao_onchain_address
            AND dao_registry.privacy_enabled = false
        )
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'rebalance_recommendations' AND policyname = 'Service role manages rebalance recommendations'
  ) THEN
    CREATE POLICY "Service role manages rebalance recommendations"
      ON public.rebalance_recommendations
      FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;
