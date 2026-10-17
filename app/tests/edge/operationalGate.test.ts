import assert from "node:assert/strict";
import test from "node:test";
import { haltCausesFrom, operationalGate } from "../../supabase/functions/_shared/operationalGate.ts";

const green = [
  { id: "role_valid", ok: true, severity: "critical" },
  { id: "liquidity_floor", ok: true, severity: "critical" },
  { id: "nav_freshness", ok: true, severity: "critical" },
];

test("continue executes only after the review window with green guardrails", () => {
  const base = {
    action: "continue" as const,
    status: "InReview",
    reviewEndSecs: 1_000,
    checks: green,
    guardrailFailures: [],
    openHaltCauses: null,
  };
  assert.equal(operationalGate({ ...base, nowSecs: 999 }).ok, false);
  const ok = operationalGate({ ...base, nowSecs: 1_000 });
  assert.equal(ok.ok, true);
  assert.ok(ok.reasons.includes("review window passed"));
});

test("continue is refused when guardrails did not run or one fails", () => {
  const base = {
    action: "continue" as const,
    status: "InReview",
    nowSecs: 2_000,
    reviewEndSecs: 1_000,
    guardrailFailures: [],
    openHaltCauses: null,
  };
  assert.deepEqual(operationalGate({ ...base, checks: [] }).blockers, ["guardrails did not run"]);
  const failing = [...green.slice(0, 2), { id: "nav_freshness", ok: false, severity: "critical" }];
  assert.equal(operationalGate({ ...base, checks: failing }).ok, false);
  const warningOnly = [...green, { id: "agents_enabled", ok: false, severity: "warning" }];
  assert.equal(operationalGate({ ...base, checks: warningOnly }).ok, true);
});

test("a model-only halt (openHaltCauses: []) can be cleared when all deterministic checks and guardrails pass", () => {
  const r = operationalGate({
    action: "clear_halt",
    status: "Halted",
    nowSecs: 2_000,
    reviewEndSecs: 1_000,
    checks: [
      ...green,
      { id: "genlayer_venue", ok: true, indeterminate: true, severity: "critical" },
      { id: "genlayer_halt", ok: true, indeterminate: true, severity: "critical" },
    ],
    guardrailFailures: [],
    openHaltCauses: [],
  });
  assert.equal(r.ok, true);
  assert.ok(r.reasons.some((x) => x.includes("model-initiated halt cleared")));

  const blockedByFailure = operationalGate({
    action: "clear_halt",
    status: "Halted",
    nowSecs: 2_000,
    reviewEndSecs: 1_000,
    checks: green,
    guardrailFailures: ["manual guardrail failure"],
    openHaltCauses: [],
  });
  assert.equal(blockedByFailure.ok, false);

  const blockedByGenlayer = operationalGate({
    action: "clear_halt",
    status: "Halted",
    nowSecs: 2_000,
    reviewEndSecs: 1_000,
    checks: [...green, { id: "genlayer_halt", ok: false, severity: "critical" }],
    guardrailFailures: [],
    openHaltCauses: [],
  });
  assert.equal(blockedByGenlayer.ok, false);
});

test("clear_halt needs every recorded halt cause to pass again", () => {
  const halted = haltCausesFrom([
    { id: "liquidity_floor", ok: false, severity: "critical" },
    { id: "confidence_threshold", ok: false, severity: "critical" },
    { id: "nav_freshness", ok: true, severity: "critical" },
  ]);
  assert.deepEqual(halted, ["liquidity_floor"]);
  const base = {
    action: "clear_halt" as const,
    status: "Halted",
    nowSecs: 2_000,
    reviewEndSecs: 1_000,
    guardrailFailures: [],
    openHaltCauses: halted,
  };
  assert.equal(operationalGate({ ...base, checks: green }).ok, true);
  const stillFailing = [{ id: "liquidity_floor", ok: false, severity: "critical" }];
  assert.equal(operationalGate({ ...base, checks: stillFailing }).ok, false);
  const missing = [{ id: "role_valid", ok: true, severity: "critical" }];
  assert.equal(operationalGate({ ...base, checks: missing }).ok, false);
  assert.equal(operationalGate({ ...base, checks: green, openHaltCauses: null }).ok, false);
});
