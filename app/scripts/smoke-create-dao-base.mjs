#!/usr/bin/env node
/**
 * Smoke: temporarily set a tiny stake, create one DAO on Base, restore $99 stake.
 * Uses SAFE_OWNER_PRIVATE_KEY (0x1FA9…) as founder + Safe signer.
 */
import {
  createWalletClient,
  createPublicClient,
  http,
  encodeFunctionData,
  encodePacked,
  concat,
  parseAbi,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

const SAFE = '0xd338C8d0C3e28979D1cFec2f7C66769C796db89c';
const PROTOCOL = '0x377D976A31871060B4059fA244b76809A3Cc0C90';
const FACTORY = '0x280470c7275d630f1a9Fc1C406D4754D1f523Dbb';
const WNAVE = '0xFc04710C3F310f6ed84b441cf897a05807312358';
const DAO_STAKE = '0xA744784e186c549E490fE1c11F29Bc0aCd2277fd';
const FULL_STAKE = 472010724n; // ≈ $19; keep in sync with Safe setNaveStakeConfig
const SMOKE_STAKE = 100000n; // 0.1 wNAVE
const MULTISEND = '0x9641d764fc13c8B624c04430C7356C1C7C8102e2';
const ZERO = '0x0000000000000000000000000000000000000000';

const SAFE_ABI = parseAbi([
  'function nonce() view returns (uint256)',
  'function getTransactionHash(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 _nonce) view returns (bytes32)',
  'function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns (bool)',
]);
const PROTOCOL_ABI = parseAbi([
  'function setNaveStakeConfig(address token,uint256 amount)',
  'function requiredNaveStake() view returns (uint256)',
  'function daoCount() view returns (uint256)',
]);
const ERC20_ABI = parseAbi([
  'function approve(address spender,uint256 amount) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
]);
const FACTORY_ABI = parseAbi([
  'function createDao((string name,uint8 privacyMode,address[] guardianWallets,uint8 guardianThreshold,address[4] agentAuthorities,uint16 managementFeeBps,uint16 performanceFeeBps,uint16 frozenManagementFeeBps,uint16 frozenPerformanceFeeBps,address protocolRevenueWallet,uint16 quorumBps,uint8 governanceType) params) payable returns (uint256 daoId,address treasury,address governor,address execution)',
]);
const MULTISEND_ABI = parseAbi(['function multiSend(bytes transactions) payable']);

async function safeExec(publicClient, walletClient, account, to, data, operation = 0) {
  const nonce = await publicClient.readContract({ address: SAFE, abi: SAFE_ABI, functionName: 'nonce' });
  const txHash = await publicClient.readContract({
    address: SAFE,
    abi: SAFE_ABI,
    functionName: 'getTransactionHash',
    args: [to, 0n, data, operation, 0n, 0n, 0n, ZERO, ZERO, nonce],
  });
  const signature = await account.sign({ hash: txHash });
  const hash = await walletClient.writeContract({
    address: SAFE,
    abi: SAFE_ABI,
    functionName: 'execTransaction',
    args: [to, 0n, data, operation, 0n, 0n, 0n, ZERO, ZERO, signature],
    account,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`Safe failed ${hash}`);
  return hash;
}

async function setStake(publicClient, walletClient, account, amount) {
  const data = encodeFunctionData({
    abi: PROTOCOL_ABI,
    functionName: 'setNaveStakeConfig',
    args: [WNAVE, amount],
  });
  return safeExec(publicClient, walletClient, account, PROTOCOL, data, 0);
}

async function main() {
  const key = process.env.SAFE_OWNER_PRIVATE_KEY;
  if (!key?.startsWith('0x')) throw new Error('SAFE_OWNER_PRIVATE_KEY required');
  const rpc = process.env.EVM_BASE_RPC_URL || 'https://mainnet.base.org';
  const account = privateKeyToAccount(key);
  const publicClient = createPublicClient({ chain: base, transport: http(rpc) });
  const walletClient = createWalletClient({ account, chain: base, transport: http(rpc) });

  const bal = await publicClient.readContract({
    address: WNAVE,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [account.address],
  });
  console.log('founder', account.address, 'wNAVE', bal.toString());
  if (bal < SMOKE_STAKE) throw new Error('insufficient wNAVE for smoke stake');

  const before = await publicClient.readContract({
    address: PROTOCOL,
    abi: PROTOCOL_ABI,
    functionName: 'daoCount',
  });

  console.log('lowering stake to', SMOKE_STAKE.toString());
  await setStake(publicClient, walletClient, account, SMOKE_STAKE);
  await new Promise((r) => setTimeout(r, 2000));

  console.log('approving daoStake');
  const approveHash = await walletClient.writeContract({
    address: WNAVE,
    abi: ERC20_ABI,
    functionName: 'approve',
    args: [DAO_STAKE, SMOKE_STAKE],
    account,
  });
  await publicClient.waitForTransactionReceipt({ hash: approveHash });

  const params = {
    name: `smoke-${Date.now()}`,
    privacyMode: 0,
    guardianWallets: [account.address],
    guardianThreshold: 1,
    agentAuthorities: [account.address, account.address, account.address, account.address],
    managementFeeBps: 65,
    performanceFeeBps: 850,
    frozenManagementFeeBps: 0,
    frozenPerformanceFeeBps: 0,
    protocolRevenueWallet: account.address,
    quorumBps: 1000,
    governanceType: 0,
  };

  console.log('createDao…');
  const createHash = await walletClient.writeContract({
    address: FACTORY,
    abi: FACTORY_ABI,
    functionName: 'createDao',
    args: [params],
    value: 0n,
    account,
  });
  const createReceipt = await publicClient.waitForTransactionReceipt({ hash: createHash });
  if (createReceipt.status !== 'success') throw new Error(`createDao failed ${createHash}`);
  console.log('createDao tx', createHash);

  const after = await publicClient.readContract({
    address: PROTOCOL,
    abi: PROTOCOL_ABI,
    functionName: 'daoCount',
  });
  console.log('daoCount', before.toString(), '->', after.toString());
  if (after <= before) throw new Error('daoCount did not increase');

  console.log('restoring full $99 stake');
  await setStake(publicClient, walletClient, account, FULL_STAKE);
  await new Promise((r) => setTimeout(r, 2000));
  const required = await publicClient.readContract({
    address: PROTOCOL,
    abi: PROTOCOL_ABI,
    functionName: 'requiredNaveStake',
  });
  console.log('requiredNaveStake', required.toString());
  if (required !== FULL_STAKE) throw new Error('failed to restore full stake');
  console.log('SMOKE OK');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
