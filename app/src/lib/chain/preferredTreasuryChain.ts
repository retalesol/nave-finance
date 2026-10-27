/**
 * Pick the deployment of a treasury that belongs on the network the user
 * already has open. A grouped treasury must not fall through to whichever
 * chain row was stored first.
 */

import { evmTarget, isEvmAddress, isEvmChainId, type ChainFamily } from './types';

export interface TreasuryChainChoice {
  chainId: number | null;
  daoOnchainAddress: string;
  label: string;
}

export function preferredTreasuryChain<T extends TreasuryChainChoice>(
  chains: readonly T[],
  family: ChainFamily,
  fallback: T,
): T {
  if (family === 'solana') {
    const solana = chains.find((chain) => !isEvmAddress(chain.daoOnchainAddress));
    if (solana) return solana;
  } else {
    const match = chains.find((chain) => (
      typeof chain.chainId === 'number'
      && isEvmChainId(chain.chainId)
      && evmTarget(chain.chainId).family === family
    ));
    if (match) return match;
  }
  return chains[0] ?? fallback;
}
