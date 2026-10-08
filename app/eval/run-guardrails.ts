// Deterministic guardrails eval runner (Phase 7).
//
// Runs the canonical guardrail fixtures through the SAME module the dispatcher
// uses (supabase/functions/_shared/guardrails.ts), asserting that known-bad
// scenarios are rejected before any signing. This is the gate that must be
// green before a fine-tuned model is allowed to influence signing.
//
// Run with either runtime:
//   npx -y tsx eval/run-guardrails.ts          (Node)
//   deno run --allow-read eval/run-guardrails.ts (Deno)
//
// Exit code 0 = all fixtures matched expectations; 1 = at least one mismatch.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { evaluateGuardrails } from "../supabase/functions/_shared/guardrails.ts";
import type { AgentContext, AgentRole } from "../supabase/functions/_shared/agentContext.ts";

interface Fixture {
  name: string;
  description: string;
  role: AgentRole;
  options?: Record<string, unknown>;
  context: AgentContext;
  output: Record<string, unknown>;
  expect: { pass: boolean; shouldSign: boolean; mustFail: string[] };
}

const path = fileURLToPath(new URL("./fixtures/guardrails.json", import.meta.url));
const fixtures: Fixture[] = JSON.parse(await readFile(path, "utf8"));

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

  const problems: string[] = [];
  if (verdict.pass !== fx.expect.pass) {
    problems.push(`pass: expected ${fx.expect.pass}, got ${verdict.pass}`);
  }
  if (verdict.shouldSign !== fx.expect.shouldSign) {
    problems.push(`shouldSign: expected ${fx.expect.shouldSign}, got ${verdict.shouldSign}`);
  }
  for (const id of fx.expect.mustFail) {
    const c = verdict.checks.find((c) => c.id === id);
    if (!c || c.ok) {
      problems.push(`expected check '${id}' to FAIL but it did not`);
    }
  }

  if (problems.length === 0) {
    console.log(`PASS  ${fx.name}`);
  } else {
    failures++;
    console.error(`FAIL  ${fx.name}`);
    for (const p of problems) console.error(`        - ${p}`);
    console.error(`        failures: ${verdict.failures.join(" | ") || "(none)"}`);
  }
}

console.log(`\n${fixtures.length - failures}/${fixtures.length} fixtures passed.`);
process.exit(failures > 0 ? 1 : 0);
