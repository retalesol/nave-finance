// Deterministic gate on the Oversight agent's `continue` and `clear_halt` (wire role `operational`).
//
// The model's decision is advisory. Before the orchestrator executes after the
// review window or lifts a halt, it needs reasons it can check itself: the
// guardrails ran and passed, the review window is over, and every deterministic
// cause recorded with the halt now passes. A halt with no recorded cause (the
// model halted on its own judgement) is never cleared by the model; the founder
// clears it.
//
// Runtime-agnostic (no Deno/npm imports) so Node tests can import it.

export interface GateCheck {
  id: string;
  ok: boolean;
  indeterminate?: boolean;
  severity?: string;
}

/** Guardrail checks whose failure is recorded as a deterministic halt cause. */
export const HALT_CAUSE_CHECKS: readonly string[] = [
  "agents_enabled",
  "snapshot_freshness",
  "protocol_allowlist",
  "allocation_cap",
  "global_deployment_cap",
  "liquidity_floor",
  "reserve_floor",
  "nav_freshness",
  "risk_severity",
  "genlayer_venue",
  "genlayer_halt",
];

/** Failing critical checks to persist with an operational_halt. */
export function haltCausesFrom(checks: readonly GateCheck[] | null | undefined): string[] {
  if (!Array.isArray(checks)) return [];
  const causes = checks
    .filter((c) => HALT_CAUSE_CHECKS.includes(c.id) && !c.ok && (c.severity ?? "critical") === "critical")
    .map((c) => c.id);
  return [...new Set(causes)];
}

export interface OperationalGateInput {
  action: "continue" | "clear_halt";
  /** On-chain request status name (InReview, Halted, ...). */
  status: string;
  nowSecs: number;
  reviewEndSecs: number;
  checks: readonly GateCheck[] | null | undefined;
  guardrailFailures: readonly string[] | null | undefined;
  /**
   * Causes recorded with the request's latest halt. `null` = no halt on record,
   * `[]` = the halt had no deterministic cause.
   */
  openHaltCauses: readonly string[] | null;
}

export interface OperationalGateResult {
  ok: boolean;
  /** Deterministic facts that permit the action (persisted with the log row). */
  reasons: string[];
  blockers: string[];
}

export function operationalGate(input: OperationalGateInput): OperationalGateResult {
  const reasons: string[] = [];
  const blockers: string[] = [];
  const checks = Array.isArray(input.checks) ? input.checks : [];

  if (checks.length === 0) {
    blockers.push("guardrails did not run");
  } else {
    const failing = checks.filter((c) => !c.ok && (c.severity ?? "critical") === "critical").map((c) => c.id);
    if (failing.length > 0 || (input.guardrailFailures?.length ?? 0) > 0) {
      blockers.push(`guardrails failing: ${[...new Set(failing)].join(", ") || input.guardrailFailures!.join("; ")}`);
    } else {
      reasons.push(`guardrails green (${checks.length} checks)`);
    }
  }

  const byId = new Map(checks.map((c) => [c.id, c]));
  const unresolved = (input.openHaltCauses ?? []).filter((id) => {
    const c = byId.get(id);
    return !c || !c.ok || c.indeterminate === true;
  });

  if (input.action === "continue") {
    if (input.status !== "InReview") blockers.push(`request is ${input.status}, not InReview`);
    if (input.nowSecs < input.reviewEndSecs) {
      blockers.push(`review window open for ${input.reviewEndSecs - input.nowSecs}s`);
    } else {
      reasons.push("review window passed");
    }
    if (unresolved.length > 0) blockers.push(`open halt causes: ${unresolved.join(", ")}`);
    else reasons.push("no open halt cause");
  } else {
    if (input.status !== "Halted") blockers.push(`request is ${input.status}, not Halted`);
    if (input.openHaltCauses === null) {
      blockers.push("no halt record for this request");
    } else if (input.openHaltCauses.length === 0) {
      blockers.push("halt had no deterministic cause; only the founder can clear it");
    } else if (unresolved.length > 0) {
      blockers.push(`halt causes still failing: ${unresolved.join(", ")}`);
    } else {
      reasons.push(`halt causes now pass: ${input.openHaltCauses.join(", ")}`);
    }
  }

  return { ok: blockers.length === 0, reasons, blockers };
}
