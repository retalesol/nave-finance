/*
  # Portfolio simulation tables

  Stores generated Nave treasury backtests for the public /simulation page:
  50 × $1M portfolios over staggered 5-year market windows.

  1. `simulation_batches` — generation run metadata + cohort summary
  2. `simulation_portfolios` — per-run outcomes + monthly series jsonb
  3. RLS — public SELECT; service_role writes
*/

CREATE TABLE IF NOT EXISTS simulation_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  seed text NOT NULL,
  status text NOT NULL DEFAULT 'generating'
    CHECK (status IN ('generating', 'ready', 'failed')),
  params jsonb NOT NULL DEFAULT '{}'::jsonb,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_message text
);

CREATE INDEX IF NOT EXISTS idx_simulation_batches_created_at
  ON simulation_batches (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_simulation_batches_status_created
  ON simulation_batches (status, created_at DESC);

CREATE TABLE IF NOT EXISTS simulation_portfolios (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES simulation_batches(id) ON DELETE CASCADE,
  run_index integer NOT NULL CHECK (run_index >= 0),
  window_start date NOT NULL,
  window_end date NOT NULL,
  regime_label text NOT NULL
    CHECK (regime_label IN ('bull', 'bear', 'sideways', 'mixed', 'crisis')),
  start_nav_usd numeric NOT NULL DEFAULT 1000000,
  end_nav_usd numeric NOT NULL,
  total_return_pct numeric NOT NULL,
  max_drawdown_pct numeric NOT NULL,
  cagr_pct numeric NOT NULL,
  chain_split jsonb NOT NULL DEFAULT '{}'::jsonb,
  protocol_pnl jsonb NOT NULL DEFAULT '{}'::jsonb,
  series jsonb NOT NULL DEFAULT '[]'::jsonb,
  UNIQUE (batch_id, run_index)
);

CREATE INDEX IF NOT EXISTS idx_simulation_portfolios_batch
  ON simulation_portfolios (batch_id, run_index);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
    WHERE schemaname = 'public' AND tablename = 'simulation_batches' AND rowsecurity = true
  ) THEN
    ALTER TABLE simulation_batches ENABLE ROW LEVEL SECURITY;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
    WHERE schemaname = 'public' AND tablename = 'simulation_portfolios' AND rowsecurity = true
  ) THEN
    ALTER TABLE simulation_portfolios ENABLE ROW LEVEL SECURITY;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'simulation_batches'
      AND policyname = 'Service role manages simulation batches'
  ) THEN
    CREATE POLICY "Service role manages simulation batches"
      ON simulation_batches
      FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'simulation_batches'
      AND policyname = 'Public read simulation batches'
  ) THEN
    CREATE POLICY "Public read simulation batches"
      ON simulation_batches
      FOR SELECT
      TO anon, authenticated
      USING (true);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'simulation_portfolios'
      AND policyname = 'Service role manages simulation portfolios'
  ) THEN
    CREATE POLICY "Service role manages simulation portfolios"
      ON simulation_portfolios
      FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'simulation_portfolios'
      AND policyname = 'Public read simulation portfolios'
  ) THEN
    CREATE POLICY "Public read simulation portfolios"
      ON simulation_portfolios
      FOR SELECT
      TO anon, authenticated
      USING (true);
  END IF;
END $$;

GRANT SELECT ON simulation_batches TO anon, authenticated;
GRANT SELECT ON simulation_portfolios TO anon, authenticated;
GRANT ALL ON simulation_batches TO service_role;
GRANT ALL ON simulation_portfolios TO service_role;
