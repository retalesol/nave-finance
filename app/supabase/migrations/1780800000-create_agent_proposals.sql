/*
  # Autonomous proposal ledger (Phase 4)

  Records governance proposals that the planner pipeline creates from
  `rebalance_recommendations`. This table is the idempotency + audit boundary
  for autonomous proposing:

  1. New Table
    - `agent_proposals`
      - One row per autonomously-created governance proposal.
      - `idempotency_key` is the source recommendation's `policy_proof_hash`
        (or a deterministic per-action hash). A UNIQUE (dao, idempotency_key)
        constraint guarantees the same recommendation can NEVER produce two
        on-chain proposals, even under concurrent worker/edge invocations.
      - `status` tracks the lifecycle: creating → created | failed.

  2. Security
    - RLS enabled.
    - Public read for non-private DAOs (mirrors agent_action_logs).
    - Only service_role writes (the signer-service / proposal-creator).

  Separation of duties (unchanged): the planner PROPOSES; the existing 4-agent
  pipeline approves/halts/executes; on-chain invariants + deterministic
  guardrails remain the signing authority. A created proposal still has to pass
  governance and the full execution pipeline before any funds move.
*/

CREATE TABLE IF NOT EXISTS public.agent_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dao_onchain_address text NOT NULL,
  -- Idempotency key: the recommendation proof hash (or per-action digest). The
  -- UNIQUE index below makes proposal creation exactly-once per key.
  idempotency_key text NOT NULL,
  recommendation_id uuid,
  protocol_id text NOT NULL,
  program_id text NOT NULL DEFAULT '',
  amount_base_units numeric NOT NULL DEFAULT 0,
  proposal_index integer,
  proposal_address text DEFAULT '',
  payload_hash text DEFAULT '',
  tx_signature text DEFAULT '',
  proposer_role text NOT NULL DEFAULT 'planner',
  status text NOT NULL DEFAULT 'creating' CHECK (status IN ('creating', 'created', 'failed')),
  error_message text DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_proposals_dao_time
  ON public.agent_proposals (dao_onchain_address, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_proposals_recommendation
  ON public.agent_proposals (recommendation_id);

-- Exactly-once guarantee: a (dao, idempotency_key) pair can map to at most one
-- proposal attempt. The signer inserts BEFORE submitting on-chain; a duplicate
-- insert (concurrent or retried) collides here and is rejected as a no-op.
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_proposals_dao_key
  ON public.agent_proposals (dao_onchain_address, idempotency_key);

ALTER TABLE public.agent_proposals ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'agent_proposals' AND policyname = 'Public read agent proposals'
  ) THEN
    CREATE POLICY "Public read agent proposals"
      ON public.agent_proposals
      FOR SELECT
      TO anon, authenticated
      USING (
        EXISTS (
          SELECT 1 FROM dao_registry
          WHERE dao_registry.dao_onchain_address = agent_proposals.dao_onchain_address
            AND dao_registry.privacy_enabled = false
        )
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'agent_proposals' AND policyname = 'Service role manages agent proposals'
  ) THEN
    CREATE POLICY "Service role manages agent proposals"
      ON public.agent_proposals
      FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;
