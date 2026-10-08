#!/usr/bin/env node
// ─── Nave mainnet cutover WIZARD (interactive, resumable, dry-run) ────────────
//
// This is a thin ORCHESTRATOR on top of the existing hardened batch scripts. It
// does NOT reimplement any cutover logic — every on-chain / infra action is
// delegated to:
//   • nave-app/scripts/mainnet-cutover.mjs            (top orchestrator; phases
//       preflight → keys → build → deploy-contracts → handoff-authority →
//       deploy-platform → verify; requires --confirm-mainnet; resumable)
//   • contracts/solana/scripts/mainnet-cutover.mjs     (Solana; default scope
//       bridge-stake deploys nave_bridge + nave_staking only; --scope full adds
//       the six DAO programs; assertBridgeAndStakingOwnership P1 gate;
//       writes deployments/mainnet.json + mainnet-program-ids.env + launch artifact)
//   • contracts/solana/scripts/evm-mainnet-cutover.mjs (EVM per --chain-id; deploy →
//       adapters → stake → handoff → verify; handoffBridgeAuthority P1 gate)
//
// Design guarantees (see docs/MAINNET_PREFLIGHT.md + nave-contracts/CUTOVER.md):
//   1. Sequential + interactive: prompts for each input one step at a time.
//   2. Before any irreversible / fund / authority action it prints EXACTLY what
//      will happen (chain, contract/program, function/instruction, args,
//      addresses, and the literal shell command) and requires a typed
//      confirmation string.
//   3. NEVER custodies or asks for private keys. Signing stays with the chain
//      CLIs / keystore / hardware flows the delegated scripts already use. The
//      wizard only passes through NON-SECRET args (env-file path, key-dir path,
//      chain id). It reads the env file only to display a safe allowlist and to
//      detect whether EVM is enabled — secrets are never printed or logged.
//   4. Idempotent + resumable via deployments/cutover-wizard-state.json. On
//      restart it skips steps already completed AND steps whose on-chain artifact
//      already exists (manifest-based skip, reusing the delegated scripts' own
//      manifest skip logic). A completed on-chain action is never repeated.
//   5. Dry-run / testnet-rehearsal: --dry-run (default) prints the full ordered
//      sequence + the exact commands + confirmations WITHOUT invoking anything;
//      --rehearse-testnet targets Sepolia/Base Sepolia via the EVM script's
//      testnet chain ids. The app/contracts Solana cutover scripts are
//      MAINNET-ONLY (no devnet path), so on a rehearsal those steps auto-skip
//      loudly and the devnet deployment is verified out-of-band. Rehearsal also
//      supports typing SKIP at a confirmation (skip one step, keep going) and
//      CONTINUE after a failed step (record + proceed) — both REFUSED on --live.
//      --live targets mainnet. Nothing is executed unless --execute is passed
//      (and --live additionally requires --confirm-mainnet). Checkpoint state is
//      scoped to the mode that created it (a rehearsal checkpoint can never mark
//      live-mainnet steps done).
//   6. After each step it verifies on-chain by reading back the result (delegated
//      verify phases + the P1 owner≠relayer/rewarder asserts) and aborts loudly
//      on mismatch (a non-zero verify exit throws).
//
// SAFETY: run `--dry-run` (default) freely — it performs NO irreversible action
// and NO subprocess. `--rehearse-testnet`/`--live` only act when `--execute` is
// also present; `--live` additionally requires `--confirm-mainnet`.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deploymentWireRefusal } from "./lib/deploymentArtifactStatus.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(__dirname, "..");

// Repo layout (overridable via env for non-default checkouts).
const CONTRACTS_DIR =
  process.env.CONTRACTS_DIR || resolve(APP_ROOT, "..", "contracts", "solana");
const EVM_CONTRACTS_DIR = process.env.EVM_CONTRACTS_DIR || resolve(CONTRACTS_DIR, "..", "evm");
const APP_CUTOVER = join(APP_ROOT, "scripts", "mainnet-cutover.mjs");
const CONTRACTS_CUTOVER = join(CONTRACTS_DIR, "scripts", "mainnet-cutover.mjs");
const EVM_CUTOVER = join(CONTRACTS_DIR, "scripts", "evm-mainnet-cutover.mjs");

// Manifests the delegated scripts write — used for idempotent skip detection.
const SOLANA_MANIFEST = join(CONTRACTS_DIR, "deployments", "mainnet.json");
const SOLANA_LAUNCH_ARTIFACT = join(CONTRACTS_DIR, "deployments", "mainnet-launch-artifact.json");
const EVM_DEPLOYMENTS_DIR = join(EVM_CONTRACTS_DIR, "deployments");

const STATE_DIR = join(APP_ROOT, "deployments");
const DEFAULT_STATE_PATH = join(STATE_DIR, "cutover-wizard-state.json");

// EVM scope is fenced (mirrors the delegated scripts): Ethereum + Base + Robinhood.
// Robinhood Chain (Arbitrum Nitro L2) is BRIDGE/STAKE-ONLY (`bridgeOnly`): its
// deploy phase ships ONLY the hardened bridge stack (WrappedNave + NaveBridge
// lockbox + NaveStaking) and the DAO-stack steps (adapters, $99 stake) do not
// exist for it — the delegated EVM script hard-rejects those phases on 4663/46630.
const EVM_MAINNET_CHAINS = [
  { chainId: 1, label: "Ethereum", segment: "ETHEREUM" },
  { chainId: 8453, label: "Base", segment: "BASE" },
  { chainId: 4663, label: "Robinhood Chain", segment: "ROBINHOOD", bridgeOnly: true },
];
const EVM_TESTNET_CHAINS = [
  { chainId: 11155111, label: "Ethereum Sepolia", segment: "SEPOLIA" },
  { chainId: 84532, label: "Base Sepolia", segment: "BASE_SEPOLIA" },
  { chainId: 46630, label: "Robinhood Testnet", segment: "ROBINHOOD_TESTNET", bridgeOnly: true },
];

// Cutover scope: bridge-stake (default) deploys ONLY bridge/staking; full adds DAO stack.
const DEFAULT_CUTOVER_SCOPE = "bridge-stake";
// nave_bridge.initialize_config, NOT by a wizard phase — surfaced for the plan.
const BRIDGE_FEE = { totalBps: 250, stakingBps: 100, protocolBps: 100, burnBps: 50 };
const MAINNET_NAVE_MINT = "EGg56E1YtL5YapzkF7vkRThHR8i5FeRvm2LLuySdYory";

// Env keys that are SAFE to echo in the plan (never secrets). Everything else is
// redacted. This allowlist is intentionally conservative.
const SAFE_ENV_KEYS = new Set([
  "SQUADS_VAULT",
  "SAFE_ADDRESS",
  "PROTOCOL_OWNER",
  "PROTOCOL_TREASURY",
  "PYTH_ADDRESS",
  "VITE_NAVE_PROTOCOL_FEE_WALLET",
  "VITE_EVM_PROTOCOL_REVENUE_WALLET",
  "VITE_EVM_NETWORK",
  "VITE_EVM_CHAIN_ID",
  "VITE_EVM_ETHEREUM_PROTOCOL_ADDRESS",
  "VITE_EVM_ETHEREUM_FACTORY_ADDRESS",
  "VITE_EVM_BASE_PROTOCOL_ADDRESS",
  "VITE_EVM_BASE_FACTORY_ADDRESS",
  "VITE_EVM_ROBINHOOD_WRAPPED_NAVE_ADDRESS",
  "VITE_EVM_ROBINHOOD_BRIDGE_LOCKBOX_ADDRESS",
  "VITE_EVM_ROBINHOOD_STAKING_ADDRESS",
  "NAVE_CLUSTER",
  "SUPABASE_PROJECT_REF",
  "VITE_SUPABASE_URL",
  "NAVE_SIGNER_URL",
  "BRIDGE_RELAYER_ENABLED",
  "STAKING_MIRROR_ENABLED",
  "BRIDGE_WATCHER_ENABLED",
  "NAVE_BRIDGE_MAINNET_REVIEWED",
  "BRIDGE_SOLANA_BRIDGE_PROGRAM",
  "BRIDGE_SOLANA_STAKING_PROGRAM",
  "BRIDGE_SOLANA_STAKING_COLLECTOR",
  "BRIDGE_SOLANA_STAKING_POOL_ACCOUNT",
  "BRIDGE_SOLANA_RELAYER_PUBKEY",
  "BRIDGE_EVM_RELAYER_ADDRESS",
  "NAVE_STAKE_TOKEN",
  "REQUIRED_NAVE_STAKE",
  "DAO_STAKE_MODULE",
  "FAUCET_ENABLED",
]);

function parseArgs() {
  const argv = process.argv.slice(2);
  const out = {
    mode: "dry-run", // dry-run | rehearse-testnet | live
    execute: false,
    confirmMainnet: false,
    envPath: "",
    keyDir: "",
    statePath: DEFAULT_STATE_PATH,
    reuseProgramIds: false,
    resetState: false,
    evm: "auto", // auto | on | off
    scope: (process.env.CUTOVER_SCOPE || DEFAULT_CUTOVER_SCOPE).trim(),
    yes: false, // pre-accept confirmations (rehearsal automation only; never on --live)
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--dry-run") out.mode = "dry-run";
    else if (a === "--rehearse-testnet") out.mode = "rehearse-testnet";
    else if (a === "--live") out.mode = "live";
    else if (a === "--execute") out.execute = true;
    else if (a === "--confirm-mainnet") out.confirmMainnet = true;
    else if (a === "--env") out.envPath = argv[++i];
    else if (a === "--key-dir") out.keyDir = argv[++i];
    else if (a === "--state") out.statePath = resolve(argv[++i]);
    else if (a === "--reuse-program-ids") out.reuseProgramIds = true;
    else if (a === "--reset-state") out.resetState = true;
    else if (a === "--evm") out.evm = "on";
    else if (a === "--no-evm") out.evm = "off";
    else if (a === "--scope") out.scope = argv[++i];
    else if (a === "--yes") out.yes = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return out;
}

function printHelp() {
  console.log(`
Nave mainnet cutover wizard — orchestrates the existing hardened cutover scripts.

Usage:
  node scripts/mainnet-cutover-wizard.mjs [--dry-run|--rehearse-testnet|--live] [options]

Modes:
  --dry-run            (default) print the full ordered plan + commands +
                       confirmations. Performs NO irreversible action, spawns NO
                       subprocess. Safe to run anywhere.
  --rehearse-testnet   target Sepolia (11155111) + Base Sepolia (84532) +
                       Robinhood Testnet (46630) via the EVM script's testnet
                       chain ids. Solana cutover phases are mainnet-only and
                       auto-skip loudly (verify devnet out-of-band).
                       Rehearsal-only prompt escapes: SKIP (skip one confirmable
                       step) and CONTINUE (record a failed step and proceed).
  --live               target mainnet (Ethereum 1 + Base 8453 + Robinhood 4663 +
                       Solana mainnet-beta). Requires --confirm-mainnet.

Execution gate:
  --execute            actually run the delegated scripts (only meaningful with
                       --rehearse-testnet / --live). Without it, every mode is
                       plan-only. --live additionally requires --confirm-mainnet.

Options:
  --env <path>         cutover env file (passed by PATH to the delegated scripts;
                       the wizard reads only a non-secret allowlist for the plan).
                       Per-chain EVM overrides: prefix a key with the chain segment
                       ("ETHEREUM__", "BASE__", "ROBINHOOD__", "SEPOLIA__",
                       "BASE_SEPOLIA__", "ROBINHOOD_TESTNET__"), e.g.
                       SEPOLIA__EVM_RPC_URL / BASE__NAVE_STAKE_TOKEN. The wizard
                       writes a derived 0600 per-chain env next to the state file.
  --key-dir <path>     secure Solana key directory (0700) passed to the contracts
                       cutover. Never contains keys asked-for by the wizard.
  --state <path>       checkpoint/state file (default deployments/cutover-wizard-state.json).
  --reset-state        start a fresh checkpoint (ignore prior progress).
  --reuse-program-ids  pass --reuse-program-ids to the contracts cutover (in-place
                       program upgrades — required for already-deployed program IDs).
  --evm / --no-evm     force-enable / force-disable the EVM leg (default: auto-detect
                       from the env file).
  --scope bridge-stake|full
                       Cutover scope (default: bridge-stake). bridge-stake deploys
                       ONLY nave_bridge + nave_staking (Solana) and the hardened
                       bridge stack (EVM). full adds the DAO/treasury programs.
  --yes                pre-accept typed confirmations (rehearsal automation only;
                       REFUSED on --live).

The wizard NEVER asks for or stores private keys. Signing is delegated to the
solana CLI / Foundry / keystore / hardware flows the existing scripts already use.
`);
}

// ── Env loading (optional; used only for the plan + EVM detection) ────────────
function parseEnvFile(path) {
  const env = {};
  if (!path || !existsSync(path)) return env;
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

function safeEnvValue(key, env) {
  const val = (env[key] ?? "").trim();
  if (!val) return "<unset>";
  if (SAFE_ENV_KEYS.has(key)) return val;
  return "<redacted>";
}

// EVM enabled iff VITE_EVM_NETWORK set or any VITE_EVM_*_FACTORY_ADDRESS present
// (mirrors evmEnabled() in the app cutover so detection is consistent).
function detectEvmEnabled(env) {
  if ((env.VITE_EVM_NETWORK || "").trim()) return true;
  if (
    ["ETHEREUM", "BASE", "SEPOLIA", "BASE_SEPOLIA"].some(
      (seg) => (env[`VITE_EVM_${seg}_FACTORY_ADDRESS`] || "").trim(),
    )
  ) {
    return true;
  }
  // Bridge/stake triple addresses (no DAO factory required).
  return ["ETHEREUM", "BASE", "ROBINHOOD", "SEPOLIA", "BASE_SEPOLIA", "ROBINHOOD_TESTNET"].some(
    (seg) =>
      (env[`VITE_EVM_${seg}_WRAPPED_NAVE_ADDRESS`] || "").trim() ||
      (env[`VITE_EVM_${seg}_BRIDGE_LOCKBOX_ADDRESS`] || "").trim() ||
      (env[`VITE_EVM_${seg}_STAKING_ADDRESS`] || "").trim(),
  );
}

function chainIsBridgeOnly(chain, ctx) {
  return chain.bridgeOnly || ctx.scope === "bridge-stake";
}

// ── Checkpoint state ──────────────────────────────────────────────────────────
function loadState(path, reset, mode) {
  if (reset || !existsSync(path)) {
    return { version: 1, mode, createdAt: new Date().toISOString(), steps: {} };
  }
  let state;
  try {
    state = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { version: 1, mode, createdAt: new Date().toISOString(), steps: {} };
  }
  // SAFETY: a checkpoint is scoped to the mode that created it. A rehearsal
  // state must never mark mainnet (--live) steps as done, and vice versa.
  // Plan-only (dry-run) state carries no completed on-chain action, so it is
  // safely discarded when switching modes.
  if (state.mode && state.mode !== mode) {
    if (state.mode === "dry-run") {
      return { version: 1, mode, createdAt: new Date().toISOString(), steps: {} };
    }
    throw new Error(
      `State file ${path} was created by a "${state.mode}" run and cannot be reused for "${mode}". ` +
        "Pass a different --state path or --reset-state.",
    );
  }
  state.mode = state.mode ?? mode;
  return state;
}

function saveState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  state.updatedAt = new Date().toISOString();
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

function markStep(state, id, status, note) {
  state.steps[id] = { status, note: note ?? "", at: new Date().toISOString() };
}

// ── Manifest-based skip detection (reuse the delegated scripts' outputs) ──────
function readJsonIfExists(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

// On a testnet rehearsal the Solana deployment of record is devnet.json (the
// mainnet manifest does not exist yet) — without this, the rehearsal would try
// to re-deploy programs that are already live on devnet with fixed IDs
// (violating upgrade-not-deploy).
const SOLANA_DEVNET_MANIFEST = join(CONTRACTS_DIR, "deployments", "devnet.json");

function solanaProgramsDeployed(ctx) {
  const manifest = ctx?.mode === "rehearse-testnet" ? SOLANA_DEVNET_MANIFEST : SOLANA_MANIFEST;
  const m = readJsonIfExists(manifest);
  return Boolean(m?.programs?.nave_bridge && m?.programs?.nave_staking);
}

function solanaNaveMintPinned() {
  const m = readJsonIfExists(SOLANA_MANIFEST);
  return Boolean(m?.naveStake?.pinned);
}

function solanaAuthorityHandedOff(squads) {
  // The launch artifact records verified authorities; treat handoff as done when
  // every verified authority equals the Squads vault. (A chain read would be
  // authoritative but is deferred to the delegated verify phase; the wizard only
  // reads local manifests here so dry-run stays side-effect free.)
  const art = readJsonIfExists(SOLANA_LAUNCH_ARTIFACT);
  const verified = art?.authorities?.verified;
  if (!verified || !squads) return false;
  const vals = Object.values(verified);
  return vals.length > 0 && vals.every((v) => v === squads);
}

function evmArtifactIsLive(path) {
  const artifact = readJsonIfExists(path);
  if (!artifact) return false;
  return deploymentWireRefusal(artifact) == null;
}

function evmChainDeployed(chainId) {
  // Anvil fixtures and other non-production files exist on disk but are not a deploy.
  return evmArtifactIsLive(join(EVM_DEPLOYMENTS_DIR, `${chainId}.json`));
}

// Bridge-only chains (Robinhood) write `hardened-bridge-<chainId>.json` from
// DeployHardenedBridgeStack.s.sol instead of the DAO-stack `<chainId>.json`.
function evmBridgeStackDeployed(chainId) {
  return evmArtifactIsLive(join(EVM_DEPLOYMENTS_DIR, `hardened-bridge-${chainId}.json`));
}

function evmAdaptersDeployed(chainId) {
  return existsSync(join(EVM_DEPLOYMENTS_DIR, `adapters-${chainId}.json`));
}

function evmLaunch(chainId) {
  const path = join(EVM_DEPLOYMENTS_DIR, `evm-launch-${chainId}.json`);
  const artifact = readJsonIfExists(path);
  if (artifact && deploymentWireRefusal(artifact)) return null;
  return artifact;
}

function evmStakeConfigured(chainId) {
  return Boolean(evmLaunch(chainId)?.naveStake);
}

function evmHandoffStarted(chainId) {
  return Boolean(evmLaunch(chainId)?.authority?.handoff);
}

// ── Command builders (wrap the existing scripts; never reimplement) ───────────
function appPhaseCmd(ctx, phase) {
  const args = [APP_CUTOVER, "--phase", phase, "--scope", ctx.scope];
  if (ctx.envPath) args.push("--env", resolve(ctx.envPath));
  if (ctx.keyDir) args.push("--key-dir", resolve(ctx.keyDir));
  if (ctx.mode === "live") args.push("--confirm-mainnet");
  if (ctx.reuseProgramIds) args.push("--reuse-program-ids");
  return { cmd: "node", args, cwd: APP_ROOT };
}

function contractsPhaseCmd(ctx, phase) {
  const args = [CONTRACTS_CUTOVER, "--phase", phase, "--scope", ctx.scope];
  if (ctx.envPath) args.push("--env", resolve(ctx.envPath));
  if (ctx.keyDir) args.push("--key-dir", resolve(ctx.keyDir));
  if (ctx.mode === "live") args.push("--confirm-mainnet");
  if (ctx.reuseProgramIds) args.push("--reuse-program-ids");
  return { cmd: "node", args, cwd: CONTRACTS_DIR };
}

// Per-chain env derivation: the delegated EVM script takes a SINGLE-chain env
// (EVM_RPC_URL, NAVE_STAKE_TOKEN, PYTH_ADDRESS, …), but the wizard sequences
// TWO chains from one env file. Keys prefixed "<SEGMENT>__" (e.g.
// SEPOLIA__EVM_RPC_URL, BASE__NAVE_STAKE_TOKEN) override the base key for that
// chain; the wizard writes a derived 0600 env file per chain next to the state
// file and passes it by path. Without any prefixed keys the base env is used
// as-is (previous behavior).
function evmChainEnvPath(ctx, chain, { write }) {
  const prefix = `${chain.segment}__`;
  const hasOverrides = Object.keys(ctx.env).some((k) => k.startsWith(prefix));
  if (!ctx.envPath || !hasOverrides) return ctx.envPath;
  const derivedPath = join(dirname(ctx.statePath), `cutover-env-${chain.chainId}.derived.env`);
  if (write) {
    const allPrefixes = [...EVM_MAINNET_CHAINS, ...EVM_TESTNET_CHAINS].map((c) => `${c.segment}__`);
    const merged = {};
    for (const [k, v] of Object.entries(ctx.env)) {
      if (allPrefixes.some((p) => k.startsWith(p))) continue; // strip all prefixed keys
      merged[k] = v;
    }
    for (const [k, v] of Object.entries(ctx.env)) {
      if (k.startsWith(prefix)) merged[k.slice(prefix.length)] = v;
    }
    mkdirSync(dirname(derivedPath), { recursive: true });
    writeFileSync(
      derivedPath,
      `# DERIVED per-chain cutover env for ${chain.label} (${chain.chainId}) — regenerated each run.\n` +
        Object.entries(merged)
          .map(([k, v]) => `${k}=${v}`)
          .join("\n") +
        "\n",
      { mode: 0o600 },
    );
  }
  return derivedPath;
}

function evmPhaseCmd(ctx, chainId, phase) {
  const chain = [...EVM_MAINNET_CHAINS, ...EVM_TESTNET_CHAINS].find((c) => c.chainId === chainId);
  const args = [EVM_CUTOVER, "--chain-id", String(chainId), "--phase", phase, "--scope", ctx.scope];
  // Derived env is only WRITTEN on execute paths; dry-run just shows the path.
  const envPath = evmChainEnvPath(ctx, chain, { write: ctx.execute && ctx.mode !== "dry-run" });
  if (envPath) args.push("--env", resolve(envPath));
  // Only mainnet chain ids require --confirm-mainnet; testnet chains do not.
  if (ctx.mode === "live") args.push("--confirm-mainnet");
  return { cmd: "node", args, cwd: CONTRACTS_DIR };
}

function renderCmd(spec) {
  if (!spec) return "(manual / out-of-band step — no wizard command)";
  return `${spec.cmd} ${spec.args.map((a) => (/[ "']/.test(a) ? JSON.stringify(a) : a)).join(" ")}   # cwd: ${spec.cwd}`;
}

// The concrete chains this run targets.
function targetChains(ctx) {
  if (ctx.mode === "rehearse-testnet") return EVM_TESTNET_CHAINS;
  return EVM_MAINNET_CHAINS;
}

// The app + contracts cutover scripts are MAINNET-ONLY (they hard-require
// --confirm-mainnet and assert a mainnet-beta RPC genesis hash; there is no
// devnet code path). On a testnet rehearsal those delegated steps therefore
// cannot execute; they are skipped loudly and the devnet deployment is
// verified out-of-band (solana program show + the devnet smoke scripts).
function rehearseMainnetOnlySkip(ctx, extra) {
  if (ctx.mode !== "rehearse-testnet") return null;
  return {
    skip: true,
    reason:
      "delegated script is MAINNET-ONLY (hard-requires --confirm-mainnet + mainnet RPC; no devnet path) — " +
      `rehearsal verifies the existing devnet deployment out-of-band${extra ? `; ${extra}` : ""}`,
  };
}

// ── Step definitions ──────────────────────────────────────────────────────────
// Each step: { id, title, group, kind, buildPlan(ctx), skip(ctx) }
//   kind: local | irreversible | authority | infra | manual | verify
// `buildPlan` returns { summary[], command (spec|null), confirm (string|null),
//   manual (string[]|null) }.
function buildSteps(ctx) {
  const steps = [];
  const clusterLabel = ctx.mode === "rehearse-testnet" ? "Solana devnet" : "Solana mainnet-beta";
  const chains = targetChains(ctx);

  // ── Group A — EVM per chain (optional, additive) ────────────────────────────
  if (ctx.evmEnabled) {
    for (const chain of chains) {
      const c = chain.chainId;
      const L = `${chain.label} (${c})`;

      steps.push({
        id: `evm-${c}-preflight`,
        title: `EVM ${L}: preflight`,
        group: "EVM",
        kind: "local",
        buildPlan: () => ({
          summary: [
            `Validate the ${L} deploy inputs BEFORE any broadcast.`,
            chainIsBridgeOnly(chain, ctx)
              ? "Bridge/stake-only chain: reads RPC chain-id == chain, Safe has on-chain bytecode, deploy signer configured. DAO fee checks are skipped (no DAO stack on this chain)."
              : "Reads RPC chain-id == chain, Safe has on-chain bytecode, FORMATION_FEE_WEI/TREASURY_SEED_WEI==0 (fee-free), TOKEN_MINT_FEE_WEI==0.05 ETH, deploy signer configured.",
            "Read-only. No funds move.",
          ],
          command: evmPhaseCmd(ctx, c, "preflight"),
          confirm: null,
          manual: null,
        }),
        skip: () => ({ skip: false }),
      });

      steps.push({
        id: `evm-${c}-build`,
        title: `EVM ${L}: build + test`,
        group: "EVM",
        kind: "local",
        buildPlan: () => ({
          summary: ["forge build + forge test in contracts/evm. Local only; no chain write."],
          command: evmPhaseCmd(ctx, c, "build"),
          confirm: null,
          manual: null,
        }),
        skip: () => ({ skip: false }),
      });

      steps.push({
        id: `evm-${c}-deploy`,
        title: chainIsBridgeOnly(chain, ctx)
          ? `EVM ${L}: DEPLOY hardened bridge/staking/token stack (bridge-only chain)`
          : `EVM ${L}: DEPLOY core + hardened bridge/staking/token stack`,
        group: "EVM",
        kind: "irreversible",
        buildPlan: () => ({
          summary: chainIsBridgeOnly(chain, ctx)
            ? [
                `IRREVERSIBLE: forge script DeployHardenedBridgeStack.s.sol --broadcast --verify on ${L}.`,
                "Bridge/stake-only scope: deploys ONLY WrappedNave, NaveBridge lockbox, NaveStaking (no NaveProtocol/factory/oracle).",
                "Mainnet: STACK_OWNER defaults to SAFE_ADDRESS (Safe owns at deploy; deploy wallet only broadcasts).",
                "Wiring done by the Solidity script: WrappedNave.minter=lockbox, non-zero supplyCap, per-tx + daily caps, staking rewarder.",
                "Handoff is a separate phase.",
              ]
            : [
                `IRREVERSIBLE: forge script Deploy.s.sol --broadcast --verify on ${L}.`,
                "Deploys NaveProtocol, NaveDAOFactory, PythOracle and (via the hardened-bridge script) WrappedNave, NaveBridge lockbox, NaveStaking.",
                "Constructor/config wiring done here by the Solidity scripts (NOT separate wizard phases): WrappedNave.minter=lockbox, non-zero supplyCap, per-tx + daily caps, fee split, staking rewarder, mintPaused=true.",
                `PROTOCOL_OWNER=${safeEnvValue("PROTOCOL_OWNER", ctx.env)}  PROTOCOL_TREASURY=${safeEnvValue("PROTOCOL_TREASURY", ctx.env)}  PYTH_ADDRESS=${safeEnvValue("PYTH_ADDRESS", ctx.env)}`,
                "Handoff is a separate phase (HANDOFF_TO_SAFE=false here).",
              ],
          command: evmPhaseCmd(ctx, c, "deploy"),
          confirm: `DEPLOY ${chain.segment} ${c}`,
          manual: null,
        }),
        skip: () => {
          if (chainIsBridgeOnly(chain, ctx)) {
            return evmBridgeStackDeployed(c)
              ? { skip: true, reason: `deployments/hardened-bridge-${c}.json already present (already deployed)` }
              : { skip: false };
          }
          return evmChainDeployed(c)
            ? { skip: true, reason: `deployments/${c}.json already present (already deployed)` }
            : { skip: false };
        },
      });

      steps.push({
        id: `evm-${c}-adapters`,
        title: `EVM ${L}: deploy strategy adapters`,
        group: "EVM",
        kind: "irreversible",
        buildPlan: () => ({
          summary: [
            `IRREVERSIBLE: deploys Aave/Compound/Balancer adapters for ${L} (only the subset whose constructor-arg env vars are set).`,
            "Sequenced after core deploy (needs protocol address), before handoff. Loud-skips if no adapter env is set.",
          ],
          command: evmPhaseCmd(ctx, c, "adapters"),
          confirm: `DEPLOY ${chain.segment} ${c} ADAPTERS`,
          manual: null,
        }),
        skip: () => {
          if (chainIsBridgeOnly(chain, ctx)) {
            return { skip: true, reason: "bridge/stake-only chain — no DAO adapters phase (the delegated EVM script rejects it)" };
          }
          return evmAdaptersDeployed(c)
            ? { skip: true, reason: `adapters-${c}.json already present` }
            : { skip: false };
        },
      });

      steps.push({
        id: `evm-${c}-stake`,
        title: `EVM ${L}: pin $99 NAVE creation stake (setNaveStakeConfig + setDaoStake)`,
        group: "EVM",
        kind: "irreversible",
        buildPlan: () => ({
          summary: [
            `onlyOwner STATE CHANGE (pre-handoff): NaveProtocol.setNaveStakeConfig(NAVE_STAKE_TOKEN, REQUIRED_NAVE_STAKE) + setDaoStake(DAO_STAKE_MODULE) on ${L}.`,
            `token=${safeEnvValue("NAVE_STAKE_TOKEN", ctx.env)}  requiredStake=${safeEnvValue("REQUIRED_NAVE_STAKE", ctx.env)}  daoStakeModule=${safeEnvValue("DAO_STAKE_MODULE", ctx.env)}`,
            "The delegated script reads the config back on-chain and fails closed on mismatch.",
            "MUST run before the Safe handoff (onlyOwner). Loud-skips if stake env unset → creation stays fee-free with no stake gate.",
          ],
          command: evmPhaseCmd(ctx, c, "stake"),
          confirm: `STAKE ${chain.segment} ${c}`,
          manual: null,
        }),
        skip: () => {
          if (chainIsBridgeOnly(chain, ctx)) {
            return { skip: true, reason: "bridge/stake-only chain — no NaveProtocol, so no $99 creation-stake phase (the delegated EVM script rejects it)" };
          }
          return evmStakeConfigured(c)
            ? { skip: true, reason: `evm-launch-${c}.json already records naveStake` }
            : { skip: false };
        },
      });

      steps.push({
        id: `evm-${c}-handoff`,
        title: `EVM ${L}: AUTHORITY HANDOFF to Safe (two-step)`,
        group: "EVM",
        kind: "authority",
        buildPlan: () => ({
          summary: [
            chainIsBridgeOnly(chain, ctx)
              ? `AUTHORITY MOVE on ${L}: transferOwnership of the bridge stack ONLY (NaveBridge, NaveStaking, WrappedNave — two-step) to SAFE_ADDRESS (no NaveProtocol/PythOracle on this bridge/stake-only chain).`
              : `AUTHORITY MOVE on ${L}: transferOwnership of NaveProtocol (Ownable2Step, pending→accept), PythOracle (Ownable, immediate), and the bridge stack (NaveBridge, NaveStaking, WrappedNave — two-step) to SAFE_ADDRESS.`,
            `SAFE_ADDRESS=${safeEnvValue("SAFE_ADDRESS", ctx.env)}`,
            "P1 GATE (fail closed): NaveBridge.relayer() and NaveStaking.rewarder() must NOT equal the Safe.",
            "The Safe finalizes out-of-band via acceptOwnership(). The wizard does not sign for the Safe.",
          ],
          command: evmPhaseCmd(ctx, c, "handoff"),
          confirm: `HANDOFF ${chain.segment} ${c} TO SAFE`,
          manual: null,
        }),
        skip: () =>
          evmHandoffStarted(c)
            ? { skip: true, reason: `evm-launch-${c}.json already records an authority handoff` }
            : { skip: false },
      });

      steps.push({
        id: `evm-${c}-verify`,
        title: `EVM ${L}: verify (P1 owner ≠ relayer/rewarder readback)`,
        group: "EVM",
        kind: "verify",
        buildPlan: () => ({
          summary: [
            `Read back on-chain owner/pendingOwner/relayer/rewarder for ${L} and FAIL CLOSED if the relayer/rewarder hot key equals the (current or pending) multisig owner (audit P1).`,
            "Also records deployed-code presence per address. Abort loudly on mismatch.",
          ],
          command: evmPhaseCmd(ctx, c, "verify"),
          confirm: null,
          manual: null,
        }),
        skip: () => ({ skip: false }),
      });
    }
  }

  // ── Group B — Solana + platform (via the app top orchestrator) ──────────────
  steps.push({
    id: "sol-preflight",
    title: "Preflight (app + contracts safety gates)",
    group: "Solana",
    kind: "local",
    buildPlan: () => ({
      summary: [
        "App preflight: scope-aware env schema (bridge-stake skips DAO-only keys), VITE_USE_MOCKS=false, distinct secrets, signer-infra/bridge-faucet/EVM gates, mainnet RPC check; full scope also runs agent/fee/Jupiter/NAV/revenue-wallet checks.",
        "Then the contracts preflight (RPC mainnet, revalue-keeper confirmed, fee-free constants, NAVE mint config, deploy wallet present, toolchain).",
        "Read-only. No funds move; no keys custodied.",
      ],
      command: appPhaseCmd(ctx, "preflight"),
      confirm: null,
      manual: null,
    }),
    skip: () => rehearseMainnetOnlySkip(ctx) ?? { skip: false },
  });

  steps.push({
    id: "sol-keys",
    title: "Program keypairs (generate/load; idempotent)",
    group: "Solana",
    kind: "local",
    buildPlan: () => ({
      summary: [
        "Generates missing program keypairs into the secure --key-dir (0600) and copies them to target/deploy. Existing keypairs are reused (idempotent).",
        "For already-deployed programs pass --reuse-program-ids so program IDs are PRESERVED (in-place upgrade, per upgrade-not-deploy).",
        "No chain write.",
      ],
      command: appPhaseCmd(ctx, "keys"),
      confirm: null,
      manual: null,
    }),
    skip: () =>
      rehearseMainnetOnlySkip(ctx, "devnet program keypairs already exist (fixed IDs; upgrade-not-deploy)") ?? {
        skip: false,
      },
  });

  steps.push({
    id: "sol-build",
    title: "Build contracts (--features mainnet) + unit tests",
    group: "Solana",
    kind: "local",
    buildPlan: () => ({
      summary: [
        "build.sh --features mainnet (pins the mainnet Jupiter Lend program id) + npm run test:unit. Local only; no chain write.",
      ],
      command: appPhaseCmd(ctx, "build"),
      confirm: null,
      manual: null,
    }),
    skip: () => rehearseMainnetOnlySkip(ctx) ?? { skip: false },
  });

  steps.push({
    id: "sol-deploy",
    title:
      ctx.scope === "full"
        ? `DEPLOY Solana programs (8, incl. nave_bridge + nave_staking) + init global config + pin NAVE mint`
        : `DEPLOY Solana bridge/staking programs (nave_bridge + nave_staking only)`,
    group: "Solana",
    kind: "irreversible",
    buildPlan: () => ({
      summary:
        ctx.scope === "full"
          ? [
              `IRREVERSIBLE: solana program deploy of the 8 programs to ${clusterLabel} (in-place upgrade when --reuse-program-ids; program IDs preserved).`,
              "Then initialize_global_config (UPGRADE-AUTHORITY gated, run as the deploy wallet pre-handoff) and set_nave_mint pinning the canonical mainnet NAVE mint.",
              `canonical NAVE mint=${MAINNET_NAVE_MINT}  (devnet replica mint is refused on the mainnet path).`,
              "Writes deployments/mainnet.json, mainnet-program-ids.env, and the launch artifact.",
            ]
          : [
              `IRREVERSIBLE: solana program deploy of nave_bridge + nave_staking ONLY to ${clusterLabel} (treasury DAO programs stay on devnet).`,
              "Skips initialize_global_config and set_nave_mint (no nave_core on this path).",
              "Writes deployments/mainnet.json, mainnet-program-ids.env, and the launch artifact.",
            ],
      command: appPhaseCmd(ctx, "deploy-contracts"),
      confirm: `DEPLOY SOLANA ${ctx.mode === "rehearse-testnet" ? "DEVNET" : "MAINNET"} CONTRACTS`,
      manual: null,
    }),
    skip: () => {
      if (solanaProgramsDeployed(ctx)) {
        const manifest = ctx.mode === "rehearse-testnet" ? "deployments/devnet.json" : "deployments/mainnet.json";
        return {
          skip: true,
          reason: `${manifest} already lists nave_bridge + nave_staking (already deployed; program IDs preserved per upgrade-not-deploy)`,
        };
      }
      return rehearseMainnetOnlySkip(ctx) ?? { skip: false };
    },
  });

  steps.push({
    id: "sol-bridge-init",
    title: "Initialize bridge/staking config + wire+fund the neutral staking collector (MANUAL)",
    group: "Solana",
    kind: "manual",
    buildPlan: () => ({
      summary: [
        "NOT a phase in mainnet-cutover.mjs — the bridge/staking LAUNCH init is run out-of-band with the launch values, then the wizard's verify step confirms P1 ownership.",
        `nave_bridge.initialize_config: owner = Squads vault (${safeEnvValue("SQUADS_VAULT", ctx.env)}), relayer = KMS hot key (DISTINCT from owner — audit P1), protocol_fee_owner, staking_pool_owner = the RELAYER wallet that owns the neutral collector, fee ${BRIDGE_FEE.totalBps} bps split ${BRIDGE_FEE.stakingBps}/${BRIDGE_FEE.protocolBps}/${BRIDGE_FEE.burnBps} (staking/protocol/burn), per-tx + daily caps (non-zero), paused.`,
        "nave_staking.initialize_pool: owner = Squads vault; seeds the rolling 365-day drip (reward_duration = 31536000).",
        "Create the dedicated NAVE collector token account owned by the relayer wallet, then set BRIDGE_SOLANA_STAKING_COLLECTOR = BRIDGE_SOLANA_STAKING_POOL_ACCOUNT = VITE_NAVE_BRIDGE_STAKING_POOL_ACCOUNT = <collector> and repoint the BridgeConfig staking leg at it via set_config.",
      ],
      command: null,
      confirm: `BRIDGE INIT COMPLETE ON ${ctx.mode === "rehearse-testnet" ? "DEVNET" : "MAINNET"}`,
      manual: [
        "See contracts/solana/scripts/bridge-setup-relayer.mjs and the staking-drip cutover template.",
        "Reference config in the PROGRAMS comment of contracts/solana/scripts/mainnet-cutover.mjs.",
        "Confirm afterward: owner = Squads, relayer distinct from owner, collector == staking pool account, caps non-zero.",
      ],
    }),
    // Only relevant if the bridge/staking leg is being launched (bridge reviewed
    // or mirror enabled). Skip when the bridge is not part of this cutover.
    skip: () => {
      const bridgeReviewed = (ctx.env.NAVE_BRIDGE_MAINNET_REVIEWED ?? "").toLowerCase() === "true";
      const anyBridge =
        (ctx.env.BRIDGE_RELAYER_ENABLED ?? "").toLowerCase() === "true" ||
        (ctx.env.STAKING_MIRROR_ENABLED ?? "").toLowerCase() === "true";
      if (!anyBridge && !bridgeReviewed) {
        return { skip: true, reason: "bridge/staking leg not enabled for this cutover (no BRIDGE_* / mirror)" };
      }
      return { skip: false };
    },
  });

  steps.push({
    id: "sol-set-nave-mint",
    title: "Confirm/re-pin canonical NAVE stake mint (standalone; pre-handoff)",
    group: "Solana",
    kind: "irreversible",
    buildPlan: () => ({
      summary: [
        "authority-gated (global_config.authority = deploy wallet, pre-handoff). Idempotent: skips when already pinned to the canonical mint; fails closed if the on-chain mint mismatches after the call.",
        `pins set_nave_mint(${MAINNET_NAVE_MINT}).`,
      ],
      command: contractsPhaseCmd(ctx, "set-nave-mint"),
      confirm: `PIN NAVE MINT ${ctx.mode === "rehearse-testnet" ? "DEVNET" : "MAINNET"}`,
      manual: null,
    }),
    skip: () => {
      if (ctx.scope === "bridge-stake") {
        return { skip: true, reason: "bridge-stake scope — set_nave_mint requires nave_core (use --scope full for DAO cutover)" };
      }
      return (
        solanaNaveMintPinned()
          ? { skip: true, reason: "deployments/mainnet.json records naveStake.pinned=true (already pinned)" }
          : rehearseMainnetOnlySkip(ctx, "devnet pins the devnet replica mint; the canonical-mint pin is mainnet-only") ?? {
              skip: false,
            }
      );
    },
  });

  steps.push({
    id: "sol-handoff",
    title: "AUTHORITY HANDOFF: Solana upgrade authority → Squads vault",
    group: "Solana",
    kind: "authority",
    buildPlan: () => ({
      summary: [
        `AUTHORITY MOVE: solana program set-upgrade-authority for all deployed programs → Squads vault (${safeEnvValue("SQUADS_VAULT", ctx.env)}).`,
        "Verified via solana program show after each transfer; fails closed on mismatch.",
        "Run AFTER initialize_global_config + set_nave_mint (both need the deploy wallet as authority).",
      ],
      command: appPhaseCmd(ctx, "handoff-authority"),
      confirm: `HANDOFF SOLANA AUTHORITY TO SQUADS`,
      manual: null,
    }),
    skip: () =>
      solanaAuthorityHandedOff((ctx.env.SQUADS_VAULT ?? "").trim())
        ? { skip: true, reason: "launch artifact records all program authorities == Squads vault" }
        : rehearseMainnetOnlySkip(
            ctx,
            "an authority handoff is NEVER exercised against a rehearsal placeholder (it would orphan the devnet programs)",
          ) ?? { skip: false },
  });

  steps.push({
    id: "sol-platform",
    title: "Deploy platform (Supabase link/push/secrets/functions + Helius webhook)",
    group: "Platform",
    kind: "infra",
    buildPlan: () => ({
      summary: [
        "INFRA STATE CHANGE: supabase link + db push (migrations) + secrets set + functions:deploy, then register the mainnet Helius webhook over all program IDs.",
        `Supabase project ref=${safeEnvValue("SUPABASE_PROJECT_REF", ctx.env)}  url=${safeEnvValue("VITE_SUPABASE_URL", ctx.env)}`,
        "Mutates the live Supabase project + Helius. No on-chain funds move, but this is not trivially reversible.",
      ],
      command: appPhaseCmd(ctx, "deploy-platform"),
      confirm: `DEPLOY PLATFORM ${ctx.mode === "rehearse-testnet" ? "TESTNET" : "MAINNET"}`,
      manual: null,
    }),
    skip: () =>
      rehearseMainnetOnlySkip(ctx, "the live Supabase/Helius project must not be mutated by a rehearsal") ?? {
        skip: false,
      },
  });

  steps.push({
    id: "sol-verify",
    title: "Verify (program hashes + P1 bridge/staking ownership + go/no-go)",
    group: "Verify",
    kind: "verify",
    buildPlan: () => ({
      summary: [
        "Contracts verify: solana-verify program hashes + assertBridgeAndStakingOwnership — FAIL CLOSED unless nave_bridge/nave_staking owner is the Squads vault (or pending to it) AND owner ≠ relayer (audit P1).",
        "Then the app verify gate: beta:go-no-go (+ verify:e2e-gate when DAO_ADDRESS set). Re-runs the config safety gates.",
        "Read-only asserts; abort loudly on any mismatch.",
      ],
      command: appPhaseCmd(ctx, "verify"),
      confirm: null,
      manual: null,
    }),
    skip: () =>
      rehearseMainnetOnlySkip(ctx, "devnet P1 posture (owner == relayer) is a known testnet-only condition") ?? {
        skip: false,
      },
  });

  // ── Group C — Final cross-chain invariant + unpause ─────────────────────────
  steps.push({
    id: "final-invariants",
    title: "Final cross-chain invariant review (owner ≠ relayer/rewarder on every chain; Σ caps ≤ custody)",
    group: "Final",
    kind: "manual",
    buildPlan: () => ({
      summary: [
        "Confirm, across ALL chains, that the multisig owner is distinct from the relayer/rewarder hot key (audit P1) — enforced on-chain by the Solana + EVM verify phases already run above.",
        "Operationally confirm Σ per-chain wNAVE supplyCap ≤ Solana custody NAVE backing (per-chain caps do NOT enforce global 1:1 backing).",
        "Confirm BRIDGE_FEE_BPS == VITE_NAVE_BRIDGE_FEE_BPS == on-chain BridgeConfig.fee_bps (250; split 100/100/50).",
        "Confirm BRIDGE_EVM_CONFIRMATIONS ≥ 5 and relayer keys are KMS/HSM-backed.",
      ],
      command: null,
      confirm: `INVARIANTS CONFIRMED`,
      manual: [
        "Re-run the EVM verify phase per chain and the Solana verify phase if any config changed.",
        "This step is a human sign-off gate; it moves no funds.",
      ],
    }),
    skip: () => {
      const bridgeReviewed = (ctx.env.NAVE_BRIDGE_MAINNET_REVIEWED ?? "").toLowerCase() === "true";
      const anyBridge =
        (ctx.env.BRIDGE_RELAYER_ENABLED ?? "").toLowerCase() === "true" ||
        (ctx.env.STAKING_MIRROR_ENABLED ?? "").toLowerCase() === "true";
      return !anyBridge && !bridgeReviewed
        ? { skip: true, reason: "bridge/staking leg not part of this cutover" }
        : { skip: false };
    },
  });

  steps.push({
    id: "final-unpause",
    title: "UNPAUSE bridge/staking via the multisig (final, after two-way smoke)",
    group: "Final",
    kind: "manual",
    buildPlan: () => ({
      summary: [
        "The bridge/lockbox ships PAUSED. As the FINAL step — only after a tiny-amount smoke bridge in BOTH directions succeeds — the Squads/Safe multisig unpauses.",
        "This is an onlyOwner multisig action executed out-of-band (Squads / Safe UI); the wizard does not and cannot sign for the multisig.",
        "unpause: nave_bridge set_paused(false) via Squads; NaveBridge setPaused(false) + WrappedNave setMintPaused(false) via Safe.",
      ],
      command: null,
      confirm: `UNPAUSE CONFIRMED BY MULTISIG`,
      manual: [
        "Execute the tiny-amount two-way smoke bridge first; assert fee-split balances + replay rejection.",
        "Then propose+execute the unpause from the multisig. Record the tx signatures in the release ticket.",
      ],
    }),
    skip: () => {
      const bridgeReviewed = (ctx.env.NAVE_BRIDGE_MAINNET_REVIEWED ?? "").toLowerCase() === "true";
      const anyBridge = (ctx.env.BRIDGE_RELAYER_ENABLED ?? "").toLowerCase() === "true";
      return !anyBridge && !bridgeReviewed
        ? { skip: true, reason: "bridge not enabled for this cutover — nothing to unpause" }
        : { skip: false };
    },
  });

  return steps;
}

// ── Runner ────────────────────────────────────────────────────────────────────
function runSpec(spec) {
  const result = spawnSync(spec.cmd, spec.args, { cwd: spec.cwd, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`Step command failed (exit ${result.status}): ${renderCmd(spec)}`);
  }
}

async function main() {
  const ctx = parseArgs();
  if (ctx.help) {
    printHelp();
    return;
  }

  // Safety guards on the destructive modes.
  if (ctx.mode === "live" && ctx.execute && !ctx.confirmMainnet) {
    throw new Error("--live --execute requires --confirm-mainnet.");
  }
  if (ctx.mode === "live" && ctx.yes) {
    throw new Error("--yes (auto-accept confirmations) is REFUSED on --live. Confirm each step manually.");
  }
  const willExecute = ctx.execute && ctx.mode !== "dry-run";

  ctx.env = parseEnvFile(ctx.envPath);
  ctx.evmEnabled = ctx.evm === "on" ? true : ctx.evm === "off" ? false : detectEvmEnabled(ctx.env);

  const state = loadState(ctx.statePath, ctx.resetState, ctx.mode);
  const steps = buildSteps(ctx);

  console.log("\n══════════════════════════════════════════════════════════════════════");
  console.log("  NAVE MAINNET CUTOVER WIZARD");
  console.log("══════════════════════════════════════════════════════════════════════");
  console.log(`  mode:        ${ctx.mode}${willExecute ? " (EXECUTE)" : " (plan-only)"}`);
  console.log(`  scope:       ${ctx.scope}${ctx.scope === "bridge-stake" ? " (bridge/staking only — treasury stays on devnet)" : " (full DAO + bridge stack)"}`);
  console.log(`  target:      ${ctx.mode === "rehearse-testnet" ? "Sepolia + Base Sepolia + Robinhood Testnet + Solana devnet" : "Ethereum + Base + Robinhood + Solana mainnet-beta"}`);
  console.log(`  EVM leg:     ${ctx.evmEnabled ? "ENABLED" : "disabled (Solana-only)"}`);
  console.log(`  env file:    ${ctx.envPath ? resolve(ctx.envPath) : "<none — plan uses placeholders>"}${ctx.envPath && !existsSync(ctx.envPath) ? " (NOT FOUND)" : ""}`);
  console.log(`  key dir:     ${ctx.keyDir ? resolve(ctx.keyDir) : "<none>"}`);
  console.log(`  state file:  ${ctx.statePath}`);
  console.log(`  secrets:     NEVER custodied by the wizard — signing is delegated to the chain CLIs.`);
  if (!willExecute) {
    console.log("\n  This is a PLAN-ONLY run. No commands are executed and no irreversible");
    console.log("  action is taken. Add --execute (and --confirm-mainnet on --live) to run.");
  }

  const rl = willExecute && !ctx.yes ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  let stepNo = 0;
  try {
    for (const step of steps) {
      stepNo += 1;
      const plan = step.buildPlan(ctx);
      const prior = state.steps[step.id];
      const skipDecision = step.skip(ctx);

      console.log(`\n──────────────────────────────────────────────────────────────────────`);
      console.log(`Step ${stepNo}/${steps.length}  [${step.group} · ${step.kind}]  ${step.title}`);
      console.log(`  id: ${step.id}`);
      for (const line of plan.summary) console.log(`  • ${line}`);
      console.log(`  command: ${renderCmd(plan.command)}`);
      if (plan.manual) for (const m of plan.manual) console.log(`  ↳ ${m}`);
      if (plan.confirm) {
        console.log(`  confirmation required: type exactly →  ${plan.confirm}`);
      }

      // Idempotent skip (completed on-chain action or prior state).
      if (prior?.status === "done") {
        console.log(`  ✓ SKIP — already completed in a prior run (${prior.at}).`);
        continue;
      }
      if (skipDecision.skip) {
        console.log(`  ✓ SKIP — ${skipDecision.reason}.`);
        markStep(state, step.id, "done", `skipped: ${skipDecision.reason}`);
        saveState(ctx.statePath, state);
        continue;
      }

      if (!willExecute) {
        console.log(`  (plan-only: would ${plan.command ? "run the command above" : "perform the manual step above"}${plan.confirm ? " after typed confirmation" : ""}.)`);
        markStep(state, step.id, "planned", "plan-only run");
        continue;
      }

      // EXECUTE path — confirmation gate for anything irreversible/authority/infra/manual.
      // Rehearsal-only escape hatches (REFUSED on --live, where any mismatch aborts):
      //   • typing SKIP at a confirmation marks the step operator-skipped and continues
      //     (e.g. an authority handoff that must not target a placeholder multisig);
      //   • when a step command fails, typing CONTINUE records the failure and proceeds
      //     so the rest of the sequence can still be rehearsed.
      const rehearsal = ctx.mode === "rehearse-testnet";
      const needsConfirm = Boolean(plan.confirm);
      if (needsConfirm && !ctx.yes) {
        const hint = rehearsal ? ` (SKIP skips this step; anything else aborts)` : ` (anything else aborts)`;
        const answer = (await rl.question(`  Type "${plan.confirm}" to proceed${hint}: `)).trim();
        if (answer !== plan.confirm) {
          if (rehearsal && answer === "SKIP") {
            console.log(`  ⏭ SKIP — operator skipped this step (rehearsal only; recorded in the checkpoint).`);
            markStep(state, step.id, "done", "operator-skipped (rehearsal)");
            saveState(ctx.statePath, state);
            continue;
          }
          throw new Error(`Confirmation mismatch for step ${step.id}. Aborting cutover (nothing further executed).`);
        }
      } else if (needsConfirm && ctx.yes) {
        console.log(`  (--yes: auto-accepted "${plan.confirm}" — rehearsal automation)`);
      }

      if (plan.command) {
        console.log(`  ▶ executing: ${renderCmd(plan.command)}`);
        try {
          runSpec(plan.command);
        } catch (error) {
          if (rehearsal && rl) {
            console.error(`  ✗ step FAILED: ${error.message}`);
            const answer = (
              await rl.question(`  Rehearsal: type "CONTINUE" to record the failure and proceed (anything else aborts): `)
            ).trim();
            if (answer === "CONTINUE") {
              markStep(state, step.id, "failed", error.message);
              saveState(ctx.statePath, state);
              continue;
            }
          }
          throw error;
        }
        markStep(state, step.id, "done", "executed");
      } else {
        // Manual/out-of-band step: the operator performs it; the wizard records
        // the acknowledgement so a resume does not re-prompt.
        markStep(state, step.id, "done", "manual step acknowledged");
      }
      saveState(ctx.statePath, state);
      console.log(`  ✓ done.`);
    }
  } finally {
    if (rl) rl.close();
  }

  saveState(ctx.statePath, state);
  console.log(`\n══════════════════════════════════════════════════════════════════════`);
  console.log(willExecute ? "  Cutover run complete (see per-step results above)." : "  Plan printed. No action taken.");
  console.log(`  Checkpoint saved: ${ctx.statePath}`);
  console.log("══════════════════════════════════════════════════════════════════════\n");
}

main().catch((error) => {
  console.error(`\nCutover wizard failed: ${error.message}`);
  process.exit(1);
});
