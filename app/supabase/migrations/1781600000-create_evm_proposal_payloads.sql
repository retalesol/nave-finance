/*
  # EVM proposal payload index

  The EVM NaveGovernor stores only `keccak256(payload)` on-chain (the
  `ProposalCreated` event emits the hash, never the preimage). Ratifying a
  token-mint / constitution proposal or queuing an execution request requires
  the ORIGINAL payload bytes. Previously the creator's browser kept the payload
  in localStorage, so any other device (or a cleared cache) dead-ended with
  "no locally indexed payload".

  This table is the server-side payload index: the creator writes the payload
  here at proposal-creation time, and any device recovers it later. Multiple
  candidate rows per proposal are allowed — the client ALWAYS verifies
  keccak256(payload) against the authoritative on-chain payloadHash before use,
  so a malicious/garbage row can never cause an incorrect on-chain action (it
  simply fails verification and is ignored). That same verification is why
  public INSERT is safe.

  Forward-only and idempotent.
*/

CREATE TABLE IF NOT EXISTS public.evm_proposal_payloads (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chain_id        integer NOT NULL,
  dao_address     text NOT NULL,
  proposal_index  bigint NOT NULL,
  proposal_type   text NOT NULL,
  payload_hex     text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS evm_proposal_payloads_lookup_idx
  ON public.evm_proposal_payloads (chain_id, lower(dao_address), proposal_index);

ALTER TABLE public.evm_proposal_payloads ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  -- Public read: payloads are preimages of on-chain-public hashes.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'evm_proposal_payloads'
      AND policyname = 'Public read evm proposal payloads'
  ) THEN
    CREATE POLICY "Public read evm proposal payloads"
      ON public.evm_proposal_payloads
      FOR SELECT TO anon, authenticated
      USING (true);
  END IF;

  -- Public insert: safe because the client verifies keccak256(payload) against
  -- the on-chain payloadHash before ever submitting an action. No UPDATE/DELETE
  -- for anon, so a stored (correct) payload cannot be overwritten/removed.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'evm_proposal_payloads'
      AND policyname = 'Public insert evm proposal payloads'
  ) THEN
    CREATE POLICY "Public insert evm proposal payloads"
      ON public.evm_proposal_payloads
      FOR INSERT TO anon, authenticated
      WITH CHECK (true);
  END IF;

  -- Service role full access (edge functions / indexers).
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'evm_proposal_payloads'
      AND policyname = 'Service role manages evm proposal payloads'
  ) THEN
    CREATE POLICY "Service role manages evm proposal payloads"
      ON public.evm_proposal_payloads
      FOR ALL TO service_role
      USING (true) WITH CHECK (true);
  END IF;
END $$;
