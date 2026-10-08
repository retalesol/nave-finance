import { corsHeadersFor, jsonWithCors } from "../_shared/http.ts";

type AssetClass = "stablecoin" | "sol" | "other";

interface Opportunity {
  protocolId: string;
  apyBps: number;
  riskScore: number;
  assetClass: AssetClass;
  liquid: boolean;
  source: string;
}

function clampBps(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.round(value);
}

function pctToBps(pct: number): number {
  if (!Number.isFinite(pct)) return 0;
  return clampBps(pct * 100);
}

async function fetchJson(url: string, headers?: Record<string, string>): Promise<unknown> {
  const resp = await fetch(url, {
    method: "GET",
    headers: { "Content-Type": "application/json", ...(headers ?? {}) },
  });
  if (!resp.ok) {
    throw new Error(`${url} -> HTTP ${resp.status}`);
  }
  return await resp.json();
}

function parseJito(raw: unknown): Opportunity | null {
  const obj = raw as { apy?: number };
  const apy = Number(obj?.apy);
  if (!Number.isFinite(apy) || apy <= 0) return null;
  return {
    protocolId: "jito",
    apyBps: pctToBps(apy),
    riskScore: 30,
    assetClass: "sol",
    liquid: true,
    source: "jito:stakePools/overview",
  };
}

function parseKamino(raw: unknown): Opportunity | null {
  if (!Array.isArray(raw)) return null;
  const usdcLike = raw.find((row) => {
    const r = row as Record<string, unknown>;
    const text = JSON.stringify(r).toLowerCase();
    return text.includes("usdc");
  }) as Record<string, unknown> | undefined;
  if (!usdcLike) return null;

  const apyCandidates = [
    Number(usdcLike.apy),
    Number(usdcLike.supplyApy),
    Number(usdcLike.supply_apy),
    Number(usdcLike.totalApy),
  ];
  const apy = apyCandidates.find((v) => Number.isFinite(v) && v > 0);
  if (!apy) return null;
  return {
    protocolId: "kamino",
    apyBps: pctToBps(apy),
    riskScore: 18,
    assetClass: "stablecoin",
    liquid: true,
    source: "kamino:strategies/metrics",
  };
}

function parseMarginfi(raw: unknown): Opportunity | null {
  const obj = raw as Record<string, unknown>;
  const state = (obj?.state ?? obj) as Record<string, unknown>;
  const banks = (state?.banks ?? state?.bank ?? []) as unknown[];
  if (!Array.isArray(banks)) return null;

  const usdcBank = banks.find((b) => {
    const text = JSON.stringify(b).toLowerCase();
    return text.includes("usdc");
  }) as Record<string, unknown> | undefined;
  if (!usdcBank) return null;

  const apyCandidates = [
    Number(usdcBank.lendingApy),
    Number(usdcBank.lending_apy),
    Number(usdcBank.supplyApy),
    Number(usdcBank.apy),
  ];
  const apy = apyCandidates.find((v) => Number.isFinite(v) && v > 0);
  if (!apy) return null;

  return {
    protocolId: "marginfi",
    apyBps: pctToBps(apy),
    riskScore: 22,
    assetClass: "stablecoin",
    liquid: true,
    source: "marginfi:state",
  };
}

/**
 * Parse Jupiter Earn /lend/v1/earn/tokens response.
 * Returns an opportunity using the first USDC-like stablecoin entry found,
 * or the highest-supply entry if no stablecoin is identified.
 */
function parseJupiterEarn(raw: unknown): Opportunity | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  type JupToken = { tokenAddress?: string; supplyRate?: string | number; rewardsRate?: string | number };
  const items = raw as JupToken[];
  // Prefer USDC (mainnet or devnet) as representative stablecoin rate.
  const USDC_MINTS = new Set([
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // mainnet
    "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr", // devnet
  ]);
  const entry = items.find((t) => USDC_MINTS.has(t.tokenAddress ?? "")) ?? items[0];
  if (!entry) return null;
  const supply = Number(entry.supplyRate ?? 0);
  const rewards = Number(entry.rewardsRate ?? 0);
  if (!Number.isFinite(supply) || supply <= 0) return null;
  // supplyRate / rewardsRate are scaled by 1e12 in the SDK; convert to bps.
  const apyBps = clampBps(((supply + rewards) / 1e12) * 10_000);
  if (apyBps <= 0) return null;
  return {
    protocolId: "jupiter",
    apyBps,
    riskScore: 20,
    assetClass: "stablecoin",
    liquid: true,
    source: "live:jupiter-earn-api",
  };
}

// Deterministic fallback if upstream APIs fail.
const FALLBACK: Opportunity[] = [
  {
    protocolId: "kamino",
    apyBps: 640,
    riskScore: 18,
    assetClass: "stablecoin",
    liquid: true,
    source: "fallback:kamino",
  },
  {
    protocolId: "marginfi",
    apyBps: 580,
    riskScore: 22,
    assetClass: "stablecoin",
    liquid: true,
    source: "fallback:marginfi",
  },
  {
    protocolId: "jito",
    apyBps: 760,
    riskScore: 30,
    assetClass: "sol",
    liquid: true,
    source: "fallback:jito",
  },
  {
    protocolId: "jupiter",
    apyBps: 450,
    riskScore: 20,
    assetClass: "stablecoin",
    liquid: true,
    source: "fallback:jupiter",
  },
];

Deno.serve(async (req: Request) => {
  // yield-data is a browser-callable public read-only endpoint; allow any
  // http(s) origin when NAVE_ALLOWED_ORIGINS is not configured (dev/staging).
  const corsHeaders = corsHeadersFor(req, { allowBrowserFallback: true });
  const jsonResponse = (data: unknown, status = 200) =>
    jsonWithCors(corsHeaders, data, status);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "GET") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const opportunities: Opportunity[] = [];
  const errors: string[] = [];

  try {
    // Jito's mainnet API is the authoritative rate source. Devnet has no
    // comparable live Jito staking endpoint, so we always fetch from mainnet
    // for the APY rate signal and use NAVE_CLUSTER to decide whether to skip
    // this live fetch entirely (devnet operators may prefer the static fallback).
    // Default: fetch live rates regardless of cluster (mainnet rate serves as
    // a valid proxy for devnet testing since the relative ordering of protocols
    // is what the policy evaluator cares about). Set NAVE_JITO_SKIP_LIVE=true
    // on devnet deployments to skip the live fetch and use the static fallback.
    const skipJitoLive = Deno.env.get("NAVE_JITO_SKIP_LIVE")?.toLowerCase() === "true";
    if (!skipJitoLive) {
      const jitoRaw = await fetchJson(
        "https://kobe.mainnet.jito.network/api/v1/stakePools/overview",
      );
      const jito = parseJito(jitoRaw);
      if (jito) opportunities.push(jito);
    } else {
      // Use static fallback for devnet.
      opportunities.push(FALLBACK.find((f) => f.protocolId === "jito")!);
    }
  } catch (e) {
    errors.push(e instanceof Error ? e.message : "jito fetch failed");
  }

  try {
    // The Kamino cluster must match the deployment. A hardcoded `devnet` fed
    // devnet APYs into the policy engine even on mainnet. Default to mainnet-beta
    // and allow an explicit override.
    const kaminoCluster =
      Deno.env.get("NAVE_KAMINO_CLUSTER") ||
      (Deno.env.get("NAVE_CLUSTER") === "devnet" ? "devnet" : "mainnet-beta");
    const kaminoRaw = await fetchJson(
      `https://api.kamino.finance/strategies/metrics?cluster=${kaminoCluster}`,
    );
    const kamino = parseKamino(kaminoRaw);
    if (kamino) opportunities.push(kamino);
  } catch (e) {
    errors.push(e instanceof Error ? e.message : "kamino fetch failed");
  }

  try {
    const marginfiRaw = await fetchJson("https://api.marginfi.com/state");
    const marginfi = parseMarginfi(marginfiRaw);
    if (marginfi) opportunities.push(marginfi);
  } catch (e) {
    errors.push(e instanceof Error ? e.message : "marginfi fetch failed");
  }

  // Jupiter Lend (Earn) — requires JUPITER_API_KEY Supabase secret.
  const jupiterApiKey = Deno.env.get("JUPITER_API_KEY");
  if (jupiterApiKey) {
    try {
      const jupiterRaw = await fetchJson(
        "https://api.jup.ag/lend/v1/earn/tokens",
        { "x-api-key": jupiterApiKey },
      );
      const jupiter = parseJupiterEarn(jupiterRaw);
      if (jupiter) opportunities.push(jupiter);
    } catch (e) {
      errors.push(e instanceof Error ? e.message : "jupiter fetch failed");
    }
  } else {
    // No API key — use fallback rate so the yield scanner always has a Jupiter entry.
    opportunities.push(FALLBACK.find((f) => f.protocolId === "jupiter")!);
  }

  const payload = {
    opportunities: opportunities.length > 0 ? opportunities : FALLBACK,
    fetched_at: new Date().toISOString(),
    errors: errors.length > 0 ? errors : undefined,
  };
  return jsonResponse(payload);
});
