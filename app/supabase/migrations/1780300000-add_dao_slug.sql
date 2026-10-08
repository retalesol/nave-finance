/*
  # Add unique DAO slug for human-readable names (e.g. nave → nave.dao / /dao/nave)

  - `slug` — lowercase identifier, unique across public DAO registry rows
  - Indexed for join-by-name lookups from the lobby and short links
*/

ALTER TABLE dao_registry
  ADD COLUMN IF NOT EXISTS slug text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'dao_registry' AND indexname = 'idx_dao_registry_slug_unique'
  ) THEN
    CREATE UNIQUE INDEX idx_dao_registry_slug_unique ON dao_registry(slug) WHERE slug IS NOT NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'dao_registry' AND indexname = 'idx_dao_registry_slug'
  ) THEN
    CREATE INDEX idx_dao_registry_slug ON dao_registry(slug);
  END IF;
END $$;
