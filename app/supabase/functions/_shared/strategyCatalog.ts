// Strategy menu: every venue the constitution can name, with its risk tier,
// exit behavior, risks and live-rate source. Runtime-agnostic (no Deno or
// Vite APIs) so the edge rate job, the policy evaluator and the browser read
// the same list.
//
// Tiers:
//   1  lending and savings (Aave, Compound, curated Morpho, Sky/Spark, Jupiter
//      Lend, Kamino main-market USDC)
//   2  higher-utilization or higher-risk curated vaults
//   3  credit, synthetic dollars and fixed-term (Maple, Ethena, Pendle PT)
// Approved caps within a tier are summed on-chain: Tier 2 at most 30%,
// Tier 3 at most 15% (NaveConstants / nave_core constants).

export type RiskTier = 1 | 2 | 3;
export type StrategyChain = "solana" | "ethereum" | "base" | "robinhood" | "arc";
export type ExitKind = "instant" | "queue" | "cooldown" | "maturity";

export type RateSource =
  | { kind: "defillama"; pool: string }
  | { kind: "morpho"; chainId: number; vault: string }
  | { kind: "kamino"; market: string; mint: string }
  | { kind: "pendle"; chainId: number; market: string };

export interface StrategyVenue {
  /** Constitution protocol id (unique per chain). */
  id: string;
  chain: StrategyChain;
  label: string;
  asset: string;
  tier: RiskTier;
  /** False for venues whose asset is not a dollar (Jito SOL). */
  stable: boolean;
  exit: ExitKind;
  /** Plain-language exit delay shown next to the venue. */
  exitNote: string;
  risks: string[];
  rate: RateSource | null;
  /** Base APY (%) as of Oct 10, 2026, used until the first live refresh. */
  fallbackApy: number;
  /** Where the adapter is proven: deployed on the chain's testnet, or fork-only. */
  availability: "testnet" | "fork-only" | "later";
  /** Why a "later" venue is not selectable yet. */
  laterReason?: string;
  /** Hidden from the default menu (shown only behind its feature flag). */
  hiddenByDefault?: boolean;
}

export const TIER2_TOTAL_CAP_PCT = 30;
export const TIER3_TOTAL_CAP_PCT = 15;

const KAMINO_MAIN_MARKET = "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF";
const SOL_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const INSTANT = "Instant";
const LENDING_RISK = "Withdrawals wait if the pool is fully borrowed.";

export const STRATEGY_VENUES: StrategyVenue[] = [
  // ── Solana ─────────────────────────────────────────────────────────────
  {
    id: "jupiter", chain: "solana", label: "Jupiter Lend USDC", asset: "USDC", tier: 1, stable: true,
    exit: "instant", exitNote: INSTANT, risks: [LENDING_RISK],
    rate: { kind: "defillama", pool: "d783c8df-e2ed-44b4-8317-161ccc1b5f06" },
    fallbackApy: 4.9, availability: "testnet",
  },
  {
    id: "kamino", chain: "solana", label: "Kamino USDC", asset: "USDC", tier: 1, stable: true,
    exit: "instant", exitNote: INSTANT, risks: [LENDING_RISK],
    rate: { kind: "kamino", market: KAMINO_MAIN_MARKET, mint: SOL_USDC },
    fallbackApy: 4.5, availability: "testnet",
  },
  {
    id: "jito", chain: "solana", label: "Jito staked SOL", asset: "SOL", tier: 1, stable: false,
    exit: "instant", exitNote: "Instant through the stake pool; SOL price moves with the market",
    risks: ["SOL, not stable: the position's dollar value moves with SOL."],
    rate: { kind: "defillama", pool: "0e7d0722-9054-4907-8593-567b353c0900" },
    fallbackApy: 4.9, availability: "testnet",
  },
  {
    id: "marginfi", chain: "solana", label: "MarginFi USDC", asset: "USDC", tier: 1, stable: true,
    exit: "instant", exitNote: INSTANT, risks: [LENDING_RISK, "Small TVL."],
    rate: null, fallbackApy: 0, availability: "testnet", hiddenByDefault: true,
  },
  {
    id: "kamino-pyusd", chain: "solana", label: "Kamino PYUSD", asset: "PYUSD", tier: 2, stable: true,
    exit: "instant", exitNote: "Instant when liquidity allows; the pool runs near 90% borrowed",
    risks: ["High utilization: withdrawals can wait for repayments."],
    rate: { kind: "kamino", market: KAMINO_MAIN_MARKET, mint: "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo" },
    fallbackApy: 9.0, availability: "later",
    laterReason: "Shares Kamino's on-chain constitution entry; a per-reserve cap is needed first.",
  },
  {
    id: "kamino-syrupusdc", chain: "solana", label: "Kamino syrupUSDC markets", asset: "USDC", tier: 3, stable: true,
    exit: "instant", exitNote: "Instant when liquidity allows",
    risks: ["Lends against Maple credit collateral."],
    rate: null, fallbackApy: 0, availability: "later",
    laterReason: "Shares Kamino's on-chain constitution entry; a per-reserve cap is needed first.",
  },

  // ── Ethereum ───────────────────────────────────────────────────────────
  {
    id: "aave", chain: "ethereum", label: "Aave V3 USDC", asset: "USDC", tier: 1, stable: true,
    exit: "instant", exitNote: INSTANT, risks: [LENDING_RISK],
    rate: { kind: "defillama", pool: "aa70268e-4b52-42bf-a116-608b370f9501" },
    fallbackApy: 4.3, availability: "testnet",
  },
  {
    id: "compound", chain: "ethereum", label: "Compound V3 USDC", asset: "USDC", tier: 1, stable: true,
    exit: "instant", exitNote: INSTANT, risks: [LENDING_RISK],
    rate: { kind: "defillama", pool: "7da72d09-56ca-4ec5-a45f-59114353e487" },
    fallbackApy: 4.2, availability: "testnet",
  },
  {
    id: "morpho-steakhouse-usdc", chain: "ethereum", label: "Morpho Steakhouse USDC", asset: "USDC", tier: 1, stable: true,
    exit: "instant", exitNote: INSTANT, risks: [LENDING_RISK, "Curator picks the Morpho markets."],
    rate: { kind: "morpho", chainId: 1, vault: "0xBEEF01735c132Ada46AA9aA4c54623cAA92A64CB" },
    fallbackApy: 4.5, availability: "fork-only",
  },
  {
    id: "morpho-gauntlet-usdc", chain: "ethereum", label: "Morpho Gauntlet USDC Prime", asset: "USDC", tier: 1, stable: true,
    exit: "instant", exitNote: INSTANT, risks: [LENDING_RISK, "Curator picks the Morpho markets."],
    rate: { kind: "morpho", chainId: 1, vault: "0xdd0f28e19C1780eb6396170735D45153D261490d" },
    fallbackApy: 4.5, availability: "fork-only",
  },
  {
    id: "sky-susds", chain: "ethereum", label: "Sky sUSDS", asset: "USDS", tier: 1, stable: true,
    exit: "instant", exitNote: INSTANT, risks: ["Rate set by Sky governance."],
    rate: { kind: "defillama", pool: "d8c4eff5-c8a9-46fc-a888-057c4c668e72" },
    fallbackApy: 3.8, availability: "fork-only",
  },
  {
    id: "spark-susdc", chain: "ethereum", label: "Spark sUSDC", asset: "USDC", tier: 1, stable: true,
    exit: "instant", exitNote: INSTANT, risks: ["Wraps sUSDS; rate set by Sky governance."],
    rate: { kind: "defillama", pool: "d8c4eff5-c8a9-46fc-a888-057c4c668e72" },
    fallbackApy: 3.8, availability: "fork-only",
  },
  {
    id: "maple-syrup", chain: "ethereum", label: "Maple syrupUSDC", asset: "USDC", tier: 3, stable: true,
    exit: "queue", exitNote: "Maple withdrawal queue, usually under a day",
    risks: [
      "Overcollateralized loans to institutional borrowers; a default reduces the pool.",
      "Maple must allowlist the treasury's adapter before it can deposit.",
    ],
    rate: { kind: "defillama", pool: "43641cf5-a92e-416b-bce9-27113d3c0db6" },
    fallbackApy: 5.3, availability: "fork-only",
  },
  {
    id: "ethena-susde", chain: "ethereum", label: "Ethena sUSDe", asset: "USDe", tier: 3, stable: true,
    exit: "cooldown", exitNote: "Ethena cooldown read from chain (1 day on Oct 10, 2026)",
    risks: [
      "Synthetic dollar backed by hedged derivatives positions.",
      "Funding rates can turn negative and cut the yield.",
    ],
    rate: { kind: "defillama", pool: "66985a81-9c51-46ca-9977-42b4fe7bc6df" },
    fallbackApy: 5.1, availability: "fork-only",
  },
  {
    id: "pendle-pt-susde", chain: "ethereum", label: "Pendle PT-sUSDe (Nov 26, 2026)", asset: "sUSDe", tier: 3, stable: true,
    exit: "maturity", exitNote: "Locked until Nov 26, 2026 unless the guardian quorum approves an early sale",
    risks: [
      "Fixed rate only if held to maturity; an early sale takes the market price.",
      "Inherits Ethena sUSDe risk.",
    ],
    rate: { kind: "pendle", chainId: 1, market: "0x47ad2Cd1DD15739A7a035b9d3B7828d916FEF77E" },
    fallbackApy: 5.0, availability: "fork-only",
  },

  // ── Base ───────────────────────────────────────────────────────────────
  {
    id: "aave", chain: "base", label: "Aave V3 USDC", asset: "USDC", tier: 1, stable: true,
    exit: "instant", exitNote: INSTANT, risks: [LENDING_RISK],
    rate: { kind: "defillama", pool: "7e0661bf-8cf3-45e6-9424-31916d4c7b84" },
    fallbackApy: 4.4, availability: "testnet",
  },
  {
    id: "morpho-steakhouse-usdc", chain: "base", label: "Morpho Steakhouse USDC", asset: "USDC", tier: 1, stable: true,
    exit: "instant", exitNote: INSTANT, risks: [LENDING_RISK, "Curator picks the Morpho markets."],
    rate: { kind: "morpho", chainId: 8453, vault: "0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183" },
    fallbackApy: 4.6, availability: "fork-only",
  },
  {
    id: "morpho-gauntlet-usdc", chain: "base", label: "Morpho Gauntlet USDC Prime", asset: "USDC", tier: 1, stable: true,
    exit: "instant", exitNote: INSTANT, risks: [LENDING_RISK, "Curator picks the Morpho markets."],
    rate: { kind: "morpho", chainId: 8453, vault: "0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61" },
    fallbackApy: 4.6, availability: "fork-only",
  },
  {
    id: "spark-usdc", chain: "base", label: "Spark USDC Vault", asset: "USDC", tier: 1, stable: true,
    exit: "instant", exitNote: INSTANT, risks: [LENDING_RISK],
    rate: { kind: "morpho", chainId: 8453, vault: "0x7BfA7C4f149E7415b73bdeDfe609237e29CBF34A" },
    fallbackApy: 4.2, availability: "fork-only",
  },
  {
    id: "morpho-steakhouse-hy-usdc", chain: "base", label: "Morpho Steakhouse High Yield USDC", asset: "USDC", tier: 2, stable: true,
    exit: "instant", exitNote: "Instant when liquidity allows",
    risks: [LENDING_RISK, "Lends against riskier collateral than the Prime vaults."],
    rate: { kind: "morpho", chainId: 8453, vault: "0xBEEFA7B88064FeEF0cEe02AAeBBd95D30df3878F" },
    fallbackApy: 5.6, availability: "fork-only",
  },

  // ── Robinhood Chain ────────────────────────────────────────────────────
  {
    id: "morpho-steakhouse-usdg", chain: "robinhood", label: "Morpho Steakhouse USDG", asset: "USDG", tier: 1, stable: true,
    exit: "instant", exitNote: INSTANT,
    risks: [LENDING_RISK, "Needs USDG registered as the treasury stablecoin (real USDG, not a USDC stand-in)."],
    rate: { kind: "defillama", pool: "32f586b4-5358-5aa2-88ee-c842139e7023" },
    fallbackApy: 3.6, availability: "fork-only",
  },

  // ── Arc ────────────────────────────────────────────────────────────────
  {
    id: "morpho-steakhouse-usdc", chain: "arc", label: "Morpho Steakhouse Prime USDC", asset: "USDC", tier: 1, stable: true,
    exit: "instant", exitNote: INSTANT, risks: [LENDING_RISK],
    rate: { kind: "morpho", chainId: 5042, vault: "0xbeef0016cb2Fd5C352ea7CA08a9f54739DFa7298" },
    fallbackApy: 2.3, availability: "fork-only",
  },
];

export function venuesForChain(chain: StrategyChain, includeHidden = false): StrategyVenue[] {
  return STRATEGY_VENUES.filter((v) => v.chain === chain && (includeHidden || !v.hiddenByDefault));
}

export function findVenue(chain: StrategyChain, id: string): StrategyVenue | undefined {
  return STRATEGY_VENUES.find((v) => v.chain === chain && v.id === id);
}

/** Strategy-menu chain for an EVM chain id (mainnet or its testnet). */
export function strategyChainForEvmId(chainId: number | null | undefined): StrategyChain | null {
  switch (chainId) {
    case 1:
    case 11155111:
      return "ethereum";
    case 8453:
    case 84532:
      return "base";
    case 4663:
    case 46630:
      return "robinhood";
    case 5042:
    case 5042002:
      return "arc";
    default:
      return null;
  }
}

// ── Rates ─────────────────────────────────────────────────────────────────

export interface StrategyRate {
  venueId: string;
  chain: StrategyChain;
  baseApy: number | null;
  rewardApy: number | null;
  mean30dApy: number | null;
  tvlUsd: number | null;
  source: string;
  fetchedAt: string;
}

/** A rate more than this far above its 30-day mean is treated as temporary. */
export const TEMPORARY_RATE_MARGIN_PCT = 1.5;

/**
 * APY used for ranking and estimates. Base yield only: reward APY is excluded
 * because the incentives these venues advertise (Merkl and similar) are
 * claimable by end users only, not by a treasury contract. A base rate more
 * than 1.5 points above its 30-day mean falls back to the mean.
 */
export function effectiveApy(rate: Pick<StrategyRate, "baseApy" | "mean30dApy"> | null | undefined, fallback: number): number {
  if (!rate || rate.baseApy == null || !Number.isFinite(rate.baseApy)) return fallback;
  const mean = rate.mean30dApy;
  if (mean != null && Number.isFinite(mean) && rate.baseApy > mean + TEMPORARY_RATE_MARGIN_PCT) return mean;
  return rate.baseApy;
}

export function isTemporaryRate(rate: Pick<StrategyRate, "baseApy" | "mean30dApy"> | null | undefined): boolean {
  if (!rate || rate.baseApy == null || rate.mean30dApy == null) return false;
  return rate.baseApy > rate.mean30dApy + TEMPORARY_RATE_MARGIN_PCT;
}

// ── Presets ───────────────────────────────────────────────────────────────

export type TierPresetId = "conservative" | "balanced" | "yield6";

export const TIER_PRESETS: Record<TierPresetId, { tiers: RiskTier[]; targetApy: number | null; summary: string }> = {
  conservative: { tiers: [1], targetApy: null, summary: "Tier 1 lending and savings only. Expect about 4–5%." },
  balanced: { tiers: [1, 2], targetApy: null, summary: "Tier 1 plus up to 30% in Tier 2 vaults." },
  yield6: {
    tiers: [1, 2, 3],
    targetApy: 6,
    summary: "Tier 1 + 2 + 3 within caps (Tier 2 ≤ 30%, Tier 3 ≤ 15%), aiming for a 6% blend.",
  },
};

/**
 * Per-venue cap (percent of NAV) for a constitution: the user's per-venue
 * limit, with each tier's ceiling split evenly across that tier's approved
 * venues so the on-chain tier totals always fit.
 */
export function venueCapPct(
  venue: Pick<StrategyVenue, "tier">,
  perVenueLimitPct: number,
  approvedInTier: number,
): number {
  const limit = Math.max(0, Math.min(100, perVenueLimitPct));
  if (venue.tier === 1) return limit;
  const ceiling = venue.tier === 2 ? TIER2_TOTAL_CAP_PCT : TIER3_TOTAL_CAP_PCT;
  return Math.min(limit, Math.floor((ceiling / Math.max(1, approvedInTier)) * 100) / 100);
}

/** Per-venue caps in bps for the approved venues of one chain. */
export function constitutionCapsBps(
  venues: Array<Pick<StrategyVenue, "id" | "tier">>,
  perVenueLimitPct: number,
): Map<string, number> {
  const counts = new Map<RiskTier, number>();
  for (const v of venues) counts.set(v.tier, (counts.get(v.tier) ?? 0) + 1);
  const out = new Map<string, number>();
  for (const v of venues) {
    out.set(v.id, Math.round(venueCapPct(v, perVenueLimitPct, counts.get(v.tier) ?? 1) * 100));
  }
  return out;
}

const SOLANA_RISK_TIER_SHIFT = 14;
const SOLANA_ALLOCATION_BPS_MASK = (1 << SOLANA_RISK_TIER_SHIFT) - 1;

/** Solana packs the tier into the two high bits of max_allocation_bps. */
export function packSolanaAllocation(bps: number, tier: RiskTier): number {
  const clamped = Math.max(0, Math.min(10_000, Math.round(bps)));
  return clamped | ((tier - 1) << SOLANA_RISK_TIER_SHIFT);
}

/** Inverse of packSolanaAllocation; entries written before tiers read as Tier 1. */
export function unpackSolanaAllocation(raw: number): { bps: number; riskTier: number } {
  return { bps: raw & SOLANA_ALLOCATION_BPS_MASK, riskTier: (raw >> SOLANA_RISK_TIER_SHIFT) + 1 };
}

export interface BlendedEstimate {
  apy: number;
  /** Share of deployed capital per venue id, summing to 1. */
  weights: Map<string, number>;
  meetsTarget: boolean | null;
}

/**
 * Blended live estimate for a preset on one chain: Tier 3 then Tier 2 venues
 * take up to their tier ceilings of deployed capital (split evenly, best rate
 * first within the tier), and the best Tier 1 venue takes the rest. Stable
 * venues only, since presets target dollars.
 */
export function blendedEstimate(
  chain: StrategyChain,
  preset: TierPresetId,
  rates: Map<string, StrategyRate>,
  selectable: (venue: StrategyVenue) => boolean = (v) => v.availability !== "later",
): BlendedEstimate {
  const { tiers, targetApy } = TIER_PRESETS[preset];
  const venues = venuesForChain(chain).filter((v) => v.stable && tiers.includes(v.tier) && selectable(v));
  const apyOf = (v: StrategyVenue) => effectiveApy(rates.get(v.id), v.fallbackApy);
  const weights = new Map<string, number>();
  let remaining = 1;
  for (const tier of [3, 2] as RiskTier[]) {
    const inTier = venues.filter((v) => v.tier === tier);
    if (inTier.length === 0) continue;
    const share = (tier === 2 ? TIER2_TOTAL_CAP_PCT : TIER3_TOTAL_CAP_PCT) / 100;
    for (const v of inTier) weights.set(v.id, share / inTier.length);
    remaining -= share;
  }
  const tier1 = venues.filter((v) => v.tier === 1).sort((a, b) => apyOf(b) - apyOf(a));
  if (tier1.length > 0) {
    weights.set(tier1[0].id, (weights.get(tier1[0].id) ?? 0) + remaining);
  } else if (weights.size > 0) {
    const total = 1 - remaining;
    for (const [id, w] of weights) weights.set(id, w / total);
  }
  let apy = 0;
  for (const [id, w] of weights) {
    const v = venues.find((x) => x.id === id);
    if (v) apy += w * apyOf(v);
  }
  apy = Math.round(apy * 100) / 100;
  return { apy, weights, meetsTarget: targetApy == null ? null : apy >= targetApy };
}

/** Plain risk list for a preset on one chain (deduplicated). */
export function presetRisks(chain: StrategyChain, preset: TierPresetId): string[] {
  const { tiers } = TIER_PRESETS[preset];
  const seen = new Set<string>();
  for (const v of venuesForChain(chain)) {
    if (!tiers.includes(v.tier) || v.availability === "later") continue;
    for (const r of v.risks) seen.add(r);
  }
  return [...seen];
}
