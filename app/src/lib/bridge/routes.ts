// ─── NAVE bridge routes + quoting (trusted-relayer MVP) ──────────────────────
// Enumerates the supported testnet bridge routes and computes on-top fee quotes
// (NAVE_BRIDGE_FEE_BPS, 2.5% by default).
// A route is "supported" only when its EVM leg is in the active EVM network AND
// has a WrappedNave contract address configured — otherwise there is nothing to
// mint/burn against, so the route is hidden.

import {
  ACTIVE_EVM_CHAIN_IDS,
  EVM_WRAPPED_NAVE_ADDRESSES,
  NAVE_BRIDGE_FEE_BPS,
  computeBridgeFee,
} from '../programConfig';
import { evmTarget, type EvmChainId } from '../chain/types';
import type { BridgeQuote, BridgeRoute } from './types';

/** True when the given EVM chain id has a WrappedNave contract configured. */
export function hasWrappedNave(chainId: EvmChainId): boolean {
  const addr = EVM_WRAPPED_NAVE_ADDRESSES[chainId];
  return typeof addr === 'string' && addr.trim() !== '';
}

/**
 * Build the supported bridge routes for the active EVM network. For every active
 * EVM chain that has a WrappedNave address, both directions are produced:
 * Solana→EVM (lock) and EVM→Solana (burn).
 */
export function getSupportedBridgeRoutes(): BridgeRoute[] {
  const routes: BridgeRoute[] = [];
  for (const chainId of ACTIVE_EVM_CHAIN_IDS) {
    if (!hasWrappedNave(chainId)) continue;
    const evmFamily = evmTarget(chainId).family; // 'ethereum' | 'base' | 'robinhood'
    routes.push({
      from: 'solana',
      to: evmFamily,
      direction: 'solana_to_evm',
      evmChainId: chainId,
    });
    routes.push({
      from: evmFamily,
      to: 'solana',
      direction: 'evm_to_solana',
      evmChainId: chainId,
    });
  }
  return routes;
}

/**
 * Compute a 2.5%-on-top fee quote. `netRaw` is the amount the user wants to
 * bridge; the quote reports the gross they part with plus the three-way split.
 */
export function quoteBridge(netRaw: bigint): BridgeQuote {
  const { grossRaw, feeRaw, stakingRaw, protocolRaw, burnRaw } = computeBridgeFee(netRaw);
  return { netRaw, grossRaw, feeRaw, stakingRaw, protocolRaw, burnRaw, feeBps: NAVE_BRIDGE_FEE_BPS };
}
