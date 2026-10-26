-- Same-address treasuries share one 0x address across EVM chains. Agent keys
-- are wrapped per chain, so the active-key uniqueness has to include chain_id.
DROP INDEX IF EXISTS public.idx_evm_keys_dao_role_active;

CREATE UNIQUE INDEX idx_evm_keys_dao_role_active
  ON public.encrypted_evm_keys (
    dao_onchain_address,
    chain_id,
    signer_role,
    COALESCE(guardian_index, -1)
  )
  WHERE is_active = true;
