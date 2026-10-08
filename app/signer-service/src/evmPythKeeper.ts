// Pull Pyth price updates from Hermes for the EVM Pyth contract.
// Reuses the same Hermes endpoint as the Solana poster. Does not invent an oracle:
// NaveTreasury.revalueTreasury still reads PythOracle.getPriceNoOlderThan.
import { HermesClient } from '@pythnetwork/hermes-client';

const HERMES_URL = process.env.PYTH_HERMES_URL || 'https://hermes.pyth.network';

function normalizeFeed(feedHex: string): string {
  const clean = feedHex.replace(/^0x/, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(clean)) {
    throw new Error(`pyth feed id must be 32 bytes of hex, got "${feedHex}"`);
  }
  return `0x${clean}`;
}

/** Hermes `updatePriceFeeds` bytes (0x-hex) for the given Pyth feed ids. */
export async function fetchHermesUpdateData(feedIds: string[]): Promise<`0x${string}`[]> {
  const feeds = Array.from(new Set(feedIds.map(normalizeFeed)));
  if (feeds.length === 0) return [];

  const hermes = new HermesClient(HERMES_URL);
  const updates = await hermes.getLatestPriceUpdates(feeds, { encoding: 'hex' });
  const data = updates.binary?.data ?? [];
  if (data.length === 0) {
    throw new Error('Hermes returned no price update bytes');
  }
  return data.map((entry) => (entry.startsWith('0x') ? entry : `0x${entry}`) as `0x${string}`);
}
