-- Treasury groups: one name can exist once per chain.
-- Deployments are unique on (chain_id, dao_onchain_address).
-- One slug belongs to one treasury_group_id, shared by every chain of that name.
-- Idempotent.

ALTER TABLE public.dao_registry
  ADD COLUMN IF NOT EXISTS treasury_group_id uuid;

UPDATE public.dao_registry
SET treasury_group_id = gen_random_uuid()
WHERE treasury_group_id IS NULL;

ALTER TABLE public.dao_registry
  ALTER COLUMN treasury_group_id SET DEFAULT gen_random_uuid();

ALTER TABLE public.dao_registry
  ALTER COLUMN treasury_group_id SET NOT NULL;

-- Collapse checksum / mixed-case duplicates before lowercasing the survivor.
DELETE FROM public.watched_daos AS extra
USING public.watched_daos AS keep
WHERE extra.id > keep.id
  AND extra.wallet_address ~* '^0x[0-9a-f]{40}$'
  AND lower(extra.wallet_address) = lower(keep.wallet_address)
  AND extra.dao_onchain_address = keep.dao_onchain_address;

UPDATE public.watched_daos
SET wallet_address = lower(wallet_address)
WHERE wallet_address ~* '^0x[0-9a-f]{40}$'
  AND wallet_address <> lower(wallet_address);

UPDATE public.dao_registry
SET creator_wallet = lower(creator_wallet)
WHERE creator_wallet ~* '^0x[0-9a-f]{40}$'
  AND creator_wallet <> lower(creator_wallet);

UPDATE public.dao_registry AS row
SET dao_onchain_address = lower(row.dao_onchain_address)
WHERE row.dao_onchain_address ~* '^0x[0-9a-f]{40}$'
  AND row.dao_onchain_address <> lower(row.dao_onchain_address)
  AND NOT EXISTS (
    SELECT 1
    FROM public.dao_registry AS other
    WHERE other.id <> row.id
      AND other.dao_onchain_address = lower(row.dao_onchain_address)
  );

-- Drop the global address unique constraint (name varies slightly across environments).
DO $$
DECLARE
  constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT con.conname
    FROM pg_constraint AS con
    WHERE con.conrelid = 'public.dao_registry'::regclass
      AND con.contype = 'u'
      AND pg_get_constraintdef(con.oid) ILIKE '%dao_onchain_address%'
      AND pg_get_constraintdef(con.oid) NOT ILIKE '%chain_id%'
  LOOP
    EXECUTE format('ALTER TABLE public.dao_registry DROP CONSTRAINT IF EXISTS %I', constraint_name);
  END LOOP;
END $$;

DROP INDEX IF EXISTS public.idx_dao_registry_slug_unique;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'dao_registry_chain_address_unique'
      AND conrelid = 'public.dao_registry'::regclass
  ) THEN
    ALTER TABLE public.dao_registry
      ADD CONSTRAINT dao_registry_chain_address_unique
      UNIQUE NULLS NOT DISTINCT (chain_id, dao_onchain_address);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_dao_registry_treasury_group
  ON public.dao_registry (treasury_group_id);

CREATE INDEX IF NOT EXISTS idx_dao_registry_slug
  ON public.dao_registry (slug);

CREATE OR REPLACE FUNCTION public.dao_registry_enforce_slug_group()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  other_group uuid;
BEGIN
  IF NEW.slug IS NULL OR btrim(NEW.slug) = '' THEN
    RETURN NEW;
  END IF;
  SELECT treasury_group_id
    INTO other_group
  FROM public.dao_registry
  WHERE slug = NEW.slug
    AND treasury_group_id IS DISTINCT FROM NEW.treasury_group_id
    AND id IS DISTINCT FROM NEW.id
  LIMIT 1;
  IF other_group IS NOT NULL THEN
    RAISE EXCEPTION 'slug already belongs to another treasury group'
      USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS dao_registry_slug_group ON public.dao_registry;
CREATE TRIGGER dao_registry_slug_group
  BEFORE INSERT OR UPDATE OF slug, treasury_group_id
  ON public.dao_registry
  FOR EACH ROW
  EXECUTE FUNCTION public.dao_registry_enforce_slug_group();

CREATE OR REPLACE FUNCTION public.nave_wallet_header_matches(stored text)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT
    stored IS NOT NULL
    AND (
      stored = NULLIF(current_setting('request.headers', true)::json->>'x-wallet-address', '')
      OR (
        stored ~* '^0x[0-9a-f]{40}$'
        AND lower(stored) = lower(COALESCE(current_setting('request.headers', true)::json->>'x-wallet-address', ''))
      )
    );
$$;

DROP POLICY IF EXISTS "Users read own watched DAOs" ON public.watched_daos;
CREATE POLICY "Users read own watched DAOs"
  ON public.watched_daos
  FOR SELECT
  TO anon, authenticated
  USING (public.nave_wallet_header_matches(wallet_address));

DROP POLICY IF EXISTS "Users delete own watched DAOs" ON public.watched_daos;
CREATE POLICY "Users delete own watched DAOs"
  ON public.watched_daos
  FOR DELETE
  TO anon, authenticated
  USING (public.nave_wallet_header_matches(wallet_address));
