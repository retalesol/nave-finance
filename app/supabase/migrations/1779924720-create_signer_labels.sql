/*
  # Create signer_labels table

  Stores human-readable labels for guardian wallets within a DAO.
  Labels are set by DAO guardians and are visible to all DAO members.

  1. New Tables
    - `signer_labels`
      - `id` (uuid, primary key)
      - `dao_onchain_address` (text, NOT NULL)
      - `wallet_address` (text, NOT NULL) — the guardian wallet being labeled
      - `label` (text, NOT NULL) — human-readable label, e.g. 'Lead Contributor'
      - `updated_at` (timestamptz)

  2. Indexes
    - Unique: (dao_onchain_address, wallet_address) — one label per wallet per DAO

  3. Security
    - RLS enabled
    - Public read for non-private DAOs
    - Service role write access (updates go through edge function with wallet verification)
*/

CREATE TABLE IF NOT EXISTS signer_labels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dao_onchain_address text NOT NULL,
  wallet_address text NOT NULL,
  label text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Unique: one label per wallet per DAO
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'signer_labels' AND indexname = 'idx_signer_labels_dao_wallet'
  ) THEN
    CREATE UNIQUE INDEX idx_signer_labels_dao_wallet ON signer_labels(dao_onchain_address, wallet_address);
  END IF;
END $$;

-- Enable RLS
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
    WHERE schemaname = 'public' AND tablename = 'signer_labels' AND rowsecurity = true
  ) THEN
    ALTER TABLE signer_labels ENABLE ROW LEVEL SECURITY;
  END IF;
END $$;

-- Policy: Public read for non-private DAO labels
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'signer_labels' AND policyname = 'Public read signer labels'
  ) THEN
    CREATE POLICY "Public read signer labels"
      ON signer_labels
      FOR SELECT
      TO anon, authenticated
      USING (
        EXISTS (
          SELECT 1 FROM dao_registry
          WHERE dao_registry.dao_onchain_address = signer_labels.dao_onchain_address
            AND dao_registry.privacy_enabled = false
        )
      );
  END IF;
END $$;

-- Policy: Service role full access
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'signer_labels' AND policyname = 'Service role manages signer labels'
  ) THEN
    CREATE POLICY "Service role manages signer labels"
      ON signer_labels
      FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;