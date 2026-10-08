/*
  # Add wrapped DEK columns to encrypted_agent_keys (envelope encryption)

  Replaces the unscalable "four global env AES keys" model. Each agent private
  key remains encrypted under a per-DAO/per-role data key (DEK). The DEK itself
  is now wrapped under a single master key-encryption-key (NAVE_MASTER_KEK) and
  persisted here, so servers (dispatcher, signer) can unwrap it on demand using
  the KEK held only in their runtime env / KMS — instead of operators copying a
  raw decrypt key into shared env vars that cannot differ per DAO.

  The raw DEK is never stored; only its ciphertext (wrapped_dek) + IV + GCM tag.
  Without the master KEK the wrapped DEK is useless, preserving defense in depth.

  Columns are nullable so historical rows (created before envelope encryption)
  remain valid; those rows must still be served with an explicit decrypt key
  until rotated.
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'encrypted_agent_keys' AND column_name = 'wrapped_dek'
  ) THEN
    ALTER TABLE encrypted_agent_keys ADD COLUMN wrapped_dek text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'encrypted_agent_keys' AND column_name = 'dek_wrap_iv'
  ) THEN
    ALTER TABLE encrypted_agent_keys ADD COLUMN dek_wrap_iv text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'encrypted_agent_keys' AND column_name = 'dek_wrap_tag'
  ) THEN
    ALTER TABLE encrypted_agent_keys ADD COLUMN dek_wrap_tag text;
  END IF;
END $$;
