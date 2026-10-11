// Shared agent decision contracts.
//
// The dispatcher (LLM output schema + validators) and the orchestrator (what to
// do with a decision) MUST agree on the decision vocabulary. Historically the
// orchestrator gated autonomous execution on `decision === "approve"` while the
// Oversight schema (wire role `operational`) could only ever emit continue|halt|clear_halt|request_review,
// so execution was dead code. Both sides now import from this module and the
// eval harness (eval/run-agent-contracts.ts) asserts the contract.
//
// This file must stay runtime-agnostic (no Deno/npm imports) so the Node-based
// eval harness can import it directly.

export const AGENT_ROLES = ["executive", "financial", "oversight", "operational"] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

/** Decisions a signing role (executive / financial / oversight) may return. */
export const SIGNING_DECISIONS = ["approve", "reject", "request_review"] as const;
export type SigningDecision = (typeof SIGNING_DECISIONS)[number];

/** Decisions the Oversight agent (wire role `operational`, the monitor) may return. */
export const OPERATIONAL_DECISIONS = ["continue", "halt", "clear_halt", "request_review"] as const;
export type OperationalDecision = (typeof OPERATIONAL_DECISIONS)[number];

/**
 * The ONLY Oversight decision (wire role `operational`) that permits autonomous execution once the
 * on-chain review window has elapsed. `continue` means "no reason to block —
 * proceed to execution" (see the Oversight system prompt in agent-dispatcher).
 */
export const OPERATIONAL_EXECUTE_DECISIONS: readonly OperationalDecision[] = ["continue"];

/** Oversight decisions (wire role `operational`) that expire the request outright once the window elapsed. */
export const OPERATIONAL_EXPIRE_DECISIONS: readonly OperationalDecision[] = ["halt"];

export function isSigningDecision(d: unknown): d is SigningDecision {
  return typeof d === "string" && (SIGNING_DECISIONS as readonly string[]).includes(d);
}

export function isOperationalDecision(d: unknown): d is OperationalDecision {
  return typeof d === "string" && (OPERATIONAL_DECISIONS as readonly string[]).includes(d);
}

export interface OperationalVerdictInput {
  decision: unknown;
  should_halt?: boolean | null;
  guardrail_failures?: readonly string[] | null;
}

/** What the orchestrator does with an Oversight verdict (wire role `operational`) after review_end. */
export type PostReviewAction = "execute" | "expire" | "park";

/**
 * Deterministic post-review routing for the Oversight role (wire key `operational`). Called ONLY when
 * the on-chain request is InReview and `now >= review_end`.
 *
 *   - should_halt                                → "park"    (halt path handles it)
 *   - continue + no guardrail failures           → "execute"
 *   - halt (without should_halt — inconsistent)  → "expire"
 *   - request_review / clear_halt / blocked      → "park" until the execution
 *     grace window elapses, then "expire" (timeout cleanup)
 *
 * Anything outside the Oversight decision enum (e.g. a stray "approve") never executes.
 */
export function postReviewAction(
  input: OperationalVerdictInput,
  opts: { graceElapsed: boolean },
): PostReviewAction {
  const failures = input.guardrail_failures ?? [];
  if (input.should_halt) return "park";
  if (!isOperationalDecision(input.decision)) {
    return opts.graceElapsed ? "expire" : "park";
  }
  if (OPERATIONAL_EXECUTE_DECISIONS.includes(input.decision) && failures.length === 0) {
    return "execute";
  }
  if (OPERATIONAL_EXPIRE_DECISIONS.includes(input.decision)) return "expire";
  return opts.graceElapsed ? "expire" : "park";
}
