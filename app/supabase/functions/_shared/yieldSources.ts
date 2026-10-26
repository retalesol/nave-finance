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
import {
  effectiveApy,
  findVenue,
  strategyChainForEvmId,
  type StrategyChain,
  type StrategyRate,
} from "./strategyCatalog.ts";
import { fromStrategyRateRow } from "./apySource.ts";
import {
  ethereumFamilyOpportunities,
  netOfBridgeApyBps,
  yieldBandFor,
  type EthereumFamilyScoreOptions,
} from "./ethereumFamilyYield.ts";

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

/**
 * Pool-scanner classes plus the legacy `"sol"` label, normalized onto policy's
 * AssetClass. `sol-like`, `blue-chip`, and `lp` stay themselves so the widened
 * yield_opportunities check accepts them. Do not fold `sol-like` into `sol`
 * or `other`. Legacy feeds that say `sol` (Jito) become `sol-like`.
 * `stablecoin` stays `stablecoin`.
 */
export function toPolicyAssetClass(value: unknown): AssetClass {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (raw === "sol") return "sol-like";
  if (
    raw === "stablecoin" ||
    raw === "sol-like" ||
    raw === "blue-chip" ||
    raw === "lp" ||
    raw === "other"
  ) {
    return raw;
  }
  return "other";
}

function isEtherBlueChip(protocolId: string, symbol: string): boolean {
  if (symbol === "weth" || symbol === "wsteth") return true;
  return protocolId === "weth"
    || protocolId === "wsteth"
    || protocolId === "aave-v3-weth"
    || protocolId === "robinhood-weth-vault";
}

/**
 * Asset class written to yield_opportunities. Jito is sol-like. WETH and
 * wstETH are blue-chip. Stablecoins stay stablecoin. The result is always a
 * value the widened check allows, and sol-like is never rewritten to a
 * rejected label.
 */
export function persistedAssetClass(input: {
  assetClass?: unknown;
  symbol?: string | null;
  protocolId?: string | null;
}): AssetClass {
  const protocol = (input.protocolId ?? "").trim().toLowerCase();
  const symbol = (input.symbol ?? "").trim().toLowerCase();
  if (protocol === "jito" || protocol === "jitosol") return "sol-like";
  if (isEtherBlueChip(protocol, symbol)) return "blue-chip";
  return toPolicyAssetClass(input.assetClass);
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

const EVM_TESTNET_CHAIN_ID = {
  ethereum: 11155111,
  base: 84532,
  robinhood: 46630,
  arc: 5042002,
} as const;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
/** Adapters bound to the retired Base Sepolia protocol. Never score them as live. */
const STALE_BASE_SEPOLIA_AAVE = new Set([
  "0x536e2eb2f96fe419a893cdbe39e41e44326e60da",
  "0x9fe38d5fe9804c07823b36b4ab16a0e5a7118ebf",
]);
const CURRENT_BASE_SEPOLIA_PROTOCOL = "0x6C07BC6A22d2D18E232D546Ab06B6F49115834C8";
export const SEPOLIA_AAVE_V3_ADAPTER = "0xFfFDfc7DEfbfaF64c232897452Aa6E6F92809426";
export const SEPOLIA_AAVE_V3_ADAPTER_GEN2 = "0xA9183aB50EB70f5F271faB81E50b61a5B11b0a4B";
export const SEPOLIA_COMPOUND_V3_ADAPTER = "0x845d8310A861A95Ed1644643D1BAe086944B1AA0";
export const SEPOLIA_COMPOUND_V3_ADAPTER_GEN2 = "0xa675dC4A02304ce069D98760DcF64B0cf3530A80";
export const BASE_SEPOLIA_AAVE_V3_ADAPTER = "0x33D19799EBac88FFDc4e5BF61c199c71963470A6";
export const BASE_SEPOLIA_AAVE_V3_ADAPTER_GEN2 = "0xcA99d4A75A41C3aff5F3Fc2c2Dfd241129B1e093";
export const ROBINHOOD_STEAKHOUSE_USDG_ADAPTER = "0x31be55dCf50a71B42948408c9eFE7004f827BF0F";
export const ROBINHOOD_WETH_VAULT_ADAPTER = "0xF16421BDD5B9D6418d3133c49f3Afc8cdf15b457";
export const ROBINHOOD_TESTNET_USDC = "0xAaaE26C5B891bF00D4cD6eF04148Bf1CB1CC96b1";
export const ROBINHOOD_TESTNET_WETH = "0x7943e237c7F95DA44E0301572D358911207852Fa";
export const ARC_STEAKHOUSE_USDC_ADAPTER = "0x12DA47672287c188C79c1504eE72E2aC8b446f7B";
export const ARC_CCTP_ADAPTER = "0x1b591C6a976e75F65F54cE863C8d96b3289BBF80";
export const ARC_TESTNET_USDC = "0x3600000000000000000000000000000000000000";
export const SEPOLIA_TESTNET_USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
export const BASE_SEPOLIA_TESTNET_USDC = "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f";

/** Static testnet rates. Same modest figures as the simulation baselines. Not a pool scan. */
const TESTNET_AAVE = { apyBps: 450, riskScore: 16 };
const TESTNET_COMPOUND = { apyBps: 420, riskScore: 18 };
const TESTNET_ROBINHOOD_STEAKHOUSE = { apyBps: 360, riskScore: 18 };
const TESTNET_ROBINHOOD_WETH = { apyBps: 320, riskScore: 22 };
const TESTNET_ARC_STEAKHOUSE = { apyBps: 230, riskScore: 16 };
const TESTNET_CCTP = { apyBps: Math.round(TESTNET_AAVE.apyBps * 0.92), riskScore: 28 };

/** Constitutions use `aave` / `compound`; venue watches and charters use the `-v3` names. */
export function canonicalProtocolId(id: string): string {
  const lower = id.toLowerCase();
  if (lower === "aave-v3") return "aave";
  if (lower === "compound-v3") return "compound";
  return lower;
}

function isAaveId(id: string): boolean {
  return canonicalProtocolId(id) === "aave";
}

function isCompoundId(id: string): boolean {
  return canonicalProtocolId(id) === "compound";
}

function isCctpId(id: string): boolean {
  return id === "cctp" || id === "cctp-sepolia-aave-v3";
}

function isRobinhoodSteakhouseId(id: string): boolean {
  return id === "morpho-steakhouse-usdg" || id === "morpho-steakhouse-usdc" || isAaveId(id);
}

function isRobinhoodWethId(id: string): boolean {
  return id === "robinhood-weth-vault" || id === "arbitrum-bridge";
}

function isArcSteakhouseId(id: string): boolean {
  return id === "morpho-steakhouse-usdc" || isAaveId(id);
}

function usableProgramId(value: string | undefined): string {
  const id = (value ?? "").trim();
  if (!id || id.toLowerCase() === ZERO_ADDRESS) return "";
  return id;
}

function testnetRate(partial: Omit<YieldOpportunity, "source"> & { source: string }): YieldOpportunity {
  return partial;
}

/** Base, Robinhood, and Arc mainnet ids. They receive Ethereum venues, not testnet rates. */
const EVM_MAINNET_YIELD_HOME: Record<string, number> = {
  base: 8453,
  robinhood: 4663,
  arc: 5042,
};

/**
 * Static testnet rates for the venues this testing environment can name.
 * There is no live EVM pool scan. Base Sepolia Aave uses the adapter on the
 * current protocol. A stale adapter address stays unavailable.
 *
 * Base, Robinhood, and Arc (testnet and mainnet) also receive the Ethereum
 * family list. Testnet uses Sepolia and may keep static rates. Mainnet does
 * not copy those static rates onto pools that were not read.
 */
export function scoreEvmTestnetOpportunities(
  approved: ApprovedRef[],
  chain: string,
  chainId?: number | null,
  options?: EthereumFamilyScoreOptions,
): YieldOpportunity[] {
  const family = chain.toLowerCase();
  const expectedId = EVM_TESTNET_CHAIN_ID[family as keyof typeof EVM_TESTNET_CHAIN_ID];
  const mainnetHomeId = EVM_MAINNET_YIELD_HOME[family];
  const isMainnetHome = mainnetHomeId != null && chainId === mainnetHomeId;
  if (isMainnetHome) {
    return ethereumFamilyOpportunities(chainId as number, options);
  }
  if (expectedId == null || chainId !== expectedId) {
    console.info(
      `[yieldSources] static testnet rates apply only to chain ids 11155111, 84532, 46630, and 5042002; chain=${family} chainId=${chainId ?? "unset"}`,
    );
    return [];
  }

  const out: YieldOpportunity[] = [];
  for (const ref of approved) {
    const id = ref.protocolId.toLowerCase();
    if (chainId === 11155111 && isAaveId(id)) {
      out.push(testnetRate({
        protocolId: ref.protocolId,
        programId: usableProgramId(ref.programId) || SEPOLIA_AAVE_V3_ADAPTER,
        apyBps: TESTNET_AAVE.apyBps,
        riskScore: TESTNET_AAVE.riskScore,
        assetClass: "stablecoin",
        liquid: true,
        source: "testnet-rate:aave-v3",
        symbol: "USDC",
      }));
      continue;
    }
    if (chainId === 11155111 && isCompoundId(id)) {
      out.push(testnetRate({
        protocolId: ref.protocolId,
        programId: usableProgramId(ref.programId) || SEPOLIA_COMPOUND_V3_ADAPTER,
        apyBps: TESTNET_COMPOUND.apyBps,
        riskScore: TESTNET_COMPOUND.riskScore,
        assetClass: "stablecoin",
        liquid: true,
        source: "testnet-rate:compound-v3",
        symbol: "USDC",
      }));
      continue;
    }
    if (chainId === 84532 && isAaveId(id)) {
      const program = usableProgramId(ref.programId);
      if (program !== "" && STALE_BASE_SEPOLIA_AAVE.has(program.toLowerCase())) {
        out.push(testnetRate({
          protocolId: ref.protocolId,
          programId: "",
          apyBps: TESTNET_AAVE.apyBps,
          riskScore: 100,
          assetClass: "stablecoin",
          liquid: false,
          source: `testnet-rate:unavailable: Base Sepolia Aave V3 adapter must be the one on protocol ${CURRENT_BASE_SEPOLIA_PROTOCOL}`,
          symbol: "USDC",
        }));
        continue;
      }
      out.push(testnetRate({
        protocolId: ref.protocolId,
        programId: program || BASE_SEPOLIA_AAVE_V3_ADAPTER,
        apyBps: TESTNET_AAVE.apyBps,
        riskScore: TESTNET_AAVE.riskScore,
        assetClass: "stablecoin",
        liquid: true,
        source: "testnet-rate:aave-v3",
        symbol: "USDC",
      }));
      continue;
    }
    if (chainId === 46630 && isRobinhoodSteakhouseId(id)) {
      const program = usableProgramId(ref.programId);
      out.push(testnetRate({
        protocolId: ref.protocolId,
        programId: program || ROBINHOOD_STEAKHOUSE_USDG_ADAPTER,
        apyBps: TESTNET_ROBINHOOD_STEAKHOUSE.apyBps,
        riskScore: TESTNET_ROBINHOOD_STEAKHOUSE.riskScore,
        assetClass: "stablecoin",
        liquid: true,
        source: "testnet-rate:morpho-steakhouse-usdg",
        symbol: "USDC",
        mint: ROBINHOOD_TESTNET_USDC,
      }));
      continue;
    }
    if (chainId === 46630 && isRobinhoodWethId(id)) {
      const program = usableProgramId(ref.programId);
      out.push(testnetRate({
        protocolId: ref.protocolId,
        programId: program || ROBINHOOD_WETH_VAULT_ADAPTER,
        apyBps: TESTNET_ROBINHOOD_WETH.apyBps,
        riskScore: TESTNET_ROBINHOOD_WETH.riskScore,
        assetClass: "blue-chip",
        liquid: true,
        source: "testnet-rate:robinhood-weth-vault",
        symbol: "WETH",
        mint: ROBINHOOD_TESTNET_WETH,
      }));
      continue;
    }
    if (chainId === 5042002 && isArcSteakhouseId(id)) {
      const program = usableProgramId(ref.programId);
      out.push(testnetRate({
        protocolId: ref.protocolId,
        programId: program || ARC_STEAKHOUSE_USDC_ADAPTER,
        apyBps: TESTNET_ARC_STEAKHOUSE.apyBps,
        riskScore: TESTNET_ARC_STEAKHOUSE.riskScore,
        assetClass: "stablecoin",
        liquid: true,
        source: "testnet-rate:morpho-steakhouse-usdc",
        symbol: "USDC",
        mint: ARC_TESTNET_USDC,
      }));
      continue;
    }
    if ((chainId === 46630 || chainId === 5042002) && isCctpId(id)) {
      const program = usableProgramId(ref.programId);
      out.push(testnetRate({
        protocolId: ref.protocolId,
        programId: program || (chainId === 5042002 ? ARC_CCTP_ADAPTER : ROBINHOOD_STEAKHOUSE_USDG_ADAPTER),
        apyBps: TESTNET_CCTP.apyBps,
        riskScore: TESTNET_CCTP.riskScore,
        assetClass: "stablecoin",
        liquid: true,
        source: "testnet-rate:cctp-to-sepolia-aave-v3: bridge test USDC to the Sepolia sister treasury and supply Aave V3 there",
        symbol: "USDC",
        mint: chainId === 5042002 ? ARC_TESTNET_USDC : ROBINHOOD_TESTNET_USDC,
      }));
    }
  }
  if (family === "base" || family === "robinhood" || family === "arc") {
    out.push(...ethereumFamilyOpportunities(chainId, options));
  }
  return out;
}

/**
 * Scan yield opportunities for the approved protocols. Read-only and
 * fail-safe: any source error falls back to the deterministic built-in table so
 * the policy loop always has inputs to reason over.
 *
 * Source priority:
 *   1. NAVE_YIELD_SOURCE_URL (operator-run aggregator) — Solana
 *   2. Live pool scanner (requires JUPITER_API_KEY + protocol program IDs) — Solana
 *   3. Built-in fallback table — Solana
 * EVM testnets use static testnet rates (see scoreEvmTestnetOpportunities).
 * That path is not a live pool scan.
 */
export async function scanYieldOpportunities(
  approved: ApprovedRef[],
  sourceUrl?: string,
  chain?: string,
  chainId?: number | null,
  scoreOptions?: EthereumFamilyScoreOptions,
): Promise<YieldOpportunity[]> {
  const family = (chain ?? "solana").toLowerCase();
  if (family === "base" || family === "robinhood" || family === "ethereum" || family === "arc") {
    return scoreEvmTestnetOpportunities(approved, family, chainId, scoreOptions);
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
          marginfiProgramId: Deno.env.get("NAVE_MARGINFI_ADAPTER_ID") || undefined,
          jitoProgramId: jitoId,
          jupiterProgramId: jupiterId,
          jupiterApiKey,
          cluster: "mainnet-beta",
          rpcUrl: Deno.env.get("SOLANA_MAINNET_RPC_URL") || undefined,
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
 * Replace each opportunity's APY with the venue's live mainnet rate from
 * strategy_rates (via `effectiveApy`: base yield only, temporary spikes fall
 * back to the 30-day mean), then rank best first. Testnet venues have no rate
 * of their own, so the mainnet reference rate stands in and the source says so.
 * Opportunities with no catalog venue or no stored rate keep their figure.
 */
export function applyLiveRates<T extends YieldOpportunity>(
  opportunities: T[],
  chain: string,
  chainId: number | null | undefined,
  rates: StrategyRate[],
): T[] {
  const family = chain.toLowerCase();
  const defaultChain: StrategyChain | null = family === "solana" ? "solana" : strategyChainForEvmId(chainId ?? null);
  if (!defaultChain && opportunities.every((o) => !o.rateChain)) return opportunities;
  const byVenue = new Map(rates.map((r) => [`${r.chain}:${r.venueId}`, r]));
  const testnet = chainId != null && [11155111, 84532, 46630, 5042002].includes(chainId);
  const out = opportunities.map((o) => {
    if (o.liquid === false && o.riskScore >= 100) return o;
    const rateChain = o.rateChain ?? defaultChain;
    if (!rateChain) return o;
    const venueId = o.rateVenueId ?? canonicalProtocolId(o.protocolId);
    const venue = findVenue(rateChain, venueId);
    const rate = byVenue.get(`${rateChain}:${venueId}`);
    if (!venue || !rate || rate.baseApy == null) return o;
    const apy = effectiveApy(rate, venue.fallbackApy);
    const grossBps = Math.round(apy * 100);
    const nextSource = `${testnet ? "mainnet-reference-rate" : "live-rate"}:${rate.source}`;
    if (o.bridgeRequired && o.bridgeOneWayCostBps != null) {
      const net = netOfBridgeApyBps(grossBps, o.bridgeOneWayCostBps);
      const execToken = o.executable ? "executable" : "not-executable";
      return {
        ...o,
        venueApyBps: grossBps,
        netApyBps: net,
        apyBps: net,
        apyRead: true,
        yieldBand: yieldBandFor(net),
        tvlUsd: rate.tvlUsd ?? o.tvlUsd,
        source: `${nextSource}:bridge-required:${o.bridgeCostSource ?? ""}:${execToken}`,
      };
    }
    return {
      ...o,
      apyBps: grossBps,
      apyRead: true,
      tvlUsd: rate.tvlUsd ?? o.tvlUsd,
      source: nextSource,
    };
  });
  return out.sort((a, b) => b.apyBps - a.apyBps);
}

/** Latest stored rates; empty on any read error so callers keep static figures. */
export async function loadStrategyRates(
  supabase: { from: (table: string) => { select: (cols: string) => PromiseLike<{ data: unknown[] | null; error: unknown }> } },
): Promise<StrategyRate[]> {
  try {
    const { data, error } = await supabase.from("strategy_rates").select("*");
    if (error || !data) return [];
    return data.map((row) => fromStrategyRateRow(row as Record<string, unknown>));
  } catch {
    return [];
  }
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
      .map((watch) => canonicalProtocolId(watch.protocolId)),
  );
  if (stopped.size === 0) return opportunities;
  return opportunities.filter((item) => !stopped.has(canonicalProtocolId(item.protocolId)));
}
