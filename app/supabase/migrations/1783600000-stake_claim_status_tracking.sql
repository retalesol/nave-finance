/*
  Staged claim-status tracking for claim-on-demand EVM rewards.

  A reward_claim row is now inserted the moment the relayer ACCEPTS a claim
  (status 'submitted') and then walks through 'wrapping' (NAVE reserve →
  bridge custody on Solana) → 'delivering' (lockbox bridgeIn mint on the EVM
  chain) → 'completed' / 'failed', so the app's "Your Transactions" feed can
  show live progress. Because the row exists before the Solana wrap, its
  source_tx becomes a synthetic stable id (stake-claim:<chainId>:<nonce>) and
  the real wrap transaction lands in the new wrap_tx column; dest_tx keeps the
  EVM mint tx as before.

  Also indexes (staker, created_at) — the transactions feed reads a wallet's
  recent stake/unstake/claim rows directly (public SELECT policy already
  exists).
*/

ALTER TABLE public.bridge_stake_events
  ADD COLUMN IF NOT EXISTS wrap_tx text;

CREATE INDEX IF NOT EXISTS idx_bridge_stake_events_staker_created
  ON public.bridge_stake_events (staker, created_at DESC);
