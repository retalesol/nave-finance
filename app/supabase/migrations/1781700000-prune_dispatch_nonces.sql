/*
  # Prune stale dispatch_nonces (replay-protection store)

  orchestrator-proxy inserts one row per consumed founder challenge. Without
  pruning the table grows without bound (audit M-1). Keep 30 days of history for
  forensics; older rows are safe to delete because challenges expire after 5m.
*/

CREATE EXTENSION IF NOT EXISTS pg_cron;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'prune_dispatch_nonces_daily'
  ) THEN
    PERFORM cron.schedule(
      'prune_dispatch_nonces_daily',
      '0 4 * * *',
      $cron$DELETE FROM public.dispatch_nonces WHERE created_at < now() - interval '30 days'$cron$
    );
  END IF;
END $$;
