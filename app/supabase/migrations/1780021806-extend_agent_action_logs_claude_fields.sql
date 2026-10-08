/*
  # Extend agent_action_logs for Claude AI integration

  1. New Columns
    - `confidence_score` (smallint) — 0-100 confidence from Claude reasoning
    - `risk_flags` (jsonb) — Array of risk flag strings identified by Claude
    - `decision` (text) — 'approve' | 'reject' | 'request_review' | 'continue' | 'halt' | 'clear_halt'
    - `claude_model` (text) — Model version used (e.g. 'claude-sonnet-4-5')
    - `raw_claude_response` (text) — Full raw JSON response for audit trail
    - `retry_count` (smallint) — Number of Claude inference attempts for this action
  2. Indexes
    - Index on decision for filtering agent decisions
    - Index on confidence_score for threshold queries
*/

-- Add confidence_score column
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'agent_action_logs'
      AND column_name = 'confidence_score'
  ) THEN
    ALTER TABLE agent_action_logs ADD COLUMN confidence_score smallint;
  END IF;
END $$;

-- Add risk_flags column
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'agent_action_logs'
      AND column_name = 'risk_flags'
  ) THEN
    ALTER TABLE agent_action_logs ADD COLUMN risk_flags jsonb DEFAULT '[]'::jsonb;
  END IF;
END $$;

-- Add decision column
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'agent_action_logs'
      AND column_name = 'decision'
  ) THEN
    ALTER TABLE agent_action_logs ADD COLUMN decision text;
  END IF;
END $$;

-- Add claude_model column
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'agent_action_logs'
      AND column_name = 'claude_model'
  ) THEN
    ALTER TABLE agent_action_logs ADD COLUMN claude_model text;
  END IF;
END $$;

-- Add raw_claude_response column
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'agent_action_logs'
      AND column_name = 'raw_claude_response'
  ) THEN
    ALTER TABLE agent_action_logs ADD COLUMN raw_claude_response text;
  END IF;
END $$;

-- Add retry_count column
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'agent_action_logs'
      AND column_name = 'retry_count'
  ) THEN
    ALTER TABLE agent_action_logs ADD COLUMN retry_count smallint DEFAULT 0;
  END IF;
END $$;

-- Index on decision for filtering
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'agent_action_logs'
      AND indexname = 'idx_agent_action_logs_decision'
  ) THEN
    CREATE INDEX idx_agent_action_logs_decision ON agent_action_logs(decision);
  END IF;
END $$;

-- Index on confidence_score for threshold queries
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'agent_action_logs'
      AND indexname = 'idx_agent_action_logs_confidence'
  ) THEN
    CREATE INDEX idx_agent_action_logs_confidence ON agent_action_logs(confidence_score);
  END IF;
END $$;