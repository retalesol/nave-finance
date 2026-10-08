/*
  # Create worker_locks (M8 — cross-replica distributed lease lock)

  The Railway worker guards overlapping runs with an in-process mutex only, so
  two replicas (or a rolling-restart overlap) can both execute the same loop and
  double-act — most dangerously double management-fee collection at the annual
  UTC-midnight boundary, or double agent-wallet replenishment.

  This table backs a lease-based distributed lock: a loop claims `lock_key` by
  atomically inserting/refreshing a row whose `expires_at` is in the future and
  whose `holder` is this replica. Pooled (PgBouncer) connections make
  session-level `pg_advisory_lock` unreliable, so a TTL/lease row is used
  instead — it self-heals if a holder crashes (the lease simply expires).

  1. New Table
    - `worker_locks(lock_key text pk, holder text, expires_at timestamptz, updated_at timestamptz)`
  2. Security
    - RLS enabled; only the service role (the worker) may read/write.
*/

CREATE TABLE IF NOT EXISTS public.worker_locks (
  lock_key   text PRIMARY KEY,
  holder     text NOT NULL,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.worker_locks ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'worker_locks'
      AND policyname = 'Service role manages worker locks'
  ) THEN
    CREATE POLICY "Service role manages worker locks"
      ON public.worker_locks
      FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;

/*
  Atomically acquire or refresh a lease. Returns true when the caller now holds
  the lock. A lease is grantable when it does not exist, has expired, or is
  already held by the same holder (re-entrant refresh). The single INSERT ...
  ON CONFLICT with a guarded WHERE makes the claim race-free across replicas.
*/
CREATE OR REPLACE FUNCTION public.try_acquire_worker_lock(
  p_lock_key text,
  p_holder   text,
  p_ttl_seconds integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now timestamptz := now();
  v_expires timestamptz := now() + make_interval(secs => p_ttl_seconds);
  v_rows integer;
BEGIN
  INSERT INTO public.worker_locks (lock_key, holder, expires_at, updated_at)
  VALUES (p_lock_key, p_holder, v_expires, v_now)
  ON CONFLICT (lock_key) DO UPDATE
    SET holder = EXCLUDED.holder,
        expires_at = EXCLUDED.expires_at,
        updated_at = EXCLUDED.updated_at
    WHERE public.worker_locks.expires_at < v_now
       OR public.worker_locks.holder = EXCLUDED.holder;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END $$;

/* Release a lease only if still held by this holder (no-op otherwise). */
CREATE OR REPLACE FUNCTION public.release_worker_lock(
  p_lock_key text,
  p_holder   text
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM public.worker_locks
  WHERE lock_key = p_lock_key AND holder = p_holder;
$$;
