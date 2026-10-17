-- Founder metadata writes (logos, token images, hidden assets) moved to the
-- founder-metadata edge function, which checks an on-chain founder signature.
-- The anon key can no longer insert, update, or delete these rows by presenting
-- an x-wallet-address header. Public reads stay. service_role bypasses RLS.

DROP POLICY IF EXISTS "anon_upsert_token_images" ON public.dao_token_images;
DROP POLICY IF EXISTS "anon_update_token_images" ON public.dao_token_images;
DROP POLICY IF EXISTS "Creator inserts token images" ON public.dao_token_images;
DROP POLICY IF EXISTS "Creator updates token images" ON public.dao_token_images;

DROP POLICY IF EXISTS "Founder hides assets" ON public.dao_hidden_assets;
DROP POLICY IF EXISTS "Founder unhides assets" ON public.dao_hidden_assets;

DROP POLICY IF EXISTS "dao-logos upload" ON storage.objects;
DROP POLICY IF EXISTS "dao-logos update" ON storage.objects;
DROP POLICY IF EXISTS "dao-logos founder upload" ON storage.objects;
DROP POLICY IF EXISTS "dao-logos founder update" ON storage.objects;
DROP POLICY IF EXISTS "dao-logos founder upload (scoped)" ON storage.objects;
DROP POLICY IF EXISTS "dao-logos founder update (scoped)" ON storage.objects;
