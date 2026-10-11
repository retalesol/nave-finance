// nave-price-oracle — the ONE canonical NAVE/USD creation-price endpoint.
//
// Both the app (CreateDAO stake gate) and the server-side transaction builders
// call this so the required DAO-creation stake ($99 of NAVE) is derived from a
// single, attested number.
//
// GET (public, browser-callable)
//   ?stake_usd=<number>   optional override of the staked USD value (default 99)
//   ?persist=0            optional; skip writing a snapshot row (default: persist)
//                         Anonymous callers only persist when the newest stored
//                         attestation is older than NAVE_ORACLE_PERSIST_TTL_SECONDS
//                         (default 60); X-Indexer-Secret callers always persist.
//   ?health=1             lightweight config probe (no pricing)
//
// Response (200): { ok, network, naveMint, priceUsd, source, quote, attestation,
//                   sources?, dropped?, persisted }
// Fail-closed (503) on mainnet when too few healthy market samples survive.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { corsHeadersFor, jsonWithCors, secretsMatch } from "../_shared/http.ts";
import {
  aggregateSamples,
  attest,
  buildStakeQuote,
  gatherMainnetSamples,
  isMainnet,
  loadOracleConfig,
  type MarketSample,
  type StakeQuote,
} from "../_shared/naveOracle.ts";

function getSupabase() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return null;
  return createClient(url, key);
}

/** Persist an oracle snapshot/attestation row (best-effort; never blocks). */
// deno-lint-ignore no-explicit-any
async function persistAttestation(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  quote: StakeQuote,
  source: string,
  sampleCount: number,
  attestation: { payloadHash: string; signature: string | null; signed: boolean; algorithm: string },
  used: MarketSample[],
): Promise<boolean> {
  try {
    const { error } = await supabase.from("nave_price_attestations").insert({
      network: quote.network,
      nave_mint: quote.naveMint,
      price_usd: quote.priceUsd,
      stake_usd: quote.stakeUsd,
      required_nave_base_units: quote.requiredNaveBaseUnits,
      min_nave_base_units: quote.minNaveBaseUnits,
      nave_decimals: quote.naveDecimals,
      quote_tolerance_bps: quote.quoteToleranceBps,
      source,
      sample_count: sampleCount,
      payload_hash: attestation.payloadHash,
      signature: attestation.signature,
      signed: attestation.signed,
      algorithm: attestation.algorithm,
      issued_at: quote.issuedAt,
      expires_at: quote.expiresAt,
      payload: quote,
      samples: used,
    });
    if (error) {
      console.error("[nave-price-oracle] persist failed:", error.message);
      return false;
    }
    return true;
  } catch (e) {
    console.error("[nave-price-oracle] persist threw:", e instanceof Error ? e.message : e);
    return false;
  }
}

const PERSIST_TTL_MS = (() => {
  const n = Number(Deno.env.get("NAVE_ORACLE_PERSIST_TTL_SECONDS"));
  return (Number.isFinite(n) && n >= 0 ? n : 60) * 1000;
})();

/** True when no attestation for `network` was stored within the TTL window. */
// deno-lint-ignore no-explicit-any
async function anonymousPersistWindowOpen(supabase: any, network: string): Promise<boolean> {
  if (PERSIST_TTL_MS === 0) return true;
  try {
    const { data, error } = await supabase
      .from("nave_price_attestations")
      .select("issued_at")
      .eq("network", network)
      .order("issued_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      console.error("[nave-price-oracle] persist-window read failed:", error.message);
      return false; // fail closed: don't write when we can't tell
    }
    if (!data?.issued_at) return true;
    return Date.now() - new Date(data.issued_at).getTime() >= PERSIST_TTL_MS;
  } catch (e) {
    console.error("[nave-price-oracle] persist-window threw:", e instanceof Error ? e.message : e);
    return false;
  }
}

Deno.serve(async (req: Request) => {
  // Public, read-only endpoint: reflect any http(s) origin when no allow-list is
  // configured (dev/staging) and honor NAVE_ALLOWED_ORIGINS in production.
  const corsHeaders = corsHeadersFor(req, { allowBrowserFallback: true });
  const jsonResponse = (data: unknown, status = 200) =>
    jsonWithCors(corsHeaders, data, status);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "GET") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const cfg = loadOracleConfig();
  const url = new URL(req.url);

  if (url.searchParams.get("health") === "1") {
    return jsonResponse({
      ok: true,
      service: "nave-price-oracle",
      network: cfg.network,
      naveMint: cfg.naveMint,
      mode: isMainnet(cfg.network) ? "multi-chain" : "fixed",
      config: {
        stakeUsd: cfg.stakeUsd,
        devnetPriceUsd: cfg.devnetPriceUsd,
        minSources: cfg.minSources,
        minLiquidityUsd: cfg.minLiquidityUsd,
        maxPriceAgeSeconds: cfg.maxPriceAgeSeconds,
        attestationSigned: Boolean(Deno.env.get("NAVE_ORACLE_ATTESTATION_SECRET")),
        pools: cfg.pools,
        meteoraPair: cfg.meteoraPair ?? null,
        coingeckoId: cfg.coingeckoId || null,
      },
    });
  }

  // SEC-M6: the attestation signs the whole quote — including stake_usd — so an
  // attacker-chosen `?stake_usd=1` used to yield a validly-signed quote for a
  // $1 stake. Only authenticated service callers (X-Indexer-Secret) may
  // override the canonical stake target; unauthenticated callers get exactly
  // cfg.stakeUsd (a matching redundant param is tolerated for old clients).
  const stakeUsdParam = url.searchParams.get("stake_usd");
  let stakeUsdOverride = stakeUsdParam != null ? Number(stakeUsdParam) : undefined;
  if (stakeUsdOverride != null && (!Number.isFinite(stakeUsdOverride) || stakeUsdOverride <= 0)) {
    return jsonResponse({ error: "stake_usd must be a positive number" }, 400);
  }
  if (stakeUsdOverride != null && stakeUsdOverride !== cfg.stakeUsd) {
    const serviceSecret = Deno.env.get("NAVE_INDEXER_SECRET");
    const provided = req.headers.get("X-Indexer-Secret");
    if (!serviceSecret || !secretsMatch(provided, serviceSecret)) {
      return jsonResponse(
        { error: "stake_usd override requires service authentication; the canonical stake target is fixed" },
        403,
      );
    }
  }
  if (stakeUsdOverride === cfg.stakeUsd) stakeUsdOverride = undefined;
  const persistRequested = url.searchParams.get("persist") !== "0";
  const serviceCaller = (() => {
    const serviceSecret = Deno.env.get("NAVE_INDEXER_SECRET");
    return Boolean(serviceSecret) && secretsMatch(req.headers.get("X-Indexer-Secret"), serviceSecret!);
  })();

  try {
    let priceUsd: number;
    let source: "fixed" | "multi-chain";
    let used: MarketSample[] = [];
    let dropped: Array<MarketSample & { reason: string }> = [];
    let attempts: Array<{ market: string; ok: boolean; error?: string }> = [];

    if (isMainnet(cfg.network)) {
      const gathered = await gatherMainnetSamples(cfg);
      attempts = gathered.attempts;
      const agg = aggregateSamples(cfg, gathered.samples); // throws => fail-closed
      priceUsd = agg.priceUsd;
      used = agg.used;
      dropped = agg.dropped;
      source = "multi-chain";
    } else {
      priceUsd = cfg.devnetPriceUsd;
      source = "fixed";
    }

    if (!(priceUsd > 0) || !Number.isFinite(priceUsd)) {
      return jsonResponse({ ok: false, error: "oracle produced a non-positive price" }, 503);
    }

    const quote = buildStakeQuote(cfg, priceUsd, source, stakeUsdOverride);
    const attestation = await attest(quote);

    // Write amplification guard: an anonymous GET used to insert a row every
    // hit. Now only service callers persist unconditionally; anonymous hits
    // persist at most once per TTL window (a cheap indexed read otherwise).
    let persisted = false;
    const supabase = getSupabase();
    if (persistRequested && supabase) {
      const shouldPersist = serviceCaller ||
        await anonymousPersistWindowOpen(supabase, quote.network);
      if (shouldPersist) {
        persisted = await persistAttestation(supabase, quote, source, used.length, attestation, used);
      }
    }

    return jsonResponse({
      ok: true,
      network: cfg.network,
      naveMint: cfg.naveMint,
      priceUsd,
      source,
      quote,
      attestation,
      sources: source === "multi-chain" ? used : undefined,
      dropped: dropped.length > 0 ? dropped : undefined,
      attempts: attempts.length > 0 ? attempts : undefined,
      persisted,
      fetchedAt: new Date().toISOString(),
    });
  } catch (e) {
    // Mainnet aggregation fails closed here: surface 503 so callers treat the
    // creation flow as temporarily unavailable rather than under-collateralize.
    const message = e instanceof Error ? e.message : "oracle error";
    console.error("[nave-price-oracle] error:", message);
    return jsonResponse({ ok: false, error: message }, 503);
  }
});
