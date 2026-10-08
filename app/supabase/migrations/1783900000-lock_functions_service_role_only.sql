/*
  Restrict worker-lock functions to the service role.

  try_acquire_worker_lock / release_worker_lock are SECURITY DEFINER and were
  executable by anon/authenticated (Supabase advisor 0028/0029). They are only
  ever called server-side (signer-service claims + worker ticks) with the
  service-role key — leaving them public let an anonymous caller squat the
  `stakeClaim:<chain>:<staker>` lease (blocking a staker's claims) or the
  mirror/watcher leases (stalling money-moving ticks) for the TTL, repeatedly.
*/

REVOKE ALL ON FUNCTION public.try_acquire_worker_lock(text, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_worker_lock(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.try_acquire_worker_lock(text, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_worker_lock(text, text) TO service_role;
