// Arc Testnet viem definition. There is no Arc mainnet (chain id 5042) in this app.
//
// Native gas is USDC with 18 decimals. That is not the 6-decimal ERC-20 USDC
// at 0x3600000000000000000000000000000000000000, which is the only token the
// treasury balance readers treat as a treasury asset.
//
// The default RPC is the public endpoint (eth_chainId 0x4cef52). Override it
// with VITE_EVM_ARC_TESTNET_RPC_URL. Never put a secret-keyed URL in a VITE_ var.

import { defineChain } from 'viem';

/** Arc Testnet — chain id 5042002 (0x4cef52). */
export const arcTestnet = defineChain({
  id: 5042002,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://rpc.testnet.arc.network'] },
  },
  blockExplorers: {
    default: {
      name: 'Arc Explorer',
      url: 'https://explorer.testnet.arc.io',
    },
  },
  testnet: true,
});
