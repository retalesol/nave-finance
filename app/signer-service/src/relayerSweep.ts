/**
 * Sweep a relayer that holds more than 0.05 ETH (or the Arc USDC equivalent)
 * down to that reserve. The only recipient is the protocol revenue wallet
 * (`NaveProtocol.protocolTreasury`). Keys are never logged.
 *
 * Arc testnet gas is 18-decimal USDC. When the oracle has no fresh ETH price,
 * the reserve uses ARC_TESTNET_ETH_USD_MICRO ($2,500 / ETH), the same
 * documented constant as the contracts.
 */
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  http,
  parseEther,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arcTestnet, robinhood, robinhoodTestnet } from './evmChains.js';
import { mainnet, base, sepolia, baseSepolia, type Chain } from 'viem/chains';
import { rpcUrlFor } from './evmRelayer.js';
import { isEvmChainId } from './evmSigner.js';

export const RELAYER_SWEEP_RESERVE_WEI = parseEther('0.05');
export const ARC_CHAIN_ID = 5042002;
/** $2,500.00 per ETH, micro-USD. 0.05 ETH = $125. */
export const ARC_TESTNET_ETH_USD_MICRO = 2_500_000_000n;

const TESTNET_CHAIN_IDS = [11155111, 84532, 46630, 5042002] as const;
const MAINNET_CHAIN_IDS = [1, 8453, 4663] as const;

/** Pinned testnet protocol singletons. Mainnet stays env-only. */
const TESTNET_PROTOCOL: Record<number, Address> = {
  11155111: '0x6C07BC6A22d2D18E232D546Ab06B6F49115834C8',
  84532: '0x6C07BC6A22d2D18E232D546Ab06B6F49115834C8',
  46630: '0x6C07BC6A22d2D18E232D546Ab06B6F49115834C8',
  5042002: '0x6C07BC6A22d2D18E232D546Ab06B6F49115834C8',
};

const protocolAbi = [
  {
    type: 'function',
    name: 'protocolTreasury',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'relayer',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'factory',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'wrappedNative',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'ethUsdFeedId',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'bytes32' }],
  },
] as const;

const factoryAbi = [
  {
    type: 'function',
    name: 'oracle',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
] as const;

const oracleAbi = [
  {
    type: 'function',
    name: 'hasFreshPrice',
    stateMutability: 'view',
    inputs: [
      { name: 'asset', type: 'address' },
      { name: 'pythFeedId', type: 'bytes32' },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'valueUsd',
    stateMutability: 'view',
    inputs: [
      { name: 'asset', type: 'address' },
      { name: 'pythFeedId', type: 'bytes32' },
      { name: 'decimals', type: 'uint8' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'uint256' }],
  },
] as const;

export function sweepExcess(balance: bigint, reserve: bigint): bigint {
  if (balance <= reserve) return 0n;
  return balance - reserve;
}

function loadOpsAccount() {
  const raw = (process.env.NAVE_EVM_OPS_PRIVATE_KEY || process.env.EVM_OPS_PRIVATE_KEY || '').trim();
  if (!raw) return null;
  const hex = (raw.startsWith('0x') ? raw : `0x${raw}`) as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) {
    console.error('[relayer-sweep] ops key is set but is not a 32-byte hex key.');
    return null;
  }
  try {
    return privateKeyToAccount(hex);
  } catch {
    console.error('[relayer-sweep] ops key could not be parsed.');
    return null;
  }
}

function protocolAddress(chainId: number): Address | null {
  const envName = `NAVE_EVM_PROTOCOL_${chainId}`;
  const fromEnv = process.env[envName]?.trim();
  if (fromEnv && /^0x[0-9a-fA-F]{40}$/.test(fromEnv)) return fromEnv as Address;
  return TESTNET_PROTOCOL[chainId] ?? null;
}

function chainsToSweep(): number[] {
  const includeMainnet = process.env.NAVE_RELAYER_SWEEP_INCLUDE_MAINNET === 'true';
  return [...TESTNET_CHAIN_IDS, ...(includeMainnet ? MAINNET_CHAIN_IDS : [])];
}

async function arcReserveWei(
  client: ReturnType<typeof createPublicClient>,
  protocol: Address,
): Promise<bigint> {
  const fallback = (RELAYER_SWEEP_RESERVE_WEI * ARC_TESTNET_ETH_USD_MICRO) / 10n ** 18n * 10n ** 12n;
  try {
    const factory = await client.readContract({
      address: protocol,
      abi: protocolAbi,
      functionName: 'factory',
    });
    const oracle = await client.readContract({
      address: factory as Address,
      abi: factoryAbi,
      functionName: 'oracle',
    });
    const weth = await client.readContract({
      address: protocol,
      abi: protocolAbi,
      functionName: 'wrappedNative',
    });
    const feed = await client.readContract({
      address: protocol,
      abi: protocolAbi,
      functionName: 'ethUsdFeedId',
    });
    if (!weth || weth === '0x0000000000000000000000000000000000000000') return fallback;
    const fresh = await client.readContract({
      address: oracle as Address,
      abi: oracleAbi,
      functionName: 'hasFreshPrice',
      args: [weth as Address, feed as Hex],
    });
    if (!fresh) return fallback;
    const micro = await client.readContract({
      address: oracle as Address,
      abi: oracleAbi,
      functionName: 'valueUsd',
      args: [weth as Address, feed as Hex, 18, RELAYER_SWEEP_RESERVE_WEI],
    });
    if (typeof micro !== 'bigint' || micro <= 0n) return fallback;
    return micro * 10n ** 12n;
  } catch {
    return fallback;
  }
}

async function sweepChain(chainId: number, account: ReturnType<typeof privateKeyToAccount>): Promise<void> {
  if (!isEvmChainId(chainId)) return;
  let rpc: string;
  try {
    rpc = rpcUrlFor(chainId);
  } catch {
    return;
  }
  const protocol = protocolAddress(chainId);
  if (!protocol) return;

  const transport = http(rpc);
  const publicClient = createPublicClient({ transport });
  let revenue: Address;
  try {
    revenue = await publicClient.readContract({
      address: protocol,
      abi: protocolAbi,
      functionName: 'protocolTreasury',
    }) as Address;
  } catch (err) {
    console.error(`[relayer-sweep] chain ${chainId}: could not read protocol revenue wallet (${err instanceof Error ? err.message : err})`);
    return;
  }
  if (!revenue || revenue === '0x0000000000000000000000000000000000000000') return;
  if (revenue.toLowerCase() === account.address.toLowerCase()) return;

  try {
    const onchainRelayer = await publicClient.readContract({
      address: protocol,
      abi: protocolAbi,
      functionName: 'relayer',
    }) as Address;
    if (
      onchainRelayer
      && onchainRelayer !== '0x0000000000000000000000000000000000000000'
      && onchainRelayer.toLowerCase() !== account.address.toLowerCase()
    ) {
      console.warn(`[relayer-sweep] chain ${chainId}: protocol relayer is not this ops wallet; skipping`);
      return;
    }
  } catch {
    // Older protocols have no relayer() getter. The ops wallet is the relayer.
  }

  const balance = await publicClient.getBalance({ address: account.address });
  const reserve = chainId === ARC_CHAIN_ID ? await arcReserveWei(publicClient, protocol) : RELAYER_SWEEP_RESERVE_WEI;
  const excess = sweepExcess(balance, reserve);
  if (excess === 0n) return;

  const gas = 21_000n;
  const gasPrice = await publicClient.getGasPrice();
  const gasCost = gas * gasPrice * 2n;
  if (excess <= gasCost) return;
  const value = excess - gasCost;

  const viemChain = chainFor(chainId);
  const wallet = createWalletClient({ account, chain: viemChain, transport });
  const hash = await wallet.sendTransaction({ account, to: revenue, value, chain: viemChain });
  console.log(
    `[relayer-sweep] chain ${chainId}: sent ${formatEther(value)} native to protocol revenue, leaving the ${formatEther(reserve)} reserve (${hash})`,
  );
}

function chainFor(chainId: number): Chain {
  const table: Record<number, Chain> = {
    1: mainnet,
    8453: base,
    11155111: sepolia,
    84532: baseSepolia,
    4663: robinhood,
    46630: robinhoodTestnet,
    5042002: arcTestnet,
  };
  const chain = table[chainId];
  if (!chain) throw new Error(`no viem chain for ${chainId}`);
  return chain;
}

/** Read relayer balances and sweep anything above the reserve to protocol revenue. */
export async function runRelayerSweep(): Promise<void> {
  const account = loadOpsAccount();
  if (!account) return;
  for (const chainId of chainsToSweep()) {
    try {
      await sweepChain(chainId, account);
    } catch (err) {
      console.error(`[relayer-sweep] chain ${chainId}:`, err instanceof Error ? err.message : err);
    }
  }
}
