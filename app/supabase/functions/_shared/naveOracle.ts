// Central NAVE price oracle — shared sampling, aggregation, and attestation.
//
// This module is the SINGLE source of truth for the canonical NAVE/USD
// "creation price" used by the DAO $99 stake gate. It is consumed by the
// `nave-price-oracle` edge function (which both the app and the server-side
// transaction builders call) so every surface derives the required NAVE stake
// from the exact same number.
//
// Pricing modes
//   • Devnet / testnet → a FIXED price (default $10/NAVE) so $99 == 9.9 NAVE.
//   • Mainnet → sample live NAVE markets (Solana Meteora LP + EVM wrapped NAVE
//     on Ethereum/Base), drop stale / thin-liquidity samples, then aggregate
//     with a trimmed mean (median for ≤2 samples). If too few healthy samples
//     remain the oracle FAILS CLOSED (no price, no quote) rather than emit a
//     guessed number that would under/over-collateralize a real stake.
//
// All config is read from clearly-namespaced `NAVE_ORACLE_*` env vars so this
// module owns its own keys and never collides with bridge / contract config.

// ─── Config ──────────────────────────────────────────────────────────────────

/** Known NAVE SPL mints (foundation outputs); overridable via env. */
const DEFAULT_MAINNET_MINT = "EGg56E1YtL5YapzkF7vkRThHR8i5FeRvm2LLuySdYory";
const DEFAULT_DEVNET_MINT = "GmBMZuXsXpe7TZK27PTcXUyNGcuw9Ew8v3fxys7wM9Wa";

/** GeckoTerminal network slugs for the three supported chains. */
const GT_NETWORK: Record<MarketChain, string> = {
  solana: "solana",
  ethereum: "eth",
  base: "base",
};

const USD_STABLE_MINTS = new Set<string>([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC (mainnet)
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT (mainnet)
]);

function envStr(key: string): string | undefined {
  const v = Deno.env.get(key);
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

function envNum(key: string, fallback: number): number {
  const raw = envStr(key);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export type OracleNetwork = "mainnet" | "devnet" | "testnet" | "localnet";
export type MarketChain = "solana" | "ethereum" | "base";

/** Resolve the active Solana cluster from the explicit signal or RPC sniff. */
export function resolveNetwork(): OracleNetwork {
  const cluster = (Deno.env.get("NAVE_CLUSTER") ?? "").toLowerCase().trim();
  if (cluster === "mainnet" || cluster === "mainnet-beta") return "mainnet";
  if (cluster === "devnet") return "devnet";
  if (cluster === "localnet" || cluster === "localhost") return "localnet";
  if (cluster === "testnet") return "testnet";
  const rpc = (Deno.env.get("SOLANA_RPC_URL") ?? "").toLowerCase();
  if (rpc.includes("mainnet")) return "mainnet";
  if (rpc.includes("127.0.0.1") || rpc.includes("localhost")) return "localnet";
  return "devnet";
}

export function isMainnet(network: OracleNetwork): boolean {
  return network === "mainnet";
}

/** Active NAVE mint for the resolved network. */
export function resolveNaveMint(network: OracleNetwork): string {
  const override = envStr("NAVE_ORACLE_NAVE_MINT");
  if (override) return override;
  if (isMainnet(network)) {
    return envStr("NAVE_ORACLE_MAINNET_MINT") ?? DEFAULT_MAINNET_MINT;
  }
  return envStr("NAVE_ORACLE_DEVNET_MINT") ?? DEFAULT_DEVNET_MINT;
}

export interface OracleConfig {
  network: OracleNetwork;
  naveMint: string;
  naveDecimals: number;
  /** USD value of NAVE a founder must stake to create a DAO (default $99). */
  stakeUsd: number;
  /** Fixed NAVE/USD price used on every non-mainnet network (default $10). */
  devnetPriceUsd: number;
  /** Attestation validity window (seconds). */
  quoteTtlSeconds: number;
  /** Downward tolerance (bps) applied to derive the on-chain min-NAVE floor. */
  quoteToleranceBps: number;
  /** Mainnet aggregation guardrails. */
  minLiquidityUsd: number;
  maxPriceAgeSeconds: number;
  minSources: number;
  /** Mainnet market pool configuration (GeckoTerminal pool addresses). */
  pools: Partial<Record<MarketChain, string>>;
  /** Per-chain NAVE token address used to pick the NAVE side of each pool. */
  tokens: Partial<Record<MarketChain, string>>;
  /** Optional direct Meteora DLMM pair address (Solana). */
  meteoraPair?: string;
}

export function loadOracleConfig(): OracleConfig {
  const network = resolveNetwork();
  return {
    network,
    naveMint: resolveNaveMint(network),
    naveDecimals: Math.max(0, Math.trunc(envNum("NAVE_ORACLE_NAVE_DECIMALS", 6))),
    stakeUsd: envNum("NAVE_ORACLE_STAKE_USD", 99),
    devnetPriceUsd: envNum("NAVE_ORACLE_DEVNET_PRICE_USD", 10),
    quoteTtlSeconds: Math.max(30, Math.trunc(envNum("NAVE_ORACLE_QUOTE_TTL_SECONDS", 300))),
    quoteToleranceBps: Math.min(
      5000,
      Math.max(0, Math.trunc(envNum("NAVE_ORACLE_QUOTE_TOLERANCE_BPS", 100))),
    ),
    minLiquidityUsd: Math.max(0, envNum("NAVE_ORACLE_MIN_LIQUIDITY_USD", 25_000)),
    maxPriceAgeSeconds: Math.max(30, Math.trunc(envNum("NAVE_ORACLE_MAX_PRICE_AGE_SECONDS", 900))),
    minSources: Math.max(1, Math.trunc(envNum("NAVE_ORACLE_MIN_SOURCES", 1))),
    pools: {
      solana: envStr("NAVE_ORACLE_SOLANA_POOL"),
      ethereum: envStr("NAVE_ORACLE_ETHEREUM_POOL"),
      base: envStr("NAVE_ORACLE_BASE_POOL"),
    },
    tokens: {
      solana: envStr("NAVE_ORACLE_SOLANA_TOKEN") ?? resolveNaveMint(network),
      ethereum: envStr("NAVE_ORACLE_ETHEREUM_TOKEN"),
      base: envStr("NAVE_ORACLE_BASE_TOKEN"),
    },
    meteoraPair: envStr("NAVE_ORACLE_METEORA_POOL"),
  };
}

// ─── Market sampling ───────────────────────────────────────────────────────

export interface MarketSample {
  /** Stable label, e.g. "solana-meteora", "ethereum-gt". */
  market: string;
  chain: MarketChain;
  priceUsd: number;
  liquidityUsd: number;
  /** Epoch seconds for the sample (now() for live aggregator reads). */
  updatedAt: number;
  source: string;
}

async function fetchJson(url: string, headers?: Record<string, string>): Promise<unknown> {
  const res = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json", ...(headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return await res.json();
}

/** Lowercase + strip the GeckoTerminal `"<network>_"` prefix from a token id. */
function gtTokenAddress(id: string | undefined): string {
  if (!id) return "";
  const idx = id.indexOf("_");
  return (idx >= 0 ? id.slice(idx + 1) : id).toLowerCase();
}

/**
 * Sample a NAVE/USD price from a GeckoTerminal pool. Works uniformly across
 * Solana (Meteora) and EVM (Ethereum/Base) pools: GeckoTerminal exposes USD
 * prices for both pool tokens plus USD reserves, so we pick the side that is
 * NAVE (by token address) and use its USD price + the pool's USD liquidity.
 */
export async function sampleGeckoTerminalPool(
  chain: MarketChain,
  poolAddress: string,
  naveToken: string,
): Promise<MarketSample | null> {
  const network = GT_NETWORK[chain];
  const url = `https://api.geckoterminal.com/api/v2/networks/${network}/pools/${poolAddress}`;
  const raw = (await fetchJson(url)) as {
    data?: {
      attributes?: {
        base_token_price_usd?: string | number;
        quote_token_price_usd?: string | number;
        reserve_in_usd?: string | number;
      };
      relationships?: {
        base_token?: { data?: { id?: string } };
        quote_token?: { data?: { id?: string } };
      };
    };
  };
  const attrs = raw?.data?.attributes;
  const rels = raw?.data?.relationships;
  if (!attrs) return null;

  const wanted = naveToken.toLowerCase();
  const baseAddr = gtTokenAddress(rels?.base_token?.data?.id);
  const quoteAddr = gtTokenAddress(rels?.quote_token?.data?.id);

  let priceUsd: number | null = null;
  if (baseAddr && baseAddr === wanted) {
    priceUsd = Number(attrs.base_token_price_usd);
  } else if (quoteAddr && quoteAddr === wanted) {
    priceUsd = Number(attrs.quote_token_price_usd);
  } else {
    // Token address not configured/matched: default to the base side, which is
    // the convention for single-sided NAVE pools, but only if it is finite.
    priceUsd = Number(attrs.base_token_price_usd);
  }

  const liquidityUsd = Number(attrs.reserve_in_usd);
  if (!Number.isFinite(priceUsd as number) || (priceUsd as number) <= 0) return null;
  if (!Number.isFinite(liquidityUsd) || liquidityUsd < 0) return null;

  return {
    market: `${chain}-gt`,
    chain,
    priceUsd: priceUsd as number,
    liquidityUsd,
    updatedAt: Math.floor(Date.now() / 1000),
    source: url,
  };
}

/**
 * Sample a NAVE/USD price directly from a Meteora DLMM pair. Meteora's DLMM API
 * reports `current_price` as the price of mint_x denominated in mint_y and
 * `liquidity` as USD. We resolve USD by requiring the quote side to be a known
 * USD stable; otherwise we return null and let the GeckoTerminal sample stand.
 */
export async function sampleMeteoraPair(
  pairAddress: string,
  naveMint: string,
): Promise<MarketSample | null> {
  const base = envStr("NAVE_ORACLE_METEORA_API_URL") ?? "https://dlmm-api.meteora.ag";
  const url = `${base.replace(/\/$/, "")}/pair/${pairAddress}`;
  const raw = (await fetchJson(url)) as {
    mint_x?: string;
    mint_y?: string;
    current_price?: string | number;
    liquidity?: string | number;
  };
  const mintX = raw?.mint_x;
  const mintY = raw?.mint_y;
  const currentPrice = Number(raw?.current_price);
  const liquidityUsd = Number(raw?.liquidity);
  if (!mintX || !mintY || !Number.isFinite(currentPrice) || currentPrice <= 0) return null;
  if (!Number.isFinite(liquidityUsd) || liquidityUsd < 0) return null;

  let priceUsd: number | null = null;
  if (mintX === naveMint && USD_STABLE_MINTS.has(mintY)) {
    // price of NAVE (x) in stable (y) ≈ USD
    priceUsd = currentPrice;
  } else if (mintY === naveMint && USD_STABLE_MINTS.has(mintX)) {
    // current_price is x-per-y => NAVE (y) priced in stable (x) is 1/price
    priceUsd = 1 / currentPrice;
  } else {
    return null; // non-USD quote: defer to USD-denominated aggregator samples
  }
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) return null;

  return {
    market: "solana-meteora",
    chain: "solana",
    priceUsd,
    liquidityUsd,
    updatedAt: Math.floor(Date.now() / 1000),
    source: url,
  };
}

export interface SampleAttempt {
  market: string;
  ok: boolean;
  error?: string;
}

export interface SampleResult {
  samples: MarketSample[];
  attempts: SampleAttempt[];
}

/** Gather every configured mainnet market sample (best-effort per source). */
export async function gatherMainnetSamples(cfg: OracleConfig): Promise<SampleResult> {
  const samples: MarketSample[] = [];
  const attempts: SampleAttempt[] = [];

  const push = async (label: string, fn: () => Promise<MarketSample | null>) => {
    try {
      const s = await fn();
      if (s) {
        samples.push(s);
        attempts.push({ market: label, ok: true });
      } else {
        attempts.push({ market: label, ok: false, error: "no usable price/liquidity" });
      }
    } catch (e) {
      attempts.push({ market: label, ok: false, error: e instanceof Error ? e.message : "fetch failed" });
    }
  };

  // Solana: prefer a direct Meteora pair (the canonical NAVE LP) and also pull
  // the GeckoTerminal-indexed Solana pool when configured.
  if (cfg.meteoraPair) {
    await push("solana-meteora", () => sampleMeteoraPair(cfg.meteoraPair as string, cfg.naveMint));
  }
  if (cfg.pools.solana && cfg.tokens.solana) {
    await push("solana-gt", () =>
      sampleGeckoTerminalPool("solana", cfg.pools.solana as string, cfg.tokens.solana as string),
    );
  }
  for (const chain of ["ethereum", "base"] as const) {
    const pool = cfg.pools[chain];
    const token = cfg.tokens[chain];
    if (pool && token) {
      await push(`${chain}-gt`, () => sampleGeckoTerminalPool(chain, pool, token));
    }
  }

  return { samples, attempts };
}

// ─── Aggregation ─────────────────────────────────────────────────────────────

/** Median of a non-empty numeric array. */
export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Trimmed mean: drop the single lowest + highest sample when there are ≥4
 * samples, then average the rest. With 1–3 samples fall back to the median so a
 * single outlier among three cannot dominate.
 */
export function trimmedMean(values: number[]): number {
  if (values.length === 0) return NaN;
  if (values.length < 4) return median(values);
  const sorted = [...values].sort((a, b) => a - b);
  const kept = sorted.slice(1, sorted.length - 1);
  return kept.reduce((a, b) => a + b, 0) / kept.length;
}

export interface AggregateResult {
  priceUsd: number;
  used: MarketSample[];
  dropped: Array<MarketSample & { reason: string }>;
}

/**
 * Filter samples by freshness + minimum liquidity, then aggregate the healthy
 * ones with a trimmed mean. Throws (fail-closed) when fewer than `minSources`
 * healthy samples survive so callers never publish a guessed mainnet price.
 */
export function aggregateSamples(cfg: OracleConfig, samples: MarketSample[]): AggregateResult {
  const now = Math.floor(Date.now() / 1000);
  const used: MarketSample[] = [];
  const dropped: Array<MarketSample & { reason: string }> = [];

  for (const s of samples) {
    if (!Number.isFinite(s.priceUsd) || s.priceUsd <= 0) {
      dropped.push({ ...s, reason: "non-positive price" });
      continue;
    }
    if (s.liquidityUsd < cfg.minLiquidityUsd) {
      dropped.push({ ...s, reason: `liquidity $${s.liquidityUsd} < min $${cfg.minLiquidityUsd}` });
      continue;
    }
    const age = now - s.updatedAt;
    if (age > cfg.maxPriceAgeSeconds) {
      dropped.push({ ...s, reason: `stale ${age}s > ${cfg.maxPriceAgeSeconds}s` });
      continue;
    }
    used.push(s);
  }

  if (used.length < cfg.minSources) {
    throw new Error(
      `oracle fail-closed: ${used.length} healthy NAVE market sample(s) < required ${cfg.minSources}`,
    );
  }

  return { priceUsd: trimmedMean(used.map((s) => s.priceUsd)), used, dropped };
}

// ─── Quote + attestation ─────────────────────────────────────────────────────

export interface StakeQuote {
  network: OracleNetwork;
  naveMint: string;
  naveDecimals: number;
  /** Canonical NAVE/USD price the quote was computed at. */
  priceUsd: number;
  /** USD value the stake must reach (default $99). */
  stakeUsd: number;
  /** Human-readable NAVE amount (priceUsd-derived). */
  requiredNave: number;
  /** Exact NAVE base units the client should transfer into escrow (string u64). */
  requiredNaveBaseUnits: string;
  /**
   * Minimum NAVE base units the on-chain stake instruction must enforce. This
   * is `requiredNaveBaseUnits` reduced by `quoteToleranceBps` so a small price
   * drift between quote and execution does not reject an honestly-funded stake.
   */
  minNaveBaseUnits: string;
  quoteToleranceBps: number;
  source: "fixed" | "multi-chain";
  issuedAt: string;
  expiresAt: string;
}

/** ceil(usd / price * 10^decimals) as a non-negative integer (bigint). */
function requiredBaseUnits(stakeUsd: number, priceUsd: number, decimals: number): bigint {
  if (!(priceUsd > 0)) throw new Error("priceUsd must be > 0");
  const scale = 10 ** decimals;
  const exact = (stakeUsd / priceUsd) * scale;
  return BigInt(Math.ceil(exact));
}

export function buildStakeQuote(
  cfg: OracleConfig,
  priceUsd: number,
  source: "fixed" | "multi-chain",
  stakeUsdOverride?: number,
): StakeQuote {
  const stakeUsd = stakeUsdOverride && stakeUsdOverride > 0 ? stakeUsdOverride : cfg.stakeUsd;
  const required = requiredBaseUnits(stakeUsd, priceUsd, cfg.naveDecimals);
  const min = (required * BigInt(10_000 - cfg.quoteToleranceBps)) / 10_000n;
  const now = Date.now();
  return {
    network: cfg.network,
    naveMint: cfg.naveMint,
    naveDecimals: cfg.naveDecimals,
    priceUsd,
    stakeUsd,
    requiredNave: stakeUsd / priceUsd,
    requiredNaveBaseUnits: required.toString(),
    minNaveBaseUnits: min.toString(),
    quoteToleranceBps: cfg.quoteToleranceBps,
    source,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + cfg.quoteTtlSeconds * 1000).toISOString(),
  };
}

function bytesToHex(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return Array.from(arr).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Stable, key-sorted JSON so the hash/signature is reproducible. */
export function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export interface Attestation {
  payloadHash: string;
  signature: string | null;
  signed: boolean;
  algorithm: "HMAC-SHA256";
}

/**
 * Produce a tamper-evident attestation over the canonical quote payload: a
 * SHA-256 content hash plus an HMAC-SHA256 signature keyed by
 * NAVE_ORACLE_ATTESTATION_SECRET. The signature lets DAO-creation later PROVE
 * which price/amount the protocol issued. When the secret is unset the snapshot
 * is still hashed + persisted, but `signed` is false (acceptable off mainnet).
 */
export async function attest(payload: StakeQuote): Promise<Attestation> {
  const canonical = canonicalize(payload as unknown);
  const data = new TextEncoder().encode(canonical);
  const hashBuf = await crypto.subtle.digest("SHA-256", data);
  const payloadHash = bytesToHex(hashBuf);

  const secret = envStr("NAVE_ORACLE_ATTESTATION_SECRET");
  if (!secret) {
    return { payloadHash, signature: null, signed: false, algorithm: "HMAC-SHA256" };
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadHash));
  return { payloadHash, signature: bytesToHex(sigBuf), signed: true, algorithm: "HMAC-SHA256" };
}
