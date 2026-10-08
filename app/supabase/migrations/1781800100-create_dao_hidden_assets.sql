/*
  # Create dao_hidden_assets (treasury spam/visibility filter)

  Per-DAO, server-side set of treasury assets the DAO has chosen to hide from the
  default Assets view (airdrop spam, dust, etc.). Stored per-DAO (not per-wallet)
  so collaborators share the same curated view.

  1. New Table
    - `dao_hidden_assets`
      - `dao_onchain_address` — the DAO (Solana base58 or EVM 0x…)
      - `chain` — 'solana' | 'ethereum' | 'base'
      - `asset_identifier` — mint (Solana) / token contract or 'ETH' (EVM)
      - `hidden_by_wallet` — the wallet that hid it (audit)
      - `hidden_at` — timestamp
    - UNIQUE (dao_onchain_address, chain, asset_identifier)
  2. Security (RLS)
    - Public SELECT so every collaborator sees the same hidden set.
    - INSERT/DELETE gated to the DAO's creator (founder) via the soft
      `x-wallet-address` header matching dao_registry.creator_wallet — mirrors the
      existing creator-gated write pattern. (Service role bypasses RLS.)
*/

CREATE TABLE IF NOT EXISTS public.dao_hidden_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dao_onchain_address text NOT NULL,
  chain text NOT NULL DEFAULT 'solana',
  asset_identifier text NOT NULL,
  hidden_by_wallet text NOT NULL DEFAULT '',
  hidden_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'dao_hidden_assets'
      AND indexname = 'uq_dao_hidden_assets'
  ) THEN
    CREATE UNIQUE INDEX uq_dao_hidden_assets
      ON public.dao_hidden_assets (dao_onchain_address, chain, asset_identifier);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'dao_hidden_assets'
      AND indexname = 'idx_dao_hidden_assets_dao'
  ) THEN
    CREATE INDEX idx_dao_hidden_assets_dao
      ON public.dao_hidden_assets (dao_onchain_address);
  END IF;
END $$;

ALTER TABLE public.dao_hidden_assets ENABLE ROW LEVEL SECURITY;

-- Public read: the hidden set is shared per-DAO.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'dao_hidden_assets'
      AND policyname = 'Public read hidden assets'
  ) THEN
    CREATE POLICY "Public read hidden assets"
      ON public.dao_hidden_assets
      FOR SELECT
      TO anon, authenticated
      USING (true);
  END IF;
END $$;

-- Founder-gated insert: x-wallet-address must match the DAO creator.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'dao_hidden_assets'
      AND policyname = 'Founder hides assets'
  ) THEN
    CREATE POLICY "Founder hides assets"
      ON public.dao_hidden_assets
      FOR INSERT
      TO anon, authenticated
      WITH CHECK (
        EXISTS (
          SELECT 1 FROM public.dao_registry r
          WHERE r.dao_onchain_address = dao_hidden_assets.dao_onchain_address
            AND r.creator_wallet = current_setting('request.headers', true)::json->>'x-wallet-address'
        )
      );
  END IF;
END $$;

-- Founder-gated unhide (delete).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'dao_hidden_assets'
      AND policyname = 'Founder unhides assets'
  ) THEN
    CREATE POLICY "Founder unhides assets"
      ON public.dao_hidden_assets
      FOR DELETE
      TO anon, authenticated
      USING (
        EXISTS (
          SELECT 1 FROM public.dao_registry r
          WHERE r.dao_onchain_address = dao_hidden_assets.dao_onchain_address
            AND r.creator_wallet = current_setting('request.headers', true)::json->>'x-wallet-address'
        )
      );
  END IF;
END $$;
