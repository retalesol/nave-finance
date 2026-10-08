/*
  # Lock watched_daos writes to edge functions

  We keep wallet-scoped SELECT/DELETE for user UX, but disable direct INSERT/UPDATE
  from anon/authenticated roles so privacy checks are enforced through the
  service-role `watch-dao` function path.
*/

DROP POLICY IF EXISTS "Users insert own watched DAOs" ON public.watched_daos;
DROP POLICY IF EXISTS "Users update own watched DAOs" ON public.watched_daos;
