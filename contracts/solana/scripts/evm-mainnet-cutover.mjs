#!/usr/bin/env node
// ─── Nave EVM mainnet cutover (Ethereum + Base + Robinhood ONLY) ──────────────
//
// Counterpart to mainnet-cutover.mjs (Solana). Drives the Foundry deploy +
// explorer verification + Safe authority handoff for the EVM contracts
// in ../../evm, keyed by chain id. Scope is fenced to:
//   1         Ethereum mainnet
//   8453      Base mainnet
//   4663      Robinhood Chain mainnet   (Arbitrum Nitro L2)
//   11155111  Ethereum Sepolia (testnet)
//   84532     Base Sepolia (testnet)
//   46630     Robinhood Chain Testnet
// Any other EVM chain id (e.g. BSC 56) is HARD-REJECTED at preflight.
//
// Scope (--scope):
//   bridge-stake (default): hardened bridge stack only (WrappedNave + NaveBridge
//     lockbox + NaveStaking). `adapters`/`stake` are rejected; handoff/verify
//     operate on the bridge stack. Use this until Safe handoff + P1 (owner ≠
//     relayer) are complete on each chain.
//   full: DAO stack via Deploy.s.sol (all supported chains including Robinhood
//     4663/46630). Requires WETH pinned in NaveAddressRegistry for that chain;
//     yield adapters may be zero on Robinhood (capital via bridge adapters).
// Robinhood verification uses Blockscout (no API key).
//
// Phases (--phase): preflight | build | deploy | adapters | stake | handoff | verify | all
//   adapters: deploys the strategy adapters (Aave/Compound/Balancer) via
//   script/DeployAdapters.s.sol, sequenced after `deploy` (needs the protocol
//   address) and before `handoff`. In a full `all` run a missing adapter script
//   is a loud skip; `--phase adapters` fails closed if it is missing.
//   stake: records a zero required NAVE amount on NaveProtocol via
//   setNaveStakeConfig(NAVE_STAKE_TOKEN, 0) + setDaoStake(DAO_STAKE_MODULE) so an
//   existing lock can still be released. onlyOwner, so it MUST run BEFORE the
//   Safe handoff. REQUIRED_NAVE_STAKE must be 0 or unset. A non-zero value fails
//   closed. In a full `all` run a missing token/module is a loud skip.
// Mainnet phases (chain id 1 / 8453 / 4663) require --confirm-mainnet, just
// like the Solana cutover's strict guard.
//
// DAO creation charges no protocol fee (FORMATION_FEE_WEI / TREASURY_SEED_WEI
// must be 0 on mainnet). Forming a treasury does not lock NAVE. The token-mint
// fee is separate and unchanged (0.05 ETH on mainnet).
//
// Required env (per chosen --chain-id):
//   EVM_RPC_URL                  JSON-RPC for the target chain (single-chain), OR
//   EVM_ETHEREUM_RPC_URL / EVM_BASE_RPC_URL / EVM_ROBINHOOD_RPC_URL
//                                preferred per-chain RPCs (auto-selected from
//                                --chain-id so a leftover Ethereum EVM_RPC_URL
//                                cannot silently deploy Base/Robinhood to L1)
//   EVM_DEPLOY_PRIVATE_KEY       0x deploy key (or set EVM_DEPLOY_ACCOUNT keystore)
//   PROTOCOL_OWNER               initial owner (deploy wallet; pre-handoff)
//   PROTOCOL_TREASURY            protocol fee recipient
//   PYTH_ADDRESS                 per-chain Pyth contract
//   SAFE_ADDRESS                 Safe multisig for authority handoff (must have code)
//   ETHERSCAN_API_KEY            verify on Ethereum (1 / 11155111)
//   BASESCAN_API_KEY             verify on Base (8453 / 84532)
// Required on mainnet: TOKEN_MINT_FEE_WEI (must be 50000000000000000 = 0.05 ETH;
//   the separate, ongoing token-mint fee — unchanged).
// Fee-free creation (enforced 0 below): FORMATION_FEE_WEI and TREASURY_SEED_WEI,
//   if set on mainnet, MUST be 0 (MAINNET_FORMATION_FEE_WEI / MAINNET_TREASURY_SEED_WEI
//   are both "0"). Creation takes no ETH profit and there is no formation-fee
//   carve-out. REQUIRED_NAVE_STAKE (--phase stake) must be 0.
//   Omit both to default to 0.
// Adapter constructor args (per chain, optional; deploys the subset that is set):
//   AAVE_V3_POOL
//   COMPOUND_V3_COMET
//   BALANCER_VAULT, BALANCER_POOL_ID, BALANCER_BPT, BALANCER_ROUTED_ASSET,
//     BALANCER_ASSET_INDEX, BALANCER_TOKEN_COUNT
// Curve is intentionally omitted until a vetted deployment/pool exists.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deploymentWireRefusal } from "../../evm/script/lib/deploymentArtifactStatus.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const EVM_CONTRACTS_DIR = resolve(ROOT, "..", "evm");
const DEPLOYMENTS_DIR = join(EVM_CONTRACTS_DIR, "deployments");

// The closed set of supported EVM chain ids. Anything else is rejected.
const SUPPORTED_CHAIN_IDS = new Set([1, 8453, 4663, 11155111, 84532, 46630, 5042002]);
const MAINNET_CHAIN_IDS = new Set([1, 8453, 4663]);
// Robinhood Chain (Arbitrum Nitro L2) hosts ONLY the bridge/staking stack when
// the DAO stack is deployed separately. With `--scope bridge-stake` (default)
// EVERY chain uses the hardened bridge stack only.
// Robinhood previously forced bridge-stake only. Full DAO stack is now
// supported via `--scope full` (same as Base/Ethereum). Keep the set for
// documentation / operator defaults; it no longer overrides an explicit full scope.
const BRIDGE_ONLY_CHAIN_IDS = new Set([]);
const FORMER_BRIDGE_ONLY_CHAIN_IDS = new Set([4663, 46630]);
const CUTOVER_SCOPES = new Set(["bridge-stake", "full"]);
const DEFAULT_CUTOVER_SCOPE = "bridge-stake";
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const CHAIN_META = {
  1: {
    label: "Ethereum",
    explorer: "etherscan",
    apiKeyEnv: "ETHERSCAN_API_KEY",
    testnet: false,
    rpcEnvKeys: ["EVM_ETHEREUM_RPC_URL", "EVM_RPC_URL"],
  },
  8453: {
    label: "Base",
    explorer: "basescan",
    apiKeyEnv: "BASESCAN_API_KEY",
    testnet: false,
    rpcEnvKeys: ["EVM_BASE_RPC_URL", "EVM_RPC_URL"],
  },
  // Blockscout verification needs no API key — verifierUrl is passed instead.
  4663: {
    label: "Robinhood Chain",
    explorer: "blockscout",
    apiKeyEnv: null,
    verifier: "blockscout",
    verifierUrl: "https://robinhoodchain.blockscout.com/api",
    testnet: false,
    rpcEnvKeys: ["EVM_ROBINHOOD_RPC_URL", "EVM_RPC_URL"],
  },
  11155111: {
    label: "Ethereum Sepolia",
    explorer: "etherscan",
    apiKeyEnv: "ETHERSCAN_API_KEY",
    testnet: true,
    rpcEnvKeys: ["EVM_SEPOLIA_RPC_URL", "EVM_ETHEREUM_RPC_URL", "EVM_RPC_URL"],
  },
  84532: {
    label: "Base Sepolia",
    explorer: "basescan",
    apiKeyEnv: "BASESCAN_API_KEY",
    testnet: true,
    rpcEnvKeys: ["EVM_BASE_SEPOLIA_RPC_URL", "EVM_BASE_RPC_URL", "EVM_RPC_URL"],
  },
  46630: {
    label: "Robinhood Testnet",
    explorer: "blockscout",
    apiKeyEnv: null,
    verifier: "blockscout",
    verifierUrl: "https://explorer.testnet.chain.robinhood.com/api",
    testnet: true,
    rpcEnvKeys: ["EVM_ROBINHOOD_TESTNET_RPC_URL", "EVM_ROBINHOOD_RPC_URL", "EVM_RPC_URL"],
  },
  5042002: {
    label: "Arc Testnet",
    explorer: "blockscout",
    apiKeyEnv: null,
    testnet: true,
    rpcEnvKeys: ["EVM_ARC_TESTNET_RPC_URL", "EVM_RPC_URL"],
  },
};

/**
 * Bind env.EVM_RPC_URL to the RPC for `--chain-id` before any forge/cast call.
 * Prefers the chain-specific key (EVM_BASE_RPC_URL, …) so a stale Ethereum
 * EVM_RPC_URL cannot broadcast a Base/Robinhood deploy onto L1.
 */
function resolveRpcForChain(env, chainId) {
  const meta = CHAIN_META[chainId];
  const keys = meta.rpcEnvKeys || ["EVM_RPC_URL"];
  let chosenKey = null;
  let url = "";
  for (const key of keys) {
    const v = (env[key] || "").trim();
    if (v) {
      chosenKey = key;
      url = v;
      break;
    }
  }
  if (!url) {
    throw new Error(
      `No RPC URL for chain ${chainId} (${meta.label}). Set one of: ${keys.join(", ")}.`,
    );
  }
  env.EVM_RPC_URL = url;
  if (chosenKey !== "EVM_RPC_URL") {
    console.log(`  Using ${chosenKey} for chain ${chainId} (${meta.label}).`);
  }
  return url;
}

/** forge `--verify` flags for the chain's explorer (Etherscan-family or Blockscout). */
function verifierArgs(env, chainId) {
  const meta = CHAIN_META[chainId];
  if (meta.verifier === "blockscout") {
    return ["--verifier", "blockscout", "--verifier-url", meta.verifierUrl];
  }
  return ["--etherscan-api-key", env[meta.apiKeyEnv]];
}

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {
    envPath: "",
    phase: "all",
    chainId: 0,
    scope: (process.env.CUTOVER_SCOPE || DEFAULT_CUTOVER_SCOPE).trim(),
    confirmMainnet: false,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--env") out.envPath = args[++i];
    else if (arg === "--phase") out.phase = args[++i];
    else if (arg === "--chain-id") out.chainId = Number(args[++i]);
    else if (arg === "--scope") out.scope = args[++i];
    else if (arg === "--confirm-mainnet") out.confirmMainnet = true;
  }
  if (!out.chainId) throw new Error("Missing required flag: --chain-id <1|8453|4663|11155111|84532|46630>");
  if (!CUTOVER_SCOPES.has(out.scope)) {
    throw new Error(`Invalid --scope "${out.scope}" (allowed: bridge-stake, full).`);
  }

  // ── Hard chain-id guard (reject BSC 56 and any other EVM network) ──
  if (!SUPPORTED_CHAIN_IDS.has(out.chainId)) {
    throw new Error(
      `Unsupported EVM chain id ${out.chainId}. Nave supports ONLY 1, 8453, 4663, 11155111, 84532, 46630, 5042002 ` +
        "(Ethereum + Base + Robinhood Chain mainnets/testnets). No BSC/Polygon.",
    );
  }
  if (isBridgeOnlyScope(out.chainId, out.scope) && ["adapters", "stake"].includes(out.phase)) {
    throw new Error(
      `Phase '${out.phase}' is not available on chain ${out.chainId} in scope '${out.scope}' ` +
        "(bridge/staking-only — no DAO protocol/factory/adapters/stake).",
    );
  }
  if (MAINNET_CHAIN_IDS.has(out.chainId) && !out.confirmMainnet) {
    throw new Error(`Refusing to run mainnet flow on chain ${out.chainId} without --confirm-mainnet.`);
  }
  return out;
}

function isBridgeOnlyScope(chainId, scope) {
  void chainId;
  void FORMER_BRIDGE_ONLY_CHAIN_IDS;
  return scope === "bridge-stake";
}

function parseEnvFile(path) {
  if (!path) return {};
  const raw = readFileSync(resolve(path), "utf8");
  const env = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    env[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return env;
}

// Provider RPC URLs routinely embed API keys in the path/query — never echo
// them into error messages/logs. Only the origin is diagnostic anyway.
function redactArg(arg) {
  if (/^https?:\/\//i.test(arg)) {
    try {
      return `${new URL(arg).origin}/<redacted>`;
    } catch {
      return "<redacted-url>";
    }
  }
  return arg;
}

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    cwd: options.cwd ?? EVM_CONTRACTS_DIR,
    env: { ...process.env, ...options.env },
    stdio: options.stdio ?? "inherit",
    encoding: "utf8",
  });
  const shownArgs = args.map(redactArg).join(" ");
  // spawnSync sets `error` (e.g. ENOENT) when the binary can't be launched at
  // all — surface that explicitly so a missing `forge`/`cast`/`git` reads as a
  // clear "not installed / not on PATH" instead of an opaque non-zero status.
  if (result.error) {
    if (result.error.code === "ENOENT") {
      throw new Error(`Command not found: ${cmd}. Is it installed and on PATH? (${cmd} ${shownArgs})`);
    }
    throw new Error(`Failed to launch ${cmd}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`Command failed (${cmd} ${shownArgs})`);
  }
  return result;
}

function runCapture(cmd, args, env) {
  const r = run(cmd, args, { stdio: "pipe", env });
  return (r.stdout ?? "").trim();
}

function requireEnv(env, keys) {
  for (const key of keys) {
    if (!env[key]) throw new Error(`Missing required env var: ${key}`);
  }
}

/** Validate that the named env vars (when present) are 0x 20-byte addresses. */
function requireAddresses(env, keys) {
  for (const key of keys) {
    const v = (env[key] || "").trim();
    if (v && !EVM_ADDRESS_RE.test(v)) {
      throw new Error(`${key} must be a 0x 20-byte EVM address (got "${v}").`);
    }
  }
}

/** True iff `addr` has deployed bytecode on-chain (cast code != 0x). */
function hasOnchainCode(env, addr) {
  const code = runCapture("cast", ["code", addr, "--rpc-url", env.EVM_RPC_URL], env);
  return code !== "0x" && code.length > 2;
}

/** A deploy/handoff signer (private key or foundry keystore account) is set. */
function hasDeploySigner(env) {
  return Boolean(env.EVM_DEPLOY_PRIVATE_KEY || env.EVM_DEPLOY_ACCOUNT);
}

function signerArgs(env) {
  if (env.EVM_DEPLOY_PRIVATE_KEY) return ["--private-key", env.EVM_DEPLOY_PRIVATE_KEY];
  if (env.EVM_DEPLOY_ACCOUNT) return ["--account", env.EVM_DEPLOY_ACCOUNT];
  throw new Error("Set EVM_DEPLOY_PRIVATE_KEY or EVM_DEPLOY_ACCOUNT for the deploy/handoff phase.");
}

/** Verify the RPC actually serves the expected chain id (fail closed). */
function verifyRpcChainId(env, chainId) {
  const onchain = Number(runCapture("cast", ["chain-id", "--rpc-url", env.EVM_RPC_URL], env));
  if (onchain !== chainId) {
    throw new Error(`RPC chain id mismatch: --chain-id ${chainId} but EVM_RPC_URL serves ${onchain}.`);
  }
  if (!SUPPORTED_CHAIN_IDS.has(onchain)) {
    throw new Error(`RPC serves unsupported chain id ${onchain}.`);
  }
}

// DAO creation charges no protocol fee on every network (mirrors the Solana side
// where FORMATION_FEE_LAMPORTS = 0). Forming a treasury does not lock NAVE. The
// token-mint fee is a SEPARATE, ongoing fee and is unchanged.
const MAINNET_FORMATION_FEE_WEI = "0"; // no protocol fee at formation
const MAINNET_TOKEN_MINT_FEE_WEI = "50000000000000000"; // 0.05 ETH (separate mint fee, unchanged)
// No formation-fee carve-out. The founder supplies any initial treasury deposit
// separately. That deposit is not a fee.
const MAINNET_TREASURY_SEED_WEI = "0";
// New treasuries lock no NAVE. The stake phase writes required amount 0 and may
// still set the moonlight module so an existing lock can be released.
const DAO_STAKE_TARGET_USD = 0;

function preflight(env, chainId, scope) {
  const meta = CHAIN_META[chainId];
  const bridgeOnly = isBridgeOnlyScope(chainId, scope);
  // Bridge-only chains (Robinhood) have no DAO stack: only the RPC, Safe and a
  // deploy signer are needed. Blockscout chains need no explorer API key.
  // RPC is resolved via resolveRpcForChain (chain-specific keys preferred).
  const required = bridgeOnly
    ? ["SAFE_ADDRESS"]
    : ["PROTOCOL_OWNER", "PROTOCOL_TREASURY", "PYTH_ADDRESS", "SAFE_ADDRESS"];
  if (meta.apiKeyEnv) required.push(meta.apiKeyEnv);
  requireEnv(env, required);
  if (!(env.EVM_RPC_URL || "").trim()) {
    throw new Error(
      `EVM_RPC_URL unresolved for chain ${chainId}. Set ${ (meta.rpcEnvKeys || ["EVM_RPC_URL"]).join(" or ") }.`,
    );
  }
  // "arbitrum" stays blocked: Robinhood is an Arbitrum Nitro chain but its RPC
  // hosts never carry that word (rpc.*.chain.robinhood.com / robinhood-*.g.alchemy.com)
  // — an "arbitrum" hostname means someone pointed this at Arbitrum One/Sepolia.
  if (/\b(bsc|binance|polygon|arbitrum)\b/i.test(env.EVM_RPC_URL)) {
    throw new Error("EVM_RPC_URL hostname suggests an out-of-scope network.");
  }

  // On mainnet, creation charges no protocol fee: FORMATION_FEE_WEI and
  // TREASURY_SEED_WEI, if set, MUST be 0. The separate token-mint fee is
  // unchanged (must equal 0.05 ETH). Fail closed.
  // (DAO-fee posture is meaningless on bridge-only chains — skipped there.)
  if (MAINNET_CHAIN_IDS.has(chainId) && !bridgeOnly) {
    const fee = (env.FORMATION_FEE_WEI || "").trim();
    if (fee && BigInt(fee) !== BigInt(MAINNET_FORMATION_FEE_WEI)) {
      throw new Error(
        `FORMATION_FEE_WEI ${fee} must equal ${MAINNET_FORMATION_FEE_WEI} ` +
        `(creation charges no protocol fee; gas only). Omit it to default to 0.`,
      );
    }
    const tokenMintFee = (env.TOKEN_MINT_FEE_WEI || "").trim();
    if (!tokenMintFee) {
      throw new Error(
        `TOKEN_MINT_FEE_WEI is required for mainnet deploys. ` +
        `Set it to ${MAINNET_TOKEN_MINT_FEE_WEI} (0.05 ETH). ` +
        `Testnets may omit it (defaults to 0).`,
      );
    }
    if (BigInt(tokenMintFee) !== BigInt(MAINNET_TOKEN_MINT_FEE_WEI)) {
      throw new Error(
        `TOKEN_MINT_FEE_WEI ${tokenMintFee} does not match the canonical mainnet token mint fee ` +
        `${MAINNET_TOKEN_MINT_FEE_WEI} (0.05 ETH). Update MAINNET_TOKEN_MINT_FEE_WEI in ` +
        `evm-mainnet-cutover.mjs if you intentionally want a different amount.`,
      );
    }
    const treasurySeed = (env.TREASURY_SEED_WEI || "").trim();
    if (treasurySeed && BigInt(treasurySeed) !== BigInt(MAINNET_TREASURY_SEED_WEI)) {
      throw new Error(
        `TREASURY_SEED_WEI ${treasurySeed} must equal ${MAINNET_TREASURY_SEED_WEI} ` +
        `(no fee carve-out; creation is fee-free and the user seed is supplied separately). ` +
        `Omit it to default to 0.`,
      );
    }
  }

  // Validate every address-shaped input up front (fail fast before any deploy).
  if (bridgeOnly) {
    requireAddresses(env, ["SAFE_ADDRESS"]);
  } else {
    requireAddresses(env, ["PROTOCOL_OWNER", "PROTOCOL_TREASURY", "PYTH_ADDRESS", "SAFE_ADDRESS"]);
  }

  // Deploy/handoff signer must be configured here, not discovered mid-deploy.
  if (!hasDeploySigner(env)) {
    throw new Error("Set EVM_DEPLOY_PRIVATE_KEY or EVM_DEPLOY_ACCOUNT (deploy + Safe-handoff signer).");
  }

  run("forge", ["--version"]);
  run("cast", ["--version"]);
  verifyRpcChainId(env, chainId);

  // The Safe must be a real deployed contract on this chain BEFORE we ever
  // transfer authority to it — never hand ownership to an EOA/empty address.
  if (!hasOnchainCode(env, env.SAFE_ADDRESS)) {
    throw new Error(
      `SAFE_ADDRESS ${env.SAFE_ADDRESS} has no on-chain bytecode on chain ${chainId}. ` +
        "Authority handoff requires a deployed Safe multisig (cast code != 0x).",
    );
  }
}

function buildAndTest() {
  run("forge", ["build"]);
  // Cutover parent processes often inject STACK_OWNER / STACK_RELAYER into the
  // environment for deploy. Those leak into forge test and break gate tests that
  // assert "STACK_OWNER unset". Strip them for the test invocation only.
  const testEnv = { ...process.env };
  for (const key of [
    "STACK_OWNER",
    "STACK_RELAYER",
    "STACK_SUPPLY_CAP",
    "STACK_PER_TX_CAP",
    "STACK_DAILY_CAP",
  ]) {
    delete testEnv[key];
  }
  run("forge", ["test"], { env: testEnv });
}

function deployArgs(env, chainId) {
  const args = [
    "script",
    "script/Deploy.s.sol:Deploy",
    "--rpc-url",
    env.EVM_RPC_URL,
    "--broadcast",
    "--verify",
  ];
  // chainId is already validated against the RPC in preflight (verifyRpcChainId),
  // so resolve the explorer config from the known chain meta — no redundant re-query.
  args.push(...verifierArgs(env, chainId));
  args.push(...signerArgs(env));
  return args;
}

function refuseNonProductionArtifact(artifact, label) {
  const reason = deploymentWireRefusal(artifact);
  if (!reason) return;
  throw new Error(
    `Refusing to treat ${label} as production (${reason}). ` +
      "Chain 1 DAO stack is undeployed: deployments/1.json is the Anvil fixture. " +
      "Do not broadcast Deploy.s.sol against it and do not reuse its addresses. " +
      "Move the fixture aside only when a real Safe-owned chain-1 deploy will replace it.",
  );
}

function deploy(env, chainId) {
  // The checked-in chain-1 file is an Anvil fixture. Never broadcast while it
  // is the on-disk artifact — a partial forge run would then wire adapters to it.
  refuseNonProductionArtifact(readDeployment(chainId), deploymentPath(chainId));
  // Ensure the artifact destination exists before forge tries to write it.
  mkdirSync(DEPLOYMENTS_DIR, { recursive: true });
  const scriptEnv = {
    PROTOCOL_OWNER: env.PROTOCOL_OWNER,
    PROTOCOL_TREASURY: env.PROTOCOL_TREASURY,
    PYTH_ADDRESS: env.PYTH_ADDRESS,
    FORMATION_FEE_WEI: env.FORMATION_FEE_WEI ?? "0",
    TOKEN_MINT_FEE_WEI: env.TOKEN_MINT_FEE_WEI ?? "0",
    TREASURY_SEED_WEI: env.TREASURY_SEED_WEI ?? "0",
    // Optional override; Deploy.s.sol defaults from NaveAddressRegistry.weth(chainId).
    ...(env.WRAPPED_NATIVE ? { WRAPPED_NATIVE: env.WRAPPED_NATIVE } : {}),
    // Handoff is a separate explicit phase below; never auto-handoff on deploy.
    HANDOFF_TO_SAFE: "false",
  };
  run("forge", deployArgs(env, chainId), { env: scriptEnv });
  const artifact = readDeployment(chainId);
  if (!artifact) throw new Error(`Deploy artifact not written: ${deploymentPath(chainId)}`);
  refuseNonProductionArtifact(artifact, deploymentPath(chainId));
  return artifact;
}

/**
 * Bridge-only scope (default) or Robinhood chains: the `deploy` phase deploys the
 * hardened bridge stack (WrappedNave + NaveBridge lockbox + NaveStaking) instead
 * of the DAO stack. On mainnet, STACK_OWNER defaults to SAFE_ADDRESS (intended
 * final owner recorded in the artifact; constructor owner stays the deploy
 * wallet so minter/cap wiring can run — Safe handoff is `--phase handoff`).
 * Optional env forwarded: STACK_RELAYER, STACK_SUPPLY_CAP, STACK_PER_TX_CAP,
 * STACK_DAILY_CAP.
 */
function deployBridgeStack(env, chainId) {
  mkdirSync(DEPLOYMENTS_DIR, { recursive: true });
  const scriptEnv = {};
  for (const k of ["STACK_RELAYER", "STACK_SUPPLY_CAP", "STACK_PER_TX_CAP", "STACK_DAILY_CAP", "STACK_OWNER"]) {
    if ((env[k] || "").trim()) scriptEnv[k] = env[k];
  }
  // Mainnet: record Safe as intendedOwner (deploy wallet remains owner until handoff).
  if (MAINNET_CHAIN_IDS.has(chainId) && !scriptEnv.STACK_OWNER && (env.SAFE_ADDRESS || "").trim()) {
    scriptEnv.STACK_OWNER = env.SAFE_ADDRESS.trim();
  }
  const args = [
    "script",
    "script/DeployHardenedBridgeStack.s.sol:DeployHardenedBridgeStack",
    "--rpc-url",
    env.EVM_RPC_URL,
    "--broadcast",
    "--verify",
    ...verifierArgs(env, chainId),
    ...signerArgs(env),
  ];
  run("forge", args, { env: scriptEnv });
  const stack = readBridgeStack(chainId);
  if (!stack) throw new Error(`Bridge stack artifact not written: ${bridgeStackPath(chainId)}`);
  return stack;
}

function deploymentPath(chainId) {
  return join(DEPLOYMENTS_DIR, `${chainId}.json`);
}

function readDeployment(chainId) {
  const path = deploymentPath(chainId);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Path + reader for the hardened bridge/staking/token stack artifact. */
function bridgeStackPath(chainId) {
  return join(DEPLOYMENTS_DIR, `hardened-bridge-${chainId}.json`);
}

function readBridgeStack(chainId) {
  const path = bridgeStackPath(chainId);
  if (!existsSync(path)) return null;
  const stack = JSON.parse(readFileSync(path, "utf8"));
  refuseNonProductionArtifact(stack, path);
  return stack;
}

/**
 * Hand the bridge/staking/token contracts to the Safe and enforce the P1
 * audit invariant that the multisig owner is DISTINCT from the hot relayer /
 * rewarder key (otherwise a single key compromise nullifies every cap/pause
 * guardrail — see docs/BRIDGE_STAKING_E2E_AUDIT.md P1).
 *
 * All three contracts (NaveBridge, NaveStaking, WrappedNave) use the two-step
 * `transferOwnership` → Safe `acceptOwnership()` pattern, so this phase only
 * PROPOSES; the Safe finalizes out-of-band. Missing artifact: a full `all` run
 * skips loudly; `--phase handoff` fails closed.
 */
function handoffBridgeAuthority(env, chainId, { explicit, scope }) {
  const stack = readBridgeStack(chainId);
  if (!stack) {
    const msg =
      `Hardened bridge artifact not found: ${bridgeStackPath(chainId)}. ` +
      "Bridge/staking/token ownership was NOT handed off to the Safe.";
    if (explicit && scope !== "full") throw new Error(msg);
    console.warn(`\n  WARNING: ${msg}\n  (Continuing — re-run \`--phase handoff\` once the bridge stack is deployed.)`);
    return null;
  }

  requireEnv(env, ["SAFE_ADDRESS"]);
  requireAddresses(env, ["SAFE_ADDRESS"]);
  const safe = env.SAFE_ADDRESS;
  const signer = signerArgs(env);
  if (!hasOnchainCode(env, safe)) {
    throw new Error(`Refusing bridge handoff: SAFE_ADDRESS ${safe} has no on-chain bytecode on chain ${chainId} (cast code == 0x).`);
  }

  // P1: the Safe (incoming owner) must NOT be the relayer/rewarder hot key.
  const bridgeRelayer = runCapture("cast", ["call", stack.naveBridge, "relayer()(address)", "--rpc-url", env.EVM_RPC_URL], env);
  const stakingRewarder = runCapture("cast", ["call", stack.naveStaking, "rewarder()(address)", "--rpc-url", env.EVM_RPC_URL], env);
  if (bridgeRelayer.toLowerCase() === safe.toLowerCase()) {
    throw new Error(`P1 violation: NaveBridge.relayer == SAFE_ADDRESS ${safe}. The multisig owner must be distinct from the relayer hot key.`);
  }
  if (stakingRewarder.toLowerCase() === safe.toLowerCase()) {
    throw new Error(`P1 violation: NaveStaking.rewarder == SAFE_ADDRESS ${safe}. The multisig owner must be distinct from the rewarder hot key.`);
  }

  const contracts = [
    { name: "NaveBridge", addr: stack.naveBridge },
    { name: "NaveStaking", addr: stack.naveStaking },
    { name: "WrappedNave", addr: stack.wrappedNave },
  ];
  // Live bridge stacks may still be owned by a legacy EOA. On `--scope full`
  // (DAO cutover) skip loudly — do not attempt transferOwnership. On
  // bridge-stake scope, fail closed when explicit so ops know ownership moved.
  const resolvedSigner = (env.PROTOCOL_OWNER || env.EVM_DEPLOY_ACCOUNT || "").trim() || null;

  const pending = {};
  for (const { name, addr } of contracts) {
    if (!addr || !EVM_ADDRESS_RE.test(addr)) throw new Error(`Bridge stack artifact missing a valid ${name} address.`);
    const currentOwner = runCapture("cast", ["call", addr, "owner()(address)", "--rpc-url", env.EVM_RPC_URL], env);
    if (resolvedSigner && currentOwner.toLowerCase() !== resolvedSigner.toLowerCase()) {
      const msg =
        `${name} owner is ${currentOwner}, not the cutover deploy wallet ${resolvedSigner}. ` +
        `Live bridge/staking ownership left unchanged — use the current owner key to propose transferOwnership → ${safe} ` +
        `and set relayer to STACK_RELAYER when ready.`;
      if (explicit && scope !== "full") throw new Error(msg);
      console.warn(`\n  WARNING: ${msg}`);
      return {
        safe,
        skipped: true,
        reason: msg,
        bridgeRelayer,
        stakingRewarder,
        currentOwners: Object.fromEntries(
          contracts.map(({ name: n, addr: a }) => [
            n,
            runCapture("cast", ["call", a, "owner()(address)", "--rpc-url", env.EVM_RPC_URL], env),
          ]),
        ),
      };
    }
    run("cast", ["send", addr, "transferOwnership(address)", safe, "--rpc-url", env.EVM_RPC_URL, ...signer]);
    const p = runCapture("cast", ["call", addr, "pendingOwner()(address)", "--rpc-url", env.EVM_RPC_URL], env);
    if (p.toLowerCase() !== safe.toLowerCase()) {
      throw new Error(`${name} pendingOwner is ${p}, expected Safe ${safe}.`);
    }
    pending[name] = p;
    console.log(`  ${name} pendingOwner -> Safe ${safe} (call acceptOwnership() from the Safe to finalize).`);
  }
  return { safe, pending, bridgeRelayer, stakingRewarder };
}

/**
 * Start the Ownable2Step handoff of UUPS protocol singletons to the Safe.
 * Targets: protocol, factory, oracle, and daoStake (when present). The Safe
 * must call acceptOwnership() on each to finalize — verified in the verify
 * phase as pending transfers. Bridge/WrappedNave/Staking are handled by
 * handoffBridgeAuthority.
 */
function handoffAuthority(env, chainId, artifact) {
  requireEnv(env, ["SAFE_ADDRESS"]);
  requireAddresses(env, ["SAFE_ADDRESS"]);
  const signer = signerArgs(env);

  // Re-check the Safe has bytecode at handoff time too (this phase can run
  // standalone, not just after preflight). Never transfer authority to an
  // EOA/empty address — that would brick protocol ownership irrecoverably.
  if (!hasOnchainCode(env, env.SAFE_ADDRESS)) {
    throw new Error(
      `Refusing handoff: SAFE_ADDRESS ${env.SAFE_ADDRESS} has no on-chain bytecode on chain ${chainId} (cast code == 0x).`,
    );
  }

  const daoStakeFromEnv = (env.DAO_STAKE_MODULE || "").trim();
  let daoStakeAddr = artifact.daoStake || daoStakeFromEnv || null;
  if (!daoStakeAddr && artifact.protocol) {
    try {
      const onModule = runCapture("cast", ["call", artifact.protocol, "daoStake()(address)", "--rpc-url", env.EVM_RPC_URL], env);
      if (onModule && onModule !== "0x0000000000000000000000000000000000000000") {
        daoStakeAddr = onModule;
      }
    } catch { /* older stacks */ }
  }

  const targets = [
    ["protocol", artifact.protocol],
    ["factory", artifact.factory],
    ["oracle", artifact.oracle],
    ["daoStake", daoStakeAddr],
  ].filter(([, addr]) => typeof addr === "string" && addr.startsWith("0x") && addr.length === 42);

  const pending = {};
  const owned = {};
  for (const [name, target] of targets) {
    // Idempotent: skip if already pending/owned by the Safe (re-runs after a
    // partial handoff must not revert OwnableUnauthorizedAccount).
    let currentOwner = null;
    let pendingOwner = null;
    try {
      currentOwner = runCapture("cast", ["call", target, "owner()(address)", "--rpc-url", env.EVM_RPC_URL], env);
    } catch { /* ignore */ }
    try {
      pendingOwner = runCapture("cast", ["call", target, "pendingOwner()(address)", "--rpc-url", env.EVM_RPC_URL], env);
    } catch { /* ignore */ }
    const safeLc = env.SAFE_ADDRESS.toLowerCase();
    if (currentOwner && currentOwner.toLowerCase() === safeLc) {
      console.log(`  ${name} (${target}) already owned by Safe — skipping transferOwnership.`);
      owned[name] = currentOwner;
      continue;
    }
    if (pendingOwner && pendingOwner.toLowerCase() === safeLc) {
      console.log(`  ${name} (${target}) already pendingOwner=Safe — skipping transferOwnership.`);
      pending[name] = pendingOwner;
      continue;
    }
    run("cast", [
      "send",
      target,
      "transferOwnership(address)",
      env.SAFE_ADDRESS,
      "--rpc-url",
      env.EVM_RPC_URL,
      ...signer,
    ]);
    const p = runCapture("cast", ["call", target, "pendingOwner()(address)", "--rpc-url", env.EVM_RPC_URL], env);
    if (p.toLowerCase() !== safeLc) {
      throw new Error(`${name} pendingOwner is ${p}, expected Safe ${env.SAFE_ADDRESS}.`);
    }
    pending[name] = p;
    console.log(`  ${name} pendingOwner -> Safe ${env.SAFE_ADDRESS} (call acceptOwnership() from the Safe to finalize).`);
  }
  if (artifact.protocol && !owned.protocol && !pending.protocol) {
    throw new Error(`Protocol was not handed off to Safe ${env.SAFE_ADDRESS}.`);
  }
  console.log(`\n  UUPS singletons Ownable2Step handoff proposed -> Safe ${env.SAFE_ADDRESS}.`);
  console.log("  Safe must acceptOwnership() on protocol, factory, oracle, daoStake (and bridge stack via bridge handoff).");
  return { safe: env.SAFE_ADDRESS, pending, owned };
}

// Per-chain strategy-adapter constructor-arg env keys (documented in the app
// env schema + docs/MAINNET_PREFLIGHT.md). Only those present are forwarded; the
// adapter deploy script deploys the subset it has addresses for.
const ADAPTERS = [
  {
    name: "Aave v3",
    flag: "DEPLOY_AAVE",
    outputKey: "aaveV3Adapter",
    appSuffix: "AAVE_ADAPTER_ADDRESS",
    required: ["AAVE_V3_POOL"],
  },
  {
    name: "Compound v3",
    flag: "DEPLOY_COMPOUND",
    outputKey: "compoundV3Adapter",
    appSuffix: "COMPOUND_ADAPTER_ADDRESS",
    required: ["COMPOUND_V3_COMET"],
  },
  {
    name: "Balancer",
    flag: "DEPLOY_BALANCER",
    outputKey: "balancerAdapter",
    appSuffix: "BALANCER_ADAPTER_ADDRESS",
    required: ["BALANCER_VAULT", "BALANCER_POOL_ID", "BALANCER_BPT", "BALANCER_ROUTED_ASSET", "BALANCER_ASSET_INDEX", "BALANCER_TOKEN_COUNT"],
  },
];
const ADAPTER_ENV_KEYS = [...new Set(ADAPTERS.flatMap((a) => a.required))];
const ADAPTERS_SCRIPT = "script/DeployAdapters.s.sol:DeployAdapters";
const ADAPTERS_SCRIPT_FILE = join(EVM_CONTRACTS_DIR, "script", "DeployAdapters.s.sol");

/**
 * Deploy the strategy adapters (Aave v3 / Compound v3 / Balancer) for
 * this chain, sequenced AFTER core deploy (needs the protocol address) and
 * BEFORE authority handoff. The Solidity deploy script (DeployAdapters.s.sol)
 * is owned by the contracts agent; this orchestrator only invokes it with the
 * per-chain constructor-arg env vars + the deployed protocol address.
 *
 * If the script file is absent: a full `all` run logs a loud WARNING and skips
 * (so the rest of the cutover still sequences), while an explicit
 * `--phase adapters` fails closed so the operator knows adapters were not run.
 */
function deployAdapters(env, chainId, artifact, { explicit }) {
  if (!existsSync(ADAPTERS_SCRIPT_FILE)) {
    const msg =
      `Adapter deploy script not found: ${ADAPTERS_SCRIPT_FILE}. ` +
      "The contracts agent owns script/DeployAdapters.s.sol; adapters were NOT deployed.";
    if (explicit) throw new Error(msg);
    console.warn(`\n  WARNING: ${msg}\n  (Continuing — re-run \`--phase adapters\` once the script exists.)`);
    return null;
  }
  const selectedAdapters = ADAPTERS.filter((a) => a.required.every((k) => (env[k] || "").trim()));
  const supplied = ADAPTER_ENV_KEYS.filter((k) => (env[k] || "").trim());
  if (selectedAdapters.length === 0) {
    const msg = `No adapter constructor-arg env vars set for chain ${chainId} (e.g. AAVE_V3_POOL, COMPOUND_V3_COMET, BALANCER_*).`;
    if (explicit) throw new Error(msg);
    console.warn(`\n  WARNING: ${msg} Skipping adapter deploy.`);
    return null;
  }
  const partial = ADAPTERS
    .filter((a) => a.required.some((k) => (env[k] || "").trim()) && !a.required.every((k) => (env[k] || "").trim()))
    .map((a) => `${a.name} missing ${a.required.filter((k) => !(env[k] || "").trim()).join(", ")}`);
  if (partial.length) {
    throw new Error(`Incomplete adapter env configuration: ${partial.join("; ")}. Omit the full adapter set or provide all required keys.`);
  }
  requireAddresses(env, ["AAVE_V3_POOL", "COMPOUND_V3_COMET", "BALANCER_VAULT", "BALANCER_BPT", "BALANCER_ROUTED_ASSET"]);

  const scriptEnv = { NAVE_PROTOCOL: artifact.protocol, PROTOCOL_ADDRESS: artifact.protocol, PROTOCOL: artifact.protocol };
  for (const k of supplied) scriptEnv[k] = env[k];
  for (const adapter of selectedAdapters) scriptEnv[adapter.flag] = "true";
  // Adapters run before authority handoff, so the deploy wallet is still
  // protocol owner. Without this, every DAO `updateConstitution` reverts
  // `AdapterNotProtocolApproved` until the Safe submits the allowlist txs.
  scriptEnv.APPROVE_ON_PROTOCOL = "true";

  const args = ["script", ADAPTERS_SCRIPT, "--rpc-url", env.EVM_RPC_URL, "--broadcast", "--verify"];
  args.push(...verifierArgs(env, chainId));
  args.push(...signerArgs(env));
  run("forge", args, { env: scriptEnv });
  console.log(`\n  Strategy adapters deployed for chain ${chainId} (set: ${selectedAdapters.map((a) => a.name).join(", ")}).`);

  // Best-effort read of an adapters artifact if the deploy script writes one.
  const adaptersArtifactPath = join(DEPLOYMENTS_DIR, `adapters-${chainId}.json`);
  if (existsSync(adaptersArtifactPath)) {
    try { return normalizeAdapters(JSON.parse(readFileSync(adaptersArtifactPath, "utf8"))); } catch { /* ignore */ }
  }
  return { deployed: selectedAdapters.map((a) => a.name) };
}

function normalizeAdapters(adapters) {
  if (!adapters || typeof adapters !== "object") return null;
  const out = {};
  const entries = {
    aaveV3: adapters.aaveV3 ?? adapters.aaveV3Adapter ?? adapters.aave,
    compoundV3: adapters.compoundV3 ?? adapters.compoundV3Adapter ?? adapters.compound,
    balancer: adapters.balancer ?? adapters.balancerAdapter,
  };
  for (const [key, val] of Object.entries(entries)) {
    if (typeof val === "string" && EVM_ADDRESS_RE.test(val) && val !== "0x0000000000000000000000000000000000000000") {
      out[key] = val;
    }
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Record a zero required NAVE amount and the moonlight module on NaveProtocol.
 * Calls setNaveStakeConfig(NAVE_STAKE_TOKEN, 0) and setDaoStake(DAO_STAKE_MODULE).
 * Both are onlyOwner, so this MUST run while the deploy wallet is still the
 * owner — BEFORE the Safe handoff. Verifies the config on-chain after writing.
 * REQUIRED_NAVE_STAKE must be 0 or unset. A non-zero value fails closed.
 * Returns null when the token or module env is absent.
 *
 * Env: NAVE_STAKE_TOKEN (wrapped-NAVE ERC-20), REQUIRED_NAVE_STAKE (must be 0),
 * DAO_STAKE_MODULE (NaveDaoStake, so an existing lock can be released).
 */
function configureNaveStake(env, chainId, artifact, { explicit }) {
  const token = (env.NAVE_STAKE_TOKEN || "").trim();
  const amountRaw = (env.REQUIRED_NAVE_STAKE || "").trim();
  const amount = amountRaw === "" ? "0" : amountRaw;
  const module = (env.DAO_STAKE_MODULE || "").trim();
  if (!/^[0-9]+$/.test(amount) || BigInt(amount) !== 0n) {
    throw new Error(
      `REQUIRED_NAVE_STAKE must be 0 or unset (forming a treasury does not require NAVE). Got "${amountRaw}".`,
    );
  }
  if (!token || !module) {
    const msg =
      `NAVE stake module not fully set (NAVE_STAKE_TOKEN + DAO_STAKE_MODULE) for chain ${chainId}. ` +
      "New treasuries already lock nothing. Set the module before handoff so an existing lock can be released.";
    if (explicit) throw new Error(msg);
    console.warn(`\n  WARNING: ${msg}\n  (Continuing — re-run \`--phase stake\` BEFORE handoff once configured.)`);
    return null;
  }
  requireAddresses(env, ["NAVE_STAKE_TOKEN", "DAO_STAKE_MODULE"]);
  if (!hasOnchainCode(env, token)) {
    throw new Error(`NAVE_STAKE_TOKEN ${token} has no on-chain bytecode on chain ${chainId} (cast code == 0x).`);
  }
  const signer = signerArgs(env);

  run("cast", [
    "send", artifact.protocol, "setNaveStakeConfig(address,uint256)", token, amount,
    "--rpc-url", env.EVM_RPC_URL, ...signer,
  ]);
  if (module) {
    if (!hasOnchainCode(env, module)) {
      throw new Error(`DAO_STAKE_MODULE ${module} has no on-chain bytecode on chain ${chainId} (cast code == 0x).`);
    }
    run("cast", [
      "send", artifact.protocol, "setDaoStake(address)", module,
      "--rpc-url", env.EVM_RPC_URL, ...signer,
    ]);
  }

  // Verify on-chain (fail closed) — the cutover must not record a stake that did
  // not actually land.
  const onToken = runCapture("cast", ["call", artifact.protocol, "naveStakeToken()(address)", "--rpc-url", env.EVM_RPC_URL], env);
  const onAmount = runCapture("cast", ["call", artifact.protocol, "requiredNaveStake()(uint256)", "--rpc-url", env.EVM_RPC_URL], env);
  if (onToken.toLowerCase() !== token.toLowerCase()) {
    throw new Error(`setNaveStakeConfig verify failed: on-chain naveStakeToken is ${onToken}, expected ${token}.`);
  }
  // cast may render uint256 as "123 [1.23e2]"; compare the leading integer.
  if (BigInt(onAmount.split(/\s+/)[0]) !== BigInt(amount)) {
    throw new Error(`setNaveStakeConfig verify failed: on-chain requiredNaveStake is ${onAmount}, expected ${amount}.`);
  }
  let onModule = "";
  if (module) {
    onModule = runCapture("cast", ["call", artifact.protocol, "daoStake()(address)", "--rpc-url", env.EVM_RPC_URL], env);
    if (onModule.toLowerCase() !== module.toLowerCase()) {
      throw new Error(`setDaoStake verify failed: on-chain daoStake is ${onModule}, expected ${module}.`);
    }
  }
  console.log(
    `\n  NAVE stake configured on NaveProtocol: token=${token}, requiredStake=${amount}` +
      (module ? `, daoStake=${module}` : " (NaveDaoStake module not set)") + ".",
  );
  return { naveStakeToken: token, requiredNaveStake: amount, daoStake: module || null, stakeTargetUsd: DAO_STAKE_TARGET_USD };
}

function verify(env, chainId, artifact, { scope } = {}) {
  const checks = {};
  // EIP-1967 implementation slot (UUPS / ERC1967Proxy).
  const IMPL_SLOT =
    "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
  for (const [name, addr] of Object.entries(artifact)) {
    if (typeof addr !== "string" || !addr.startsWith("0x") || addr.length !== 42) continue;
    // Skip non-contract metadata fields and implementation address keys — those
    // are the logic contracts, not the live proxies the app calls.
    if (
      name.endsWith("Implementation") ||
      name === "authority" ||
      name === "proxyPattern" ||
      name === "intendedOwner" ||
      name === "relayer"
    ) {
      continue;
    }
    const code = runCapture("cast", ["code", addr, "--rpc-url", env.EVM_RPC_URL], env);
    checks[name] = { address: addr, hasCode: code !== "0x" && code.length > 2 };
    try {
      const slot = runCapture(
        "cast",
        ["storage", addr, IMPL_SLOT, "--rpc-url", env.EVM_RPC_URL],
        env,
      );
      const impl = `0x${slot.replace(/^0x/, "").slice(-40)}`;
      if (impl !== "0x0000000000000000000000000000000000000000") {
        checks[name].eip1967Implementation = impl;
        const implCode = runCapture("cast", ["code", impl, "--rpc-url", env.EVM_RPC_URL], env);
        checks[name].implementationHasCode = implCode !== "0x" && implCode.length > 2;
      }
    } catch {
      /* non-proxy addresses (e.g. tokenDeployer) have no EIP-1967 slot */
    }
  }
  // Surface current/pending owner of the protocol + oracle for the authority
  // audit (absent on bridge-only chains, where no DAO stack exists).
  if (artifact.protocol) {
    try {
      checks.protocolOwner = runCapture("cast", ["call", artifact.protocol, "owner()(address)", "--rpc-url", env.EVM_RPC_URL], env);
      checks.protocolPendingOwner = runCapture("cast", ["call", artifact.protocol, "pendingOwner()(address)", "--rpc-url", env.EVM_RPC_URL], env);
    } catch { /* protocol may not expose pendingOwner pre-deploy */ }
    try {
      const latest = runCapture(
        "cast",
        ["call", artifact.protocol, "latestImplementations()(address,address,address)", "--rpc-url", env.EVM_RPC_URL],
        env,
      );
      checks.latestDaoImplementations = latest;
    } catch { /* older immutable stacks lack the registry */ }
  }
  if (artifact.oracle) {
    try {
      checks.oracleOwner = runCapture("cast", ["call", artifact.oracle, "owner()(address)", "--rpc-url", env.EVM_RPC_URL], env);
    } catch { /* oracle may not be deployed yet */ }
  }
  if (artifact.factory) {
    try {
      checks.factoryOwner = runCapture("cast", ["call", artifact.factory, "owner()(address)", "--rpc-url", env.EVM_RPC_URL], env);
      checks.factoryPendingOwner = runCapture("cast", ["call", artifact.factory, "pendingOwner()(address)", "--rpc-url", env.EVM_RPC_URL], env);
    } catch { /* */ }
  }

  // ── Bridge/staking/token authority audit (P1: owner must != relayer/rewarder) ──
  const stack = readBridgeStack(chainId);
  if (stack) {
    const safe = (env.SAFE_ADDRESS || "").toLowerCase();
    const bridge = {};
    // FAIL CLOSED: when the bridge-stack artifact exists, these readbacks are
    // the P1 audit's inputs. A transient RPC failure must abort the verify
    // phase, not silently skip the owner != relayer/rewarder assertion (a
    // swallowed readback here previously let verify pass vacuously).
    try {
      bridge.naveBridgeOwner = runCapture("cast", ["call", stack.naveBridge, "owner()(address)", "--rpc-url", env.EVM_RPC_URL], env);
      bridge.naveBridgePendingOwner = runCapture("cast", ["call", stack.naveBridge, "pendingOwner()(address)", "--rpc-url", env.EVM_RPC_URL], env);
      bridge.naveBridgeRelayer = runCapture("cast", ["call", stack.naveBridge, "relayer()(address)", "--rpc-url", env.EVM_RPC_URL], env);
      bridge.naveStakingOwner = runCapture("cast", ["call", stack.naveStaking, "owner()(address)", "--rpc-url", env.EVM_RPC_URL], env);
      bridge.naveStakingPendingOwner = runCapture("cast", ["call", stack.naveStaking, "pendingOwner()(address)", "--rpc-url", env.EVM_RPC_URL], env);
      bridge.naveStakingRewarder = runCapture("cast", ["call", stack.naveStaking, "rewarder()(address)", "--rpc-url", env.EVM_RPC_URL], env);
      bridge.wrappedNaveOwner = runCapture("cast", ["call", stack.wrappedNave, "owner()(address)", "--rpc-url", env.EVM_RPC_URL], env);
      bridge.wrappedNavePendingOwner = runCapture("cast", ["call", stack.wrappedNave, "pendingOwner()(address)", "--rpc-url", env.EVM_RPC_URL], env);
    } catch (error) {
      throw new Error(
        `P1 authority readback failed for the bridge stack on chain ${chainId} (${error.message}). ` +
          "Refusing to pass verify without the owner != relayer/rewarder audit — re-run once the RPC responds.",
      );
    }

    // Fail closed on the P1 invariant: the relayer/rewarder hot key must never
    // be the (current or pending) multisig owner. This holds pre- and
    // post-accept because the Safe is never the relayer/rewarder.
    // On `--scope full`, a pre-existing bridge may still have owner==relayer
    // (legacy EOA) while this cutover only ships the DAO stack — surface as a
    // loud warning so DAO verify can complete; bridge-stake scope stays hard-fail.
    const relayer = (bridge.naveBridgeRelayer || "").toLowerCase();
    const rewarder = (bridge.naveStakingRewarder || "").toLowerCase();
    const p1Pending = [];
    for (const [role, addr] of [["relayer", relayer], ["rewarder", rewarder]]) {
      if (addr && safe && addr === safe) {
        throw new Error(`P1 violation (verify): bridge ${role} ${addr} equals SAFE_ADDRESS. Owner and ${role} must be distinct keys.`);
      }
      if (addr && bridge.naveBridgeOwner && addr === bridge.naveBridgeOwner.toLowerCase()) {
        const msg =
          `P1 violation (verify): bridge ${role} ${addr} equals the current NaveBridge owner. ` +
          "Separate the multisig owner from the hot key before mainnet value flows.";
        if (scope === "full") {
          console.warn(`\n  WARNING: ${msg}`);
          p1Pending.push(msg);
        } else {
          throw new Error(msg);
        }
      }
    }
    if (p1Pending.length) bridge.p1Pending = p1Pending;
    checks.bridgeAuthority = bridge;
  }
  return checks;
}

function writeLaunchArtifact(env, chainId, artifact, adapters, naveStake, handoff, verifyChecks, checks) {
  mkdirSync(DEPLOYMENTS_DIR, { recursive: true });
  let gitCommit = "";
  try { gitCommit = runCapture("git", ["rev-parse", "HEAD"], env); } catch { /* not a repo */ }
  const out = {
    generatedAt: new Date().toISOString(),
    gitCommit,
    chain: CHAIN_META[chainId].label,
    chainId,
    explorer: CHAIN_META[chainId].explorer,
    isTestnet: CHAIN_META[chainId].testnet,
    // Record the RPC ORIGIN only: provider URLs routinely embed API keys in the
    // path/query, and the launch artifact is meant to be committed/shared.
    rpcUrl: (() => {
      try {
        return new URL(env.EVM_RPC_URL).origin;
      } catch {
        return "";
      }
    })(),
    addresses: artifact,
    adapters: normalizeAdapters(adapters),
    // New treasuries lock no NAVE. requiredNaveStake is 0. The module, when set,
    // can still release an existing lock.
    naveStake: naveStake ?? null,
    authority: {
      expectedSafe: env.SAFE_ADDRESS ?? "",
      handoff,
    },
    checks,
    verify: verifyChecks,
  };
  const path = join(DEPLOYMENTS_DIR, `evm-launch-${chainId}.json`);
  writeFileSync(path, JSON.stringify(out, null, 2));
  return path;
}

async function main() {
  const args = parseArgs();
  const env = parseEnvFile(args.envPath);
  const chainId = args.chainId;
  const phase = args.phase;
  const runAll = phase === "all";
  const meta = CHAIN_META[chainId];
  const bridgeOnly = isBridgeOnlyScope(chainId, args.scope);
  const checks = { scope: args.scope, preflight: false, build: false, deploy: false, adapters: false, stake: false, handoff: false, verify: false };

  console.log(`\nNave EVM cutover — ${meta.label} (chain ${chainId})${meta.testnet ? " [testnet]" : " [MAINNET]"} scope=${args.scope} phase=${phase}`);

  // Any on-chain phase must bind + verify RPC before forge/cast. `--phase deploy`
  // alone used to skip preflight and could broadcast to the wrong chain when
  // EVM_RPC_URL still pointed at Ethereum (see orphaned-ethereum-duplicate-stack.json).
  const needsRpc = runAll || ["preflight", "deploy", "adapters", "stake", "handoff", "verify"].includes(phase);
  if (needsRpc) {
    resolveRpcForChain(env, chainId);
    verifyRpcChainId(env, chainId);
  }

  if (runAll || phase === "preflight") {
    preflight(env, chainId, args.scope);
    checks.preflight = true;
  }
  if (runAll || phase === "build") {
    buildAndTest();
    checks.build = true;
  }

  // Bridge-only scope: the working artifact is the hardened bridge stack, and
  // adapters/stake phases never run there (already rejected in parseArgs).
  let artifact = bridgeOnly ? readBridgeStack(chainId) : readDeployment(chainId);
  if (!bridgeOnly) {
    const stale = deploymentWireRefusal(artifact);
    if (stale) {
      const usesDaoArtifact = runAll || ["deploy", "adapters", "stake", "handoff", "verify"].includes(phase);
      if (usesDaoArtifact) refuseNonProductionArtifact(artifact, deploymentPath(chainId));
      console.log(
        `\nIgnoring deployments/${chainId}.json (${stale}). ` +
          "That file is not a live DAO stack. Chain 1 remains undeployed until a real artifact replaces the Anvil fixture.",
      );
      console.log(`\nEVM cutover phase complete (phase=${phase}; non-production DAO artifact not wired).`);
      return;
    }
  }
  if (runAll || phase === "deploy") {
    // Re-check immediately before broadcast (defense in depth if env mutated).
    verifyRpcChainId(env, chainId);
    artifact = bridgeOnly ? deployBridgeStack(env, chainId) : deploy(env, chainId);
    checks.deploy = true;
  }

  // preflight/build alone do not need a deploy artifact (and must not fail after
  // a successful RPC/tooling check). Later phases do.
  const needsArtifact = runAll || ["deploy", "adapters", "stake", "handoff", "verify"].includes(phase);
  if (needsArtifact && !artifact) {
    throw new Error(
      bridgeOnly
        ? "No hardened bridge stack artifact found. Run the deploy phase first."
        : "No deployment artifact found. Run the deploy phase first.",
    );
  }
  if (!needsArtifact && !artifact) {
    console.log(`\nEVM cutover phase complete (no on-chain deploy artifact required for phase=${phase}).`);
    return;
  }

  let adapters = null;
  if (!bridgeOnly && (runAll || phase === "adapters")) {
    adapters = deployAdapters(env, chainId, artifact, { explicit: phase === "adapters" });
    checks.adapters = Boolean(adapters);
  }

  // NAVE stake config MUST run before the Safe handoff (onlyOwner).
  let naveStake = null;
  if (!bridgeOnly && (runAll || phase === "stake")) {
    naveStake = configureNaveStake(env, chainId, artifact, { explicit: phase === "stake" });
    checks.stake = Boolean(naveStake);
  }

  let handoff = null;
  if (runAll || phase === "handoff") {
    // DAO protocol/oracle handoff only exists where the DAO stack does.
    handoff = bridgeOnly ? {} : handoffAuthority(env, chainId, artifact);
    // Also hand the bridge/staking/token stack to the Safe (P1). Kept as a
    // separate artifact from the DAO protocol stack. On `--scope full`, a
    // pre-existing live bridge owned by another key is skipped (warn) — DAO
    // handoff must still complete.
    const bridgeHandoff = handoffBridgeAuthority(env, chainId, {
      explicit: phase === "handoff" || bridgeOnly,
      scope: args.scope,
    });
    if (bridgeHandoff) handoff = { ...handoff, bridge: bridgeHandoff };
    checks.handoff = true;
  }

  let verifyChecks = {};
  if (runAll || phase === "verify") {
    verifyChecks = verify(env, chainId, artifact, { scope: args.scope });
    checks.verify = true;
  }

  const launchPath = writeLaunchArtifact(env, chainId, artifact, adapters, naveStake, handoff, verifyChecks, checks);
  console.log(`\nEVM cutover phase complete. Deployment: ${bridgeOnly ? bridgeStackPath(chainId) : deploymentPath(chainId)}`);
  console.log(`Launch artifact: ${launchPath}`);
  console.log("\nApp wiring — set these VITE_EVM_* vars (see nave-app .env.mainnet.cutover.example):");
  console.log("  # Point env at PROXY addresses only (never implementation addresses).");
  console.log("  # Upgrade monitor (Railway evm-indexer): EVM_UPGRADE_PROPOSER_PRIVATE_KEY");
  const SEGMENTS = {
    1: "ETHEREUM", 8453: "BASE", 4663: "ROBINHOOD",
    11155111: "SEPOLIA", 84532: "BASE_SEPOLIA", 46630: "ROBINHOOD_TESTNET",
  };
  const net = SEGMENTS[chainId];
  if (bridgeOnly) {
    // Bridge/staking-only chain — wire the bridge triple, not the DAO stack.
    console.log(`  VITE_EVM_${net}_WRAPPED_NAVE_ADDRESS=${artifact.wrappedNave}`);
    console.log(`  VITE_EVM_${net}_BRIDGE_LOCKBOX_ADDRESS=${artifact.naveBridge}`);
    console.log(`  VITE_EVM_${net}_STAKING_ADDRESS=${artifact.naveStaking}`);
    console.log(`  (signer-service: BRIDGE_EVM_WRAPPED_NAVE_${chainId} / BRIDGE_EVM_LOCKBOX_${chainId} / BRIDGE_EVM_STAKING_${chainId})`);
    return;
  }
  console.log(`  VITE_EVM_${net}_PROTOCOL_ADDRESS=${artifact.protocol}`);
  console.log(`  VITE_EVM_${net}_FACTORY_ADDRESS=${artifact.factory}`);
  if (naveStake) {
    console.log(
      `\n  NAVE stake module: token=${naveStake.naveStakeToken}, ` +
        `requiredStake=${naveStake.requiredNaveStake}` +
        (naveStake.daoStake ? `, daoStake=${naveStake.daoStake}` : ", daoStake=<unset>") +
        ". New treasuries lock nothing.",
    );
  } else {
    console.log(
      "\n  NAVE stake module: NOT configured. New treasuries already lock nothing. " +
        "Run `--phase stake` (NAVE_STAKE_TOKEN + DAO_STAKE_MODULE, REQUIRED_NAVE_STAKE=0) BEFORE handoff " +
        "so an existing lock can be released.",
    );
  }
  const adapterConfig = normalizeAdapters(adapters);
  if (adapterConfig) {
    const adapterHints = [
      ["aaveV3", "AAVE_ADAPTER_ADDRESS"],
      ["compoundV3", "COMPOUND_ADAPTER_ADDRESS"],
      ["balancer", "BALANCER_ADAPTER_ADDRESS"],
    ];
    for (const [key, suffix] of adapterHints) {
      if (adapterConfig[key]) console.log(`  VITE_EVM_${net}_${suffix}=${adapterConfig[key]}`);
    }
  }
}

main().catch((error) => {
  console.error(`\nEVM mainnet cutover failed: ${error.message}`);
  process.exit(1);
});
