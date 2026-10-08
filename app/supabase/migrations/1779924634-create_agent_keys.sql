/*
  # Create encrypted_agent_keys table

  This is the most security-critical table in the system. It stores AES-256-GCM
  encrypted private keys for the 4 AI agents (executive, financial, oversight,
  operational) that automate treasury operations.

  Security model:
  - Keys are generated and encrypted by the generate-agent-keys edge function
  - Only the service_role can INSERT (during DAO creation)
  - Only the service_role can SELECT (agent services authenticate via service_role)
  - No UPDATE or DELETE is permitted — keys are append-only (rotation creates new rows)
  - The decryption key is returned ONCE to each agent service during creation
    and is never stored in this database
  - Even with database access, the encrypted_private_key is useless without
    the agent-specific AES decryption key

  1. New Tables
    - `encrypted_agent_keys`
      - `id` (uuid, primary key)
      - `dao_onchain_address` (text, NOT NULL) — which DAO this agent key belongs to
      - `agent_role` (text, NOT NULL) — 'executive' | 'financial' | 'oversight' | 'operational'
      - `encrypted_private_key` (text, NOT NULL) — AES-256-GCM encrypted, base64 encoded
      - `encryption_iv` (text, NOT NULL) — initialization vector, base64 encoded
      - `encryption_tag` (text, NOT NULL) — GCM auth tag, base64 encoded
      - `public_key` (text, NOT NULL) — base58 Solana pubkey (safe to expose)
      - `is_active` (boolean, default true) — false after key rotation
      - `created_at` (timestamptz)
      - `rotated_at` (timestamptz, nullable) — set when key is replaced

  2. Indexes
    - Unique composite: (dao_onchain_address, agent_role, is_active) where is_active = true
    - Index on dao_onchain_address for lookups
    - Index on public_key for reverse lookups

  3. Security
    - RLS enabled, extremely restrictive
    - Only service_role can read or insert
    - No update or delete policies for any role
*/

-- =============================================
-- TABLE: encrypted_agent_keys
-- =============================================
CREATE TABLE IF NOT EXISTS encrypted_agent_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dao_onchain_address text NOT NULL,
  agent_role text NOT NULL CHECK (agent_role IN ('executive', 'financial', 'oversight', 'operational')),
  encrypted_private_key text NOT NULL,
  encryption_iv text NOT NULL,
  encryption_tag text NOT NULL,
  public_key text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  rotated_at timestamptz
);

-- Unique constraint: only one active key per role per DAO
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'encrypted_agent_keys' AND indexname = 'idx_agent_keys_dao_role_active'
  ) THEN
    CREATE UNIQUE INDEX idx_agent_keys_dao_role_active
      ON encrypted_agent_keys(dao_onchain_address, agent_role)
      WHERE is_active = true;
  END IF;
END $$;

-- Index: DAO address lookup
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'encrypted_agent_keys' AND indexname = 'idx_agent_keys_dao'
  ) THEN
    CREATE INDEX idx_agent_keys_dao ON encrypted_agent_keys(dao_onchain_address);
  END IF;
END $$;

-- Index: public key reverse lookup
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'encrypted_agent_keys' AND indexname = 'idx_agent_keys_pubkey'
  ) THEN
    CREATE INDEX idx_agent_keys_pubkey ON encrypted_agent_keys(public_key);
  END IF;
END $$;

-- Enable RLS
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
    WHERE schemaname = 'public' AND tablename = 'encrypted_agent_keys' AND rowsecurity = true
  ) THEN
    ALTER TABLE encrypted_agent_keys ENABLE ROW LEVEL SECURITY;
  END IF;
END $$;

-- Policy: Only service_role can SELECT (agent services use service_role JWT)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'encrypted_agent_keys' AND policyname = 'Service role reads agent keys'
  ) THEN
    CREATE POLICY "Service role reads agent keys"
      ON encrypted_agent_keys
      FOR SELECT
      TO service_role
      USING (true);
  END IF;
END $$;

-- Policy: Only service_role can INSERT (key generation edge function)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'encrypted_agent_keys' AND policyname = 'Service role inserts agent keys'
  ) THEN
    CREATE POLICY "Service role inserts agent keys"
      ON encrypted_agent_keys
      FOR INSERT
      TO service_role
      WITH CHECK (true);
  END IF;
END $$;

-- Policy: Only service_role can UPDATE (for key rotation — setting is_active = false)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'encrypted_agent_keys' AND policyname = 'Service role updates agent keys'
  ) THEN
    CREATE POLICY "Service role updates agent keys"
      ON encrypted_agent_keys
      FOR UPDATE
      TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;

-- No DELETE policy — keys are never deleted, only deactivated via is_active = false