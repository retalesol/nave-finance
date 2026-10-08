// Agent decision-contract test (pre-redeploy hardening, finding #1).
//
// The dispatcher's Operational output schema can only ever emit
//   continue | halt | clear_halt | request_review
// but the orchestrator used to gate autonomous execution on `decision ===
// "approve"`, so execution was dead code. Both sides now import the decision
// vocabulary from `_shared/agentContracts.ts`; this harness pins the contract:
//
//   1. postReviewAction() (what the orchestrator runs) accepts EXACTLY the
//      Operational enum — every enum member maps to a defined action and every
//      non-member (including "approve") never executes.
//   2. The ONLY executing decision is `continue` with no halt / guardrail failures.
//   3. Source-level: the dispatcher's Operational JSON schema text lists exactly
//      the enum; the dispatcher validates with the shared validators; and the
//      orchestrator has no `decision === "approve"` execution gate left.
//
// Deterministic, no network. Run with either runtime:
//   npx -y tsx eval/run-agent-contracts.ts
//   deno run --allow-read eval/run-agent-contracts.ts
// Exit code 0 = contract holds; 1 = at least one assertion failed.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  isOperationalDecision,
  isSigningDecision,
  OPERATIONAL_DECISIONS,
  OPERATIONAL_EXECUTE_DECISIONS,
  OPERATIONAL_EXPIRE_DECISIONS,
  type PostReviewAction,
  postReviewAction,
  SIGNING_DECISIONS,
} from "../supabase/functions/_shared/agentContracts.ts";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    console.log(`PASS  ${name}`);
  } else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n        - ${detail}` : ""}`);
  }
}

const read = (rel: string) => readFile(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const dispatcherSrc = await read("../supabase/functions/agent-dispatcher/index.ts");
const orchestratorSrc = await read("../supabase/functions/agent-orchestrator/index.ts");

// ── 1. Enum shape ─────────────────────────────────────────────────────────────
check(
  "operational enum is exactly continue|halt|clear_halt|request_review",
  JSON.stringify([...OPERATIONAL_DECISIONS].sort()) ===
    JSON.stringify(["clear_halt", "continue", "halt", "request_review"]),
  `got ${JSON.stringify(OPERATIONAL_DECISIONS)}`,
);
check(
  "signing enum is exactly approve|reject|request_review",
  JSON.stringify([...SIGNING_DECISIONS].sort()) ===
    JSON.stringify(["approve", "reject", "request_review"]),
  `got ${JSON.stringify(SIGNING_DECISIONS)}`,
);
check(
  "execute/expire subsets are members of the operational enum",
  [...OPERATIONAL_EXECUTE_DECISIONS, ...OPERATIONAL_EXPIRE_DECISIONS].every(isOperationalDecision),
);
check("'approve' is NOT an operational decision", !isOperationalDecision("approve"));
check("'continue' is NOT a signing decision", !isSigningDecision("continue"));

// ── 2. postReviewAction routing (orchestrator's accepted set == dispatcher enum)
const grace = [{ graceElapsed: false }, { graceElapsed: true }];
const routed = new Map<string, Set<PostReviewAction>>();
for (const d of OPERATIONAL_DECISIONS) {
  const set = new Set<PostReviewAction>();
  for (const g of grace) set.add(postReviewAction({ decision: d, should_halt: false, guardrail_failures: [] }, g));
  routed.set(d, set);
}
check(
  "every operational decision routes to a defined action",
  [...routed.values()].every((s) => [...s].every((a) => ["execute", "expire", "park"].includes(a))),
  JSON.stringify([...routed.entries()].map(([k, v]) => [k, [...v]])),
);

const executing = OPERATIONAL_DECISIONS.filter((d) =>
  grace.some((g) =>
    postReviewAction({ decision: d, should_halt: false, guardrail_failures: [] }, g) === "execute"
  )
);
check(
  "the ONLY executing operational decision is 'continue'",
  JSON.stringify(executing) === JSON.stringify(["continue"]),
  `executing set = ${JSON.stringify(executing)}`,
);
check(
  "'continue' executes when clean (no halt, no guardrail failures)",
  postReviewAction({ decision: "continue", should_halt: false, guardrail_failures: [] }, { graceElapsed: false }) ===
    "execute",
);
check(
  "'continue' with guardrail failures never executes",
  grace.every((g) =>
    postReviewAction({ decision: "continue", should_halt: false, guardrail_failures: ["x"] }, g) !== "execute"
  ),
);
check(
  "'continue' with should_halt never executes (parks for halt path)",
  grace.every((g) =>
    postReviewAction({ decision: "continue", should_halt: true, guardrail_failures: [] }, g) === "park"
  ),
);
check(
  "'halt' expires the request",
  grace.every((g) => postReviewAction({ decision: "halt", should_halt: false, guardrail_failures: [] }, g) === "expire"),
);
check(
  "'request_review' parks, then expires only after grace",
  postReviewAction({ decision: "request_review", guardrail_failures: [] }, { graceElapsed: false }) === "park" &&
    postReviewAction({ decision: "request_review", guardrail_failures: [] }, { graceElapsed: true }) === "expire",
);
check(
  "'clear_halt' parks, then expires only after grace",
  postReviewAction({ decision: "clear_halt", guardrail_failures: [] }, { graceElapsed: false }) === "park" &&
    postReviewAction({ decision: "clear_halt", guardrail_failures: [] }, { graceElapsed: true }) === "expire",
);
for (const stray of ["approve", "reject", "", undefined, null, 42, "CONTINUE"]) {
  check(
    `non-enum decision ${JSON.stringify(stray)} never executes`,
    grace.every((g) => postReviewAction({ decision: stray, guardrail_failures: [] }, g) !== "execute"),
  );
}

// ── 3. Source-level contract ──────────────────────────────────────────────────
// Dispatcher: the Operational JSON schema shown to the model lists exactly the enum.
const schemaUnions = [...dispatcherSrc.matchAll(/"decision":\s*((?:"[a-z_]+"\s*\|\s*)*"[a-z_]+")/g)]
  .map((m) => m[1].split("|").map((s) => s.trim().replace(/"/g, "")).sort());
const opSchemas = schemaUnions.filter((u) => u.includes("continue"));
const signingSchemas = schemaUnions.filter((u) => !u.includes("continue"));
check(
  "dispatcher Operational prompt schema lists exactly the shared enum",
  opSchemas.length === 1 &&
    JSON.stringify(opSchemas[0]) === JSON.stringify([...OPERATIONAL_DECISIONS].sort()),
  `operational prompt schema(s) = ${JSON.stringify(opSchemas)}`,
);
check(
  "dispatcher signing prompt schemas (executive/financial/oversight) list exactly the shared enum",
  signingSchemas.length === 3 &&
    signingSchemas.every((u) => JSON.stringify(u) === JSON.stringify([...SIGNING_DECISIONS].sort())),
  `signing prompt schema(s) = ${JSON.stringify(signingSchemas)}`,
);
check(
  "dispatcher imports the shared contract validators",
  /from\s+"\.\.\/_shared\/agentContracts\.ts"/.test(dispatcherSrc) &&
    /isOperationalDecision\(o\.decision\)/.test(dispatcherSrc) &&
    /isSigningDecision\(o\.decision\)/.test(dispatcherSrc),
);
check(
  "dispatcher does not redefine the decision unions locally",
  !/type\s+OperationalDecision\s*=\s*"/.test(dispatcherSrc) && !/type\s+SigningDecision\s*=\s*"/.test(dispatcherSrc),
);
check(
  "dispatcher Operational prompt tells the model 'continue' means proceed to execution",
  /"continue":[\s\S]{0,400}?PROCEED TO EXECUTION/.test(dispatcherSrc),
);
// Orchestrator: routes via the shared contract and has no "approve" execution gate.
check(
  "orchestrator imports postReviewAction from the shared contract",
  /postReviewAction[^\n]*\n?[^\n]*from\s+"\.\.\/_shared\/agentContracts\.ts"/.test(orchestratorSrc) ||
    /import\s*\{[^}]*postReviewAction[^}]*\}\s*from\s+"\.\.\/_shared\/agentContracts\.ts"/.test(orchestratorSrc),
);
check(
  "orchestrator calls postReviewAction for the post-review execute/expire branch",
  /postReviewAction\(/.test(orchestratorSrc.replace(/import[^;]*;/g, "")),
);
// The only remaining `decision === "approve"` must be the SIGNING-role gate,
// explicitly excluding operational.
const approveGates = [...orchestratorSrc.matchAll(/decision === "approve"[^\n]*/g)].map((m) => m[0]);
check(
  "orchestrator has no operational execution gate on decision === 'approve'",
  approveGates.every((line) => /agentRole !== "operational"/.test(line)),
  `gates: ${JSON.stringify(approveGates)}`,
);

console.log(`\n${failures === 0 ? "agent decision contract holds." : `${failures} contract assertion(s) failed.`}`);
process.exit(failures > 0 ? 1 : 0);
