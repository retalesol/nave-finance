-- Replay protection for the founder-signed orchestrator-proxy challenge.
-- Each verified challenge signature may be used at most once. The proxy inserts
-- the signature here after verifying it; a unique-violation means the challenge
-- was already consumed (replay) and the request is rejected.
CREATE TABLE IF NOT EXISTS public.dispatch_nonces (
  signature text PRIMARY KEY,
  dao_onchain_address text NOT NULL,
  wallet text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS dispatch_nonces_created_at_idx
  ON public.dispatch_nonces (created_at);

-- Service-role only: this table is written exclusively by the edge function
-- using the service-role key. Enable RLS with no public policies (default-deny).
ALTER TABLE public.dispatch_nonces ENABLE ROW LEVEL SECURITY;
