/*
  # Create bridge_transfers table

  Records every cross-chain NAVE token bridge transfer handled by the
  trusted-relayer MVP in signer-service (/bridge-relay). NAVE is a Solana SPL
  token (home chain); a wrapped ERC-20 ("WrappedNave") lives on each EVM testnet
  (Sepolia 11155111 / Base Sepolia 84532).

    • solana_to_evm (lock): user transfers NAVE into the Solana custody account;
      the relayer mints WrappedNave on the destination EVM chain (minus a 2% fee
      to the EVM fee wallet).
    • evm_to_solana (burn): user burns WrappedNave on EVM; the relayer releases
      NAVE from custody to the user (minus a 2% fee to the Solana fee wallet).

  `source_tx` is UNIQUE so a replay of the same lock/burn is idempotent — the
  relayer returns the existing row instead of minting/releasing twice.

  Security:
    - RLS enabled. The signer-service uses the service-role key (bypasses RLS)
      for all writes. Anon/authenticated get READ-ONLY access (public bridge
      history); there is NO insert/update policy for anon, so the public can
      never forge or mutate a transfer record.

  Note: there is no shared updated_at trigger convention in this repo, so
  `updated_at` is maintained explicitly by the signer-service on each write.
*/

CREATE TABLE IF NOT EXISTS public.bridge_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  direction text NOT NULL,
  source_chain text NOT NULL,
  dest_chain text NOT NULL,
  source_tx text NOT NULL UNIQUE,
  dest_tx text,
  sender text,
  recipient text NOT NULL,
  amount_raw numeric NOT NULL,
  fee_raw numeric,
  net_raw numeric,
  status text NOT NULL DEFAULT 'pending',
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bridge_transfers_recipient
  ON public.bridge_transfers (recipient);
CREATE INDEX IF NOT EXISTS idx_bridge_transfers_status
  ON public.bridge_transfers (status);

-- Enable RLS (service-role writes via the signer-service; anon read-only).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
    WHERE schemaname = 'public' AND tablename = 'bridge_transfers' AND rowsecurity = true
  ) THEN
    ALTER TABLE public.bridge_transfers ENABLE ROW LEVEL SECURITY;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'bridge_transfers'
      AND policyname = 'Service role manages bridge transfers'
  ) THEN
    CREATE POLICY "Service role manages bridge transfers"
      ON public.bridge_transfers
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
    WHERE schemaname = 'public' AND tablename = 'bridge_transfers'
      AND policyname = 'Public can read bridge transfers'
  ) THEN
    CREATE POLICY "Public can read bridge transfers"
      ON public.bridge_transfers
      FOR SELECT
      TO anon, authenticated
      USING (true);
  END IF;
END $$;
