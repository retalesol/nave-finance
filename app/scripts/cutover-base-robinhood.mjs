#!/usr/bin/env node
/**
 * Simple Base + Robinhood mainnet cutover driven by DEPLOYMENT_DATA.md.
 *
 * Solana stays on DEVNET. Ethereum stays on SEPOLIA. Only Base (8453) and
 * Robinhood Chain (4663) are mainnet-cutover targets.
 *
 * Phases:
 *   validate  — parse + check DEPLOYMENT_DATA.md operator env block
 *   app-env   — write deployments/cutover-base-rh.env.generated (VITE_* snippet)
 *   deploy    — contracts: Base (--scope full|bridge-stake) + Robinhood (bridge-stake)
 *   handoff   — Safe ownership transfer start on both chains
 *   verify    — explorer / artifact verify on both chains
 *   all       — validate → deploy → app-env → handoff → verify
 *
 * Usage:
 *   node scripts/cutover-base-robinhood.mjs --phase validate
 *   node scripts/cutover-base-robinhood.mjs --phase all --env /path/to/secrets.env --confirm-mainnet
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(__dirname, "..");
const DATA_MD = join(APP_ROOT, "DEPLOYMENT_DATA.md");
const OUT_DIR = join(APP_ROOT, "deployments");
const OUT_ENV = join(OUT_DIR, "cutover-base-rh.env.generated");

const CONTRACTS_CUTOVER = process.env.CONTRACTS_CUTOVER_PATH
  ? resolve(process.env.CONTRACTS_CUTOVER_PATH)
  : resolve(APP_ROOT, "..", "contracts", "solana", "scripts", "evm-mainnet-cutover.mjs");

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const PHASES = new Set(["validate", "app-env", "deploy", "handoff", "verify", "all"]);

const KNOWN = {
  base: {
    wrappedNave: "0xFc04710C3F310f6ed84b441cf897a05807312358",
    bridge: "0x608c6Ee3d56C4Ac5241D5481E72bD236C5404654",
    staking: "0xC8f3BD11a62D39133DdFb5D653789eAe9d8630ec",
  },
  robinhood: {
    wrappedNave: "0xFc04710C3F310f6ed84b441cf897a05807312358",
    bridge: "0x608c6Ee3d56C4Ac5241D5481E72bD236C5404654",
    staking: "0xC8f3BD11a62D39133DdFb5D653789eAe9d8630ec",
  },
  sepolia: {
    protocol: "0x678e69c53E53904ca6D060040E14DFc56003BC11",
    factory: "0x4C8dBdEaa7f5B043dB9A8831023b67994Dc2cb36",
    wrappedNave: "0x1d1d988e8ffE542f1f8F7932DE3A634251D4A042",
    bridge: "0xd5695B76602A288090f3a630dfBca23912cff76d",
    staking: "0x9BdE2F925fb71bDfC3EA0F0F9617786b5a642F02",
  },
};

function parseArgs(argv) {
  const out = { phase: "validate", env: null, confirmMainnet: false, baseScope: "bridge-stake" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--phase") out.phase = argv[++i];
    else if (a === "--env") out.env = argv[++i];
    else if (a === "--confirm-mainnet") out.confirmMainnet = true;
    else if (a === "--base-scope") out.baseScope = argv[++i];
    else if (a === "--help" || a === "-h") out.help = true;
  }
  if (!PHASES.has(out.phase)) {
    throw new Error(`Invalid --phase ${out.phase} (allowed: ${[...PHASES].join(", ")})`);
  }
  if (out.baseScope !== "full" && out.baseScope !== "bridge-stake") {
    throw new Error(`Invalid --base-scope ${out.baseScope} (full | bridge-stake)`);
  }
  return out;
}

function parseEnvBlock(md) {
  const match = md.match(/## Operator inputs[\s\S]*?```env\n([\s\S]*?)```/);
  if (!match) throw new Error("DEPLOYMENT_DATA.md missing Operator inputs ```env block");
  const env = {};
  for (const line of match[1].split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    env[key] = val;
  }
  return env;
}

function loadSecretsEnv(path) {
  if (!path) return {};
  if (!existsSync(path)) throw new Error(`--env file not found: ${path}`);
  const env = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return env;
}

function requireAddr(env, key) {
  const v = (env[key] || "").trim();
  if (!EVM_ADDRESS_RE.test(v)) throw new Error(`${key} must be a 0x EVM address`);
  return v;
}

function requireNonEmpty(env, key) {
  const v = (env[key] || "").trim();
  if (!v) throw new Error(`${key} is required in DEPLOYMENT_DATA.md (or --env)`);
  return v;
}

function mergeEnv(dataEnv, secrets) {
  return { ...dataEnv, ...secrets };
}

function validate(env) {
  const safe = requireAddr(env, "SAFE_ADDRESS");
  const relayer = requireAddr(env, "STACK_RELAYER");
  if (safe.toLowerCase() === relayer.toLowerCase()) {
    throw new Error("SAFE_ADDRESS must differ from STACK_RELAYER");
  }
  if (relayer === "0x0000000000000000000000000000000000000000") {
    throw new Error("STACK_RELAYER is still the zero-address placeholder — set the real relayer EOA");
  }
  requireNonEmpty(env, "EVM_BASE_RPC_URL");
  requireNonEmpty(env, "EVM_ROBINHOOD_RPC_URL");
  requireNonEmpty(env, "VITE_EVM_BASE_RPC_URL");
  requireNonEmpty(env, "VITE_EVM_ROBINHOOD_RPC_URL");
  requireNonEmpty(env, "VITE_SOLANA_RPC_URL");
  const sol = env.VITE_SOLANA_RPC_URL.toLowerCase();
  if (sol.includes("mainnet")) {
    throw new Error("VITE_SOLANA_RPC_URL must be Solana DEVNET for this cutover (mainnet deferred)");
  }
  if (!sol.includes("devnet") && !sol.includes("127.0.0.1") && !sol.includes("localhost")) {
    console.warn("  WARNING: VITE_SOLANA_RPC_URL does not look like devnet — confirm before continuing.");
  }
  console.log("✓ DEPLOYMENT_DATA.md operator inputs look valid");
  console.log(`  SAFE_ADDRESS   ${safe}`);
  console.log(`  STACK_RELAYER  ${relayer}`);
  console.log(`  Base scope     ${(env.CUTOVER_BASE_SCOPE || "bridge-stake").trim()}`);
}

function writeAppEnv(env) {
  mkdirSync(OUT_DIR, { recursive: true });
  const baseScope = (env.CUTOVER_BASE_SCOPE || "bridge-stake").trim();
  const lines = [
    "# Generated by scripts/cutover-base-robinhood.mjs — do not hand-edit.",
    "# Profile: Solana Devnet + Ethereum Sepolia + Base Mainnet + Robinhood Mainnet",
    "VITE_EVM_NETWORK=mixed",
    `VITE_SOLANA_RPC_URL=${env.VITE_SOLANA_RPC_URL}`,
    `VITE_EVM_SEPOLIA_RPC_URL=${env.VITE_EVM_SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com"}`,
    `VITE_EVM_BASE_RPC_URL=${env.VITE_EVM_BASE_RPC_URL}`,
    `VITE_EVM_ROBINHOOD_RPC_URL=${env.VITE_EVM_ROBINHOOD_RPC_URL}`,
    `VITE_WALLETCONNECT_PROJECT_ID=${env.VITE_WALLETCONNECT_PROJECT_ID || ""}`,
    "",
    "# Ethereum Sepolia (DAO + bridge)",
    `VITE_EVM_SEPOLIA_PROTOCOL_ADDRESS=${KNOWN.sepolia.protocol}`,
    `VITE_EVM_SEPOLIA_FACTORY_ADDRESS=${KNOWN.sepolia.factory}`,
    `VITE_EVM_SEPOLIA_WRAPPED_NAVE_ADDRESS=${KNOWN.sepolia.wrappedNave}`,
    `VITE_EVM_SEPOLIA_BRIDGE_LOCKBOX_ADDRESS=${KNOWN.sepolia.bridge}`,
    `VITE_EVM_SEPOLIA_STAKING_ADDRESS=${KNOWN.sepolia.staking}`,
    "",
    "# Base mainnet (bridge/stake; DAO when CUTOVER_BASE_SCOPE=full)",
    `VITE_EVM_BASE_WRAPPED_NAVE_ADDRESS=${KNOWN.base.wrappedNave}`,
    `VITE_EVM_BASE_BRIDGE_LOCKBOX_ADDRESS=${KNOWN.base.bridge}`,
    `VITE_EVM_BASE_STAKING_ADDRESS=${KNOWN.base.staking}`,
    "",
    "# Robinhood Chain mainnet (bridge/stake only)",
    `VITE_EVM_ROBINHOOD_WRAPPED_NAVE_ADDRESS=${KNOWN.robinhood.wrappedNave}`,
    `VITE_EVM_ROBINHOOD_BRIDGE_LOCKBOX_ADDRESS=${KNOWN.robinhood.bridge}`,
    `VITE_EVM_ROBINHOOD_STAKING_ADDRESS=${KNOWN.robinhood.staking}`,
    "",
    "# Intentionally UNSET (deferred): Ethereum mainnet + Solana mainnet",
    "# VITE_EVM_ETHEREUM_PROTOCOL_ADDRESS=",
    "# VITE_EVM_ETHEREUM_FACTORY_ADDRESS=",
  ];
  if (baseScope === "full") {
    lines.push(
      "",
      "# Base DAO addresses — paste from contracts/evm/deployments/8453.json after --scope full",
      "VITE_EVM_BASE_PROTOCOL_ADDRESS=",
      "VITE_EVM_BASE_FACTORY_ADDRESS=",
    );
  }
  writeFileSync(OUT_ENV, lines.join("\n") + "\n");
  console.log(`✓ Wrote ${OUT_ENV}`);
  console.log("  Merge into Vercel/Railway browser env (or .env.local), then redeploy the app.");
}

function runContractsPhase(chainId, scope, phase, envPath, confirmMainnet) {
  if (!existsSync(CONTRACTS_CUTOVER)) {
    throw new Error(
      `Contracts cutover script not found at ${CONTRACTS_CUTOVER}. ` +
        `Pass CONTRACTS_CUTOVER_PATH or keep the sibling nave-contracts checkout.`,
    );
  }
  const args = [CONTRACTS_CUTOVER, "--chain-id", String(chainId), "--scope", scope, "--phase", phase];
  if (envPath) args.push("--env", envPath);
  if (confirmMainnet) args.push("--confirm-mainnet");
  console.log(`\n→ forge cutover chain=${chainId} scope=${scope} phase=${phase}`);
  const r = spawnSync(process.execPath, args, {
    stdio: "inherit",
    env: {
      ...process.env,
      // Prefer per-chain RPCs from DEPLOYMENT_DATA so a leftover EVM_RPC_URL cannot mis-route.
      EVM_BASE_RPC_URL: process.env.EVM_BASE_RPC_URL,
      EVM_ROBINHOOD_RPC_URL: process.env.EVM_ROBINHOOD_RPC_URL,
    },
  });
  if (r.status !== 0) {
    throw new Error(`Contracts cutover failed (chain ${chainId}, phase ${phase}, exit ${r.status})`);
  }
}

function deployBoth(env, opts) {
  if (!opts.confirmMainnet) {
    throw new Error("Mainnet deploy requires --confirm-mainnet");
  }
  if (!opts.env) throw new Error("--env <secrets.env> required for deploy (EVM_DEPLOY_PRIVATE_KEY)");
  const baseScope = (env.CUTOVER_BASE_SCOPE || opts.baseScope || "bridge-stake").trim();
  // Inject data-file values into the child via a merged temp is avoided — require
  // the secrets env to also carry SAFE_ADDRESS / STACK_* / RPCs, OR export them.
  process.env.SAFE_ADDRESS = env.SAFE_ADDRESS;
  process.env.STACK_RELAYER = env.STACK_RELAYER;
  process.env.STACK_OWNER = env.SAFE_ADDRESS;
  process.env.EVM_BASE_RPC_URL = env.EVM_BASE_RPC_URL;
  process.env.EVM_ROBINHOOD_RPC_URL = env.EVM_ROBINHOOD_RPC_URL;
  if (env.STACK_SUPPLY_CAP) process.env.STACK_SUPPLY_CAP = env.STACK_SUPPLY_CAP;
  if (env.STACK_PER_TX_CAP) process.env.STACK_PER_TX_CAP = env.STACK_PER_TX_CAP;
  if (env.STACK_DAILY_CAP) process.env.STACK_DAILY_CAP = env.STACK_DAILY_CAP;
  if (env.BASESCAN_API_KEY) process.env.BASESCAN_API_KEY = env.BASESCAN_API_KEY;
  if (env.PROTOCOL_TREASURY) process.env.PROTOCOL_TREASURY = env.PROTOCOL_TREASURY;
  if (env.PYTH_ADDRESS) process.env.PYTH_ADDRESS = env.PYTH_ADDRESS;
  if (env.TOKEN_MINT_FEE_WEI) process.env.TOKEN_MINT_FEE_WEI = env.TOKEN_MINT_FEE_WEI;

  runContractsPhase(8453, baseScope, "all", opts.env, true);
  runContractsPhase(4663, "bridge-stake", "all", opts.env, true);
}

function handoffBoth(env, opts) {
  if (!opts.confirmMainnet) throw new Error("Mainnet handoff requires --confirm-mainnet");
  if (!opts.env) throw new Error("--env <secrets.env> required for handoff");
  process.env.SAFE_ADDRESS = env.SAFE_ADDRESS;
  process.env.EVM_BASE_RPC_URL = env.EVM_BASE_RPC_URL;
  process.env.EVM_ROBINHOOD_RPC_URL = env.EVM_ROBINHOOD_RPC_URL;
  const baseScope = (env.CUTOVER_BASE_SCOPE || opts.baseScope || "bridge-stake").trim();
  runContractsPhase(8453, baseScope, "handoff", opts.env, true);
  runContractsPhase(4663, "bridge-stake", "handoff", opts.env, true);
}

function verifyBoth(env, opts) {
  if (!opts.confirmMainnet) throw new Error("Mainnet verify requires --confirm-mainnet");
  if (!opts.env) throw new Error("--env <secrets.env> required for verify");
  process.env.SAFE_ADDRESS = env.SAFE_ADDRESS;
  process.env.EVM_BASE_RPC_URL = env.EVM_BASE_RPC_URL;
  process.env.EVM_ROBINHOOD_RPC_URL = env.EVM_ROBINHOOD_RPC_URL;
  if (env.BASESCAN_API_KEY) process.env.BASESCAN_API_KEY = env.BASESCAN_API_KEY;
  const baseScope = (env.CUTOVER_BASE_SCOPE || opts.baseScope || "bridge-stake").trim();
  runContractsPhase(8453, baseScope, "verify", opts.env, true);
  runContractsPhase(4663, "bridge-stake", "verify", opts.env, true);
}

function printHelp() {
  console.log(`Usage: node scripts/cutover-base-robinhood.mjs --phase <phase> [options]

Phases: validate | app-env | deploy | handoff | verify | all

Options:
  --env <file>           Secrets env (EVM_DEPLOY_PRIVATE_KEY, etc.)
  --confirm-mainnet      Required for deploy/handoff/verify/all
  --base-scope <scope>   bridge-stake (default) | full

Reads: ${DATA_MD}
Writes: ${OUT_ENV}
`);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }
  if (!existsSync(DATA_MD)) throw new Error(`Missing ${DATA_MD}`);
  const dataEnv = parseEnvBlock(readFileSync(DATA_MD, "utf8"));
  const secrets = loadSecretsEnv(opts.env);
  const env = mergeEnv(dataEnv, secrets);

  if (opts.phase === "validate" || opts.phase === "all") validate(env);
  if (opts.phase === "deploy" || opts.phase === "all") deployBoth(env, opts);
  if (opts.phase === "app-env" || opts.phase === "all") writeAppEnv(env);
  if (opts.phase === "handoff") handoffBoth(env, opts);
  if (opts.phase === "verify") verifyBoth(env, opts);
  // Note: --phase all already runs deploy (which includes handoff+verify via contracts `all`).
  // Separate handoff/verify phases are for re-runs after Safe acceptance.

  console.log("\nDone.");
}

try {
  main();
} catch (err) {
  console.error(`\ncutover-base-robinhood failed: ${err.message || err}`);
  process.exit(1);
}
