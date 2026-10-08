/*
  # DAO privacy access controls

  1. Add `voting_token_mint` to `dao_registry` so token-governed privacy checks
     can validate holder access without brittle on-chain decoding in SQL.
  2. Add `dao_authorized_wallets` for wallet-governed private DAO membership.
*/

ALTER TABLE public.dao_registry
  ADD COLUMN IF NOT EXISTS voting_token_mint text;

CREATE TABLE IF NOT EXISTS public.dao_authorized_wallets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dao_onchain_address text NOT NULL,
  wallet_address text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_dao_authorized_wallets_unique
  ON public.dao_authorized_wallets (dao_onchain_address, wallet_address);

CREATE INDEX IF NOT EXISTS idx_dao_authorized_wallets_dao
  ON public.dao_authorized_wallets (dao_onchain_address);

ALTER TABLE public.dao_authorized_wallets ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'dao_authorized_wallets' AND policyname = 'Service role manages dao authorized wallets'
  ) THEN
    CREATE POLICY "Service role manages dao authorized wallets"
      ON public.dao_authorized_wallets
      FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;
