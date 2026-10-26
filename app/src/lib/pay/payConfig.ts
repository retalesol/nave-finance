/**
 * Optional Pay chain config. Empty means the invoice shows the canonical
 * treasury address. A missing router is not treated as a deployed forwarder.
 */

import { evmAllowedAssets } from '../allowedAssets';
import { isEvmChainId } from '../chain/types';
import { EVM_PROTOCOL_REVENUE_WALLET, SOLANA_NETWORK } from '../programConfig';
import { readViteEnv } from '../viteEnv';

function parseAddressMap(raw: string | undefined): Record<string, string> {
  if (!raw || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value.trim())) {
        out[key] = value.trim();
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function paySolanaUsdcMint(): string | null {
  const value = readViteEnv('VITE_PAY_SOLANA_USDC_MINT')?.trim();
  return value || null;
}

/** chain id -> router address. Absent or invalid entries are dropped. */
export function payEvmRouters(): Record<string, string> {
  return parseAddressMap(readViteEnv('VITE_PAY_EVM_ROUTERS'));
}

/** chain id -> USDC token. Used only together with a router on that chain. */
export function payEvmUsdc(): Record<string, string> {
  return parseAddressMap(readViteEnv('VITE_PAY_EVM_USDC'));
}

const SOLANA_USDC = {
  mainnet: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  devnet: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
} as const;

/** USDC the payer sends. Env overrides the known token for that chain. */
export function payUsdc(chain: string, chainId: number | null): { address: string; decimals: number } | null {
  if (chain === 'solana') {
    const configured = paySolanaUsdcMint();
    return {
      address: configured ?? (SOLANA_NETWORK === 'mainnet' ? SOLANA_USDC.mainnet : SOLANA_USDC.devnet),
      decimals: 6,
    };
  }
  if (chainId == null || !isEvmChainId(chainId)) return null;
  const configured = payEvmUsdc()[String(chainId)];
  if (configured) return { address: configured, decimals: 6 };
  const listed = evmAllowedAssets(chainId).find((asset) => asset.symbol === 'USDC');
  return listed ? { address: listed.address, decimals: listed.decimals } : null;
}

/** Where a Nave Pay subscription in USDC is sent. */
export function payBillingDestination(chain: 'solana' | 'evm'): string | null {
  if (chain === 'solana') {
    return readViteEnv('VITE_PAY_BILLING_SOLANA')?.trim()
      || readViteEnv('VITE_NAVE_PROTOCOL_FEE_WALLET')?.trim()
      || null;
  }
  return readViteEnv('VITE_PAY_BILLING_EVM')?.trim()
    || EVM_PROTOCOL_REVENUE_WALLET
    || null;
}
