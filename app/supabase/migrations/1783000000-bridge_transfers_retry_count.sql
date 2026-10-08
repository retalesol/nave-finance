/*
  # Bridge watcher: retry_count for the independent relay watcher

  Adds the `retry_count` column consumed by signer-service `bridgeWatcher.ts`
  (audit M-1: push-only relay had no recovery path for lost/failed transfers).
  The watcher re-drives stale `pending`/`failed` transfers through the standard,
  on-chain-verified relay path, bounded by this counter; once it exceeds
  BRIDGE_WATCHER_MAX_RETRIES a row is parked as status 'stuck' for an operator.

  On-chain replay guards (nave_bridge `ProcessedRelease` /
  lockbox `processed[srcChainId,srcNonce]`) remain the authoritative
  double-spend protection, so a re-drive of an already-processed transfer
  reverts harmlessly rather than paying twice.

  Idempotent (IF NOT EXISTS) so re-applying is safe.
*/

ALTER TABLE public.bridge_transfers
  ADD COLUMN IF NOT EXISTS retry_count integer NOT NULL DEFAULT 0;

-- Composite index for the watcher's retry sweep
-- (status IN ('pending','failed') AND updated_at < cutoff, oldest first).
CREATE INDEX IF NOT EXISTS idx_bridge_transfers_status_updated_at
  ON public.bridge_transfers (status, updated_at);
