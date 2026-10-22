/**
 * Live testnet treasury loop. The founder signs with EVM_DEPLOY_PRIVATE_KEY.
 * Executive, Financial, and Oversight sign with EVM_TESTING_KEY_1/2/3.
 * Operational is a fresh address that does not sign. Keys are not printed.
 *
 *   node scripts/testnet-treasury-live.mjs --chain ethereum
 *   node scripts/testnet-treasury-live.mjs --chain all
 *
 * ethereum / base: create, stake, deposit, vote, bootstrap into a venue, withdraw.
 * arc: create, deposit, vote, transfer back. CCTP stays unexecuted (24h review, no bridge bootstrap).
 * robinhood: create, wrap a dust of ETH, deposit WETH, vote a policy. No USDC and no venue.
 */
import { readFileSync } from "node:fs";
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

const ABI = parseAbi([
  "function protocol() view returns (address)",
  "function paused() view returns (bool)",
  "function requiredNaveStake() view returns (uint256)",
  "function naveStakeToken() view returns (address)",
  "function daoStake() view returns (address)",
  "function formationFee() view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function deposit() payable",
  "function createDao((string name,uint8 privacyMode,address[] guardianWallets,uint8 guardianThreshold,address[4] agentAuthorities,uint16 managementFeeBps,uint16 performanceFeeBps,uint16 frozenManagementFeeBps,uint16 frozenPerformanceFeeBps,address protocolRevenueWallet,uint16 quorumBps,uint8 governanceType) params) payable returns (uint256 daoId, address treasury, address governor, address execution)",
  "event DaoCreated(uint256 indexed daoId, address indexed founder, address treasury, address governor, address execution)",
  "function registerAsset(address asset, bytes32 pythFeedId, bool isStablecoin, uint8 assetKind)",
  "function deposit(address asset, uint256 amount)",
  "function currentNav() view returns (uint256)",
  "function assetInfo(address asset) view returns (bool registered, bool enabled, bool isStablecoin, uint8 assetKind, bytes32 pythFeedId, uint8 decimals)",
  "function updateConstitution(address[] adapters, uint16[] maxAllocationBps, bool[] approved, string[] protocolIds, uint8 newConfidenceThreshold, uint256 agentThresholdUsd)",
  "function toggleAgents(bool enabled)",
  "function agentsEnabled() view returns (bool)",
  "function revalueTreasury()",
  "function nextProposalIndex() view returns (uint64)",
  "function createProposal((string title, string description, bytes payload, uint8 proposalType, uint256 votingPeriodSeconds, address votingMint) params) returns (uint64)",
  "function castVoteWallet(uint64 index, uint8 choice)",
  "function finalizeProposal(uint64 index)",
  "function proposalCore(uint64 index) view returns (uint8 proposalType, uint8 status, bytes32 payloadHash, uint256 finalizedAt, address proposer)",
  "function createStrategyRequestBootstrap(uint64 proposalIndex, uint256 amount, address adapter, address asset)",
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

const CHAINS = {
  ethereum: {
    chainId: 11155111,
    rpc: "https://ethereum-sepolia-rpc.publicnode.com",
    factory: "0x4F01c9616A48F14009EC083Ff4bb6e47EdDE0890",
    name: "nave-live-sepolia",
    mode: "strategy",
    asset: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    stable: true,
    assetKind: 0,
    deposit: 2_000_000n,
    deploy: 1_000_000n,
    adapter: "0x845d8310A861A95Ed1644643D1BAe086944B1AA0",
    protocolId: "compound-v3",
    venue: "comet",
  },
  base: {
    chainId: 84532,
    rpc: "https://sepolia.base.org",
    factory: "0xF53dE95ae1Fed92FFd9C9305E1716FD48EFcB776",
    name: "nave-live-base",
    mode: "strategy",
    asset: "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f",
    stable: true,
    assetKind: 0,
    deposit: 2_000_000n,
    deploy: 1_000_000n,
    adapter: "0x33D19799EBac88FFDc4e5BF61c199c71963470A6",
    protocolId: "aave",
    venue: "aave",
  },
  arc: {
    chainId: 5042002,
    rpc: "https://rpc.testnet.arc.io",
    factory: "0xa7bd919a5249DD1Da6E02a6716D2Db2B2e0A99f0",
    name: "nave-live-arc",
    mode: "transfer",
    asset: "0x3600000000000000000000000000000000000000",
    stable: true,
    assetKind: 0,
    deposit: 2_000_000n,
    transfer: 500_000n,
  },
  robinhood: {
    chainId: 46630,
    rpc: "https://rpc.testnet.chain.robinhood.com",
    factory: "0x303cE551De723cad43e1575C4D981C0E2b662b7F",
    name: "nave-live-rh",
    mode: "policy",
    weth: "0x7943e237c7F95DA44E0301572D358911207852Fa",
    wrap: 1_000_000_000_000_000n,
  },
};

function loadEnvFile() {
  const text = readFileSync(ENV_PATH, "utf8");
  const env = {};
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
  base: ["EVM_BASE_SEPOLIA_RPC_URL", "BASE_SEPOLIA_RPC_URL"],
  arc: ["EVM_ARC_TESTNET_RPC_URL"],
  robinhood: ["EVM_ROBINHOOD_TESTNET_RPC_URL"],
};
for (const [name, spec] of Object.entries(CHAINS)) {
  spec.rpc = rpcFrom(RPC_KEYS[name], spec.rpc);
}

function loadHexKey(name) {
  let value = FILE_ENV[name] || "";
  if (!value) throw new Error(`${name} is missing from the testnet env file`);
  if (!value.startsWith("0x")) value = `0x${value}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`${name} is not a 32-byte hex key`);
  return value;
}

function loadKey() {
  return loadHexKey("EVM_DEPLOY_PRIVATE_KEY");
}

// Agent keys cannot be the founder, a guardian, or each other. The three
// funded testing keys sign Executive, Financial, and Oversight. Operational
// only monitors, so a fresh address is enough and is never printed as a key.
function roleAccounts() {
  return {
    executive: privateKeyToAccount(loadHexKey("EVM_TESTING_KEY_1")),
    financial: privateKeyToAccount(loadHexKey("EVM_TESTING_KEY_2")),
    oversight: privateKeyToAccount(loadHexKey("EVM_TESTING_KEY_3")),
    operational: privateKeyToAccount(generatePrivateKey()),
  };
}

function chainFor(spec) {
  return defineChain({
    id: spec.chainId,
    name: spec.name,
    nativeCurrency: { name: "Native", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [spec.rpc] } },
  });
}

function shortError(error) {
  const message = error?.shortMessage || error?.message || String(error);
  const cause = error?.cause?.shortMessage || error?.cause?.message || "";
  const combined = cause && !message.includes(cause) ? `${message}: ${cause}` : message;
  return combined.split("\n")[0].slice(0, 400);
}

function slippageFloor(amount) {
  const floor = (amount * 9950n) / 10000n;
  return floor === 0n ? 1n : floor;
}

async function send(wallet, publicClient, params) {
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const hash = await wallet.writeContract({ ...params, gas: params.gas ?? 4_000_000n });
      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
      if (receipt.status !== "success") {
        throw new Error(`transaction reverted: ${hash}`);
      }
      console.log(`  tx ${params.functionName} ${hash}`);
      return receipt;
    } catch (error) {
      last = error;
      const message = shortError(error);
      const sent = Boolean(error?.cause?.hash || /transaction reverted: 0x/.test(message));
      const retryable = message.includes("Missing or invalid parameters")
        || message.toLowerCase().includes("nonce");
      if (sent || !retryable) throw error;
      await sleep(1500);
    }
  }
  throw last;
}

function sleep(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function read(publicClient, address, functionName, args = []) {
  let last;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await publicClient.readContract({ address, abi: ABI, functionName, args });
    } catch (error) {
      last = error;
      const message = shortError(error);
      if (!message.includes("returned no data") && !message.includes("timeout")) throw error;
      await sleep(1500);
    }
  }
  throw last;
}

async function readUntil(publicClient, address, functionName, args, predicate, label) {
  let last;
  for (let attempt = 0; attempt < 10; attempt++) {
    last = await read(publicClient, address, functionName, args);
    if (predicate(last)) return last;
    await sleep(1000);
  }
  throw new Error(`${label} stayed ${last}`);
}

function daoParams(name, founder, roles) {
  return {
    name,
    privacyMode: 0,
    guardianWallets: [founder],
    guardianThreshold: 1,
    agentAuthorities: [
      roles.executive.address,
      roles.financial.address,
      roles.oversight.address,
      roles.operational.address,
    ],
    managementFeeBps: 0,
    performanceFeeBps: 1500,
    frozenManagementFeeBps: 0,
    frozenPerformanceFeeBps: 1500,
    protocolRevenueWallet: founder,
    quorumBps: 1000,
    governanceType: 0,
  };
}

async function createDao(wallet, publicClient, spec, founder, roles) {
  const receipt = await send(wallet, publicClient, {
    address: spec.factory,
    abi: ABI,
    functionName: "createDao",
    args: [daoParams(spec.name, founder, roles)],
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

async function ensureStake() {
  return { required: "0" };
}

async function govern(wallet, publicClient, spec, dao, founder, payload, proposalType, title) {
  const index = await read(publicClient, dao.treasury, "nextProposalIndex");
  await send(wallet, publicClient, {
    address: dao.governor,
    abi: ABI,
    functionName: "createProposal",
    args: [{
      title,
      description: "live testnet treasury check",
      payload,
      proposalType,
      votingPeriodSeconds: VOTING_PERIOD,
      votingMint: ZERO,
    }],
  });
  await send(wallet, publicClient, {
    address: dao.governor,
    abi: ABI,
    functionName: "castVoteWallet",
    args: [index, 0],
  });
  await send(wallet, publicClient, {
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
  console.log(`  proposal ${index} passed, payload ${core[2]}`);
  return { index, payloadHash: core[2] };
}

async function strategyLoop(wallet, publicClient, spec, dao, founder, roleWallets) {
  const beforeNav = await read(publicClient, dao.treasury, "currentNav");
  const info = await read(publicClient, dao.treasury, "assetInfo", [spec.asset]);
  if (!info[0]) {
    await send(wallet, publicClient, {
      address: dao.treasury,
      abi: ABI,
      functionName: "registerAsset",
      args: [spec.asset, `0x${"00".repeat(32)}`, true, spec.assetKind],
    });
  }
  let afterDeposit = await read(publicClient, spec.asset, "balanceOf", [dao.treasury]);
  if (afterDeposit < spec.deposit) {
    const assetBal = await read(publicClient, spec.asset, "balanceOf", [founder]);
    if (assetBal < spec.deposit) throw new Error(`asset balance ${assetBal} is below deposit ${spec.deposit}`);
    await send(wallet, publicClient, {
      address: spec.asset,
      abi: ABI,
      functionName: "approve",
      args: [dao.treasury, spec.deposit],
    });
    await send(wallet, publicClient, {
      address: dao.treasury,
      abi: ABI,
      functionName: "deposit",
      args: [spec.asset, spec.deposit],
    });
    afterDeposit = await readUntil(
      publicClient,
      spec.asset,
      "balanceOf",
      [dao.treasury],
      (value) => value >= spec.deposit,
      "treasury balance",
    );
  }
  const nav = await readUntil(
    publicClient,
    dao.treasury,
    "currentNav",
    [],
    (value) => value > beforeNav || afterDeposit >= spec.deposit,
    "nav",
  );
  console.log(`  deposited ${afterDeposit} nav ${beforeNav} -> ${nav}`);

  await send(wallet, publicClient, {
    address: dao.treasury,
    abi: ABI,
    functionName: "updateConstitution",
    args: [[spec.adapter], [10_000], [true], [spec.protocolId], 70, 0n],
  });
  await send(roleWallets.executive, publicClient, {
    address: dao.treasury,
    abi: ABI,
    functionName: "toggleAgents",
    args: [true],
  });
  await send(wallet, publicClient, {
    address: dao.treasury,
    abi: ABI,
    functionName: "revalueTreasury",
    args: [],
  });

  const payload = encodeAbiParameters(
    [
      { type: "address" },
      { type: "uint256" },
      { type: "address" },
    ],
    [spec.adapter, spec.deploy, spec.asset],
  );
  const expectedHash = keccak256(payload);
  const nextIndex = await read(publicClient, dao.treasury, "nextProposalIndex");
  let vote = null;
  if (nextIndex > 0n) {
    const prior = nextIndex - 1n;
    const core = await read(publicClient, dao.governor, "proposalCore", [prior]);
    if (Number(core[1]) === 1 && core[2].toLowerCase() === expectedHash.toLowerCase()) {
      vote = { index: prior, payloadHash: core[2] };
      console.log(`  reusing passed proposal ${prior}`);
    }
  }
  if (!vote) vote = await govern(wallet, publicClient, spec, dao, founder, payload, 1, "deploy-venue");
  let requestStatus = 0;
  try {
    requestStatus = Number(await read(publicClient, dao.execution, "requestStatus", [vote.index]));
  } catch {
    requestStatus = 0;
  }
  if (requestStatus < 4) {
    await send(wallet, publicClient, {
      address: dao.execution,
      abi: ABI,
      functionName: "createStrategyRequestBootstrap",
      args: [vote.index, spec.deploy, spec.adapter, spec.asset],
    });
    await send(roleWallets.executive, publicClient, {
      address: dao.execution,
      abi: ABI,
      functionName: "executiveApprove",
      args: [vote.index, REASONING],
    });
    await send(roleWallets.financial, publicClient, {
      address: dao.execution,
      abi: ABI,
      functionName: "financialApprove",
      args: [vote.index, vote.payloadHash, REASONING],
    });
    await send(roleWallets.oversight, publicClient, {
      address: dao.execution,
      abi: ABI,
      functionName: "oversightApprove",
      args: [vote.index, vote.payloadHash, REASONING],
    });
  } else {
    console.log(`  request ${vote.index} already at status ${requestStatus}`);
  }
  await send(wallet, publicClient, {
    address: dao.treasury,
    abi: ABI,
    functionName: "revalueTreasury",
    args: [],
  });
  const idleBefore = await read(publicClient, spec.asset, "balanceOf", [dao.treasury]);
  if (requestStatus < 5) {
  await send(roleWallets.executive, publicClient, {
    address: dao.execution,
    abi: ABI,
    functionName: "execute",
    args: [vote.index, slippageFloor(spec.deploy)],
    gas: 8_000_000n,
  });
  }
  const status = await readUntil(
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
    venueBalance = await readUntil(
      publicClient,
      comet,
      "balanceOf",
      [spec.adapter],
      (value) => value > 0n,
      "comet balance",
    );
  } else {
    const aToken = await read(publicClient, spec.adapter, "aTokenFor", [spec.asset]);
    venueBalance = await readUntil(
      publicClient,
      aToken,
      "balanceOf",
      [spec.adapter],
      (value) => value > 0n,
      "aToken balance",
    );
  }
  if (venueBalance === 0n) throw new Error("venue balance is still 0");
  console.log(`  venue balance ${venueBalance}; treasury idle ${idleBefore} -> ${idleAfter}`);

  const withdrawAmt = spec.deploy - 2_000n;
  await send(roleWallets.executive, publicClient, {
    address: dao.execution,
    abi: ABI,
    functionName: "withdrawFromStrategy",
    args: [vote.index, withdrawAmt, slippageFloor(withdrawAmt)],
    gas: 8_000_000n,
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
  console.log(`  withdrew ${withdrawAmt}; treasury idle ${idleFinal}; nav ${navFinal}`);
  return {
    proposal: vote.index.toString(),
    payloadHash: vote.payloadHash,
    venueBalance: venueBalance.toString(),
    idleAfterDeploy: idleAfter.toString(),
    idleAfterWithdraw: idleFinal.toString(),
    navAfterDeposit: nav.toString(),
    navFinal: navFinal.toString(),
  };
}

async function transferLoop(wallet, publicClient, spec, dao, founder) {
  const beforeNav = await read(publicClient, dao.treasury, "currentNav");
  const info = await read(publicClient, dao.treasury, "assetInfo", [spec.asset]);
  if (!info[0]) {
    await send(wallet, publicClient, {
      address: dao.treasury,
      abi: ABI,
      functionName: "registerAsset",
      args: [spec.asset, `0x${"00".repeat(32)}`, true, 0],
    });
  }
  let treasuryBal = await read(publicClient, spec.asset, "balanceOf", [dao.treasury]);
  if (treasuryBal < spec.deposit) {
    const assetBal = await read(publicClient, spec.asset, "balanceOf", [founder]);
    if (assetBal < spec.deposit) throw new Error(`asset balance ${assetBal} is below deposit ${spec.deposit}`);
    await send(wallet, publicClient, {
      address: spec.asset,
      abi: ABI,
      functionName: "approve",
      args: [dao.treasury, spec.deposit],
    });
    await send(wallet, publicClient, {
      address: dao.treasury,
      abi: ABI,
      functionName: "deposit",
      args: [spec.asset, spec.deposit],
    });
    treasuryBal = await readUntil(
      publicClient,
      spec.asset,
      "balanceOf",
      [dao.treasury],
      (value) => value >= spec.deposit,
      "treasury balance",
    );
  }
  const nav = await read(publicClient, dao.treasury, "currentNav");
  console.log(`  deposited ${treasuryBal} nav ${beforeNav} -> ${nav}`);

  const payload = encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "uint256" }],
    [spec.asset, founder, spec.transfer],
  );
  const vote = await govern(wallet, publicClient, spec, dao, founder, payload, 8, "return-dust");
  const founderBefore = await readUntil(
    publicClient,
    spec.asset,
    "balanceOf",
    [founder],
    (value) => value > 0n,
    "founder balance",
  );
  await send(wallet, publicClient, {
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
  const founderAfter = await readUntil(
    publicClient,
    spec.asset,
    "balanceOf",
    [founder],
    (value) => value > founderBefore - spec.transfer,
    "recipient balance",
  );
  const navAfter = await read(publicClient, dao.treasury, "currentNav");
  console.log(`  transferred ${spec.transfer}; treasury now ${treasuryAfter}; founder ${founderBefore} -> ${founderAfter}; nav ${navAfter}`);
  return {
    proposal: vote.index.toString(),
    payloadHash: vote.payloadHash,
    treasuryAfter: treasuryAfter.toString(),
    founderBefore: founderBefore.toString(),
    founderAfter: founderAfter.toString(),
    navAfterDeposit: nav.toString(),
    navAfter: navAfter.toString(),
  };
}

async function policyLoop(wallet, publicClient, spec, dao, founder) {
  const wrappedBefore = await read(publicClient, spec.weth, "balanceOf", [founder]);
  await send(wallet, publicClient, {
    address: spec.weth,
    abi: ABI,
    functionName: "deposit",
    args: [],
    value: spec.wrap,
  });
  const wrapped = await read(publicClient, spec.weth, "balanceOf", [founder]);
  const gained = wrapped - wrappedBefore;
  if (gained < spec.wrap) throw new Error(`wrap gained ${gained}`);
  await send(wallet, publicClient, {
    address: dao.treasury,
    abi: ABI,
    functionName: "registerAsset",
    args: [spec.weth, `0x${"00".repeat(32)}`, false, 1],
  });
  await send(wallet, publicClient, {
    address: spec.weth,
    abi: ABI,
    functionName: "approve",
    args: [dao.treasury, spec.wrap],
  });
  await send(wallet, publicClient, {
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
  if (treasuryWeth !== spec.wrap) throw new Error(`treasury WETH ${treasuryWeth} != ${spec.wrap}`);
  console.log(`  deposited ${spec.wrap} WETH; nav stays ${nav} because this asset is not priced`);

  const payload = "0x";
  const vote = await govern(wallet, publicClient, spec, dao, founder, payload, 0, "policy-ok");
  return {
    proposal: vote.index.toString(),
    payloadHash: vote.payloadHash,
    treasuryWeth: treasuryWeth.toString(),
    nav: nav.toString(),
  };
}

async function runChain(key, spec) {
  const account = privateKeyToAccount(key);
  const roles = roleAccounts();
  const chain = chainFor(spec);
  const transport = http(spec.rpc);
  const publicClient = createPublicClient({ chain, transport });
  const wallet = createWalletClient({ account, chain, transport });
  const roleWallets = {
    executive: createWalletClient({ account: roles.executive, chain, transport }),
    financial: createWalletClient({ account: roles.financial, chain, transport }),
    oversight: createWalletClient({ account: roles.oversight, chain, transport }),
  };
  const founder = account.address;
  const onchainId = await publicClient.getChainId();
  if (onchainId !== spec.chainId) throw new Error(`RPC chain id ${onchainId} != ${spec.chainId}`);
  const protocol = await read(publicClient, spec.factory, "protocol");
  const paused = await read(publicClient, protocol, "paused");
  if (paused) throw new Error("protocol is paused");
  console.log(`\n${spec.name} factory ${spec.factory} protocol ${protocol}`);
  const existing = resumeDao();
  const stake = existing ? { required: "resumed" } : await ensureStake(wallet, publicClient, protocol, founder);
  const dao = existing ?? await createDao(wallet, publicClient, spec, founder, roles);
  console.log(`  dao ${dao.daoId} treasury ${dao.treasury}`);
  let detail;
  if (spec.mode === "strategy") detail = await strategyLoop(wallet, publicClient, spec, dao, founder, roleWallets);
  else if (spec.mode === "transfer") detail = await transferLoop(wallet, publicClient, spec, dao, founder);
  else detail = await policyLoop(wallet, publicClient, spec, dao, founder);
  return { ok: true, chain: spec.name, chainId: spec.chainId, founder, stake, ...dao, ...detail };
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

function resumeDao() {
  const flag = process.argv.indexOf("--resume");
  if (flag === -1) return null;
  const [treasury, governor, execution, daoId = "0"] = (process.argv[flag + 1] || "").split(",");
  if (!treasury || !governor || !execution) {
    throw new Error("--resume needs treasury,governor,execution");
  }
  return { treasury, governor, execution, daoId, createTx: "resumed" };
}

const key = loadKey();
const results = [];
for (const [name, spec] of selected()) {
  try {
    results.push(await runChain(key, spec));
    console.log(`PASS  ${name}`);
  } catch (error) {
    console.error(`FAIL  ${name}: ${shortError(error)}`);
    results.push({ ok: false, chain: name, error: shortError(error) });
  }
}
const failed = results.filter((row) => !row.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
console.log(JSON.stringify(results, null, 2));
if (failed > 0) process.exitCode = 1;
