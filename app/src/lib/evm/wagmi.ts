// ─── wagmi / RainbowKit configuration (Ethereum + Base + Robinhood) ───────────
// Active chains follow `EVM_DEPLOYMENT_MODE` so mixed deployments register
// Sepolia + Base mainnet + Robinhood mainnet together.

import { getDefaultConfig } from '@rainbow-me/rainbowkit';
import { http, type Transport } from 'wagmi';
import { mainnet, base, sepolia, baseSepolia } from 'wagmi/chains';
import type { Chain } from 'viem';
import { robinhood, robinhoodTestnet } from './robinhoodChains';
import { arcTestnet } from './arcChains';
import {
  EVM_DEPLOYMENT_MODE,
  EVM_RPC_URLS,
  WALLETCONNECT_PROJECT_ID,
} from '../programConfig';
import type { EvmChainId } from '../chain/types';

/** viem/wagmi chain object for each supported chain id (closed set). */
export const WAGMI_CHAIN_BY_ID: Record<EvmChainId, Chain> = {
  1: mainnet,
  8453: base,
  4663: robinhood,
  11155111: sepolia,
  84532: baseSepolia,
  46630: robinhoodTestnet,
  5042002: arcTestnet,
};

const MAINNET_CHAINS: readonly [Chain, ...Chain[]] = [mainnet, base, robinhood];
const TESTNET_CHAINS: readonly [Chain, ...Chain[]] = [sepolia, baseSepolia, robinhoodTestnet, arcTestnet];
/** Mixed cutover: Ethereum Sepolia + Base mainnet + Robinhood mainnet. */
const MIXED_CHAINS: readonly [Chain, ...Chain[]] = [sepolia, base, robinhood];

const activeChains =
  EVM_DEPLOYMENT_MODE === 'mainnet'
    ? MAINNET_CHAINS
    : EVM_DEPLOYMENT_MODE === 'mixed'
      ? MIXED_CHAINS
      : TESTNET_CHAINS;

/** Build per-chain transports, preferring configured RPC URLs over public RPC. */
const transports: Record<number, Transport> = {};
for (const chain of activeChains) {
  const override = EVM_RPC_URLS[chain.id as EvmChainId];
  transports[chain.id] = override ? http(override) : http();
}

/**
 * Shared wagmi config consumed by both the React provider tree and the
 * imperative `@wagmi/core` actions used in the EVM transaction path.
 */
export const wagmiConfig = getDefaultConfig({
  appName: 'Nave',
  projectId: WALLETCONNECT_PROJECT_ID,
  chains: activeChains,
  transports,
  ssr: false,
});
