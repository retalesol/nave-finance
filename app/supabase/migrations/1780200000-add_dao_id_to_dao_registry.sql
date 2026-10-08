/*
  # Add dao_id to dao_registry

  The on-chain `DaoInitialized` event carries the DAO's numeric `dao_id`
  (the per-founder index used to derive the DAO registry PDA). Storing it
  lets the frontend derive the correct on-chain PDA instead of defaulting to
  0, and lets the indexer/register-dao functions keep the canonical id.

  1. Changes
    - `dao_registry.dao_id` (bigint, nullable) — on-chain DAO index
  2. Indexes
    - `idx_dao_registry_dao_id` for lookups by id
*/

ALTER TABLE dao_registry
  ADD COLUMN IF NOT EXISTS dao_id bigint;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'dao_registry' AND indexname = 'idx_dao_registry_dao_id'
  ) THEN
    CREATE INDEX idx_dao_registry_dao_id ON dao_registry(dao_id);
  END IF;
END $$;
