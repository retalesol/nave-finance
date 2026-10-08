// ─── NAVE token stats (public, browser-callable) ─────────────────────────────
// Aggregates live $NAVE market data for the homepage tokenomics section:
//   - price + market cap from GeckoTerminal (mirrors the bridge/price-oracle's
//     existing GeckoTerminal usage in naveOracle.ts, kept independent here
//     since this is marketing display data, not the creation-price oracle).
//   - a 24h hourly price series for the line chart.
//   - a holder count computed directly from Solana mainnet via
//     getProgramAccounts over the SPL Token program, filtered to the NAVE
//     mint — no paid indexer API required.
//
// Fails soft: any single upstream failure degrades that field to null rather
// than failing the whole response, since this is read-only display data with
// no security-sensitive consequences either way.

import { corsHeadersFor, jsonWithCors } from "../_shared/http.ts";

const NAVE_MINT = Deno.env.get("NAVE_TOKEN_STATS_MINT") ?? "EGg56E1YtL5YapzkF7vkRThHR8i5FeRvm2LLuySdYory";
const POOL_ADDRESS = Deno.env.get("NAVE_TOKEN_STATS_POOL") ?? "DEAtFrFhDz1J5D2KB9pzQCDHj5bT7tBCcWcBHwYzV4LU";
const MAINNET_RPC_URL = Deno.env.get("NAVE_TOKEN_STATS_RPC_URL") ?? "https://api.mainnet-beta.solana.com";
const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

const CACHE_TTL_MS = 120_000;

interface TokenStatsPayload {
  priceUsd: number | null;
  marketCapUsd: number | null;
  holders: number | null;
  totalSupply: number | null;
  chain: { t: number; price: number }[];
  contractAddress: string;
  links: {
    dexscreener: string;
    geckoterminal: string;
  };
  fetchedAt: string;
}

let cached: { payload: TokenStatsPayload; expiresAt: number } | null = null;

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return await res.json();
}

/** Price, FDV (≈ market cap for a fixed-supply, fully fair-launched token), and total supply. */
async function fetchTokenMarketData(): Promise<{
  priceUsd: number | null;
  marketCapUsd: number | null;
  totalSupply: number | null;
}> {
  try {
    const raw = (await fetchJson(
      `https://api.geckoterminal.com/api/v2/networks/solana/tokens/${NAVE_MINT}`,
    )) as {
      data?: { attributes?: { price_usd?: string; fdv_usd?: string; market_cap_usd?: string | null; normalized_total_supply?: string } };
    };
    const attrs = raw?.data?.attributes;
    const priceUsd = attrs?.price_usd ? Number(attrs.price_usd) : null;
    // GeckoTerminal often reports market_cap_usd as null for tokens it can't
    // independently verify circulating supply for. NAVE is fully fair-launched
    // with a fixed max supply and no vesting, so FDV is the correct stand-in.
    const marketCapUsd = attrs?.market_cap_usd
      ? Number(attrs.market_cap_usd)
      : attrs?.fdv_usd
        ? Number(attrs.fdv_usd)
        : null;
    const totalSupply = attrs?.normalized_total_supply ? Number(attrs.normalized_total_supply) : null;
    return {
      priceUsd: Number.isFinite(priceUsd) ? priceUsd : null,
      marketCapUsd: Number.isFinite(marketCapUsd) ? marketCapUsd : null,
      totalSupply: Number.isFinite(totalSupply) ? totalSupply : null,
    };
  } catch {
    return { priceUsd: null, marketCapUsd: null, totalSupply: null };
  }
}

/** Last 24 hourly candles (close price) from the most liquid NAVE/USDC pool. */
async function fetchDayChain(): Promise<{ t: number; price: number }[]> {
  try {
    const raw = (await fetchJson(
      `https://api.geckoterminal.com/api/v2/networks/solana/pools/${POOL_ADDRESS}/ohlcv/hour?aggregate=1&limit=24`,
    )) as { data?: { attributes?: { ohlcv_list?: number[][] } } };
    const list = raw?.data?.attributes?.ohlcv_list ?? [];
    // GeckoTerminal returns newest-first: [timestamp, open, high, low, close, volume].
    return list
      .map((row) => ({ t: row[0], price: row[4] }))
      .filter((p) => Number.isFinite(p.price))
      .sort((a, b) => a.t - b.t);
  } catch {
    return [];
  }
}

/** Holder count: distinct token accounts for the NAVE mint with a nonzero balance. */
async function fetchHolderCount(): Promise<number | null> {
  try {
    const res = await fetch(MAINNET_RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getProgramAccounts",
        params: [
          TOKEN_PROGRAM_ID,
          {
            encoding: "jsonParsed",
            filters: [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: NAVE_MINT } }],
          },
        ],
      }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      result?: { account?: { data?: { parsed?: { info?: { tokenAmount?: { amount?: string } } } } } }[];
      error?: unknown;
    };
    if (body.error || !Array.isArray(body.result)) return null;
    const holders = body.result.filter((row) => {
      const amount = row.account?.data?.parsed?.info?.tokenAmount?.amount;
      return amount !== undefined && BigInt(amount) > 0n;
    });
    return holders.length;
  } catch {
    return null;
  }
}

async function buildPayload(): Promise<TokenStatsPayload> {
  const [market, chain, holders] = await Promise.all([
    fetchTokenMarketData(),
    fetchDayChain(),
    fetchHolderCount(),
  ]);
  return {
    priceUsd: market.priceUsd,
    marketCapUsd: market.marketCapUsd,
    holders,
    totalSupply: market.totalSupply,
    chain,
    contractAddress: NAVE_MINT,
    links: {
      dexscreener: `https://dexscreener.com/solana/${NAVE_MINT}`,
      geckoterminal: `https://www.geckoterminal.com/solana/pools/${POOL_ADDRESS}`,
    },
    fetchedAt: new Date().toISOString(),
  };
}

Deno.serve(async (req: Request) => {
  // Public read-only marketing data — allow any http(s) origin when
  // NAVE_ALLOWED_ORIGINS is not configured (dev/staging), same posture as yield-data.
  const corsHeaders = corsHeadersFor(req, { allowBrowserFallback: true });
  const jsonResponse = (data: unknown, status = 200) => jsonWithCors(corsHeaders, data, status);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "GET") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return jsonResponse(cached.payload);
  }

  const payload = await buildPayload();
  cached = { payload, expiresAt: now + CACHE_TTL_MS };
  return jsonResponse(payload);
});
