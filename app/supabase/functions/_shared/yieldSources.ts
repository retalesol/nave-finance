// Read-only yield opportunity scanner (Phase 2 — extended in Phase 3).
//
// Source resolution (in order):
//   1. If NAVE_YIELD_SOURCE_URL is set, fetch JSON from it (an operator-run
//      read-only aggregator). Expected shape: { opportunities: YieldOpportunity[] }.
//   2. If JUPITER_API_KEY is set, use the pool scanner (poolScanner.ts) to
//      query all four protocols live and return per-(protocol, asset) granular
//      opportunities filtered to the curated asset allowlist.
//   3. Fall back to the conservative deterministic built-in table.
//
// The scanner only ever returns opportunities for protocols in the supplied
// approved-protocol allowlist; unapproved venues are dropped before the
// evaluator sees them.

import type { AssetClass, YieldOpportunity } from "./policy.ts";
import { scanAllPools } from "./poolScanner.ts";

interface ApprovedRef {
  protocolId: string;
  programId: string;
}

// Conservative built-in baseline. APY in bps, risk 0..100 (lower = safer).
// These are intentionally modest, low-risk, stablecoin/LST-style defaults that
// match the constitution's "high yield, extremely low risk" intent. Operators
// SHOULD point NAVE_YIELD_SOURCE_URL at a live feed for production.
const BUILTIN: Record<string, { apyBps: number; riskScore: number; assetClass: AssetClass; liquid: boolean; source: string }> = {
  kamino:   { apyBps: 640, riskScore: 18, assetClass: "stablecoin", liquid: true, source: "builtin:kamino-usdc-reserve"    },
  marginfi: { apyBps: 580, riskScore: 22, assetClass: "stablecoin", liquid: true, source: "builtin:marginfi-usdc-lending"  },
  jito:     { apyBps: 760, riskScore: 30, assetClass: "sol-like",   liquid: true, source: "builtin:jito-sol-staking"       },
  // Jupiter Lend (Earn): supply yield on stablecoins and SOL via jlTokens.
  // The builtin APY is a conservative devnet baseline; production should fetch
  // live rates from the Jupiter Earn API (/lend/v1/earn/tokens) via NAVE_YIELD_SOURCE_URL
  // or JUPITER_API_KEY (see the yield-data edge function).
  jupiter:  { apyBps: 450, riskScore: 20, assetClass: "stablecoin", liquid: true, source: "builtin:jupiter-earn-usdc"     },
};

/**
 * Attempt to fetch a live Jupiter Earn supply rate for `protocolId === 'jupiter'`.
 * Requires JUPITER_API_KEY. Falls back to null on any error so the caller can
 * use the built-in baseline instead.
 */
async function fetchJupiterEarnApyBps(mint?: string): Promise<number | null> {
  const apiKey =
    typeof Deno !== "undefined" ? Deno.env.get("JUPITER_API_KEY") : undefined;
  if (!apiKey) return null;
  try {
    const resp = await fetch("https://api.jup.ag/lend/v1/earn/tokens", {
      headers: { "x-api-key": apiKey },
    });
    if (!resp.ok) return null;
    const data = await resp.json() as Array<{
      tokenAddress?: string;
      supplyRate?: string | number;
      rewardsRate?: string | number;
    }>;
    // Find the entry matching the requested mint (defaults to USDC on devnet).
    const USDC_DEVNET = "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr";
    const target = mint ?? USDC_DEVNET;
    const entry = data.find((t) => t.tokenAddress === target) ?? data[0];
    if (!entry) return null;
    // supplyRate + rewardsRate are scaled by 1e12 in the SDK; compute total APY in bps.
    const supply = Number(entry.supplyRate ?? 0);
    const rewards = Number(entry.rewardsRate ?? 0);
    if (!Number.isFinite(supply) || supply <= 0) return null;
    // Scale factor 1e12 → decimal APY → bps (×10000).
    const apyBps = Math.round(((supply + rewards) / 1e12) * 10_000);
    return apyBps > 0 ? apyBps : null;
  } catch {
    return null;
  }
}

async function fromBuiltin(approved: ApprovedRef[]): Promise<YieldOpportunity[]> {
  // Pre-fetch live Jupiter rate once if Jupiter is in the approved list.
  const hasJupiter = approved.some((a) => a.protocolId.toLowerCase() === "jupiter");
  const liveJupiterApyBps = hasJupiter ? await fetchJupiterEarnApyBps() : null;

  const out: YieldOpportunity[] = [];
  for (const a of approved) {
    const id = a.protocolId.toLowerCase();
    const b = BUILTIN[id];
    if (!b) continue;
    const apyBps = (id === "jupiter" && liveJupiterApyBps !== null)
      ? liveJupiterApyBps
      : b.apyBps;
    out.push({
      protocolId: a.protocolId,
      programId: a.programId,
      apyBps,
      riskScore: b.riskScore,
      assetClass: b.assetClass,
      liquid: b.liquid,
      source: (id === "jupiter" && liveJupiterApyBps !== null)
        ? "live:jupiter-earn-api"
        : b.source,
    });
  }
  return out;
}

/** Pool-scanner classes plus the legacy `"sol"` label, normalized onto policy's AssetClass. */
export function toPolicyAssetClass(value: unknown): AssetClass {
  if (value === "sol") return "sol-like";
  if (
    value === "stablecoin" ||
    value === "sol-like" ||
    value === "blue-chip" ||
    value === "lp" ||
    value === "other"
  ) {
    return value;
  }
  return "other";
}

function sanitize(raw: unknown, approved: ApprovedRef[]): YieldOpportunity[] {
  if (!raw || typeof raw !== "object") return [];
  const list = (raw as { opportunities?: unknown }).opportunities;
  if (!Array.isArray(list)) return [];
  const approvedIds = new Map(approved.map((a) => [a.protocolId.toLowerCase(), a]));
  const out: YieldOpportunity[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const protocolId = String(o.protocolId ?? "").trim();
    const ref = approvedIds.get(protocolId.toLowerCase());
    if (!ref) continue; // not approved -> drop
    const apyBps = Number(o.apyBps);
    const riskScore = Number(o.riskScore);
    if (!Number.isFinite(apyBps) || apyBps < 0) continue;
    if (!Number.isFinite(riskScore) || riskScore < 0 || riskScore > 100) continue;
    const assetClass = toPolicyAssetClass(o.assetClass);
    out.push({
      protocolId: ref.protocolId,
      // Bind to the on-chain approved program id, never a feed-supplied one.
      programId: ref.programId,
      apyBps: Math.round(apyBps),
      riskScore: Math.round(riskScore),
      assetClass,
      liquid: o.liquid !== false,
      source: typeof o.source === "string" ? o.source : "external",
    });
  }
  return out;
}

/**
 * Scan yield opportunities for the approved protocols. Read-only and
 * fail-safe: any source error falls back to the deterministic built-in table so
 * the policy loop always has inputs to reason over.
 *
 * Source priority:
 *   1. NAVE_YIELD_SOURCE_URL (operator-run aggregator)
 *   2. Live pool scanner (requires JUPITER_API_KEY + protocol program IDs)
 *   3. Built-in fallback table
 */
export async function scanYieldOpportunities(
  approved: ApprovedRef[],
  sourceUrl?: string,
  chain?: string,
): Promise<YieldOpportunity[]> {
  const family = (chain ?? "solana").toLowerCase();
  if (family === "base" || family === "robinhood" || family === "ethereum") {
    console.info(
      `[yieldSources] no EVM yield markets are scored for chain=${family}; returning an empty opportunity list`,
    );
    return [];
  }
  const url = sourceUrl ?? (typeof Deno !== "undefined" ? Deno.env.get("NAVE_YIELD_SOURCE_URL") : undefined);
  if (url) {
    try {
      const resp = await fetch(url, { method: "GET" });
      if (resp.ok) {
        const json = await resp.json();
        const parsed = sanitize(json, approved);
        if (parsed.length > 0) return parsed;
      } else {
        console.warn(`[yieldSources] source ${url} -> HTTP ${resp.status}; using pool scanner`);
      }
    } catch (e) {
      console.warn(`[yieldSources] source fetch failed; trying pool scanner:`, e instanceof Error ? e.message : e);
    }
  }

  // Source 2: live pool scanner (when protocol IDs + API key are configured)
  if (typeof Deno !== "undefined") {
    const jupiterApiKey = Deno.env.get("JUPITER_API_KEY");
    const kaminoId = Deno.env.get("NAVE_KAMINO_ADAPTER_ID");
    const jitoId = Deno.env.get("NAVE_JITO_ADAPTER_ID");
    const jupiterId = Deno.env.get("JUPITER_LENDING_PROGRAM_ID")
      ?? "7tjE28izRUjzmxC1QNXnNwcc4N82CNYCexf3k8mw67s3";

    if (kaminoId && jitoId) {
      try {
        const approvedIds = new Set(approved.map((a) => a.protocolId.toLowerCase()));
        const allPools = await scanAllPools({
          kaminoProgramId: kaminoId,
          jitoProgramId: jitoId,
          jupiterProgramId: jupiterId,
          jupiterApiKey,
          cluster: "mainnet-beta",
        });
        // Filter to approved protocols only, and map to YieldOpportunity
        const filtered = allPools.filter((p) => approvedIds.has(p.protocolId));
        if (filtered.length > 0) {
          return filtered.map((p) => ({
            protocolId: p.protocolId,
            programId: p.programId,
            mint: p.mint,
            symbol: p.symbol,
            poolId: p.poolId,
            extMarket: p.extMarket,
            extReserve: p.extReserve,
            collateralMint: p.collateralMint,
            apyBps: p.apyBps,
            riskScore: p.riskScore,
            adjustedScore: p.adjustedScore,
            tvlUsd: p.tvlUsd,
            assetClass: toPolicyAssetClass(p.assetClass),
            liquid: p.liquid,
            source: p.source,
          }));
        }
      } catch (e) {
        console.warn(`[yieldSources] pool scanner failed; using builtin:`, e instanceof Error ? e.message : e);
      }
    }
  }

  return fromBuiltin(approved);
}

/**
 * Drop venues a finished watch marked stop. The venue flag defaults off, so a
 * stop is ignored until NAVE_GENLAYER_VENUE_GATE=true. Watch and fine stay.
 */
export function withholdStoppedVenues<T extends { protocolId: string }>(
  opportunities: T[],
  watches: Array<{ protocolId: string; status: string }>,
  venueGate: boolean,
): T[] {
  if (!venueGate) return opportunities;
  const stopped = new Set(
    watches
      .filter((watch) => watch.status === "stop")
      .map((watch) => watch.protocolId.toLowerCase()),
  );
  if (stopped.size === 0) return opportunities;
  return opportunities.filter((item) => !stopped.has(item.protocolId.toLowerCase()));
}
