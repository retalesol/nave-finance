/*
  # Add reasoning_hash to agent_action_logs

  Phase 7 reasoning-hash integrity. The dispatcher now computes a deterministic
  SHA-256 over the canonical reasoning artifacts and the signer commits the same
  hash on-chain. Persisting it lets us detect drift between the stored reasoning
  and the on-chain commitment (recompute and compare).

  1. Changes
    - Add `reasoning_hash` (text, default '') to `agent_action_logs`
    - Index on (reasoning_hash) for drift/replay lookups
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'agent_action_logs'
      AND column_name = 'reasoning_hash'
  ) THEN
    ALTER TABLE agent_action_logs ADD COLUMN reasoning_hash text DEFAULT '';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'agent_action_logs'
      AND indexname = 'idx_agent_action_logs_reasoning_hash'
  ) THEN
    CREATE INDEX idx_agent_action_logs_reasoning_hash ON agent_action_logs(reasoning_hash);
  END IF;
END $$;
