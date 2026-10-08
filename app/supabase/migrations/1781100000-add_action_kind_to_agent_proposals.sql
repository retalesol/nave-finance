/*
  # Add action_kind to the autonomous proposal ledger (Workstream C, planner)

  The deterministic policy engine (`_shared/policy.ts`) emits three action
  kinds: `deploy`, `withdraw`, and `hold`. The planner (`proposal-creator`)
  now proposes both `deploy` AND `withdraw` capital movements (the latter from
  `reduce_exposure` and the withdraw legs of `rebalance` recommendations).

  On-chain, BOTH are the SAME governance primitive: a `ProposalType::Strategy`
  proposal whose payload binds `(protocol_program, amount, mint)`. The payload
  is direction-agnostic — the direction (deposit vs redeem) is decided at
  EXECUTION time by which instruction the pipeline runs (`execute_strategy`
  vs `withdraw_from_strategy`). We therefore persist the intended direction
  here so the downstream 4-agent pipeline can route a passed proposal to the
  correct instruction (and so the ledger is auditable).

  1. Change
    - `agent_proposals.action_kind` text NOT NULL DEFAULT 'deploy'
      CHECK (action_kind IN ('deploy', 'withdraw')).
      Defaulting to 'deploy' preserves the meaning of every existing row.

  Separation of duties is unchanged: the planner only PROPOSES; the existing
  pipeline approves/halts/executes; on-chain invariants + deterministic
  guardrails remain the signing authority.
*/

ALTER TABLE public.agent_proposals
  ADD COLUMN IF NOT EXISTS action_kind text NOT NULL DEFAULT 'deploy';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_proposals_action_kind_check'
  ) THEN
    ALTER TABLE public.agent_proposals
      ADD CONSTRAINT agent_proposals_action_kind_check
      CHECK (action_kind IN ('deploy', 'withdraw'));
  END IF;
END $$;
