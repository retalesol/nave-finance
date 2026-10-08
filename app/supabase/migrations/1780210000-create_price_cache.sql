/*
  # Create price_cache

  CoinGecko's public price endpoint is rate-limited. snapshot-treasury caches
  the last good SOL/USD price here and falls back to it when a live fetch fails,
  so a transient price-API failure never produces a $0 treasury valuation.

  1. New Table
    - `price_cache`
      - `symbol` (text, primary key) — e.g. 'solana'
      - `price_usd` (numeric, NOT NULL)
      - `updated_at` (timestamptz, default now())
  2. Security
    - RLS enabled; only service_role (edge functions) reads/writes.
*/

CREATE TABLE IF NOT EXISTS price_cache (
  symbol text PRIMARY KEY,
  price_usd numeric NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
    WHERE schemaname = 'public' AND tablename = 'price_cache' AND rowsecurity = true
  ) THEN
    ALTER TABLE price_cache ENABLE ROW LEVEL SECURITY;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'price_cache' AND policyname = 'Service role manages price cache'
  ) THEN
    CREATE POLICY "Service role manages price cache"
      ON price_cache
      FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;
