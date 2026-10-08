/*
  # Create activity_logs table

  Stores parsed on-chain transaction events for all DAOs. Replaces
  RECENT_ACTIVITY and AUDIT_LOG mock arrays in the frontend.

  Populated by the index-events edge function (service_role only).
  Read by the frontend for activity feeds and audit trails.

  1. New Tables
    - `activity_logs`
      - `id` (uuid, primary key)
      - `dao_onchain_address` (text, NOT NULL)
      - `event_type` (text, NOT NULL) — e.g. 'DaoCreated', 'TreasuryDeposit', 'VoteCast'
      - `description` (text) — human-readable description
      - `actor` (text) — base58 pubkey of the wallet/agent that initiated
      - `agent_role` (text, nullable) — if an agent initiated this action
      - `tx_signature` (text) — Solana transaction signature
      - `slot` (bigint) — Solana slot number
      - `block_time` (timestamptz, nullable) — block timestamp
      - `raw_data` (jsonb) — full parsed event data
      - `created_at` (timestamptz)

  2. Indexes
    - (dao_onchain_address, created_at DESC) — primary query path
    - (tx_signature) — deduplication and lookups
    - (dao_onchain_address, event_type) — filtered queries

  3. Security
    - RLS enabled
    - Public read for non-private DAOs (joins to dao_registry)
    - Service role full access for indexer writes
*/

CREATE TABLE IF NOT EXISTS activity_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dao_onchain_address text NOT NULL,
  event_type text NOT NULL DEFAULT '',
  description text DEFAULT '',
  actor text DEFAULT '',
  agent_role text,
  tx_signature text DEFAULT '',
  slot bigint,
  block_time timestamptz,
  raw_data jsonb DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Index: primary query — DAO + time descending
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'activity_logs' AND indexname = 'idx_activity_logs_dao_time'
  ) THEN
    CREATE INDEX idx_activity_logs_dao_time ON activity_logs(dao_onchain_address, created_at DESC);
  END IF;
END $$;

-- Index: tx signature for dedup
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'activity_logs' AND indexname = 'idx_activity_logs_tx'
  ) THEN
    CREATE INDEX idx_activity_logs_tx ON activity_logs(tx_signature);
  END IF;
END $$;

-- Index: filtered by event type
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'activity_logs' AND indexname = 'idx_activity_logs_dao_type'
  ) THEN
    CREATE INDEX idx_activity_logs_dao_type ON activity_logs(dao_onchain_address, event_type);
  END IF;
END $$;

-- Enable RLS
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
    WHERE schemaname = 'public' AND tablename = 'activity_logs' AND rowsecurity = true
  ) THEN
    ALTER TABLE activity_logs ENABLE ROW LEVEL SECURITY;
  END IF;
END $$;

-- Policy: Public read for logs belonging to non-private DAOs
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'activity_logs' AND policyname = 'Public read for non-private DAO logs'
  ) THEN
    CREATE POLICY "Public read for non-private DAO logs"
      ON activity_logs
      FOR SELECT
      TO anon, authenticated
      USING (
        EXISTS (
          SELECT 1 FROM dao_registry
          WHERE dao_registry.dao_onchain_address = activity_logs.dao_onchain_address
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
    WHERE schemaname = 'public' AND tablename = 'activity_logs' AND policyname = 'Service role manages activity logs'
  ) THEN
    CREATE POLICY "Service role manages activity logs"
      ON activity_logs
      FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;