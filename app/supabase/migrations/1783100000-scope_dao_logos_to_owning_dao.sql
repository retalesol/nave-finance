/*
  # Scope dao-logos upload/update policy to the owning DAO (H2 residual fix)

  The `dao-logos founder upload`/`update` policies added by
  1781200000-harden-rls-policies.sql require the caller to be *a* DAO's
  founder (any dao_registry row with creator_wallet = the caller's wallet),
  but never checked that they are the founder of the SPECIFIC dao_registry
  the object being written belongs to — the object path carried no DAO
  identity to scope against. In practice this meant any DAO founder could
  overwrite or upload logo objects intended for a different DAO's asset.

  Upload paths are now namespaced as `{daoAddress}/{filename}` (see
  src/lib/uploadLogo.ts), so this migration re-scopes both policies to the
  DAO encoded in the object's folder name via storage.foldername(name).
*/

DROP POLICY IF EXISTS "dao-logos founder upload" ON storage.objects;
DROP POLICY IF EXISTS "dao-logos founder update" ON storage.objects;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'dao-logos founder upload (scoped)'
  ) THEN
    CREATE POLICY "dao-logos founder upload (scoped)"
      ON storage.objects FOR INSERT
      TO anon, authenticated
      WITH CHECK (
        bucket_id = 'dao-logos'
        AND EXISTS (
          SELECT 1 FROM public.dao_registry r
          WHERE r.dao_onchain_address = (storage.foldername(name))[1]
            AND r.creator_wallet = current_setting('request.headers', true)::json->>'x-wallet-address'
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'dao-logos founder update (scoped)'
  ) THEN
    CREATE POLICY "dao-logos founder update (scoped)"
      ON storage.objects FOR UPDATE
      TO anon, authenticated
      USING (
        bucket_id = 'dao-logos'
        AND EXISTS (
          SELECT 1 FROM public.dao_registry r
          WHERE r.dao_onchain_address = (storage.foldername(name))[1]
            AND r.creator_wallet = current_setting('request.headers', true)::json->>'x-wallet-address'
        )
      )
      WITH CHECK (
        bucket_id = 'dao-logos'
        AND EXISTS (
          SELECT 1 FROM public.dao_registry r
          WHERE r.dao_onchain_address = (storage.foldername(name))[1]
            AND r.creator_wallet = current_setting('request.headers', true)::json->>'x-wallet-address'
        )
      );
  END IF;
END $$;
