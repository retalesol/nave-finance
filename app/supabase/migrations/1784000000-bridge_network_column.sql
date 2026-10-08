-- Scope bridge + stake activity by deployment network.
-- Historical rows were written during testnet/devnet beta using family names
-- like 'ethereum'/'base' that collide with mainnet labels, so the Bridge page
-- must filter by an explicit network column rather than chain name alone.

ALTER TABLE public.bridge_transfers
  ADD COLUMN IF NOT EXISTS network text NOT NULL DEFAULT 'testnet';

ALTER TABLE public.bridge_stake_events
  ADD COLUMN IF NOT EXISTS network text NOT NULL DEFAULT 'testnet';

-- Existing rows predate mainnet cutover.
UPDATE public.bridge_transfers SET network = 'testnet' WHERE network IS NULL OR network = '';
UPDATE public.bridge_stake_events SET network = 'testnet' WHERE network IS NULL OR network = '';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bridge_transfers_network_check'
  ) THEN
    ALTER TABLE public.bridge_transfers
      ADD CONSTRAINT bridge_transfers_network_check
      CHECK (network IN ('mainnet', 'testnet'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bridge_stake_events_network_check'
  ) THEN
    ALTER TABLE public.bridge_stake_events
      ADD CONSTRAINT bridge_stake_events_network_check
      CHECK (network IN ('mainnet', 'testnet'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_bridge_transfers_network_created
  ON public.bridge_transfers (network, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_bridge_stake_events_network_created
  ON public.bridge_stake_events (network, created_at DESC);
