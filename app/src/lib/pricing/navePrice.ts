// ─── NAVE spot price (CoinGecko) ──────────────────────────────────────────────
// Public, keyless CoinGecko simple-price lookup for the NAVE token
// (id: nave-shares), used to express bridge volume in USD. Cached in
// localStorage for a few minutes so the stats poll (30s) doesn't hammer the
// free API tier, with an in-flight dedupe so concurrent callers share one
// request. Returns null on any failure — callers degrade to token amounts.

const COINGECKO_ID = 'nave-shares';
const PRICE_URL = `https://api.coingecko.com/api/v3/simple/price?ids=${COINGECKO_ID}&vs_currencies=usd`;
const CACHE_KEY = 'nave_usd_price_v1';
const CACHE_TTL_MS = 5 * 60_000;

let inFlight: Promise<number | null> | null = null;

function readCache(): number | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const { usd, at } = JSON.parse(raw) as { usd: number; at: number };
    if (typeof usd !== 'number' || !Number.isFinite(usd)) return null;
    return Date.now() - at < CACHE_TTL_MS ? usd : null;
  } catch {
    return null;
  }
}

function writeCache(usd: number): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ usd, at: Date.now() }));
  } catch {
    // Storage unavailable — every call falls through to the network cache TTL.
  }
}

/** NAVE/USD spot price, or null when CoinGecko is unreachable. */
export async function fetchNaveUsdPrice(): Promise<number | null> {
  const cached = readCache();
  if (cached !== null) return cached;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const res = await fetch(PRICE_URL);
      if (!res.ok) return null;
      const body = (await res.json()) as Record<string, { usd?: number }>;
      const usd = body[COINGECKO_ID]?.usd;
      if (typeof usd !== 'number' || !Number.isFinite(usd)) return null;
      writeCache(usd);
      return usd;
    } catch {
      return null;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}
