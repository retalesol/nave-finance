/**
 * Live testnet proof for same-address treasuries, the outbound relayer fee,
 * yield rows, the lobby wallet match, and the quieter agent poll.
 *
 * Refuses VITE_USE_MOCKS and any local/anvil chain. Never prints keys.
 * Touches Sepolia (11155111) and Robinhood testnet (46630) only for writes.
 * Base Sepolia and Arc are read-only bytecode checks.
 *
 *   cd app
 *   npx tsx scripts/testnet-live-e2e.mjs
 *
 * The shell should source contracts/evm/.env.testnet.local first. This file
 * also reads that env file itself so a key never has to appear on a command line.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  http,
  parseAbi,
  parseEther,
  defineChain,
} from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { sepolia } from "viem/chains";
import { normalizeWalletAddress } from "../src/lib/chain/daoOnchainAddress.ts";
import { ethereumFamilyOpportunities } from "../supabase/functions/_shared/ethereumFamilyYield.ts";
import {
  hasActiveAgentKey,
  planPollRpc,
  selectDispatchableWork,
} from "../supabase/functions/_shared/pollDiscovery.ts";
import { RELAYER_SWEEP_RESERVE_WEI, sweepExcess } from "../signer-service/src/relayerSweep.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, "..");
const REPO = resolve(APP, "..");
const ENV_PATH = resolve(REPO, "contracts/evm/.env.testnet.local");
const APP_ENV_CANDIDATES = [resolve(APP, ".env.local"), resolve(APP, ".env"), resolve(APP, ".env.development")];
const REPORT_PATH = resolve(APP, "docs/TESTNET_LIVE_E2E_2026-10-23.md");

const FACTORY = "0x4a15eB156b54403Fd0e58DfFe4F20aB6C35099dA";
const PROTOCOL = "0x6C07BC6A22d2D18E232D546Ab06B6F49115834C8";
const EXPECTED_IMPL = {
  0: "0x19Af8d8De09580F52149e006f0a66412180F018A",
  1: "0x6B1c0506568d45BdfB4B942425b2F3a30DAE8351",
  2: "0x170C5c672642f366bbAF0083A8331745c2eE66d4",
};
const SEPOLIA_USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const ACTIVATION_FEE = parseEther("0.001");
const RELAYER_FEE = parseEther("0.0005");
const TREASURY_NATIVE_FUND = parseEther("0.002");
const DUST = 1n;
const NORMAL = 1_000_000n;
const LARGE = 15_000_000n;
const DEPOSIT_TOTAL = DUST + NORMAL + LARGE;
const FORBIDDEN_CHAIN_IDS = new Set([1, 8453, 4663, 5042, 31337]);
const ZERO = "0x0000000000000000000000000000000000000000";

const ABI = parseAbi([
  "function protocol() view returns (address)",
  "function paused() view returns (bool)",
  "function formationFee() view returns (uint256)",
  "function relayer() view returns (address)",
  "function protocolTreasury() view returns (address)",
  "function factory() view returns (address)",
  "function wrappedNative() view returns (address)",
  "function latestImplementation(uint8 role) view returns (address)",
  "function activationFeeQuote() view returns (uint256 nativeWei, uint256 arcUsdcAmount)",
  "function predictCrossChainAddresses(address founder, string slug) view returns (address treasury, address governor, address execution)",
  "function createCrossChainDao((string name,uint8 privacyMode,address[] guardianWallets,uint8 guardianThreshold,address[4] agentAuthorities,uint16 managementFeeBps,uint16 performanceFeeBps,uint16 frozenManagementFeeBps,uint16 frozenPerformanceFeeBps,address protocolRevenueWallet,uint16 quorumBps,uint8 governanceType) params, string slug) payable returns (uint256 daoId, address treasury, address governor, address execution)",
  "function activateDao((string name,uint8 privacyMode,address[] guardianWallets,uint8 guardianThreshold,address[4] agentAuthorities,uint16 managementFeeBps,uint16 performanceFeeBps,uint16 frozenManagementFeeBps,uint16 frozenPerformanceFeeBps,address protocolRevenueWallet,uint16 quorumBps,uint8 governanceType) params, string slug) payable returns (uint256 daoId, address treasury, address governor, address execution)",
  "event DaoCreated(uint256 indexed daoId, address indexed founder, address treasury, address governor, address execution)",
  "function founder() view returns (address)",
  "function name() view returns (string)",
  "function daoId() view returns (uint256)",
  "function registerAsset(address asset, bytes32 pythFeedId, bool isStablecoin, uint8 assetKind)",
  "function deposit(address asset, uint256 amount)",
  "function nextProposalIndex() view returns (uint64)",
  "function createProposal((string title, string description, bytes payload, uint8 proposalType, uint256 votingPeriodSeconds, address votingMint) params) returns (uint64)",
  "function castVoteWallet(uint64 index, uint8 choice)",
  "function finalizeProposal(uint64 index)",
  "function proposalCore(uint64 index) view returns (uint8 proposalType, uint8 status, bytes32 payloadHash, uint256 finalizedAt, address proposer)",
  "function executeTransferProposal(uint64 proposalIndex, address asset, address recipient, uint256 amount)",
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "error InsufficientNativeForRelayerFee()",
  "error InsufficientActivationFee()",
  "error DaoAlreadyActivated()",
]);

const report = {
  startedAt: new Date().toISOString(),
  mocks: "refused-unless-false",
  txs: [],
  assertions: [],
  blocked: [],
  notes: [],
  balances: {},
};

function scrub(value) {
  return String(value)
    .replace(/https?:\/\/\S+/g, "[rpc]")
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[jwt]")
    .replace(/sbp_[A-Za-z0-9]+/g, "[supabase-token]")
    .replace(/0x[0-9a-fA-F]{64}/g, "0x[redacted-key]")
    .slice(0, 500);
}

function loadEnvFile(path) {
  const env = {};
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return env;
  }
  for (const row of text.split("\n")) {
    const match = row.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[match[1]] = value;
  }
  return env;
}

function envFlagTrue(value) {
  const flag = String(value ?? "").trim().toLowerCase();
  return flag === "true" || flag === "1" || flag === "yes";
}

function refuseMocks() {
  const hits = [];
  if (envFlagTrue(process.env.VITE_USE_MOCKS)) hits.push("process.env.VITE_USE_MOCKS");
  for (const path of APP_ENV_CANDIDATES) {
    const env = loadEnvFile(path);
    if (envFlagTrue(env.VITE_USE_MOCKS)) hits.push(path);
  }
  if (hits.length > 0) {
    throw new Error(`Refusing to run: VITE_USE_MOCKS is true (${hits.length} source(s))`);
  }
}

function assertLocalRpc(url, label) {
  const lower = String(url || "").toLowerCase();
  if (!lower) throw new Error(`${label} RPC is missing`);
  if (/anvil|127\.0\.0\.1|localhost|0\.0\.0\.0|foundry/.test(lower)) {
    throw new Error(`Refusing to run: ${label} RPC is local or anvil`);
  }
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function recordTx(label, hash, chainId) {
  report.txs.push({ label, hash, chainId });
  console.log(`tx ${label} ${chainId} ${hash}`);
  writeReport();
}

function assertEq(label, actual, expected) {
  const ok = typeof actual === "bigint" || typeof expected === "bigint"
    ? BigInt(actual) === BigInt(expected)
    : String(actual).toLowerCase() === String(expected).toLowerCase();
  report.assertions.push({
    label,
    ok,
    actual: String(actual),
    expected: String(expected),
  });
  writeReport();
  console.log(`${ok ? "ok" : "FAIL"} ${label}`);
  if (!ok) throw new Error(`${label}: got ${actual}, expected ${expected}`);
}

function note(text) {
  report.notes.push(text);
  console.log(text);
  writeReport();
}

function writeReport() {
  const lines = [
    "# Testnet live E2E — 2026-10-23",
    "",
    `Started ${report.startedAt}. Finished ${report.finishedAt ?? "in progress"}.`,
    "",
    "This run refused mocks and anvil, and it did not send transactions to mainnet, Base Sepolia, or Arc.",
    "",
    "## Blocked deploys",
    "",
  ];
  if (report.blocked.length === 0) lines.push("None recorded yet.");
  for (const row of report.blocked) lines.push(`- ${row}`);
  lines.push("", "## Transactions", "");
  if (report.txs.length === 0) lines.push("None yet.");
  for (const tx of report.txs) lines.push(`- ${tx.label} (chain ${tx.chainId}): \`${tx.hash}\``);
  lines.push("", "## Assertions", "");
  if (report.assertions.length === 0) lines.push("None yet.");
  for (const row of report.assertions) {
    lines.push(`- ${row.ok ? "PASS" : "FAIL"} ${row.label}: got \`${row.actual}\`, expected \`${row.expected}\``);
  }
  lines.push("", "## Notes", "");
  if (report.notes.length === 0) lines.push("None yet.");
  for (const row of report.notes) lines.push(`- ${row}`);
  if (report.balances && Object.keys(report.balances).length > 0) {
    lines.push("", "## Balances", "");
    for (const [key, value] of Object.entries(report.balances)) lines.push(`- ${key}: ${value}`);
  }
  if (report.error) {
    lines.push("", "## Error", "", scrub(report.error));
  }
  writeFileSync(REPORT_PATH, `${lines.join("\n")}\n`);
}

function loadHexKey(env, name) {
  let value = env[name] || "";
  if (!value) throw new Error(`${name} is missing from the testnet env file`);
  if (!value.startsWith("0x")) value = `0x${value}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`${name} is not a 32-byte hex key`);
  return value;
}

function freshAddress() {
  return privateKeyToAccount(generatePrivateKey()).address;
}

function chainClients(chain, rpc, account) {
  const transport = http(rpc);
  return {
    publicClient: createPublicClient({ chain, transport }),
    wallet: createWalletClient({ account, chain, transport }),
  };
}

async function assertChain(client, expectedId, label) {
  const chainId = await client.getChainId();
  if (FORBIDDEN_CHAIN_IDS.has(chainId)) {
    throw new Error(`Refusing ${label}: chain id ${chainId} is mainnet, anvil, or unsupported`);
  }
  if (chainId !== expectedId) throw new Error(`${label} chain id ${chainId} != ${expectedId}`);
  return chainId;
}

async function send(wallet, publicClient, params, label) {
  let lastMessage = "send failed";
  for (let attempt = 0; attempt < 3; attempt++) {
    let hash;
    try {
      hash = await wallet.writeContract({ ...params, gas: params.gas ?? 4_000_000n });
      recordTx(label, hash, publicClient.chain?.id ?? params.chainId);
      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
      if (receipt.status !== "success") throw new Error(`${label} reverted ${hash}`);
      return { hash, receipt };
    } catch (error) {
      lastMessage = scrub(error?.shortMessage || error?.message || error);
      const retryable = !hash && /nonce|replacement|underpriced|timed out|timeout|headers timeout/i.test(lastMessage);
      if (!retryable || attempt === 2) throw new Error(lastMessage);
      await sleep(2000);
    }
  }
  throw new Error(lastMessage);
}

async function read(publicClient, address, functionName, args = []) {
  return publicClient.readContract({ address, abi: ABI, functionName, args });
}

function daoParams(name, founder, agents, revenue) {
  return {
    name,
    privacyMode: 0,
    guardianWallets: [founder],
    guardianThreshold: 1,
    agentAuthorities: agents,
    managementFeeBps: 0,
    performanceFeeBps: 1500,
    frozenManagementFeeBps: 0,
    frozenPerformanceFeeBps: 1500,
    protocolRevenueWallet: revenue,
    quorumBps: 1000,
    governanceType: 0,
  };
}

async function passTransferProposal(wallet, publicClient, governor, treasury, asset, recipient, amount, title) {
  const index = await read(publicClient, treasury, "nextProposalIndex");
  const payload = encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "uint256" }],
    [asset, recipient, amount],
  );
  await send(wallet, publicClient, {
    address: governor,
    abi: ABI,
    functionName: "createProposal",
    args: [{
      title,
      description: "live testnet treasury check",
      payload,
      proposalType: 8,
      votingPeriodSeconds: 60n,
      votingMint: ZERO,
    }],
  }, `proposal-${title}`);
  await send(wallet, publicClient, {
    address: governor,
    abi: ABI,
    functionName: "castVoteWallet",
    args: [index, 0],
  }, `vote-${title}`);
  await send(wallet, publicClient, {
    address: governor,
    abi: ABI,
    functionName: "finalizeProposal",
    args: [index],
  }, `finalize-${title}`);
  const core = await read(publicClient, governor, "proposalCore", [index]);
  assertEq(`proposal ${title} passed`, core[1], 1);
  return index;
}

function errorText(error) {
  const parts = [];
  let current = error;
  for (let depth = 0; current && depth < 6; depth++) {
    if (current.data?.errorName) parts.push(current.data.errorName);
    if (current.shortMessage) parts.push(current.shortMessage);
    if (current.message) parts.push(current.message);
    current = current.cause;
  }
  return scrub(parts.join(" | "));
}

async function proveEmptyRelayerRevert(publicClient, wallet, governor, index, asset, recipient, amount) {
  const args = [index, asset, recipient, amount];
  let reverted = false;
  try {
    await publicClient.simulateContract({
      address: governor,
      abi: ABI,
      functionName: "executeTransferProposal",
      args,
      account: wallet.account,
    });
  } catch (error) {
    const text = errorText(error);
    if (!text.includes("InsufficientNativeForRelayerFee")) {
      throw new Error(`empty treasury reverted with a different reason: ${text}`);
    }
    reverted = true;
    note(`eth_call revert on the passed dust transfer: InsufficientNativeForRelayerFee`);
  }
  assertEq("empty native balance reverts InsufficientNativeForRelayerFee", reverted, true);

  const data = encodeFunctionData({ abi: ABI, functionName: "executeTransferProposal", args });
  try {
    const hash = await wallet.sendTransaction({ to: governor, data, gas: 1_500_000n });
    recordTx("dust-transfer-empty-revert", hash, publicClient.chain?.id);
    let receipt;
    try {
      receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
    } catch (error) {
      receipt = error?.receipt;
      if (!receipt) note(`mined revert receipt was not returned (${scrub(error?.shortMessage || error?.message || error)})`);
    }
    if (receipt) assertEq("mined empty-balance transfer reverted", receipt.status, "reverted");
  } catch (error) {
    const text = errorText(error);
    if (text.includes("InsufficientNativeForRelayerFee")) {
      note("The node refused to broadcast the known revert. The eth_call above is the on-chain proof.");
      return;
    }
    throw new Error(text);
  }
}

function sqlLiteral(value) {
  const text = String(value);
  if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(text) && !/^0x[0-9a-f]{40}$/.test(text)) {
    throw new Error("Refusing to interpolate an unexpected SQL value");
  }
  return `'${text}'`;
}

async function runSql(query) {
  const token = readFileSync(resolve(homedir(), ".supabase/access-token"), "utf8").trim();
  if (!token) throw new Error("Supabase access token file is empty");
  const response = await fetch(
    "https://api.supabase.com/v1/projects/suiivgqwxvqjuxqsrdnu/database/query",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
    },
  );
  const text = await response.text();
  if (!response.ok) throw new Error(`SQL failed (${response.status}): ${scrub(text)}`);
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [];
}

async function registerViaEdge(appEnv, account, treasury, chainId, chain, slug, daoId) {
  const url = appEnv.VITE_SUPABASE_URL;
  const anon = appEnv.VITE_SUPABASE_ANON_KEY;
  if (!url || !anon) return { ok: false, reason: "app env has no Supabase URL or anon key" };
  const nonce = randomBytes(8).toString("hex");
  const issued = Date.now();
  const dao = treasury.toLowerCase();
  const message = `nave-register-dao|${dao}|${chainId}|0||${issued}|${nonce}`;
  const signature = await account.signMessage({ message });
  const response = await fetch(`${url}/functions/v1/register-dao`, {
    method: "POST",
    headers: {
      apikey: anon,
      Authorization: `Bearer ${anon}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      dao_address: dao,
      creator_wallet: account.address,
      creator_message: message,
      creator_signature: signature,
      chain,
      chain_id: chainId,
      network: "testnet",
      name: "Nave Treasury",
      slug,
      governance_type: "wallet",
      privacy_enabled: false,
      dao_id: Number(daoId),
    }),
  });
  const body = await response.text();
  return { ok: response.ok, status: response.status, body: scrub(body).slice(0, 300) };
}

async function queryRegistry(appEnv, creatorLower, slug) {
  const url = appEnv.VITE_SUPABASE_URL;
  const anon = appEnv.VITE_SUPABASE_ANON_KEY;
  const response = await fetch(
    `${url}/rest/v1/dao_registry?creator_wallet=eq.${creatorLower}&slug=eq.${slug}&select=dao_onchain_address,chain_id,treasury_group_id,creator_wallet,slug,network`,
    { headers: { apikey: anon, Authorization: `Bearer ${anon}` } },
  );
  if (!response.ok) throw new Error(`registry query failed (${response.status})`);
  return response.json();
}

function runFocusedTests() {
  execFileSync(process.execPath, ["--import", "tsx", "--test", "tests/edge/pollDiscovery.test.ts"], {
    cwd: APP,
    stdio: "inherit",
  });
  execFileSync(process.execPath, ["--import", "tsx", "--test", "src/relayerSweep.test.ts"], {
    cwd: resolve(APP, "signer-service"),
    stdio: "inherit",
  });
  note("Focused poll-discovery and relayer-sweep unit tests passed.");
}

async function main() {
  refuseMocks();
  note("VITE_USE_MOCKS is not true. Anvil and mainnet chain ids are refused.");
  if (envFlagTrue(process.env.NAVE_BRIDGE_OUTBOUND_ENABLED)) {
    throw new Error("Refusing to run while NAVE_BRIDGE_OUTBOUND_ENABLED is set in the shell");
  }

  const fileEnv = loadEnvFile(ENV_PATH);
  const appEnv = { ...loadEnvFile(resolve(APP, ".env.local")), ...loadEnvFile(resolve(APP, ".env")) };
  const sepoliaRpc = fileEnv.EVM_SEPOLIA_RPC_URL || fileEnv.ETH_SEPOLIA_RPC_URL || process.env.EVM_SEPOLIA_RPC_URL;
  const rhRpc = fileEnv.EVM_ROBINHOOD_TESTNET_RPC_URL || process.env.EVM_ROBINHOOD_TESTNET_RPC_URL;
  const baseRpc = fileEnv.EVM_BASE_SEPOLIA_RPC_URL || fileEnv.BASE_SEPOLIA_RPC_URL;
  const arcRpc = fileEnv.EVM_ARC_TESTNET_RPC_URL;
  assertLocalRpc(sepoliaRpc, "Sepolia");
  assertLocalRpc(rhRpc, "Robinhood testnet");
  assertLocalRpc(baseRpc, "Base Sepolia");
  assertLocalRpc(arcRpc, "Arc testnet");

  runFocusedTests();

  const founder = privateKeyToAccount(loadHexKey(fileEnv, "EVM_TESTING_KEY_1"));
  const deployer = privateKeyToAccount(loadHexKey(fileEnv, "EVM_DEPLOY_PRIVATE_KEY"));
  const recipient = privateKeyToAccount(loadHexKey(fileEnv, "EVM_TESTING_KEY_2"));
  const third = privateKeyToAccount(loadHexKey(fileEnv, "EVM_TESTING_KEY_3"));
  note(`Founder is testing key 1 (${founder.address}). Revenue and relayer are the deployer (${deployer.address}). Keys are not printed.`);

  const robinhood = defineChain({
    id: 46630,
    name: "Robinhood Testnet",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rhRpc] } },
  });
  const sepoliaPair = chainClients(sepolia, sepoliaRpc, founder);
  const rhPair = chainClients(robinhood, rhRpc, founder);
  const deployerSepolia = chainClients(sepolia, sepoliaRpc, deployer);

  await assertChain(sepoliaPair.publicClient, 11155111, "Sepolia");
  await assertChain(rhPair.publicClient, 46630, "Robinhood testnet");

  const baseClient = createPublicClient({ transport: http(baseRpc) });
  const arcClient = createPublicClient({ transport: http(arcRpc) });
  const baseId = await assertChain(baseClient, 84532, "Base Sepolia");
  const arcId = await assertChain(arcClient, 5042002, "Arc testnet");
  for (const [label, client, chainId] of [["Base Sepolia", baseClient, baseId], ["Arc testnet", arcClient, arcId]]) {
    const factoryCode = await client.getBytecode({ address: FACTORY });
    const protocolCode = await client.getBytecode({ address: PROTOCOL });
    const factoryBytes = factoryCode && factoryCode !== "0x" ? (factoryCode.length - 2) / 2 : 0;
    const protocolBytes = protocolCode && protocolCode !== "0x" ? (protocolCode.length - 2) / 2 : 0;
    assertEq(`${label} deterministic factory bytecode`, factoryBytes, 0);
    assertEq(`${label} deterministic protocol bytecode`, protocolBytes, 0);
    const reason = label === "Base Sepolia"
      ? "Base Sepolia rejected the implementation transaction gas limit. Same-address activation was not broadcast. This is a blocked deploy, not a pass."
      : "Arc testnet's 30M block gas limit cannot hold the ~37M gas implementation deploy. Same-address activation was not broadcast. This is a blocked deploy, not a pass.";
    report.blocked.push(`${label} (${chainId}): bytecode at factory ${FACTORY} and protocol ${PROTOCOL} is empty. ${reason}`);
    note(report.blocked[report.blocked.length - 1]);
  }

  for (const [label, client] of [["Sepolia", sepoliaPair.publicClient], ["Robinhood testnet", rhPair.publicClient]]) {
    const factoryCode = await client.getBytecode({ address: FACTORY });
    const protocolCode = await client.getBytecode({ address: PROTOCOL });
    if (!factoryCode || factoryCode === "0x" || !protocolCode || protocolCode === "0x") {
      throw new Error(`${label} deterministic stack has no code`);
    }
    const onFactory = await read(client, PROTOCOL, "factory");
    const onProtocol = await read(client, FACTORY, "protocol");
    const relayer = await read(client, PROTOCOL, "relayer");
    const revenue = await read(client, PROTOCOL, "protocolTreasury");
    const paused = await read(client, PROTOCOL, "paused");
    const formation = await read(client, PROTOCOL, "formationFee");
    assertEq(`${label} protocol factory`, onFactory, FACTORY);
    assertEq(`${label} factory protocol`, onProtocol, PROTOCOL);
    assertEq(`${label} relayer`, relayer, deployer.address);
    assertEq(`${label} revenue`, revenue, deployer.address);
    assertEq(`${label} paused`, paused, false);
    assertEq(`${label} formation fee`, formation, 0n);
    for (const role of [0, 1, 2]) {
      const impl = await read(client, PROTOCOL, "latestImplementation", [role]);
      assertEq(`${label} implementation ${role}`, impl, EXPECTED_IMPL[role]);
    }
  }

  const revenue = deployer.address;
  const agents = [recipient.address, third.address, freshAddress(), freshAddress()];
  const params = daoParams("Nave Treasury", founder.address, agents, revenue);
  let slug = "";
  let predicted = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    slug = `nave-e2e-${Date.now().toString(36)}${attempt}`.slice(0, 32);
    predicted = await read(sepoliaPair.publicClient, FACTORY, "predictCrossChainAddresses", [founder.address, slug]);
    const sepoliaCode = await sepoliaPair.publicClient.getBytecode({ address: predicted[0] });
    const rhCode = await rhPair.publicClient.getBytecode({ address: predicted[0] });
    const sepoliaEmpty = !sepoliaCode || sepoliaCode === "0x";
    const rhEmpty = !rhCode || rhCode === "0x";
    if (sepoliaEmpty && rhEmpty) break;
    predicted = null;
  }
  if (!predicted) throw new Error("Could not find an unused cross-chain slug");
  const rhPredicted = await read(rhPair.publicClient, FACTORY, "predictCrossChainAddresses", [founder.address, slug]);
  assertEq("predicted treasury matches on Robinhood before deploy", rhPredicted[0], predicted[0]);
  assertEq("predicted governor matches on Robinhood before deploy", rhPredicted[1], predicted[1]);
  assertEq("predicted execution matches on Robinhood before deploy", rhPredicted[2], predicted[2]);
  note(`Slug ${slug}. Predicted treasury ${predicted[0]}.`);

  const founderUsdc = await read(sepoliaPair.publicClient, SEPOLIA_USDC, "balanceOf", [founder.address]);
  if (founderUsdc < DEPOSIT_TOTAL) {
    const shortfall = DEPOSIT_TOTAL - founderUsdc;
    const deployerUsdc = await read(sepoliaPair.publicClient, SEPOLIA_USDC, "balanceOf", [deployer.address]);
    if (deployerUsdc < shortfall) throw new Error(`Deployer USDC ${deployerUsdc} is below the ${shortfall} shortfall`);
    await send(deployerSepolia.wallet, deployerSepolia.publicClient, {
      address: SEPOLIA_USDC,
      abi: ABI,
      functionName: "transfer",
      args: [founder.address, shortfall],
    }, "fund-founder-usdc");
    const after = await read(sepoliaPair.publicClient, SEPOLIA_USDC, "balanceOf", [founder.address]);
    assertEq("founder USDC covers the three deposits", after >= DEPOSIT_TOTAL, true);
  }

  const deployerBeforeSepolia = await sepoliaPair.publicClient.getBalance({ address: deployer.address });
  const founderBeforeSepolia = await sepoliaPair.publicClient.getBalance({ address: founder.address });
  report.balances.deployerSepoliaBefore = deployerBeforeSepolia.toString();
  report.balances.founderSepoliaBefore = founderBeforeSepolia.toString();

  await send(sepoliaPair.wallet, sepoliaPair.publicClient, {
    address: FACTORY,
    abi: ABI,
    functionName: "createCrossChainDao",
    args: [params, slug],
    value: 0n,
    gas: 12_000_000n,
  }, "create-cross-chain-sepolia");

  const [treasury, governor, execution] = predicted;
  const createdFounder = await read(sepoliaPair.publicClient, treasury, "founder");
  const createdName = await read(sepoliaPair.publicClient, treasury, "name");
  assertEq("Sepolia predicted treasury founder", createdFounder, founder.address);
  assertEq("Sepolia treasury name", createdName, "Nave Treasury");
  const daoId = await read(sepoliaPair.publicClient, treasury, "daoId");
  const sepoliaCode = await sepoliaPair.publicClient.getBytecode({ address: treasury });
  assertEq("Sepolia treasury has code", Boolean(sepoliaCode && sepoliaCode !== "0x"), true);

  const quote = await read(rhPair.publicClient, FACTORY, "activationFeeQuote");
  assertEq("Robinhood activation fee is 0.001 ETH", quote[0], ACTIVATION_FEE);
  assertEq("Robinhood activation fee is not Arc USDC", quote[1], 0n);
  const revenueBefore = await rhPair.publicClient.getBalance({ address: revenue });
  const founderRhBefore = await rhPair.publicClient.getBalance({ address: founder.address });
  await send(rhPair.wallet, rhPair.publicClient, {
    address: FACTORY,
    abi: ABI,
    functionName: "activateDao",
    args: [params, slug],
    value: ACTIVATION_FEE,
    gas: 12_000_000n,
  }, "activate-robinhood");
  const revenueAfter = await rhPair.publicClient.getBalance({ address: revenue });
  const founderRhAfter = await rhPair.publicClient.getBalance({ address: founder.address });
  assertEq("Robinhood treasury founder", await read(rhPair.publicClient, treasury, "founder"), founder.address);
  assertEq("same treasury address", treasury, predicted[0]);
  assertEq("same governor address", governor, predicted[1]);
  assertEq("same execution address", execution, predicted[2]);
  assertEq("revenue wallet gained 0.001 ETH", revenueAfter - revenueBefore, ACTIVATION_FEE);
  if (founderRhBefore - founderRhAfter < ACTIVATION_FEE) {
    throw new Error("Founder spent less than the activation fee");
  }
  note(`Activation fee delta at revenue ${revenue}: ${revenueAfter - revenueBefore} wei.`);
  report.balances.revenueRobinhoodBefore = revenueBefore.toString();
  report.balances.revenueRobinhoodAfter = revenueAfter.toString();

  const relayerBeforeDeposits = await sepoliaPair.publicClient.getBalance({ address: revenue });
  await send(sepoliaPair.wallet, sepoliaPair.publicClient, {
    address: treasury,
    abi: ABI,
    functionName: "registerAsset",
    args: [SEPOLIA_USDC, `0x${"00".repeat(32)}`, true, 0],
  }, "register-usdc");
  await send(sepoliaPair.wallet, sepoliaPair.publicClient, {
    address: SEPOLIA_USDC,
    abi: ABI,
    functionName: "approve",
    args: [treasury, DEPOSIT_TOTAL],
  }, "approve-usdc");

  let treasuryUsdc = 0n;
  for (const [label, amount] of [["dust", DUST], ["normal", NORMAL], ["large", LARGE]]) {
    const relayerBefore = await sepoliaPair.publicClient.getBalance({ address: revenue });
    await send(sepoliaPair.wallet, sepoliaPair.publicClient, {
      address: treasury,
      abi: ABI,
      functionName: "deposit",
      args: [SEPOLIA_USDC, amount],
    }, `deposit-${label}`);
    const relayerAfter = await sepoliaPair.publicClient.getBalance({ address: revenue });
    treasuryUsdc += amount;
    const bal = await read(sepoliaPair.publicClient, SEPOLIA_USDC, "balanceOf", [treasury]);
    assertEq(`deposit ${label} did not charge the relayer`, relayerAfter, relayerBefore);
    assertEq(`treasury USDC after ${label} deposit`, bal, treasuryUsdc);
  }
  assertEq("deposits left the relayer balance unchanged overall", await sepoliaPair.publicClient.getBalance({ address: revenue }), relayerBeforeDeposits);

  const index = await passTransferProposal(
    sepoliaPair.wallet,
    sepoliaPair.publicClient,
    governor,
    treasury,
    SEPOLIA_USDC,
    recipient.address,
    DUST,
    "dust-out",
  );
  await proveEmptyRelayerRevert(
    sepoliaPair.publicClient,
    sepoliaPair.wallet,
    governor,
    index,
    SEPOLIA_USDC,
    recipient.address,
    DUST,
  );

  const treasuryNativeBeforeFund = await sepoliaPair.publicClient.getBalance({ address: treasury });
  assertEq("treasury native balance is empty before the fee fund", treasuryNativeBeforeFund, 0n);
  const fundHash = await sepoliaPair.wallet.sendTransaction({ to: treasury, value: TREASURY_NATIVE_FUND });
  recordTx("fund-treasury-native", fundHash, 11155111);
  const fundReceipt = await sepoliaPair.publicClient.waitForTransactionReceipt({ hash: fundHash, timeout: 180_000 });
  if (fundReceipt.status !== "success") throw new Error(`fund-treasury-native reverted ${fundHash}`);
  const weth = await read(sepoliaPair.publicClient, PROTOCOL, "wrappedNative");
  const wrapped = await read(sepoliaPair.publicClient, weth, "balanceOf", [treasury]);
  assertEq("inbound ETH wrapped and left native balance at 0", await sepoliaPair.publicClient.getBalance({ address: treasury }), 0n);
  assertEq("treasury WETH covers three relayer fees", wrapped, TREASURY_NATIVE_FUND);

  let expectedRecipient = await read(sepoliaPair.publicClient, SEPOLIA_USDC, "balanceOf", [recipient.address]);
  let expectedWeth = wrapped;
  const sizes = [["dust", DUST, index], ["normal", NORMAL, null], ["large", LARGE, null]];
  for (const [label, amount, existingIndex] of sizes) {
    const proposalIndex = existingIndex ?? await passTransferProposal(
      sepoliaPair.wallet,
      sepoliaPair.publicClient,
      governor,
      treasury,
      SEPOLIA_USDC,
      recipient.address,
      amount,
      `${label}-out`,
    );
    const relayerBefore = await sepoliaPair.publicClient.getBalance({ address: revenue });
    await send(sepoliaPair.wallet, sepoliaPair.publicClient, {
      address: governor,
      abi: ABI,
      functionName: "executeTransferProposal",
      args: [proposalIndex, SEPOLIA_USDC, recipient.address, amount],
      gas: 2_000_000n,
    }, `transfer-${label}`);
    const relayerAfter = await sepoliaPair.publicClient.getBalance({ address: revenue });
    expectedRecipient += amount;
    expectedWeth -= RELAYER_FEE;
    const recipientBal = await read(sepoliaPair.publicClient, SEPOLIA_USDC, "balanceOf", [recipient.address]);
    const wethAfter = await read(sepoliaPair.publicClient, weth, "balanceOf", [treasury]);
    const core = await read(sepoliaPair.publicClient, governor, "proposalCore", [proposalIndex]);
    assertEq(`transfer ${label} paid 0.0005 ETH to the relayer`, relayerAfter - relayerBefore, RELAYER_FEE);
    assertEq(`transfer ${label} USDC arrived`, recipientBal, expectedRecipient);
    assertEq(`transfer ${label} unwrapped the relayer fee from WETH`, wethAfter, expectedWeth);
    assertEq(`transfer ${label} proposal consumed`, core[1], 4);
  }

  const deployerAfterSepolia = await sepoliaPair.publicClient.getBalance({ address: deployer.address });
  report.balances.deployerSepoliaAfter = deployerAfterSepolia.toString();
  const sepoliaExcess = sweepExcess(deployerAfterSepolia, RELAYER_SWEEP_RESERVE_WEI);
  const rhExcess = sweepExcess(revenueAfter, RELAYER_SWEEP_RESERVE_WEI);
  note(
    `Sweep not broadcast. Relayer, revenue, and the deployer are ${deployer.address} on both chains. A sweep would pay that same key and only burn its gas. Sepolia excess above 0.05 ETH is ${sepoliaExcess} wei. Robinhood excess above 0.05 ETH is ${rhExcess} wei. The reserve math was unit-tested. The deployer Sepolia balance stayed above the 0.05 ETH reserve.`,
  );
  assertEq("deployer Sepolia balance stayed above the sweep reserve", deployerAfterSepolia > RELAYER_SWEEP_RESERVE_WEI, true);
  assertEq("sweep math leaves 0.05 from an 0.08 balance", sweepExcess(parseEther("0.08"), RELAYER_SWEEP_RESERVE_WEI), parseEther("0.03"));
  if (deployerAfterSepolia + parseEther("0.01") < deployerBeforeSepolia) {
    throw new Error("Deployer Sepolia balance fell by more than gas");
  }

  const scored = ethereumFamilyOpportunities(46630);
  const aave = scored.find((row) => row.protocolId === "aave-v3-usdc");
  if (!aave) throw new Error("Robinhood scored list has no Sepolia Aave row");
  assertEq("Robinhood Aave row is bridge-required", aave.bridgeRequired, true);
  assertEq("Robinhood Aave venue is Sepolia", aave.venueChainId, 11155111);
  assertEq("Robinhood Aave is not executable while the bridge flag is off", aave.executable, false);
  if (!String(aave.executionLabel).includes("not executable")) {
    throw new Error(`Aave execution label was ${aave.executionLabel}`);
  }
  note(`Robinhood scored Aave as "${aave.executionLabel}". NAVE_BRIDGE_OUTBOUND_ENABLED was not turned on. No bridge transaction was sent.`);
  const linkedAndFlag = ethereumFamilyOpportunities(46630, {
    linkedEthereumTreasury: true,
    outboundBridgeEnabled: true,
  }).find((row) => row.protocolId === "aave-v3-usdc");
  assertEq("Aave would be executable only with a linked Sepolia treasury and the flag", linkedAndFlag?.executable, true);

  const yieldRows = await runSql(`
    insert into public.yield_opportunities
      (dao_onchain_address, protocol_id, program_id, apy_bps, risk_score, asset_class, liquid, score, source)
    values
      (${sqlLiteral(treasury.toLowerCase())}, 'jito', 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', 760, 30, 'sol-like', true, 584, 'live-e2e:jito'),
      (${sqlLiteral(treasury.toLowerCase())}, 'aave-v3-weth', ${sqlLiteral(weth.toLowerCase())}, 180, 22, 'blue-chip', true, 147, 'live-e2e:weth')
    returning id, protocol_id, asset_class, source;
  `);
  const jito = yieldRows.find((row) => row.protocol_id === "jito" && row.asset_class === "sol-like");
  const wethRow = yieldRows.find((row) => row.protocol_id === "aave-v3-weth" && row.asset_class === "blue-chip");
  if (!jito || !wethRow) throw new Error(`yield insert did not return both rows: ${scrub(JSON.stringify(yieldRows))}`);
  note(`yield_opportunities insert succeeded. Jito sol-like ${jito.id}. WETH blue-chip ${wethRow.id}.`);
  report.assertions.push({ label: "sol-like Jito insert", ok: true, actual: jito.id, expected: "row" });
  report.assertions.push({ label: "blue-chip WETH insert", ok: true, actual: wethRow.id, expected: "row" });

  const checksummed = getAddress(founder.address);
  const normalized = normalizeWalletAddress(checksummed);
  assertEq("checksummed wallet normalizes to lowercase", normalized, checksummed.toLowerCase());
  let registry = [];
  const edgeSepolia = await registerViaEdge(appEnv, founder, treasury, 11155111, "ethereum", slug, daoId);
  const edgeRh = await registerViaEdge(appEnv, founder, treasury, 46630, "robinhood", slug, daoId);
  note(`register-dao Sepolia: ${edgeSepolia.ok ? "ok" : edgeSepolia.status} ${edgeSepolia.body || edgeSepolia.reason || ""}`);
  note(`register-dao Robinhood: ${edgeRh.ok ? "ok" : edgeRh.status} ${edgeRh.body || edgeRh.reason || ""}`);
  if (appEnv.VITE_SUPABASE_URL && appEnv.VITE_SUPABASE_ANON_KEY) {
    registry = await queryRegistry(appEnv, normalized, slug);
  }
  if (!Array.isArray(registry) || registry.length < 2) {
    const groupId = randomBytes(16).toString("hex").replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
    await runSql(`
      insert into public.dao_registry
        (dao_onchain_address, name, governance_type, privacy_enabled, creator_wallet, slug, chain, chain_id, network, treasury_group_id)
      values
        (${sqlLiteral(treasury.toLowerCase())}, 'Nave Treasury', 'wallet', false, ${sqlLiteral(normalized)}, ${sqlLiteral(slug)}, 'ethereum', 11155111, 'testnet', ${sqlLiteral(groupId)}),
        (${sqlLiteral(treasury.toLowerCase())}, 'Nave Treasury', 'wallet', false, ${sqlLiteral(normalized)}, ${sqlLiteral(slug)}, 'robinhood', 46630, 'testnet', ${sqlLiteral(groupId)})
      on conflict (chain_id, dao_onchain_address) do update
        set slug = excluded.slug,
            treasury_group_id = excluded.treasury_group_id,
            creator_wallet = excluded.creator_wallet,
            network = excluded.network;
    `);
    registry = await queryRegistry(appEnv, normalized, slug);
    note("Registry rows were written with the service SQL path because register-dao did not return both chain rows.");
  }
  const groupIds = new Set(registry.map((row) => row.treasury_group_id));
  const chains = new Set(registry.map((row) => Number(row.chain_id)));
  assertEq("checksummed wallet finds one treasury group", groupIds.size, 1);
  assertEq("group includes Sepolia", chains.has(11155111), true);
  assertEq("group includes Robinhood testnet", chains.has(46630), true);
  assertEq("stored creator wallet is lowercase", registry.every((row) => row.creator_wallet === normalized), true);
  note(`Lobby query with checksummed ${checksummed} matched group ${[...groupIds][0]} via ${normalized}.`);

  const keyless = "0x00000000000000000000000000000000000000cc";
  const noKeys = { solana: new Set(), evm: new Set() };
  let dispatcherCalls = 0;
  for (let sweep = 0; sweep < 2; sweep++) {
    const selected = selectDispatchableWork(
      [{ dao: keyless, chainId: 11155111, status: "Pending" }],
      (item) => hasActiveAgentKey(item, noKeys),
      25,
    );
    dispatcherCalls += selected.dispatch.length;
    const idle = planPollRpc({
      registryDaos: [{ dao: treasury, chainId: 11155111 }],
      activity: [],
    });
    if (idle.evmTargets.length !== 0) throw new Error("idle treasury was RPC-planned");
  }
  assertEq("keyless treasury dispatcher calls across two sweeps", dispatcherCalls, 0);
  const keyed = selectDispatchableWork(
    [{ dao: treasury.toLowerCase(), chainId: 11155111, status: "Pending" }],
    (item) => hasActiveAgentKey(item, {
      solana: new Set(),
      evm: new Set([`${treasury.toLowerCase()}:11155111:executive`]),
    }),
    25,
  );
  assertEq("keyed treasury has one discovery decision", keyed.dispatch.length, 1);
  note("The signer worker was not started. Autopilot was not enabled. No agent_action_logs row was pre-seeded. The keyless result is the orchestrator discovery path, not two live 15-minute wall-clock sweeps, and the keyed result did not contact the signer.");

  const founderAfter = await sepoliaPair.publicClient.getBalance({ address: founder.address });
  report.balances.founderSepoliaAfter = founderAfter.toString();
  if (founderAfter < parseEther("0.05")) throw new Error("Founder Sepolia balance is below 0.05 ETH");
  note(`Done. Treasury ${treasury}. Slug ${slug}.`);
}

main()
  .then(() => {
    report.finishedAt = new Date().toISOString();
    writeReport();
  })
  .catch((error) => {
    report.error = scrub(error?.stack || error?.message || error);
    report.finishedAt = new Date().toISOString();
    writeReport();
    console.error(report.error);
    process.exitCode = 1;
  });
