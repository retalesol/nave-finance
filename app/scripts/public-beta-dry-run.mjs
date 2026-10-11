/**
 * Public-beta live treasury dry run for the four EVM testnets.
 * Signs with keys from contracts/evm/.env.testnet.local. Does not print keys.
 *
 *   node scripts/public-beta-dry-run.mjs --chain sepolia
 *   node scripts/public-beta-dry-run.mjs --chain all
 *
 * New treasuries only. Uses the approved Compound (Sepolia) and Aave (Base
 * Sepolia) adapters. Does not shorten a stored review window. One guardian
 * vote is attempted and must fail to close; a second guardian then closes.
 */
import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import { resolve, dirname } from "node:path";
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
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = resolve(HERE, "../../contracts/evm/.env.testnet.local");
const OUT_PATH = "/tmp/nave-public-beta-evm.json";
const KEY_PATH = "/tmp/nave-public-beta-agent-keys.json";

const ABI = parseAbi([
  "function protocol() view returns (address)",
  "function protocolId() view returns (string)",
  "function paused() view returns (bool)",
  "function requiredNaveStake() view returns (uint256)",
  "function naveStakeToken() view returns (address)",
  "function daoStake() view returns (address)",
  "function formationFee() view returns (uint256)",
  "function isApprovedAdapter(address) view returns (bool)",
  "function riskTierOf(address) view returns (uint8)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function createDao((string name,uint8 privacyMode,address[] guardianWallets,uint8 guardianThreshold,address[4] agentAuthorities,uint16 managementFeeBps,uint16 performanceFeeBps,uint16 frozenManagementFeeBps,uint16 frozenPerformanceFeeBps,address protocolRevenueWallet,uint16 quorumBps,uint8 governanceType) params) payable returns (uint256 daoId, address treasury, address governor, address execution)",
  "event DaoCreated(uint256 indexed daoId, address indexed founder, address treasury, address governor, address execution)",
  "function registerAsset(address asset, bytes32 pythFeedId, bool isStablecoin, uint8 assetKind)",
  "function deposit(address asset, uint256 amount)",
  "function deposit() payable",
  "function currentNav() view returns (uint256)",
  "function assetInfo(address asset) view returns (bool registered, bool enabled, bool isStablecoin, uint8 assetKind, bytes32 pythFeedId, uint8 decimals)",
  "function updateConstitution(address[] adapters, uint16[] maxAllocationBps, bool[] approved, string[] protocolIds, uint8 newConfidenceThreshold, uint256 agentThresholdUsd)",
  "function agentsEnabled() view returns (bool)",
  "function toggleAgents(bool enabled)",
  "function reviewWindowSecs() view returns (int64)",
  "function revalueTreasury()",
  "function nextProposalIndex() view returns (uint64)",
  "function guardianCount() view returns (uint8)",
  "function createProposal((string title, string description, bytes payload, uint8 proposalType, uint256 votingPeriodSeconds, address votingMint) params) returns (uint64)",
  "function castVoteWallet(uint64 index, uint8 choice)",
  "function finalizeProposal(uint64 index)",
  "function proposalCore(uint64 index) view returns (uint8 proposalType, uint8 status, bytes32 payloadHash, uint256 finalizedAt, address proposer)",
  "function createStrategyRequest(uint64 proposalIndex, uint256 amount, address adapter, address asset)",
  "function executiveApprove(uint64 index, bytes32 reasoningHash)",
  "function financialApprove(uint64 index, bytes32 txPayloadHash, bytes32 reasoningHash)",
  "function oversightApprove(uint64 index, bytes32 txPayloadHash, bytes32 reasoningHash)",
  "function execute(uint64 index, uint256 minOut)",
  "function withdrawFromStrategy(uint64 index, uint256 amount, uint256 minOut)",
  "function requestStatus(uint64 index) view returns (uint8)",
  "function requestExists(uint64 index) view returns (bool)",
  "function getRequest(uint64 index) view returns (bool exists, uint8 kind, uint8 status, bool bootstrap, uint64 proposalIndex, address adapter, address asset, address recipient, uint256 amount, uint256 reviewEnd, int64 reviewWindow, uint256 withdrawnAmount)",
  "function shares(address,address) view returns (uint256)",
  "function totalShares(address) view returns (uint256)",
  "function comet() view returns (address)",
  "function aTokenFor(address asset) view returns (address)",
  "error VotingPeriodNotEnded()",
  "error ReviewWindowActive()",
  "error SlippageBoundRequired()",
  "error DepositSlippageExceeded()",
]);

const REASONING = `0x${"ab".repeat(32)}`;
const ZERO = "0x0000000000000000000000000000000000000000";
const ZERO_FEED = `0x${"00".repeat(32)}`;
const VOTING_PERIOD = 60n;

const CHAINS = {
  sepolia: {
    chainId: 11155111,
    factory: "0x4F01c9616A48F14009EC083Ff4bb6e47EdDE0890",
    name: "Beta Sepolia",
    mode: "strategy",
    asset: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    assetKind: 0,
    deposit: 2_000_000n,
    adapter: "0xa675dC4A02304ce069D98760DcF64B0cf3530A80",
    protocolId: "compound-v3",
    venue: "comet",
  },
  base: {
    chainId: 84532,
    factory: "0xF53dE95ae1Fed92FFd9C9305E1716FD48EFcB776",
    name: "Beta Base Sep",
    mode: "strategy",
    asset: "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f",
    assetKind: 0,
    deposit: 2_000_000n,
    adapter: "0xcA99d4A75A41C3aff5F3Fc2c2Dfd241129B1e093",
    protocolId: "aave-v3",
    venue: "aave",
  },
  robinhood: {
    chainId: 46630,
    factory: "0x303cE551De723cad43e1575C4D981C0E2b662b7F",
    name: "Beta Robinhood",
    mode: "govern",
    weth: "0x7943e237c7F95DA44E0301572D358911207852Fa",
    deposit: 1_000_000_000_000_000n,
  },
  arc: {
    chainId: 5042002,
    factory: "0xa7bd919a5249DD1Da6E02a6716D2Db2B2e0A99f0",
    name: "Beta Arc",
    mode: "govern",
    asset: "0x3600000000000000000000000000000000000000",
    deposit: 2_000_000n,
  },
};

const RPC_KEYS = {
  sepolia: ["EVM_SEPOLIA_RPC_URL", "ETH_SEPOLIA_RPC_URL"],
  base: ["EVM_BASE_SEPOLIA_RPC_URL", "BASE_SEPOLIA_RPC_URL"],
  robinhood: ["EVM_ROBINHOOD_TESTNET_RPC_URL"],
  arc: ["EVM_ARC_TESTNET_RPC_URL"],
};

function loadEnvFile() {
  const env = {};
  for (const row of readFileSync(ENV_PATH, "utf8").split("\n")) {
    const match = row.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[match[1]] = value;
  }
  return env;
}

const FILE_ENV = loadEnvFile();

function rpcFrom(names) {
  for (const name of names) {
    const value = (process.env[name] || FILE_ENV[name] || "").trim();
    if (value) return value;
  }
  throw new Error(`missing RPC for ${names.join(",")}`);
}

function normalizeKey(value, label) {
  let key = value || "";
  if (!key.startsWith("0x")) key = `0x${key}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error(`${label} is not a 32-byte hex key`);
  return key;
}

function loadAccounts() {
  return {
    deploy: privateKeyToAccount(normalizeKey(FILE_ENV.EVM_DEPLOY_PRIVATE_KEY, "EVM_DEPLOY_PRIVATE_KEY")),
    g1: privateKeyToAccount(normalizeKey(FILE_ENV.EVM_TESTING_KEY_1, "EVM_TESTING_KEY_1")),
    g2: privateKeyToAccount(normalizeKey(FILE_ENV.EVM_TESTING_KEY_2, "EVM_TESTING_KEY_2")),
  };
}

function chainFor(spec) {
  return defineChain({
    id: spec.chainId,
    name: spec.name,
    nativeCurrency: {
      name: spec.chainId === 5042002 ? "USDC" : "ETH",
      symbol: spec.chainId === 5042002 ? "USDC" : "ETH",
      decimals: 18,
    },
    rpcUrls: { default: { http: [spec.rpc] } },
  });
}

function shortError(error) {
  const message = error?.shortMessage || error?.message || String(error);
  return message.split("\n")[0].slice(0, 500);
}

function sleep(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function clientsFor(account, spec) {
  const chain = chainFor(spec);
  const transport = http(spec.rpc, { timeout: 30_000 });
  return {
    publicClient: createPublicClient({ chain, transport }),
    wallet: createWalletClient({ account, chain, transport }),
  };
}

const nonces = new Map();

async function takeNonce(publicClient, address) {
  const key = address.toLowerCase();
  if (!nonces.has(key)) {
    nonces.set(key, await publicClient.getTransactionCount({ address, blockTag: "pending" }));
  }
  const nonce = nonces.get(key);
  nonces.set(key, nonce + 1);
  return nonce;
}

async function send(wallet, publicClient, params) {
  const nonce = await takeNonce(publicClient, wallet.account.address);
  const hash = await wallet.writeContract({ ...params, nonce, gas: params.gas ?? 4_000_000n });
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (receipt.status !== "success") throw new Error(`transaction reverted: ${hash}`);
  console.log(`  tx ${params.functionName || "transfer"} ${hash}`);
  return { hash, receipt };
}

async function read(publicClient, address, functionName, args = []) {
  let last;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await publicClient.readContract({ address, abi: ABI, functionName, args });
    } catch (error) {
      last = error;
      const message = shortError(error);
      if (!message.includes("returned no data") && !message.includes("timeout") && !message.includes("HTTP")) throw error;
      await sleep(1500);
    }
  }
  throw last;
}

async function expectRevert(wallet, publicClient, params, label) {
  try {
    const sent = await send(wallet, publicClient, params);
    throw new Error(`${label} unexpectedly succeeded: ${sent.hash}`);
  } catch (error) {
    if (String(error.message || "").includes("unexpectedly succeeded")) throw error;
    const message = shortError(error);
    console.log(`  expected revert ${label}: ${message}`);
    return message;
  }
}

function daoParams(name, founder, guardians, agents) {
  return {
    name,
    privacyMode: 0,
    guardianWallets: guardians,
    guardianThreshold: 2,
    agentAuthorities: agents,
    managementFeeBps: 0,
    performanceFeeBps: 1500,
    frozenManagementFeeBps: 0,
    frozenPerformanceFeeBps: 1500,
    protocolRevenueWallet: founder,
    quorumBps: 3500,
    governanceType: 0,
  };
}

async function ensureStake() {
  return { required: "0" };
}

async function createDao(wallet, publicClient, spec, founder, guardians, agents) {
  const { receipt } = await send(wallet, publicClient, {
    address: spec.factory,
    abi: ABI,
    functionName: "createDao",
    args: [daoParams(`${spec.name} ${stamp()}`, founder, guardians, agents)],
    value: 0n,
    gas: 12_000_000n,
  });
  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({ abi: ABI, data: log.data, topics: log.topics });
      if (decoded.eventName === "DaoCreated") {
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

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
}

async function govern(deployWallet, secondWallet, publicClient, dao) {
  const index = await read(publicClient, dao.treasury, "nextProposalIndex");
  const payload = "0x";
  const create = await send(deployWallet, publicClient, {
    address: dao.governor,
    abi: ABI,
    functionName: "createProposal",
    args: [{
      title: "policy-ok",
      description: "live testnet treasury check",
      payload,
      proposalType: 0,
      votingPeriodSeconds: VOTING_PERIOD,
      votingMint: ZERO,
    }],
  });
  const first = await send(secondWallet, publicClient, {
    address: dao.governor,
    abi: ABI,
    functionName: "castVoteWallet",
    args: [index, 0],
  });
  const oneGuardianRevert = await expectRevert(deployWallet, publicClient, {
    address: dao.governor,
    abi: ABI,
    functionName: "finalizeProposal",
    args: [index],
  }, "one-guardian finalize");
  const second = await send(deployWallet, publicClient, {
    address: dao.governor,
    abi: ABI,
    functionName: "castVoteWallet",
    args: [index, 0],
  });
  const fin = await send(deployWallet, publicClient, {
    address: dao.governor,
    abi: ABI,
    functionName: "finalizeProposal",
    args: [index],
  });
  let core;
  for (let attempt = 0; attempt < 8; attempt++) {
    core = await read(publicClient, dao.governor, "proposalCore", [index]);
    if (Number(core[1]) === 1) break;
    await sleep(1500);
  }
  if (Number(core[1]) !== 1) throw new Error(`proposal status ${core[1]} after two votes`);
  return {
    index: index.toString(),
    payloadHash: core[2],
    votingPeriodSeconds: "60",
    oneGuardianRevert,
    txs: {
      create: create.hash,
      firstVote: first.hash,
      secondVote: second.hash,
      finalize: fin.hash,
    },
  };
}

async function fundAgents(deployWallet, publicClient, agents, wei) {
  const hashes = [];
  for (const account of agents) {
    const nonce = await takeNonce(publicClient, deployWallet.account.address);
    const hash = await deployWallet.sendTransaction({ to: account.address, value: wei, nonce });
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
    if (receipt.status !== "success") throw new Error(`agent fund reverted ${hash}`);
    hashes.push(hash);
    console.log(`  tx fund-agent ${hash}`);
  }
  return hashes;
}

async function adapterClaim(publicClient, spec, execution) {
  const shares = await read(publicClient, spec.adapter, "shares", [execution, spec.asset]);
  const total = await read(publicClient, spec.adapter, "totalShares", [spec.asset]);
  if (total === 0n) return 0n;
  let underlying;
  if (spec.venue === "comet") {
    const comet = await read(publicClient, spec.adapter, "comet");
    underlying = await read(publicClient, comet, "balanceOf", [spec.adapter]);
  } else {
    const aToken = await read(publicClient, spec.adapter, "aTokenFor", [spec.asset]);
    underlying = await read(publicClient, aToken, "balanceOf", [spec.adapter]);
  }
  return (shares * underlying) / total;
}

async function strategyLoop(spec, dao, wallets, publicClient) {
  const info = await read(publicClient, dao.treasury, "assetInfo", [spec.asset]);
  if (!info[0]) {
    await send(wallets.deploy, publicClient, {
      address: dao.treasury,
      abi: ABI,
      functionName: "registerAsset",
      args: [spec.asset, ZERO_FEED, true, spec.assetKind],
    });
  }
  let treasuryBal = await read(publicClient, spec.asset, "balanceOf", [dao.treasury]);
  if (treasuryBal < spec.deposit) {
    const founderBal = await read(publicClient, spec.asset, "balanceOf", [wallets.deploy.account.address]);
    if (founderBal < spec.deposit) throw new Error(`asset balance ${founderBal} is below deposit ${spec.deposit}`);
    await send(wallets.deploy, publicClient, {
      address: spec.asset,
      abi: ABI,
      functionName: "approve",
      args: [dao.treasury, spec.deposit],
    });
    await send(wallets.deploy, publicClient, {
      address: dao.treasury,
      abi: ABI,
      functionName: "deposit",
      args: [spec.asset, spec.deposit],
    });
    treasuryBal = await read(publicClient, spec.asset, "balanceOf", [dao.treasury]);
  }
  await send(wallets.deploy, publicClient, {
    address: dao.treasury,
    abi: ABI,
    functionName: "revalueTreasury",
    args: [],
  });
  const nav = await read(publicClient, dao.treasury, "currentNav");
  const tier = Number(await read(publicClient, spec.protocol, "riskTierOf", [spec.adapter]));
  const capBps = tier === 3 ? 1500 : tier === 2 ? 3000 : 5000;
  const deployAmt = (spec.deposit * BigInt(capBps) * 9n) / 100_000n;
  if (deployAmt < 200_000n) throw new Error(`deploy amount ${deployAmt} is too small for the share lock`);
  console.log(`  nav ${nav} tier ${tier} capBps ${capBps} deploy ${deployAmt}`);
  await send(wallets.deploy, publicClient, {
    address: dao.treasury,
    abi: ABI,
    functionName: "updateConstitution",
    args: [[spec.adapter], [capBps], [true], [spec.protocolId], 70, 0n],
  });

  const payload = encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }, { type: "address" }],
    [spec.adapter, deployAmt, spec.asset],
  );
  const expectedHash = keccak256(payload);
  const nextIndex = await read(publicClient, dao.treasury, "nextProposalIndex");
  let index = nextIndex;
  let core = null;
  let oneGuardianRevert = null;
  let reused = false;
  if (nextIndex > 0n) {
    const prior = nextIndex - 1n;
    const priorCore = await read(publicClient, dao.governor, "proposalCore", [prior]);
    if (Number(priorCore[1]) === 1 && priorCore[2].toLowerCase() === expectedHash.toLowerCase()) {
      console.log(`  reusing passed proposal ${prior}`);
      index = prior;
      core = priorCore;
      reused = true;
      oneGuardianRevert = "already demonstrated on this treasury";
    }
  }
  if (!reused) await send(wallets.deploy, publicClient, {
    address: dao.governor,
    abi: ABI,
    functionName: "createProposal",
    args: [{
      title: "deploy-venue",
      description: "live testnet treasury check",
      payload,
      proposalType: 1,
      votingPeriodSeconds: VOTING_PERIOD,
      votingMint: ZERO,
    }],
  });
  if (!reused) await send(wallets.g1, publicClient, {
    address: dao.governor,
    abi: ABI,
    functionName: "castVoteWallet",
    args: [index, 0],
  });
  if (!reused) oneGuardianRevert = await expectRevert(wallets.deploy, publicClient, {
    address: dao.governor,
    abi: ABI,
    functionName: "finalizeProposal",
    args: [index],
  }, "one-guardian finalize");
  if (!reused) await send(wallets.deploy, publicClient, {
    address: dao.governor,
    abi: ABI,
    functionName: "castVoteWallet",
    args: [index, 0],
  });
  if (!reused) await send(wallets.deploy, publicClient, {
    address: dao.governor,
    abi: ABI,
    functionName: "finalizeProposal",
    args: [index],
  });
  if (!reused) {
  for (let attempt = 0; attempt < 8; attempt++) {
    core = await read(publicClient, dao.governor, "proposalCore", [index]);
    if (Number(core[1]) === 1) break;
    await sleep(1500);
  }
  if (Number(core[1]) !== 1) throw new Error(`proposal status ${core[1]}`);
  if (core[2].toLowerCase() !== keccak256(payload).toLowerCase()) {
    throw new Error("payload hash does not match the venue binding");
  }
  }

  const idleBefore = await read(publicClient, spec.asset, "balanceOf", [dao.treasury]);
  const window = await read(publicClient, dao.treasury, "reviewWindowSecs");
  if (window !== 60n) throw new Error(`review window is ${window}, expected 60; not shortening it`);
  const exists = await read(publicClient, dao.execution, "requestExists", [index]);
  let status = exists ? Number(await read(publicClient, dao.execution, "requestStatus", [index])) : -1;
  if (!exists) {
    await send(wallets.deploy, publicClient, {
      address: dao.execution,
      abi: ABI,
      functionName: "createStrategyRequest",
      args: [index, deployAmt, spec.adapter, spec.asset],
    });
    await send(wallets.executive, publicClient, {
      address: dao.execution,
      abi: ABI,
      functionName: "executiveApprove",
      args: [index, REASONING],
    });
    await send(wallets.financial, publicClient, {
      address: dao.execution,
      abi: ABI,
      functionName: "financialApprove",
      args: [index, core[2], REASONING],
    });
    const oversight = await send(wallets.oversight, publicClient, {
      address: dao.execution,
      abi: ABI,
      functionName: "oversightApprove",
      args: [index, core[2], REASONING],
    });
    console.log(`  waiting ${window}s review window after ${oversight.hash}`);
    await sleep(Number(window) * 1000 + 5000);
    status = 4;
  }
  if (status !== 5) {
    const minOut = (deployAmt * 9950n) / 10_000n;
    await send(wallets.executive, publicClient, {
      address: dao.execution,
      abi: ABI,
      functionName: "execute",
      args: [index, minOut],
      gas: 8_000_000n,
    });
    for (let attempt = 0; attempt < 8; attempt++) {
      status = Number(await read(publicClient, dao.execution, "requestStatus", [index]));
      if (status === 5) break;
      await sleep(1500);
    }
    if (status !== 5) throw new Error(`execution status ${status}`);
  } else {
    console.log("  execution already landed; withdrawing");
  }
  const idleAfter = await read(publicClient, spec.asset, "balanceOf", [dao.treasury]);
  const claim = await adapterClaim(publicClient, spec, dao.execution);
  if (claim === 0n) throw new Error("venue claim is still 0");
  const withdrawAmt = claim > 1n ? claim - 1n : claim;
  const withdrawMin = (withdrawAmt * 9900n) / 10_000n;
  await send(wallets.executive, publicClient, {
    address: dao.execution,
    abi: ABI,
    functionName: "withdrawFromStrategy",
    args: [index, withdrawAmt, withdrawMin > 0n ? withdrawMin : 1n],
    gas: 8_000_000n,
  });
  const idleFinal = await read(publicClient, spec.asset, "balanceOf", [dao.treasury]);
  const claimAfter = await adapterClaim(publicClient, spec, dao.execution);
  const navFinal = await read(publicClient, dao.treasury, "currentNav");
  console.log(`  idle ${idleBefore} -> ${idleAfter} -> ${idleFinal}; claim ${claim} -> ${claimAfter}; nav ${nav} -> ${navFinal}`);
  return {
    proposal: index.toString(),
    payloadHash: core[2],
    oneGuardianRevert,
    reviewWindowSecs: window.toString(),
    deployAmount: deployAmt.toString(),
    withdrawAmount: withdrawAmt.toString(),
    idleBefore: idleBefore.toString(),
    idleAfterDeploy: idleAfter.toString(),
    idleAfterWithdraw: idleFinal.toString(),
    claimBeforeWithdraw: claim.toString(),
    claimAfterWithdraw: claimAfter.toString(),
    navAfterDeposit: nav.toString(),
    navFinal: navFinal.toString(),
    adapter: spec.adapter,
    protocolId: spec.protocolId,
  };
}

async function withdrawExecuted(spec, dao, wallets, publicClient, indexes) {
  let claim = await adapterClaim(publicClient, spec, dao.execution);
  const idleBefore = await read(publicClient, spec.asset, "balanceOf", [dao.treasury]);
  const hashes = [];
  for (const index of indexes) {
    if (claim <= 1n) break;
    const request = await read(publicClient, dao.execution, "getRequest", [index]);
    const remaining = request[8] - request[11];
    const amount = claim - 1n < remaining ? claim - 1n : remaining;
    if (amount === 0n) continue;
    const minOut = (amount * 9900n) / 10_000n;
    const sent = await send(wallets.executive, publicClient, {
      address: dao.execution,
      abi: ABI,
      functionName: "withdrawFromStrategy",
      args: [index, amount, minOut > 0n ? minOut : 1n],
      gas: 8_000_000n,
    });
    hashes.push(sent.hash);
    claim = await adapterClaim(publicClient, spec, dao.execution);
  }
  const idleFinal = await read(publicClient, spec.asset, "balanceOf", [dao.treasury]);
  console.log(`  withdraw idle ${idleBefore} -> ${idleFinal}; claim left ${claim}`);
  if (claim > 2_000n) throw new Error(`venue claim ${claim} remains after withdraw`);
  return {
    withdrawTxs: hashes,
    idleBefore: idleBefore.toString(),
    idleAfterWithdraw: idleFinal.toString(),
    claimAfterWithdraw: claim.toString(),
  };
}

async function depositGovern(spec, dao, wallets, publicClient) {
  if (spec.weth) {
    const wrapped = await read(publicClient, spec.weth, "balanceOf", [wallets.deploy.account.address]);
    if (wrapped < spec.deposit) {
      await send(wallets.deploy, publicClient, {
        address: spec.weth,
        abi: ABI,
        functionName: "deposit",
        args: [],
        value: spec.deposit,
      });
    }
    const info = await read(publicClient, dao.treasury, "assetInfo", [spec.weth]);
    if (!info[0]) {
      await send(wallets.deploy, publicClient, {
        address: dao.treasury,
        abi: ABI,
        functionName: "registerAsset",
        args: [spec.weth, ZERO_FEED, false, 1],
      });
    }
    await send(wallets.deploy, publicClient, {
      address: spec.weth,
      abi: ABI,
      functionName: "approve",
      args: [dao.treasury, spec.deposit],
    });
    await send(wallets.deploy, publicClient, {
      address: dao.treasury,
      abi: ABI,
      functionName: "deposit",
      args: [spec.weth, spec.deposit],
    });
    const treasuryBal = await read(publicClient, spec.weth, "balanceOf", [dao.treasury]);
    console.log(`  treasury WETH ${treasuryBal}`);
    const vote = await govern(wallets.deploy, wallets.g1, publicClient, dao);
    return { asset: spec.weth, treasuryBalance: treasuryBal.toString(), ...vote, yieldVenueOffered: false };
  }
  const info = await read(publicClient, dao.treasury, "assetInfo", [spec.asset]);
  if (!info[0]) {
    await send(wallets.deploy, publicClient, {
      address: dao.treasury,
      abi: ABI,
      functionName: "registerAsset",
      args: [spec.asset, ZERO_FEED, true, 0],
    });
  }
  const bal = await read(publicClient, spec.asset, "balanceOf", [wallets.deploy.account.address]);
  if (bal < spec.deposit) throw new Error(`asset balance ${bal} is below deposit ${spec.deposit}`);
  await send(wallets.deploy, publicClient, {
    address: spec.asset,
    abi: ABI,
    functionName: "approve",
    args: [dao.treasury, spec.deposit],
  });
  await send(wallets.deploy, publicClient, {
    address: dao.treasury,
    abi: ABI,
    functionName: "deposit",
    args: [spec.asset, spec.deposit],
  });
  const treasuryBal = await read(publicClient, spec.asset, "balanceOf", [dao.treasury]);
  const nav = await read(publicClient, dao.treasury, "currentNav");
  console.log(`  treasury asset ${treasuryBal} nav ${nav}`);
  const vote = await govern(wallets.deploy, wallets.g1, publicClient, dao);
  return {
    asset: spec.asset,
    treasuryBalance: treasuryBal.toString(),
    nav: nav.toString(),
    ...vote,
    yieldVenueOffered: false,
  };
}

function loadOrCreateAgents() {
  let saved = {};
  try {
    saved = JSON.parse(readFileSync(KEY_PATH, "utf8"));
  } catch {
    saved = {};
  }
  const roles = ["executive", "financial", "oversight", "operational"];
  for (const role of roles) {
    if (!saved[role]) saved[role] = generatePrivateKey();
  }
  writeFileSync(KEY_PATH, JSON.stringify(saved));
  chmodSync(KEY_PATH, 0o600);
  return Object.fromEntries(roles.map((role) => [role, privateKeyToAccount(saved[role])]));
}

async function runChain(name, spec, accounts, agents) {
  spec.rpc = rpcFrom(RPC_KEYS[name]);
  const founder = accounts.deploy.address;
  const guardians = [founder, accounts.g1.address, accounts.g2.address];
  const agentAccounts = [agents.executive, agents.financial, agents.oversight, agents.operational];
  const { publicClient, wallet: deployWallet } = clientsFor(accounts.deploy, spec);
  const onchainId = await publicClient.getChainId();
  if (onchainId !== spec.chainId) throw new Error(`RPC chain id ${onchainId} != ${spec.chainId}`);
  const protocol = await read(publicClient, spec.factory, "protocol");
  spec.protocol = protocol;
  const paused = await read(publicClient, protocol, "paused");
  if (paused) throw new Error("protocol is paused");
  if (spec.adapter) {
    const adapterProtocol = await read(publicClient, spec.adapter, "protocol");
    const approved = await read(publicClient, protocol, "isApprovedAdapter", [spec.adapter]);
    const protocolId = await read(publicClient, spec.adapter, "protocolId");
    if (adapterProtocol.toLowerCase() !== protocol.toLowerCase() || !approved || protocolId !== spec.protocolId) {
      throw new Error(`adapter ${spec.adapter} is not the approved ${spec.protocolId} on this protocol`);
    }
  }
  console.log(`\n${name} factory ${spec.factory} protocol ${protocol}`);
  console.log(`  founder ${founder}`);
  console.log(`  guardians ${guardians.join(" ")}`);
  console.log(`  agents ${agentAccounts.map((a) => a.address).join(" ")}`);
  const resumed = resumeDao();
  const stake = resumed ? { required: "resumed" } : await ensureStake(deployWallet, publicClient, protocol, founder);
  if (!resumed && spec.mode === "strategy") {
    const fundWei = name === "base" ? 300_000_000_000_000n : 2_000_000_000_000_000n;
    const native = await publicClient.getBalance({ address: founder });
    if (native < fundWei * 3n + 2_000_000_000_000_000n) {
      throw new Error(`founder native balance ${native} is too low to create and fund agents`);
    }
    await fundAgents(deployWallet, publicClient, [agents.executive, agents.financial, agents.oversight], fundWei);
  }
  const dao = resumed ?? await createDao(
    deployWallet,
    publicClient,
    spec,
    founder,
    guardians,
    agentAccounts.map((a) => a.address),
  );
  const review = await read(publicClient, dao.treasury, "reviewWindowSecs");
  const agentsEnabled = await read(publicClient, dao.treasury, "agentsEnabled");
  const guardianCount = await read(publicClient, dao.treasury, "guardianCount");
  console.log(`  dao ${dao.daoId} treasury ${dao.treasury} reviewWindow ${review} agentsEnabled ${agentsEnabled} guardians ${guardianCount}`);
  if (review !== 60n) throw new Error(`new treasury review window is ${review}, expected 60`);
  const wallets = {
    deploy: deployWallet,
    g1: clientsFor(accounts.g1, spec).wallet,
    executive: clientsFor(agents.executive, spec).wallet,
    financial: clientsFor(agents.financial, spec).wallet,
    oversight: clientsFor(agents.oversight, spec).wallet,
  };
  let enableTx = null;
  if (!agentsEnabled) {
    const execBal = await publicClient.getBalance({ address: agents.executive.address });
    const need = spec.chainId === 5042002 ? 500_000_000_000_000_000n : 1_000_000_000_000_000n;
    if (execBal < need) {
      const native = await publicClient.getBalance({ address: founder });
      if (native < need + 1_000_000_000_000_000n) {
        throw new Error(`founder native balance ${native} cannot fund the executive agent`);
      }
      await fundAgents(deployWallet, publicClient, [agents.executive], need);
    }
    const enabled = await send(wallets.executive, publicClient, {
      address: dao.treasury,
      abi: ABI,
      functionName: "toggleAgents",
      args: [true],
    });
    enableTx = enabled.hash;
    const now = await read(publicClient, dao.treasury, "agentsEnabled");
    if (!now) throw new Error("executive toggleAgents did not enable the pipeline");
  }
  const withdrawFlag = process.argv.indexOf("--withdraw-indexes");
  if (withdrawFlag !== -1) {
    const indexes = (process.argv[withdrawFlag + 1] || "").split(",").filter(Boolean).map((n) => BigInt(n));
    const detail = await withdrawExecuted(spec, dao, wallets, publicClient, indexes);
    return {
      ok: true,
      chain: name,
      surface: "script",
      ...dao,
      ...detail,
    };
  }
  const detail = spec.mode === "strategy"
    ? await strategyLoop(spec, dao, wallets, publicClient)
    : await depositGovern(spec, dao, wallets, publicClient);
  return {
    ok: true,
    chain: name,
    chainId: spec.chainId,
    founder,
    guardians,
    agents: Object.fromEntries(Object.entries(agents).map(([role, account]) => [role, account.address])),
    stake,
    reviewWindowSecs: review.toString(),
    agentsEnabled,
    enableTx,
    guardianCount: Number(guardianCount),
    surface: "script",
    ...dao,
    ...detail,
  };
}

function resumeDao() {
  const flag = process.argv.indexOf("--resume");
  if (flag === -1) return null;
  const [treasury, governor, execution, daoId = "0"] = (process.argv[flag + 1] || "").split(",");
  if (!treasury || !governor || !execution) throw new Error("--resume needs treasury,governor,execution");
  return { treasury, governor, execution, daoId, createTx: "resumed" };
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
const agents = loadOrCreateAgents();
const results = [];
for (const [name, spec] of selected()) {
  try {
    results.push(await runChain(name, spec, accounts, agents));
    console.log(`PASS  ${name}`);
  } catch (error) {
    console.error(`FAIL  ${name}: ${shortError(error)}`);
    if (error?.details) console.error(`  details ${String(error.details).slice(0, 300)}`);
    if (error?.cause) console.error(`  cause ${String(error.cause?.shortMessage || error.cause?.message || error.cause).slice(0, 300)}`);
    results.push({ ok: false, chain: name, error: shortError(error) });
  }
  let prior = [];
  try { prior = JSON.parse(readFileSync(OUT_PATH, "utf8")); } catch { prior = []; }
  const row = results[results.length - 1];
  writeFileSync(OUT_PATH, JSON.stringify([...prior.filter((item) => item.chain !== row.chain), row], null, 2));
}
const failed = results.filter((row) => !row.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
console.log(`results ${OUT_PATH}`);
process.exitCode = failed ? 1 : 0;
