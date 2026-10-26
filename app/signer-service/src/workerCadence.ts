/** Safety sweep of indexed open requests. Not a full-registry RPC scan. */
export const DEFAULT_ORCHESTRATOR_SWEEP_MS = 15 * 60 * 1000;
export const DEFAULT_SNAPSHOT_INTERVAL_MS = 15 * 60 * 1000;
export const DEFAULT_POLICY_INTERVAL_MS = 60 * 60 * 1000;
export const DEFAULT_PROPOSAL_INTERVAL_MS = 60 * 60 * 1000;
/**
 * How often the worker re-reads indexed oversight rows to arm a timer at
 * reviewEnd. This does not call the orchestrator and does not scan treasuries.
 */
export const DEFAULT_REVIEW_WAKE_REFRESH_MS = 15_000;
