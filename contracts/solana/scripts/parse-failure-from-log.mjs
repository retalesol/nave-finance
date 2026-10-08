#!/usr/bin/env node
/**
 * Parse anchor/mocha log output and mark failure index for resume.
 * Usage: node scripts/parse-failure-from-log.mjs [logfile]
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const logPath = process.argv[2] || path.join(ROOT, ".test-runs/last-run.log");
const manifest = JSON.parse(
  fs.readFileSync(path.join(ROOT, ".test-runs/manifest.json"), "utf8")
);
const checkpointPath = path.join(ROOT, ".test-runs/checkpoint.json");

if (!fs.existsSync(logPath)) {
  console.error(`Log not found: ${logPath}`);
  process.exit(1);
}

const log = fs.readFileSync(logPath, "utf8");

// Mocha numbered failure: "  12) suite name"
const numbered = [...log.matchAll(/^\s*(\d+)\)\s+(.+)$/gm)];
let failedTitle = null;
if (numbered.length) {
  const last = numbered[numbered.length - 1];
  failedTitle = last[2].trim();
}

// Or: "Failure at index N" from checkpoint runner
const idxMatch = log.match(/Failure at index (\d+)/);
let index = idxMatch ? Number(idxMatch[1]) : null;

if (index == null && failedTitle) {
  const hit = manifest.tests.find((t) => failedTitle.includes(t.title) || t.fullTitle.includes(failedTitle));
  if (hit) index = hit.index;
}

if (index == null) {
  console.error("Could not determine failed test index from log.");
  process.exit(1);
}

const test = manifest.tests[index];
const checkpoint = fs.existsSync(checkpointPath)
  ? JSON.parse(fs.readFileSync(checkpointPath, "utf8"))
  : { version: 1, lastPassedIndex: -1, passedCount: 0 };

checkpoint.lastFailedIndex = index;
checkpoint.lastFailedTitle = test?.fullTitle || failedTitle;
checkpoint.lastFailedError = log.split("\n").find((l) => l.includes("Error:"))?.trim() || null;
checkpoint.lastUpdated = new Date().toISOString();
checkpoint.total = manifest.total;

fs.writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 2));
console.log(`Checkpoint updated: failure at index ${index}`);
console.log(`  ${checkpoint.lastFailedTitle}`);
console.log(`Resume with: npm run test:resume`);
