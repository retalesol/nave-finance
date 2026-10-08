/*
  EVM claim-on-demand reward ledger.

  EVM stakers earn a pro-rata share of the ONE Solana reward pool. Instead of
  pre-funding each EVM chain's drip contract (whose 365-day integer rate floor
  strands small deliveries as dust), the relayer keeps an authoritative
  per-(chain, staker) accrual here and wraps + mints wNAVE straight to the
  staker at claim time (lockbox `bridgeIn`, replay partition 902).

  accrued_raw folds `stake / globalTVL x solanaRatePerSec x elapsed` on every
  server-side sync; claimed_raw is the lifetime paid out. Claimable =
  accrued_raw - claimed_raw. Payout audit rows live in bridge_stake_events with
  kind = 'reward_claim' (their per-chain count also derives the 902 nonces, so
  every attempt permanently consumes its nonce).

  RLS mirrors bridge_stake_events: public read (the UI shows the claimable
  balance), writes only via the service role (the relayer).
*/

CREATE TABLE IF NOT EXISTS public.evm_reward_accounts (
  chain_id bigint NOT NULL,
  staker text NOT NULL, -- lowercase 0x address
  accrued_raw numeric NOT NULL DEFAULT 0,
  claimed_raw numeric NOT NULL DEFAULT 0,
  -- Stake observed at the last fold (base units) — lets the fold detect
  -- stake changes between syncs and bound the error window.
  staked_raw numeric NOT NULL DEFAULT 0,
  -- Timestamp the accrual was last folded up to.
  anchor_ts timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, staker),
  CONSTRAINT evm_reward_accounts_nonneg CHECK (accrued_raw >= 0 AND claimed_raw >= 0),
  CONSTRAINT evm_reward_accounts_claimed_lte_accrued CHECK (claimed_raw <= accrued_raw)
);

CREATE INDEX IF NOT EXISTS idx_evm_reward_accounts_staker
  ON public.evm_reward_accounts (staker);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
    WHERE schemaname = 'public' AND tablename = 'evm_reward_accounts' AND rowsecurity = true
  ) THEN
    ALTER TABLE public.evm_reward_accounts ENABLE ROW LEVEL SECURITY;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'evm_reward_accounts'
      AND policyname = 'evm_reward_accounts_public_read'
  ) THEN
    CREATE POLICY evm_reward_accounts_public_read
      ON public.evm_reward_accounts
      FOR SELECT
      USING (true);
  END IF;
END $$;

-- No INSERT/UPDATE/DELETE policies: only the service role (relayer) writes.
