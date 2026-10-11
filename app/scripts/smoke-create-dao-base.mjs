#!/usr/bin/env node
/**
 * Smoke: create one DAO on Base. Gas only — no NAVE stake approval or stake config change.
 * Uses SAFE_OWNER_PRIVATE_KEY as the founder wallet.
 */
import {
  createWalletClient,
  createPublicClient,
  http,
  parseAbi,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

const PROTOCOL = '0x377D976A31871060B4059fA244b76809A3Cc0C90';
const FACTORY = '0x280470c7275d630f1a9Fc1C406D4754D1f523Dbb';

const PROTOCOL_ABI = parseAbi([
  'function daoCount() view returns (uint256)',
]);
const FACTORY_ABI = parseAbi([
  'function createDao((string name,uint8 privacyMode,address[] guardianWallets,uint8 guardianThreshold,address[4] agentAuthorities,uint16 managementFeeBps,uint16 performanceFeeBps,uint16 frozenManagementFeeBps,uint16 frozenPerformanceFeeBps,address protocolRevenueWallet,uint16 quorumBps,uint8 governanceType) params) payable returns (uint256 daoId,address treasury,address governor,address execution)',
]);

async function main() {
  const key = process.env.SAFE_OWNER_PRIVATE_KEY;
  if (!key?.startsWith('0x')) throw new Error('SAFE_OWNER_PRIVATE_KEY required');
  const rpc = process.env.EVM_BASE_RPC_URL || 'https://mainnet.base.org';
  const account = privateKeyToAccount(key);
  const publicClient = createPublicClient({ chain: base, transport: http(rpc) });
  const walletClient = createWalletClient({ account, chain: base, transport: http(rpc) });

  const before = await publicClient.readContract({
    address: PROTOCOL,
    abi: PROTOCOL_ABI,
    functionName: 'daoCount',
  });

  const params = {
    name: `smoke-${Date.now()}`,
    privacyMode: 0,
    guardianWallets: [account.address],
    guardianThreshold: 1,
    agentAuthorities: [account.address, account.address, account.address, account.address],
    managementFeeBps: 0,
    performanceFeeBps: 1500,
    frozenManagementFeeBps: 0,
    frozenPerformanceFeeBps: 1500,
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
  console.log('SMOKE OK');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
