// Live venue rates for the strategy menu. Reads DefiLlama's yields API plus
// the Morpho, Kamino and Pendle APIs, and returns one row per catalog venue.
// Every fetch is best-effort: a failed source yields no row for that venue,
// and readers fall back to the catalog's dated rate.

import {
  STRATEGY_VENUES,
  type StrategyRate,
  type StrategyVenue,
} from "./strategyCatalog.ts";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const DEFILLAMA_POOLS_URL = "https://yields.llama.fi/pools";
const MORPHO_GRAPHQL_URL = "https://api.morpho.org/graphql";
const KAMINO_API = "https://api.kamino.finance";
const PENDLE_API = "https://api-v2.pendle.finance/core";

interface LlamaPool {
  pool: string;
  apyBase?: number | null;
  apyReward?: number | null;
  apyMean30d?: number | null;
  tvlUsd?: number | null;
}

function num(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/** Fraction (0.05) to percent (5), rounded to 4 decimals. */
function pct(fraction: number | null): number | null {
  return fraction == null ? null : Math.round(fraction * 1e6) / 1e4;
}

async function json<T>(fetcher: FetchLike, url: string, init?: RequestInit): Promise<T | null> {
  try {
    const res = await fetcher(url, init);
    if (!res.ok) return null;
    return await res.json() as T;
  } catch {
    return null;
  }
}

export async function fetchDefiLlamaPools(fetcher: FetchLike): Promise<Map<string, LlamaPool>> {
  const body = await json<{ data?: LlamaPool[] }>(fetcher, DEFILLAMA_POOLS_URL);
  return new Map((body?.data ?? []).map((p) => [p.pool, p]));
}

export async function fetchMorphoVaultApys(
  fetcher: FetchLike,
  vaults: Array<{ chainId: number; vault: string }>,
): Promise<Map<string, { apy: number | null; tvlUsd: number | null }>> {
  const out = new Map<string, { apy: number | null; tvlUsd: number | null }>();
  if (vaults.length === 0) return out;
  const chainIds = [...new Set(vaults.map((v) => v.chainId))];
  const addresses = [...new Set(vaults.map((v) => v.vault))];
  // MetaMorpho (v1) and vault v2 live in separate collections. `netApy` is
  // after the curator fee, i.e. what a depositor earns.
  const query = `{
    vaults(first: 100, where: { chainId_in: ${JSON.stringify(chainIds)}, address_in: ${JSON.stringify(addresses)} }) {
      items { address chain { id } state { netApy totalAssetsUsd } }
    }
    vaultV2s(first: 100, where: { chainId_in: ${JSON.stringify(chainIds)}, address_in: ${JSON.stringify(addresses)} }) {
      items { address chain { id } netApy totalAssetsUsd }
    }
  }`;
  const body = await json<{
    data?: {
      vaults?: { items?: Array<{ address: string; chain: { id: number }; state?: { netApy?: number; totalAssetsUsd?: number } }> };
      vaultV2s?: { items?: Array<{ address: string; chain: { id: number }; netApy?: number; totalAssetsUsd?: number }> };
    };
  }>(fetcher, MORPHO_GRAPHQL_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query }),
  });
  for (const v of body?.data?.vaults?.items ?? []) {
    out.set(`${v.chain.id}:${v.address.toLowerCase()}`, {
      apy: pct(num(v.state?.netApy)),
      tvlUsd: num(v.state?.totalAssetsUsd),
    });
  }
  for (const v of body?.data?.vaultV2s?.items ?? []) {
    out.set(`${v.chain.id}:${v.address.toLowerCase()}`, {
      apy: pct(num(v.netApy)),
      tvlUsd: num(v.totalAssetsUsd),
    });
  }
  return out;
}

export async function fetchKaminoReserveApys(
  fetcher: FetchLike,
  market: string,
): Promise<Map<string, { apy: number | null; tvlUsd: number | null }>> {
  const rows = await json<Array<{ liquidityTokenMint?: string; supplyApy?: string | number; totalSupplyUsd?: string | number }>>(
    fetcher,
    `${KAMINO_API}/kamino-market/${market}/reserves/metrics?env=mainnet-beta`,
  );
  const out = new Map<string, { apy: number | null; tvlUsd: number | null }>();
  for (const r of rows ?? []) {
    if (!r.liquidityTokenMint) continue;
    out.set(r.liquidityTokenMint, { apy: pct(num(r.supplyApy)), tvlUsd: num(r.totalSupplyUsd) });
  }
  return out;
}

export async function fetchPendleImpliedApy(
  fetcher: FetchLike,
  chainId: number,
  market: string,
): Promise<{ apy: number | null; tvlUsd: number | null } | null> {
  const body = await json<{ impliedApy?: number; liquidity?: { usd?: number } }>(
    fetcher,
    `${PENDLE_API}/v1/${chainId}/markets/${market.toLowerCase()}`,
  );
  if (!body) return null;
  return { apy: pct(num(body.impliedApy)), tvlUsd: num(body.liquidity?.usd) };
}

/**
 * Fetch live rates for every catalog venue with a rate source. DefiLlama
 * supplies base, reward and 30-day mean; Morpho, Kamino and Pendle supply the
 * current base rate only (no 30-day mean), and Pendle's figure is the PT's
 * implied fixed rate to maturity.
 */
export async function fetchStrategyRates(
  fetcher: FetchLike = fetch,
  venues: StrategyVenue[] = STRATEGY_VENUES,
  now: Date = new Date(),
): Promise<StrategyRate[]> {
  const fetchedAt = now.toISOString();
  const withRate = venues.filter((v) => v.rate != null);
  const needsLlama = withRate.some((v) => v.rate?.kind === "defillama");
  const morphoVaults = withRate.flatMap((v) => v.rate?.kind === "morpho" ? [v.rate] : []);
  const kaminoMarkets = [...new Set(withRate.flatMap((v) => v.rate?.kind === "kamino" ? [v.rate.market] : []))];

  const [llama, morpho, ...kamino] = await Promise.all([
    needsLlama ? fetchDefiLlamaPools(fetcher) : Promise.resolve(new Map<string, LlamaPool>()),
    fetchMorphoVaultApys(fetcher, morphoVaults),
    ...kaminoMarkets.map((m) => fetchKaminoReserveApys(fetcher, m)),
  ]);
  const kaminoByMarket = new Map(kaminoMarkets.map((m, i) => [m, kamino[i]]));

  const rows: StrategyRate[] = [];
  for (const v of withRate) {
    const src = v.rate!;
    const base = { venueId: v.id, chain: v.chain, fetchedAt };
    if (src.kind === "defillama") {
      const p = llama.get(src.pool);
      if (!p || num(p.apyBase) == null) continue;
      rows.push({
        ...base,
        baseApy: num(p.apyBase),
        rewardApy: num(p.apyReward),
        mean30dApy: num(p.apyMean30d),
        tvlUsd: num(p.tvlUsd),
        source: `defillama:${src.pool}`,
      });
    } else if (src.kind === "morpho") {
      const m = morpho.get(`${src.chainId}:${src.vault.toLowerCase()}`);
      if (!m || m.apy == null) continue;
      rows.push({ ...base, baseApy: m.apy, rewardApy: null, mean30dApy: null, tvlUsd: m.tvlUsd, source: `morpho:${src.vault}` });
    } else if (src.kind === "kamino") {
      const k = kaminoByMarket.get(src.market)?.get(src.mint);
      if (!k || k.apy == null) continue;
      rows.push({ ...base, baseApy: k.apy, rewardApy: null, mean30dApy: null, tvlUsd: k.tvlUsd, source: `kamino:${src.market}` });
    } else if (src.kind === "pendle") {
      const pd = await fetchPendleImpliedApy(fetcher, src.chainId, src.market);
      if (!pd || pd.apy == null) continue;
      rows.push({ ...base, baseApy: pd.apy, rewardApy: null, mean30dApy: null, tvlUsd: pd.tvlUsd, source: `pendle:${src.market}` });
    }
  }
  return rows;
}

/** Database row shape for `strategy_rates`. */
export function toStrategyRateRow(rate: StrategyRate) {
  return {
    venue_id: rate.venueId,
    chain: rate.chain,
    base_apy: rate.baseApy,
    reward_apy: rate.rewardApy,
    mean_30d_apy: rate.mean30dApy,
    tvl_usd: rate.tvlUsd,
    source: rate.source,
    fetched_at: rate.fetchedAt,
  };
}

export function fromStrategyRateRow(row: Record<string, unknown>): StrategyRate {
  return {
    venueId: String(row.venue_id ?? ""),
    chain: String(row.chain ?? "") as StrategyRate["chain"],
    baseApy: num(row.base_apy),
    rewardApy: num(row.reward_apy),
    mean30dApy: num(row.mean_30d_apy),
    tvlUsd: num(row.tvl_usd),
    source: String(row.source ?? ""),
    fetchedAt: String(row.fetched_at ?? ""),
  };
}
