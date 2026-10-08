/**
 * Agent-automated treasury capital bridges (CCTP / OP / Arbitrum).
 *
 * Env gates (all default off):
 *   NAVE_BRIDGE_OUTBOUND_ENABLED=true
 *   NAVE_BRIDGE_FINALIZE_ENABLED=true
 *
 * Allowlists:
 *   USDC / WETH / ETH only; destination must match on-chain linkedTreasury.
 */
import { EVM_CHAIN_IDS, SUPPORTED_EVM_CHAIN_IDS } from './chain.ts';

export const BRIDGE_OUTBOUND_ENABLED =
  (Deno.env.get('NAVE_BRIDGE_OUTBOUND_ENABLED') ?? 'false').toLowerCase() === 'true';
export const BRIDGE_FINALIZE_ENABLED =
  (Deno.env.get('NAVE_BRIDGE_FINALIZE_ENABLED') ?? 'false').toLowerCase() === 'true';

/**
 * Destination-side finalize guard for CCTP attestations / L2 message claims.
 * Callers must still implement the chain-specific receive path; this enforces
 * the env gate + basic input sanity so finalize cannot run when disabled.
 */
export function bridgeFinalizeGuardrailsOk(params: {
  enabled?: boolean;
  destChainId: number;
  correlationId?: string;
}): { ok: true } | { ok: false; reason: string } {
  const enabled = params.enabled ?? BRIDGE_FINALIZE_ENABLED;
  if (!enabled) {
    return { ok: false, reason: 'NAVE_BRIDGE_FINALIZE_ENABLED is false' };
  }
  // Every supported EVM chain (Ethereum / Base / Robinhood + testnets) is a
  // valid finalize destination — corridors below define 1↔8453 and 1↔4663.
  if (!SUPPORTED_EVM_CHAIN_IDS.has(params.destChainId)) {
    return {
      ok: false,
      reason: `finalize unsupported on dest chain ${params.destChainId} (expect Eth/Base/Robinhood)`,
    };
  }
  if (params.correlationId !== undefined && params.correlationId.length === 0) {
    return { ok: false, reason: 'correlationId must be non-empty when provided' };
  }
  return { ok: true };
}

/** Assets agents may bridge (lowercase addresses populated per chain at runtime). */
export const BRIDGE_ASSET_SYMBOLS = new Set(['USDC', 'WETH', 'ETH']);

export type BridgeCorridor =
  | { kind: 'cctp'; from: number; to: number }
  | { kind: 'op-standard-bridge'; from: number; to: number }
  | { kind: 'arbitrum-bridge'; from: number; to: number };

export function resolveBridgeCorridor(
  sourceChainId: number,
  destChainId: number,
  assetSymbol: string,
): BridgeCorridor | null {
  const sym = assetSymbol.toUpperCase();
  const ETH = EVM_CHAIN_IDS.ethereum.mainnet;
  const BASE = EVM_CHAIN_IDS.base.mainnet;
  const RH = EVM_CHAIN_IDS.robinhood.mainnet;
  const isPair = (a: number, b: number) =>
    (sourceChainId === a && destChainId === b) || (sourceChainId === b && destChainId === a);
  if (sym === 'USDC') {
    // CCTP for Base↔Ethereum (and Robinhood when domain is live).
    if (isPair(BASE, ETH) || isPair(RH, ETH)) {
      return { kind: 'cctp', from: sourceChainId, to: destChainId };
    }
  }
  if (sym === 'ETH' || sym === 'WETH') {
    if (isPair(BASE, ETH)) {
      return { kind: 'op-standard-bridge', from: sourceChainId, to: destChainId };
    }
    if (isPair(RH, ETH)) {
      return { kind: 'arbitrum-bridge', from: sourceChainId, to: destChainId };
    }
  }
  return null;
}

export function bridgeGuardrailsOk(params: {
  enabled: boolean;
  assetSymbol: string;
  amountBaseUnits: bigint;
  maxSingleHopBaseUnits?: bigint;
}): { ok: true } | { ok: false; reason: string } {
  if (!params.enabled) {
    return { ok: false, reason: 'NAVE_BRIDGE_OUTBOUND_ENABLED is false' };
  }
  if (!BRIDGE_ASSET_SYMBOLS.has(params.assetSymbol.toUpperCase())) {
    return { ok: false, reason: `asset ${params.assetSymbol} not allowlisted for bridging` };
  }
  if (params.amountBaseUnits <= 0n) {
    return { ok: false, reason: 'amount must be positive' };
  }
  if (
    params.maxSingleHopBaseUnits !== undefined &&
    params.amountBaseUnits > params.maxSingleHopBaseUnits
  ) {
    return { ok: false, reason: 'amount exceeds max single-hop cap' };
  }
  return { ok: true };
}
