/*
  # Create encrypted_evm_keys table (secp256k1 agent + guardian keys)

  EVM counterpart to encrypted_agent_keys. Keeps EVM secp256k1 secrets fully
  DISTINCT from the Solana Ed25519 keys (separate table, optionally a separate
  master KEK via NAVE_EVM_MASTER_KEK) per the multi-chain plan's "keep secrets
  distinct" requirement.

  Stores AES-256-GCM encrypted secp256k1 private keys for:
    - the 4 agent roles (executive | financial | oversight | operational), and
    - server-custodied guardian signers (M-of-N), keyed by guardian_index.

  The signer-service unwraps the per-key DEK with the master KEK at sign time and
  produces EIP-712 signatures (NaveExecution agent approvals + guardian
  approvals). The raw private key never leaves the signer process.

  Scope: Ethereum + Base only (chain_id ∈ {1, 8453, 11155111, 84532}).
  Append-only like encrypted_agent_keys: rotation inserts a new active row.
*/

CREATE TABLE IF NOT EXISTS encrypted_evm_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dao_onchain_address text NOT NULL,
  chain text NOT NULL CHECK (chain IN ('ethereum', 'base')),
  chain_id bigint NOT NULL CHECK (chain_id IN (1, 8453, 11155111, 84532)),
  signer_role text NOT NULL CHECK (
    signer_role IN ('executive', 'financial', 'oversight', 'operational', 'guardian')
  ),
  -- M-of-N slot for guardian signers; NULL for the single-instance agent roles.
  guardian_index integer,
  evm_address text NOT NULL, -- 0x... (lowercased), safe to expose
  encrypted_private_key text NOT NULL, -- AES-256-GCM ciphertext, base64
  encryption_iv text NOT NULL,
  encryption_tag text NOT NULL,
  -- Envelope encryption (DEK wrapped by the master KEK); nullable for legacy.
  wrapped_dek text,
  dek_wrap_iv text,
  dek_wrap_tag text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  rotated_at timestamptz,
  -- (chain, chain_id) must be a valid pairing.
  CONSTRAINT encrypted_evm_keys_chain_pair CHECK (
    (chain = 'ethereum' AND chain_id IN (1, 11155111))
    OR (chain = 'base' AND chain_id IN (8453, 84532))
  )
);

-- One active key per (dao, signer_role, guardian slot). COALESCE folds the NULL
-- guardian_index for agent roles into a single sentinel so the partial unique
-- index applies uniformly.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'encrypted_evm_keys' AND indexname = 'idx_evm_keys_dao_role_active'
  ) THEN
    CREATE UNIQUE INDEX idx_evm_keys_dao_role_active
      ON encrypted_evm_keys(dao_onchain_address, signer_role, COALESCE(guardian_index, -1))
      WHERE is_active = true;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'encrypted_evm_keys' AND indexname = 'idx_evm_keys_dao'
  ) THEN
    CREATE INDEX idx_evm_keys_dao ON encrypted_evm_keys(dao_onchain_address);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'encrypted_evm_keys' AND indexname = 'idx_evm_keys_address'
  ) THEN
    CREATE INDEX idx_evm_keys_address ON encrypted_evm_keys(evm_address);
  END IF;
END $$;

-- Enable RLS (service_role only; no public/anon access — most sensitive table).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
    WHERE schemaname = 'public' AND tablename = 'encrypted_evm_keys' AND rowsecurity = true
  ) THEN
    ALTER TABLE encrypted_evm_keys ENABLE ROW LEVEL SECURITY;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'encrypted_evm_keys' AND policyname = 'Service role reads evm keys'
  ) THEN
    CREATE POLICY "Service role reads evm keys"
      ON encrypted_evm_keys FOR SELECT TO service_role USING (true);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'encrypted_evm_keys' AND policyname = 'Service role inserts evm keys'
  ) THEN
    CREATE POLICY "Service role inserts evm keys"
      ON encrypted_evm_keys FOR INSERT TO service_role WITH CHECK (true);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'encrypted_evm_keys' AND policyname = 'Service role updates evm keys'
  ) THEN
    CREATE POLICY "Service role updates evm keys"
      ON encrypted_evm_keys FOR UPDATE TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;

-- No DELETE policy — keys are deactivated (is_active = false), never deleted.
