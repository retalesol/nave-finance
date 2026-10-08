// Prompt-regression decision scorecard (Workstream B / D).
//
// Where run-guardrails.ts asserts only the guardrail PASS/SIGN verdict, this
// harness asserts the FINAL post-guardrail DECISION the dispatcher would emit
// for a recorded `(AgentContext + recorded model output)` pair. It exists so
// that edits to the agent SYSTEM PROMPTS — which change the model's recorded
// output — can be measured against golden expected decisions instead of vibes.
//
// Why this is deterministic / CI-safe: it does NOT call the live model. Each
// fixture freezes a recorded model output and asserts that the deterministic
// layer (evaluateGuardrails + the dispatcher's finalDecision/finalShouldSign
// derivation) maps it to a stable verdict + decision. When a prompt change
// alters recorded outputs, regenerate the fixtures from new traces and this
// harness pins the deterministic consequences (no silent signing-behavior drift).
//
// The decision derivation mirrors agent-dispatcher/index.ts EXACTLY:
//   finalDecision   = guardrailFailures.length > 0 ? "request_review" : output.decision
//   finalShouldSign = verdict.shouldSign  (pass && isSigning && output.should_sign)
//
// Run with either runtime:
//   npx -y tsx eval/run-decisions.ts            (Node)
//   deno run --allow-read eval/run-decisions.ts (Deno)
//
// Exit code 0 = all fixtures matched expectations; 1 = at least one mismatch.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { evaluateGuardrails } from "../supabase/functions/_shared/guardrails.ts";
import type { AgentContext, AgentRole } from "../supabase/functions/_shared/agentContext.ts";

interface DecisionFixture {
  name: string;
  description: string;
  role: AgentRole;
  options?: Record<string, unknown>;
  /** Canonical AgentContext (same shape as guardrails fixtures). */
  context: AgentContext;
  /** Recorded model output (frozen; stands in for a live inference). */
  output: Record<string, unknown>;
  expect: {
    /** Guardrail verdict: every critical check passed. */
    pass: boolean;
    /** Final signing eligibility after guardrails. */
    shouldSign: boolean;
    /** Final post-guardrail decision the dispatcher would log/return. */
    decision: string;
    /** Critical checks that MUST be in the failure set (subset assertion). */
    mustFail: string[];
  };
}

/** Mirror of agent-dispatcher: a blocked verdict downgrades to request_review. */
function deriveFinalDecision(modelDecision: string, blocked: boolean): string {
  return blocked ? "request_review" : modelDecision;
}

const path = fileURLToPath(new URL("./fixtures/decisions.json", import.meta.url));
const fixtures: DecisionFixture[] = JSON.parse(await readFile(path, "utf8"));

let failures = 0;

for (const fx of fixtures) {
  const verdict = evaluateGuardrails(
    fx.role,
    fx.context,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fx.output as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (fx.options ?? {}) as any,
  );

  const blocked = verdict.failures.length > 0;
  const modelDecision = String(fx.output.decision ?? "");
  const finalDecision = deriveFinalDecision(modelDecision, blocked);
  const finalShouldSign = verdict.shouldSign;

  const problems: string[] = [];
  if (verdict.pass !== fx.expect.pass) {
    problems.push(`pass: expected ${fx.expect.pass}, got ${verdict.pass}`);
  }
  if (finalShouldSign !== fx.expect.shouldSign) {
    problems.push(`shouldSign: expected ${fx.expect.shouldSign}, got ${finalShouldSign}`);
  }
  if (finalDecision !== fx.expect.decision) {
    problems.push(`decision: expected '${fx.expect.decision}', got '${finalDecision}'`);
  }
  for (const id of fx.expect.mustFail) {
    const c = verdict.checks.find((c) => c.id === id);
    if (!c || c.ok) {
      problems.push(`expected check '${id}' to FAIL but it did not`);
    }
  }

  if (problems.length === 0) {
    console.log(`PASS  ${fx.name}  ->  ${finalDecision}${finalShouldSign ? " (sign)" : ""}`);
  } else {
    failures++;
    console.error(`FAIL  ${fx.name}`);
    for (const p of problems) console.error(`        - ${p}`);
    console.error(`        failures: ${verdict.failures.join(" | ") || "(none)"}`);
  }
}

console.log(`\n${fixtures.length - failures}/${fixtures.length} decision fixtures passed.`);
process.exit(failures > 0 ? 1 : 0);
