/*
  # Create dao_registry and watched_daos tables

  1. New Tables
    - `dao_registry` — Off-chain metadata companion to the on-chain DaoRegistry account
      - `id` (uuid, primary key)
      - `dao_onchain_address` (text, unique, NOT NULL) — base58 Solana pubkey
      - `name` (text, NOT NULL) — DAO display name
      - `description` (text) — optional description
      - `logo_url` (text) — optional logo image URL
      - `governance_type` (text, NOT NULL) — 'wallet' or 'token'
      - `privacy_enabled` (boolean, default false)
      - `creator_wallet` (text, NOT NULL) — base58 pubkey of the wallet that created the DAO
      - `social_twitter` (text) — optional twitter handle
      - `social_discord` (text) — optional discord invite
      - `social_website` (text) — optional website URL
      - `created_at` (timestamptz, default now())
      - `updated_at` (timestamptz, default now())

    - `watched_daos` — Tracks which DAOs a wallet is watching/has joined
      - `id` (uuid, primary key)
      - `wallet_address` (text, NOT NULL) — the watcher's base58 pubkey
      - `dao_onchain_address` (text, NOT NULL) — the DAO they are watching
      - `label` (text) — optional user-defined label
      - `added_at` (timestamptz, default now())

  2. Indexes
    - `dao_registry.dao_onchain_address` — unique lookup
    - `dao_registry.creator_wallet` — filter by creator
    - `watched_daos.(wallet_address, dao_onchain_address)` — unique composite, prevent duplicates
    - `watched_daos.wallet_address` — filter by wallet

  3. Security
    - RLS enabled on both tables
    - dao_registry: public SELECT for non-private DAOs, creator can INSERT/UPDATE
    - watched_daos: users can only manage their own rows (matched by wallet_address header)
*/

-- =============================================
-- TABLE: dao_registry
-- =============================================
CREATE TABLE IF NOT EXISTS dao_registry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dao_onchain_address text UNIQUE NOT NULL,
  name text NOT NULL DEFAULT '',
  description text DEFAULT '',
  logo_url text DEFAULT '',
  governance_type text NOT NULL DEFAULT 'wallet',
  privacy_enabled boolean NOT NULL DEFAULT false,
  creator_wallet text NOT NULL,
  social_twitter text DEFAULT '',
  social_discord text DEFAULT '',
  social_website text DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Index: creator wallet lookup
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'dao_registry' AND indexname = 'idx_dao_registry_creator_wallet'
  ) THEN
    CREATE INDEX idx_dao_registry_creator_wallet ON dao_registry(creator_wallet);
  END IF;
END $$;

-- Enable RLS
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
    WHERE schemaname = 'public' AND tablename = 'dao_registry' AND rowsecurity = true
  ) THEN
    ALTER TABLE dao_registry ENABLE ROW LEVEL SECURITY;
  END IF;
END $$;

-- Policy: Anyone can read non-private DAOs (anon + authenticated)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'dao_registry' AND policyname = 'Public DAOs are readable by anyone'
  ) THEN
    CREATE POLICY "Public DAOs are readable by anyone"
      ON dao_registry
      FOR SELECT
      TO anon, authenticated
      USING (privacy_enabled = false);
  END IF;
END $$;

-- Policy: Service role can read all DAOs (needed for edge functions)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'dao_registry' AND policyname = 'Service role reads all DAOs'
  ) THEN
    CREATE POLICY "Service role reads all DAOs"
      ON dao_registry
      FOR SELECT
      TO service_role
      USING (true);
  END IF;
END $$;

-- Policy: Service role can insert DAOs (edge function creates during DAO init)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'dao_registry' AND policyname = 'Service role can insert DAOs'
  ) THEN
    CREATE POLICY "Service role can insert DAOs"
      ON dao_registry
      FOR INSERT
      TO service_role
      WITH CHECK (true);
  END IF;
END $$;

-- Policy: Service role can update DAOs
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'dao_registry' AND policyname = 'Service role can update DAOs'
  ) THEN
    CREATE POLICY "Service role can update DAOs"
      ON dao_registry
      FOR UPDATE
      TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;

-- =============================================
-- TABLE: watched_daos
-- =============================================
CREATE TABLE IF NOT EXISTS watched_daos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_address text NOT NULL,
  dao_onchain_address text NOT NULL,
  label text DEFAULT '',
  added_at timestamptz NOT NULL DEFAULT now()
);

-- Unique constraint: one watch record per wallet+dao pair
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'watched_daos' AND indexname = 'idx_watched_daos_wallet_dao_unique'
  ) THEN
    CREATE UNIQUE INDEX idx_watched_daos_wallet_dao_unique ON watched_daos(wallet_address, dao_onchain_address);
  END IF;
END $$;

-- Index: wallet address lookup
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'watched_daos' AND indexname = 'idx_watched_daos_wallet'
  ) THEN
    CREATE INDEX idx_watched_daos_wallet ON watched_daos(wallet_address);
  END IF;
END $$;

-- Enable RLS
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
    WHERE schemaname = 'public' AND tablename = 'watched_daos' AND rowsecurity = true
  ) THEN
    ALTER TABLE watched_daos ENABLE ROW LEVEL SECURITY;
  END IF;
END $$;

-- Policy: Users can read their own watched DAOs via x-wallet-address header
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'watched_daos' AND policyname = 'Users read own watched DAOs'
  ) THEN
    CREATE POLICY "Users read own watched DAOs"
      ON watched_daos
      FOR SELECT
      TO anon, authenticated
      USING (wallet_address = current_setting('request.headers', true)::json->>'x-wallet-address');
  END IF;
END $$;

-- Policy: Users can insert their own watched DAOs
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'watched_daos' AND policyname = 'Users insert own watched DAOs'
  ) THEN
    CREATE POLICY "Users insert own watched DAOs"
      ON watched_daos
      FOR INSERT
      TO anon, authenticated
      WITH CHECK (wallet_address = current_setting('request.headers', true)::json->>'x-wallet-address');
  END IF;
END $$;

-- Policy: Users can delete their own watched DAOs
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'watched_daos' AND policyname = 'Users delete own watched DAOs'
  ) THEN
    CREATE POLICY "Users delete own watched DAOs"
      ON watched_daos
      FOR DELETE
      TO anon, authenticated
      USING (wallet_address = current_setting('request.headers', true)::json->>'x-wallet-address');
  END IF;
END $$;

-- Policy: Service role full access on watched_daos
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'watched_daos' AND policyname = 'Service role manages watched DAOs'
  ) THEN
    CREATE POLICY "Service role manages watched DAOs"
      ON watched_daos
      FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;