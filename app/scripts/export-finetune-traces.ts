// Fine-tuning trace-export job (Workstream D).
//
// Captures the supervised dataset for graduating the advisory agent model into a
// fine-tuned model. It is READ-ONLY on the database and emits JSONL — one row per
// recorded model DECISION — assembling four things the plan requires:
//
//   (1) the reconstructed/available AgentContext signal,
//   (2) the model output (raw_claude_response / decision / confidence / risk_flags),
//   (3) the deterministic guardrail verdict (status completed vs guardrail_blocked
//       + error_message), and
//   (4) the final on-chain OUTCOME, joined from subsequent signing / execute /
//       expire / halt logs (and tx_signature) for the SAME
//       execution_request_address.
//
// It then derives an outcome-based LABEL (see LABEL DEFINITION below).
//
// ─────────────────────────────────────────────────────────────────────────────
// SOURCE OF TRUTH: the `agent_action_logs` table. The dispatcher writes one row
// per model decision with `raw_claude_response` populated (action_type
// `pipeline_<role>` or `inference`, status `completed` | `guardrail_blocked` |
// `error`). The orchestrator writes OUTCOME rows for the same
// `execution_request_address` with `raw_claude_response = null` (action_type
// `signing` | `execute_strategy` | `jupiter_deposit` | `withdraw_from_strategy` |
// `halt` | `clear_halt` | `expire_request`) carrying the on-chain `tx_signature`.
// We treat rows WITH a non-null raw_claude_response AND a decision as the model
// traces, and join the rest as outcomes.
//
// NOTE: agent_action_logs does NOT persist the full AgentContext, so the context
// signal here is the subset recoverable from the log (dao, role, action, the
// payload hash bound to the request, and the constitution_check the signing agent
// evaluated). A future context-snapshot column could enrich this without changing
// the row schema below.
//
// ─────────────────────────────────────────────────────────────────────────────
// LABEL DEFINITION (outcome-based; documented for the fine-tuning gate):
//
//   good       — the deterministic guardrails PASSED (status === "completed") AND
//                the on-chain outcome matched the model's intent:
//                  decision=approve  → executed or signed (and not expired/halted)
//                  decision=halt     → halted on-chain
//                  decision=reject / request_review → expired (not executed)
//   bad        — any of:
//                  • guardrail_blocked (model output rejected by guardrails), OR
//                  • the model approved something the chain/guardrails rejected
//                    (approve → expired, or approve → halted-for-risk), OR
//                  • the decision contradicts the realized chain state
//                    (e.g. reject → executed).
//   unlabeled  — no terminal on-chain outcome yet (still pending / in-review), or
//                a decision with no defined expected outcome. Excluded from
//                precision/recall but retained for inspection.
//
// The label is advisory training signal ONLY. Signing authority always remains
// the deterministic guardrails + on-chain invariants, never the model or label.
//
// ─────────────────────────────────────────────────────────────────────────────
// USAGE (fail-closed on missing env):
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//     npx -y tsx scripts/export-finetune-traces.ts [--out file.jsonl] [--limit N] [--dao <addr>]
//
//   --out <path>   write JSONL to a file (default: stdout)
//   --limit <n>    max model-decision rows to scan (default: 5000)
//   --dao <addr>   restrict to a single dao_onchain_address
//
// Read-only: issues only SELECT queries. Never writes to the database.

import { writeFile } from "node:fs/promises";
import process from "node:process";
import { createClient } from "@supabase/supabase-js";

export const FT_TRACE_SCHEMA_VERSION = "ft-trace/1.1.0";

/** Outcome action types written by the orchestrator for an execution request. */
const OUTCOME_ACTIONS = new Set([
  "signing",
  "execute_strategy",
  "jupiter_deposit",
  "withdraw_from_strategy",
  "halt",
  "clear_halt",
  "expire_request",
]);

const EXECUTE_ACTIONS = new Set([
  "execute_strategy",
  "jupiter_deposit",
  "withdraw_from_strategy",
]);

interface LogRow {
  id: string;
  dao_onchain_address: string;
  agent_role: string;
  action_type: string;
  reasoning: string | null;
  constitution_check: unknown;
  payload_hash: string | null;
  execution_request_address: string | null;
  status: string;
  error_message: string | null;
  confidence_score: number | null;
  risk_flags: unknown;
  decision: string | null;
  claude_model: string | null;
  raw_claude_response: string | null;
  reasoning_hash: string | null;
  tx_signature: string | null;
  created_at: string;
}

interface OutcomeEvent {
  action_type: string;
  status: string;
  decision: string | null;
  tx_signature: string | null;
  created_at: string;
}

interface Outcome {
  signed: boolean;
  executed: boolean;
  expired: boolean;
  halted: boolean;
  tx_signatures: string[];
  terminal: "executed" | "signed" | "expired" | "halted" | "pending";
  events: OutcomeEvent[];
}

export interface FineTuneTraceRow {
  schema_version: string;
  id: string;
  dao: string;
  execution_request_address: string;
  agent_role: string;
  action_type: string;
  created_at: string;
  claude_model: string | null;
  reasoning_hash: string | null;
  context_signal: {
    dao: string;
    agent_role: string;
    action_type: string;
    protocol_payload_hash: string | null;
    constitution_check: unknown;
  };
  model_output: {
    decision: string | null;
    confidence: number | null;
    risk_flags: string[];
    raw_response: string | null;
    reasoning: string | null;
  };
  guardrail_verdict: {
    status: string;
    blocked: boolean;
    error_message: string | null;
  };
  outcome: Outcome;
  label: "good" | "bad" | "unlabeled";
  label_reason: string;
}

function toStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x));
  return [];
}

/** Reduce all outcome logs for one execution request into a terminal outcome. */
function deriveOutcome(rows: LogRow[]): Outcome {
  const events: OutcomeEvent[] = [];
  const txSigs = new Set<string>();
  let signed = false;
  let executed = false;
  let expired = false;
  let halted = false;

  for (const r of rows) {
    if (!OUTCOME_ACTIONS.has(r.action_type)) continue;
    const completed = r.status === "completed";
    const sig = r.tx_signature && r.tx_signature.length > 0 ? r.tx_signature : null;
    if (sig) txSigs.add(sig);
    events.push({
      action_type: r.action_type,
      status: r.status,
      decision: r.decision,
      tx_signature: sig,
      created_at: r.created_at,
    });
    if (!completed) continue;
    if (r.action_type === "signing") signed = true;
    if (EXECUTE_ACTIONS.has(r.action_type)) executed = true;
    if (r.action_type === "expire_request") expired = true;
    if (r.action_type === "halt") halted = true;
  }

  const terminal: Outcome["terminal"] = executed
    ? "executed"
    : expired
    ? "expired"
    : halted
    ? "halted"
    : signed
    ? "signed"
    : "pending";

  return { signed, executed, expired, halted, tx_signatures: [...txSigs], terminal, events };
}

/** Outcome-based label derivation. See LABEL DEFINITION in the header. */
function deriveLabel(
  blocked: boolean,
  decision: string | null,
  outcome: Outcome,
): { label: FineTuneTraceRow["label"]; reason: string } {
  if (blocked) {
    return { label: "bad", reason: "guardrail_blocked: model output rejected by deterministic guardrails" };
  }
  const d = (decision ?? "").toLowerCase();

  if (outcome.terminal === "pending") {
    return { label: "unlabeled", reason: "no terminal on-chain outcome yet (pending/in-review)" };
  }

  if (d === "approve") {
    if (outcome.executed || outcome.signed) {
      if (outcome.halted) return { label: "bad", reason: "approved but halted for risk after signing" };
      if (outcome.expired) return { label: "bad", reason: "approved+signed but expired without execution" };
      return { label: "good", reason: "guardrails passed and approval executed/signed on-chain as intended" };
    }
    if (outcome.expired) return { label: "bad", reason: "model approved but request expired without execution" };
    if (outcome.halted) return { label: "bad", reason: "model approved but execution halted due to risk" };
    return { label: "unlabeled", reason: "approve with no signing/execute outcome recorded" };
  }

  if (d === "halt") {
    if (outcome.halted) return { label: "good", reason: "halt decision realized on-chain" };
    if (outcome.executed) return { label: "bad", reason: "halt decision but execution proceeded on-chain" };
    return { label: "unlabeled", reason: "halt decision with no matching on-chain halt" };
  }

  if (d === "reject" || d === "request_review") {
    if (outcome.executed) return { label: "bad", reason: "rejected/under-review but executed on-chain anyway" };
    if (outcome.expired) return { label: "good", reason: "rejection realized as on-chain expiry as intended" };
    return { label: "unlabeled", reason: "rejection with no terminal expiry recorded" };
  }

  return { label: "unlabeled", reason: `decision '${d || "unknown"}' has no defined expected outcome` };
}

function parseArgs(argv: string[]) {
  const args: { out?: string; limit: number; dao?: string } = { limit: 5000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") args.out = argv[++i];
    else if (a === "--limit") args.limit = Math.max(1, Number(argv[++i]) || 5000);
    else if (a === "--dao") args.dao = argv[++i];
  }
  return args;
}

async function main(): Promise<void> {
  const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  // Fail-closed: never reach out to a default/anon endpoint. Both must be set.
  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error(
      "Missing required env. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY " +
        "(read-only service client) before running trace-export.",
    );
    process.exit(1);
  }

  const args = parseArgs(process.argv.slice(2));
  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // (1) Pull model-decision rows: those carrying a raw model response AND a
  // decision (the dispatcher's per-role inferences). Orchestrator outcome rows
  // have raw_claude_response=null and are fetched separately as outcomes.
  let decisionQuery = supabase
    .from("agent_action_logs")
    .select("*")
    .not("raw_claude_response", "is", null)
    .not("decision", "is", null)
    .order("created_at", { ascending: true })
    .limit(args.limit);
  if (args.dao) decisionQuery = decisionQuery.eq("dao_onchain_address", args.dao);

  const { data: decisionRows, error: decErr } = await decisionQuery;
  if (decErr) {
    console.error(`Failed to read agent_action_logs (decisions): ${decErr.message}`);
    process.exit(1);
  }
  const decisions = (decisionRows ?? []) as LogRow[];

  // (2) Pull ALL logs for the involved execution requests so we can join
  // subsequent on-chain outcomes. Chunk the .in() to stay within URL limits.
  const erAddresses = [
    ...new Set(
      decisions
        .map((r) => r.execution_request_address)
        .filter((a): a is string => !!a && a.length > 0),
    ),
  ];

  const logsByEr = new Map<string, LogRow[]>();
  const CHUNK = 100;
  for (let i = 0; i < erAddresses.length; i += CHUNK) {
    const chunk = erAddresses.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from("agent_action_logs")
      .select("*")
      .in("execution_request_address", chunk);
    if (error) {
      console.error(`Failed to read agent_action_logs (outcomes): ${error.message}`);
      process.exit(1);
    }
    for (const row of (data ?? []) as LogRow[]) {
      const key = row.execution_request_address ?? "";
      if (!logsByEr.has(key)) logsByEr.set(key, []);
      logsByEr.get(key)!.push(row);
    }
  }

  // (3) Assemble one dataset row per model decision.
  const out: string[] = [];
  for (const d of decisions) {
    const er = d.execution_request_address ?? "";
    const related = logsByEr.get(er) ?? [];
    const outcome = deriveOutcome(related);
    const blocked = d.status === "guardrail_blocked";
    const { label, reason } = deriveLabel(blocked, d.decision, outcome);

    const row: FineTuneTraceRow = {
      schema_version: FT_TRACE_SCHEMA_VERSION,
      id: d.id,
      dao: d.dao_onchain_address,
      execution_request_address: er,
      agent_role: d.agent_role,
      action_type: d.action_type,
      created_at: d.created_at,
      claude_model: d.claude_model,
      reasoning_hash: d.reasoning_hash,
      context_signal: {
        dao: d.dao_onchain_address,
        agent_role: d.agent_role,
        action_type: d.action_type,
        protocol_payload_hash: d.payload_hash && d.payload_hash.length > 0 ? d.payload_hash : null,
        constitution_check: d.constitution_check ?? {},
      },
      model_output: {
        decision: d.decision,
        confidence: d.confidence_score,
        risk_flags: toStringArray(d.risk_flags),
        raw_response: d.raw_claude_response,
        reasoning: d.reasoning,
      },
      guardrail_verdict: {
        status: d.status,
        blocked,
        error_message: d.error_message && d.error_message.length > 0 ? d.error_message : null,
      },
      outcome,
      label,
      label_reason: reason,
    };
    out.push(JSON.stringify(row));
  }

  const jsonl = out.join("\n") + (out.length > 0 ? "\n" : "");
  if (args.out) {
    await writeFile(args.out, jsonl, "utf8");
    console.error(`Wrote ${out.length} trace rows to ${args.out}`);
  } else {
    process.stdout.write(jsonl);
    console.error(`Exported ${out.length} trace rows.`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
