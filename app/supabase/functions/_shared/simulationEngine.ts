/**
 * Nave portfolio simulation engine.
 *
 * Generates 50 staggered 5-year backtests of a $1M treasury under Nave-style
 * automation: 50/50 Solana↔EVM, risk-adjusted allocation across approved
 * venues, Robinhood bridge-out to Ethereum yield, and synthetic bull/bear
 * macro regimes. Pure functions — no Deno/Supabase imports.
 */

export type Regime = "bull" | "bear" | "sideways" | "crisis";
export type RegimeLabel = Regime | "mixed";

export type VenueId =
  | "kamino"
  | "marginfi"
  | "jupiter"
  | "jito"
  | "aave"
  | "compound"
  | "robinhood-bridge";

export type ChainSide = "solana" | "evm";

export interface VenueSpec {
  id: VenueId;
  chain: ChainSide;
  /** Display / network hint (Robinhood bridges to Ethereum). */
  network: "solana" | "ethereum" | "base" | "robinhood";
  assetClass: "stablecoin" | "sol" | "eth";
  /** Baseline APY in bps at generation time. */
  apyBps: number;
  riskScore: number;
  /** Max portfolio weight for this venue (0..1). */
  cap: number;
  liquid: boolean;
}

export interface BaselineApys {
  kamino: number;
  marginfi: number;
  jupiter: number;
  jito: number;
  aave: number;
  compound: number;
}

export interface SimulationParams {
  startCapitalUsd: number;
  portfolioCount: number;
  horizonMonths: number;
  historyMonths: number;
  solanaTargetWeight: number;
  evmTargetWeight: number;
  liquidityFloor: number;
  rebalanceBand: number;
  /** Robinhood haircut applied when bridging WETH → Ethereum (bps of notional). */
  robinhoodBridgeFeeBps: number;
  seed: string;
  venues: VenueSpec[];
  baselines: BaselineApys;
}

export interface MonthMacro {
  monthIndex: number;
  date: string; // YYYY-MM-01
  regime: Regime;
  solReturn: number;
  ethReturn: number;
  /** Multiplier applied to lending APYs this month (compression/expansion). */
  yieldMult: number;
}

export interface AllocationPoint {
  venueId: VenueId;
  weight: number;
  navUsd: number;
}

export interface SeriesPoint {
  t: string;
  month: number;
  nav: number;
  solNav: number;
  evmNav: number;
  regime: Regime;
  allocations: AllocationPoint[];
}

export interface PortfolioResult {
  runIndex: number;
  windowStart: string;
  windowEnd: string;
  regimeLabel: RegimeLabel;
  startNavUsd: number;
  endNavUsd: number;
  totalReturnPct: number;
  maxDrawdownPct: number;
  cagrPct: number;
  chainSplit: { solana: number; evm: number };
  protocolPnl: Record<string, number>;
  series: SeriesPoint[];
}

export interface BatchSummary {
  medianEndNav: number;
  p10EndNav: number;
  p90EndNav: number;
  bestEndNav: number;
  worstEndNav: number;
  survivalRate: number;
  avgMaxDrawdownPct: number;
  medianCagrPct: number;
  bullCohort: { count: number; medianReturnPct: number; medianEndNav: number };
  bearCohort: { count: number; medianReturnPct: number; medianEndNav: number };
  sidewaysCohort: { count: number; medianReturnPct: number; medianEndNav: number };
  mixedCohort: { count: number; medianReturnPct: number; medianEndNav: number };
}

export interface SimulationBatchResult {
  seed: string;
  params: SimulationParams;
  summary: BatchSummary;
  portfolios: PortfolioResult[];
  macro: MonthMacro[];
}

/** Conservative builtins matching yieldSources.ts + EVM marketing ranges. */
export const DEFAULT_BASELINES: BaselineApys = {
  kamino: 640,
  marginfi: 580,
  jupiter: 450,
  jito: 760,
  aave: 450,
  compound: 420,
};

export function buildDefaultVenues(baselines: BaselineApys = DEFAULT_BASELINES): VenueSpec[] {
  return [
    { id: "kamino", chain: "solana", network: "solana", assetClass: "stablecoin", apyBps: baselines.kamino, riskScore: 18, cap: 0.35, liquid: true },
    { id: "marginfi", chain: "solana", network: "solana", assetClass: "stablecoin", apyBps: baselines.marginfi, riskScore: 22, cap: 0.30, liquid: true },
    { id: "jupiter", chain: "solana", network: "solana", assetClass: "stablecoin", apyBps: baselines.jupiter, riskScore: 20, cap: 0.25, liquid: true },
    { id: "jito", chain: "solana", network: "solana", assetClass: "sol", apyBps: baselines.jito, riskScore: 30, cap: 0.40, liquid: true },
    { id: "aave", chain: "evm", network: "ethereum", assetClass: "stablecoin", apyBps: baselines.aave, riskScore: 16, cap: 0.35, liquid: true },
    { id: "compound", chain: "evm", network: "base", assetClass: "stablecoin", apyBps: baselines.compound, riskScore: 18, cap: 0.30, liquid: true },
    // Robinhood has no local Aave/Compound — capital bridges to Ethereum.
    { id: "robinhood-bridge", chain: "evm", network: "robinhood", assetClass: "eth", apyBps: Math.round(baselines.aave * 0.92), riskScore: 28, cap: 0.20, liquid: true },
  ];
}

export function defaultParams(overrides?: Partial<SimulationParams>): SimulationParams {
  const baselines = overrides?.baselines ?? DEFAULT_BASELINES;
  const seed = overrides?.seed ?? `nave-sim-${Date.now()}`;
  return {
    startCapitalUsd: overrides?.startCapitalUsd ?? 1_000_000,
    portfolioCount: overrides?.portfolioCount ?? 50,
    horizonMonths: overrides?.horizonMonths ?? 60,
    historyMonths: overrides?.historyMonths ?? 120,
    solanaTargetWeight: overrides?.solanaTargetWeight ?? 0.5,
    evmTargetWeight: overrides?.evmTargetWeight ?? 0.5,
    liquidityFloor: overrides?.liquidityFloor ?? 0.08,
    rebalanceBand: overrides?.rebalanceBand ?? 0.05,
    robinhoodBridgeFeeBps: overrides?.robinhoodBridgeFeeBps ?? 15,
    seed,
    baselines,
    venues: overrides?.venues ?? buildDefaultVenues(baselines),
  };
}

/* ── Deterministic PRNG (mulberry32) ───────────────────────── */

function hashSeed(seed: string): number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const w = idx - lo;
  return sorted[lo] * (1 - w) + sorted[hi] * w;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return percentile(s, 0.5);
}

function addMonths(isoDate: string, months: number): string {
  const d = new Date(isoDate + "T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

/** Build ~10y of monthly regimes with correlated SOL/ETH returns + yield mult. */
export function buildMacroPath(seed: string, historyMonths: number, startDate = "2016-01-01"): MonthMacro[] {
  const rand = mulberry32(hashSeed(seed + ":macro"));
  const out: MonthMacro[] = [];
  let regime: Regime = "sideways";
  let regimeLeft = 0;

  const regimeMonthly: Record<Regime, { solMu: number; ethMu: number; vol: number; yieldMult: number; len: [number, number] }> = {
    bull: { solMu: 0.045, ethMu: 0.035, vol: 0.09, yieldMult: 0.82, len: [8, 18] },
    bear: { solMu: -0.035, ethMu: -0.028, vol: 0.11, yieldMult: 1.35, len: [6, 14] },
    sideways: { solMu: 0.008, ethMu: 0.006, vol: 0.05, yieldMult: 1.0, len: [4, 10] },
    crisis: { solMu: -0.12, ethMu: -0.09, vol: 0.18, yieldMult: 1.55, len: [2, 4] },
  };

  const pickRegime = (): Regime => {
    const r = rand();
    // Slightly more bear/crisis weight so staggered 5y windows produce
    // meaningful bull vs bear cohorts for the public simulation page.
    if (r < 0.30) return "bull";
    if (r < 0.58) return "bear";
    if (r < 0.82) return "sideways";
    return "crisis";
  };

  for (let i = 0; i < historyMonths; i++) {
    if (regimeLeft <= 0) {
      regime = pickRegime();
      const [lo, hi] = regimeMonthly[regime].len;
      regimeLeft = lo + Math.floor(rand() * (hi - lo + 1));
    }
    regimeLeft -= 1;
    const cfg = regimeMonthly[regime];
    // Box-Muller-ish via two uniforms
    const u1 = Math.max(1e-9, rand());
    const u2 = rand();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    const solReturn = cfg.solMu + z * cfg.vol;
    const ethReturn = cfg.ethMu + z * cfg.vol * 0.85 + (rand() - 0.5) * 0.02;
    out.push({
      monthIndex: i,
      date: addMonths(startDate, i),
      regime,
      solReturn,
      ethReturn,
      yieldMult: cfg.yieldMult * (0.95 + rand() * 0.1),
    });
  }
  return out;
}

function adjustedScore(apyBps: number, riskScore: number, liquid: boolean): number {
  return apyBps - riskScore * 12 + (liquid ? 25 : 0);
}

/**
 * Allocate within one chain side to venues by risk-adjusted APY under caps,
 * reserving a liquidity sleeve as cash (weight on a synthetic "cash" not stored).
 */
function allocateSide(
  venues: VenueSpec[],
  side: ChainSide,
  sideNav: number,
  liquidityFloor: number,
  yieldMult: number,
  monthRegime: Regime,
): { weights: Map<VenueId, number>; cashWeight: number } {
  const sideVenues = venues.filter((v) => v.chain === side);
  const scored = sideVenues
    .map((v) => {
      let apy = v.apyBps * yieldMult;
      // LST / ETH sleeves get slight APY bump in bulls from staking demand, compression in crisis
      if (v.assetClass === "sol" || v.assetClass === "eth") {
        if (monthRegime === "bull") apy *= 1.05;
        if (monthRegime === "crisis") apy *= 0.9;
      }
      return { venue: v, score: adjustedScore(apy, v.riskScore, v.liquid), apy };
    })
    .sort((a, b) => b.score - a.score);

  const deployable = Math.max(0, 1 - liquidityFloor);
  const weights = new Map<VenueId, number>();
  let remaining = deployable;

  for (const row of scored) {
    if (remaining <= 0.001) break;
    const take = Math.min(row.venue.cap, remaining);
    if (take <= 0) continue;
    weights.set(row.venue.id, take);
    remaining -= take;
  }

  // If under-deployed, top up best venue under remaining room to its cap
  if (remaining > 0.001 && scored.length > 0) {
    const best = scored[0].venue;
    const cur = weights.get(best.id) ?? 0;
    const room = Math.max(0, best.cap - cur);
    const add = Math.min(room, remaining);
    if (add > 0) {
      weights.set(best.id, cur + add);
      remaining -= add;
    }
  }

  const cashWeight = 1 - [...weights.values()].reduce((a, b) => a + b, 0);
  void sideNav;
  return { weights, cashWeight: clamp(cashWeight, 0, 1) };
}

function dominantRegime(months: MonthMacro[]): RegimeLabel {
  const counts: Record<Regime, number> = { bull: 0, bear: 0, sideways: 0, crisis: 0 };
  for (const m of months) counts[m.regime] += 1;
  const total = months.length || 1;
  const stressShare = (counts.bear + counts.crisis) / total;
  const bullShare = counts.bull / total;
  const sidewaysShare = counts.sideways / total;
  // Stress months (bear + crisis) win the cohort label first so the UI can
  // show how automation behaves through drawdown seasons.
  if (stressShare >= 0.30) return "bear";
  if (bullShare >= 0.38) return "bull";
  if (sidewaysShare >= 0.40) return "sideways";
  return "mixed";
}

function runSinglePortfolio(
  params: SimulationParams,
  macroWindow: MonthMacro[],
  runIndex: number,
): PortfolioResult {
  const startNav = params.startCapitalUsd;
  let solNav = startNav * params.solanaTargetWeight;
  let evmNav = startNav * params.evmTargetWeight;
  let peak = startNav;
  let maxDd = 0;

  const protocolPnl: Record<string, number> = {};
  for (const v of params.venues) protocolPnl[v.id] = 0;
  protocolPnl.cash = 0;

  let sumSolShare = 0;
  let sumEvmShare = 0;
  const series: SeriesPoint[] = [];

  // Track deployed notionals per venue for PnL attribution
  const venueNav = new Map<VenueId, number>();
  for (const v of params.venues) venueNav.set(v.id, 0);

  for (let i = 0; i < macroWindow.length; i++) {
    const m = macroWindow[i];
    const totalBefore = solNav + evmNav;

    // Rebalance chain split if drifted beyond band
    const solShare = totalBefore > 0 ? solNav / totalBefore : 0.5;
    if (Math.abs(solShare - params.solanaTargetWeight) > params.rebalanceBand) {
      solNav = totalBefore * params.solanaTargetWeight;
      evmNav = totalBefore * params.evmTargetWeight;
    }

    const solAlloc = allocateSide(params.venues, "solana", solNav, params.liquidityFloor, m.yieldMult, m.regime);
    const evmAlloc = allocateSide(params.venues, "evm", evmNav, params.liquidityFloor, m.yieldMult, m.regime);

    // Apply Robinhood bridge fee when allocating to that sleeve (one-time on increase)
    const rhWeight = evmAlloc.weights.get("robinhood-bridge") ?? 0;
    const rhTarget = evmNav * rhWeight;
    const rhPrev = venueNav.get("robinhood-bridge") ?? 0;
    if (rhTarget > rhPrev + 1) {
      const bridged = rhTarget - rhPrev;
      const fee = bridged * (params.robinhoodBridgeFeeBps / 10_000);
      evmNav -= fee;
      protocolPnl["robinhood-bridge"] = (protocolPnl["robinhood-bridge"] ?? 0) - fee;
    }

    // Accrue yield + mark beta assets
    let newSol = 0;
    let newEvm = 0;
    const allocations: AllocationPoint[] = [];

    for (const v of params.venues) {
      const sideAlloc = v.chain === "solana" ? solAlloc : evmAlloc;
      const sideNav = v.chain === "solana" ? solNav : evmNav;
      const w = sideAlloc.weights.get(v.id) ?? 0;
      let nav = sideNav * w;

      const monthlyYield = (v.apyBps * m.yieldMult) / 10_000 / 12;
      const yieldGain = nav * monthlyYield;
      nav += yieldGain;
      protocolPnl[v.id] = (protocolPnl[v.id] ?? 0) + yieldGain;

      if (v.assetClass === "sol") {
        const priceGain = nav * m.solReturn * 0.85; // LST tracks SOL with mild lag/haircut
        nav += priceGain;
        protocolPnl[v.id] = (protocolPnl[v.id] ?? 0) + priceGain;
      } else if (v.assetClass === "eth") {
        // Robinhood-bridged WETH / ETH exposure marks to ETH
        const priceGain = nav * m.ethReturn * 0.9;
        nav += priceGain;
        protocolPnl[v.id] = (protocolPnl[v.id] ?? 0) + priceGain;
      }

      venueNav.set(v.id, nav);
      if (v.chain === "solana") newSol += nav;
      else newEvm += nav;
      if (w > 0.001) {
        allocations.push({ venueId: v.id, weight: round4(w * (v.chain === "solana" ? params.solanaTargetWeight : params.evmTargetWeight)), navUsd: round2(nav) });
      }
    }

    // Cash sleeves (idle liquidity) earn ~T-bill-ish 3% APY, no beta
    const solCash = solNav * solAlloc.cashWeight;
    const evmCash = evmNav * evmAlloc.cashWeight;
    const cashYield = (solCash + evmCash) * (0.03 / 12);
    protocolPnl.cash = (protocolPnl.cash ?? 0) + cashYield;
    newSol += solCash * (1 + 0.03 / 12);
    newEvm += evmCash * (1 + 0.03 / 12);

    solNav = Math.max(0, newSol);
    evmNav = Math.max(0, newEvm);
    const nav = solNav + evmNav;
    peak = Math.max(peak, nav);
    const dd = peak > 0 ? (peak - nav) / peak : 0;
    maxDd = Math.max(maxDd, dd);

    sumSolShare += nav > 0 ? solNav / nav : 0.5;
    sumEvmShare += nav > 0 ? evmNav / nav : 0.5;

    series.push({
      t: m.date,
      month: i,
      nav: round2(nav),
      solNav: round2(solNav),
      evmNav: round2(evmNav),
      regime: m.regime,
      allocations,
    });
  }

  const endNav = solNav + evmNav;
  const totalReturnPct = ((endNav - startNav) / startNav) * 100;
  const years = params.horizonMonths / 12;
  const cagrPct = years > 0 ? (Math.pow(Math.max(endNav, 1) / startNav, 1 / years) - 1) * 100 : 0;
  const n = macroWindow.length || 1;

  return {
    runIndex,
    windowStart: macroWindow[0]?.date ?? "",
    windowEnd: macroWindow[macroWindow.length - 1]?.date ?? "",
    regimeLabel: dominantRegime(macroWindow),
    startNavUsd: startNav,
    endNavUsd: round2(endNav),
    totalReturnPct: round2(totalReturnPct),
    maxDrawdownPct: round2(maxDd * 100),
    cagrPct: round2(cagrPct),
    chainSplit: {
      solana: round4(sumSolShare / n),
      evm: round4(sumEvmShare / n),
    },
    protocolPnl: Object.fromEntries(
      Object.entries(protocolPnl).map(([k, v]) => [k, round2(v)]),
    ),
    series,
  };
}

function cohortStats(
  portfolios: PortfolioResult[],
  label: RegimeLabel | RegimeLabel[],
): { count: number; medianReturnPct: number; medianEndNav: number } {
  const labels = Array.isArray(label) ? label : [label];
  const rows = portfolios.filter((p) => labels.includes(p.regimeLabel));
  if (rows.length === 0) return { count: 0, medianReturnPct: 0, medianEndNav: 0 };
  return {
    count: rows.length,
    medianReturnPct: round2(median(rows.map((r) => r.totalReturnPct))),
    medianEndNav: round2(median(rows.map((r) => r.endNavUsd))),
  };
}

export function summarizeBatch(portfolios: PortfolioResult[], startCapital: number): BatchSummary {
  const ends = portfolios.map((p) => p.endNavUsd).sort((a, b) => a - b);
  const survived = portfolios.filter((p) => p.endNavUsd >= startCapital).length;
  return {
    medianEndNav: round2(percentile(ends, 0.5)),
    p10EndNav: round2(percentile(ends, 0.1)),
    p90EndNav: round2(percentile(ends, 0.9)),
    bestEndNav: ends.length ? ends[ends.length - 1] : 0,
    worstEndNav: ends.length ? ends[0] : 0,
    survivalRate: portfolios.length ? round4(survived / portfolios.length) : 0,
    avgMaxDrawdownPct: round2(
      portfolios.reduce((s, p) => s + p.maxDrawdownPct, 0) / (portfolios.length || 1),
    ),
    medianCagrPct: round2(median(portfolios.map((p) => p.cagrPct))),
    bullCohort: cohortStats(portfolios, "bull"),
    bearCohort: cohortStats(portfolios, ["bear", "crisis"]),
    sidewaysCohort: cohortStats(portfolios, "sideways"),
    mixedCohort: cohortStats(portfolios, "mixed"),
  };
}

/**
 * Run the full batch: build macro history, slice 50 offset windows, simulate each.
 */
export function generateSimulationBatch(
  partial?: Partial<SimulationParams>,
): SimulationBatchResult {
  const params = defaultParams(partial);
  const macro = buildMacroPath(params.seed, params.historyMonths);
  const maxStart = Math.max(0, params.historyMonths - params.horizonMonths);
  const portfolios: PortfolioResult[] = [];

  for (let i = 0; i < params.portfolioCount; i++) {
    const startOffset = params.portfolioCount <= 1
      ? 0
      : Math.floor((i * maxStart) / (params.portfolioCount - 1));
    const window = macro.slice(startOffset, startOffset + params.horizonMonths);
    if (window.length < params.horizonMonths) {
      // Pad edge case — shouldn't happen with historyMonths >= horizon
      continue;
    }
    portfolios.push(runSinglePortfolio(params, window, i));
  }

  return {
    seed: params.seed,
    params,
    summary: summarizeBatch(portfolios, params.startCapitalUsd),
    portfolios,
    macro,
  };
}
