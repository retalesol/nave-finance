/*
  # Daily simulation batch refresh

  Invokes the public simulation-data edge function with ?refresh=1 so a stale
  batch (>24h) is regenerated. Uses pg_net + vault secrets when available;
  no-ops safely if extensions/secrets are missing.
*/

CREATE OR REPLACE FUNCTION public.nave_refresh_simulation_batch()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  project_url text;
  service_key text;
BEGIN
  -- Prefer vault secrets used by other Nave cron jobs when present.
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
    WHERE name IN ('service_role_key', 'anon_key')
    ORDER BY CASE name WHEN 'service_role_key' THEN 0 ELSE 1 END
    LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    service_key := NULL;
  END;

  IF project_url IS NULL OR service_key IS NULL THEN
    RAISE NOTICE 'nave_refresh_simulation_batch: vault secrets missing; skip';
    RETURN;
  END IF;

  PERFORM net.http_get(
    url := rtrim(project_url, '/') || '/functions/v1/simulation-data?refresh=1',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || service_key,
      'Content-Type', 'application/json'
    )
  );
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'nave_refresh_simulation_batch failed: %', SQLERRM;
END;
$$;

REVOKE ALL ON FUNCTION public.nave_refresh_simulation_batch() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.nave_refresh_simulation_batch() TO postgres;

DO $$
DECLARE
  jid integer;
BEGIN
  SELECT jobid INTO jid FROM cron.job WHERE jobname = 'nave-simulation-refresh' LIMIT 1;
  IF jid IS NOT NULL THEN
    PERFORM cron.unschedule(jid);
  END IF;
END $$;

SELECT cron.schedule(
  'nave-simulation-refresh',
  '15 1 * * *',
  $$SELECT public.nave_refresh_simulation_batch();$$
);
