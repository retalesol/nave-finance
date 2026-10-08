/*
  # Harden RLS policies (security audit remediation)

  Three anon-open patterns are closed here. RLS combines policies with OR, so a
  single permissive `USING (true)` / `WITH CHECK (true)` policy granted to anon
  defeats every co-existing privacy/ownership gate on the same command.

  1. monthly_reports (CRITICAL data exposure)
     1779924683 created a privacy-gated "Public read monthly reports" SELECT
     policy (only non-private DAOs). 1779924740 then ADDED a permissive
     "Anyone can read monthly reports" SELECT policy `USING (true)`, which
     OR-combines with the gated one and exposes EVERY DAO's yield_earned /
     capital_* / fees to anon — including privacy-enabled DAOs. We drop the
     permissive policy, leaving only the privacy-gated read.

  2. dao_token_images (open INSERT/UPDATE)
     1781000000 left INSERT/UPDATE `WITH CHECK (true)` / `USING (true)` open to
     anon, so anyone could overwrite any DAO's token image. We keep public
     SELECT (images are public assets) but require writers to present the DAO
     creator wallet via the `x-wallet-address` header, matched against
     dao_registry.creator_wallet for the row's dao_address. This mirrors the
     header-scoped ownership model already used by watched_daos. service_role
     (edge functions / indexers) keeps full access and bypasses RLS.

  3. dao-logos storage bucket (open INSERT/UPDATE)
     1780000000 left bucket INSERT/UPDATE open to anon. We keep public read but
     restrict writes to callers presenting an `x-wallet-address` header that is a
     known DAO creator wallet in dao_registry — so only registered founders can
     upload/replace logos.

  NOTE (frontend coordination): the app currently writes dao_token_images and
  dao-logos directly with the anon client and does NOT yet send the
  `x-wallet-address` header on those calls. After this migration those writes
  fail closed until the client forwards the header (or the writes are routed
  through a service_role edge function). This is intentional — no insecure
  fallback is introduced.

  Forward-only and idempotent: safe to run more than once.
*/

-- ─── 1. monthly_reports: drop the permissive anon-open read ───────────────────
DROP POLICY IF EXISTS "Anyone can read monthly reports" ON public.monthly_reports;

-- ─── 2. dao_token_images: replace open writes with creator-scoped writes ──────
DROP POLICY IF EXISTS "anon_upsert_token_images" ON public.dao_token_images;
DROP POLICY IF EXISTS "anon_update_token_images" ON public.dao_token_images;

DO $$
BEGIN
  -- INSERT: only the DAO's registered creator (by x-wallet-address header).
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'dao_token_images'
      AND policyname = 'Creator inserts token images'
  ) THEN
    CREATE POLICY "Creator inserts token images"
      ON public.dao_token_images
      FOR INSERT
      TO anon, authenticated
      WITH CHECK (
        EXISTS (
          SELECT 1 FROM public.dao_registry r
          WHERE r.dao_onchain_address = dao_token_images.dao_address
            AND r.creator_wallet = current_setting('request.headers', true)::json->>'x-wallet-address'
        )
      );
  END IF;

  -- UPDATE: same ownership gate on both the existing row (USING) and the new
  -- row (WITH CHECK) so a creator cannot re-key a row to another DAO.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'dao_token_images'
      AND policyname = 'Creator updates token images'
  ) THEN
    CREATE POLICY "Creator updates token images"
      ON public.dao_token_images
      FOR UPDATE
      TO anon, authenticated
      USING (
        EXISTS (
          SELECT 1 FROM public.dao_registry r
          WHERE r.dao_onchain_address = dao_token_images.dao_address
            AND r.creator_wallet = current_setting('request.headers', true)::json->>'x-wallet-address'
        )
      )
      WITH CHECK (
        EXISTS (
          SELECT 1 FROM public.dao_registry r
          WHERE r.dao_onchain_address = dao_token_images.dao_address
            AND r.creator_wallet = current_setting('request.headers', true)::json->>'x-wallet-address'
        )
      );
  END IF;

  -- Defense-in-depth: explicit service_role full access (edge fns / indexers).
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'dao_token_images'
      AND policyname = 'Service role manages token images'
  ) THEN
    CREATE POLICY "Service role manages token images"
      ON public.dao_token_images
      FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;

-- ─── 3. dao-logos storage bucket: restrict writes to known DAO founders ───────
DROP POLICY IF EXISTS "dao-logos upload" ON storage.objects;
DROP POLICY IF EXISTS "dao-logos update" ON storage.objects;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'dao-logos founder upload'
  ) THEN
    CREATE POLICY "dao-logos founder upload"
      ON storage.objects
      FOR INSERT
      TO anon, authenticated
      WITH CHECK (
        bucket_id = 'dao-logos'
        AND EXISTS (
          SELECT 1 FROM public.dao_registry r
          WHERE r.creator_wallet = current_setting('request.headers', true)::json->>'x-wallet-address'
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'dao-logos founder update'
  ) THEN
    CREATE POLICY "dao-logos founder update"
      ON storage.objects
      FOR UPDATE
      TO anon, authenticated
      USING (
        bucket_id = 'dao-logos'
        AND EXISTS (
          SELECT 1 FROM public.dao_registry r
          WHERE r.creator_wallet = current_setting('request.headers', true)::json->>'x-wallet-address'
        )
      )
      WITH CHECK (
        bucket_id = 'dao-logos'
        AND EXISTS (
          SELECT 1 FROM public.dao_registry r
          WHERE r.creator_wallet = current_setting('request.headers', true)::json->>'x-wallet-address'
        )
      );
  END IF;
END $$;
