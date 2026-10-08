/*
  # Add Robinhood Chain (Arbitrum Nitro L2) — bridge + staking ONLY

  Robinhood Chain joins Ethereum and Base as a supported EVM chain for the
  NAVE bridge + staking stack: mainnet chain_id 4663, testnet 46630.

  Scope fence: Robinhood hosts NO DAO contracts. Only the surfaces the
  bridge/staking flows touch are widened:

    - `evm_indexer_cursors` — the EVM indexer keeps a scan cursor per chain.
    - `activity_logs`       — indexed bridge/staking events land here via the
                              index-events edge function (scope "indexer").

  Deliberately NOT widened (stay ethereum/base-only, matching the "dao" scope
  in supabase/functions/_shared/chain.ts): dao_registry, treasury_snapshots,
  agent_action_logs, monthly_reports, watched_daos, encrypted_evm_keys.

  bridge_transfers / bridge_stake_events have no chain CHECK constraints (the
  relayer validates chains in code), so no change is needed there.

  Idempotent: constraints are dropped-if-exists then re-added.
*/

-- ── evm_indexer_cursors: allow the two Robinhood chain ids ──────────────────
ALTER TABLE public.evm_indexer_cursors
  DROP CONSTRAINT IF EXISTS evm_indexer_cursors_chain_id_check;
ALTER TABLE public.evm_indexer_cursors
  ADD CONSTRAINT evm_indexer_cursors_chain_id_check
  CHECK (chain_id IN (1, 8453, 4663, 11155111, 84532, 46630));

ALTER TABLE public.evm_indexer_cursors
  DROP CONSTRAINT IF EXISTS evm_indexer_cursors_chain_check;
ALTER TABLE public.evm_indexer_cursors
  ADD CONSTRAINT evm_indexer_cursors_chain_check
  CHECK (chain IN ('ethereum', 'base', 'robinhood'));

-- ── activity_logs: accept robinhood (chain, chain_id) pairs ─────────────────
ALTER TABLE public.activity_logs
  DROP CONSTRAINT IF EXISTS activity_logs_chain_check;
ALTER TABLE public.activity_logs
  ADD CONSTRAINT activity_logs_chain_check
  CHECK (
    chain IN ('solana', 'ethereum', 'base', 'robinhood')
    AND (
      (chain = 'solana'    AND chain_id IS NULL)
      OR (chain = 'ethereum'  AND chain_id IN (1, 11155111))
      OR (chain = 'base'      AND chain_id IN (8453, 84532))
      OR (chain = 'robinhood' AND chain_id IN (4663, 46630))
    )
  );
