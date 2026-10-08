/*
  # Create treasury_snapshots and monthly_reports tables

  treasury_snapshots stores periodic vault balance snapshots for time-series
  charts (replaces TREASURY_HISTORY mock). Populated by the snapshot-treasury
  edge function on a cron schedule.

  monthly_reports stores aggregated monthly performance data for the
  reporting dashboard (replaces REPORT_YEARS mock). Aggregated from
  snapshots and activity_logs by the snapshot-treasury edge function.

  1. New Tables
    - `treasury_snapshots`
      - `id` (uuid, primary key)
      - `dao_onchain_address` (text, NOT NULL)
      - `total_value_usd` (numeric, NOT NULL, default 0)
      - `sol_balance` (numeric, NOT NULL, default 0)
      - `usdc_balance` (numeric, NOT NULL, default 0)
      - `strategy_positions` (jsonb) — breakdown of DeFi positions
      - `token_balances` (jsonb) — all SPL token balances
      - `snapshot_at` (timestamptz, NOT NULL)

    - `monthly_reports`
      - `id` (uuid, primary key)
      - `dao_onchain_address` (text, NOT NULL)
      - `year` (int, NOT NULL)
      - `month` (int, NOT NULL)
      - `capital_start` (numeric, default 0)
      - `capital_end` (numeric, default 0)
      - `yield_earned` (numeric, default 0)
      - `fees_collected` (numeric, default 0)
      - `agent_actions_count` (int, default 0)
      - `wallet_actions_count` (int, default 0)
      - `proposals_count` (int, default 0)
      - `summary` (jsonb) — detailed breakdown
      - `created_at` (timestamptz)

  2. Indexes
    - treasury_snapshots: (dao_onchain_address, snapshot_at DESC)
    - monthly_reports: unique (dao_onchain_address, year, month)

  3. Security
    - RLS enabled, public read for non-private DAOs
    - Service role write access
*/

-- =============================================
-- TABLE: treasury_snapshots
-- =============================================
CREATE TABLE IF NOT EXISTS treasury_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dao_onchain_address text NOT NULL,
  total_value_usd numeric NOT NULL DEFAULT 0,
  sol_balance numeric NOT NULL DEFAULT 0,
  usdc_balance numeric NOT NULL DEFAULT 0,
  strategy_positions jsonb DEFAULT '[]',
  token_balances jsonb DEFAULT '[]',
  snapshot_at timestamptz NOT NULL DEFAULT now()
);

-- Index: primary query path
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'treasury_snapshots' AND indexname = 'idx_treasury_snapshots_dao_time'
  ) THEN
    CREATE INDEX idx_treasury_snapshots_dao_time ON treasury_snapshots(dao_onchain_address, snapshot_at DESC);
  END IF;
END $$;

-- Enable RLS
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
    WHERE schemaname = 'public' AND tablename = 'treasury_snapshots' AND rowsecurity = true
  ) THEN
    ALTER TABLE treasury_snapshots ENABLE ROW LEVEL SECURITY;
  END IF;
END $$;

-- Policy: Public read for non-private DAO snapshots
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'treasury_snapshots' AND policyname = 'Public read treasury snapshots'
  ) THEN
    CREATE POLICY "Public read treasury snapshots"
      ON treasury_snapshots
      FOR SELECT
      TO anon, authenticated
      USING (
        EXISTS (
          SELECT 1 FROM dao_registry
          WHERE dao_registry.dao_onchain_address = treasury_snapshots.dao_onchain_address
            AND dao_registry.privacy_enabled = false
        )
      );
  END IF;
END $$;

-- Policy: Service role full access
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'treasury_snapshots' AND policyname = 'Service role manages treasury snapshots'
  ) THEN
    CREATE POLICY "Service role manages treasury snapshots"
      ON treasury_snapshots
      FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;

-- =============================================
-- TABLE: monthly_reports
-- =============================================
CREATE TABLE IF NOT EXISTS monthly_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dao_onchain_address text NOT NULL,
  year int NOT NULL,
  month int NOT NULL CHECK (month >= 1 AND month <= 12),
  capital_start numeric NOT NULL DEFAULT 0,
  capital_end numeric NOT NULL DEFAULT 0,
  yield_earned numeric NOT NULL DEFAULT 0,
  fees_collected numeric NOT NULL DEFAULT 0,
  agent_actions_count int NOT NULL DEFAULT 0,
  wallet_actions_count int NOT NULL DEFAULT 0,
  proposals_count int NOT NULL DEFAULT 0,
  summary jsonb DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Unique constraint: one report per DAO per month
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'monthly_reports' AND indexname = 'idx_monthly_reports_dao_period'
  ) THEN
    CREATE UNIQUE INDEX idx_monthly_reports_dao_period ON monthly_reports(dao_onchain_address, year, month);
  END IF;
END $$;

-- Enable RLS
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
    WHERE schemaname = 'public' AND tablename = 'monthly_reports' AND rowsecurity = true
  ) THEN
    ALTER TABLE monthly_reports ENABLE ROW LEVEL SECURITY;
  END IF;
END $$;

-- Policy: Public read for non-private DAO reports
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'monthly_reports' AND policyname = 'Public read monthly reports'
  ) THEN
    CREATE POLICY "Public read monthly reports"
      ON monthly_reports
      FOR SELECT
      TO anon, authenticated
      USING (
        EXISTS (
          SELECT 1 FROM dao_registry
          WHERE dao_registry.dao_onchain_address = monthly_reports.dao_onchain_address
            AND dao_registry.privacy_enabled = false
        )
      );
  END IF;
END $$;

-- Policy: Service role full access
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'monthly_reports' AND policyname = 'Service role manages monthly reports'
  ) THEN
    CREATE POLICY "Service role manages monthly reports"
      ON monthly_reports
      FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;