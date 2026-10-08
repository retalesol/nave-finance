#!/usr/bin/env node
/**
 * Push RPC-related vars from `.env.local` into Supabase Edge secrets using the
 * names expected by edge functions (`snapshot-treasury`, `register-dao`, etc.).
 *
 * Maps:
 *   VITE_EVM_SEPOLIA_RPC_URL      → EVM_SEPOLIA_RPC_URL
 *   VITE_EVM_BASE_SEPOLIA_RPC_URL → EVM_BASE_SEPOLIA_RPC_URL
 *   VITE_EVM_ETHEREUM_RPC_URL     → EVM_ETHEREUM_RPC_URL (optional)
 *   VITE_EVM_BASE_RPC_URL         → EVM_BASE_RPC_URL (optional)
 *   VITE_SOLANA_RPC_URL           → SOLANA_RPC_URL
 *   NAVE_INDEXER_SECRET           → NAVE_INDEXER_SECRET (optional; if set locally)
 *
 * Requires: `supabase link` for this project and a logged-in CLI (`supabase login`).
 * Does not print secret values.
 */
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = join(root, ".env.local");

if (!existsSync(envPath)) {
  console.error("[sync-supabase-edge-rpc-secrets] Missing .env.local");
  process.exit(1);
}

/** @type {Record<string, string>} */
const env = {};
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const m = line.match(/^([A-Za-z0-9_]+)=(.*)$/);
  if (!m) continue;
  let v = m[2].trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  env[m[1]] = v;
}

/** @type {Array<[string, string]>} */
const mapping = [
  ["EVM_SEPOLIA_RPC_URL", "VITE_EVM_SEPOLIA_RPC_URL"],
  ["EVM_BASE_SEPOLIA_RPC_URL", "VITE_EVM_BASE_SEPOLIA_RPC_URL"],
  ["EVM_ETHEREUM_RPC_URL", "VITE_EVM_ETHEREUM_RPC_URL"],
  ["EVM_BASE_RPC_URL", "VITE_EVM_BASE_RPC_URL"],
  ["EVM_ROBINHOOD_RPC_URL", "VITE_EVM_ROBINHOOD_RPC_URL"],
  ["EVM_ETHEREUM_PROTOCOL_ADDRESS", "VITE_EVM_ETHEREUM_PROTOCOL_ADDRESS"],
  ["EVM_BASE_PROTOCOL_ADDRESS", "VITE_EVM_BASE_PROTOCOL_ADDRESS"],
  ["EVM_ROBINHOOD_PROTOCOL_ADDRESS", "VITE_EVM_ROBINHOOD_PROTOCOL_ADDRESS"],
  ["SOLANA_RPC_URL", "VITE_SOLANA_RPC_URL"],
  ["NAVE_INDEXER_SECRET", "NAVE_INDEXER_SECRET"],
  ["LLM_TIMEOUT_MS", "LLM_TIMEOUT_MS"],
  ["LLM_DAILY_TOKEN_BUDGET", "LLM_DAILY_TOKEN_BUDGET"],
  ["NAVE_BREAK_GLASS_SECRET", "NAVE_BREAK_GLASS_SECRET"],
  ["NAVE_EXECUTION_GRACE_SECS", "NAVE_EXECUTION_GRACE_SECS"],
  ["NAVE_ORACLE_PERSIST_TTL_SECONDS", "NAVE_ORACLE_PERSIST_TTL_SECONDS"],
];

const args = [];
for (const [dest, src] of mapping) {
  const v = env[src];
  if (!v) continue;
  args.push(`${dest}=${v}`);
}

if (args.length === 0) {
  console.error("[sync-supabase-edge-rpc-secrets] No matching keys in .env.local to push.");
  process.exit(1);
}

console.log(
  "[sync-supabase-edge-rpc-secrets] Setting:",
  args.map((a) => a.split("=")[0]).join(", "),
);

const r = spawnSync("supabase", ["secrets", "set", ...args], {
  cwd: root,
  stdio: "inherit",
});
process.exit(r.status === 0 ? 0 : r.status ?? 1);
