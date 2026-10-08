/*
  # Create nave_price_attestations

  Persists the canonical NAVE/USD creation-price snapshots produced by the
  `nave-price-oracle` edge function. Each row is a tamper-evident attestation
  (SHA-256 payload hash + optional HMAC-SHA256 signature) of the price and the
  derived stake amounts, so a DAO creation can later PROVE which price/amount the
  protocol issued for its $99 NAVE stake.

  1. New Table — `nave_price_attestations`
     - identity + cluster: `id`, `network`, `nave_mint`
     - pricing: `price_usd`, `stake_usd`, `nave_decimals`, `source`
     - derived stake amounts (u64 base units stored as numeric/text):
       `required_nave_base_units`, `min_nave_base_units`, `quote_tolerance_bps`
     - provenance: `sample_count`, `samples` (jsonb), `payload` (jsonb)
     - attestation: `payload_hash`, `signature`, `signed`, `algorithm`
     - validity: `issued_at`, `expires_at`, `created_at`
  2. Security
     - RLS enabled. Service role (edge function) has full access. Anon/auth get
       READ-ONLY access: attestations are public price data and must be
       independently verifiable by clients proving a stake amount.
*/

CREATE TABLE IF NOT EXISTS nave_price_attestations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  network text NOT NULL,
  nave_mint text NOT NULL,
  price_usd numeric NOT NULL,
  stake_usd numeric NOT NULL,
  nave_decimals integer NOT NULL DEFAULT 6,
  source text NOT NULL,
  required_nave_base_units numeric NOT NULL,
  min_nave_base_units numeric NOT NULL,
  quote_tolerance_bps integer NOT NULL DEFAULT 0,
  sample_count integer NOT NULL DEFAULT 0,
  samples jsonb NOT NULL DEFAULT '[]'::jsonb,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  payload_hash text NOT NULL,
  signature text,
  signed boolean NOT NULL DEFAULT false,
  algorithm text NOT NULL DEFAULT 'HMAC-SHA256',
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_nave_price_attestations_issued_at
  ON nave_price_attestations (issued_at DESC);
CREATE INDEX IF NOT EXISTS idx_nave_price_attestations_network_issued_at
  ON nave_price_attestations (network, issued_at DESC);
CREATE INDEX IF NOT EXISTS idx_nave_price_attestations_payload_hash
  ON nave_price_attestations (payload_hash);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
    WHERE schemaname = 'public' AND tablename = 'nave_price_attestations' AND rowsecurity = true
  ) THEN
    ALTER TABLE nave_price_attestations ENABLE ROW LEVEL SECURITY;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'nave_price_attestations'
      AND policyname = 'Service role manages price attestations'
  ) THEN
    CREATE POLICY "Service role manages price attestations"
      ON nave_price_attestations
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
    WHERE schemaname = 'public' AND tablename = 'nave_price_attestations'
      AND policyname = 'Public can read price attestations'
  ) THEN
    CREATE POLICY "Public can read price attestations"
      ON nave_price_attestations
      FOR SELECT
      TO anon, authenticated
      USING (true);
  END IF;
END $$;
