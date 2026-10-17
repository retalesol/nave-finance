import { PublicKey } from '@solana/web3.js';

export const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
export const CHAINLINK_SOL_USD_DEVNET = new PublicKey('99B2bTijsU6f1GCT73HmdR7HCFFjGMBcPZY6jZ96ynrR');
export const CHAINLINK_SOL_USD_MAINNET = new PublicKey('CH31Xns5z3M1cTAbKW34jcxPPciazARpijcHj9rxtemt');

export function chainlinkSolUsdFor(mainnet: boolean): PublicKey {
  return mainnet ? CHAINLINK_SOL_USD_MAINNET : CHAINLINK_SOL_USD_DEVNET;
}

/**
 * The `price_update` account nave_execution's execute/withdraw valuation reads.
 * An explicit address wins. Wrapped SOL is priced from the pinned Chainlink
 * SOL/USD feed (the program rejects any other account for it). Stablecoins
 * ignore the account, so the mint is passed as a harmless placeholder.
 */
export function executionPriceAccount(
  mint: PublicKey,
  mainnet: boolean,
  explicit?: string | null,
): PublicKey {
  if (explicit) return new PublicKey(explicit);
  return mint.equals(WSOL_MINT) ? chainlinkSolUsdFor(mainnet) : mint;
}
