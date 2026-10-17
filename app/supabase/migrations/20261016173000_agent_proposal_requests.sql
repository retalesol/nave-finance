/*
  # Planner proposals carry their asset and the request they became

  A passed planner proposal is bound to an execution request with the same
  (adapter, amount, asset) the proposal committed. The asset was only inside
  the idempotency key, so it is stored on its own. `execution_request_address`
  records the request once created (a Solana PDA, or `0xexecution#index` on EVM),
  and status moves from `created` to `requested`.
*/

ALTER TABLE public.agent_proposals
  ADD COLUMN IF NOT EXISTS asset_mint text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS execution_request_address text NOT NULL DEFAULT '';

ALTER TABLE public.agent_proposals DROP CONSTRAINT IF EXISTS agent_proposals_status_check;
ALTER TABLE public.agent_proposals
  ADD CONSTRAINT agent_proposals_status_check
  CHECK (status IN ('creating', 'created', 'requested', 'failed'));
