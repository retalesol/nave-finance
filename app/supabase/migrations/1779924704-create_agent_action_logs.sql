/*
  # Create agent_action_logs table

  Stores AI agent reasoning, analysis, and action records. Each time an agent
  processes a DAO's constitution, analyzes a strategy, or takes an action,
  the reasoning chain is recorded here for auditability.

  1. New Tables
    - `agent_action_logs`
      - `id` (uuid, primary key)
      - `dao_onchain_address` (text, NOT NULL)
      - `agent_role` (text, NOT NULL) — 'executive' | 'financial' | 'oversight' | 'operational'
      - `action_type` (text, NOT NULL) — e.g. 'strategy_proposal', 'risk_review', 'payload_construction'
      - `reasoning` (text) — the agent's reasoning/analysis text
      - `constitution_check` (jsonb) — which constitution rules were evaluated
      - `payload_hash` (text) — hash of any transaction payload constructed
      - `execution_request_address` (text) — on-chain ExecutionRequest PDA if applicable
      - `status` (text, NOT NULL, default 'pending') — 'pending', 'approved', 'rejected', 'executed', 'halted'
      - `error_message` (text) — if the action failed
      - `created_at` (timestamptz)
      - `completed_at` (timestamptz, nullable)

  2. Indexes
    - (dao_onchain_address, agent_role, created_at DESC) — primary query
    - (dao_onchain_address, status) — filter by status

  3. Security
    - RLS enabled
    - Public read for non-private DAOs
    - Only service_role can write (agent services)
*/

CREATE TABLE IF NOT EXISTS agent_action_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dao_onchain_address text NOT NULL,
  agent_role text NOT NULL CHECK (agent_role IN ('executive', 'financial', 'oversight', 'operational')),
  action_type text NOT NULL DEFAULT '',
  reasoning text DEFAULT '',
  constitution_check jsonb DEFAULT '{}',
  payload_hash text DEFAULT '',
  execution_request_address text DEFAULT '',
  status text NOT NULL DEFAULT 'pending',
  error_message text DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

-- Index: primary query path
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'agent_action_logs' AND indexname = 'idx_agent_logs_dao_role_time'
  ) THEN
    CREATE INDEX idx_agent_logs_dao_role_time ON agent_action_logs(dao_onchain_address, agent_role, created_at DESC);
  END IF;
END $$;

-- Index: status filter
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'agent_action_logs' AND indexname = 'idx_agent_logs_dao_status'
  ) THEN
    CREATE INDEX idx_agent_logs_dao_status ON agent_action_logs(dao_onchain_address, status);
  END IF;
END $$;

-- Enable RLS
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
    WHERE schemaname = 'public' AND tablename = 'agent_action_logs' AND rowsecurity = true
  ) THEN
    ALTER TABLE agent_action_logs ENABLE ROW LEVEL SECURITY;
  END IF;
END $$;

-- Policy: Public read for non-private DAO agent logs
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'agent_action_logs' AND policyname = 'Public read agent action logs'
  ) THEN
    CREATE POLICY "Public read agent action logs"
      ON agent_action_logs
      FOR SELECT
      TO anon, authenticated
      USING (
        EXISTS (
          SELECT 1 FROM dao_registry
          WHERE dao_registry.dao_onchain_address = agent_action_logs.dao_onchain_address
            AND dao_registry.privacy_enabled = false
        )
      );
  END IF;
END $$;

-- Policy: Service role full access (agent services write here)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'agent_action_logs' AND policyname = 'Service role manages agent action logs'
  ) THEN
    CREATE POLICY "Service role manages agent action logs"
      ON agent_action_logs
      FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;