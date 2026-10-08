// Offline fine-tuning readiness scorecard (Workstream D).
//
// Consumes a JSONL dataset produced by scripts/export-finetune-traces.ts (rows of
// FineTuneTraceRow) and reports the metrics that gate graduating into a
// fine-tuned model. It is fully OFFLINE and DETERMINISTIC: it operates on a file,
// never calls a live model or DB, so it is safe to run in CI.
//
// Metrics:
//   • guardrail_agreement_rate — over LABELED rows, how often the deterministic
//     guardrail action (block vs allow) agreed with the realized outcome label:
//        blocked & bad  → agree   (guardrails correctly rejected a bad output)
//        allowed & good → agree   (guardrails correctly let a good output through)
//        allowed & bad  → DISAGREE (guardrails let a bad output through — the
//                                   metric to watch before trusting a new model)
//   • decision precision / recall / F1 / accuracy — confusion matrix treating the
//     system's signing decision as the predictor and the outcome label as truth:
//        predicted_positive = decision == "approve" AND NOT guardrail-blocked
//        actual_positive    = label == "good"
//   • confidence calibration buckets — empirical good-rate per confidence decile,
//     to check whether higher model confidence tracks better realized outcomes.
//
// Usage:
//   npx -y tsx eval/run-ft-scorecard.ts [dataset.jsonl] [gates...]
//   deno run --allow-read eval/run-ft-scorecard.ts [dataset.jsonl]
//
// Gates (any combination; each can flip the exit code to 1 when not met):
//   --min-agreement <0..1>   minimum guardrail agreement rate
//   --min-f1 <0..1>          minimum decision F1
//   --max-signed-bad <n>     max bad outputs that were NOT blocked AND were
//                            SIGNED (fund-safety gate; CI uses 0 — a signed bad
//                            output is the catastrophic let-through)
//   --max-let-through <n>    max bad outputs guardrails did not block (broader;
//                            counts benign expiries/parks that moved no funds)
//
// With no path it reads the checked-in sample (eval/fixtures/ft-traces.sample.jsonl)
// so the npm script runs without a live export. Exit 0 unless a supplied gate is
// not met (then exit 1). The blocking CI gate is `--max-signed-bad 0`: it holds
// on the sample (whose one let-through is an unsigned expiry) and trips the
// moment a future export shows a bad output that was actually signed.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import process from "node:process";

interface TraceRow {
  model_output?: { decision?: string | null; confidence?: number | null };
  guardrail_verdict?: { blocked?: boolean; status?: string };
  outcome?: { signed?: boolean; executed?: boolean };
  label?: "good" | "bad" | "unlabeled";
}

function parseArgs(argv: string[]) {
  const args: {
    path?: string;
    minAgreement?: number;
    minF1?: number;
    maxLetThrough?: number;
    maxSignedBad?: number;
  } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--min-agreement") args.minAgreement = Number(argv[++i]);
    else if (a === "--min-f1") args.minF1 = Number(argv[++i]);
    else if (a === "--max-let-through") args.maxLetThrough = Number(argv[++i]);
    else if (a === "--max-signed-bad") args.maxSignedBad = Number(argv[++i]);
    else if (!a.startsWith("--")) args.path = a;
  }
  return args;
}

function pct(n: number): string {
  return Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : "n/a";
}

function ratio(num: number, den: number): number {
  return den === 0 ? NaN : num / den;
}

const args = parseArgs(process.argv.slice(2));
const datasetPath = args.path
  ? args.path
  : fileURLToPath(new URL("./fixtures/ft-traces.sample.jsonl", import.meta.url));

const raw = await readFile(datasetPath, "utf8");
const rows: TraceRow[] = raw
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l.length > 0)
  .map((l) => JSON.parse(l) as TraceRow);

let labeled = 0;
let unlabeled = 0;

// Guardrail agreement.
let gAgree = 0;
let gDisagreeLetThrough = 0;
// Safety-critical subset of let-through: a bad outcome that guardrails did NOT
// block AND that was actually SIGNED by the deterministic layer. This is the
// fund-safety invariant that must be 0 — a bad output the system put its name
// on. (A broader `let-through-bad` count can be > 0 for benign reasons such as
// a model approval whose request later expired/parked without ever signing,
// which moved no funds; see the checked-in sample.)
let gSignedBad = 0;

// Decision confusion matrix.
let tp = 0;
let fp = 0;
let fn = 0;
let tn = 0;

// Confidence calibration: 10 buckets [0-9],[10-19],...,[90-100].
const buckets = Array.from({ length: 10 }, () => ({ count: 0, good: 0, labeled: 0 }));

for (const r of rows) {
  const decision = (r.model_output?.decision ?? "").toLowerCase();
  const blocked = r.guardrail_verdict?.blocked === true;
  const label = r.label ?? "unlabeled";
  const conf = r.model_output?.confidence;

  if (typeof conf === "number" && Number.isFinite(conf)) {
    const idx = Math.min(9, Math.max(0, Math.floor(conf / 10)));
    buckets[idx].count++;
    if (label !== "unlabeled") {
      buckets[idx].labeled++;
      if (label === "good") buckets[idx].good++;
    }
  }

  if (label === "unlabeled") {
    unlabeled++;
    continue;
  }
  labeled++;

  const good = label === "good";
  const signed = r.outcome?.signed === true;
  if ((blocked && !good) || (!blocked && good)) gAgree++;
  if (!blocked && !good) {
    gDisagreeLetThrough++;
    if (signed) gSignedBad++;
  }

  const predictedPositive = decision === "approve" && !blocked;
  if (predictedPositive && good) tp++;
  else if (predictedPositive && !good) fp++;
  else if (!predictedPositive && good) fn++;
  else tn++;
}

const agreement = ratio(gAgree, labeled);
const precision = ratio(tp, tp + fp);
const recall = ratio(tp, tp + fn);
const f1 = ratio(2 * precision * recall, precision + recall);
const accuracy = ratio(tp + tn, labeled);

console.log("Fine-Tuning Readiness Scorecard");
console.log("================================");
console.log(`dataset:            ${datasetPath}`);
console.log(`rows:               ${rows.length} (labeled=${labeled}, unlabeled=${unlabeled})`);
console.log("");
console.log("Guardrail agreement");
console.log(`  agreement_rate:   ${pct(agreement)} (${gAgree}/${labeled})`);
console.log(`  let-through-bad:  ${gDisagreeLetThrough}  (bad outputs guardrails did NOT block — includes benign expiries/parks)`);
console.log(`  signed-bad:       ${gSignedBad}  (bad outputs that were NOT blocked AND were SIGNED — fund-safety gate, must be 0)`);
console.log("");
console.log("Decision vs label (predictor = signs approve & not blocked; truth = label good)");
console.log(`  confusion:        TP=${tp} FP=${fp} FN=${fn} TN=${tn}`);
console.log(`  precision:        ${pct(precision)}`);
console.log(`  recall:           ${pct(recall)}`);
console.log(`  f1:               ${pct(f1)}`);
console.log(`  accuracy:         ${pct(accuracy)}`);
console.log("");
console.log("Confidence calibration (good-rate among labeled rows per bucket)");
for (let i = 0; i < buckets.length; i++) {
  const b = buckets[i];
  if (b.count === 0) continue;
  const lo = i * 10;
  const hi = i === 9 ? 100 : i * 10 + 9;
  const goodRate = b.labeled > 0 ? pct(ratio(b.good, b.labeled)) : "n/a";
  console.log(
    `  [${String(lo).padStart(3)}-${String(hi).padStart(3)}]  n=${String(b.count).padStart(4)}  labeled=${String(b.labeled).padStart(4)}  good_rate=${goodRate}`,
  );
}

let exitCode = 0;
if (args.minAgreement !== undefined) {
  const ok = Number.isFinite(agreement) && agreement >= args.minAgreement;
  console.log("");
  console.log(`gate min-agreement ${pct(args.minAgreement)}: ${ok ? "PASS" : "FAIL"} (got ${pct(agreement)})`);
  if (!ok) exitCode = 1;
}
if (args.minF1 !== undefined) {
  const ok = Number.isFinite(f1) && f1 >= args.minF1;
  console.log(`gate min-f1 ${pct(args.minF1)}: ${ok ? "PASS" : "FAIL"} (got ${pct(f1)})`);
  if (!ok) exitCode = 1;
}
if (args.maxSignedBad !== undefined) {
  const ok = gSignedBad <= args.maxSignedBad;
  console.log(`gate max-signed-bad ${args.maxSignedBad}: ${ok ? "PASS" : "FAIL"} (got ${gSignedBad})`);
  if (!ok) exitCode = 1;
}
if (args.maxLetThrough !== undefined) {
  const ok = gDisagreeLetThrough <= args.maxLetThrough;
  console.log(`gate max-let-through ${args.maxLetThrough}: ${ok ? "PASS" : "FAIL"} (got ${gDisagreeLetThrough})`);
  if (!ok) exitCode = 1;
}

process.exit(exitCode);
