/*
  # Bridge hardening: fee legs + on-chain replay ids + staking events

  Extends `bridge_transfers` for the mainnet-hardened bridge, where the 2.5%
  fee is charged ON TOP and split three ways (staking 1% / protocol 1% /
  burn 0.5%) resolved on-chain, and where the primary replay guard is on-chain
  (nave_bridge `ProcessedRelease` PDA / lockbox `processed[srcChainId,srcNonce]`).

    • staking_raw / protocol_raw / burn_raw — the three fee legs (base units).
    • source_nonce — the Solana lock's outbound nonce (Solana→EVM replay key on
      the EVM lockbox).
    • source_message_id — the 32-byte source message id (EVM burn tx hash) used
      as the nave_bridge release replay key.

  Also adds `bridge_stake_events`, an audit trail the relayer writes when it
  mirrors EVM stake/unstake to the central Solana pool or delivers EVM reward
  top-ups. Read-only to the public (same posture as bridge_transfers).

  All ADDs are idempotent (IF NOT EXISTS) so re-applying is safe.
*/

ALTER TABLE public.bridge_transfers
  ADD COLUMN IF NOT EXISTS staking_raw numeric,
  ADD COLUMN IF NOT EXISTS protocol_raw numeric,
  ADD COLUMN IF NOT EXISTS burn_raw numeric,
  ADD COLUMN IF NOT EXISTS source_nonce numeric,
  ADD COLUMN IF NOT EXISTS source_message_id text;

-- ── Staking mirror / reward audit trail ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.bridge_stake_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 'stake' | 'unstake' | 'reward_topup'
  kind text NOT NULL,
  -- chain the event originated on ('ethereum' | 'base') and its numeric id
  source_chain text NOT NULL,
  source_chain_id numeric,
  -- source tx hash of the EVM stake/unstake/claim (UNIQUE → idempotent mirror)
  source_tx text NOT NULL UNIQUE,
  -- destination action (Solana pool sync / EVM reward mint) tx once submitted
  dest_tx text,
  staker text,
  amount_raw numeric NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bridge_stake_events_staker
  ON public.bridge_stake_events (staker);
CREATE INDEX IF NOT EXISTS idx_bridge_stake_events_status
  ON public.bridge_stake_events (status);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
    WHERE schemaname = 'public' AND tablename = 'bridge_stake_events' AND rowsecurity = true
  ) THEN
    ALTER TABLE public.bridge_stake_events ENABLE ROW LEVEL SECURITY;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'bridge_stake_events'
      AND policyname = 'Service role manages bridge stake events'
  ) THEN
    CREATE POLICY "Service role manages bridge stake events"
      ON public.bridge_stake_events
      FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'bridge_stake_events'
      AND policyname = 'Public can read bridge stake events'
  ) THEN
    CREATE POLICY "Public can read bridge stake events"
      ON public.bridge_stake_events
      FOR SELECT
      TO anon, authenticated
      USING (true);
  END IF;
END $$;
