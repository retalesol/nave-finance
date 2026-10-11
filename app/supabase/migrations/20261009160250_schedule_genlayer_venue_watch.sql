/*
  # Daily GenLayer venue review

  Wakes genlayer-venue-watch, which posts kind "venue" to the adjudicator
  for Kamino, Aave V3, and Compound V3. No-ops when the vault URL or
  service role key is missing.
*/

CREATE OR REPLACE FUNCTION public.nave_genlayer_venue_watch()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  project_url text;
  service_key text;
BEGIN
  BEGIN
    SELECT decrypted_secret INTO project_url
    FROM vault.decrypted_secrets
    WHERE name = 'project_url'
    LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    project_url := NULL;
  END;

  BEGIN
    SELECT decrypted_secret INTO service_key
    FROM vault.decrypted_secrets
    WHERE name = 'service_role_key'
    LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    service_key := NULL;
  END;

  IF project_url IS NULL OR service_key IS NULL THEN
    RAISE NOTICE 'nave_genlayer_venue_watch: vault secrets missing; skip';
    RETURN;
  END IF;

  PERFORM net.http_post(
    url := rtrim(project_url, '/') || '/functions/v1/genlayer-venue-watch',
    body := jsonb_build_object('source', 'cron'),
    params := '{}'::jsonb,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || service_key,
      'Content-Type', 'application/json'
    ),
    timeout_milliseconds := 150000
  );
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'nave_genlayer_venue_watch failed: %', SQLERRM;
END;
$$;

REVOKE ALL ON FUNCTION public.nave_genlayer_venue_watch() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.nave_genlayer_venue_watch() TO postgres;

DO $$
DECLARE
  jid integer;
BEGIN
  SELECT jobid INTO jid FROM cron.job WHERE jobname = 'nave-genlayer-venue-watch' LIMIT 1;
  IF jid IS NOT NULL THEN
    PERFORM cron.unschedule(jid);
  END IF;
END $$;

SELECT cron.schedule(
  'nave-genlayer-venue-watch',
  '30 2 * * *',
  $$SELECT public.nave_genlayer_venue_watch();$$
);
