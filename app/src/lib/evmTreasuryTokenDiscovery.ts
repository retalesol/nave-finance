import type { EvmChainId } from './chain/types';

/** Chains supported by Etherscan API v2 `chainid` in this app. */
const ETHERSCAN_V2_CHAIN_IDS = new Set<EvmChainId>([1, 8453, 11155111, 84532]);

/**
 * Returns unique ERC-20 contract addresses that appear in `tokentx` history for
 * `treasury` (incoming/outgoing token transfers). Used to surface "mystery"
 * tokens sitting on the treasury before they are registered on-chain.
 *
 * Requires `VITE_ETHERSCAN_API_KEY` in the client env. Without a key, returns [].
 */
export async function discoverErc20ContractAddressesFromTreasuryActivity(
  chainId: EvmChainId,
  treasury: string,
  apiKey: string | undefined,
): Promise<string[]> {
  const key = apiKey?.trim();
  if (!key || !ETHERSCAN_V2_CHAIN_IDS.has(chainId)) return [];

  const url = new URL('https://api.etherscan.io/v2/api');
  url.searchParams.set('chainid', String(chainId));
  url.searchParams.set('module', 'account');
  url.searchParams.set('action', 'tokentx');
  url.searchParams.set('address', treasury);
  url.searchParams.set('page', '1');
  url.searchParams.set('offset', '500');
  url.searchParams.set('sort', 'desc');
  url.searchParams.set('apikey', key);

  try {
    const res = await fetch(url.toString());
    if (!res.ok) return [];
    const json: unknown = await res.json();
    if (!json || typeof json !== 'object') return [];
    const status = (json as { status?: string }).status;
    const result = (json as { result?: unknown }).result;
    if (status !== '1' || !Array.isArray(result)) return [];

    const out = new Set<string>();
    for (const row of result) {
      if (!row || typeof row !== 'object') continue;
      const c = (row as { contractAddress?: string }).contractAddress;
      if (typeof c === 'string' && /^0x[0-9a-fA-F]{40}$/i.test(c)) {
        out.add(c.toLowerCase());
      }
    }
    return [...out];
  } catch {
    return [];
  }
}
