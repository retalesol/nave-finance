#!/usr/bin/env node
/**
 * Run localnet tests one-by-one with checkpointing and resume support.
 *
 * Usage:
 *   node scripts/checkpoint-runner.mjs run [--from N] [--overlap N]
 *   node scripts/checkpoint-runner.mjs resume [--overlap N]   # default overlap: 6
 *   node scripts/checkpoint-runner.mjs status
 *   node scripts/checkpoint-runner.mjs reset
 *   node scripts/checkpoint-runner.mjs mark-failed --index N [--error "msg"]
 *
 * Requires localnet validator + deployed programs (see scripts/localnet-session.sh).
 */
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const RUNS_DIR = path.join(ROOT, ".test-runs");
const MANIFEST_PATH = path.join(RUNS_DIR, "manifest.json");
const CHECKPOINT_PATH = path.join(RUNS_DIR, "checkpoint.json");
const SUCCESS_LOG = path.join(RUNS_DIR, "success.log");
const LAST_RUN_LOG = path.join(RUNS_DIR, "last-run.log");
const TS_MOCHA = path.join(ROOT, "../node_modules/.bin/ts-mocha");

const DEFAULT_OVERLAP = 6;
const DEFAULT_TIMEOUT = "120000";

function loadJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function saveJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function appendLog(file, line) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${line}\n`);
}

function loadManifest() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    console.error("Missing manifest. Run: npm run test:manifest");
    process.exit(1);
  }
  return loadJson(MANIFEST_PATH, null);
}

function loadCheckpoint(manifest) {
  return loadJson(CHECKPOINT_PATH, {
    version: 1,
    total: manifest.total,
    lastPassedIndex: -1,
    lastFailedIndex: null,
    lastFailedTitle: null,
    lastFailedError: null,
    lastUpdated: null,
    passedCount: 0,
  });
}

function saveCheckpoint(checkpoint) {
  checkpoint.lastUpdated = new Date().toISOString();
  saveJson(CHECKPOINT_PATH, checkpoint);
}

function ensureLocalnet() {
  const url = process.env.ANCHOR_PROVIDER_URL || "http://127.0.0.1:8899";
  const result = spawnSync(
    "curl",
    ["-s", "-X", "POST", url, "-H", "Content-Type: application/json", "-d", '{"jsonrpc":"2.0","id":1,"method":"getHealth"}'],
    { encoding: "utf8" }
  );
  if (!result.stdout?.includes("ok")) {
    console.error(`Localnet not reachable at ${url}. Start with: npm run localnet:up`);
    process.exit(1);
  }
}

function runSingleTest(test, manifest) {
  const needsChain = test.integration;
  if (needsChain) ensureLocalnet();

  const env = {
    ...process.env,
    ANCHOR_PROVIDER_URL: process.env.ANCHOR_PROVIDER_URL || "http://127.0.0.1:8899",
    ANCHOR_WALLET: process.env.ANCHOR_WALLET || `${process.env.HOME}/.config/solana/id.json`,
  };

  const started = Date.now();
  const result = spawnSync(
    TS_MOCHA,
    [
      "-p",
      "./tsconfig.json",
      "-t",
      DEFAULT_TIMEOUT,
      "--grep",
      test.grep,
      test.file,
    ],
    { cwd: ROOT, encoding: "utf8", env, maxBuffer: 20 * 1024 * 1024 }
  );

  const elapsedMs = Date.now() - started;
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  const passed = result.status === 0 && /(\n|^)\s*\d+ passing/.test(output);

  return { passed, elapsedMs, output, exitCode: result.status ?? 1 };
}

function parseArgs(argv) {
  const args = { overlap: DEFAULT_OVERLAP, from: null, index: null, error: null };
  const cmd = argv[0] || "run";
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--overlap" && argv[i + 1]) args.overlap = Number(argv[++i]);
    else if (a === "--from" && argv[i + 1]) args.from = Number(argv[++i]);
    else if (a === "--index" && argv[i + 1]) args.index = Number(argv[++i]);
    else if (a === "--error" && argv[i + 1]) args.error = argv[++i];
  }
  return { cmd, ...args };
}

function resolveStartIndex(cmd, checkpoint, args) {
  if (args.from != null) return Math.max(0, args.from);

  if (cmd === "resume") {
    if (checkpoint.lastFailedIndex != null) {
      return Math.max(0, checkpoint.lastFailedIndex - args.overlap);
    }
    return Math.max(0, checkpoint.lastPassedIndex + 1);
  }

  if (cmd === "run") {
    if (checkpoint.lastPassedIndex >= 0 && checkpoint.lastFailedIndex == null) {
      return checkpoint.lastPassedIndex + 1;
    }
    return 0;
  }

  return 0;
}

function printStatus(manifest, checkpoint) {
  console.log(`Manifest: ${manifest.total} tests (${manifest.generatedAt})`);
  console.log(`Checkpoint: last passed #${checkpoint.lastPassedIndex} (${checkpoint.passedCount} logged passes)`);
  if (checkpoint.lastFailedIndex != null) {
    console.log(`Last failure: #${checkpoint.lastFailedIndex} — ${checkpoint.lastFailedTitle}`);
    if (checkpoint.lastFailedError) console.log(`  ${checkpoint.lastFailedError}`);
  } else {
    console.log("Last failure: none recorded");
  }
  const next = checkpoint.lastFailedIndex != null
    ? Math.max(0, checkpoint.lastFailedIndex - DEFAULT_OVERLAP)
    : checkpoint.lastPassedIndex + 1;
  console.log(`Resume would start at index: ${next}`);
}

function main() {
  const { cmd, overlap, from, index, error } = parseArgs(process.argv.slice(2));
  const manifest = loadManifest();
  let checkpoint = loadCheckpoint(manifest);

  if (cmd === "reset") {
    if (fs.existsSync(CHECKPOINT_PATH)) fs.unlinkSync(CHECKPOINT_PATH);
    console.log("Checkpoint cleared.");
    return;
  }

  if (cmd === "status") {
    printStatus(manifest, checkpoint);
    return;
  }

  if (cmd === "mark-failed") {
    if (index == null) {
      console.error("mark-failed requires --index N");
      process.exit(1);
    }
    const test = manifest.tests[index];
    if (!test) {
      console.error(`No test at index ${index}`);
      process.exit(1);
    }
    checkpoint.lastFailedIndex = index;
    checkpoint.lastFailedTitle = test.fullTitle;
    checkpoint.lastFailedError = error || "Manually marked failed";
    saveCheckpoint(checkpoint);
    console.log(`Marked failed: [${index}] ${test.fullTitle}`);
    return;
  }

  if (cmd !== "run" && cmd !== "resume") {
    console.error(`Unknown command: ${cmd}`);
    process.exit(1);
  }

  const startIndex = resolveStartIndex(cmd, checkpoint, { from, overlap });
  console.log(`Running tests ${startIndex}..${manifest.total - 1} (${manifest.total - startIndex} tests)`);
  if (cmd === "resume") console.log(`Resume overlap: ${overlap} tests before last failure`);

  appendLog(SUCCESS_LOG, `\n=== ${cmd.toUpperCase()} from index ${startIndex} @ ${new Date().toISOString()} ===`);

  let failed = false;
  for (let i = startIndex; i < manifest.tests.length; i++) {
    const test = manifest.tests[i];
    const label = `[${i}/${manifest.total - 1}] ${test.fullTitle}`;
    process.stdout.write(`${label} ... `);

    const { passed, elapsedMs, output, exitCode } = runSingleTest(test, manifest);
    fs.writeFileSync(LAST_RUN_LOG, output);

    if (passed) {
      console.log(`ok (${(elapsedMs / 1000).toFixed(1)}s)`);
      checkpoint.lastPassedIndex = i;
      checkpoint.lastFailedIndex = null;
      checkpoint.lastFailedTitle = null;
      checkpoint.lastFailedError = null;
      checkpoint.passedCount = (checkpoint.passedCount || 0) + 1;
      checkpoint.total = manifest.total;
      saveCheckpoint(checkpoint);
      appendLog(SUCCESS_LOG, `${new Date().toISOString()} PASS [${i}] ${test.fullTitle} (${elapsedMs}ms)`);
    } else {
      console.log("FAIL");
      const errLine =
        output
          .split("\n")
          .find((l) => l.includes("Error:") || l.includes("AssertionError") || l.includes("AnchorError")) ||
        `exit ${exitCode}`;
      checkpoint.lastFailedIndex = i;
      checkpoint.lastFailedTitle = test.fullTitle;
      checkpoint.lastFailedError = errLine.trim();
      saveCheckpoint(checkpoint);
      appendLog(SUCCESS_LOG, `${new Date().toISOString()} FAIL [${i}] ${test.fullTitle} — ${errLine.trim()}`);
      console.error(`\nFailure at index ${i}. Re-run with:\n  npm run test:resume\n  npm run test:resume -- --overlap 8\n  npm run test:checkpoint -- --from ${Math.max(0, i - overlap)}`);
      failed = true;
      break;
    }
  }

  if (!failed) {
    console.log(`\nAll ${manifest.total} tests passed. Checkpoint complete.`);
    appendLog(SUCCESS_LOG, `=== COMPLETE ${manifest.total} tests @ ${new Date().toISOString()} ===`);
  }

  process.exit(failed ? 1 : 0);
}

main();
