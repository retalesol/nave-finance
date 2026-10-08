// ─── Robinhood Chain viem definitions (no viem built-in exists) ───────────────
// Robinhood Chain is an Arbitrum Nitro L2 (currency ETH). DAO treasuries are
// supported; local DeFi is limited so agents bridge WETH out to Ethereum for yield.
//
// Default RPCs are the chain's PUBLIC endpoints (verified to return chain ids
// 0x1237 / 0xb626). A deployment can override them with the (public, non-keyed)
// VITE_EVM_ROBINHOOD*_RPC_URL vars — never put a secret-keyed provider URL in a
// VITE_ var, it ends up in the browser bundle.

import { defineChain } from 'viem';

/** Robinhood Chain mainnet — chain id 4663 (0x1237). */
export const robinhood = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://rpc.mainnet.chain.robinhood.com'] },
  },
  blockExplorers: {
    default: {
      name: 'Blockscout',
      url: 'https://robinhoodchain.blockscout.com',
      apiUrl: 'https://robinhoodchain.blockscout.com/api',
    },
  },
});

/** Robinhood Chain testnet — chain id 46630 (0xb626). */
export const robinhoodTestnet = defineChain({
  id: 46630,
  name: 'Robinhood Chain Testnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://rpc.testnet.chain.robinhood.com'] },
  },
  blockExplorers: {
    default: {
      name: 'Blockscout',
      url: 'https://explorer.testnet.chain.robinhood.com',
      apiUrl: 'https://explorer.testnet.chain.robinhood.com/api',
    },
  },
  testnet: true,
});
