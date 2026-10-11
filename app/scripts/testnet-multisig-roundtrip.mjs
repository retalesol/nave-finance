/**
 * Pre-GenLayer multi-guardian round trip.
 * Founder (deployer) creates and funds the treasury. Three testing keys are the
 * guardians. The four agent keys are derived from the deployer key, because an
 * agent key may not be the founder or a guardian. One yes vote must not
 * finalize. Two yes votes must.
 *
 * Strategy chains supply to the venue, wait for the venue value to pass the
 * deposit, book the on-chain mark, require NAV to rise, then withdraw. Every
 * chain also runs the role-boundary negatives: each agent tries the other
 * roles' actions, zero minOut, forged marks, early and direct execution, and
 * an Executive re-enable after a 2-of-3 guardian disable. All must revert.
 *
 *   node scripts/testnet-multisig-roundtrip.mjs --chain ethereum
 *   node scripts/testnet-multisig-roundtrip.mjs --chain base --yield-wait-mins 150
 *   node scripts/testnet-multisig-roundtrip.mjs --chain all
 *
 * Does not print private keys. GenLayer gates stay off.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeAbiParameters,
  http,
  keccak256,
  parseAbi,
  defineChain,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = resolve(HERE, "../../contracts/evm/.env.testnet.local");
const REPORT_PATH = resolve(HERE, "../test-results/testnet-multisig-report.json");

const ABI = parseAbi([
  "error VotingPeriodNotEnded()",
  "error VotingPeriodEnded()",
  "error GuardianRequired()",
  "error AlreadyVoted()",
  "error Unauthorized()",
  "error AgentsDisabled()",
  "error AgentsLockedByGuardians()",
  "error AgentsDisableRequiresGuardians()",
  "error SlippageBoundRequired()",
  "error ReviewWindowActive()",
  "error InvalidStateTransition()",
  "error DirectExecutionNotAllowed()",
  "error InvalidGuardianThreshold()",
  "error InvalidGuardianSignature()",
  "error GuardianNotFound()",
  "error DuplicateGuardianSignature()",
  "error GuardianActionExpired()",
  "error ProtocolNotApproved()",
  "error PayloadHashMismatch()",
  "error ReasoningHashRequired()",
  "error DaoFrozen()",
  "error GlobalPaused()",
  "error DaoMoonlighting()",
  "error MathOverflow()",
  "function protocol() view returns (address)",
  "function governor() view returns (address)",
  "function execution() view returns (address)",
  "function paused() view returns (bool)",
  "function requiredNaveStake() view returns (uint256)",
  "function naveStakeToken() view returns (address)",
  "function daoStake() view returns (address)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function deposit() payable",
  "function createDao((string name,uint8 privacyMode,address[] guardianWallets,uint8 guardianThreshold,address[4] agentAuthorities,uint16 managementFeeBps,uint16 performanceFeeBps,uint16 frozenManagementFeeBps,uint16 frozenPerformanceFeeBps,address protocolRevenueWallet,uint16 quorumBps,uint8 governanceType) params) payable returns (uint256 daoId, address treasury, address governor, address execution)",
  "event DaoCreated(uint256 indexed daoId, address indexed founder, address treasury, address governor, address execution)",
  "function registerAsset(address asset, bytes32 pythFeedId, bool isStablecoin, uint8 assetKind)",
  "function deposit(address asset, uint256 amount)",
  "function currentNav() view returns (uint256)",
  "function assetInfo(address asset) view returns (bool registered, bool enabled, bool isStablecoin, uint8 assetKind, bytes32 pythFeedId, uint8 decimals)",
  "function updateConstitution(address[] adapters, uint16[] maxAllocationBps, bool[] approved, string[] protocolIds, uint8 newConfidenceThreshold, uint256 agentThresholdUsd)",
  "function toggleAgents(bool enabled)",
  "function revalueTreasury()",
  "function nextProposalIndex() view returns (uint64)",
  "function createProposal((string title, string description, bytes payload, uint8 proposalType, uint256 votingPeriodSeconds, address votingMint) params) returns (uint64)",
  "function castVoteWallet(uint64 index, uint8 choice)",
  "function finalizeProposal(uint64 index)",
  "function proposalCore(uint64 index) view returns (uint8 proposalType, uint8 status, bytes32 payloadHash, uint256 finalizedAt, address proposer)",
  "function createStrategyRequestBootstrap(uint64 proposalIndex, uint256 amount, address adapter, address asset)",
  "function createStrategyRequest(uint64 proposalIndex, uint256 amount, address adapter, address asset)",
  "function executeDirect(uint64 index, uint256 minOut)",
  "function operationalHalt(uint64 index, bytes32 reasonHash)",
  "function syncPositionValue(address adapter) returns (uint256)",
  "function syncPositionValue(address adapter, uint256 observed) returns (uint256)",
  "function positionValue(address asset) view returns (uint256)",
  "function position(address adapter) view returns (address asset, uint256 depositedAmount, uint256 currentValue)",
  "function agentsEnabled() view returns (bool)",
  "function agentsGuardianLocked() view returns (bool)",
  "function guardianAction((uint8 actionType, uint8 slot, uint8 newStatus, address newKey, uint64 nonce, uint64 deadline) params, bytes[] signatures)",
  "function executiveApprove(uint64 index, bytes32 reasoningHash)",
  "function financialApprove(uint64 index, bytes32 txPayloadHash, bytes32 reasoningHash)",
  "function oversightApprove(uint64 index, bytes32 txPayloadHash, bytes32 reasoningHash)",
  "function execute(uint64 index, uint256 minOut)",
  "function withdrawFromStrategy(uint64 index, uint256 amount, uint256 minOut)",
  "function requestStatus(uint64 index) view returns (uint8)",
  "function executeTransferProposal(uint64 proposalIndex, address asset, address recipient, uint256 amount)",
  "function comet() view returns (address)",
  "function aTokenFor(address asset) view returns (address)",
]);

const REASONING = `0x${"ab".repeat(32)}`;
const ZERO = "0x0000000000000000000000000000000000000000";
const VOTING_PERIOD = 3600n;
const QUORUM_BPS = 3500;

const CHAINS = {
  ethereum: {
    chainId: 11155111,
    rpc: "https://ethereum-sepolia-rpc.publicnode.com",
    factory: "0x4F01c9616A48F14009EC083Ff4bb6e47EdDE0890",
    name: "msig-sepolia",
    agentGas: 2_000_000_000_000_000n,
    mode: "strategy",
    asset: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    assetKind: 0,
    deposit: 30_000_000n,
    deploy: 15_000_000n,
    adapter: "0x845d8310A861A95Ed1644643D1BAe086944B1AA0",
    protocolId: "compound-v3",
    venue: "comet",
  },
  "ethereum-aave": {
    chainId: 11155111,
    rpc: "https://ethereum-sepolia-rpc.publicnode.com",
    factory: "0x4F01c9616A48F14009EC083Ff4bb6e47EdDE0890",
    name: "msig-sepolia-aave",
    agentGas: 2_000_000_000_000_000n,
    mode: "strategy",
    asset: "0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8",
    assetKind: 0,
    deposit: 30_000_000n,
    deploy: 15_000_000n,
    adapter: "0xFfFDfc7DEfbfaF64c232897452Aa6E6F92809426",
    protocolId: "aave",
    venue: "aave",
  },
  base: {
    chainId: 84532,
    rpc: "https://sepolia.base.org",
    factory: "0xF53dE95ae1Fed92FFd9C9305E1716FD48EFcB776",
    name: "msig-base",
    agentGas: 500_000_000_000_000n,
    mode: "strategy",
    asset: "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f",
    assetKind: 0,
    deposit: 2_000_000_000n,
    deploy: 1_000_000_000n,
    adapter: "0x33D19799EBac88FFDc4e5BF61c199c71963470A6",
    protocolId: "aave",
    venue: "aave",
  },
  arc: {
    chainId: 5042002,
    rpc: "https://rpc.testnet.arc.network",
    factory: "0xa7bd919a5249DD1Da6E02a6716D2Db2B2e0A99f0",
    name: "msig-arc",
    agentGas: 300_000_000_000_000_000n,
    mode: "transfer",
    asset: "0x3600000000000000000000000000000000000000",
    deposit: 2_000_000n,
    transfer: 500_000n,
  },
  robinhood: {
    chainId: 46630,
    rpc: "https://rpc.testnet.chain.robinhood.com",
    factory: "0x303cE551De723cad43e1575C4D981C0E2b662b7F",
    name: "msig-rh",
    agentGas: 1_000_000_000_000_000n,
    mode: "policy",
    weth: "0x7943e237c7F95DA44E0301572D358911207852Fa",
    wrap: 1_000_000_000_000_000n,
  },
};

function loadEnvFile() {
  const env = {};
  for (const row of readFileSync(ENV_PATH, "utf8").split("\n")) {
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

const FILE_ENV = loadEnvFile();

function rpcFrom(names, fallback) {
  for (const name of names) {
    const value = (process.env[name] || FILE_ENV[name] || "").trim();
    if (value) return value;
  }
  return fallback;
}

const RPC_KEYS = {
  ethereum: ["EVM_SEPOLIA_RPC_URL", "ETH_SEPOLIA_RPC_URL"],
  "ethereum-aave": ["EVM_SEPOLIA_RPC_URL", "ETH_SEPOLIA_RPC_URL"],
  base: ["EVM_BASE_SEPOLIA_RPC_URL", "BASE_SEPOLIA_RPC_URL"],
  arc: ["EVM_ARC_TESTNET_RPC_URL"],
  robinhood: ["EVM_ROBINHOOD_TESTNET_RPC_URL"],
};
for (const [name, spec] of Object.entries(CHAINS)) {
  spec.fallbackRpc = spec.rpc;
  spec.rpc = rpcFrom(RPC_KEYS[name], spec.rpc);
}

let fallbackRpc = null;

function asKey(value, label) {
  let hex = value || "";
  if (!hex.startsWith("0x")) hex = `0x${hex}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) throw new Error(`${label} is not a 32-byte hex key`);
  return hex;
}

const AGENT_ROLES = ["executive", "financial", "oversight", "operational"];

// Agent keys may not be the founder, a guardian, or another slot's key, so the
// four agents are derived from the deployer key and never leave this process.
function loadAccounts() {
  const deployKey = asKey(FILE_ENV.EVM_DEPLOY_PRIVATE_KEY, "founder");
  const founder = privateKeyToAccount(deployKey);
  const guardians = [1, 2, 3].map((n) =>
    privateKeyToAccount(asKey(FILE_ENV[`EVM_TESTING_KEY_${n}`], `guardian ${n}`)),
  );
  const agents = AGENT_ROLES.map((role) =>
    privateKeyToAccount(keccak256(`${deployKey}${Buffer.from(`nave-msig-agent-${role}`).toString("hex")}`)),
  );
  return { founder, guardians, agents };
}

async function ensureGas(founderWallet, publicClient, accounts, amount) {
  for (const account of accounts) {
    const balance = await publicClient.getBalance({ address: account.address });
    if (balance >= amount / 2n) continue;
    let hash;
    for (let attempt = 0; ; attempt++) {
      try {
        const nonce = await publicClient.getTransactionCount({
          address: founderWallet.account.address,
          blockTag: "pending",
        });
        hash = await founderWallet.sendTransaction({ to: account.address, value: amount, nonce });
        break;
      } catch (error) {
        // A lagging RPC hands back a used nonce right after the previous top-up.
        if (attempt >= 5 || !/Missing or invalid parameters|nonce/i.test(errorText(error))) throw error;
        await sleep(3000);
      }
    }
    await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
    console.log(`  funded agent ${account.address.slice(0, 8)} ${hash}`);
  }
}

function chainFor(spec) {
  return defineChain({
    id: spec.chainId,
    name: spec.name,
    nativeCurrency: { name: "Native", symbol: spec.chainId === 5042002 ? "USDC" : "ETH", decimals: 18 },
    rpcUrls: { default: { http: [spec.rpc] } },
  });
}

function errorText(error) {
  return [error?.shortMessage, error?.message, error?.cause?.shortMessage, error?.cause?.name]
    .filter(Boolean)
    .join(" ")
    .replace(/https?:\/\/\S+/g, "[rpc]");
}

function sleep(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

// Sepolia runs a newer gas schedule than forge/viem assume, so fixed limits
// under-provision; the node's own estimate is the reliable figure. The floor
// covers a lagging RPC that estimates against a contract it cannot see yet.
const GAS_FLOOR = 2_000_000n;

async function estimateGas(wallet, publicClient, params) {
  let last;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const estimate = await publicClient.estimateContractGas({ ...params, account: wallet.account });
      const padded = (estimate * 13n) / 10n;
      return padded > GAS_FLOOR ? padded : GAS_FLOOR;
    } catch (error) {
      last = error;
      await sleep(3000);
    }
  }
  throw last;
}

async function sendOnce(wallet, publicClient, params) {
  const gas = params.gas ?? (await estimateGas(wallet, publicClient, params));
  const hash = await wallet.writeContract({ ...params, gas });
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (receipt.status !== "success") throw new Error(`transaction reverted: ${hash}`);
  console.log(`  tx ${params.functionName} ${wallet.account.address.slice(0, 8)} ${hash}`);
  return receipt;
}

async function send(wallet, publicClient, params) {
  try {
    return await sendOnce(wallet, publicClient, params);
  } catch (error) {
    if (!fallbackRpc || !/Missing or invalid parameters/i.test(errorText(error))) throw error;
    console.log(`  configured RPC rejected ${params.functionName}; retrying the public endpoint`);
    const transport = http(fallbackRpc);
    const altWallet = createWalletClient({ account: wallet.account, chain: wallet.chain, transport });
    const altPublic = createPublicClient({ chain: wallet.chain, transport });
    return sendOnce(altWallet, altPublic, params);
  }
}

async function read(publicClient, address, functionName, args = []) {
  let last;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await publicClient.readContract({ address, abi: ABI, functionName, args });
    } catch (error) {
      last = error;
      const message = errorText(error);
      if (!message.includes("returned no data") && !message.includes("timeout")) throw error;
      await sleep(1500);
    }
  }
  throw last;
}

async function readUntil(publicClient, address, functionName, args, predicate, label) {
  let last;
  for (let attempt = 0; attempt < 30; attempt++) {
    last = await read(publicClient, address, functionName, args);
    if (predicate(last)) return last;
    await sleep(2000);
  }
  throw new Error(`${label} stayed ${last}`);
}

const boundary = [];

/** Simulates `params` from `wallet` and requires a revert whose error matches `pattern`. */
async function expectRevert(wallet, publicClient, label, params, pattern) {
  let text = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await publicClient.simulateContract({ abi: ABI, ...params, account: wallet.account });
      text = "";
    } catch (error) {
      text = errorText(error);
      if (pattern.test(text)) break;
    }
    // A lagging RPC can still show the previous request state.
    await sleep(2000);
  }
  if (!text) throw new Error(`boundary breach: ${label} succeeded`);
  if (!pattern.test(text)) throw new Error(`${label} reverted for the wrong reason: ${text.slice(0, 240)}`);
  const reason = text.match(pattern)[0];
  boundary.push({ label, reverted: reason });
  console.log(`  blocked: ${label} (${reason})`);
}

const GUARDIAN_ACTION = { DISABLE_AGENTS: 4, ENABLE_AGENTS: 7 };
const GUARDIAN_TYPES = {
  GuardianAction: [
    { name: "actionType", type: "uint8" },
    { name: "agentSlot", type: "uint8" },
    { name: "newStatus", type: "uint8" },
    { name: "newKey", type: "address" },
    { name: "nonce", type: "uint64" },
    { name: "deadline", type: "uint64" },
  ],
};

async function guardianParams(publicClient, signers, treasury, actionType) {
  const block = await publicClient.getBlock();
  const params = {
    actionType,
    slot: 0,
    newStatus: 0,
    newKey: ZERO,
    nonce: BigInt(Date.now()),
    deadline: block.timestamp + 3600n,
  };
  const message = {
    actionType,
    agentSlot: 0,
    newStatus: 0,
    newKey: ZERO,
    nonce: params.nonce,
    deadline: params.deadline,
  };
  const domain = {
    name: "NaveTreasury",
    version: "1",
    chainId: await publicClient.getChainId(),
    verifyingContract: treasury,
  };
  const signatures = await Promise.all(
    signers.map((wallet) =>
      wallet.account.signTypedData({ domain, types: GUARDIAN_TYPES, primaryType: "GuardianAction", message }),
    ),
  );
  return { params, signatures };
}

/**
 * Guardian lock check: 2-of-3 DISABLE_AGENTS, then the Executive cannot turn
 * agents back on, one guardian cannot either, and a 2-of-3 ENABLE_AGENTS does.
 * `whileDisabled` runs extra boundary checks inside the disabled window.
 */
async function guardianLockCycle(wallets, publicClient, dao, whileDisabled) {
  const [executive, financial] = wallets.agents;
  const [g0, g1, g2] = wallets.guardians;
  if (!(await read(publicClient, dao.treasury, "agentsEnabled"))) {
    await send(executive, publicClient, {
      address: dao.treasury,
      abi: ABI,
      functionName: "toggleAgents",
      args: [true],
    });
  }
  for (const [label, wallet] of [["financial agent", financial], ["guardian", g0], ["founder", wallets.founder]]) {
    await expectRevert(wallet, publicClient, `${label} turns agents on`, {
      address: dao.treasury,
      functionName: "toggleAgents",
      args: [true],
    }, /Unauthorized/);
  }
  await expectRevert(executive, publicClient, "executive disables agents without guardians", {
    address: dao.treasury,
    functionName: "toggleAgents",
    args: [false],
  }, /AgentsDisableRequiresGuardians/);
  const lone = await guardianParams(publicClient, [g2], dao.treasury, GUARDIAN_ACTION.DISABLE_AGENTS);
  await expectRevert(g2, publicClient, "one guardian disables agents", {
    address: dao.treasury,
    functionName: "guardianAction",
    args: [lone.params, lone.signatures],
  }, /InvalidGuardianThreshold/);
  const forged = await guardianParams(publicClient, [g2, executive], dao.treasury, GUARDIAN_ACTION.DISABLE_AGENTS);
  await expectRevert(g2, publicClient, "guardian plus agent signature disables agents", {
    address: dao.treasury,
    functionName: "guardianAction",
    args: [forged.params, forged.signatures],
  }, /GuardianNotFound/);
  const disable = await guardianParams(publicClient, [g1, g2], dao.treasury, GUARDIAN_ACTION.DISABLE_AGENTS);
  await send(g2, publicClient, {
    address: dao.treasury,
    abi: ABI,
    functionName: "guardianAction",
    args: [disable.params, disable.signatures],
  });
  await readUntil(publicClient, dao.treasury, "agentsGuardianLocked", [], (value) => value === true, "guardian lock");
  console.log("  2 of 3 guardians disabled agents");
  await expectRevert(executive, publicClient, "executive re-enables after guardian disable", {
    address: dao.treasury,
    functionName: "toggleAgents",
    args: [true],
  }, /AgentsLockedByGuardians/);
  await expectRevert(g2, publicClient, "guardian replays the used disable signatures", {
    address: dao.treasury,
    functionName: "guardianAction",
    args: [disable.params, disable.signatures],
  }, /InvalidGuardianSignature/);
  if (whileDisabled) await whileDisabled();
  const loneEnable = await guardianParams(publicClient, [g0], dao.treasury, GUARDIAN_ACTION.ENABLE_AGENTS);
  await expectRevert(g0, publicClient, "one guardian re-enables agents", {
    address: dao.treasury,
    functionName: "guardianAction",
    args: [loneEnable.params, loneEnable.signatures],
  }, /InvalidGuardianThreshold/);
  const enable = await guardianParams(publicClient, [g0, g2], dao.treasury, GUARDIAN_ACTION.ENABLE_AGENTS);
  await send(g0, publicClient, {
    address: dao.treasury,
    abi: ABI,
    functionName: "guardianAction",
    args: [enable.params, enable.signatures],
  });
  await readUntil(publicClient, dao.treasury, "agentsEnabled", [], (value) => value === true, "agents re-enabled");
  console.log("  2 of 3 guardians re-enabled agents");
}

/** Every non-holder of `role` calling `functionName` must hit Unauthorized. */
async function othersBlocked(publicClient, others, address, functionName, args) {
  for (const [roleName, wallet] of others) {
    await expectRevert(wallet, publicClient, `${roleName} calls ${functionName}`, {
      address,
      functionName,
      args,
    }, /Unauthorized/);
  }
}

async function ensureStake() {
  return { required: "0" };
}

async function createDao(founderWallet, publicClient, spec, founder, guardians, agents) {
  const receipt = await send(founderWallet, publicClient, {
    address: spec.factory,
    abi: ABI,
    functionName: "createDao",
    args: [{
      name: spec.name,
      privacyMode: 0,
      guardianWallets: guardians.map((account) => account.address),
      guardianThreshold: 2,
      agentAuthorities: agents.map((account) => account.address),
      managementFeeBps: 0,
      performanceFeeBps: 1500,
      frozenManagementFeeBps: 0,
      frozenPerformanceFeeBps: 1500,
      protocolRevenueWallet: founder,
      quorumBps: QUORUM_BPS,
      governanceType: 0,
    }],
    value: 0n,
  });
  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({ abi: ABI, data: log.data, topics: log.topics });
      if (decoded.eventName === "DaoCreated") {
        for (let attempt = 0; attempt < 30; attempt++) {
          const code = await publicClient.getCode({ address: decoded.args.execution });
          if (code && code !== "0x") break;
          await sleep(2000);
        }
        return {
          daoId: decoded.args.daoId.toString(),
          treasury: decoded.args.treasury,
          governor: decoded.args.governor,
          execution: decoded.args.execution,
          createTx: receipt.transactionHash,
        };
      }
    } catch {
      // not this event
    }
  }
  throw new Error("DaoCreated was not in the create receipt");
}

async function assertOneVoteCannotFinalize(wallet, publicClient, governor, index) {
  try {
    await publicClient.simulateContract({
      address: governor,
      abi: ABI,
      functionName: "finalizeProposal",
      args: [index],
      account: wallet.account,
    });
  } catch (error) {
    const text = errorText(error);
    if (!/VotingPeriodNotEnded/i.test(text)) throw error;
    console.log("  one yes vote cannot close the proposal");
    return;
  }
  throw new Error("a single guardian was able to finalize");
}

async function voteIfNeeded(wallet, publicClient, governor, index) {
  let last;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      await publicClient.simulateContract({
        address: governor,
        abi: ABI,
        functionName: "castVoteWallet",
        args: [index, 0],
        account: wallet.account,
      });
      last = null;
      break;
    } catch (error) {
      if (/AlreadyVoted/i.test(errorText(error))) {
        console.log(`  ${wallet.account.address.slice(0, 8)} already voted`);
        return;
      }
      // A just-created proposal can look expired on a lagging RPC because an
      // empty slot has status Active and votingEnd 0.
      if (/VotingPeriodEnded/i.test(errorText(error)) && attempt < 19) {
        last = error;
        await sleep(3000);
        continue;
      }
      throw error;
    }
  }
  if (last) throw last;
  await send(wallet, publicClient, {
    address: governor,
    abi: ABI,
    functionName: "castVoteWallet",
    args: [index, 0],
  });
}

async function govern(founderWallet, guardianWallets, publicClient, dao, payload, proposalType, title) {
  const index = await read(publicClient, dao.treasury, "nextProposalIndex");
  await send(founderWallet, publicClient, {
    address: dao.governor,
    abi: ABI,
    functionName: "createProposal",
    args: [{
      title,
      description: "three-guardian testnet round trip",
      payload,
      proposalType,
      votingPeriodSeconds: VOTING_PERIOD,
      votingMint: ZERO,
    }],
  });
  await voteIfNeeded(guardianWallets[0], publicClient, dao.governor, index);
  await assertOneVoteCannotFinalize(guardianWallets[0], publicClient, dao.governor, index);
  await voteIfNeeded(guardianWallets[1], publicClient, dao.governor, index);
  await send(guardianWallets[1], publicClient, {
    address: dao.governor,
    abi: ABI,
    functionName: "finalizeProposal",
    args: [index],
  });
  const core = await readUntil(
    publicClient,
    dao.governor,
    "proposalCore",
    [index],
    (value) => Number(value[1]) === 1,
    "proposal status",
  );
  console.log(`  proposal ${index} passed with 2 of 3 guardians, payload ${core[2]}`);
  return { index, payloadHash: core[2] };
}

async function finishExistingProposal(guardianWallets, publicClient, dao) {
  const next = await read(publicClient, dao.treasury, "nextProposalIndex");
  if (next === 0n) throw new Error("resume found no proposal");
  const index = next - 1n;
  const existing = await read(publicClient, dao.governor, "proposalCore", [index]);
  if (Number(existing[1]) === 1) {
    console.log(`  proposal ${index} already passed`);
    return { index, payloadHash: existing[2] };
  }
  await voteIfNeeded(guardianWallets[0], publicClient, dao.governor, index);
  await assertOneVoteCannotFinalize(guardianWallets[0], publicClient, dao.governor, index);
  await voteIfNeeded(guardianWallets[1], publicClient, dao.governor, index);
  await send(guardianWallets[1], publicClient, {
    address: dao.governor,
    abi: ABI,
    functionName: "finalizeProposal",
    args: [index],
  });
  const core = await readUntil(
    publicClient,
    dao.governor,
    "proposalCore",
    [index],
    (value) => Number(value[1]) === 1,
    "proposal status",
  );
  console.log(`  proposal ${index} passed with 2 of 3 guardians, payload ${core[2]}`);
  return { index, payloadHash: core[2] };
}

async function strategyLoop(wallets, publicClient, spec, dao, founder) {
  const { founder: founderWallet, guardians } = wallets;
  const [executive] = wallets.agents;
  const beforeNav = await read(publicClient, dao.treasury, "currentNav");
  const info = await read(publicClient, dao.treasury, "assetInfo", [spec.asset]);
  if (!info[0]) {
    await send(founderWallet, publicClient, {
      address: dao.treasury,
      abi: ABI,
      functionName: "registerAsset",
      args: [spec.asset, `0x${"00".repeat(32)}`, true, spec.assetKind],
    });
  }
  const assetBal = await read(publicClient, spec.asset, "balanceOf", [founder]);
  if (assetBal < spec.deposit) throw new Error(`asset balance ${assetBal} is below deposit ${spec.deposit}`);
  await send(founderWallet, publicClient, {
    address: spec.asset,
    abi: ABI,
    functionName: "approve",
    args: [dao.treasury, spec.deposit],
  });
  await send(founderWallet, publicClient, {
    address: dao.treasury,
    abi: ABI,
    functionName: "deposit",
    args: [spec.asset, spec.deposit],
  });
  const afterDeposit = await readUntil(
    publicClient,
    spec.asset,
    "balanceOf",
    [dao.treasury],
    (value) => value >= spec.deposit,
    "treasury balance",
  );
  const nav = await readUntil(
    publicClient,
    dao.treasury,
    "currentNav",
    [],
    (value) => value > beforeNav,
    "nav",
  );
  console.log(`  deposited ${afterDeposit} nav ${beforeNav} -> ${nav}`);
  await send(founderWallet, publicClient, {
    address: dao.treasury,
    abi: ABI,
    functionName: "updateConstitution",
    args: [[spec.adapter], [10_000], [true], [spec.protocolId], 70, 0n],
  });
  await send(executive, publicClient, {
    address: dao.treasury,
    abi: ABI,
    functionName: "toggleAgents",
    args: [true],
  });
  await send(founderWallet, publicClient, {
    address: dao.treasury,
    abi: ABI,
    functionName: "revalueTreasury",
    args: [],
  });
  const payload = encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }, { type: "address" }],
    [spec.adapter, spec.deploy, spec.asset],
  );
  const vote = await govern(founderWallet, guardians, publicClient, dao, payload, 1, "deploy-venue");
  return strategyFromVote(wallets, publicClient, spec, dao, vote);
}

async function strategyFromVote(wallets, publicClient, spec, dao, vote) {
  const founderWallet = wallets.founder;
  const [executive, financial, oversight, operational] = wallets.agents;
  const roles = {
    executive: ["executive", executive],
    financial: ["financial", financial],
    oversight: ["oversight", oversight],
    operational: ["operational", operational],
    guardian: ["guardian", wallets.guardians[0]],
    founder: ["founder", founderWallet],
  };
  const except = (...names) => Object.entries(roles).filter(([name]) => !names.includes(name)).map(([, row]) => row);
  await expectRevert(financial, publicClient, "non-founder creates the bootstrap request", {
    address: dao.execution,
    functionName: "createStrategyRequestBootstrap",
    args: [vote.index, spec.deploy, spec.adapter, spec.asset],
  }, /Unauthorized/);
  await send(founderWallet, publicClient, {
    address: dao.execution,
    abi: ABI,
    functionName: "createStrategyRequestBootstrap",
    args: [vote.index, spec.deploy, spec.adapter, spec.asset],
  });
  await othersBlocked(publicClient, except("executive"), dao.execution, "executiveApprove", [vote.index, REASONING]);
  await send(executive, publicClient, {
    address: dao.execution,
    abi: ABI,
    functionName: "executiveApprove",
    args: [vote.index, REASONING],
  });
  await othersBlocked(publicClient, except("financial"), dao.execution, "financialApprove", [vote.index, vote.payloadHash, REASONING]);
  await send(financial, publicClient, {
    address: dao.execution,
    abi: ABI,
    functionName: "financialApprove",
    args: [vote.index, vote.payloadHash, REASONING],
  });
  await othersBlocked(publicClient, except("oversight"), dao.execution, "oversightApprove", [vote.index, vote.payloadHash, REASONING]);
  await send(oversight, publicClient, {
    address: dao.execution,
    abi: ABI,
    functionName: "oversightApprove",
    args: [vote.index, vote.payloadHash, REASONING],
  });
  const minOut = (spec.deploy * 995n) / 1000n;
  await othersBlocked(publicClient, except("executive"), dao.execution, "execute", [vote.index, minOut]);
  await othersBlocked(publicClient, except("operational"), dao.execution, "operationalHalt", [vote.index, REASONING]);
  await expectRevert(executive, publicClient, "executive executes with zero minOut", {
    address: dao.execution,
    functionName: "execute",
    args: [vote.index, 0n],
  }, /SlippageBoundRequired/);
  await expectRevert(executive, publicClient, "executive executes directly while agents are enabled", {
    address: dao.execution,
    functionName: "executeDirect",
    args: [vote.index, minOut],
  }, /DirectExecutionNotAllowed/);
  await send(founderWallet, publicClient, {
    address: dao.treasury,
    abi: ABI,
    functionName: "revalueTreasury",
    args: [],
  });
  const idleBefore = await read(publicClient, spec.asset, "balanceOf", [dao.treasury]);
  await send(executive, publicClient, {
    address: dao.execution,
    abi: ABI,
    functionName: "execute",
    args: [vote.index, minOut],
  });
  await readUntil(
    publicClient,
    dao.execution,
    "requestStatus",
    [vote.index],
    (value) => Number(value) === 5,
    "execution status",
  );
  const idleAfter = await readUntil(
    publicClient,
    spec.asset,
    "balanceOf",
    [dao.treasury],
    (value) => value === idleBefore - spec.deploy,
    "idle after deploy",
  );
  let venueBalance = 0n;
  if (spec.venue === "comet") {
    const comet = await read(publicClient, spec.adapter, "comet");
    venueBalance = await readUntil(publicClient, comet, "balanceOf", [spec.adapter], (value) => value > 0n, "comet balance");
  } else {
    const aToken = await read(publicClient, spec.adapter, "aTokenFor", [spec.asset]);
    venueBalance = await readUntil(publicClient, aToken, "balanceOf", [spec.adapter], (value) => value > 0n, "aToken balance");
  }
  const yieldProof = await proveYield(wallets, publicClient, spec, dao);
  await othersBlocked(publicClient, except("executive"), dao.execution, "withdrawFromStrategy", [vote.index, spec.deploy / 2n, 1n]);
  await expectRevert(executive, publicClient, "executive withdraws with zero minOut", {
    address: dao.execution,
    functionName: "withdrawFromStrategy",
    args: [vote.index, spec.deploy / 2n, 0n],
  }, /SlippageBoundRequired/);
  for (const [roleName, wallet] of except("operational", "founder")) {
    await expectRevert(wallet, publicClient, `${roleName} forges a position mark`, {
      address: dao.execution,
      functionName: "syncPositionValue",
      args: [spec.adapter],
    }, /Unauthorized/);
  }
  await expectRevert(founderWallet, publicClient, "founder writes a mark straight into the treasury", {
    address: dao.treasury,
    functionName: "syncPositionValue",
    args: [spec.adapter, spec.deploy * 10n],
  }, /Unauthorized/);
  const withdrawAmt = spec.deploy - 2_000n;
  await send(executive, publicClient, {
    address: dao.execution,
    abi: ABI,
    functionName: "withdrawFromStrategy",
    args: [vote.index, withdrawAmt, (withdrawAmt * 995n) / 1000n],
  });
  const idleFinal = await readUntil(
    publicClient,
    spec.asset,
    "balanceOf",
    [dao.treasury],
    (value) => value > idleAfter,
    "idle after withdraw",
  );
  const navFinal = await read(publicClient, dao.treasury, "currentNav");
  console.log(`  venue ${venueBalance}; idle ${idleBefore} -> ${idleAfter} -> ${idleFinal}; nav ${navFinal}`);
  const reviewWindow = await reviewWindowBoundary(wallets, publicClient, spec, dao, except);
  return {
    proposal: vote.index.toString(),
    payloadHash: vote.payloadHash,
    venueBalance: venueBalance.toString(),
    idleAfterWithdraw: idleFinal.toString(),
    navFinal: navFinal.toString(),
    yieldProof,
    reviewWindow,
  };
}

/**
 * Supply has happened: wait until the adapter reports more than was deposited,
 * book that as the on-chain mark, and require NAV to rise.
 */
async function proveYield(wallets, publicClient, spec, dao) {
  const founderWallet = wallets.founder;
  const flag = process.argv.indexOf("--yield-wait-mins");
  const waitMs = Number(flag === -1 ? 10 : process.argv[flag + 1]) * 60_000;
  await send(founderWallet, publicClient, {
    address: dao.treasury,
    abi: ABI,
    functionName: "revalueTreasury",
    args: [],
  });
  const navAtSupply = await read(publicClient, dao.treasury, "currentNav");
  const [, deposited, markAtSupply] = await read(publicClient, dao.treasury, "position", [spec.adapter]);
  const started = Date.now();
  let observed = 0n;
  while (Date.now() - started < waitMs) {
    observed = await publicClient.readContract({
      address: spec.adapter,
      abi: ABI,
      functionName: "positionValue",
      args: [spec.asset],
      account: dao.execution,
    });
    if (observed > deposited) break;
    await sleep(20_000);
  }
  const waitedSecs = Math.round((Date.now() - started) / 1000);
  if (observed <= deposited) {
    throw new Error(`venue value ${observed} did not pass deposit ${deposited} within ${waitedSecs}s`);
  }
  await send(founderWallet, publicClient, {
    address: dao.execution,
    abi: ABI,
    functionName: "syncPositionValue",
    args: [spec.adapter],
  });
  const position = await readUntil(
    publicClient,
    dao.treasury,
    "position",
    [spec.adapter],
    (value) => value[2] > deposited,
    "position mark",
  );
  await send(founderWallet, publicClient, {
    address: dao.treasury,
    abi: ABI,
    functionName: "revalueTreasury",
    args: [],
  });
  const navAfterMark = await readUntil(
    publicClient,
    dao.treasury,
    "currentNav",
    [],
    (value) => value > navAtSupply,
    "nav after mark",
  );
  console.log(
    `  yield: deposited ${deposited}, venue ${observed} after ${waitedSecs}s, mark ${markAtSupply} -> ${position[2]}, nav ${navAtSupply} -> ${navAfterMark}`,
  );
  return {
    deposited: deposited.toString(),
    observed: observed.toString(),
    markBefore: markAtSupply.toString(),
    markAfter: position[2].toString(),
    navAtSupply: navAtSupply.toString(),
    navAfterMark: navAfterMark.toString(),
    waitedSecs,
  };
}

/**
 * A second, non-bootstrap request snapshots the 24h review window. Executing it
 * early must revert on both the agent path and the break-glass direct path,
 * and the guardian lock must hold against the Executive meanwhile.
 */
async function reviewWindowBoundary(wallets, publicClient, spec, dao, except) {
  const { founder: founderWallet, guardians } = wallets;
  const [executive, financial, oversight] = wallets.agents;
  const amount = 1_000_000n;
  const payload = encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }, { type: "address" }],
    [spec.adapter, amount, spec.asset],
  );
  const vote = await govern(founderWallet, guardians, publicClient, dao, payload, 1, "windowed-deploy");
  await send(founderWallet, publicClient, {
    address: dao.execution,
    abi: ABI,
    functionName: "createStrategyRequest",
    args: [vote.index, amount, spec.adapter, spec.asset],
  });
  await send(executive, publicClient, {
    address: dao.execution,
    abi: ABI,
    functionName: "executiveApprove",
    args: [vote.index, REASONING],
  });
  await send(financial, publicClient, {
    address: dao.execution,
    abi: ABI,
    functionName: "financialApprove",
    args: [vote.index, vote.payloadHash, REASONING],
  });
  await send(oversight, publicClient, {
    address: dao.execution,
    abi: ABI,
    functionName: "oversightApprove",
    args: [vote.index, vote.payloadHash, REASONING],
  });
  await readUntil(publicClient, dao.execution, "requestStatus", [vote.index], (value) => Number(value) === 4, "in review");
  const minOut = (amount * 995n) / 1000n;
  await expectRevert(executive, publicClient, "executive executes inside the review window", {
    address: dao.execution,
    functionName: "execute",
    args: [vote.index, minOut],
  }, /ReviewWindowActive/);
  await guardianLockCycle(wallets, publicClient, dao, async () => {
    await expectRevert(executive, publicClient, "executive executes while guardians hold agents off", {
      address: dao.execution,
      functionName: "execute",
      args: [vote.index, minOut],
    }, /AgentsDisabled/);
    await expectRevert(executive, publicClient, "executive direct-executes before the window ends", {
      address: dao.execution,
      functionName: "executeDirect",
      args: [vote.index, minOut],
    }, /ReviewWindowActive/);
    for (const [roleName, wallet] of except("executive")) {
      await expectRevert(wallet, publicClient, `${roleName} direct-executes`, {
        address: dao.execution,
        functionName: "executeDirect",
        args: [vote.index, minOut],
      }, /Unauthorized/);
    }
  });
  return { proposal: vote.index.toString(), status: "in review, left to expire" };
}

/** Role boundaries that need no strategy venue (Arc transfer and Robinhood policy chains). */
async function venuelessBoundary(wallets, publicClient, dao) {
  const [executive, financial, oversight, operational] = wallets.agents;
  const guardian = wallets.guardians[0];
  const founder = wallets.founder;
  await guardianLockCycle(wallets, publicClient, dao);
  const probe = founder.account.address;
  for (const [roleName, wallet] of [["executive", executive], ["financial", financial], ["oversight", oversight], ["guardian", guardian]]) {
    await expectRevert(wallet, publicClient, `${roleName} forges a position mark`, {
      address: dao.execution,
      functionName: "syncPositionValue",
      args: [probe],
    }, /Unauthorized/);
  }
  await expectRevert(founder, publicClient, "founder writes a mark straight into the treasury", {
    address: dao.treasury,
    functionName: "syncPositionValue",
    args: [probe, 10n ** 24n],
  }, /Unauthorized/);
  const all = { executive, financial, oversight, operational, guardian, founder };
  const others = (holder) => Object.entries(all).filter(([name]) => name !== holder);
  const cross = [
    ["executiveApprove", [0n, REASONING], "executive"],
    ["financialApprove", [0n, REASONING, REASONING], "financial"],
    ["oversightApprove", [0n, REASONING, REASONING], "oversight"],
    ["execute", [0n, 1n], "executive"],
    ["withdrawFromStrategy", [0n, 1n, 1n], "executive"],
    ["operationalHalt", [0n, REASONING], "operational"],
  ];
  for (const [functionName, args, holder] of cross) {
    await othersBlocked(publicClient, others(holder), dao.execution, functionName, args);
  }
}

async function transferLoop(wallets, publicClient, spec, dao, founder) {
  const { founder: founderWallet, guardians } = wallets;
  const info = await read(publicClient, dao.treasury, "assetInfo", [spec.asset]);
  if (!info[0]) {
    await send(founderWallet, publicClient, {
      address: dao.treasury,
      abi: ABI,
      functionName: "registerAsset",
      args: [spec.asset, `0x${"00".repeat(32)}`, true, 0],
    });
  }
  await send(founderWallet, publicClient, {
    address: spec.asset,
    abi: ABI,
    functionName: "approve",
    args: [dao.treasury, spec.deposit],
  });
  await send(founderWallet, publicClient, {
    address: dao.treasury,
    abi: ABI,
    functionName: "deposit",
    args: [spec.asset, spec.deposit],
  });
  const treasuryBal = await readUntil(
    publicClient,
    spec.asset,
    "balanceOf",
    [dao.treasury],
    (value) => value >= spec.deposit,
    "treasury balance",
  );
  const payload = encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "uint256" }],
    [spec.asset, founder, spec.transfer],
  );
  const vote = await govern(founderWallet, guardians, publicClient, dao, payload, 8, "return-dust");
  return transferFromVote(founderWallet, publicClient, spec, dao, founder, vote, treasuryBal);
}

async function transferFromVote(founderWallet, publicClient, spec, dao, founder, vote, treasuryBal) {
  await send(founderWallet, publicClient, {
    address: dao.governor,
    abi: ABI,
    functionName: "executeTransferProposal",
    args: [vote.index, spec.asset, founder, spec.transfer],
  });
  const treasuryAfter = await readUntil(
    publicClient,
    spec.asset,
    "balanceOf",
    [dao.treasury],
    (value) => value === treasuryBal - spec.transfer,
    "treasury after transfer",
  );
  const navAfter = await read(publicClient, dao.treasury, "currentNav");
  console.log(`  transferred ${spec.transfer}; treasury ${treasuryAfter}; nav ${navAfter}`);
  return {
    proposal: vote.index.toString(),
    payloadHash: vote.payloadHash,
    treasuryAfter: treasuryAfter.toString(),
    navAfter: navAfter.toString(),
  };
}

async function policyLoop(wallets, publicClient, spec, dao) {
  const { founder: founderWallet, guardians } = wallets;
  const founder = founderWallet.account.address;
  await send(founderWallet, publicClient, {
    address: spec.weth,
    abi: ABI,
    functionName: "deposit",
    args: [],
    value: spec.wrap,
  });
  await send(founderWallet, publicClient, {
    address: dao.treasury,
    abi: ABI,
    functionName: "registerAsset",
    args: [spec.weth, `0x${"00".repeat(32)}`, false, 1],
  });
  await send(founderWallet, publicClient, {
    address: spec.weth,
    abi: ABI,
    functionName: "approve",
    args: [dao.treasury, spec.wrap],
  });
  await send(founderWallet, publicClient, {
    address: dao.treasury,
    abi: ABI,
    functionName: "deposit",
    args: [spec.weth, spec.wrap],
  });
  const treasuryWeth = await readUntil(
    publicClient,
    spec.weth,
    "balanceOf",
    [dao.treasury],
    (value) => value === spec.wrap,
    "treasury WETH",
  );
  const nav = await read(publicClient, dao.treasury, "currentNav");
  console.log(`  deposited ${treasuryWeth} WETH; nav stays ${nav} because this asset is not priced`);
  const vote = await govern(founderWallet, guardians, publicClient, dao, "0x", 0, "policy-ok");
  return {
    proposal: vote.index.toString(),
    payloadHash: vote.payloadHash,
    treasuryWeth: treasuryWeth.toString(),
    nav: nav.toString(),
    founder,
  };
}

async function runChain(spec, accounts) {
  const chain = chainFor(spec);
  fallbackRpc = spec.fallbackRpc === spec.rpc ? null : spec.fallbackRpc;
  const transport = http(spec.rpc);
  const publicClient = createPublicClient({ chain, transport });
  const onchainId = await publicClient.getChainId();
  if (onchainId !== spec.chainId) throw new Error(`RPC chain id ${onchainId} != ${spec.chainId}`);
  const founderWallet = createWalletClient({ account: accounts.founder, chain, transport });
  const guardianWallets = accounts.guardians.map((account) =>
    createWalletClient({ account, chain, transport }),
  );
  const protocol = await read(publicClient, spec.factory, "protocol");
  const paused = await read(publicClient, protocol, "paused");
  if (paused) throw new Error("protocol is paused");
  console.log(`\n${spec.name} protocol ${protocol}`);
  const agentWallets = accounts.agents.map((account) =>
    createWalletClient({ account, chain, transport }),
  );
  const wallets = { founder: founderWallet, guardians: guardianWallets, agents: agentWallets };
  await ensureGas(founderWallet, publicClient, accounts.agents, spec.agentGas);
  const resumeFlag = process.argv.indexOf("--resume");
  const resumeTreasury = resumeFlag === -1 ? null : process.argv[resumeFlag + 1];
  let stake = { required: "resumed" };
  let dao;
  let detail;
  if (resumeTreasury) {
    const governor = await read(publicClient, resumeTreasury, "governor");
    const execution = await read(publicClient, resumeTreasury, "execution");
    dao = { daoId: "resumed", treasury: resumeTreasury, governor, execution, createTx: null };
    console.log(`  resume treasury ${dao.treasury} governor ${dao.governor}`);
    const vote = await finishExistingProposal(guardianWallets, publicClient, dao);
    if (spec.mode === "strategy" && !(await read(publicClient, dao.treasury, "agentsEnabled"))) {
      await send(agentWallets[0], publicClient, {
        address: dao.treasury,
        abi: ABI,
        functionName: "toggleAgents",
        args: [true],
      });
    }
    if (spec.mode === "strategy") {
      detail = await strategyFromVote(wallets, publicClient, spec, dao, vote);
    } else if (spec.mode === "transfer") {
      const treasuryBal = await read(publicClient, spec.asset, "balanceOf", [dao.treasury]);
      detail = await transferFromVote(founderWallet, publicClient, spec, dao, accounts.founder.address, vote, treasuryBal);
    } else {
      detail = { proposal: vote.index.toString(), payloadHash: vote.payloadHash };
    }
  } else {
    stake = await ensureStake(founderWallet, publicClient, protocol, accounts.founder.address);
    dao = await createDao(founderWallet, publicClient, spec, accounts.founder.address, accounts.guardians, accounts.agents);
    console.log(`  dao ${dao.daoId} treasury ${dao.treasury} governor ${dao.governor}`);
    if (spec.mode === "strategy") detail = await strategyLoop(wallets, publicClient, spec, dao, accounts.founder.address);
    else if (spec.mode === "transfer") detail = await transferLoop(wallets, publicClient, spec, dao, accounts.founder.address);
    else detail = await policyLoop(wallets, publicClient, spec, dao);
  }
  if (spec.mode !== "strategy") await venuelessBoundary(wallets, publicClient, dao);
  return {
    ok: true,
    chain: spec.name,
    chainId: spec.chainId,
    founder: accounts.founder.address,
    guardians: accounts.guardians.map((account) => account.address),
    agents: Object.fromEntries(AGENT_ROLES.map((role, i) => [role, accounts.agents[i].address])),
    quorumBps: QUORUM_BPS,
    singleVoteBlocked: true,
    stake,
    ...dao,
    ...detail,
    boundary: boundary.splice(0),
  };
}

function selected() {
  const flag = process.argv.indexOf("--chain");
  const value = flag === -1 ? "all" : process.argv[flag + 1];
  if (!value || value === "all") return Object.entries(CHAINS);
  if (!CHAINS[value]) {
    console.error(`Unknown chain ${value}`);
    process.exit(1);
  }
  return [[value, CHAINS[value]]];
}

const accounts = loadAccounts();
const results = [];
for (const [name, spec] of selected()) {
  try {
    results.push(await runChain(spec, accounts));
  } catch (error) {
    const message = errorText(error).slice(0, 500);
    console.error(`\n${name} FAILED: ${message}`);
    results.push({ ok: false, chain: name, error: message, boundary: boundary.splice(0) });
  }
}
const chainArg = process.argv[process.argv.indexOf("--chain") + 1] || "all";
const reportPath = REPORT_PATH.replace(/\.json$/, `-${chainArg}.json`);
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, JSON.stringify(results, null, 2));
console.log(`\nreport ${reportPath}`);
if (results.some((row) => !row.ok)) process.exit(1);
