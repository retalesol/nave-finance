/*
  # Live strategy rates

  One row per (chain, venue_id) holding the latest venue APY from DefiLlama,
  Morpho, Kamino or Pendle. refresh-strategy-rates upserts it hourly. Rates
  are public market data, so anyone may read; only the service role writes.
*/

CREATE TABLE IF NOT EXISTS public.strategy_rates (
  chain text NOT NULL,
  venue_id text NOT NULL,
  base_apy numeric,
  reward_apy numeric,
  mean_30d_apy numeric,
  tvl_usd numeric,
  source text NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain, venue_id)
);

ALTER TABLE public.strategy_rates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "strategy_rates are public" ON public.strategy_rates;
CREATE POLICY "strategy_rates are public"
  ON public.strategy_rates
  FOR SELECT
  TO anon, authenticated
  USING (true);

REVOKE INSERT, UPDATE, DELETE ON public.strategy_rates FROM anon, authenticated;
GRANT SELECT ON public.strategy_rates TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.nave_refresh_strategy_rates()
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
    RAISE NOTICE 'nave_refresh_strategy_rates: vault secrets missing; skip';
    RETURN;
  END IF;

  PERFORM net.http_post(
    url := rtrim(project_url, '/') || '/functions/v1/refresh-strategy-rates',
    body := jsonb_build_object('source', 'cron'),
    params := '{}'::jsonb,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || service_key,
      'Content-Type', 'application/json'
    ),
    timeout_milliseconds := 60000
  );
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'nave_refresh_strategy_rates failed: %', SQLERRM;
END;
$$;

REVOKE ALL ON FUNCTION public.nave_refresh_strategy_rates() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.nave_refresh_strategy_rates() TO postgres;

DO $$
DECLARE
  jid integer;
BEGIN
  SELECT jobid INTO jid FROM cron.job WHERE jobname = 'nave-refresh-strategy-rates' LIMIT 1;
  IF jid IS NOT NULL THEN
    PERFORM cron.unschedule(jid);
  END IF;
END $$;

SELECT cron.schedule(
  'nave-refresh-strategy-rates',
  '17 * * * *',
  $$SELECT public.nave_refresh_strategy_rates();$$
);
