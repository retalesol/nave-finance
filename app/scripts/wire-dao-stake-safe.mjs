#!/usr/bin/env node
/**
 * Wire NaveProtocol DAO stake config via the protocol Safe (threshold 1).
 *
 * Requires SAFE_OWNER_PRIVATE_KEY for Safe owner:
 *   0x1FA9D4Ad76D53FbF1274d10ACBA12463ae90Bdca
 *
 * Usage:
 *   SAFE_OWNER_PRIVATE_KEY=0x… node scripts/wire-dao-stake-safe.mjs
 *   SAFE_OWNER_PRIVATE_KEY=0x… node scripts/wire-dao-stake-safe.mjs --chain base
 *   SAFE_OWNER_PRIVATE_KEY=0x… node scripts/wire-dao-stake-safe.mjs --chain robinhood
 */
import {
  createWalletClient,
  createPublicClient,
  http,
  encodeFunctionData,
  encodePacked,
  keccak256,
  toBytes,
  concat,
  pad,
  toHex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

const SAFE = '0xd338C8d0C3e28979D1cFec2f7C66769C796db89c';
const WNAVE = '0xFc04710C3F310f6ed84b441cf897a05807312358';
const REQUIRED = 0n; // forming a treasury locks no NAVE; the module can still release an existing lock

const CHAINS = {
  base: {
    id: 8453,
    name: 'Base',
    rpc: process.env.EVM_BASE_RPC_URL || process.env.VITE_EVM_BASE_RPC_URL || 'https://mainnet.base.org',
    protocol: '0x377D976A31871060B4059fA244b76809A3Cc0C90',
    daoStake: '0xA744784e186c549E490fE1c11F29Bc0aCd2277fd',
    chain: base,
  },
  robinhood: {
    id: 4663,
    name: 'Robinhood',
    rpc: process.env.EVM_ROBINHOOD_RPC_URL || process.env.VITE_EVM_ROBINHOOD_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com',
    protocol: '0xaA1BDf23dc9995Aad2035B921E9699CB9d54F29A',
    daoStake: '0xC95D4214ca9711cEd6e4ad261c33BfB7775c79D1',
    chain: {
      id: 4663,
      name: 'Robinhood Chain',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: ['https://rpc.mainnet.chain.robinhood.com'] } },
    },
  },
};

const SAFE_ABI = [
  {
    type: 'function',
    name: 'nonce',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'getTransactionHash',
    stateMutability: 'view',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
      { name: 'operation', type: 'uint8' },
      { name: 'safeTxGas', type: 'uint256' },
      { name: 'baseGas', type: 'uint256' },
      { name: 'gasPrice', type: 'uint256' },
      { name: 'gasToken', type: 'address' },
      { name: 'refundReceiver', type: 'address' },
      { name: '_nonce', type: 'uint256' },
    ],
    outputs: [{ type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'execTransaction',
    stateMutability: 'payable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
      { name: 'operation', type: 'uint8' },
      { name: 'safeTxGas', type: 'uint256' },
      { name: 'baseGas', type: 'uint256' },
      { name: 'gasPrice', type: 'uint256' },
      { name: 'gasToken', type: 'address' },
      { name: 'refundReceiver', type: 'address' },
      { name: 'signatures', type: 'bytes' },
    ],
    outputs: [{ type: 'bool' }],
  },
];

const PROTOCOL_ABI = [
  {
    type: 'function',
    name: 'setNaveStakeConfig',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'setDaoStake',
    inputs: [{ name: 'daoStake_', type: 'address' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'daoStake',
    inputs: [],
    outputs: [{ type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'requiredNaveStake',
    inputs: [],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'naveStakeToken',
    inputs: [],
    outputs: [{ type: 'address' }],
    stateMutability: 'view',
  },
];

const MULTISEND_CALLONLY = '0x9641d764fc13c8B624c04430C7356C1C7C8102e2';
const MULTISEND_ABI = [
  {
    type: 'function',
    name: 'multiSend',
    inputs: [{ name: 'transactions', type: 'bytes' }],
    outputs: [],
    stateMutability: 'payable',
  },
];

function packMultiSend(calls) {
  // Safe MultiSend encoding: (operation uint8, to address, value uint256, dataLength uint256, data bytes)*
  return concat(
    calls.map(({ to, data }) =>
      encodePacked(
        ['uint8', 'address', 'uint256', 'uint256', 'bytes'],
        [0, to, 0n, BigInt(Math.floor((data.length - 2) / 2)), data],
      ),
    ),
  );
}

function packSignature(owner, signature) {
  // eth_sign style: v adjusted; Safe expects r,s,v with owner sorted for threshold>1.
  // For threshold 1, a single ECDSA signature over the SafeTx hash works.
  return signature;
}

async function execSafeCall({ publicClient, walletClient, account, to, data, operation = 0 }) {
  const nonce = await publicClient.readContract({
    address: SAFE,
    abi: SAFE_ABI,
    functionName: 'nonce',
  });
  const safeTxGas = 0n;
  const baseGas = 0n;
  const gasPrice = 0n;
  const gasToken = '0x0000000000000000000000000000000000000000';
  const refundReceiver = '0x0000000000000000000000000000000000000000';
  const value = 0n;

  const txHash = await publicClient.readContract({
    address: SAFE,
    abi: SAFE_ABI,
    functionName: 'getTransactionHash',
    args: [to, value, data, operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver, nonce],
  });

  const signature = await account.sign({ hash: txHash });
  const packed = packSignature(account.address, signature);

  const hash = await walletClient.writeContract({
    address: SAFE,
    abi: SAFE_ABI,
    functionName: 'execTransaction',
    args: [to, value, data, operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver, packed],
    account,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') {
    throw new Error(`Safe exec failed: ${hash}`);
  }
  return hash;
}

async function wireChain(key, chainKey) {
  const cfg = CHAINS[chainKey];
  if (!cfg) throw new Error(`Unknown chain ${chainKey}`);
  const account = privateKeyToAccount(key);
  if (account.address.toLowerCase() !== '0x1fa9d4ad76d53fbf1274d10acba12463ae90bdca') {
    throw new Error(
      `Key derives to ${account.address}, expected Safe owner 0x1FA9D4Ad76D53FbF1274d10ACBA12463ae90Bdca`,
    );
  }

  const publicClient = createPublicClient({ chain: cfg.chain, transport: http(cfg.rpc) });
  const walletClient = createWalletClient({
    account,
    chain: cfg.chain,
    transport: http(cfg.rpc),
  });

  const [module, amount, token] = await Promise.all([
    publicClient.readContract({ address: cfg.protocol, abi: PROTOCOL_ABI, functionName: 'daoStake' }),
    publicClient.readContract({
      address: cfg.protocol,
      abi: PROTOCOL_ABI,
      functionName: 'requiredNaveStake',
    }),
    publicClient.readContract({
      address: cfg.protocol,
      abi: PROTOCOL_ABI,
      functionName: 'naveStakeToken',
    }),
  ]);

  console.log(`[${cfg.name}] current stake:`, { module, amount: amount.toString(), token });
  if (
    module.toLowerCase() === cfg.daoStake.toLowerCase() &&
    amount === REQUIRED &&
    token.toLowerCase() === WNAVE.toLowerCase()
  ) {
    console.log(`[${cfg.name}] already wired — skip`);
    return;
  }

  const dataConfig = encodeFunctionData({
    abi: PROTOCOL_ABI,
    functionName: 'setNaveStakeConfig',
    args: [WNAVE, REQUIRED],
  });
  const dataModule = encodeFunctionData({
    abi: PROTOCOL_ABI,
    functionName: 'setDaoStake',
    args: [cfg.daoStake],
  });

  const packed = packMultiSend([
    { to: cfg.protocol, data: dataConfig },
    { to: cfg.protocol, data: dataModule },
  ]);
  const multiData = encodeFunctionData({
    abi: MULTISEND_ABI,
    functionName: 'multiSend',
    args: [packed],
  });

  console.log(`[${cfg.name}] executing Safe MultiSend (setNaveStakeConfig + setDaoStake)…`);
  // operation=1 DelegateCall for MultiSendCallOnly
  const hash = await execSafeCall({
    publicClient,
    walletClient,
    account,
    to: MULTISEND_CALLONLY,
    data: multiData,
    operation: 1,
  });
  console.log(`[${cfg.name}] Safe tx: ${hash}`);

  const [module2, amount2, token2] = await Promise.all([
    publicClient.readContract({ address: cfg.protocol, abi: PROTOCOL_ABI, functionName: 'daoStake' }),
    publicClient.readContract({
      address: cfg.protocol,
      abi: PROTOCOL_ABI,
      functionName: 'requiredNaveStake',
    }),
    publicClient.readContract({
      address: cfg.protocol,
      abi: PROTOCOL_ABI,
      functionName: 'naveStakeToken',
    }),
  ]);
  console.log(`[${cfg.name}] wired:`, { module: module2, amount: amount2.toString(), token: token2 });
  if (
    module2.toLowerCase() !== cfg.daoStake.toLowerCase() ||
    amount2 !== REQUIRED ||
    token2.toLowerCase() !== WNAVE.toLowerCase()
  ) {
    throw new Error(`[${cfg.name}] post-condition failed`);
  }
}

async function main() {
  const key = process.env.SAFE_OWNER_PRIVATE_KEY;
  if (!key?.startsWith('0x')) {
    console.error('Set SAFE_OWNER_PRIVATE_KEY=0x… (Safe owner 0x1FA9…Bdca)');
    process.exit(1);
  }
  const arg = process.argv.find((a) => a.startsWith('--chain='))?.slice('--chain='.length);
  const idx = process.argv.indexOf('--chain');
  const chainArg = arg || (idx >= 0 ? process.argv[idx + 1] : null);
  const chains = chainArg ? [chainArg] : ['base', 'robinhood'];
  for (const c of chains) {
    await wireChain(key, c);
  }
  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
