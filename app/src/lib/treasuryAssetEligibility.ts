/** Whether a held treasury asset can be proposed for transfer without a registration step. */

export interface TreasuryAssetEligibility {
  mint: string;
  uiBalance: number;
  onChainRegistered: boolean;
  enabled: boolean;
}

/**
 * Any token the treasury already holds can be sent. Native SOL uses the lamport
 * transfer path. An explicitly disabled registered asset stays blocked.
 * Native ETH is not an ERC-20 and is not offered as a token transfer.
 */
export function isSendableTreasuryAsset(asset: TreasuryAssetEligibility): boolean {
  if (!(asset.uiBalance > 0)) return false;
  if (asset.mint === 'SOL') return true;
  if (asset.mint === 'ETH') return false;
  if (asset.onChainRegistered && !asset.enabled) return false;
  return true;
}

/** Mints that can be selected for strategy or transfer forms (not native gas tokens). */
export function isSelectableTreasuryMint(asset: TreasuryAssetEligibility): boolean {
  if (asset.mint === 'SOL' || asset.mint === 'ETH') return false;
  if (asset.onChainRegistered && !asset.enabled) return false;
  return asset.onChainRegistered || asset.uiBalance > 0;
}
