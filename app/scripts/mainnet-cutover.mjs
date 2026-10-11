#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EVM_STRATEGIES } from "../src/lib/strategyReadinessData.mjs";
import { deploymentWireRefusal, solanaBridgeProgramConfigRefusal } from "./lib/deploymentArtifactStatus.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const ENV_SCHEMA_PATH = join(ROOT, "scripts", "mainnet-cutover-env.schema.json");
const ABI_META_PATH = join(ROOT, "src", "abi", "abi.meta.json");
// The Nave EVM contracts the app binds to (ERC20 is hand-maintained, excluded).
const EVM_SYNCED_CONTRACTS = ["NaveProtocol", "NaveDAOFactory", "NaveTreasury", "NaveGovernor", "NaveExecution"];
const EVM_BRIDGE_STACK_CONTRACTS = ["WrappedNave", "NaveBridge", "NaveStaking"];
const CUTOVER_SCOPES = new Set(["bridge-stake", "full"]);
const DEFAULT_CUTOVER_SCOPE = "bridge-stake";
const APP_ARTIFACT_PATH = join(ROOT, "deployments", "mainnet-launch-artifact.app.json");
const CONTRACTS_DEFAULT_DIR = resolve(ROOT, "..", "contracts", "solana");
const CONTRACTS_PROGRAM_ENV = "deployments/mainnet-program-ids.env";
const CONTRACTS_ARTIFACT = "deployments/mainnet-launch-artifact.json";
const MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

// Fee-model defaults (mirror nave_core constants + signer/worker defaults). The
// on-chain rates are the authoritative source; these are surfaced in preflight
// and the launch artifact so the operator confirms the posture before cutover.
const DEFAULT_PERFORMANCE_FEE_BPS = 1500; // 15% of realized yield (withdrawal skim)
const DEFAULT_MANAGEMENT_FEE_BPS = 0; // no annual management fee
const DEFAULT_AGENT_SOL = { request: 0.05, operate: 0.1, fillCeiling: 0.25, refillTrigger: 0.1 };
// Solana system-program default pubkey (Pubkey::default()); a revenue wallet
// must never be this all-zeros key.
const SYSTEM_PROGRAM_PUBKEY = "11111111111111111111111111111111";

// ── Unified DAO creation flow (gas and rent only + optional founder seed +
// bootstrap). Mirrors nave_core constants built with `--features mainnet` and
// the contracts cutover: creation charges no protocol fee (FORMATION_FEE_LAMPORTS
// = 0; initialize_dao charges nothing) and does not lock NAVE. The user treasury
// seed is a separate wizard input (wrapped to wSOL, deposited client-side — not
// a fee).
const MAINNET_FORMATION_FEE_LAMPORTS = 0; // fee-free creation (value is inert on-chain)
const MAINNET_TREASURY_SEED_LAMPORTS = 0; // no fee carve-out; user seed is separate
const CREATION_FLOW = {
  protocolFeeLamports: MAINNET_FORMATION_FEE_LAMPORTS,
  treasurySeedLamports: MAINNET_TREASURY_SEED_LAMPORTS,
  totalCarveoutLamports: MAINNET_FORMATION_FEE_LAMPORTS,
  treasurySeedAsset: "wSOL (AssetKind::SolLike) — user-chosen, not a fee carve-out",
  bootstrapImmediateFirstAction: true,
  bootstrapLatch: "dao_registry.bootstrap_used",
  reviewWindowSecs: { default: 86_400, min: 60, max: 604_800 },
};

// Canonical mainnet NAVE SPL mint. New treasuries do not lock it. The mint stays
// pinned so an existing lock can still be identified and released. The devnet
// replica mint (GmBM…) MUST NEVER appear on the mainnet path.
const MAINNET_NAVE_MINT = "EGg56E1YtL5YapzkF7vkRThHR8i5FeRvm2LLuySdYory";
const DEVNET_REPLICA_NAVE_MINT = "GmBMZuXsXpe7TZK27PTcXUyNGcuw9Ew8v3fxys7wM9Wa";
const DAO_STAKE_TARGET_USD = 0;
const NAVE_STAKE_FLOW = {
  mint: MAINNET_NAVE_MINT,
  stakeTargetUsd: DAO_STAKE_TARGET_USD,
  requiredStake: "0",
  pinnedVia: "contracts cutover set_nave_mint still records the canonical mint; new treasuries lock nothing",
  amountSource: "none — forming a treasury does not require NAVE",
  moonlighting: "an existing lock, if any, is released on moonlight; restore_dao reopens without a new stake",
};

// Cluster the signer/edge MUST resolve to for the mainnet cutover. NAVE_CLUSTER
// drives the on-chain Jupiter program-id assertion and the signer rate-limiter
// fail-closed posture; it MUST be exactly "mainnet" on the mainnet path.
const REQUIRED_MAINNET_CLUSTER = "mainnet";

// Fixed Jupiter Lend program IDs on mainnet (not deployed by Nave). The signer +
// edge assert the on-chain program account matches these; the cutover refuses if
// the env values drift from mainnet.
const MAINNET_JUPITER_LENDING_PROGRAM_ID = "jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9";
const MAINNET_JUPITER_LIQUIDITY_PROGRAM_ID = "jupeiUmn818Jg1ekPURTpr4mFo29p46vygyykFJ3wZC";

// Signer rate-limiter + circuit-breaker defaults (mirror signer-service defaults).
// These are surfaced in preflight + the launch artifact so the operator confirms
// the fail-closed posture before cutover. The limiter is backed by Upstash Redis
// and FAILS CLOSED (rejects signing) when Redis is unreachable on mainnet.
const DEFAULT_SIGNER_RATE = {
  perAction: 20,
  perRole: 20,
  global: 300,
  cbThreshold: 5,
  cbWindowMs: 60_000,
  cbCooldownMs: 120_000,
};

// On-chain NAV staleness ceiling (nave_execution::NAV_MAX_STALENESS_SECS = 900).
// Strategy deploys hard-block on stale NAV, so the app-side freshness window
// (NAVE_MAX_NAV_AGE_SECONDS) must never exceed this or deploys pass app-side
// then revert on-chain.
const ONCHAIN_NAV_MAX_STALENESS_SECS = 900;

// Byte offset of treasury_vault.last_revalued_at (i64) within the account data,
// computed from programs/nave_core/src/state/treasury_vault.rs:
// 8 disc + bump 1 + dao 32 + vault_token_account 32 + (total_deposited,
// total_withdrawn, current_nav, high_water_mark, last_management_fee_at,
// last_performance_fee_at, deployed_capital) 8x7 + asset_count 1 = 130 (LEN 138).
const EXPECTED_VAULT_LAST_REVALUED_OFF = 130;

// ─── EVM (Ethereum + Base + Robinhood) cutover config ─────────────────────────
// EVM support is OPTIONAL and additive: a Solana-only mainnet cutover must still
// pass. The EVM gates below fire ONLY when EVM is configured (VITE_EVM_NETWORK
// set or any VITE_EVM_*_FACTORY_ADDRESS present). Scope is fenced to Ethereum +
// Base + Robinhood Chain; any other EVM chain (e.g. BSC 56) is HARD-REJECTED.
// Robinhood (4663 / testnet 46630, Arbitrum Nitro L2) is BRIDGE/STAKE-ONLY:
// it never has factory/protocol/adapter addresses, only the bridge triple.
const EVM_SUPPORTED_CHAIN_IDS = new Set([1, 8453, 4663, 11155111, 84532, 46630, 5042002]);
const EVM_MAINNET_CHAIN_IDS = new Set([1, 8453, 4663]);
// The env-key network segments Nave uses for VITE_EVM_<SEG>_* vars.
const EVM_ENV_SEGMENTS = ["ETHEREUM", "BASE", "ROBINHOOD", "SEPOLIA", "BASE_SEPOLIA", "ROBINHOOD_TESTNET", "ARC_TESTNET"];
// Segments allowed for a MAINNET cutover (testnet segments are rejected on the
// mainnet path so a prod build can't silently point at Sepolia).
const EVM_MAINNET_SEGMENTS = ["ETHEREUM", "BASE", "ROBINHOOD"];
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const ZERO_EVM_ADDRESS = "0x0000000000000000000000000000000000000000";
const MAINNET_EVM_TOKEN_MINT_FEE_WEI = "50000000000000000"; // 0.05 ETH
// EVM creation is FEE-FREE (mirrors Solana): no formation fee, so no treasury
// seed carve-out from a fee. The CONTRACTS EVM cutover
// (contracts/solana/scripts/evm-mainnet-cutover.mjs) is authoritative and enforces
// FORMATION_FEE_WEI = 0 / TREASURY_SEED_WEI = 0 on its mainnet path; the app
// cutover surfaces it for the launch artifact. Forming a treasury does not
// require a NAVE stake. REQUIRED_NAVE_STAKE must be 0.
const MAINNET_EVM_TREASURY_SEED_WEI = "0"; // fee-free creation; no carve-out
const EVM_ADAPTERS = [
  { key: "aaveV3", env: "AAVE_ADAPTER_ADDRESS", artifact: "aaveV3Adapter", readinessId: "aave" },
  { key: "compoundV3", env: "COMPOUND_ADAPTER_ADDRESS", artifact: "compoundV3Adapter", readinessId: "compound" },
  { key: "balancer", env: "BALANCER_ADAPTER_ADDRESS", artifact: "balancerAdapter", readinessId: "balancer" },
];

/**
 * Whether `strategyReadinessData.mjs` (the SAME registry that drives the
 * frontend's Constitution/Assets protocol pickers) expects this adapter to be
 * live on the given mainnet chain id. Protocols explicitly marked
 * `supported: false` there (e.g. a not-yet-validated pool tuple) are cleanly
 * DEFERRED at cutover — they don't block mainnet launch — rather than being
 * unconditionally required like every other adapter.
 */
function isEvmAdapterExpectedAtMainnet(readinessId, chainId) {
  const entry = EVM_STRATEGIES.find((s) => s.id === readinessId);
  const rule = entry?.chains?.[chainId];
  // Default to required (fail closed) if the registry has no explicit rule.
  return rule ? rule.supported === true : true;
}
const EVM_RELEASE_GATES = [
  ["EVM_RELEASE_GATE_TOKEN_ACCESS", "token-gated access"],
  ["EVM_RELEASE_GATE_GOVERNANCE_RATIFICATION", "governance ratification"],
  ["EVM_RELEASE_GATE_EXECUTION_REQUESTS", "execution request creation"],
  ["EVM_RELEASE_GATE_ASSET_REGISTRATION", "asset registration"],
  ["EVM_RELEASE_GATE_REVALUE_KEEPER", "revalue keeper coverage"],
  ["EVM_RELEASE_GATE_EMERGENCY_FREEZE", "emergency freeze"],
  ["EVM_RELEASE_GATE_EXPLORER_LINKS", "EVM explorer links"],
];

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {
    envPath: "",
    keyDir: "",
    phase: "all",
    scope: (process.env.CUTOVER_SCOPE || DEFAULT_CUTOVER_SCOPE).trim(),
    confirmMainnet: false,
    reuseProgramIds: false,
  };
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--env") out.envPath = args[++i];
    else if (args[i] === "--key-dir") out.keyDir = args[++i];
    else if (args[i] === "--phase") out.phase = args[++i];
    else if (args[i] === "--scope") out.scope = args[++i];
    else if (args[i] === "--confirm-mainnet") out.confirmMainnet = true;
    else if (args[i] === "--reuse-program-ids") out.reuseProgramIds = true;
  }
  if (!out.envPath) throw new Error("Missing --env <path>");
  if (!out.keyDir) throw new Error("Missing --key-dir <path>");
  if (!CUTOVER_SCOPES.has(out.scope)) {
    throw new Error(`Invalid --scope "${out.scope}" (allowed: bridge-stake, full).`);
  }
  if (!out.confirmMainnet) throw new Error("Refusing to run without --confirm-mainnet.");
  return out;
}

function isBridgeStakeScope(scope) {
  return scope !== "full";
}

function parseEnvFile(path) {
  const env = {};
  const raw = readFileSync(path, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    env[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return env;
}

function mergeMissing(base, extra) {
  const merged = { ...base };
  for (const [k, v] of Object.entries(extra)) {
    if (!merged[k] && v) merged[k] = v;
  }
  return merged;
}

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    cwd: options.cwd ?? ROOT,
    env: { ...process.env, ...(options.env ?? {}) },
    stdio: options.stdio ?? "inherit",
    encoding: options.encoding ?? "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${cmd} ${args.join(" ")}`);
  }
  return result;
}

function runCapture(cmd, args, options = {}) {
  const result = run(cmd, args, { ...options, stdio: "pipe" });
  return result.stdout.trim();
}

function loadSchemaRequiredKeys(scope) {
  const schema = JSON.parse(readFileSync(ENV_SCHEMA_PATH, "utf8"));
  const base = schema.required ?? [];
  if (isBridgeStakeScope(scope)) return base;
  const fullExtra = schema.requiredFull ?? [];
  return [...new Set([...base, ...fullExtra])];
}

function assertRequiredEnv(env, scope) {
  const required = loadSchemaRequiredKeys(scope);
  const missing = required.filter((key) => !env[key]);
  if (missing.length) {
    throw new Error(
      `Missing required env keys for scope=${scope}: ${missing.join(", ")}`,
    );
  }
}

async function assertMainnetRpc(url) {
  const payload = { jsonrpc: "2.0", id: 1, method: "getGenesisHash", params: [] };
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) throw new Error(`RPC check failed with status ${resp.status}`);
  const json = await resp.json();
  const hash = json?.result;
  if (!hash || !String(hash).startsWith(MAINNET_GENESIS_HASH)) {
    throw new Error(`MAINNET_RPC_URL does not point to mainnet-beta (genesis hash: ${hash ?? "missing"})`);
  }
}

async function readEvmChainId(url, label) {
  const payload = { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] };
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) throw new Error(`${label} RPC chain-id check failed with status ${resp.status}`);
  const json = await resp.json();
  const raw = json?.result;
  if (typeof raw !== "string" || !/^0x[0-9a-fA-F]+$/.test(raw)) {
    throw new Error(`${label} RPC returned invalid eth_chainId result: ${JSON.stringify(raw)}`);
  }
  return Number.parseInt(raw, 16);
}

async function assertEvmRpcMainnet(env) {
  if (!evmEnabled(env)) return;
  const c = resolveEvmConfig(env);
  const checks = [
    ["Ethereum server", c.indexerRpc.ethereum, 1],
    ["Ethereum browser", c.ethereum.rpc, 1],
    ["Base server", c.indexerRpc.base, 8453],
    ["Base browser", c.base.rpc, 8453],
    ["Robinhood server", c.indexerRpc.robinhood, 4663],
    ["Robinhood browser", c.robinhood.rpc, 4663],
  ];
  for (const [label, url, expected] of checks) {
    if (!url) continue;
    const chainId = await readEvmChainId(url, label);
    if (chainId !== expected) {
      throw new Error(`${label} RPC must serve chain ${expected} for mainnet cutover; got ${chainId}.`);
    }
  }
}

function assertNoDevnetValues(env) {
  const inspectKeys = [
    "MAINNET_RPC_URL",
    "VITE_SUPABASE_URL",
    "NAVE_SIGNER_URL",
    "WEBHOOK_URL",
    "UPSTASH_REDIS_REST_URL",
  ];
  for (const key of inspectKeys) {
    const val = env[key] ?? "";
    if (val.includes("devnet") || val.includes("localhost") || val.includes("127.0.0.1")) {
      throw new Error(`${key} contains non-mainnet endpoint: ${val}`);
    }
  }
}

function assertSafetyEnv(env, scope) {
  if (env.VITE_USE_MOCKS !== "false") throw new Error("VITE_USE_MOCKS must be false.");
  if (!isBridgeStakeScope(scope)) {
    if (env.VITE_ESCROW_PDA_ENABLED !== "true") throw new Error("VITE_ESCROW_PDA_ENABLED must be true.");
    if (env.NAVE_ESCROW_PDA_ENABLED !== "true") throw new Error("NAVE_ESCROW_PDA_ENABLED must be true.");
  }
  if (env.NAVE_SIGNER_SECRET === env.NAVE_INDEXER_SECRET) {
    throw new Error("NAVE_SIGNER_SECRET must not equal NAVE_INDEXER_SECRET.");
  }
  const agent = (env.NAVE_AGENT_SECRET || "").trim();
  if (agent) {
    if (agent === env.NAVE_SIGNER_SECRET) {
      throw new Error("NAVE_AGENT_SECRET must not equal NAVE_SIGNER_SECRET.");
    }
    if (agent === env.NAVE_INDEXER_SECRET) {
      throw new Error("NAVE_AGENT_SECRET must not equal NAVE_INDEXER_SECRET.");
    }
  }
}

// Resolve the signer/edge cluster + rate-limiter + circuit-breaker posture from
// env, applying the signer-service defaults. The limiter is backed by Upstash
// Redis and the breaker trips on consecutive on-chain rejections.
function resolveSignerInfra(env) {
  return {
    cluster: (env.NAVE_CLUSTER || "").trim(),
    upstashConfigured: Boolean((env.UPSTASH_REDIS_REST_URL || "").trim() && (env.UPSTASH_REDIS_REST_TOKEN || "").trim()),
    skipSimulation: (env.NAVE_SIGNER_SKIP_SIMULATION ?? "false").trim().toLowerCase() === "true",
    ratePerAction: Number(env.NAVE_SIGNER_RATE_PER_ACTION ?? DEFAULT_SIGNER_RATE.perAction),
    ratePerRole: Number(env.NAVE_SIGNER_RATE_PER_ROLE ?? DEFAULT_SIGNER_RATE.perRole),
    rateGlobal: Number(env.NAVE_SIGNER_RATE_GLOBAL ?? DEFAULT_SIGNER_RATE.global),
    cbThreshold: Number(env.NAVE_SIGNER_CB_THRESHOLD ?? DEFAULT_SIGNER_RATE.cbThreshold),
    cbWindowMs: Number(env.NAVE_SIGNER_CB_WINDOW_MS ?? DEFAULT_SIGNER_RATE.cbWindowMs),
    cbCooldownMs: Number(env.NAVE_SIGNER_CB_COOLDOWN_MS ?? DEFAULT_SIGNER_RATE.cbCooldownMs),
  };
}

// Mainnet SAFETY GATE for the signer infrastructure introduced by the audit
// workstream. STRICT, fail-closed: the signer must run on the mainnet cluster,
// have a reachable Upstash limiter (it fails closed without it), keep
// transaction simulation ON, and use sane positive-integer limiter/breaker
// tunables.
function assertSignerInfraSafety(env) {
  const s = resolveSignerInfra(env);

  // Cluster must be exactly "mainnet" — this single switch flips the on-chain
  // Jupiter program-id assertion and the limiter fail-closed behavior to prod.
  if (s.cluster !== REQUIRED_MAINNET_CLUSTER) {
    throw new Error(
      `NAVE_CLUSTER must be "${REQUIRED_MAINNET_CLUSTER}" on the mainnet path (got "${env.NAVE_CLUSTER ?? "<unset>"}"). ` +
        "It drives the Jupiter program-id assertion and the signer rate-limiter fail-closed posture.",
    );
  }

  // Upstash Redis is REQUIRED on mainnet: the signer rate-limiter + circuit
  // breaker are backed by it and the signer FAILS CLOSED (refuses to sign) if
  // it cannot reach Redis. Refuse cutover if either half is missing.
  if (!(env.UPSTASH_REDIS_REST_URL || "").trim() || !(env.UPSTASH_REDIS_REST_TOKEN || "").trim()) {
    throw new Error(
      "UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are REQUIRED on mainnet. " +
        "The signer rate-limiter/circuit-breaker fails closed without a reachable Upstash Redis.",
    );
  }

  // Transaction simulation is a hard mainnet requirement: skipping it removes the
  // last on-chain dry-run guard before broadcasting a signed transaction.
  if (s.skipSimulation) {
    throw new Error(
      'NAVE_SIGNER_SKIP_SIMULATION must NOT be "true" on mainnet. ' +
        "Pre-broadcast simulation is the final fail-closed guard — remove the var or set it to \"false\".",
    );
  }

  // Limiter + breaker tunables must be positive integers when present.
  const intTunables = {
    NAVE_SIGNER_RATE_PER_ACTION: s.ratePerAction,
    NAVE_SIGNER_RATE_PER_ROLE: s.ratePerRole,
    NAVE_SIGNER_RATE_GLOBAL: s.rateGlobal,
    NAVE_SIGNER_CB_THRESHOLD: s.cbThreshold,
    NAVE_SIGNER_CB_WINDOW_MS: s.cbWindowMs,
    NAVE_SIGNER_CB_COOLDOWN_MS: s.cbCooldownMs,
  };
  for (const [key, val] of Object.entries(intTunables)) {
    if (!Number.isInteger(val) || val <= 0) {
      throw new Error(`${key} must be a positive integer (got ${val}).`);
    }
  }

  // Reverse-proxy trust: the signer derives the rate-limit identity from
  // req.ip with `trust proxy` = TRUSTED_PROXY_HOPS (Railway = 1). A leftmost
  // X-Forwarded-For was spoofable; 0 disables proxy trust entirely.
  const hopsRaw = (env.TRUSTED_PROXY_HOPS ?? "").trim();
  if (hopsRaw !== "") {
    const hops = Number(hopsRaw);
    if (!Number.isInteger(hops) || hops < 0 || hops > 4) {
      throw new Error(`TRUSTED_PROXY_HOPS must be an integer in [0, 4] (got "${hopsRaw}").`);
    }
  }

  // EVM key separation: in production the signer REFUSES to boot when
  // NAVE_EVM_MASTER_KEK is missing/malformed while NAVE_MASTER_KEK is set (no
  // silent fallback to the Solana KEK), and the two must differ so a single
  // KEK leak does not unwrap both key families.
  if (evmEnabled(env)) {
    const evmKek = (env.NAVE_EVM_MASTER_KEK || "").trim();
    const solKek = (env.NAVE_MASTER_KEK || "").trim();
    if (!evmKek) {
      throw new Error(
        "NAVE_EVM_MASTER_KEK is REQUIRED when EVM is enabled. The signer (NODE_ENV=production) no longer falls back to NAVE_MASTER_KEK.",
      );
    }
    if (solKek && evmKek === solKek) {
      throw new Error("NAVE_EVM_MASTER_KEK must differ from NAVE_MASTER_KEK (distinct KEK per key family).");
    }
    if ((env.NAVE_EVM_NETWORK || "").trim() !== "mainnet") {
      throw new Error(
        `NAVE_EVM_NETWORK must be "mainnet" on the mainnet path when EVM is enabled (got "${env.NAVE_EVM_NETWORK ?? "<unset>"}").`,
      );
    }
  }
}

// Mainnet SAFETY GATE for the on-chain Jupiter Lend program IDs. The signer/edge
// assert the live program account equals these mainnet IDs; the cutover refuses
// if the env drifts. VITE_ mirrors (when present) must match too.
function assertJupiterProgramIds(env) {
  const checks = [
    ["JUPITER_LENDING_PROGRAM_ID", MAINNET_JUPITER_LENDING_PROGRAM_ID, "VITE_JUPITER_LENDING_PROGRAM_ID"],
    ["JUPITER_LIQUIDITY_PROGRAM_ID", MAINNET_JUPITER_LIQUIDITY_PROGRAM_ID, "VITE_JUPITER_LIQUIDITY_PROGRAM_ID"],
  ];
  for (const [key, expected, viteKey] of checks) {
    const val = (env[key] || "").trim();
    if (val !== expected) {
      throw new Error(`${key} must equal the mainnet Jupiter Lend program id ${expected} (got "${val || "<unset>"}").`);
    }
    const viteVal = (env[viteKey] || "").trim();
    if (viteVal && viteVal !== expected) {
      throw new Error(`${viteKey} must match ${key} (${expected}) — got "${viteVal}".`);
    }
  }
}

// Mainnet SAFETY GATE for the NAV-freshness deploy guard. The treasury-vault
// `last_revalued_at` byte offset must be set (the integration worker computes the
// exact integer; until then a placeholder is required so it is never silently 0),
// and the app-side NAV freshness window must be a positive integer that does NOT
// exceed the on-chain NAV_MAX_STALENESS_SECS (900) — otherwise deploys pass
// app-side then revert on-chain on stale NAV.
function assertNavFreshnessConfig(env) {
  const off = (env.NAVE_VAULT_LAST_REVALUED_OFF ?? "").trim();
  if (!off) {
    throw new Error(
      "NAVE_VAULT_LAST_REVALUED_OFF is required on mainnet (byte offset of treasury_vault.last_revalued_at). " +
        `Expected value for the current TreasuryVault layout is ${EXPECTED_VAULT_LAST_REVALUED_OFF}.`,
    );
  }
  if (!/^[0-9]+$/.test(off)) {
    throw new Error(`NAVE_VAULT_LAST_REVALUED_OFF must be a non-negative integer byte offset (got "${off}").`);
  }
  if (off !== String(EXPECTED_VAULT_LAST_REVALUED_OFF)) {
    throw new Error(
      `NAVE_VAULT_LAST_REVALUED_OFF=${off} does not match the expected offset ${EXPECTED_VAULT_LAST_REVALUED_OFF} ` +
        "for the current TreasuryVault layout (8 disc + bump 1 + dao 32 + vault_token_account 32 + " +
        "total_deposited/withdrawn/current_nav/high_water_mark/last_mgmt_fee/last_perf_fee/deployed_capital 8x7 + asset_count 1). " +
        "If the layout changed, recompute and update EXPECTED_VAULT_LAST_REVALUED_OFF.",
    );
  }

  const navAgeRaw = (env.NAVE_MAX_NAV_AGE_SECONDS ?? "").trim();
  if (!navAgeRaw) {
    throw new Error(
      `NAVE_MAX_NAV_AGE_SECONDS is required on mainnet (NAV freshness window for deploys; recommend ${ONCHAIN_NAV_MAX_STALENESS_SECS} to match on-chain NAV_MAX_STALENESS_SECS).`,
    );
  }
  if (!/^[0-9]+$/.test(navAgeRaw)) {
    throw new Error(`NAVE_MAX_NAV_AGE_SECONDS must be a positive integer (seconds), got "${navAgeRaw}".`);
  }
  const navAge = Number(navAgeRaw);
  if (navAge <= 0 || navAge > ONCHAIN_NAV_MAX_STALENESS_SECS) {
    throw new Error(
      `NAVE_MAX_NAV_AGE_SECONDS must be in (0, ${ONCHAIN_NAV_MAX_STALENESS_SECS}] to stay within the on-chain ` +
        `NAV_MAX_STALENESS_SECS=${ONCHAIN_NAV_MAX_STALENESS_SECS} ceiling (got ${navAge}). Strategy deploys hard-block on stale NAV.`,
    );
  }
}

// Mainnet SAFETY GATE for the bridge and devnet faucet, added after the
// initial devnet launch of both features. Neither has had its Phase 6
// security review yet (see docs/AUDIT_FINDINGS.md) — the faucet gives away
// free NAVE and must never exist on mainnet at all; the bridge is
// testnet-only today and has a known unresolved recipient-authentication gap
// on `/bridge-relay` (a third party could front-run a legitimate lock with
// their own recipient address). Refuse cutover if either is left
// enabled/configured, unless an explicit reviewed-and-approved override is
// set — this prevents either feature from silently riding along into
// mainnet just because its devnet env vars were copied forward.
// Per-chain default confirmation depths (mirror signer-service bridgeRelayer.ts).
// Ethereum ~12s blocks, Base ~2s, Robinhood (Arbitrum Nitro) ~0.25s.
const BRIDGE_EVM_CONFIRMATION_DEFAULTS = { 1: 12, 8453: 30, 4663: 60 };
const BRIDGE_LOOKBACK_SECONDS_MIN = 3600;

function configuredMainnetBridgeChainIds(env) {
  return Object.keys(BRIDGE_EVM_CONFIRMATION_DEFAULTS)
    .map(Number)
    .filter((id) => (env[`BRIDGE_EVM_LOCKBOX_${id}`] ?? "").trim() !== "" || (env[`BRIDGE_EVM_STAKING_${id}`] ?? "").trim() !== "");
}

function assertBridgeConfirmationDepths(env) {
  const floorRaw = (env.BRIDGE_EVM_CONFIRMATIONS ?? "").trim();
  const floor = floorRaw === "" ? 0 : Number(floorRaw);
  if (!Number.isFinite(floor) || floor < 0) {
    throw new Error(`BRIDGE_EVM_CONFIRMATIONS must be a non-negative integer floor when set (got "${floorRaw}").`);
  }
  for (const chainId of configuredMainnetBridgeChainIds(env)) {
    const def = BRIDGE_EVM_CONFIRMATION_DEFAULTS[chainId];
    const raw = (env[`BRIDGE_EVM_CONFIRMATIONS_${chainId}`] ?? "").trim();
    const depth = raw === "" ? def : Number(raw);
    if (!Number.isFinite(depth) || depth < 1) {
      throw new Error(`BRIDGE_EVM_CONFIRMATIONS_${chainId} must be a positive integer (got "${raw}").`);
    }
    if (depth < def) {
      throw new Error(
        `BRIDGE_EVM_CONFIRMATIONS_${chainId}=${depth} is below the mainnet default ${def} for chain ${chainId}. ` +
          "Shallow confirmation depth on a fast L2 is a reorg/finality risk before releasing NAVE on Solana.",
      );
    }
  }
  const lookbackRaw = (env.BRIDGE_LOOKBACK_SECONDS ?? "").trim();
  if (lookbackRaw !== "") {
    const lookback = Number(lookbackRaw);
    if (!Number.isFinite(lookback) || lookback < BRIDGE_LOOKBACK_SECONDS_MIN) {
      throw new Error(
        `BRIDGE_LOOKBACK_SECONDS must be >= ${BRIDGE_LOOKBACK_SECONDS_MIN} on mainnet (got "${lookbackRaw}"); ` +
          "the missed-event scan must cover a realistic relayer outage window.",
      );
    }
  }
}

const BRIDGE_ENV_KEYS = [
  "BRIDGE_RELAYER_ENABLED",
  "BRIDGE_SOLANA_RPC_URL",
  "BRIDGE_SOLANA_NAVE_MINT",
  "BRIDGE_SOLANA_BRIDGE_PROGRAM",
  "BRIDGE_SOLANA_STAKING_PROGRAM",
  "BRIDGE_SOLANA_RELAYER_AUTHORITY",
  "BRIDGE_SOLANA_CUSTODY_AUTHORITY", // legacy alias, still honored
  "BRIDGE_SOLANA_PROTOCOL_FEE_ACCOUNT",
  "BRIDGE_SOLANA_STAKING_POOL_ACCOUNT",
  "BRIDGE_EVM_MINTER_PRIVATE_KEY",
  "BRIDGE_EVM_LOCKBOX_11155111",
  "BRIDGE_EVM_LOCKBOX_84532",
  "BRIDGE_EVM_LOCKBOX_46630",
  // Staking global-parity mirror (drip emission) — rides on the same bridge
  // relayer keys, so it falls under the same reviewed gate.
  "STAKING_MIRROR_ENABLED",
  "BRIDGE_SOLANA_STAKING_COLLECTOR",
  "BRIDGE_EVM_STAKING_11155111",
  "BRIDGE_EVM_STAKING_84532",
  "BRIDGE_EVM_STAKING_46630",
  "BRIDGE_EVM_STAKING_1",
  "BRIDGE_EVM_STAKING_8453",
  "BRIDGE_EVM_STAKING_4663",
  "VITE_NAVE_BRIDGE_PROGRAM_ID",
  "VITE_NAVE_STAKING_PROGRAM_ID",
];

function bridgeEnvConfigured(env) {
  return BRIDGE_ENV_KEYS.some((k) => (env[k] ?? "").trim() !== "");
}

function configuredSolanaProgramId(env, serverKey, viteKey) {
  const server = (env[serverKey] ?? "").trim();
  const vite = (env[viteKey] ?? "").trim();
  if (server && vite && server !== vite) {
    throw new Error(`${serverKey} (${server}) must equal ${viteKey} (${vite}).`);
  }
  return server || vite;
}

async function solanaProgramIsExecutable(rpcUrl, programId) {
  const payload = {
    jsonrpc: "2.0",
    id: 1,
    method: "getAccountInfo",
    params: [programId, { encoding: "base64" }],
  };
  let resp;
  try {
    resp = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new Error(
      `Could not read Solana program ${programId}. Cutover refuses while it is unknown whether the account is executable.`,
    );
  }
  if (!resp.ok) {
    throw new Error(
      `Could not read Solana program ${programId} (RPC status ${resp.status}). Cutover refuses while liveness is unknown.`,
    );
  }
  const json = await resp.json();
  if (json?.error) {
    throw new Error(
      `Could not read Solana program ${programId} (${json.error.message || "RPC error"}). Cutover refuses while liveness is unknown.`,
    );
  }
  const value = json?.result?.value;
  return Boolean(value && value.executable === true);
}

// Bridge env must not point at a closed or missing nave_bridge. The previous
// mainnet ids are closed and cannot be redeployed; a new id has to exist as
// an executable program account before cutover will wire the relayer.
async function assertSolanaBridgeProgramLive(env) {
  const bridgeProgramId = configuredSolanaProgramId(env, "BRIDGE_SOLANA_BRIDGE_PROGRAM", "VITE_NAVE_BRIDGE_PROGRAM_ID");
  const stakingProgramId = configuredSolanaProgramId(env, "BRIDGE_SOLANA_STAKING_PROGRAM", "VITE_NAVE_STAKING_PROGRAM_ID");
  const configError = solanaBridgeProgramConfigRefusal({
    bridgeConfigured: bridgeEnvConfigured(env),
    bridgeProgramId,
    stakingProgramId,
  });
  if (configError) throw new Error(configError);
  if (!bridgeEnvConfigured(env)) return;

  const rpc = (env.BRIDGE_SOLANA_RPC_URL || env.MAINNET_RPC_URL || "").trim();
  if (!rpc) {
    throw new Error(
      "Bridge env is set but neither BRIDGE_SOLANA_RPC_URL nor MAINNET_RPC_URL is set, so cutover cannot confirm nave_bridge is executable.",
    );
  }
  const bridgeLive = await solanaProgramIsExecutable(rpc, bridgeProgramId);
  if (!bridgeLive) {
    throw new Error(
      `Solana bridge program ${bridgeProgramId} is closed or missing (no executable program account). ` +
        "Cutover refuses to wire bridge env against it. Deploy a new nave_bridge id; do not reuse the closed mainnet id.",
    );
  }
  if (stakingProgramId) {
    const stakingLive = await solanaProgramIsExecutable(rpc, stakingProgramId);
    if (!stakingLive) {
      throw new Error(
        `Solana staking program ${stakingProgramId} is closed or missing (no executable program account). ` +
          "Cutover refuses to wire bridge env against it. Deploy a new nave_staking id; do not reuse the closed mainnet id.",
      );
    }
  }
}

function assertBridgeFaucetMainnetSafety(env) {
  const faucetEnabled = (env.FAUCET_ENABLED ?? "").toLowerCase() === "true";
  if (faucetEnabled) {
    throw new Error(
      "FAUCET_ENABLED must not be \"true\" on mainnet. The faucet (NAVE + SOL claims) is a devnet-only " +
        "convenience (free-token giveaway) and must never run against a mainnet wallet/mint.",
    );
  }

  const bridgeConfigured = bridgeEnvConfigured(env);
  const bridgeReviewed = (env.NAVE_BRIDGE_MAINNET_REVIEWED ?? "").toLowerCase() === "true";
  if (bridgeConfigured && !bridgeReviewed) {
    throw new Error(
      "Bridge env vars are configured but NAVE_BRIDGE_MAINNET_REVIEWED is not \"true\". The mainnet-hardened " +
        "bridge (single-signature, recipient embedded on-chain, 2.5% fee split resolved on-chain, per-tx + " +
        "daily caps (inbound release + outbound lock_daily_cap) + dest-chain allowlist + pause + replay guards, multisig owners) must still pass a final review before launch. " +
        "Confirm: wNAVE supplyCap + mintPaused set on-chain; nave_bridge/lockbox owners are the multisig; " +
        "relayer keys are KMS/HSM-backed (see docs/SECRETS.md). Then set NAVE_BRIDGE_MAINNET_REVIEWED=true.",
    );
  }

  // When the bridge IS enabled for mainnet, require the full hardened config so
  // a partially-wired bridge cannot go live (e.g. missing fee destinations, no
  // program id, or no confirmation depth).
  const bridgeEnabled = (env.BRIDGE_RELAYER_ENABLED ?? "").toLowerCase() === "true";
  if (bridgeEnabled && bridgeReviewed) {
    const required = [
      "BRIDGE_SOLANA_NAVE_MINT",
      "BRIDGE_SOLANA_BRIDGE_PROGRAM",
      "BRIDGE_SOLANA_PROTOCOL_FEE_ACCOUNT",
      "BRIDGE_SOLANA_STAKING_POOL_ACCOUNT",
      "BRIDGE_EVM_MINTER_PRIVATE_KEY",
    ];
    const relayerKey =
      (env.BRIDGE_SOLANA_RELAYER_AUTHORITY ?? "").trim() !== "" ||
      (env.BRIDGE_SOLANA_CUSTODY_AUTHORITY ?? "").trim() !== "";
    const missing = required.filter((k) => (env[k] ?? "").trim() === "");
    if (!relayerKey) missing.push("BRIDGE_SOLANA_RELAYER_AUTHORITY");
    const hasLockbox =
      (env.BRIDGE_EVM_LOCKBOX_11155111 ?? "").trim() !== "" ||
      (env.BRIDGE_EVM_LOCKBOX_84532 ?? "").trim() !== "" ||
      (env.BRIDGE_EVM_LOCKBOX_46630 ?? "").trim() !== "" ||
      (env.BRIDGE_EVM_LOCKBOX_1 ?? "").trim() !== "" ||
      (env.BRIDGE_EVM_LOCKBOX_8453 ?? "").trim() !== "" ||
      (env.BRIDGE_EVM_LOCKBOX_4663 ?? "").trim() !== "";
    if (!hasLockbox) missing.push("BRIDGE_EVM_LOCKBOX_<chainId>");
    if (missing.length > 0) {
      throw new Error(
        `Bridge is enabled for mainnet but required hardened config is missing: ${missing.join(", ")}. ` +
          "The mint path must go through the NaveBridge lockbox and the fee split must have on-chain destinations.",
      );
    }
    // Chain-aware confirmation depth. The relayer resolves
    // BRIDGE_EVM_CONFIRMATIONS_<chainId> (authoritative per chain) and treats
    // BRIDGE_EVM_CONFIRMATIONS only as a floor that can deepen — never shallow —
    // a chain default. Refuse a mainnet cutover that lowers any configured
    // chain below its default (a fixed "5" is ~1s of Robinhood blocks).
    assertBridgeConfirmationDepths(env);

    // Family-name → chain-id resolution no longer sniffs the Solana cluster;
    // the relayer requires an explicit NAVE_EVM_NETWORK.
    if ((env.NAVE_EVM_NETWORK || "").trim() !== "mainnet") {
      throw new Error(
        `NAVE_EVM_NETWORK must be "mainnet" on the mainnet path when the bridge is enabled (got "${env.NAVE_EVM_NETWORK ?? "<unset>"}"). ` +
          "The relayer resolves 'base'|'robinhood'|'ethereum' route names from this var and rejects them when it is unset.",
      );
    }

    // ── P1 (audit): multisig owner MUST be distinct from the relayer/rewarder ──
    // The entire on-chain cap/pause/supply guardrail bounds a compromised
    // RELAYER; that bound only holds if the OWNER is a different key. The
    // authoritative owner!=relayer check runs on-chain in the contracts cutover
    // verify phase; here we fail closed at config time so the multisig owners
    // are actually set for the handoff, and reject an obvious mis-set where a
    // relayer/rewarder public address equals a multisig owner.
    const squads = (env.SQUADS_VAULT ?? "").trim();
    const safe = (env.SAFE_ADDRESS ?? "").trim();
    if (!squads) {
      throw new Error(
        "Bridge is enabled for mainnet but SQUADS_VAULT is unset. The Solana bridge/staking config owner " +
          "(nave_bridge/nave_staking) must be the Squads multisig, distinct from the relayer hot key (audit P1).",
      );
    }
    const hasEvmBridge =
      (env.BRIDGE_EVM_LOCKBOX_1 ?? "").trim() !== "" || (env.BRIDGE_EVM_LOCKBOX_8453 ?? "").trim() !== "" ||
      (env.BRIDGE_EVM_LOCKBOX_4663 ?? "").trim() !== "" ||
      (env.BRIDGE_EVM_LOCKBOX_11155111 ?? "").trim() !== "" || (env.BRIDGE_EVM_LOCKBOX_84532 ?? "").trim() !== "" ||
      (env.BRIDGE_EVM_LOCKBOX_46630 ?? "").trim() !== "";
    if (hasEvmBridge && !safe) {
      throw new Error(
        "An EVM bridge lockbox is configured for mainnet but SAFE_ADDRESS is unset. The EVM bridge/staking/token " +
          "owner (NaveBridge/NaveStaking/WrappedNave) must be the Safe multisig, distinct from the relayer/rewarder (audit P1).",
      );
    }
    // Optional explicit relayer/rewarder PUBLIC addresses — when supplied, assert
    // they are NOT the multisig owner (the on-chain verify enforces this from the
    // live accounts regardless).
    const solRelayerPub = (env.BRIDGE_SOLANA_RELAYER_PUBKEY ?? "").trim();
    if (solRelayerPub && solRelayerPub === squads) {
      throw new Error(`P1 violation: BRIDGE_SOLANA_RELAYER_PUBKEY equals SQUADS_VAULT ${squads}. Owner and relayer must be distinct keys.`);
    }
    const evmRelayerAddr = (env.BRIDGE_EVM_RELAYER_ADDRESS ?? "").trim().toLowerCase();
    if (evmRelayerAddr && safe && evmRelayerAddr === safe.toLowerCase()) {
      throw new Error(`P1 violation: BRIDGE_EVM_RELAYER_ADDRESS equals SAFE_ADDRESS ${safe}. Owner and relayer/rewarder must be distinct keys.`);
    }
  }

  // Staking global-parity mirror (rolling 365-day drip emission). When enabled
  // it moves real value (collector -> pools, lockbox mints), so a partially
  // wired mirror must not go live.
  const mirrorEnabled = (env.STAKING_MIRROR_ENABLED ?? "").toLowerCase() === "true";
  if (mirrorEnabled) {
    if (!bridgeEnabled || !bridgeReviewed) {
      throw new Error(
        "STAKING_MIRROR_ENABLED=true requires the hardened bridge to be enabled and reviewed " +
          "(BRIDGE_RELAYER_ENABLED=true + NAVE_BRIDGE_MAINNET_REVIEWED=true) — the mirror reuses the " +
          "bridge relayer keys, lockbox mint path, and custody backing.",
      );
    }
    const collector = (env.BRIDGE_SOLANA_STAKING_COLLECTOR ?? "").trim();
    if (!collector) {
      throw new Error(
        "STAKING_MIRROR_ENABLED=true but BRIDGE_SOLANA_STAKING_COLLECTOR is unset. The mirror needs the " +
          "neutral relayer-owned NAVE collector account that receives the bridge's 1% staking leg.",
      );
    }
    // The fee leg must land in the collector — NOT the pool reward vault — or
    // the mirror has nothing to distribute and Solana double-earns its share.
    const poolAccount = (env.BRIDGE_SOLANA_STAKING_POOL_ACCOUNT ?? "").trim();
    if (poolAccount !== collector) {
      throw new Error(
        "With the staking mirror enabled, BRIDGE_SOLANA_STAKING_POOL_ACCOUNT must equal " +
          "BRIDGE_SOLANA_STAKING_COLLECTOR (the on-chain BridgeConfig staking leg is repointed at the " +
          `collector via set_config). Got pool-account "${poolAccount}" vs collector "${collector}".`,
      );
    }
    if ((env.BRIDGE_SOLANA_STAKING_PROGRAM ?? "").trim() === "") {
      throw new Error(
        "STAKING_MIRROR_ENABLED=true but BRIDGE_SOLANA_STAKING_PROGRAM is unset (nave_staking program id; " +
          "the pool + reward-vault PDAs the mirror funds/syncs derive from it).",
      );
    }
    // Every configured EVM staking pool needs its lockbox (wrap path) on the
    // same chain; mirror mints must use a distinct lockbox replay partition.
    const stakingChainIds = ["1", "8453", "4663", "11155111", "84532", "46630"].filter(
      (id) => (env[`BRIDGE_EVM_STAKING_${id}`] ?? "").trim() !== "",
    );
    for (const id of stakingChainIds) {
      if ((env[`BRIDGE_EVM_LOCKBOX_${id}`] ?? "").trim() === "") {
        throw new Error(
          `BRIDGE_EVM_STAKING_${id} is set but BRIDGE_EVM_LOCKBOX_${id} is missing — the mirror wraps the ` +
            "chain's reward share into wNAVE through that chain's lockbox before notifyReward.",
        );
      }
    }
    const mirrorSrc = (env.STAKING_MIRROR_SRC_CHAIN_ID ?? "901").trim();
    const bridgeSrc = (env.BRIDGE_SOLANA_SRC_CHAIN_ID ?? "900").trim();
    if (mirrorSrc === bridgeSrc) {
      throw new Error(
        `STAKING_MIRROR_SRC_CHAIN_ID (${mirrorSrc}) must differ from BRIDGE_SOLANA_SRC_CHAIN_ID (${bridgeSrc}) — ` +
          "they partition the lockbox replay keys; sharing one would let mirror mints collide with bridge mints.",
      );
    }
  }

  // EVM claim-on-demand rewards: the relayer wraps + mints wNAVE at claim time
  // out of a relayer-owned Solana reserve. Moves real value — must be fully
  // wired or not enabled at all.
  const claimEnabled = (env.STAKE_CLAIM_ENABLED ?? "").toLowerCase() === "true";
  if (claimEnabled) {
    if (!mirrorEnabled) {
      throw new Error(
        "STAKE_CLAIM_ENABLED=true requires STAKING_MIRROR_ENABLED=true — the mirror is what parks each " +
          "tick's EVM fee share in the claim reserve; without it the reserve never refills and claims run dry.",
      );
    }
    if ((env.STAKE_CLAIM_RESERVE ?? "").trim() === "") {
      throw new Error(
        "STAKE_CLAIM_ENABLED=true but STAKE_CLAIM_RESERVE is unset. Claims draw from this relayer-owned " +
          "Solana NAVE token account (reserve → bridge custody → wNAVE mint); create it with the relayer " +
          "wallet as owner BEFORE cutover (it must be a dedicated account, NOT the wallet's ATA).",
      );
    }
    const claimSrc = (env.STAKE_CLAIM_SRC_CHAIN_ID ?? "902").trim();
    const mirrorSrc = (env.STAKING_MIRROR_SRC_CHAIN_ID ?? "901").trim();
    const bridgeSrc = (env.BRIDGE_SOLANA_SRC_CHAIN_ID ?? "900").trim();
    if (claimSrc === bridgeSrc || claimSrc === mirrorSrc) {
      throw new Error(
        `STAKE_CLAIM_SRC_CHAIN_ID (${claimSrc}) must differ from BRIDGE_SOLANA_SRC_CHAIN_ID (${bridgeSrc}) ` +
          `and STAKING_MIRROR_SRC_CHAIN_ID (${mirrorSrc}) — the three partition the lockbox replay keys.`,
      );
    }
  }
}

// Surface the resolved signer-infra + NAV + Jupiter posture in the preflight
// summary so the operator confirms the fail-closed config before cutover.
function printSignerInfraSummary(env) {
  const s = resolveSignerInfra(env);
  console.log("\nSigner infrastructure (fail-closed on mainnet):");
  console.log(`  cluster:                     ${s.cluster} (mainnet-required)`);
  console.log(`  upstash limiter configured:  ${s.upstashConfigured} (required; signer fails closed without it)`);
  console.log(`  skip simulation:             ${s.skipSimulation} (must be false on mainnet)`);
  console.log(`  rate per-action/role/global: ${s.ratePerAction} / ${s.ratePerRole} / ${s.rateGlobal}`);
  console.log(`  circuit breaker:             threshold ${s.cbThreshold}, window ${s.cbWindowMs}ms, cooldown ${s.cbCooldownMs}ms`);
  console.log(`  jupiter lending program id:  ${(env.JUPITER_LENDING_PROGRAM_ID || "").trim()}`);
  console.log(`  jupiter liquidity program id:${(env.JUPITER_LIQUIDITY_PROGRAM_ID || "").trim()}`);
  console.log(`  NAV freshness window (deploy):${(env.NAVE_MAX_NAV_AGE_SECONDS || "").trim()}s (on-chain ceiling ${ONCHAIN_NAV_MAX_STALENESS_SECS}s)`);
  console.log(`  treasury_vault.last_revalued_at offset: ${(env.NAVE_VAULT_LAST_REVALUED_OFF || "").trim()}`);
  const faucetEnabled = (env.FAUCET_ENABLED ?? "").toLowerCase() === "true";
  const bridgeReviewed = (env.NAVE_BRIDGE_MAINNET_REVIEWED ?? "").toLowerCase() === "true";
  console.log(`  faucet enabled:               ${faucetEnabled} (must be false on mainnet)`);
  console.log(`  bridge mainnet-reviewed:      ${bridgeReviewed} (only relevant if BRIDGE_* vars are set)`);
}

// Agent-autonomy flag states with defaults applied, mirroring the runtime
// resolution in agent-dispatcher / agent-orchestrator / proposal-creator. The
// dispatcher treats an unset NAVE_GUARDRAILS_FAIL_CLOSED as fail-closed; only
// the literal string "false" relaxes it.
function resolveAgentAutonomy(env) {
  return {
    model: (env.NAVE_AGENT_MODEL || "").trim() || "claude-sonnet-4-6",
    guardrailsFailClosed: (env.NAVE_GUARDRAILS_FAIL_CLOSED ?? "true").toLowerCase() !== "false",
    autoProposeEnabled: (env.NAVE_AUTOPROPOSE_ENABLED ?? "false").toLowerCase() === "true",
    autoProposeWithdrawEnabled: (env.NAVE_AUTOPROPOSE_WITHDRAW_ENABLED ?? "false").toLowerCase() === "true",
    compoundEnabled: (env.NAVE_COMPOUND_ENABLED ?? "false").toLowerCase() === "true",
    compoundMinGainBps: Number(env.NAVE_COMPOUND_MIN_GAIN_BPS ?? "100"),
  };
}

// Mainnet SAFETY GATE for the agent-autonomy flags introduced by the agent
// optimization workstream. The deterministic guardrails + on-chain invariants
// are the signing authority, so they must NEVER be relaxed in production.
function assertAgentFlagSafety(env) {
  // Fail-closed guardrails are mandatory on mainnet. Refuse cutover if the
  // dispatcher is explicitly relaxed to fail-open.
  const failClosedRaw = (env.NAVE_GUARDRAILS_FAIL_CLOSED ?? "true").trim().toLowerCase();
  if (failClosedRaw === "false") {
    throw new Error(
      'NAVE_GUARDRAILS_FAIL_CLOSED must not be "false" on mainnet. ' +
        'The dispatcher must fail closed — remove the var (unset defaults to fail-closed) or set it to "true".',
    );
  }
  if (failClosedRaw !== "true") {
    throw new Error(
      `NAVE_GUARDRAILS_FAIL_CLOSED must be "true" or unset on mainnet (got "${env.NAVE_GUARDRAILS_FAIL_CLOSED}").`,
    );
  }

  // The autonomy flags are explicit opt-ins; when set they must be boolean-like.
  for (const key of ["NAVE_AUTOPROPOSE_ENABLED", "NAVE_AUTOPROPOSE_WITHDRAW_ENABLED", "NAVE_COMPOUND_ENABLED"]) {
    const val = env[key];
    if (val !== undefined && !["true", "false"].includes(String(val).trim().toLowerCase())) {
      throw new Error(`${key} must be "true" or "false" when set (got "${val}").`);
    }
  }

  // Withdraw auto-proposing is an ADDITIONAL gate layered on auto-proposing; it
  // is meaningless (and likely a misconfiguration) without the master gate.
  const autonomy = resolveAgentAutonomy(env);
  if (autonomy.autoProposeWithdrawEnabled && !autonomy.autoProposeEnabled) {
    throw new Error(
      "NAVE_AUTOPROPOSE_WITHDRAW_ENABLED=true requires NAVE_AUTOPROPOSE_ENABLED=true " +
        "(withdraw auto-proposing is layered on the master auto-propose gate).",
    );
  }

  // Compound min-gain must be a non-negative integer (bps) when present.
  if (env.NAVE_COMPOUND_MIN_GAIN_BPS !== undefined) {
    if (!/^[0-9]+$/.test(String(env.NAVE_COMPOUND_MIN_GAIN_BPS).trim())) {
      throw new Error("NAVE_COMPOUND_MIN_GAIN_BPS must be a non-negative integer (bps).");
    }
  }
}

// Surface the resolved agent-autonomy posture in the preflight summary so the
// operator confirms the staged-autonomy state before cutover.
function printAgentAutonomySummary(env) {
  const a = resolveAgentAutonomy(env);
  console.log("\nAgent autonomy posture (staged behind flags):");
  console.log(`  dispatcher model:            ${a.model}`);
  console.log(`  guardrails fail-closed:      ${a.guardrailsFailClosed} (mainnet-required)`);
  console.log(`  auto-propose (master gate):  ${a.autoProposeEnabled}`);
  console.log(`  auto-propose withdraw legs:  ${a.autoProposeWithdrawEnabled}`);
  console.log(`  compound (harvest->redeploy):${a.compoundEnabled}`);
  console.log(`  compound min gain (bps):     ${a.compoundMinGainBps}`);
}

// Resolve the yield-only fee posture from env. `protocolRevenueWallet` receives
// the 15% realized-yield skim taken on strategy withdrawal. The management fee
// is 0, and the signer no longer runs a collector.
function resolveFeeModel(env) {
  return {
    protocolRevenueWallet: (env.NAVE_PROTOCOL_REVENUE_WALLET || env.VITE_NAVE_PROTOCOL_FEE_WALLET || "").trim(),
    performanceFeeBps: Number(env.NAVE_PERFORMANCE_FEE_BPS ?? DEFAULT_PERFORMANCE_FEE_BPS),
    managementFeeBps: Number(env.NAVE_MANAGEMENT_FEE_BPS ?? DEFAULT_MANAGEMENT_FEE_BPS),
    agentSol: {
      request: Number(env.NAVE_AGENT_SOL_REQUEST_THRESHOLD ?? DEFAULT_AGENT_SOL.request),
      operate: Number(env.NAVE_AGENT_SOL_OPERATE_LEVEL ?? DEFAULT_AGENT_SOL.operate),
      fillCeiling: Number(env.NAVE_AGENT_SOL_FILL_CEILING ?? DEFAULT_AGENT_SOL.fillCeiling),
      refillTrigger: Number(env.NAVE_AGENT_SOL_REFILL_TRIGGER ?? DEFAULT_AGENT_SOL.refillTrigger),
    },
  };
}

// Mainnet SAFETY GATE for the fee redesign. The protocol revenue wallet is
// REQUIRED and validated non-zero (it is bound into every DAO at creation and
// receives the yield skim); fee bps must be the yield-only model (1500 / 0);
// the agent-SOL hysteresis thresholds must be ordered and positive.
function assertFeeModelSafety(env) {
  const f = resolveFeeModel(env);

  // Revenue wallet: present, plausibly a base58 pubkey, and never the all-zeros
  // system-program default.
  const w = f.protocolRevenueWallet;
  if (!w) {
    throw new Error(
      "Protocol revenue wallet is required: set VITE_NAVE_PROTOCOL_FEE_WALLET " +
        "(and/or NAVE_PROTOCOL_REVENUE_WALLET). It receives the 15% yield skim.",
    );
  }
  if (w.length < 32 || w.length > 44) {
    throw new Error(`Protocol revenue wallet "${w}" is not a valid base58 pubkey length.`);
  }
  if (w === SYSTEM_PROGRAM_PUBKEY) {
    throw new Error("Protocol revenue wallet must not be the all-zeros system-program default.");
  }

  for (const [key, val] of [["performance", f.performanceFeeBps], ["management", f.managementFeeBps]]) {
    if (!Number.isInteger(val) || val < 0 || val > 10_000) {
      throw new Error(`${key} fee bps must be an integer in [0, 10000] (got ${val}).`);
    }
  }
  if (f.performanceFeeBps !== DEFAULT_PERFORMANCE_FEE_BPS) {
    throw new Error(
      `NAVE_PERFORMANCE_FEE_BPS must be ${DEFAULT_PERFORMANCE_FEE_BPS} (15% of realized yield). Got ${f.performanceFeeBps}.`,
    );
  }
  if (f.managementFeeBps !== DEFAULT_MANAGEMENT_FEE_BPS) {
    throw new Error(
      `NAVE_MANAGEMENT_FEE_BPS must be ${DEFAULT_MANAGEMENT_FEE_BPS} (no annual management fee). Got ${f.managementFeeBps}.`,
    );
  }

  const s = f.agentSol;
  for (const [key, val] of Object.entries(s)) {
    if (!Number.isFinite(val) || val <= 0) {
      throw new Error(`NAVE_AGENT_SOL ${key} threshold must be a positive number (got ${val}).`);
    }
  }
  // Hysteresis ordering: request ≤ operate ≤ fillCeiling, and refillTrigger ≤ fillCeiling.
  if (!(s.request <= s.operate && s.operate <= s.fillCeiling && s.refillTrigger <= s.fillCeiling)) {
    throw new Error(
      `NAVE_AGENT_SOL thresholds must satisfy request ≤ operate ≤ fillCeiling and refillTrigger ≤ fillCeiling ` +
        `(got request=${s.request}, operate=${s.operate}, refillTrigger=${s.refillTrigger}, fillCeiling=${s.fillCeiling}).`,
    );
  }

}

// On mainnet the revenue wallet must be a REAL, funded account: it pays rent for
// its fee ATAs and is the protocol's live treasury sink. Refuse cutover if the
// account is empty/non-existent on-chain.
async function assertRevenueWalletFunded(env) {
  const f = resolveFeeModel(env);
  const payload = { jsonrpc: "2.0", id: 1, method: "getBalance", params: [f.protocolRevenueWallet] };
  const resp = await fetch(env.MAINNET_RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) throw new Error(`Revenue wallet balance check failed with status ${resp.status}`);
  const json = await resp.json();
  const lamports = json?.result?.value;
  if (typeof lamports !== "number" || lamports <= 0) {
    throw new Error(
      `Protocol revenue wallet ${f.protocolRevenueWallet} is unfunded/non-existent on mainnet ` +
        `(balance: ${lamports ?? "missing"} lamports). Fund it before cutover (it pays rent for its fee ATAs).`,
    );
  }
}

// Surface the resolved fee-model posture in the preflight summary.
function printFeeModelSummary(env) {
  const f = resolveFeeModel(env);
  console.log("\nFee model (yield only):");
  console.log(`  protocol revenue wallet:     ${f.protocolRevenueWallet}`);
  console.log(`  performance fee (yield skim): ${f.performanceFeeBps} bps (${(f.performanceFeeBps / 100).toFixed(2)}% of realized yield)`);
  console.log(`  management fee:               ${f.managementFeeBps} bps (no annual fee; signer does not collect)`);
  console.log(
    `  agent SOL tiers (SOL):       request ${f.agentSol.request} / operate ${f.agentSol.operate} ` +
      `/ refill-trigger ${f.agentSol.refillTrigger} / fill-ceiling ${f.agentSol.fillCeiling}`,
  );
}

// Resolve the unified DAO creation flow posture (fee split + treasury seed +
// bootstrap), applying canonical mainnet defaults. The on-chain constants
// (--features mainnet) and the contracts cutover are authoritative; these are
// surfaced for review + recorded in the launch artifact.
function resolveCreationFlow(env) {
  const feeRaw = (env.FORMATION_FEE_LAMPORTS ?? "").trim();
  const seedRaw = (env.TREASURY_SEED_LAMPORTS ?? "").trim();
  const protocolFeeLamports = /^[0-9]+$/.test(feeRaw) ? Number(feeRaw) : CREATION_FLOW.protocolFeeLamports;
  const treasurySeedLamports = /^[0-9]+$/.test(seedRaw) ? Number(seedRaw) : CREATION_FLOW.treasurySeedLamports;
  return {
    protocolFeeLamports,
    treasurySeedLamports,
    totalCarveoutLamports: protocolFeeLamports + treasurySeedLamports,
    treasurySeedAsset: CREATION_FLOW.treasurySeedAsset,
    bootstrapImmediateFirstAction: CREATION_FLOW.bootstrapImmediateFirstAction,
    bootstrapLatch: CREATION_FLOW.bootstrapLatch,
    reviewWindowSecs: CREATION_FLOW.reviewWindowSecs,
  };
}

// Mainnet SAFETY GATE for formation fee + treasury seed + NAVE stake mint.
// Creation is now FEE-FREE: initialize_dao charges nothing and the on-chain
// FORMATION_FEE_LAMPORTS constant is 0. If an operator pins these env values
// they MUST be exact (fail closed):
//   - FORMATION_FEE_LAMPORTS (if set) MUST equal 0 (no protocol fee at formation).
//   - TREASURY_SEED_LAMPORTS (if set) MUST equal 0 (user seed is separate).
//   - REQUIRED_NAVE_STAKE (if set) MUST equal 0 (forming a treasury does not lock NAVE).
//   - MAINNET_NAVE_MINT (if set) MUST equal the canonical mainnet NAVE mint, and
//     the devnet replica mint MUST NEVER appear anywhere on the mainnet path.
// All OPTIONAL: a Solana-only cutover with none set still passes.
function assertFeeSplitConfig(env) {
  const feeRaw = (env.FORMATION_FEE_LAMPORTS ?? "").trim();
  if (feeRaw) {
    if (!/^[0-9]+$/.test(feeRaw)) {
      throw new Error(`FORMATION_FEE_LAMPORTS must be a non-negative integer (lamports), got "${feeRaw}".`);
    }
    if (Number(feeRaw) !== MAINNET_FORMATION_FEE_LAMPORTS) {
      throw new Error(
        `FORMATION_FEE_LAMPORTS ${feeRaw} must equal ${MAINNET_FORMATION_FEE_LAMPORTS} ` +
          "(creation charges no protocol fee; gas and rent only).",
      );
    }
  }
  const seedRaw = (env.TREASURY_SEED_LAMPORTS ?? "").trim();
  if (seedRaw) {
    if (!/^[0-9]+$/.test(seedRaw)) {
      throw new Error(`TREASURY_SEED_LAMPORTS must be a non-negative integer (lamports), got "${seedRaw}".`);
    }
    if (Number(seedRaw) !== MAINNET_TREASURY_SEED_LAMPORTS) {
      throw new Error(
        `TREASURY_SEED_LAMPORTS ${seedRaw} must equal ${MAINNET_TREASURY_SEED_LAMPORTS} ` +
          "(no fee carve-out; user seed is supplied separately in the creation wizard).",
      );
    }
  }
  assertNaveMintConfig(env);
  const stakeRaw = (env.REQUIRED_NAVE_STAKE ?? "").trim();
  if (stakeRaw && stakeRaw !== "0") {
    throw new Error(
      `REQUIRED_NAVE_STAKE must be 0 or unset (forming a treasury does not require NAVE). Got "${stakeRaw}".`,
    );
  }
}

// Refuse a mismatched mainnet NAVE stake mint, and refuse the devnet replica
// mint anywhere on the mainnet path (fail closed).
function assertNaveMintConfig(env) {
  const raw = (env.MAINNET_NAVE_MINT ?? env.VITE_SOLANA_NAVE_MINT ?? "").trim();
  if (raw && raw !== MAINNET_NAVE_MINT) {
    throw new Error(
      `Mainnet NAVE mint ${raw} must equal the canonical mainnet NAVE mint ${MAINNET_NAVE_MINT}. ` +
        "The canonical NAVE mint is fixed on mainnet; refusing a mismatched mint.",
    );
  }
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string" && v.trim() === DEVNET_REPLICA_NAVE_MINT) {
      throw new Error(
        `Devnet replica NAVE mint ${DEVNET_REPLICA_NAVE_MINT} found in env var ${k}; ` +
          "it must NEVER appear on the mainnet cutover path.",
      );
    }
  }
}

// Surface the unified DAO creation flow posture in the preflight summary.
function printCreationFlowSummary(env) {
  const f = resolveCreationFlow(env);
  const sol = (lamports) => (lamports / 1_000_000_000).toFixed(3);
  console.log("\nUnified DAO creation flow (gas and rent only; no NAVE lock; optional founder seed + bootstrap):");
  console.log(`  formation fee (protocol):    ${f.protocolFeeLamports} lamports (${sol(f.protocolFeeLamports)} SOL) — no protocol fee (initialize_dao charges nothing)`);
  console.log(`  NAVE creation stake:         none (required amount 0). An existing lock, if any, is released on moonlight.`);
  console.log(`  treasury seed (per DAO):     ${f.treasurySeedLamports} lamports (${sol(f.treasurySeedLamports)} SOL) — user-chosen ${f.treasurySeedAsset}`);
  console.log(`  bootstrap activation:        founder-gated create_execution_request(bootstrap=true) snapshots review_window=0 (immediate first action); ${f.bootstrapLatch} blocks reuse`);
  console.log(`  review window (editable):    default ${f.reviewWindowSecs.default}s, bounds ${f.reviewWindowSecs.min}s..${f.reviewWindowSecs.max}s via set_review_window`);
}

function toolPreflight() {
  run("node", ["--version"]);
  run("npm", ["--version"]);
  run("supabase", ["--version"]);
  run("solana", ["--version"]);
}

// True when the EVM (Ethereum + Base + Robinhood) path is configured for this cutover.
function evmEnabled(env) {
  if ((env.VITE_EVM_NETWORK || "").trim()) return true;
  if (EVM_ENV_SEGMENTS.some((seg) => (env[`VITE_EVM_${seg}_FACTORY_ADDRESS`] || "").trim())) return true;
  // Bridge/stake triple addresses (no DAO factory required).
  for (const seg of ["ETHEREUM", "BASE", "ROBINHOOD", "SEPOLIA", "BASE_SEPOLIA", "ROBINHOOD_TESTNET"]) {
    if (
      (env[`VITE_EVM_${seg}_WRAPPED_NAVE_ADDRESS`] || "").trim() ||
      (env[`VITE_EVM_${seg}_BRIDGE_LOCKBOX_ADDRESS`] || "").trim() ||
      (env[`VITE_EVM_${seg}_STAKING_ADDRESS`] || "").trim()
    ) {
      return true;
    }
  }
  return false;
}

// Resolve the EVM posture (addresses + RPC + verify + signer/indexer env).
function resolveEvmConfig(env) {
  const network = (env.VITE_EVM_NETWORK || "").trim();
  const seg = (s) => ({
    factory: (env[`VITE_EVM_${s}_FACTORY_ADDRESS`] || "").trim(),
    protocol: (env[`VITE_EVM_${s}_PROTOCOL_ADDRESS`] || "").trim(),
    rpc: (env[`VITE_EVM_${s === "ETHEREUM" ? "ETHEREUM" : s}_RPC_URL`] || "").trim(),
    adapters: Object.fromEntries(EVM_ADAPTERS.map((a) => [a.key, (env[`VITE_EVM_${s}_${a.env}`] || "").trim()])),
  });
  return {
    network,
    ethereum: seg("ETHEREUM"),
    base: seg("BASE"),
    sepolia: seg("SEPOLIA"),
    baseSepolia: seg("BASE_SEPOLIA"),
    // Robinhood is bridge/stake-only — no factory/protocol/adapters; only the
    // browser RPC + the bridge triple (wNAVE / lockbox / staking) exist for it.
    robinhood: {
      rpc: (env.VITE_EVM_ROBINHOOD_RPC_URL || "").trim(),
      wrappedNave: (env.VITE_EVM_ROBINHOOD_WRAPPED_NAVE_ADDRESS || "").trim(),
      bridgeLockbox: (env.VITE_EVM_ROBINHOOD_BRIDGE_LOCKBOX_ADDRESS || "").trim(),
      staking: (env.VITE_EVM_ROBINHOOD_STAKING_ADDRESS || "").trim(),
    },
    etherscanApiKey: (env.ETHERSCAN_API_KEY || "").trim(),
    basescanApiKey: (env.BASESCAN_API_KEY || "").trim(),
    indexerRpc: {
      ethereum: (env.EVM_ETHEREUM_RPC_URL || "").trim(),
      base: (env.EVM_BASE_RPC_URL || "").trim(),
      robinhood: (env.EVM_ROBINHOOD_RPC_URL || "").trim(),
    },
    evmMasterKek: (env.NAVE_EVM_MASTER_KEK || env.NAVE_MASTER_KEK || "").trim(),
    abiPath: (env.NAVE_EVM_ABI_PATH || "").trim(),
    protocolRevenueWallet: (env.VITE_EVM_PROTOCOL_REVENUE_WALLET || "").trim(),
    tokenMintFeeWei: (env.TOKEN_MINT_FEE_WEI || "").trim(),
    tokenRevokeRewardWei: (env.TOKEN_REVOKE_REWARD_WEI || "0").trim(),
    // Formation-fee carve-out into each new DAO treasury. The CONTRACTS EVM
    // cutover enforces the canonical wei on its mainnet path; surfaced here for
    // the launch artifact. NOT FINALIZED — confirm before mainnet launch.
    formationFeeWei: (env.FORMATION_FEE_WEI || "").trim(),
    treasurySeedWei: (env.TREASURY_SEED_WEI || "").trim(),
  };
}

function isNonZeroEvmAddress(value) {
  return EVM_ADDRESS_RE.test(value) && value.toLowerCase() !== ZERO_EVM_ADDRESS;
}

function evmContractsDir(env) {
  const contractsDir = env.CONTRACTS_DIR || CONTRACTS_DEFAULT_DIR;
  return env.EVM_CONTRACTS_DIR || resolve(contractsDir, "..", "evm");
}

function readJsonIfExists(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

function normalizeAdapterArtifact(raw) {
  const adapters = raw?.adapters && typeof raw.adapters === "object" ? raw.adapters : raw;
  const out = {};
  for (const adapter of EVM_ADAPTERS) {
    const val = adapters?.[adapter.key] ?? adapters?.[adapter.artifact];
    if (typeof val === "string" && isNonZeroEvmAddress(val)) out[adapter.key] = val;
  }
  return out;
}

function assertEvmChainArtifacts(env, chainName, segment, chainId, chainConfig) {
  if (!chainConfig.factory && !chainConfig.protocol) return;
  const deployDir = join(evmContractsDir(env), "deployments");
  const coreArtifact = readJsonIfExists(join(deployDir, `${chainId}.json`));
  if (!coreArtifact) {
    throw new Error(`Missing EVM core deployment artifact for ${chainName}: ${join(deployDir, `${chainId}.json`)}`);
  }
  const coreRefusal = deploymentWireRefusal(coreArtifact);
  if (coreRefusal) {
    throw new Error(
      `${chainName} deployment ${chainId}.json is not a production artifact (${coreRefusal}). ` +
        "Refusing to match cutover env against it. Chain 1 DAO addresses are required before yield-sister cutover, and the Anvil fixture is not that stack.",
    );
  }
  for (const [field, envValue] of [["protocol", chainConfig.protocol], ["factory", chainConfig.factory]]) {
    const artifactValue = coreArtifact[field];
    if (typeof artifactValue !== "string" || artifactValue.toLowerCase() !== envValue.toLowerCase()) {
      throw new Error(
        `VITE_EVM_${segment}_${field.toUpperCase()}_ADDRESS (${envValue}) does not match ` +
          `${chainId}.json ${field} (${artifactValue || "<missing>"}).`,
      );
    }
  }

  const adapterArtifact = readJsonIfExists(join(deployDir, `adapters-${chainId}.json`));
  if (!adapterArtifact) {
    throw new Error(`Missing EVM adapter deployment artifact for ${chainName}: ${join(deployDir, `adapters-${chainId}.json`)}`);
  }
  const deployedAdapters = normalizeAdapterArtifact(adapterArtifact);
  for (const adapter of EVM_ADAPTERS) {
    const envValue = chainConfig.adapters[adapter.key];
    if (!isEvmAdapterExpectedAtMainnet(adapter.readinessId, chainId)) {
      // Deferred per src/lib/strategyReadinessData.mjs (e.g. pool tuple not
      // yet validated) — do not block cutover, but never silently accept a
      // stray address for a protocol the registry says isn't ready either.
      if (isNonZeroEvmAddress(envValue)) {
        throw new Error(
          `VITE_EVM_${segment}_${adapter.env} is set, but src/lib/strategyReadinessData.mjs marks ` +
            `"${adapter.readinessId}" as not yet supported on chain ${chainId}. Update the registry ` +
            `once the adapter/pool has been validated, rather than configuring the address ahead of it.`,
        );
      }
      console.log(`  (deferred) ${chainName} ${adapter.readinessId}: not required — marked unsupported in strategyReadinessData.mjs.`);
      continue;
    }
    if (!isNonZeroEvmAddress(envValue)) {
      throw new Error(`VITE_EVM_${segment}_${adapter.env} is required and must be non-zero for ${chainName} mainnet cutover.`);
    }
    const artifactValue = deployedAdapters[adapter.key];
    if (!artifactValue || artifactValue.toLowerCase() !== envValue.toLowerCase()) {
      throw new Error(
        `VITE_EVM_${segment}_${adapter.env} (${envValue}) does not match adapters-${chainId}.json ` +
          `${adapter.key} (${artifactValue || "<missing>"}).`,
      );
    }
  }
}

// Robinhood (bridge/stake-only) artifact match: the env bridge triple must
// mirror the contracts cutover's hardened-bridge artifact for chain 4663
// (written by contracts/solana/scripts/evm-mainnet-cutover.mjs deploy phase).
// Bridge/stake artifact match: env bridge triple must mirror hardened-bridge-<chainId>.json.
function assertBridgeStackArtifacts(env, chainName, segment, chainId, triple) {
  const deployDir = join(evmContractsDir(env), "deployments");
  const artifactPath = join(deployDir, `hardened-bridge-${chainId}.json`);
  const artifact = readJsonIfExists(artifactPath);
  if (!artifact) {
    throw new Error(`Missing ${chainName} hardened bridge artifact: ${artifactPath}. Run the EVM cutover deploy phase for chain ${chainId} first.`);
  }
  const stackRefusal = deploymentWireRefusal(artifact);
  if (stackRefusal) {
    throw new Error(
      `${chainName} hardened-bridge-${chainId}.json is not wireable (${stackRefusal}). ` +
        "Refusing to treat it as the live bridge stack.",
    );
  }
  for (const [envName, envValue, field] of [
    [`VITE_EVM_${segment}_WRAPPED_NAVE_ADDRESS`, triple.wrappedNave, "wrappedNave"],
    [`VITE_EVM_${segment}_BRIDGE_LOCKBOX_ADDRESS`, triple.bridgeLockbox, "naveBridge"],
    [`VITE_EVM_${segment}_STAKING_ADDRESS`, triple.staking, "naveStaking"],
  ]) {
    const artifactValue = artifact[field];
    if (typeof artifactValue !== "string" || artifactValue.toLowerCase() !== envValue.toLowerCase()) {
      throw new Error(
        `${envName} (${envValue}) does not match hardened-bridge-${chainId}.json ${field} (${artifactValue || "<missing>"}).`,
      );
    }
  }
}

function assertRobinhoodBridgeArtifacts(env, rh) {
  assertBridgeStackArtifacts(env, "Robinhood Chain", "ROBINHOOD", 4663, rh);
}

// Robinhood yield leaves the chain via the Arbitrum ETH adapter toward an
// Ethereum sister treasury. That destination does not exist while chain 1's
// DAO artifact is the Anvil fixture.
function assertYieldSisterRequiresChain1Dao(env) {
  const arb = (env.VITE_EVM_ROBINHOOD_ARBITRUM_BRIDGE_ADAPTER_ADDRESS || "").trim();
  if (!isNonZeroEvmAddress(arb)) return;
  const protocol = (env.VITE_EVM_ETHEREUM_PROTOCOL_ADDRESS || "").trim();
  const factory = (env.VITE_EVM_ETHEREUM_FACTORY_ADDRESS || "").trim();
  if (!isNonZeroEvmAddress(protocol) || !isNonZeroEvmAddress(factory)) {
    throw new Error(
      "Yield-sister cutover requires chain-1 DAO addresses before Robinhood can bridge yield to an Ethereum sister treasury. " +
        "Set VITE_EVM_ETHEREUM_PROTOCOL_ADDRESS and VITE_EVM_ETHEREUM_FACTORY_ADDRESS from a real deployments/1.json. " +
        "The checked-in file is an Anvil fixture (daoStack undeployed) and must not be used.",
    );
  }
  const artifactPath = join(evmContractsDir(env), "deployments", "1.json");
  const artifact = readJsonIfExists(artifactPath);
  const reason = deploymentWireRefusal(artifact);
  if (!artifact || reason) {
    throw new Error(
      `Yield-sister cutover requires a production chain-1 DAO artifact at ${artifactPath}` +
        (reason ? ` (${reason})` : " (file missing)") +
        ". Deploy the Ethereum mainnet DAO stack before wiring the Robinhood yield adapter.",
    );
  }
}

function assertEvmReleaseGates(env) {
  if (!evmEnabled(env)) return;
  const missing = EVM_RELEASE_GATES
    .filter(([key]) => (env[key] || "").trim().toLowerCase() !== "passed")
    .map(([key, label]) => `${key} (${label})`);
  if (missing.length) {
    throw new Error(`EVM release gates must be explicitly marked "passed": ${missing.join(", ")}.`);
  }
}

// Mainnet SAFETY GATE for the EVM path. Fires only when EVM is enabled. STRICT,
// fail-closed: reject any unexpected EVM chain id (BSC 56, Polygon, Arbitrum, …),
// require mainnet (not testnet) addresses on the mainnet cutover, validate the
// 0x address shape, and require the Etherscan/Basescan verify keys + per-chain
// RPC + an EVM signing KEK whenever the corresponding chain is configured.
function assertEvmConfig(env, scope) {
  if (!evmEnabled(env)) return; // Solana-only cutover; nothing to validate.
  const c = resolveEvmConfig(env);
  const bridgeStakeOnly = isBridgeStakeScope(scope);

  if (!bridgeStakeOnly && c.network !== "mainnet") {
    throw new Error(
      `VITE_EVM_NETWORK must be "mainnet" on the mainnet cutover when EVM is enabled (got "${c.network || "<unset>"}").`,
    );
  }

  // Reject any out-of-scope EVM chain env. We only allow the four known segments;
  // an explicit numeric chain-id env (if present) must be in the supported set
  // and never a testnet on the mainnet path.
  for (const key of Object.keys(env)) {
    const m = key.match(/^VITE_EVM_([A-Z0-9_]+)_(FACTORY|PROTOCOL|AAVE_ADAPTER|COMPOUND_ADAPTER|BALANCER_ADAPTER)_ADDRESS$/);
    if (m && !EVM_ENV_SEGMENTS.includes(m[1])) {
      throw new Error(`Unsupported EVM env segment in ${key}. Allowed: ${EVM_ENV_SEGMENTS.join(", ")} (no BSC/Polygon/Arbitrum).`);
    }
  }
  const declaredId = (env.VITE_EVM_CHAIN_ID || "").trim();
  if (declaredId) {
    const idNum = Number(declaredId);
    if (!EVM_SUPPORTED_CHAIN_IDS.has(idNum)) {
      throw new Error(`VITE_EVM_CHAIN_ID ${declaredId} is not a supported Nave EVM chain (1, 8453, 4663, 11155111, 84532, 46630, 5042002).`);
    }
    if (!EVM_MAINNET_CHAIN_IDS.has(idNum)) {
      throw new Error(`VITE_EVM_CHAIN_ID ${declaredId} is a testnet; the mainnet cutover requires 1, 8453 or 4663.`);
    }
  }

  // Testnet bridge addresses must NOT ride into a mainnet build (wrong-network
  // wNAVE/lockbox/staking would break the bridge silently).
  for (const seg of ["SEPOLIA", "BASE_SEPOLIA", "ROBINHOOD_TESTNET", "ARC_TESTNET"]) {
    for (const suffix of ["WRAPPED_NAVE_ADDRESS", "BRIDGE_LOCKBOX_ADDRESS", "STAKING_ADDRESS"]) {
      if ((env[`VITE_EVM_${seg}_${suffix}`] || "").trim()) {
        throw new Error(
          `VITE_EVM_${seg}_${suffix} is set on the mainnet cutover path. Remove testnet bridge addresses from the mainnet env.`,
        );
      }
    }
  }

  // Testnet segments must NOT carry addresses on the mainnet path.
  for (const seg of ["SEPOLIA", "BASE_SEPOLIA", "ARC_TESTNET"]) {
    if ((env[`VITE_EVM_${seg}_FACTORY_ADDRESS`] || "").trim() || (env[`VITE_EVM_${seg}_PROTOCOL_ADDRESS`] || "").trim()) {
      throw new Error(`Testnet segment ${seg} must not be configured on the mainnet cutover (set only ETHEREUM/BASE).`);
    }
  }

  // At least one mainnet chain must be configured.
  const chains = [
    { name: "Ethereum", segment: "ETHEREUM", chainId: 1, v: c.ethereum, key: c.etherscanApiKey, keyName: "ETHERSCAN_API_KEY", rpc: c.indexerRpc.ethereum, rpcName: "EVM_ETHEREUM_RPC_URL" },
    { name: "Base", segment: "BASE", chainId: 8453, v: c.base, key: c.basescanApiKey, keyName: "BASESCAN_API_KEY", rpc: c.indexerRpc.base, rpcName: "EVM_BASE_RPC_URL" },
  ];
  let anyConfigured = false;

  if (bridgeStakeOnly) {
    for (const ch of chains) {
      const triple = {
        wrappedNave: (env[`VITE_EVM_${ch.segment}_WRAPPED_NAVE_ADDRESS`] || "").trim(),
        bridgeLockbox: (env[`VITE_EVM_${ch.segment}_BRIDGE_LOCKBOX_ADDRESS`] || "").trim(),
        staking: (env[`VITE_EVM_${ch.segment}_STAKING_ADDRESS`] || "").trim(),
      };
      const hasAny = triple.wrappedNave || triple.bridgeLockbox || triple.staking;
      if (!hasAny) continue;
      anyConfigured = true;
      for (const [name, value] of [
        [`VITE_EVM_${ch.segment}_WRAPPED_NAVE_ADDRESS`, triple.wrappedNave],
        [`VITE_EVM_${ch.segment}_BRIDGE_LOCKBOX_ADDRESS`, triple.bridgeLockbox],
        [`VITE_EVM_${ch.segment}_STAKING_ADDRESS`, triple.staking],
      ]) {
        if (!isNonZeroEvmAddress(value)) {
          throw new Error(`${name} must be a non-zero 0x EVM address (bridge triple ships all-or-nothing).`);
        }
      }
      if (!ch.key) throw new Error(`${ch.keyName} is required to verify ${ch.name} contracts on the EVM cutover.`);
      if (!ch.rpc) throw new Error(`${ch.rpcName} is required for the EVM indexer/relayer on ${ch.name}.`);
      assertBridgeStackArtifacts(env, ch.name, ch.segment, ch.chainId, triple);
    }
  } else {
    for (const ch of chains) {
      const hasAny = ch.v.factory || ch.v.protocol;
      if (!hasAny) continue;
      anyConfigured = true;
      const segment = ch.segment;
      if (!isNonZeroEvmAddress(ch.v.factory)) throw new Error(`VITE_EVM_${segment}_FACTORY_ADDRESS must be a non-zero 0x EVM address.`);
      if (!isNonZeroEvmAddress(ch.v.protocol)) throw new Error(`VITE_EVM_${segment}_PROTOCOL_ADDRESS must be a non-zero 0x EVM address.`);
      if (!ch.key) throw new Error(`${ch.keyName} is required to verify ${ch.name} contracts on the EVM cutover.`);
      if (!ch.rpc) throw new Error(`${ch.rpcName} is required for the EVM indexer/relayer on ${ch.name}.`);
    }
    if (!anyConfigured) {
      throw new Error("EVM enabled (VITE_EVM_NETWORK set) but no Ethereum/Base factory+protocol addresses configured.");
    }
    assertEvmChainArtifacts(env, "Ethereum", "ETHEREUM", 1, c.ethereum);
    assertEvmChainArtifacts(env, "Base", "BASE", 8453, c.base);
    assertEvmReleaseGates(env);
    if (!isNonZeroEvmAddress(c.protocolRevenueWallet)) {
      throw new Error(
        "VITE_EVM_PROTOCOL_REVENUE_WALLET is required and must be a non-zero EVM address when EVM is enabled on mainnet. " +
          "Mainnet DAO creation must not fall back to the founder address for protocol revenue routing.",
      );
    }
    if (c.tokenMintFeeWei !== MAINNET_EVM_TOKEN_MINT_FEE_WEI) {
      throw new Error(
        `TOKEN_MINT_FEE_WEI must be ${MAINNET_EVM_TOKEN_MINT_FEE_WEI} (0.05 ETH) for EVM mainnet cutover; got "${c.tokenMintFeeWei || "<unset>"}".`,
      );
    }
    if (c.tokenRevokeRewardWei !== "0") {
      throw new Error(
        `TOKEN_REVOKE_REWARD_WEI must be 0 for the current EVM contracts; got "${c.tokenRevokeRewardWei}". ` +
          "There is no Solidity-backed revoke reward field yet.",
      );
    }
  }

  // Robinhood Chain (4663) is OPTIONAL and bridge/stake-only.
  const rh = c.robinhood;
  if (rh.wrappedNave || rh.bridgeLockbox || rh.staking) {
    for (const [name, value] of [
      ["VITE_EVM_ROBINHOOD_WRAPPED_NAVE_ADDRESS", rh.wrappedNave],
      ["VITE_EVM_ROBINHOOD_BRIDGE_LOCKBOX_ADDRESS", rh.bridgeLockbox],
      ["VITE_EVM_ROBINHOOD_STAKING_ADDRESS", rh.staking],
    ]) {
      if (!isNonZeroEvmAddress(value)) {
        throw new Error(`${name} must be a non-zero 0x EVM address (the Robinhood bridge triple ships all-or-nothing).`);
      }
    }
    if (!c.indexerRpc.robinhood) {
      throw new Error("EVM_ROBINHOOD_RPC_URL is required for the EVM indexer/relayer when Robinhood bridge addresses are configured.");
    }
    assertRobinhoodBridgeArtifacts(env, rh);
    anyConfigured = true;
  }

  if (!anyConfigured) {
    throw new Error(
      bridgeStakeOnly
        ? "EVM is enabled but no bridge/stake triple is configured (set VITE_EVM_{ETHEREUM,BASE,ROBINHOOD}_* bridge addresses)."
        : "EVM enabled but no Ethereum/Base factory+protocol addresses configured.",
    );
  }

  assertYieldSisterRequiresChain1Dao(env);

  // Server-custodied EVM agent/guardian keys require an EVM signing KEK.
  if (!c.evmMasterKek) {
    throw new Error("NAVE_EVM_MASTER_KEK (or NAVE_MASTER_KEK fallback) is required for EVM agent/guardian key custody.");
  }

  assertEvmAbisSynced(scope);
}

// Mainnet SAFETY GATE: when EVM is enabled, the synced-ABI metadata (stamped by
// scripts/sync-abi.mjs) must exist and cover every Nave EVM contract with no
// missing artifacts. This is the cutover-side enforcement of the `sync-abi`
// wiring (prebuild) so the frontend never binds stale placeholder ABIs.
function assertEvmAbisSynced(scope) {
  if (!existsSync(ABI_META_PATH)) {
    throw new Error(
      `EVM is enabled but ${ABI_META_PATH} is missing. Run \`npm run sync-abi\` after \`forge build\` in contracts/evm ` +
        "so the frontend binds the real synced ABIs (not the committed placeholders).",
    );
  }
  let meta;
  try {
    meta = JSON.parse(readFileSync(ABI_META_PATH, "utf8"));
  } catch (e) {
    throw new Error(`Failed to parse ${ABI_META_PATH}: ${e.message}. Re-run \`npm run sync-abi\`.`);
  }
  const missing = Array.isArray(meta.missing) ? meta.missing : [];
  if (missing.length) {
    throw new Error(
      `EVM synced-ABI metadata reports missing artifacts: ${missing.join(", ")}. ` +
        "Build contracts/evm (`forge build`) then re-run `npm run sync-abi`.",
    );
  }
  const synced = Array.isArray(meta.contracts) ? meta.contracts : [];
  const required = isBridgeStakeScope(scope) ? EVM_BRIDGE_STACK_CONTRACTS : EVM_SYNCED_CONTRACTS;
  const notCovered = required.filter((name) => !synced.includes(name));
  if (notCovered.length) {
    throw new Error(
      `EVM synced-ABI metadata does not cover: ${notCovered.join(", ")}. Re-run \`npm run sync-abi\` against the built contracts/evm.`,
    );
  }
}

function printEvmSummary(env) {
  if (!evmEnabled(env)) {
    console.log("\nEVM path: DISABLED (Solana-only cutover).");
    return;
  }
  const c = resolveEvmConfig(env);
  console.log("\nEVM path (Ethereum + Base only):");
  console.log(`  network:                     ${c.network} (mainnet-required)`);
  console.log(`  Ethereum protocol/factory:   ${c.ethereum.protocol || "<unset>"} / ${c.ethereum.factory || "<unset>"}`);
  console.log(`  Base protocol/factory:       ${c.base.protocol || "<unset>"} / ${c.base.factory || "<unset>"}`);
  console.log(`  verify keys (etherscan/base):${c.etherscanApiKey ? "set" : "unset"} / ${c.basescanApiKey ? "set" : "unset"}`);
  console.log(`  indexer RPC (eth/base/rh):   ${c.indexerRpc.ethereum ? "set" : "unset"} / ${c.indexerRpc.base ? "set" : "unset"} / ${c.indexerRpc.robinhood ? "set" : "unset"}`);
  console.log(`  EVM signing KEK:             ${c.evmMasterKek ? "set" : "unset"}`);
  console.log(`  protocol revenue wallet:     ${c.protocolRevenueWallet || "<unset>"}`);
  console.log(`  token mint/revoke fee wei:   ${c.tokenMintFeeWei || "<unset>"} / ${c.tokenRevokeRewardWei}`);
  console.log(
    `  formation fee / treasury seed wei: ${c.formationFeeWei || "<unset>"} / ${c.treasurySeedWei || "<unset>"} ` +
      `(mainnet seed ≈ ${MAINNET_EVM_TREASURY_SEED_WEI}, MAINNET_TREASURY_SEED_BPS=1667 — NOT FINALIZED, confirm before launch)`,
  );
  for (const [label, cfg] of [["Ethereum", c.ethereum], ["Base", c.base]]) {
    if (!cfg.factory && !cfg.protocol) continue;
    const configured = EVM_ADAPTERS.filter((a) => isNonZeroEvmAddress(cfg.adapters[a.key])).map((a) => a.key);
    console.log(`  ${label} adapters:            ${configured.length ? configured.join(", ") : "<unset>"}`);
  }
  console.log(`  release gates:               ${EVM_RELEASE_GATES.every(([key]) => (env[key] || "").trim().toLowerCase() === "passed") ? "passed" : "incomplete"}`);
}

function programIdMap(env) {
  return {
    NAVE_CORE_PROGRAM_ID: env.NAVE_CORE_PROGRAM_ID || env.VITE_NAVE_CORE_PROGRAM_ID,
    NAVE_GOVERNANCE_PROGRAM_ID: env.NAVE_GOVERNANCE_PROGRAM_ID || env.VITE_NAVE_GOVERNANCE_PROGRAM_ID,
    NAVE_EXECUTION_PROGRAM_ID: env.NAVE_EXECUTION_PROGRAM_ID || env.VITE_NAVE_EXECUTION_PROGRAM_ID,
    NAVE_JITO_ADAPTER_ID: env.NAVE_JITO_ADAPTER_ID || env.VITE_NAVE_JITO_ADAPTER_ID,
    NAVE_KAMINO_ADAPTER_ID: env.NAVE_KAMINO_ADAPTER_ID || env.VITE_NAVE_KAMINO_ADAPTER_ID,
    NAVE_MARGINFI_ADAPTER_ID: env.NAVE_MARGINFI_ADAPTER_ID || env.VITE_NAVE_MARGINFI_ADAPTER_ID,
  };
}

function loadContractsProgramEnv(contractsDir) {
  const path = join(contractsDir, CONTRACTS_PROGRAM_ENV);
  if (!existsSync(path)) return {};
  return parseEnvFile(path);
}

function runContractsPhase(args, env, phase) {
  const contractsDir = env.CONTRACTS_DIR || CONTRACTS_DEFAULT_DIR;
  const script = join(contractsDir, "scripts", "mainnet-cutover.mjs");
  const phaseArgs = [
    script,
    "--env",
    resolve(args.envPath),
    "--key-dir",
    resolve(args.keyDir),
    "--phase",
    phase,
    "--scope",
    args.scope,
    "--confirm-mainnet",
  ];
  if (args.reuseProgramIds) phaseArgs.push("--reuse-program-ids");
  run("node", phaseArgs, { cwd: contractsDir, env });
}

function upsertSupabaseSecrets(env) {
  const secrets = {
    SUPABASE_URL: env.VITE_SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY,
    SOLANA_RPC_URL: env.MAINNET_RPC_URL,
    NAVE_AGENT_SECRET: env.NAVE_AGENT_SECRET,
    NAVE_SIGNER_SECRET: env.NAVE_SIGNER_SECRET,
    NAVE_INDEXER_SECRET: env.NAVE_INDEXER_SECRET,
    NAVE_MASTER_KEK: env.NAVE_MASTER_KEK,
    NAVE_ALLOWED_ORIGINS: env.NAVE_ALLOWED_ORIGINS,
    NAVE_SIGNER_URL: env.NAVE_SIGNER_URL,
    NAVE_POLICY_SECRET: env.NAVE_POLICY_SECRET,
    NAVE_PROPOSER_SECRET: env.NAVE_PROPOSER_SECRET,
    ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
    VITE_NAVE_PROTOCOL_FEE_WALLET: env.VITE_NAVE_PROTOCOL_FEE_WALLET,
    NAVE_PROTOCOL_FEE_WALLET: env.VITE_NAVE_PROTOCOL_FEE_WALLET,
    // Fee-redesign config: the protocol revenue wallet receives the 15% yield skim.
    // Management fee is 0. Default unset bps to the yield-only model.
    NAVE_PROTOCOL_REVENUE_WALLET: env.NAVE_PROTOCOL_REVENUE_WALLET || env.VITE_NAVE_PROTOCOL_FEE_WALLET,
    NAVE_PERFORMANCE_FEE_BPS: env.NAVE_PERFORMANCE_FEE_BPS ?? String(DEFAULT_PERFORMANCE_FEE_BPS),
    NAVE_MANAGEMENT_FEE_BPS: env.NAVE_MANAGEMENT_FEE_BPS ?? String(DEFAULT_MANAGEMENT_FEE_BPS),
    // Cluster + Jupiter program IDs drive the edge functions' on-chain Jupiter
    // program-id assertion; the cluster flips the signer/edge to the prod path.
    NAVE_CLUSTER: env.NAVE_CLUSTER,
    JUPITER_LENDING_PROGRAM_ID: env.JUPITER_LENDING_PROGRAM_ID,
    JUPITER_LIQUIDITY_PROGRAM_ID: env.JUPITER_LIQUIDITY_PROGRAM_ID,
    // NAV-freshness deploy guard (edge): freshness window + treasury_vault
    // last_revalued_at byte offset used to read on-chain NAV age.
    NAVE_MAX_NAV_AGE_SECONDS: env.NAVE_MAX_NAV_AGE_SECONDS,
    NAVE_VAULT_LAST_REVALUED_OFF: env.NAVE_VAULT_LAST_REVALUED_OFF,
    VITE_EVM_PROTOCOL_REVENUE_WALLET: env.VITE_EVM_PROTOCOL_REVENUE_WALLET,
    // Mainnet EVM paths in the edge functions REQUIRE their RPC env (public
    // fallbacks were removed) and the protocol address for treasury-membership
    // checks in generate-evm-agent-keys bind.
    EVM_ETHEREUM_RPC_URL: env.EVM_ETHEREUM_RPC_URL,
    EVM_BASE_RPC_URL: env.EVM_BASE_RPC_URL,
    EVM_ROBINHOOD_RPC_URL: env.EVM_ROBINHOOD_RPC_URL,
    EVM_ETHEREUM_PROTOCOL_ADDRESS: env.VITE_EVM_ETHEREUM_PROTOCOL_ADDRESS,
    EVM_BASE_PROTOCOL_ADDRESS: env.VITE_EVM_BASE_PROTOCOL_ADDRESS,
    EVM_ROBINHOOD_PROTOCOL_ADDRESS: env.VITE_EVM_ROBINHOOD_PROTOCOL_ADDRESS,
    NAVE_EVM_MASTER_KEK: env.NAVE_EVM_MASTER_KEK,
    // Agent LLM guardrails (agent-dispatcher / agent-orchestrator).
    LLM_TIMEOUT_MS: env.LLM_TIMEOUT_MS,
    LLM_DAILY_TOKEN_BUDGET: env.LLM_DAILY_TOKEN_BUDGET,
    NAVE_EXECUTION_GRACE_SECS: env.NAVE_EXECUTION_GRACE_SECS,
    // Operator-only raw-DEK export (generate-agent-keys break_glass); mode is
    // disabled when unset.
    NAVE_BREAK_GLASS_SECRET: env.NAVE_BREAK_GLASS_SECRET,
    // Anonymous price-oracle persistence throttle.
    NAVE_ORACLE_PERSIST_TTL_SECONDS: env.NAVE_ORACLE_PERSIST_TTL_SECONDS,
  };

  const ids = programIdMap(env);
  Object.assign(secrets, ids, {
    VITE_ESCROW_PDA_ENABLED: env.VITE_ESCROW_PDA_ENABLED,
    NAVE_ESCROW_PDA_ENABLED: env.NAVE_ESCROW_PDA_ENABLED,
  });

  const pairs = Object.entries(secrets)
    .filter(([, val]) => typeof val === "string" && val.length > 0)
    .map(([k, v]) => `${k}=${v}`);

  if (pairs.length === 0) throw new Error("No secrets resolved for supabase secrets set.");
  run("supabase", ["secrets", "set", ...pairs], { env });
}

function deployPlatform(env) {
  run("supabase", ["link", "--project-ref", env.SUPABASE_PROJECT_REF], { env });
  run("supabase", ["db", "push"], { env });
  upsertSupabaseSecrets(env);
  run("npm", ["run", "functions:deploy"], { env, cwd: ROOT });

  const webhookEnv = {
    ...env,
    HELIUS_NETWORK: "mainnet",
    WEBHOOK_URL: env.WEBHOOK_URL || `${env.VITE_SUPABASE_URL}/functions/v1/helius-webhook`,
    HELIUS_API_KEY: env.HELIUS_API_KEY,
    NAVE_INDEXER_SECRET: env.NAVE_INDEXER_SECRET,
    NAVE_CORE_PROGRAM_ID: env.NAVE_CORE_PROGRAM_ID || env.VITE_NAVE_CORE_PROGRAM_ID,
    NAVE_GOVERNANCE_PROGRAM_ID: env.NAVE_GOVERNANCE_PROGRAM_ID || env.VITE_NAVE_GOVERNANCE_PROGRAM_ID,
    NAVE_EXECUTION_PROGRAM_ID: env.NAVE_EXECUTION_PROGRAM_ID || env.VITE_NAVE_EXECUTION_PROGRAM_ID,
    NAVE_JITO_ADAPTER_PROGRAM_ID: env.NAVE_JITO_ADAPTER_ID || env.VITE_NAVE_JITO_ADAPTER_ID,
    NAVE_KAMINO_ADAPTER_PROGRAM_ID: env.NAVE_KAMINO_ADAPTER_ID || env.VITE_NAVE_KAMINO_ADAPTER_ID,
    NAVE_MARGINFI_ADAPTER_PROGRAM_ID: env.NAVE_MARGINFI_ADAPTER_ID || env.VITE_NAVE_MARGINFI_ADAPTER_ID,
  };
  run("npm", ["run", "register-webhook"], { env: webhookEnv, cwd: ROOT });
}

function verifyGate(env) {
  const verifyEnv = {
    ...env,
    SUPABASE_URL: env.VITE_SUPABASE_URL,
    SOLANA_RPC_URL: env.MAINNET_RPC_URL,
    NAVE_SIGNER_URL: env.NAVE_SIGNER_URL,
    SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY,
  };
  run("npm", ["run", "beta:go-no-go"], { env: verifyEnv, cwd: ROOT });

  if (env.DAO_ADDRESS) {
    run("npm", ["run", "verify:e2e-gate"], { env: verifyEnv, cwd: ROOT });
  } else {
    console.log("Skipping verify:e2e-gate (DAO_ADDRESS not set).");
  }
}

function loadContractsArtifact(env) {
  const contractsDir = env.CONTRACTS_DIR || CONTRACTS_DEFAULT_DIR;
  const path = join(contractsDir, CONTRACTS_ARTIFACT);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeAppArtifact(env, checks) {
  mkdirSync(dirname(APP_ARTIFACT_PATH), { recursive: true });
  const gitCommit = runCapture("git", ["rev-parse", "HEAD"], { cwd: ROOT, env });
  const artifact = {
    generatedAt: new Date().toISOString(),
    gitCommit,
    network: "mainnet-beta",
    rpcUrl: env.MAINNET_RPC_URL,
    supabase: {
      projectRef: env.SUPABASE_PROJECT_REF,
      url: env.VITE_SUPABASE_URL,
    },
    signer: {
      url: env.NAVE_SIGNER_URL,
    },
    agentAutonomy: resolveAgentAutonomy(env),
    feeModel: resolveFeeModel(env),
    creationFlow: resolveCreationFlow(env),
    // New treasuries lock no NAVE. An existing lock, if any, is released on moonlight.
    naveStake: NAVE_STAKE_FLOW,
    signerInfra: resolveSignerInfra(env),
    navFreshness: {
      maxNavAgeSeconds: Number((env.NAVE_MAX_NAV_AGE_SECONDS ?? "").trim() || 0),
      onchainMaxStalenessSecs: ONCHAIN_NAV_MAX_STALENESS_SECS,
      vaultLastRevaluedOffset: (env.NAVE_VAULT_LAST_REVALUED_OFF ?? "").trim(),
    },
    jupiter: {
      lendingProgramId: (env.JUPITER_LENDING_PROGRAM_ID ?? "").trim(),
      liquidityProgramId: (env.JUPITER_LIQUIDITY_PROGRAM_ID ?? "").trim(),
    },
    evm: evmEnabled(env)
      ? (() => {
          const c = resolveEvmConfig(env);
          return {
            enabled: true,
            network: c.network,
            protocolRevenueWallet: c.protocolRevenueWallet,
            tokenFees: {
              mintWei: c.tokenMintFeeWei,
              revokeRewardWei: c.tokenRevokeRewardWei,
            },
            // EVM creation charges no protocol fee. REQUIRED_NAVE_STAKE is 0.
            formationFee: {
              feeWei: c.formationFeeWei,
              treasurySeedWei: c.treasurySeedWei,
              feeFree: true,
            },
            naveStake: {
              token: (env.NAVE_STAKE_TOKEN || "").trim(),
              requiredStake: (env.REQUIRED_NAVE_STAKE || "0").trim() || "0",
              daoStakeModule: (env.DAO_STAKE_MODULE || "").trim(),
              stakeTargetUsd: DAO_STAKE_TARGET_USD,
            },
            releaseGates: Object.fromEntries(EVM_RELEASE_GATES.map(([key, label]) => [key, { label, passed: (env[key] || "").trim().toLowerCase() === "passed" }])),
            ethereum: { chainId: 1, protocol: c.ethereum.protocol, factory: c.ethereum.factory, adapters: c.ethereum.adapters },
            base: { chainId: 8453, protocol: c.base.protocol, factory: c.base.factory, adapters: c.base.adapters },
            // Bridge/stake-only chain — no protocol/factory/adapters, only the bridge triple.
            robinhood: { chainId: 4663, wrappedNave: c.robinhood.wrappedNave, bridgeLockbox: c.robinhood.bridgeLockbox, staking: c.robinhood.staking },
            verify: { etherscan: Boolean(c.etherscanApiKey), basescan: Boolean(c.basescanApiKey), robinhoodBlockscout: true },
            indexerRpc: { ethereum: Boolean(c.indexerRpc.ethereum), base: Boolean(c.indexerRpc.base), robinhood: Boolean(c.indexerRpc.robinhood) },
            evmMasterKekConfigured: Boolean(c.evmMasterKek),
            abiPath: c.abiPath,
          };
        })()
      : { enabled: false },
    checks,
  };
  writeFileSync(APP_ARTIFACT_PATH, JSON.stringify(artifact, null, 2));
}

function printHostEnvHints(env) {
  console.log("\nApply these env values to hosting providers:");
  const hints = {
    VITE_SOLANA_RPC_URL: env.MAINNET_RPC_URL,
    VITE_SUPABASE_URL: env.VITE_SUPABASE_URL,
    VITE_SUPABASE_ANON_KEY: env.VITE_SUPABASE_ANON_KEY,
    VITE_SUPABASE_PUBLISHABLE_KEY: env.VITE_SUPABASE_PUBLISHABLE_KEY,
    VITE_USE_MOCKS: env.VITE_USE_MOCKS,
    VITE_ESCROW_PDA_ENABLED: env.VITE_ESCROW_PDA_ENABLED,
    NAVE_ESCROW_PDA_ENABLED: env.NAVE_ESCROW_PDA_ENABLED,
    NAVE_SIGNER_URL: env.NAVE_SIGNER_URL,
  };
  const ids = programIdMap(env);
  Object.assign(hints, {
    VITE_NAVE_CORE_PROGRAM_ID: ids.NAVE_CORE_PROGRAM_ID,
    VITE_NAVE_GOVERNANCE_PROGRAM_ID: ids.NAVE_GOVERNANCE_PROGRAM_ID,
    VITE_NAVE_EXECUTION_PROGRAM_ID: ids.NAVE_EXECUTION_PROGRAM_ID,
    VITE_NAVE_JITO_ADAPTER_ID: ids.NAVE_JITO_ADAPTER_ID,
    VITE_NAVE_KAMINO_ADAPTER_ID: ids.NAVE_KAMINO_ADAPTER_ID,
    VITE_NAVE_MARGINFI_ADAPTER_ID: ids.NAVE_MARGINFI_ADAPTER_ID,
  });
  for (const [k, v] of Object.entries(hints)) {
    if (v) console.log(`${k}=${v}`);
  }

  // Signer/worker host (Railway): yield-fee wallet + agent-SOL hysteresis.
  // The management-fee collector is gone; do not set a collect interval.
  const f = resolveFeeModel(env);
  console.log("\nApply these to the signer/worker host (Railway):");
  const workerHints = {
    NAVE_PROTOCOL_REVENUE_WALLET: f.protocolRevenueWallet,
    NAVE_PERFORMANCE_FEE_BPS: String(DEFAULT_PERFORMANCE_FEE_BPS),
    NAVE_MANAGEMENT_FEE_BPS: String(DEFAULT_MANAGEMENT_FEE_BPS),
    NAVE_AGENT_SOL_REQUEST_THRESHOLD: env.NAVE_AGENT_SOL_REQUEST_THRESHOLD ?? String(DEFAULT_AGENT_SOL.request),
    NAVE_AGENT_SOL_OPERATE_LEVEL: env.NAVE_AGENT_SOL_OPERATE_LEVEL ?? String(DEFAULT_AGENT_SOL.operate),
    NAVE_AGENT_SOL_FILL_CEILING: env.NAVE_AGENT_SOL_FILL_CEILING ?? String(DEFAULT_AGENT_SOL.fillCeiling),
    NAVE_AGENT_SOL_REFILL_TRIGGER: env.NAVE_AGENT_SOL_REFILL_TRIGGER ?? String(DEFAULT_AGENT_SOL.refillTrigger),
  };
  for (const [k, v] of Object.entries(workerHints)) {
    if (v) console.log(`${k}=${v}`);
  }

  // Signer-service host (Railway): cluster + Upstash limiter + circuit-breaker
  // tunables + Jupiter program IDs + NAV-freshness guard. The signer FAILS CLOSED
  // without a reachable Upstash limiter, so these must be present on mainnet.
  console.log("\nApply these to the signer-service host (Railway):");
  const signerHints = {
    NAVE_CLUSTER: env.NAVE_CLUSTER,
    UPSTASH_REDIS_REST_URL: env.UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN: env.UPSTASH_REDIS_REST_TOKEN,
    NAVE_SIGNER_SKIP_SIMULATION: env.NAVE_SIGNER_SKIP_SIMULATION ?? "false",
    NAVE_SIGNER_RATE_PER_ACTION: env.NAVE_SIGNER_RATE_PER_ACTION ?? String(DEFAULT_SIGNER_RATE.perAction),
    NAVE_SIGNER_RATE_PER_ROLE: env.NAVE_SIGNER_RATE_PER_ROLE ?? String(DEFAULT_SIGNER_RATE.perRole),
    NAVE_SIGNER_RATE_GLOBAL: env.NAVE_SIGNER_RATE_GLOBAL ?? String(DEFAULT_SIGNER_RATE.global),
    NAVE_SIGNER_CB_THRESHOLD: env.NAVE_SIGNER_CB_THRESHOLD ?? String(DEFAULT_SIGNER_RATE.cbThreshold),
    NAVE_SIGNER_CB_WINDOW_MS: env.NAVE_SIGNER_CB_WINDOW_MS ?? String(DEFAULT_SIGNER_RATE.cbWindowMs),
    NAVE_SIGNER_CB_COOLDOWN_MS: env.NAVE_SIGNER_CB_COOLDOWN_MS ?? String(DEFAULT_SIGNER_RATE.cbCooldownMs),
    JUPITER_LENDING_PROGRAM_ID: env.JUPITER_LENDING_PROGRAM_ID,
    JUPITER_LIQUIDITY_PROGRAM_ID: env.JUPITER_LIQUIDITY_PROGRAM_ID,
    NAVE_MAX_NAV_AGE_SECONDS: env.NAVE_MAX_NAV_AGE_SECONDS,
    NAVE_VAULT_LAST_REVALUED_OFF: env.NAVE_VAULT_LAST_REVALUED_OFF,
    // Boot-time fail-closed posture: production refuses the localhost RPC
    // default and the EVM→Solana KEK fallback.
    NODE_ENV: "production",
    SOLANA_RPC_URL: env.MAINNET_RPC_URL,
    TRUSTED_PROXY_HOPS: env.TRUSTED_PROXY_HOPS ?? "1",
    // Bridge relayer chain resolution + finality (chain-aware).
    NAVE_EVM_NETWORK: env.NAVE_EVM_NETWORK,
    BRIDGE_EVM_CHAIN_IDS: env.BRIDGE_EVM_CHAIN_IDS,
    BRIDGE_LOOKBACK_SECONDS: env.BRIDGE_LOOKBACK_SECONDS ?? "7200",
    BRIDGE_EVM_CONFIRMATIONS: env.BRIDGE_EVM_CONFIRMATIONS,
  };
  for (const chainId of configuredMainnetBridgeChainIds(env)) {
    signerHints[`BRIDGE_EVM_CONFIRMATIONS_${chainId}`] =
      env[`BRIDGE_EVM_CONFIRMATIONS_${chainId}`] ?? String(BRIDGE_EVM_CONFIRMATION_DEFAULTS[chainId]);
  }
  for (const [k, v] of Object.entries(signerHints)) {
    if (v) console.log(`${k}=${v}`);
  }

  // EVM (Ethereum + Base) host env — only when the EVM path is enabled.
  if (evmEnabled(env)) {
    const c = resolveEvmConfig(env);
    console.log("\nApply these EVM vars to the WEB host (Vite build):");
    const webEvm = {
      VITE_EVM_NETWORK: c.network,
      VITE_EVM_ETHEREUM_PROTOCOL_ADDRESS: c.ethereum.protocol,
      VITE_EVM_ETHEREUM_FACTORY_ADDRESS: c.ethereum.factory,
      VITE_EVM_BASE_PROTOCOL_ADDRESS: c.base.protocol,
      VITE_EVM_BASE_FACTORY_ADDRESS: c.base.factory,
      VITE_EVM_ETHEREUM_AAVE_ADAPTER_ADDRESS: c.ethereum.adapters.aaveV3,
      VITE_EVM_ETHEREUM_COMPOUND_ADAPTER_ADDRESS: c.ethereum.adapters.compoundV3,
      VITE_EVM_ETHEREUM_BALANCER_ADAPTER_ADDRESS: c.ethereum.adapters.balancer,
      VITE_EVM_BASE_AAVE_ADAPTER_ADDRESS: c.base.adapters.aaveV3,
      VITE_EVM_BASE_COMPOUND_ADAPTER_ADDRESS: c.base.adapters.compoundV3,
      VITE_EVM_BASE_BALANCER_ADAPTER_ADDRESS: c.base.adapters.balancer,
      VITE_EVM_PROTOCOL_REVENUE_WALLET: c.protocolRevenueWallet,
      VITE_EVM_ETHEREUM_RPC_URL: env.VITE_EVM_ETHEREUM_RPC_URL,
      VITE_EVM_BASE_RPC_URL: env.VITE_EVM_BASE_RPC_URL,
      // Robinhood (bridge/stake-only) — bridge triple + PUBLIC browser RPC.
      VITE_EVM_ROBINHOOD_WRAPPED_NAVE_ADDRESS: c.robinhood.wrappedNave,
      VITE_EVM_ROBINHOOD_BRIDGE_LOCKBOX_ADDRESS: c.robinhood.bridgeLockbox,
      VITE_EVM_ROBINHOOD_STAKING_ADDRESS: c.robinhood.staking,
      VITE_EVM_ROBINHOOD_RPC_URL: c.robinhood.rpc,
      VITE_WALLETCONNECT_PROJECT_ID: env.VITE_WALLETCONNECT_PROJECT_ID,
    };
    for (const [k, v] of Object.entries(webEvm)) {
      if (v) console.log(`${k}=${v}`);
    }

    console.log("\nApply these EVM vars to the signer-service host (Railway, relayer + EIP-712):");
    const signerEvm = {
      EVM_ETHEREUM_RPC_URL: c.indexerRpc.ethereum,
      EVM_BASE_RPC_URL: c.indexerRpc.base,
      EVM_ROBINHOOD_RPC_URL: c.indexerRpc.robinhood,
      NAVE_EVM_MASTER_KEK: env.NAVE_EVM_MASTER_KEK,
      VITE_EVM_PROTOCOL_REVENUE_WALLET: c.protocolRevenueWallet,
      TOKEN_MINT_FEE_WEI: c.tokenMintFeeWei,
      TOKEN_REVOKE_REWARD_WEI: c.tokenRevokeRewardWei,
    };
    for (const [k, v] of Object.entries(signerEvm)) {
      if (v) console.log(`${k}=${v}`);
    }

    console.log("\nApply these EVM vars to the evm-indexer host (Railway):");
    const indexerEvm = {
      EVM_ETHEREUM_RPC_URL: c.indexerRpc.ethereum,
      EVM_BASE_RPC_URL: c.indexerRpc.base,
      EVM_ROBINHOOD_RPC_URL: c.indexerRpc.robinhood,
      NAVE_INDEXER_SECRET: env.NAVE_INDEXER_SECRET,
      NAVE_EVM_ABI_PATH: c.abiPath,
      SUPABASE_URL: env.VITE_SUPABASE_URL,
    };
    for (const [k, v] of Object.entries(indexerEvm)) {
      if (v) console.log(`${k}=${v}`);
    }
  }
}

async function main() {
  const args = parseArgs();
  let env = parseEnvFile(resolve(args.envPath));
  const runAll = args.phase === "all";
  const checks = {
    preflight: false,
    contractsKeys: false,
    contractsBuild: false,
    contractsDeploy: false,
    authorityHandoff: false,
    platformDeploy: false,
    verification: false,
  };

  if (runAll || args.phase === "preflight") {
    const bridgeStakeOnly = isBridgeStakeScope(args.scope);
    console.log(`\nCutover scope: ${args.scope}${bridgeStakeOnly ? " (bridge + staking only; DAO/treasury deferred)" : " (full stack)"}`);
    assertRequiredEnv(env, args.scope);
    assertSafetyEnv(env, args.scope);
    assertSignerInfraSafety(env);
    assertBridgeFaucetMainnetSafety(env);
    await assertSolanaBridgeProgramLive(env);
    assertYieldSisterRequiresChain1Dao(env);
    assertEvmConfig(env, args.scope);
    await assertEvmRpcMainnet(env);
    assertNoDevnetValues(env);
    await assertMainnetRpc(env.MAINNET_RPC_URL);
    if (!bridgeStakeOnly) {
      assertAgentFlagSafety(env);
      assertFeeModelSafety(env);
      assertFeeSplitConfig(env);
      assertJupiterProgramIds(env);
      assertNavFreshnessConfig(env);
      await assertRevenueWalletFunded(env);
    }
    toolPreflight();
    if (!bridgeStakeOnly) {
      printAgentAutonomySummary(env);
      printFeeModelSummary(env);
      printCreationFlowSummary(env);
    }
    printSignerInfraSummary(env);
    printEvmSummary(env);
    checks.preflight = true;
  }

  if (runAll || args.phase === "keys") {
    runContractsPhase(args, env, "keys");
    checks.contractsKeys = true;
    env = mergeMissing(env, loadContractsProgramEnv(env.CONTRACTS_DIR || CONTRACTS_DEFAULT_DIR));
  }

  if (runAll || args.phase === "build") {
    runContractsPhase(args, env, "build");
    checks.contractsBuild = true;
  }

  if (runAll || args.phase === "deploy-contracts") {
    runContractsPhase(args, env, "deploy-contracts");
    checks.contractsDeploy = true;
    env = mergeMissing(env, loadContractsProgramEnv(env.CONTRACTS_DIR || CONTRACTS_DEFAULT_DIR));
  }

  if (runAll || args.phase === "handoff-authority") {
    runContractsPhase(args, env, "handoff-authority");
    checks.authorityHandoff = true;
  }

  if (runAll || args.phase === "deploy-platform") {
    deployPlatform(env);
    checks.platformDeploy = true;
    printHostEnvHints(env);
  }

  if (runAll || args.phase === "verify") {
    const bridgeStakeOnly = isBridgeStakeScope(args.scope);
    assertNoDevnetValues(env);
    assertSignerInfraSafety(env);
    assertBridgeFaucetMainnetSafety(env);
    await assertSolanaBridgeProgramLive(env);
    assertYieldSisterRequiresChain1Dao(env);
    assertEvmConfig(env, args.scope);
    await assertEvmRpcMainnet(env);
    if (!bridgeStakeOnly) {
      assertAgentFlagSafety(env);
      assertFeeSplitConfig(env);
      assertJupiterProgramIds(env);
      assertNavFreshnessConfig(env);
    }
    runContractsPhase(args, env, "verify");
    verifyGate(env);
    checks.verification = true;
  }

  writeAppArtifact(env, checks);
  const contractsArtifact = loadContractsArtifact(env);
  console.log("\nMainnet cutover phase complete.");
  console.log(`App launch artifact: ${APP_ARTIFACT_PATH}`);
  if (contractsArtifact) {
    console.log(`Contracts launch artifact found for commit ${contractsArtifact.gitCommit}`);
  }
}

main().catch((error) => {
  console.error(`\nMainnet cutover failed: ${error.message}`);
  process.exit(1);
});
