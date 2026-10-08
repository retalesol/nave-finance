/*
  # Create faucet_claims table

  Audit log for the NAVE devnet faucet (signer-service `/faucet-claim`).
  Every successful claim is recorded here for ops visibility (total claimed,
  abuse investigation). This table is NOT the rate-limiting mechanism itself —
  the dual per-address + per-IP cooldown is enforced by the signer-service's
  existing distributed rate limiter (Upstash Redis / in-memory fixed-window
  counters), the same mechanism every other public endpoint uses. This table
  is a secondary, persistent audit trail only.

  Security:
    - RLS enabled. The signer-service uses the service-role key (bypasses RLS)
      for the only write path. There is NO public read or write policy — this
      is an internal ops/audit table, not a public bridge-transfers-style feed.
*/

CREATE TABLE IF NOT EXISTS public.faucet_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient text NOT NULL,
  amount_raw numeric NOT NULL,
  signature text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_faucet_claims_recipient
  ON public.faucet_claims (recipient);
CREATE INDEX IF NOT EXISTS idx_faucet_claims_created_at
  ON public.faucet_claims (created_at);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
    WHERE schemaname = 'public' AND tablename = 'faucet_claims' AND rowsecurity = true
  ) THEN
    ALTER TABLE public.faucet_claims ENABLE ROW LEVEL SECURITY;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'faucet_claims'
      AND policyname = 'Service role manages faucet claims'
  ) THEN
    CREATE POLICY "Service role manages faucet claims"
      ON public.faucet_claims
      FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;
