/*
  # Add tx_signature to agent_action_logs

  The orchestrator now submits on-chain approval/halt transactions through the
  Node.js signer service and records the resulting Solana transaction signature.

  1. Changes
    - Add `tx_signature` (text, default '') to `agent_action_logs`
    - Index on (tx_signature) for lookups / dedupe
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'agent_action_logs'
      AND column_name = 'tx_signature'
  ) THEN
    ALTER TABLE agent_action_logs ADD COLUMN tx_signature text DEFAULT '';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'agent_action_logs'
      AND indexname = 'idx_agent_action_logs_tx_signature'
  ) THEN
    CREATE INDEX idx_agent_action_logs_tx_signature ON agent_action_logs(tx_signature);
  END IF;
END $$;
