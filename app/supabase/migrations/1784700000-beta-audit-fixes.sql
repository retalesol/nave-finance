-- Beta audit: bind EVM key rows to the wallet that generated them, stop
-- anonymous reads of model transcripts, and hide proposal payloads for
-- private treasuries.

ALTER TABLE public.encrypted_evm_keys
  ADD COLUMN IF NOT EXISTS created_by_wallet text;

COMMENT ON COLUMN public.encrypted_evm_keys.created_by_wallet IS
  'Wallet that signed the keygen challenge. Bind refuses a different founder.';

-- Column privilege: table SELECT stays for the public columns the app lists.
-- raw_claude_response is not in that list. Revoke it from the browser roles.
REVOKE SELECT (raw_claude_response) ON TABLE public.agent_action_logs FROM anon, authenticated;

DROP POLICY IF EXISTS "Public read hidden assets" ON public.dao_hidden_assets;
CREATE POLICY "Public read hidden assets"
  ON public.dao_hidden_assets
  FOR SELECT TO anon, authenticated
  USING (
    NOT EXISTS (
      SELECT 1
      FROM public.dao_registry d
      WHERE d.dao_onchain_address = dao_hidden_assets.dao_onchain_address
        AND d.privacy_enabled IS TRUE
    )
  );

DROP POLICY IF EXISTS "Public read evm proposal payloads" ON public.evm_proposal_payloads;
CREATE POLICY "Public read evm proposal payloads"
  ON public.evm_proposal_payloads
  FOR SELECT TO anon, authenticated
  USING (
    NOT EXISTS (
      SELECT 1
      FROM public.dao_registry d
      WHERE lower(d.dao_onchain_address) = lower(evm_proposal_payloads.dao_address)
        AND d.privacy_enabled IS TRUE
    )
  );
