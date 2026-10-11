/*
  # Bind wrapped DEKs to their row (dao | role | chain) and record the KEK

  dek_wrap_version
    1 = legacy: DEK wrapped under the chain family's master KEK, no associated data.
    2 = DEK wrapped with AES-GCM associated data `nave-dek:v2|<dao>|<role>|<chain>`,
        so a wrapped DEK copied onto another DAO's, role's or chain's row cannot
        be unwrapped.

  dek_kek_ref
    'master' = the chain family's master KEK (NAVE_MASTER_KEK / NAVE_EVM_MASTER_KEK).
    'role'   = the per-role KEK (NAVE_KEK_<ROLE> / NAVE_EVM_KEK_<ROLE>).

  Existing rows stay version 1 until `scripts/rewrap-role-keks.mjs` re-wraps them.
*/

ALTER TABLE encrypted_agent_keys
  ADD COLUMN IF NOT EXISTS dek_wrap_version smallint NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS dek_kek_ref text;

ALTER TABLE encrypted_evm_keys
  ADD COLUMN IF NOT EXISTS dek_wrap_version smallint NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS dek_kek_ref text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'encrypted_agent_keys_dek_envelope_chk'
  ) THEN
    ALTER TABLE encrypted_agent_keys ADD CONSTRAINT encrypted_agent_keys_dek_envelope_chk CHECK (
      (dek_wrap_version = 1)
      OR (dek_wrap_version = 2 AND dek_kek_ref IN ('master', 'role'))
    );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'encrypted_evm_keys_dek_envelope_chk'
  ) THEN
    ALTER TABLE encrypted_evm_keys ADD CONSTRAINT encrypted_evm_keys_dek_envelope_chk CHECK (
      (dek_wrap_version = 1)
      OR (dek_wrap_version = 2 AND dek_kek_ref IN ('master', 'role'))
    );
  END IF;
END $$;
