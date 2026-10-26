// Pure cooldown rules for the orchestrator's per-request redispatch. No Deno
// imports so Node tests can load it.

export const REDISPATCH_COOLDOWN_SECS = 21600;
export const REFRESH_RETRY_SECS = 600;

/** Blocks that clear on their own (a review still finalizing, stale NAV or snapshot). */
const REFRESH_ONLY_FAILURES = [
  "genlayer_charter: charter review not finished",
  "genlayer_charter: charter check missing",
  "nav_freshness:",
  "snapshot_freshness:",
];

export function waitsOnlyForRefresh(errorMessage: string): boolean {
  const failures = errorMessage.split(";").map((f) => f.trim()).filter(Boolean);
  return failures.length > 0
    && failures.every((f) => REFRESH_ONLY_FAILURES.some((prefix) => f.startsWith(prefix)));
}

export interface LastLogRow {
  decision?: string | null;
  status?: string | null;
  error_message?: string | null;
  created_at?: string | null;
}

/** The role's last answer on this request was a block, a review, or a reject. */
export function isStuckRow(last: LastLogRow | undefined | null): boolean {
  return !!last && (
    last.status === "guardrail_blocked"
    || last.decision === "request_review"
    || last.decision === "reject"
  );
}

/**
 * Seconds a role must still wait before it is asked about this request again,
 * or 0 when it may run now.
 *
 * - block / review / reject: the full cooldown (refresh-only blocks wait
 *   `refreshRetrySecs`).
 * - a Halted request whose last answer was not clear_halt: the full cooldown,
 *   so an idle monitor is not re-asked every tick.
 * - a failed or errored row whose message is a missing or inactive agent key:
 *   the full cooldown. A missing key is not a refresh retry.
 * - any other failed or errored row (refused execute, failed model call):
 *   `refreshRetrySecs`.
 * - anything else (e.g. `continue` completed on an InReview request): 0, so a
 *   request that is ready to execute is never starved.
 */

const KEY_MISS_PATTERNS = [
  /agent key not found/i,
  /key[-\s]+not[-\s]+found/i,
  /not found or inactive/i,
  /inactive[-\s]+key/i,
  /key is inactive/i,
  /no active (encrypted_)?(agent|evm)[_ ]?key/i,
  /missing agent key/i,
];

/** True when a logged failure is a missing or inactive agent key. */
export function isKeyMissFailure(errorMessage: string): boolean {
  const text = errorMessage.trim();
  if (!text) return false;
  return KEY_MISS_PATTERNS.some((pattern) => pattern.test(text));
}

export function redispatchWaitSecs(args: {
  last: LastLogRow | undefined | null;
  requestStatus: string;
  role: string;
  nowMs?: number;
  cooldownSecs?: number;
  refreshRetrySecs?: number;
}): number {
  const cooldown = args.cooldownSecs ?? REDISPATCH_COOLDOWN_SECS;
  const refresh = args.refreshRetrySecs ?? REFRESH_RETRY_SECS;
  const { last } = args;
  if (cooldown <= 0 || !last) return 0;

  let window = 0;
  if (isStuckRow(last)) {
    window = waitsOnlyForRefresh(last.error_message ?? "") ? Math.min(cooldown, refresh) : cooldown;
  } else if (
    args.requestStatus === "Halted" && args.role === "operational" && last.decision !== "clear_halt"
  ) {
    window = cooldown;
  } else if (last.status === "failed" || last.status === "error") {
    window = isKeyMissFailure(last.error_message ?? "") ? cooldown : Math.min(cooldown, refresh);
  }
  if (window <= 0) return 0;

  const createdMs = last.created_at ? Date.parse(last.created_at) : NaN;
  if (!Number.isFinite(createdMs)) return 0;
  const ageSecs = ((args.nowMs ?? Date.now()) - createdMs) / 1000;
  return Math.max(0, Math.ceil(window - ageSecs));
}
