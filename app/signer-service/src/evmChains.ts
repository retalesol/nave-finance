// ─── Custom viem chain definitions (chains without viem built-ins) ────────────
//
// Robinhood Chain is an Arbitrum Nitro L2 (currency ETH). viem ships no
// built-in definition, so the canonical objects live here and are shared by the
// bridge relayer, staking mirror, and bridge watcher.
//
// Nitro notes that matter to this service:
//   • `block.number` on-chain is an L1 estimate — irrelevant here because the
//     Nave contracts key every window off `block.timestamp`, and this service
//     counts confirmations off receipt block numbers vs `eth_blockNumber`
//     (both L2 numbers from the same RPC, so the depth math is consistent).
//   • The sequencer gives soft confirmation instantly; hard L1 finality lags.
//     Confirmation depth is therefore configurable PER CHAIN via
//     BRIDGE_EVM_CONFIRMATIONS_<chainId> (see bridgeRelayer.ts).
//   • Sequencer tx screening means a screened tx simply never lands. The
//     relayer already tolerates that: waitForReceiptRobust throws, the row is
//     marked 'failed', and the watcher re-drives it (bounded by retry_count)
//     before parking it 'stuck'.
//   • Ordering is first-come-first-served — no priority-fee bumping is
//     assumed anywhere in this service (plain viem writeContract sends).
//
// The default RPC URLs below are the PUBLIC rate-limited endpoints (metadata /
// last-resort only — every code path passes an explicit env-configured
// transport). Keyed provider URLs (e.g. Alchemy) belong ONLY in env vars.

import { defineChain } from 'viem';

/** Robinhood Chain mainnet (chainId 4663, Arbitrum Nitro L2). */
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

/** Robinhood Chain testnet (chainId 46630, Arbitrum Nitro L2). */
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

/**
 * Arc Testnet (chainId 5042002). Native gas is USDC at 18 decimals.
 * Arc mainnet 5042 is not defined here.
 */
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
