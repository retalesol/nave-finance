/** SOL and ETH spot prices. Not Pyth, and not the treasury oracle.
 *  ETH is CoinGecko `ethereum`, then mainnet WETH on DexScreener, then the
 *  same market on GeckoTerminal. Never a testnet WETH contract.
 */

const PRICE_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=solana,ethereum&vs_currencies=usd';
const CACHE_TTL_MS = 60_000;

/** Canonical liquid WETH on Ethereum mainnet. A proxy for the ETH price. */
const ETH_USD_PROXY = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const DEXSCREENER_ETH_URL = `https://api.dexscreener.com/tokens/v1/ethereum/${ETH_USD_PROXY}`;
const GECKOTERMINAL_ETH_URL = `https://api.geckoterminal.com/api/v2/simple/networks/eth/token_price/${ETH_USD_PROXY}`;

export type SpotId = 'solana' | 'ethereum';

const cache = new Map<SpotId, { usd: number; at: number }>();
let inFlight: Promise<void> | null = null;

function fresh(id: SpotId): boolean {
  const row = cache.get(id);
  return !!row && Date.now() - row.at < CACHE_TTL_MS;
}

function positiveUsd(value: unknown): number | null {
  const n = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function remember(id: SpotId, usd: number): void {
  cache.set(id, { usd, at: Date.now() });
}

async function readCoinGecko(): Promise<void> {
  try {
    const res = await fetch(PRICE_URL);
    if (!res.ok) return;
    const body = (await res.json()) as Record<string, { usd?: unknown }>;
    for (const id of ['solana', 'ethereum'] as const) {
      const usd = positiveUsd(body[id]?.usd);
      if (usd != null) remember(id, usd);
    }
  } catch {
    // Miss: ETH falls through to the market proxies below.
  }
}

type DexPair = {
  priceUsd?: unknown;
  liquidity?: { usd?: number };
  baseToken?: { address?: string };
};

async function readEthFromDexScreener(): Promise<number | null> {
  try {
    const res = await fetch(DEXSCREENER_ETH_URL);
    if (!res.ok) return null;
    const body = (await res.json()) as DexPair[] | { pairs?: DexPair[] };
    const rows = Array.isArray(body) ? body : Array.isArray(body?.pairs) ? body.pairs : [];
    let best: { price: number; liquidity: number } | null = null;
    for (const row of rows) {
      if (row?.baseToken?.address?.toLowerCase() !== ETH_USD_PROXY) continue;
      const price = positiveUsd(row.priceUsd);
      if (price == null) continue;
      const liquidity = typeof row.liquidity?.usd === 'number' && Number.isFinite(row.liquidity.usd)
        ? row.liquidity.usd
        : 0;
      if (!best || liquidity > best.liquidity) best = { price, liquidity };
    }
    return best?.price ?? null;
  } catch {
    return null;
  }
}

async function readEthFromGeckoTerminal(): Promise<number | null> {
  try {
    const res = await fetch(GECKOTERMINAL_ETH_URL, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      data?: { attributes?: { token_prices?: Record<string, unknown>; price_usd?: unknown } };
    };
    const attrs = body.data?.attributes;
    if (!attrs) return null;
    const prices = attrs.token_prices;
    if (prices) {
      for (const [addr, raw] of Object.entries(prices)) {
        if (addr.toLowerCase() !== ETH_USD_PROXY) continue;
        const usd = positiveUsd(raw);
        if (usd != null) return usd;
      }
    }
    return positiveUsd(attrs.price_usd);
  } catch {
    return null;
  }
}

async function refreshSpotPrices(): Promise<void> {
  await readCoinGecko();
  if (fresh('ethereum')) return;
  const dex = await readEthFromDexScreener();
  if (dex != null) {
    remember('ethereum', dex);
    return;
  }
  const gt = await readEthFromGeckoTerminal();
  if (gt != null) remember('ethereum', gt);
}

/** Current USD prices. A missing id means every source missed. */
export async function fetchSpotUsd(ids: SpotId[]): Promise<Partial<Record<SpotId, number>>> {
  if (ids.length > 0 && !ids.every(fresh)) {
    if (!inFlight) {
      inFlight = refreshSpotPrices().finally(() => {
        inFlight = null;
      });
    }
    await inFlight;
  }
  const out: Partial<Record<SpotId, number>> = {};
  for (const id of ids) {
    const row = cache.get(id);
    if (row) out[id] = row.usd;
  }
  return out;
}

/** Drops the 60s cache. Unit tests use this so cases don't share a price. */
export function resetSpotUsdCache(): void {
  cache.clear();
  inFlight = null;
}
