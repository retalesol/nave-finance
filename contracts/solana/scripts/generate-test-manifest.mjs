#!/usr/bin/env node
/**
 * Build ordered test manifest via mocha dry-run (captures dynamic describe titles).
 * Run after adding or renaming tests: npm run test:manifest
 */
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const TEST_DIR = path.join(ROOT, "tests");
const OUT_DIR = path.join(ROOT, ".test-runs");
const MANIFEST_PATH = path.join(OUT_DIR, "manifest.json");
const TS_MOCHA = path.join(ROOT, "../node_modules/.bin/ts-mocha");

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseSpecOutput(output, file) {
  const stack = [];
  const tests = [];
  const INDENT = 2;

  for (const rawLine of output.split("\n")) {
    const line = rawLine.replace(/\u001b\[[0-9;]*m/g, "");

    const pass = line.match(/^(\s*)✔\s+(.+?)\s*$/);
    if (pass) {
      const indent = pass[1].length;
      const level = Math.max(0, indent / INDENT - 1);
      while (stack.length > level) stack.pop();
      const title = pass[2].trim();
      const fullTitle = [...stack, title].join(" ");
      tests.push({
        file,
        title,
        fullTitle,
        grep: `^${escapeRegex(fullTitle)}$`,
        integration: !isUnitFile(file),
        network: isLocalnetTestFile(file) ? "localnet" : "devnet",
      });
      continue;
    }

    const suite = line.match(/^(\s+)([^\s✔].*?)\s*$/);
    if (!suite || line.includes("✔") || line.includes("passing") || line.includes("failing")) {
      continue;
    }

    const name = suite[2].trim();
    if (!name || name.startsWith("(")) continue;

    const indent = suite[1].length;
    const level = indent / INDENT - 1;
    if (level < 0) continue;

    while (stack.length > level) stack.pop();
    stack[level] = name;
    stack.length = level + 1;
  }

  return tests;
}

function isUnitFile(file) {
  return (
    file === "tests/governance-quorum-scenarios.ts" ||
    file === "tests/treasury-apy-scenarios.ts" ||
    file === "tests/scenario-simulation.ts"
  );
}

/** Mirror Anchor.toml test script ignores — devnet scripts must not run on localnet. */
function isLocalnetTestFile(file) {
  const base = file.replace(/^tests\//, "");
  if (base.startsWith("helpers/")) return false;
  if (base === "devnet-e2e.ts") return false;
  if (base.endsWith("-devnet.ts")) return false;
  return base.endsWith(".ts");
}

function collectFileTests(relativeFile) {
  const result = spawnSync(
    TS_MOCHA,
    ["-p", "./tsconfig.json", "--dry-run", "--reporter", "spec", relativeFile],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }
  );

  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  if (result.status !== 0 && !output.includes("✔")) {
    console.error(`Failed to list tests in ${relativeFile}:\n${output}`);
    process.exit(1);
  }

  return parseSpecOutput(output, relativeFile);
}

function main() {
  const files = fs
    .readdirSync(TEST_DIR)
    .filter((f) => f.endsWith(".ts"))
    .filter((f) => isLocalnetTestFile(`tests/${f}`))
    .sort()
    .map((f) => `tests/${f}`);

  const tests = [];
  for (const file of files) {
    tests.push(...collectFileTests(file));
  }

  tests.forEach((t, index) => {
    t.index = index;
    t.id = `${index}:${t.file}::${t.title}`;
  });

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const manifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    total: tests.length,
    files,
    tests,
  };
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  console.log(`Wrote ${tests.length} tests to ${path.relative(ROOT, MANIFEST_PATH)}`);
}

main();
