// Deterministic guardrails (Phase 7).
//
// These checks run OUTSIDE the model, before any agent is allowed to sign.
// The model's output is advisory; signing eligibility is decided here by
// deterministic rules over the canonical AgentContext (agentContext.ts) and the
// model's structured output. This is the gate the plan requires: cap math,
// payload-hash equality, confidence threshold, signer role, snapshot age,
// protocol allowlist, and decision/flag consistency.
//
// Philosophy: fail-closed. If a check cannot be evaluated because required
// context is missing AND failClosedOnUnknown is set for that check, the check
// fails (blocks signing) rather than silently passing.

import { AgentContext, AgentRole, snapshotAgeSeconds } from "./agentContext.ts";
import {
  NAVE_GENLAYER_GATE,
  NAVE_GENLAYER_HALT_GATE,
  NAVE_GENLAYER_VENUE_GATE,
  charterGateOutcome,
  haltGateOutcome,
  readGenlayerFlag,
  venueGateOutcome,
} from "./genlayerCharter.ts";

export type CheckId =
  | "role_valid"
  | "agents_enabled"
  | "confidence_threshold"
  | "decision_consistency"
  | "risk_severity"
  | "snapshot_freshness"
  | "protocol_allowlist"
  | "allocation_cap"
  | "global_deployment_cap"
  | "liquidity_floor"
  | "reserve_floor"
  | "nav_freshness"
  | "rebalance_interval"
  | "payload_hash_equality"
  | "genlayer_charter"
  | "genlayer_venue"
  | "genlayer_halt";

export type Severity = "critical" | "warning";

export interface CheckResult {
  id: CheckId;
  ok: boolean;
  /** True when the check could not be evaluated (missing context). */
  indeterminate: boolean;
  severity: Severity;
  detail: string;
}

export interface GuardrailOutput {
  decision: string;
  confidence: number;
  should_sign?: boolean;
  should_halt?: boolean;
  should_clear_halt?: boolean;
  payload_hash?: string;
  risk_flags?: string[];
}

export interface GuardrailOptions {
  /** Max acceptable treasury snapshot age (seconds). Default 1h. */
  maxSnapshotAgeSeconds?: number;
  /** Risk flags that, if present, hard-block signing. */
  severeRiskFlags?: string[];
  /**
   * When required context for a critical check is missing, fail closed
   * (block signing) instead of skipping. Default true.
   */
  failClosedOnUnknown?: boolean;
  /** Unix seconds used for rebalance-cadence eligibility. Default: now. */
  nowSecs?: number;
  /**
   * Max acceptable age (seconds) of the on-chain NAV revaluation for an
   * executable strategy deploy. 0/undefined disables the NAV freshness gate even
   * when the on-chain `last_revalued_at` field is present (staged rollout),
   * unless `requireCompleteConstitution` is set.
   */
  maxNavAgeSeconds?: number;
  /**
   * Live-treasury mode. Dispatcher and orchestrator set this. Eval fixtures
   * leave it unset so a cap/floor of 0 still means "unset" and a missing gate
   * or NAV timestamp stays non-blocking.
   *
   * When true:
   * - a deployment cap, liquidity floor, or stablecoin reserve floor of 0 fails
   * - a strategy deploy with no `navLastRevaluedAt` or `maxNavAgeSeconds <= 0` fails
   * - a missing `ctx.gate` fails for signing roles
   * - rebalance cadence also applies when `ctx.policyIntent` is `"rebalance"`
   */
  requireCompleteConstitution?: boolean;
  /**
   * Charter gate. True only when NAVE_GENLAYER_GATE=true. Default false:
   * the check is recorded and does not block.
   */
  genlayerGate?: boolean;
  /** Venue stop withholds new deploys only when this is true. Default false. */
  genlayerVenueGate?: boolean;
  /** keep_pause blocks clear_halt only when this is true. Default false. */
  genlayerHaltGate?: boolean;
}

export interface GuardrailVerdict {
  /** True only if every critical check passed (no failures). */
  pass: boolean;
  /** Final signing eligibility: pass && model said should_sign. */
  shouldSign: boolean;
  checks: CheckResult[];
  failures: string[];
}

const DEFAULT_SEVERE_FLAGS = [
  "critical",
  "severe",
  "constitution_violation",
  "cap_exceeded",
  "payload_mismatch",
  "stale_data",
  "insufficient_data",
];

function norm(s: string): string {
  return s.toLowerCase().replace(/[\s-]+/g, "_");
}

/**
 * Evaluate all deterministic guardrails. `role` is the acting agent role.
 * Signing roles: executive | financial | oversight. operational never signs.
 */
export function evaluateGuardrails(
  role: AgentRole,
  ctx: AgentContext,
  output: GuardrailOutput,
  opts: GuardrailOptions = {},
): GuardrailVerdict {
  const failClosed = opts.failClosedOnUnknown ?? true;
  const requireComplete = opts.requireCompleteConstitution ?? false;
  const maxAge = opts.maxSnapshotAgeSeconds ?? 3600;
  const maxNavAge = opts.maxNavAgeSeconds ?? 0;
  const severeFlags = (opts.severeRiskFlags ?? DEFAULT_SEVERE_FLAGS).map(norm);
  const isSigning = role !== "operational";
  const checks: CheckResult[] = [];

  const add = (
    id: CheckId,
    ok: boolean,
    detail: string,
    indeterminate = false,
    severity: Severity = "critical",
  ) => checks.push({ id, ok, indeterminate, severity, detail });

  // 1. Role validity.
  const validRole = ["executive", "financial", "oversight", "operational"].includes(role);
  add("role_valid", validRole, validRole ? `role=${role}` : `invalid role: ${role}`);

  // 1b. Agent gate (on-chain pause/freeze). Fail-CLOSED for signing roles when
  // the chain explicitly says agents are disabled or the DAO is frozen, AND when
  // the gate is present but a flag is `null` (unreadable RPC partial failure) —
  // we cannot confirm the DAO is unfrozen / enabled, so we must not open the
  // signing path. This mirrors the orchestrator's `evaluateGate` (which treats a
  // null flag as `unreadable -> fail-closed`) so the dispatcher, which is
  // independently callable, does not become a defense-in-depth hole. CRITICAL
  // backward-compat: when `ctx.gate` is absent (legacy contexts / all existing
  // fixtures) the gate is unknown and this check is NOT applicable — it must NOT
  // block. Operational role is exempt from blocking so halt/expire monitoring
  // still runs while frozen/unreadable; it surfaces a non-blocking warning.
  const gate = ctx.gate;
  const gateUnreadable = !!gate && (gate.frozen === null || gate.agentsEnabled === null);
  const gateExplicitClosed = !!gate && (gate.frozen === true || gate.agentsEnabled === false);
  const gateBlocks = gateExplicitClosed || gateUnreadable;
  if (!gate) {
    if (requireComplete && isSigning) {
      add(
        "agents_enabled",
        false,
        "agent gate missing — fail-closed (requireCompleteConstitution)",
        true,
      );
    } else {
      add("agents_enabled", true, "agent gate state not provided (n/a)", true);
    }
  } else if (isSigning) {
    if (gateUnreadable) {
      add(
        "agents_enabled",
        !failClosed,
        `agent gate unreadable (frozen=${gate.frozen}, agents_enabled=${gate.agentsEnabled}) — fail-closed`,
        true,
      );
    } else {
      add(
        "agents_enabled",
        !gateExplicitClosed,
        gateExplicitClosed
          ? `agent gate closed (frozen=${gate.frozen}, agents_enabled=${gate.agentsEnabled})`
          : `agent gate open (frozen=${gate.frozen}, agents_enabled=${gate.agentsEnabled})`,
      );
    }
  } else {
    add(
      "agents_enabled",
      true,
      gateBlocks
        ? `agent gate closed/unreadable but operational monitoring exempt (frozen=${gate.frozen}, agents_enabled=${gate.agentsEnabled})`
        : "agent gate open (operational)",
      false,
      "warning",
    );
  }

  // 2. Confidence threshold.
  const threshold = ctx.riskParams.confidenceThreshold;
  add(
    "confidence_threshold",
    output.confidence >= threshold,
    `confidence ${output.confidence} vs threshold ${threshold}`,
  );

  // 3. Decision / flag consistency.
  if (isSigning) {
    const contradiction = output.decision === "approve" && output.should_sign === false;
    add(
      "decision_consistency",
      !contradiction,
      contradiction ? "decision=approve but should_sign=false" : "consistent",
    );
  } else {
    const contradiction = !!output.should_halt && !!output.should_clear_halt;
    add(
      "decision_consistency",
      !contradiction,
      contradiction ? "should_halt and should_clear_halt both true" : "consistent",
    );
  }

  // 4. Risk-flag severity.
  const flags = (output.risk_flags ?? []).map(norm);
  const hit = flags.find((f) => severeFlags.some((s) => f.includes(s)));
  add(
    "risk_severity",
    !hit,
    hit ? `severe risk flag present: ${hit}` : "no severe risk flags",
  );

  // 5. Snapshot freshness.
  const age = snapshotAgeSeconds(ctx);
  if (age === null) {
    add(
      "snapshot_freshness",
      !failClosed,
      "no treasury snapshot available",
      true,
    );
  } else {
    add(
      "snapshot_freshness",
      age <= maxAge,
      `snapshot age ${age}s vs max ${maxAge}s`,
    );
  }

  // The remaining checks are signing-only and depend on request context.
  if (isSigning) {
    // 6. Protocol allowlist.
    const protocol = ctx.request.protocolId;
    const protocolProgram = ctx.request.protocolProgram ?? null;
    if (!protocol) {
      if (protocolProgram) {
        // A program is targeted but it maps to no known/allowlisted protocol_id
        // (unmapped adapter). The orchestrator derives protocol_id via
        // protocolIdForProgram and gets null for unknown programs; treating that
        // as n/a would let an ER targeting an unmapped program clear the
        // allowlist off-chain. Fail-closed instead (on-chain still blocks too).
        add(
          "protocol_allowlist",
          !failClosed,
          `protocol_program ${protocolProgram} supplied but maps to no allowlisted protocol_id — fail-closed`,
          true,
        );
      } else {
        // No protocol on the request (e.g. non-strategy action): not applicable.
        add("protocol_allowlist", true, "no protocol on request (n/a)");
      }
    } else if (ctx.approvedProtocols.length === 0) {
      add(
        "protocol_allowlist",
        !failClosed,
        "approved-protocol allowlist unknown",
        true,
      );
    } else {
      const ok = ctx.approvedProtocols.includes(protocol);
      add(
        "protocol_allowlist",
        ok,
        ok ? `protocol ${protocol} approved` : `protocol ${protocol} NOT in allowlist`,
      );
    }

    // 7. Allocation cap (cumulative, PER-PROTOCOL): targetDeployed + amount <=
    // cap * NAV. The cap (`maxSingleAllocationBps`) is per-protocol, so the
    // deployed term must be the TARGET protocol's already-deployed capital
    // (`targetProtocolDeployedBaseUnits`), NOT the vault-wide deployed total —
    // otherwise capital held in OTHER protocols wrongly blocks a legitimate
    // deploy. The vault-wide total is only a fallback for legacy contexts that
    // do not thread the per-protocol figure; the separate global_deployment_cap
    // (7b) enforces the vault-wide total against its own bps. Prefer on-chain
    // base-unit NAV/deployed so the comparison is unit-consistent with the
    // base-unit request amount (the USD snapshot value is only a fallback for
    // contexts that lack the on-chain reads, e.g. eval fixtures).
    const nav = ctx.treasury.navBaseUnits ?? ctx.treasury.totalValueUsd;
    const capBps = ctx.riskParams.maxSingleAllocationBps;
    const amount = ctx.request.amount ?? null;
    const deployed = ctx.request.targetProtocolDeployedBaseUnits ??
      ctx.treasury.deployedBaseUnits ?? sumDeployed(ctx);
    if (capBps == null || nav == null || amount == null || deployed == null) {
      add(
        "allocation_cap",
        !failClosed,
        "cap inputs incomplete (cap/nav/amount/target-protocol deployed)",
        true,
      );
    } else {
      const capValue = (capBps * nav) / 10_000;
      const ok = deployed + amount <= capValue;
      add(
        "allocation_cap",
        ok,
        `target-protocol deployed+amount ${deployed + amount} vs per-protocol cap ${capValue}`,
      );
    }

    // 7b–7e. Continuous constitution-policy guardrails. These mirror the
    // on-chain invariants (nave_execution) so the off-chain pipeline refuses to
    // even produce a signable decision that would breach policy. All are
    // expressed against authoritative base-unit NAV/deployed. A bps floor/cap of
    // 0 (or undefined) means "unset" and disables that constraint, matching the
    // on-chain semantics — unless requireCompleteConstitution is set, in which
    // case 0 fails closed.
    const navBu = ctx.treasury.navBaseUnits ?? null;
    const deployedBu = ctx.treasury.deployedBaseUnits ?? sumDeployed(ctx);
    const amt = ctx.request.amount ?? null;
    const projected =
      deployedBu != null && amt != null ? deployedBu + amt : null;

    // 7b. Global deployment cap: deployed + amount <= maxTotalDeployedBps * NAV.
    const maxDeployedBps = ctx.riskParams.maxTotalDeployedBps;
    if (!maxDeployedBps || maxDeployedBps <= 0) {
      if (requireComplete) {
        add(
          "global_deployment_cap",
          false,
          "global deployment cap unset — fail-closed (requireCompleteConstitution)",
          true,
        );
      } else {
        add("global_deployment_cap", true, "global deployment cap unset (n/a)");
      }
    } else if (navBu == null || projected == null) {
      add("global_deployment_cap", !failClosed, "global cap inputs incomplete (nav/deployed/amount)", true);
    } else {
      const cap = (maxDeployedBps * navBu) / 10_000;
      const ok = projected <= cap;
      add("global_deployment_cap", ok, `deployed+amount ${projected} vs global cap ${cap}`);
    }

    // 7c. Liquidity floor: NAV - (deployed + amount) >= minLiquidityBps * NAV.
    const minLiqBps = ctx.riskParams.minLiquidityBps ?? ctx.riskParams.minReservesBps;
    if (!minLiqBps || minLiqBps <= 0) {
      if (requireComplete) {
        add(
          "liquidity_floor",
          false,
          "liquidity floor unset — fail-closed (requireCompleteConstitution)",
          true,
        );
      } else {
        add("liquidity_floor", true, "liquidity floor unset (n/a)");
      }
    } else if (navBu == null || projected == null) {
      add("liquidity_floor", !failClosed, "liquidity inputs incomplete (nav/deployed/amount)", true);
    } else {
      const liquidAfter = navBu - projected;
      const floor = (minLiqBps * navBu) / 10_000;
      const ok = liquidAfter >= floor;
      add("liquidity_floor", ok, `liquid-after ${liquidAfter} vs floor ${floor}`);
    }

    // An "executable strategy deploy" is a signing action that MOVES capital out
    // of reserves into a strategy (protocol + positive amount, not a withdraw).
    // The reserve-floor and NAV-freshness gates only constrain deploys: a
    // withdraw or a non-strategy approval cannot breach the reserve floor.
    const actionNorm = norm(ctx.request.actionType ?? "");
    const isWithdraw = actionNorm.includes("withdraw");
    const isStrategyDeploy = !!protocol && amt != null && amt > 0 && !isWithdraw;

    // 7d. Stablecoin reserve floor — HARD BLOCK for executable strategy deploys.
    // A configured reserve floor must be provably satisfied before capital can
    // leave reserves. The floor only BINDS once the treasury actually holds
    // stablecoins: a treasury seeded entirely with SOL-like assets (the
    // bootstrap state) holds none yet, so there is no stablecoin reserve that a
    // deploy could draw below the floor — the floor is satisfied/not-applicable.
    // Once stablecoins exist (measurable balance > 0, or the snapshot reports a
    // positive stablecoin/USDC holding) the floor is enforced numerically; and
    // if stablecoins are present but their precise composition is unmeasurable
    // we still BLOCK (an unprovable floor over a real stablecoin reserve is
    // treated as a violated floor — fail-closed). The no-data case is already
    // guarded by snapshot_freshness above, so reaching here means a snapshot was
    // available and its stablecoin reading can be trusted.
    const reserveBps = ctx.riskParams.minStablecoinReserveBps;
    const stableBu = ctx.treasury.stablecoinBaseUnits ?? null;
    // Treasury holds stablecoins when either the measured base-unit balance is
    // positive, or the snapshot's USD-denominated stablecoin (USDC) balance is
    // positive. A SOL-only bootstrap treasury reports neither.
    const usdcBalance = ctx.treasury.usdcBalance ?? null;
    const holdsStablecoins =
      (stableBu != null && stableBu > 0) || (usdcBalance != null && usdcBalance > 0);
    if (!reserveBps || reserveBps <= 0) {
      if (requireComplete) {
        add(
          "reserve_floor",
          false,
          "stablecoin reserve floor unset — fail-closed (requireCompleteConstitution)",
          true,
        );
      } else {
        add("reserve_floor", true, "stablecoin reserve floor unset (n/a)");
      }
    } else if (!isStrategyDeploy) {
      add("reserve_floor", true, "not an executable strategy deploy (n/a)");
    } else if (!holdsStablecoins) {
      add(
        "reserve_floor",
        true,
        "treasury holds no stablecoins — reserve floor not yet binding (n/a)",
      );
    } else if (navBu == null) {
      add("reserve_floor", false, "reserve floor set but NAV unknown — deploy blocked");
    } else if (stableBu == null) {
      add(
        "reserve_floor",
        false,
        "stablecoin reserve composition unmeasurable — deploy blocked (cannot prove reserve floor)",
      );
    } else {
      const floor = (reserveBps * navBu) / 10_000;
      const ok = stableBu >= floor;
      add("reserve_floor", ok, `stablecoin ${stableBu} vs reserve floor ${floor}`);
    }

    // 7f. NAV freshness (feature-detected). When the on-chain treasury vault
    // exposes `last_revalued_at` AND a freshness window is configured, an
    // executable deploy must be priced against a recently-revalued NAV (stale
    // NAV would corrupt the cap/floor math). Resilient pre-rollout: when the
    // field is absent (undefined/null) or no window is set, the check is n/a.
    const navRevaluedAt = ctx.treasury.navLastRevaluedAt ?? null;
    if (!isStrategyDeploy) {
      add("nav_freshness", true, "not an executable strategy deploy (n/a)");
    } else if (navRevaluedAt == null) {
      if (requireComplete) {
        add(
          "nav_freshness",
          false,
          "NAV last_revalued_at missing — fail-closed (requireCompleteConstitution)",
          true,
        );
      } else {
        add("nav_freshness", true, "NAV last_revalued_at not available (n/a)", true);
      }
    } else if (!maxNavAge || maxNavAge <= 0) {
      if (requireComplete) {
        add(
          "nav_freshness",
          false,
          "NAV freshness window unset — fail-closed (requireCompleteConstitution)",
          true,
        );
      } else {
        add("nav_freshness", true, "NAV freshness window unset (n/a)");
      }
    } else {
      const now = opts.nowSecs ?? Math.floor(Date.now() / 1000);
      const ageSecs = now - navRevaluedAt;
      const ok = ageSecs <= maxNavAge;
      add(
        "nav_freshness",
        ok,
        ok
          ? `NAV revalued ${ageSecs}s ago (<= ${maxNavAge}s)`
          : `NAV stale: revalued ${ageSecs}s ago (> ${maxNavAge}s)`,
      );
    }

    // 7e. Rebalance interval eligibility. Only applies when this action claims
    // to be a rebalance (action type or a `rebalance` risk flag); a premature
    // forced rebalance (cadence not yet elapsed) is blocked.
    const isRebalance =
      norm(ctx.request.actionType ?? "").includes("rebalance") ||
      flags.some((f) => f.includes("rebalance")) ||
      (requireComplete && ctx.policyIntent === "rebalance");
    const freq = ctx.riskParams.rebalanceFrequencySecs;
    const last = ctx.riskParams.lastRebalanceAt;
    if (!isRebalance) {
      add("rebalance_interval", true, "not a rebalance action (n/a)");
    } else if (!freq || freq <= 0) {
      add("rebalance_interval", true, "rebalance cadence unset (n/a)");
    } else if (last == null) {
      add("rebalance_interval", !failClosed, "rebalance cadence missing last_rebalance_at", true);
    } else {
      const now = opts.nowSecs ?? Math.floor(Date.now() / 1000);
      const due = now - last >= freq;
      add("rebalance_interval", due, due ? "rebalance due" : `rebalance not due (${now - last}s of ${freq}s)`);
    }

    // 8. Payload-hash equality (defense-in-depth; on-chain also enforces it).
    const expected = ctx.request.expectedPayloadHash;
    const got = output.payload_hash;
    if (!expected) {
      add(
        "payload_hash_equality",
        !failClosed,
        "expected payload hash unknown",
        true,
      );
    } else if (!got) {
      add("payload_hash_equality", false, "model produced no payload hash");
    } else {
      const ok = got.toLowerCase() === expected.toLowerCase();
      add(
        "payload_hash_equality",
        ok,
        ok ? "payload hash matches" : "payload hash MISMATCH",
      );
    }
  }

  const actionNormEnd = norm(ctx.request.actionType ?? "");
  const amountEnd = ctx.request.amount ?? null;
  const isDeploy = !!ctx.request.protocolId && amountEnd != null && amountEnd > 0 && !actionNormEnd.includes("withdraw");
  const clearing =
    actionNormEnd.includes("clear_halt") ||
    actionNormEnd.includes("operational_clear") ||
    output.should_clear_halt === true;
  const charterGate = opts.genlayerGate ?? readGenlayerFlag(NAVE_GENLAYER_GATE);
  const venueGate = opts.genlayerVenueGate ?? readGenlayerFlag(NAVE_GENLAYER_VENUE_GATE);
  const haltGate = opts.genlayerHaltGate ?? readGenlayerFlag(NAVE_GENLAYER_HALT_GATE);
  const expectedAction = ctx.request.expectedPayloadHash ?? output.payload_hash ?? "";

  const charter = charterGateOutcome({
    gateOn: charterGate,
    signing: isSigning,
    expectedActionHash: expectedAction,
    charter: ctx.genlayer?.charter,
  });
  const venue = venueGateOutcome({
    gateOn: venueGate,
    isDeploy,
    venue: ctx.genlayer?.venue,
  });
  const halt = haltGateOutcome({
    gateOn: haltGate,
    clearing,
    halt: ctx.genlayer?.halt,
  });
  const pushOutcome = (id: CheckId, outcome: { block: boolean; indeterminate: boolean; recordedOnly: boolean; detail: string }) => {
    add(id, !outcome.block, outcome.detail, outcome.indeterminate, outcome.recordedOnly ? "warning" : "critical");
  };
  pushOutcome("genlayer_charter", charter);
  pushOutcome("genlayer_venue", venue);
  pushOutcome("genlayer_halt", halt);

  const failures = checks
    .filter((c) => !c.ok && c.severity === "critical")
    .map((c) => `${c.id}: ${c.detail}`);
  const pass = failures.length === 0;
  const shouldSign = pass && isSigning && output.should_sign === true;

  return { pass, shouldSign, checks, failures };
}

/** Best-effort sum of deployed capital from snapshot strategy positions. */
function sumDeployed(ctx: AgentContext): number | null {
  const positions = ctx.treasury.strategyPositions;
  if (!Array.isArray(positions) || positions.length === 0) return 0;
  let total = 0;
  for (const p of positions) {
    const v = (p as Record<string, unknown>).current_value ??
      (p as Record<string, unknown>).currentValue ??
      (p as Record<string, unknown>).value;
    const n = typeof v === "number" ? v : Number(v);
    if (Number.isNaN(n)) return null;
    total += n;
  }
  return total;
}
