#!/usr/bin/env node
/**
 * Load devnet/testnet env for Nave contract test runners.
 * Merges (lowest → highest precedence):
 *   deployments/devnet.json defaults → .env.testnet.local → process.env
 */
import { existsSync, readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

function parseDotenv(text) {
  const out = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (/^\s*#/.test(line) || !line.trim()) continue;
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let val = m[2].trim();
    if (/^["']/.test(val)) {
      const q = val[0];
      const end = val.indexOf(q, 1);
      val = end > 0 ? val.slice(1, end) : val.slice(1);
    }
    out[m[1]] = val;
  }
  return out;
}

function loadDevnetDefaults() {
  const p = resolve(ROOT, "deployments/devnet.json");
  if (!existsSync(p)) return {};
  const j = JSON.parse(readFileSync(p, "utf8"));
  return {
    SOLANA_DEVNET_RPC: j.rpc || j.rpcApp || "",
    NAVE_CORE_PROGRAM_ID: j.programs?.nave_core || "",
    NAVE_GOVERNANCE_PROGRAM_ID: j.programs?.nave_governance || "",
    NAVE_EXECUTION_PROGRAM_ID: j.programs?.nave_execution || "",
    NAVE_DEVNET_AUTHORITY: j.authority || "",
  };
}

/**
 * @returns {Record<string, string>}
 */
export function loadTestEnv() {
  const merged = { ...loadDevnetDefaults() };

  const localPath = resolve(ROOT, ".env.testnet.local");
  if (existsSync(localPath)) {
    Object.assign(merged, parseDotenv(readFileSync(localPath, "utf8")));
  }

  for (const [k, v] of Object.entries(process.env)) {
    if (v != null && String(v).trim() !== "") merged[k] = String(v);
  }

  const walletRel = merged.ANCHOR_WALLET || ".deploy-wallet-devnet.json";
  const walletAbs = resolve(ROOT, walletRel.replace(/^~\//, `${process.env.HOME || ""}/`));
  merged.ANCHOR_WALLET = existsSync(walletAbs) ? walletAbs : resolve(ROOT, walletRel);
  merged.ANCHOR_PROVIDER_URL = merged.ANCHOR_PROVIDER_URL || merged.SOLANA_DEVNET_RPC || "";
  merged.RPC = merged.RPC || merged.ANCHOR_PROVIDER_URL;

  return merged;
}

/**
 * Apply merged env to process.env (for child processes).
 */
export function applyTestEnv() {
  const env = loadTestEnv();
  for (const [k, v] of Object.entries(env)) {
    if (v) process.env[k] = v;
  }
  return env;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const env = loadTestEnv();
  const keys = Object.keys(env).sort();
  for (const k of keys) {
    if (k.toLowerCase().includes("secret") || k.toLowerCase().includes("private")) continue;
    console.log(`${k}=${env[k] ? "(set)" : "(empty)"}`);
  }
}
