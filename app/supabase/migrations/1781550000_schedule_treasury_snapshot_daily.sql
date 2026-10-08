/*
  # Treasury snapshot cadence: once per 24 hours (wall-clock)

  Replaces the previous pg_cron schedule (e.g. every 10 minutes) with a single
  daily run at **00:00 UTC**, giving a 24-hour period between snapshot batches.

  The job continues to call `public.nave_snapshot_all_daos()` which POSTs the
  `snapshot-treasury` edge function using the vault indexer secret.
*/

DO $$
DECLARE
  jid integer;
BEGIN
  SELECT jobid INTO jid FROM cron.job WHERE jobname = 'nave-treasury-snapshot' LIMIT 1;
  IF jid IS NOT NULL THEN
    PERFORM cron.unschedule(jid);
  END IF;
END $$;

SELECT cron.schedule(
  'nave-treasury-snapshot',
  '0 0 * * *',
  $$SELECT public.nave_snapshot_all_daos();$$
);
