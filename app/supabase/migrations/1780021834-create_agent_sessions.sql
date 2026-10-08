/*
  # Create agent_sessions table

  Prevents duplicate concurrent agent runs for the same agent + execution request.
  Uses a partial unique index to enforce at most one active session per agent per request.

  1. New Tables
    - `agent_sessions`
      - `id` (uuid, primary key)
      - `dao_onchain_address` (text, NOT NULL)
      - `agent_role` (text, NOT NULL) — 'executive' | 'financial' | 'oversight' | 'operational'
      - `execution_request_address` (text, NOT NULL)
      - `session_status` (text, default 'active') — 'active' | 'completed' | 'failed' | 'expired'
      - `started_at` (timestamptz, default now())
      - `completed_at` (timestamptz, nullable)
      - `expires_at` (timestamptz, NOT NULL) — auto-expire after 5 minutes
      - `error_message` (text, nullable)
  2. Security
    - Enable RLS
    - service_role only — no anon/authenticated access
  3. Indexes
    - Partial unique index: one active session per (dao, role, execution_request)
    - Index on expires_at for cleanup queries
*/

-- Create table
CREATE TABLE IF NOT EXISTS agent_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dao_onchain_address text NOT NULL,
  agent_role text NOT NULL CHECK (agent_role IN ('executive', 'financial', 'oversight', 'operational')),
  execution_request_address text NOT NULL,
  session_status text NOT NULL DEFAULT 'active' CHECK (session_status IN ('active', 'completed', 'failed', 'expired')),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '5 minutes'),
  error_message text
);

-- Enable RLS
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
    WHERE schemaname = 'public' AND tablename = 'agent_sessions' AND rowsecurity = true
  ) THEN
    ALTER TABLE agent_sessions ENABLE ROW LEVEL SECURITY;
  END IF;
END $$;

-- Partial unique index: only one active session per agent per execution request
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'agent_sessions'
      AND indexname = 'idx_agent_sessions_active_unique'
  ) THEN
    CREATE UNIQUE INDEX idx_agent_sessions_active_unique
      ON agent_sessions (dao_onchain_address, agent_role, execution_request_address)
      WHERE session_status = 'active';
  END IF;
END $$;

-- Index on expires_at for cleanup
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'agent_sessions'
      AND indexname = 'idx_agent_sessions_expires'
  ) THEN
    CREATE INDEX idx_agent_sessions_expires ON agent_sessions(expires_at) WHERE session_status = 'active';
  END IF;
END $$;

-- Index on dao + role for queries
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'agent_sessions'
      AND indexname = 'idx_agent_sessions_dao_role'
  ) THEN
    CREATE INDEX idx_agent_sessions_dao_role ON agent_sessions(dao_onchain_address, agent_role);
  END IF;
END $$;