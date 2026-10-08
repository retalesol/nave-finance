/*
  # Agent token accounting + snapshot reconciliation status

  1. `agent_action_logs.input_tokens` / `output_tokens` — exact per-inference
     token usage reported by the model API. `agent-dispatcher` enforces a
     per-DAO daily token budget (`LLM_DAILY_TOKEN_BUDGET`) and reads these
     columns when present; until now it had to estimate from response length.

  2. `treasury_snapshots.reconciliation_status` — result of the off-chain
     reconciliation self-test in `snapshot-treasury`:
       - 'ok'          : invariants recomputed from on-chain state, no breach
       - 'suspect'     : deployed_capital > 0 but every escrow/position/vault
                         read zero (PDA derivation / layout drift — monitoring
                         would otherwise be silently blind)
       - 'unavailable' : reconciliation not performed for this row (EVM rows,
                         RPC failure, legacy rows)

  Idempotent (ADD COLUMN IF NOT EXISTS; constraint re-created).
*/

ALTER TABLE public.agent_action_logs
  ADD COLUMN IF NOT EXISTS input_tokens  integer,
  ADD COLUMN IF NOT EXISTS output_tokens integer;

COMMENT ON COLUMN public.agent_action_logs.input_tokens  IS 'Model API usage.input_tokens for this inference (null = not recorded).';
COMMENT ON COLUMN public.agent_action_logs.output_tokens IS 'Model API usage.output_tokens for this inference (null = not recorded).';

-- Daily-budget query: (dao, created_at) already indexed? Add a covering index
-- only if the common lookup index is missing.
CREATE INDEX IF NOT EXISTS idx_agent_action_logs_dao_created
  ON public.agent_action_logs (dao_onchain_address, created_at DESC);

ALTER TABLE public.treasury_snapshots
  ADD COLUMN IF NOT EXISTS reconciliation_status text NOT NULL DEFAULT 'unavailable';

ALTER TABLE public.treasury_snapshots
  DROP CONSTRAINT IF EXISTS treasury_snapshots_reconciliation_status_check;
ALTER TABLE public.treasury_snapshots
  ADD CONSTRAINT treasury_snapshots_reconciliation_status_check
  CHECK (reconciliation_status IN ('ok', 'suspect', 'unavailable'));

COMMENT ON COLUMN public.treasury_snapshots.reconciliation_status IS
  'snapshot-treasury reconciliation self-test: ok | suspect (all positions read zero while deployed_capital > 0) | unavailable.';
