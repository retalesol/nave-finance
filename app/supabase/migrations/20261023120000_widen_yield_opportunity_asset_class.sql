-- Widen yield_opportunities.asset_class so sol-like, blue-chip, and lp rows
-- persist. Existing rows stay. The previous check only allowed
-- stablecoin, sol, and other, so Jito (sol-like) and WETH (blue-chip) inserts
-- failed.

DO $$
DECLARE
  constraint_name text;
BEGIN
  SELECT con.conname
    INTO constraint_name
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
  WHERE nsp.nspname = 'public'
    AND rel.relname = 'yield_opportunities'
    AND con.contype = 'c'
    AND pg_get_constraintdef(con.oid) ILIKE '%asset_class%';

  IF constraint_name IS NOT NULL
     AND constraint_name IS DISTINCT FROM 'yield_opportunities_asset_class_check' THEN
    EXECUTE format('ALTER TABLE public.yield_opportunities DROP CONSTRAINT %I', constraint_name);
  END IF;

  ALTER TABLE public.yield_opportunities
    DROP CONSTRAINT IF EXISTS yield_opportunities_asset_class_check;

  ALTER TABLE public.yield_opportunities
    ADD CONSTRAINT yield_opportunities_asset_class_check
    CHECK (asset_class IN ('stablecoin', 'sol', 'sol-like', 'blue-chip', 'lp', 'other'));
END $$;
