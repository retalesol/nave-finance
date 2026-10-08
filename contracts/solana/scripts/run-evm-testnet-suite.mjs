#!/usr/bin/env node
/**
 * Live EVM testnet E2E runner (Sepolia 11155111 / Base Sepolia 84532).
 *
 * Usage:
 *   node scripts/run-evm-testnet-suite.mjs --chain-id 11155111
 *   node scripts/run-evm-testnet-suite.mjs --chain-id 84532 --live
 *
 * Without --live, runs TestnetE2E in skip mode (forge green). With --live,
 * sets EVM_TESTNET_LIVE=1 and broadcasts against the forked RPC.
 */
import { spawnSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const EVM_ROOT = resolve(ROOT, "..", "evm");
const REPORT_DIR = resolve(ROOT, "..", "test-results");

const CHAIN_DEFAULT_RPC = {
  11155111: "https://sepolia.drpc.org",
  84532: "https://base-sepolia.drpc.org",
};

const CHAIN_RPC_ENV = {
  11155111: ["EVM_SEPOLIA_RPC_URL", "ETH_SEPOLIA_RPC_URL", "VITE_EVM_SEPOLIA_RPC_URL"],
  84532: ["EVM_BASE_SEPOLIA_RPC_URL", "BASE_SEPOLIA_RPC_URL", "VITE_EVM_BASE_SEPOLIA_RPC_URL"],
};

function parseArgs() {
  const args = process.argv.slice(2);
  let chainId = 11155111;
  let live = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--chain-id" && args[i + 1]) chainId = Number(args[++i]);
    if (args[i] === "--live") live = true;
  }
  return { chainId, live };
}

function loadDotenvLocal() {
  const paths = [
    resolve(EVM_ROOT, ".env.testnet.local"),
    resolve(ROOT, ".env.testnet.local"),
  ];
  for (const p of paths) {
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m || line.trim().startsWith("#")) continue;
      let v = m[2].trim().replace(/^["']|["']$/g, "");
      if (v && !process.env[m[1]]) process.env[m[1]] = v;
    }
  }
}

function resolveRpc(chainId) {
  const keys = CHAIN_RPC_ENV[chainId] || [];
  for (const k of keys) {
    if (process.env[k]?.trim()) return process.env[k].trim();
  }
  if (process.env.EVM_TESTNET_RPC_URL?.trim()) return process.env.EVM_TESTNET_RPC_URL.trim();
  return CHAIN_DEFAULT_RPC[chainId] || "";
}

function loadPrivateKey() {
  if (process.env.EVM_DEPLOY_PRIVATE_KEY?.trim()) {
    const raw = process.env.EVM_DEPLOY_PRIVATE_KEY.trim();
    return raw.startsWith("0x") ? raw.slice(2) : raw;
  }
  const walletRel =
    process.env.EVM_DEPLOY_WALLET_JSON?.trim() || "evm-deploy-wallet.json";
  const walletPath = resolve(EVM_ROOT, walletRel);
  if (!existsSync(walletPath)) {
    console.error(`Deploy wallet not found: ${walletPath}`);
    process.exit(1);
  }
  const text = readFileSync(walletPath, "utf8").trim();
  if (text.startsWith("[")) {
    const bytes = JSON.parse(text);
    return Buffer.from(bytes).toString("hex");
  }
  const hex = text.replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    console.error(`Unrecognized wallet format in ${walletPath}`);
    process.exit(1);
  }
  return hex;
}

async function jsonRpc(url, method, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message || JSON.stringify(body.error));
  return body.result;
}

function loadDeployments(chainId) {
  const depPath = resolve(EVM_ROOT, `deployments/${chainId}.json`);
  const adpPath = resolve(EVM_ROOT, `deployments/adapters-${chainId}.json`);
  if (!existsSync(depPath)) {
    console.error(`Missing ${depPath}`);
    process.exit(1);
  }
  const dep = JSON.parse(readFileSync(depPath, "utf8"));
  const adapters = existsSync(adpPath) ? JSON.parse(readFileSync(adpPath, "utf8")) : {};
  return { dep, adapters };
}

function aaveUsdcForChain(chainId) {
  if (chainId === 11155111) return "0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8";
  if (chainId === 84532) return "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f";
  return "";
}

function usdcForChain(chainId, strategy) {
  if (strategy?.protocolId === "aave-v3") return aaveUsdcForChain(chainId);
  if (chainId === 11155111) return "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
  if (chainId === 84532) return "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f";
  return "";
}

const ZERO = "0x0000000000000000000000000000000000000000";

const SEPOLIA_AAVE_FAUCET = "0xC959483DBa39aa9E78757139af0e9a2EDEb3f42D";
const BASE_SEPOLIA_AAVE_FAUCET = "0xD9145b5F45Ad4519c7ACcD6E0A4A82e83bB8A6Dc";

function strategyForChain(chainId, adapters) {
  // Sepolia Aave v3 USDC reserve is frequently at supply cap (revert 51); live E2E
  // uses Compound + Circle USDC unless EVM_TESTNET_FORCE_AAVE=true.
  if (
    chainId === 11155111 &&
    process.env.EVM_TESTNET_FORCE_AAVE !== "true" &&
    adapters.compoundV3Adapter &&
    adapters.compoundV3Adapter !== ZERO
  ) {
    return { adapter: adapters.compoundV3Adapter, protocolId: "compound-v3" };
  }
  if (adapters.aaveV3Adapter && adapters.aaveV3Adapter !== ZERO) {
    return { adapter: adapters.aaveV3Adapter, protocolId: "aave-v3" };
  }
  if (
    chainId === 11155111 &&
    adapters.compoundV3Adapter &&
    adapters.compoundV3Adapter !== ZERO
  ) {
    return { adapter: adapters.compoundV3Adapter, protocolId: "compound-v3" };
  }
  return { adapter: ZERO, protocolId: "" };
}

async function ensureAaveUsdc(chainId, rpc, pkHex, deployer, minRaw = 5_000_000n) {
  const usdc = aaveUsdcForChain(chainId);
  const balHex = await jsonRpc(rpc, "eth_call", [
    { to: usdc, data: `0x70a08231${deployer.slice(2).padStart(64, "0")}` },
    "latest",
  ]);
  const bal = BigInt(balHex);
  if (bal >= minRaw) {
    console.log(`  ✓ Aave USDC balance ${bal}`);
    return true;
  }
  const faucet = chainId === 11155111 ? SEPOLIA_AAVE_FAUCET : BASE_SEPOLIA_AAVE_FAUCET;
  const mintAmount = 10_000_000n;
  console.log(`  Minting ${mintAmount} Aave USDC via faucet ${faucet}...`);
  const r = spawnSync(
    "cast",
    [
      "send",
      faucet,
      "mint(address,address,uint256)",
      usdc,
      deployer,
      mintAmount.toString(),
      "--rpc-url",
      rpc,
      "--private-key",
      `0x${pkHex}`,
    ],
    { encoding: "utf8" },
  );
  if (r.status !== 0) {
    console.warn(`  WARN: Aave faucet mint failed:\n${r.stderr || r.stdout}`);
    return false;
  }
  const balAfter = BigInt(
    await jsonRpc(rpc, "eth_call", [
      { to: usdc, data: `0x70a08231${deployer.slice(2).padStart(64, "0")}` },
      "latest",
    ]),
  );
  console.log(`  ✓ Aave USDC after mint: ${balAfter}`);
  return balAfter >= minRaw;
}

async function preflight(chainId, rpc, factory, pkHex) {
  const expectedHex = chainId === 11155111 ? "0xaa36a7" : "0x14a34";
  const chainIdRaw = await jsonRpc(rpc, "eth_chainId", []);
  if (chainIdRaw?.toLowerCase() !== expectedHex) {
    console.error(`FAIL: RPC chainId ${chainIdRaw} != ${expectedHex}`);
    process.exit(2);
  }
  console.log(`  ✓ eth_chainId ${chainIdRaw}`);

  const code = await jsonRpc(rpc, "eth_getCode", [factory, "latest"]);
  if (!code || code === "0x" || code === "0x0") {
    console.error(`FAIL: no bytecode at factory ${factory}`);
    process.exit(2);
  }
  console.log(`  ✓ factory bytecode at ${factory}`);

  const deployerResult = spawnSync("cast", ["wallet", "address", "--private-key", `0x${pkHex}`], {
    encoding: "utf8",
  });
  const deployer = deployerResult.status === 0 ? deployerResult.stdout.trim() : null;
  if (deployer) {
    const bal = await jsonRpc(rpc, "eth_getBalance", [deployer, "latest"]);
    const eth = Number(BigInt(bal)) / 1e18;
    console.log(`  ✓ deployer ${deployer} balance ${eth.toFixed(4)} ETH`);
    if (eth < 0.01) console.warn("WARN: low ETH — fund deployer for gas");
  }
}

async function main() {
  loadDotenvLocal();
  const { chainId, live } = parseArgs();
  const rpc = resolveRpc(chainId);
  if (!rpc) {
    console.error(`No RPC for chain ${chainId}. Set EVM_SEPOLIA_RPC_URL or EVM_BASE_SEPOLIA_RPC_URL`);
    process.exit(1);
  }

  const pkHex = loadPrivateKey();
  const pkDecimal = BigInt("0x" + pkHex).toString();
  const { dep, adapters } = loadDeployments(chainId);
  const strat = strategyForChain(chainId, adapters);
  const usdc = usdcForChain(chainId, strat);
  const aaveAdapter = adapters.aaveV3Adapter || process.env.AAVE_V3_ADAPTER || "";

  console.log(`\n=== EVM testnet suite chainId=${chainId} live=${live} ===\n`);
  const skipBaseLive =
    chainId === 84532 &&
    live &&
    String(process.env.EVM_TESTNET_SKIP_BASE_SEPOLIA ?? "true").toLowerCase() !== "false";
  if (skipBaseLive) {
    console.log(
      "SKIP: Base Sepolia live E2E — Foundry cannot fork OP Isthmus blocks yet.",
    );
    console.log("Set EVM_TESTNET_SKIP_BASE_SEPOLIA=false to force (likely panics).\n");
    const report = {
      suite: "evm-testnet",
      chainId,
      live,
      skipped: true,
      skipReason: "foundry-op-isthmus-fork",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      exitCode: 0,
      treasury: null,
      ok: true,
      outputTail: "skipped: Base Sepolia live fork unsupported in current Foundry build",
    };
    mkdirSync(REPORT_DIR, { recursive: true });
    writeFileSync(resolve(REPORT_DIR, `evm-testnet-${chainId}.json`), JSON.stringify(report, null, 2));
    process.exit(0);
  }
  console.log(`  USDC: ${usdc}`);
  console.log(`  Strategy: ${strat.protocolId} @ ${strat.adapter}\n`);
  await preflight(chainId, rpc, dep.factory, pkHex);

  if (live && strat.protocolId === "aave-v3") {
    const deployerResult = spawnSync("cast", ["wallet", "address", "--private-key", `0x${pkHex}`], {
      encoding: "utf8",
    });
    const deployer = deployerResult.stdout?.trim();
    if (deployer) await ensureAaveUsdc(chainId, rpc, pkHex, deployer);
  }

  const forkBlock =
    process.env.EVM_TESTNET_FORK_BLOCK?.trim() ||
    (chainId === 84532 ? "42000000" : "");

  const forgeArgs = ["test", "--match-contract", "TestnetE2E", "-vvv", "--fork-url", rpc];
  if (forkBlock) forgeArgs.push("--fork-block-number", forkBlock);

  const env = {
    ...process.env,
    EVM_TESTNET_RPC_URL: rpc,
    EVM_TESTNET_CHAIN_ID: String(chainId),
    EVM_TESTNET_LIVE: live ? "true" : "false",
    EVM_DEPLOY_PRIVATE_KEY: pkDecimal,
    NAVE_FACTORY_ADDRESS: dep.factory,
    NAVE_TESTNET_USDC: usdc,
    AAVE_V3_ADAPTER: aaveAdapter,
    STRATEGY_ADAPTER: strat.adapter,
    STRATEGY_PROTOCOL_ID: strat.protocolId,
  };

  const startedAt = new Date().toISOString();
  const result = spawnSync("forge", forgeArgs, {
    cwd: EVM_ROOT,
    encoding: "utf8",
    env,
    maxBuffer: 30 * 1024 * 1024,
  });

  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  if (
    chainId === 84532 &&
    (result.status ?? 1) !== 0 &&
    output.includes("operator fee scalar")
  ) {
    console.error(
      "\nBase Sepolia fork failed: Foundry OP Isthmus operator-fee handling is not supported in this forge build.",
    );
    console.error("Workaround: upgrade Foundry when a fix is available, or run Aave live E2E on Sepolia with EVM_TESTNET_FORCE_AAVE=true once the pool has supply headroom.\n");
  }
  const treasuryMatch = output.match(/E2E_DAO_TREASURY=\s*(0x[a-fA-F0-9]{40})/);

  const report = {
    suite: "evm-testnet",
    chainId,
    live,
    startedAt,
    finishedAt: new Date().toISOString(),
    exitCode: result.status ?? 1,
    treasury: treasuryMatch ? treasuryMatch[1] : null,
    ok: (result.status ?? 1) === 0,
    outputTail: output.split("\n").slice(-50).join("\n"),
  };

  mkdirSync(REPORT_DIR, { recursive: true });
  const reportPath = resolve(REPORT_DIR, `evm-testnet-${chainId}.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(output);
  console.log(`\nWrote ${reportPath}`);
  process.exit(report.ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
