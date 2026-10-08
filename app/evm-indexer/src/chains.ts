import { defineChain } from 'viem';
import { base, baseSepolia, mainnet, sepolia } from 'viem/chains';
import type { Chain } from 'viem';

// Supported EVM chains — Ethereum, Base and Robinhood Chain ONLY (mainnets +
// their testnets). There is NO other EVM network in scope (no BSC / Polygon).
// This is the worker-side mirror of supabase/functions/_shared/chain.ts.

export type ChainKind = 'ethereum' | 'base' | 'robinhood';

// Robinhood Chain (Arbitrum Nitro L2, currency ETH) has no viem built-in.
// Default RPCs are the public endpoints; keyed provider URLs (Alchemy) come in
// via the rpcEnv vars below and are what the indexer actually dials.
export const robinhood: Chain = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.mainnet.chain.robinhood.com'] } },
  blockExplorers: {
    default: { name: 'Blockscout', url: 'https://robinhoodchain.blockscout.com' },
  },
});

export const robinhoodTestnet: Chain = defineChain({
  id: 46630,
  name: 'Robinhood Chain Testnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.testnet.chain.robinhood.com'] } },
  blockExplorers: {
    default: { name: 'Blockscout', url: 'https://explorer.testnet.chain.robinhood.com' },
  },
  testnet: true,
});

export interface EvmChainConfig {
  chainId: number;
  chain: ChainKind;
  /** Human label for logs. */
  label: string;
  /** viem chain definition. */
  viemChain: Chain;
  /** Env var holding the RPC URL (Alchemy / Ankr / any JSON-RPC). */
  rpcEnv: string;
  /** Optional per-chain start-block override env var. */
  startBlockEnv: string;
  /** Optional per-chain address allowlist env var (comma-separated 0x addrs). */
  watchAddressesEnv: string;
}

export const EVM_CHAINS: EvmChainConfig[] = [
  {
    chainId: 1,
    chain: 'ethereum',
    label: 'Ethereum',
    viemChain: mainnet,
    rpcEnv: 'EVM_ETHEREUM_RPC_URL',
    startBlockEnv: 'NAVE_EVM_START_BLOCK_1',
    watchAddressesEnv: 'NAVE_EVM_WATCH_ADDRESSES_1',
  },
  {
    chainId: 11155111,
    chain: 'ethereum',
    label: 'Sepolia',
    viemChain: sepolia,
    rpcEnv: 'EVM_SEPOLIA_RPC_URL',
    startBlockEnv: 'NAVE_EVM_START_BLOCK_11155111',
    watchAddressesEnv: 'NAVE_EVM_WATCH_ADDRESSES_11155111',
  },
  {
    chainId: 8453,
    chain: 'base',
    label: 'Base',
    viemChain: base,
    rpcEnv: 'EVM_BASE_RPC_URL',
    startBlockEnv: 'NAVE_EVM_START_BLOCK_8453',
    watchAddressesEnv: 'NAVE_EVM_WATCH_ADDRESSES_8453',
  },
  {
    chainId: 84532,
    chain: 'base',
    label: 'Base Sepolia',
    viemChain: baseSepolia,
    rpcEnv: 'EVM_BASE_SEPOLIA_RPC_URL',
    startBlockEnv: 'NAVE_EVM_START_BLOCK_84532',
    watchAddressesEnv: 'NAVE_EVM_WATCH_ADDRESSES_84532',
  },
  {
    chainId: 4663,
    chain: 'robinhood',
    label: 'Robinhood',
    viemChain: robinhood,
    rpcEnv: 'EVM_ROBINHOOD_RPC_URL',
    startBlockEnv: 'NAVE_EVM_START_BLOCK_4663',
    watchAddressesEnv: 'NAVE_EVM_WATCH_ADDRESSES_4663',
  },
  {
    chainId: 46630,
    chain: 'robinhood',
    label: 'Robinhood Testnet',
    viemChain: robinhoodTestnet,
    rpcEnv: 'EVM_ROBINHOOD_TESTNET_RPC_URL',
    startBlockEnv: 'NAVE_EVM_START_BLOCK_46630',
    watchAddressesEnv: 'NAVE_EVM_WATCH_ADDRESSES_46630',
  },
];

/** Chains that have an RPC URL configured are the ones we actually index. */
export function enabledChains(): Array<EvmChainConfig & { rpcUrl: string }> {
  const out: Array<EvmChainConfig & { rpcUrl: string }> = [];
  for (const c of EVM_CHAINS) {
    const rpcUrl = process.env[c.rpcEnv];
    if (rpcUrl && rpcUrl.trim()) out.push({ ...c, rpcUrl: rpcUrl.trim() });
  }
  return out;
}
