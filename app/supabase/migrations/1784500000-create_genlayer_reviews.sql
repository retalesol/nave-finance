/*
  # Shared GenLayer reviews

  One row shape for Solana, Ethereum, Base, and Robinhood. Keyed by chain
  family, network, treasury, and action hash so the proposal card and the
  treasury page read the same columns. The adjudicator writes the case id and
  the contract's small result. It does not store an assistant paragraph.

  This is its own table, not a column on rebalance_recommendations: a
  recommendation proof is per policy run, while a review is per chain family
  and treasury and has to stay readable after that run is superseded.

  1. New table `genlayer_reviews`
  2. RLS: public read for non-private DAOs; service_role writes.
*/

CREATE TABLE IF NOT EXISTS public.genlayer_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chain_family text NOT NULL CHECK (chain_family IN ('solana', 'ethereum', 'base', 'robinhood')),
  network text NOT NULL CHECK (network IN ('mainnet', 'testnet', 'devnet')),
  treasury text NOT NULL,
  action_hash text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('charter', 'venue', 'halt')),
  decision text NOT NULL DEFAULT '',
  customer_status text NOT NULL DEFAULT 'still_checking'
    CHECK (customer_status IN ('checked', 'needs_closer_look', 'still_checking')),
  finished boolean NOT NULL DEFAULT false,
  provisional boolean NOT NULL DEFAULT false,
  rule_ids text[] NOT NULL DEFAULT '{}',
  summary text NOT NULL DEFAULT '',
  venue_status text CHECK (venue_status IS NULL OR venue_status IN ('fine', 'watch', 'stop')),
  tx_id text NOT NULL DEFAULT '',
  case_id text NOT NULL DEFAULT '',
  appeal_requested boolean NOT NULL DEFAULT false,
  public_inputs jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_genlayer_reviews_treasury
  ON public.genlayer_reviews (chain_family, network, treasury, updated_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_genlayer_reviews_case
  ON public.genlayer_reviews (chain_family, network, treasury, action_hash, kind);

ALTER TABLE public.genlayer_reviews ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'genlayer_reviews' AND policyname = 'Public read genlayer reviews'
  ) THEN
    CREATE POLICY "Public read genlayer reviews"
      ON public.genlayer_reviews
      FOR SELECT
      TO anon, authenticated
      USING (
        EXISTS (
          SELECT 1 FROM dao_registry
          WHERE dao_registry.dao_onchain_address = genlayer_reviews.treasury
            AND dao_registry.privacy_enabled = false
        )
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'genlayer_reviews' AND policyname = 'Service role manages genlayer reviews'
  ) THEN
    CREATE POLICY "Service role manages genlayer reviews"
      ON public.genlayer_reviews
      FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;
