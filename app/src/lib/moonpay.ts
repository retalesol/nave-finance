import type { ChainKind, EvmChainId } from './chain/types';
import { getTreasuryReceiveAddress } from './pdaDerivation';
import { SOLANA_NETWORK } from './programConfig';

/** Locked USDC currency MoonPay delivers on a supported chain. */
export type MoonPayCurrencyCode = 'usdc_sol' | 'usdc' | 'usdc_base';

export interface MoonPayBuyTarget {
  currencyCode: MoonPayCurrencyCode;
  /** Destination the widget must not let the buyer edit. */
  walletAddress: string;
}

/**
 * USDC destination for the open treasury.
 * Solana mainnet pays the vault-authority PDA (MoonPay creates the USDC token
 * account). Ethereum and Base pay the treasury contract. Every other network,
 * including Solana devnet and the EVM testnets, returns null.
 */
export function moonPayBuyTarget(
  chainKind: ChainKind,
  evmChainId: EvmChainId | null,
  daoAddress: string,
): MoonPayBuyTarget | null {
  if (chainKind === 'solana') {
    if (SOLANA_NETWORK !== 'mainnet') return null;
    try {
      return {
        currencyCode: 'usdc_sol',
        walletAddress: getTreasuryReceiveAddress(daoAddress),
      };
    } catch {
      return null;
    }
  }
  if (evmChainId === 1) {
    return { currencyCode: 'usdc', walletAddress: daoAddress };
  }
  if (evmChainId === 8453) {
    return { currencyCode: 'usdc_base', walletAddress: daoAddress };
  }
  return null;
}
