#!/usr/bin/env node
/**
 * Ordered Solana devnet test runner with fail-fast and JSON report.
 *
 * Usage:
 *   node scripts/run-devnet-suite.mjs --tier smoke
 *   node scripts/run-devnet-suite.mjs --tier full
 *   node scripts/run-devnet-suite.mjs --tier full --continue-on-fail
 */
import { spawnSync } from "child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { applyTestEnv, loadTestEnv } from "./load-test-env.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const REPORT_DIR = resolve(ROOT, "..", "test-results");
const TS_MOCHA = resolve(ROOT, "../node_modules/.bin/ts-mocha");

const TIERS = {
  smoke: [{ file: "tests/devnet-e2e.ts", runner: "mocha", timeoutMs: 1_200_000 }],
  full: [
    { file: "tests/devnet-e2e.ts", runner: "mocha", timeoutMs: 1_200_000 },
    { file: "tests/revalue-devnet.ts", runner: "ts-node", timeoutMs: 600_000 },
    { file: "tests/revalue-multiasset-devnet.ts", runner: "ts-node", timeoutMs: 600_000 },
    { file: "tests/jito-cpi-devnet.ts", runner: "ts-node", timeoutMs: 600_000 },
    { file: "tests/jupiter-cpi-devnet.ts", runner: "ts-node", timeoutMs: 600_000 },
    { file: "tests/kamino-cpi-devnet.ts", runner: "ts-node", timeoutMs: 900_000 },
    { file: "tests/marginfi-cpi-devnet.ts", runner: "ts-node", timeoutMs: 900_000 },
    { file: "tests/safety-devnet.ts", runner: "ts-node", timeoutMs: 900_000 },
    { file: "tests/guardrail-devnet.ts", runner: "ts-node", timeoutMs: 900_000 },
  ],
};

function parseArgs() {
  const args = process.argv.slice(2);
  let tier = "smoke";
  let continueOnFail = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--tier" && args[i + 1]) tier = args[++i];
    if (args[i] === "--continue-on-fail") continueOnFail = true;
  }
  return { tier, continueOnFail };
}

function runPreflight(env) {
  const warnings = [];
  const errors = [];

  if (!env.ANCHOR_PROVIDER_URL) {
    errors.push("ANCHOR_PROVIDER_URL / SOLANA_DEVNET_RPC is required");
  }
  if (!existsSync(env.ANCHOR_WALLET)) {
    errors.push(`Deploy wallet not found: ${env.ANCHOR_WALLET}`);
  }

  if (existsSync(env.ANCHOR_WALLET)) {
    const bal = spawnSync(
      "solana",
      ["balance", "-u", env.ANCHOR_PROVIDER_URL, "-k", env.ANCHOR_WALLET],
      { encoding: "utf8" }
    );
    if (bal.status === 0) {
      const m = bal.stdout.match(/([\d.]+)\s+SOL/);
      const sol = m ? parseFloat(m[1]) : 0;
      console.log(`Deploy wallet balance: ${bal.stdout.trim()}`);
      if (sol < 2) warnings.push(`Low SOL balance (${sol}); devnet suite may fail funding members`);
    } else {
      warnings.push(`Could not read deploy wallet balance: ${bal.stderr || bal.stdout}`);
    }
  }

  const devnetJson = resolve(ROOT, "deployments/devnet.json");
  if (existsSync(devnetJson)) {
    const dep = JSON.parse(readFileSync(devnetJson, "utf8"));
    const programs = dep.programs || {};
    for (const [name, id] of Object.entries(programs)) {
      const show = spawnSync("solana", ["program", "show", id, "-u", env.ANCHOR_PROVIDER_URL], {
        encoding: "utf8",
      });
      if (show.status !== 0) {
        errors.push(`Program ${name} (${id}) not found on devnet RPC`);
      } else {
        console.log(`  ✓ ${name} deployed`);
      }
    }
  }

  for (const w of warnings) console.warn(`WARN: ${w}`);
  if (errors.length) {
    for (const e of errors) console.error(`FAIL: ${e}`);
    process.exit(1);
  }
}

function runStep(step, env) {
  const startedAt = new Date().toISOString();
  const childEnv = {
    ...process.env,
    ...env,
    ANCHOR_PROVIDER_URL: env.ANCHOR_PROVIDER_URL,
    ANCHOR_WALLET: env.ANCHOR_WALLET,
    RPC: env.RPC || env.ANCHOR_PROVIDER_URL,
    TS_NODE_TRANSPILE_ONLY: "1",
  };

  let result;
  if (step.runner === "mocha") {
    result = spawnSync(
      TS_MOCHA,
      ["-p", "./tsconfig.json", "-t", String(step.timeoutMs), step.file],
      { cwd: ROOT, encoding: "utf8", env: childEnv, maxBuffer: 20 * 1024 * 1024 }
    );
  } else {
    result = spawnSync("npx", ["-y", "ts-node", step.file], {
      cwd: ROOT,
      encoding: "utf8",
      env: childEnv,
      maxBuffer: 20 * 1024 * 1024,
    });
  }

  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  const daoMatch =
    output.match(/E2E_DAO_ADDRESS=([1-9A-HJ-NP-Za-km-z]{32,44})/) ||
    output.match(/DEVNET_E2E_SUMMARY=[^\n]+/);
  const daoAddress = daoMatch ? (daoMatch[1] || daoMatch[0]) : null;

  return {
    file: step.file,
    runner: step.runner,
    startedAt,
    finishedAt: new Date().toISOString(),
    exitCode: result.status ?? 1,
    daoAddress,
    outputTail: output.split("\n").slice(-40).join("\n"),
  };
}

function acquireSuiteLock() {
  mkdirSync(REPORT_DIR, { recursive: true });
  const lockPath = resolve(REPORT_DIR, ".solana-devnet-suite.lock");
  try {
    const fd = openSync(lockPath, "wx");
    closeSync(fd);
    process.on("exit", () => {
      try {
        unlinkSync(lockPath);
      } catch {
        /* ignore */
      }
    });
  } catch {
    console.error(
      `Another Solana devnet suite appears to be running (lock: ${lockPath}).`,
    );
    console.error("Wait for it to finish or remove the lock file if stale.");
    process.exit(1);
  }
}

function main() {
  const { tier, continueOnFail } = parseArgs();
  acquireSuiteLock();
  const steps = TIERS[tier];
  if (!steps) {
    console.error(`Unknown tier "${tier}". Use: ${Object.keys(TIERS).join(", ")}`);
    process.exit(1);
  }

  const env = applyTestEnv();
  console.log(`\n=== Solana devnet suite (tier=${tier}) ===`);
  console.log(`RPC: ${env.ANCHOR_PROVIDER_URL}`);
  console.log(`Wallet: ${env.ANCHOR_WALLET}\n`);

  runPreflight(env);

  const report = {
    suite: "solana-devnet",
    tier,
    startedAt: new Date().toISOString(),
    steps: [],
    passed: 0,
    failed: 0,
    daoAddresses: [],
  };

  for (const step of steps) {
    console.log(`\n--- ${step.file} ---\n`);
    const r = runStep(step, env);
    report.steps.push(r);
    if (r.exitCode === 0) {
      report.passed++;
      console.log(`OK: ${step.file}`);
      if (r.daoAddress && r.daoAddress.length < 50) report.daoAddresses.push(r.daoAddress);
    } else {
      report.failed++;
      console.error(`FAIL: ${step.file} (exit ${r.exitCode})`);
      console.error(r.outputTail);
      if (!continueOnFail) break;
    }
  }

  report.finishedAt = new Date().toISOString();
  report.ok = report.failed === 0;

  mkdirSync(REPORT_DIR, { recursive: true });
  const reportPath = resolve(REPORT_DIR, `solana-devnet-${tier}.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nWrote ${reportPath}`);
  process.exit(report.ok ? 0 : 1);
}

main();
