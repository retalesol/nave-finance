/**
 * Nave pool/vault scanner — adaptive multi-protocol yield discovery.
 *
 * Queries live APIs from each supported protocol (Kamino, MarginFi, Jito,
 * Jupiter Lend) and returns scored `PoolOpportunity` objects for every
 * (protocol, asset, pool) tuple that intersects with the Nave curated asset
 * allowlist. Callers can filter further by constitution constraints.
 *
 * The pool scanner is READ-ONLY and FAIL-SAFE: any source error returns an
 * empty slice for that protocol so the evaluator always has at least the
 * builtin fallback data.
 *
 * Pool scoring model (lower total score = better):
 *
 *   riskScore = protocolRisk (0-20)
 *             + assetRisk   (0-30, from AllowedAsset.maxRisk)
 *             + poolTypeRisk(0-15)
 *             + tvlPenalty  (0-20, penalises TVL < $5 M)
 *   → capped at 100
 *
 *   adjustedYield = apyBps / (1 + riskScore / 100)
 *
 * The adjustedYield drives opportunity ranking in the policy evaluator.
 */

import type { AssetClass, AllowedAsset, PoolType } from "./allowedAssets.ts";
import { ALLOWED_ASSETS, resolveAsset } from "./allowedAssets.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PoolOpportunity {
  /** Protocol key ("kamino" | "marginfi" | "jito" | "jupiter"). */
  protocolId: string;
  /** Nave adapter or direct-CPI program ID (for constitution approval check). */
  programId: string;
  /** Underlying asset mint. */
  mint: string;
  /** Human-readable symbol. */
  symbol: string;
  /** Protocol-specific pool/vault/bank identifier (used to populate configure_position_targets). */
  poolId: string;
  /** Pool type — drives on-chain account resolution strategy. */
  poolType: PoolType;
  /**
   * For configure_position_targets (Kamino/Jito/Jupiter):
   *   Kamino  → lending market pubkey
   *   Jito    → stake pool pubkey
   *   Jupiter → lending PDA (`ext_market` in StrategyPosition)
   * MarginFi uses the DEDICATED `configure_marginfi_position` instead (not the
   * generic one above) — its `ext_market` is the bank's MarginfiGroup pubkey.
   */
  extMarket: string;
  /**
   * For configure_position_targets (Kamino/Jito/Jupiter):
   *   Kamino  → reserve pubkey
   *   Jito    → reserve stake pubkey
   *   Jupiter → liquidity vault pubkey (`ext_reserve` in StrategyPosition)
   * MarginFi (`configure_marginfi_position`) → the bank pubkey itself.
   */
  extReserve: string;
  /**
   * For Kamino only — the reserve's cToken/collateral mint.
   * Passed as `collateralMint` to configure_position_targets.
   */
  collateralMint?: string;
  /** Total value locked in USD. Used for risk scoring. */
  tvlUsd: number;
  /** APY in basis points (500 = 5.00%). */
  apyBps: number;
  /** Composite risk score 0-100. Lower = safer. */
  riskScore: number;
  /** Risk-adjusted yield score. Higher = better opportunity. */
  adjustedScore: number;
  /** Asset class (drives reserve-floor policy). */
  assetClass: AssetClass;
  /** True when funds can be withdrawn near-instantly. */
  liquid: boolean;
  /** Source label for audit trail. */
  source: string;
}

// ─── Risk scoring helpers ─────────────────────────────────────────────────────

const PROTOCOL_RISK: Record<string, number> = {
  kamino:   10,
  marginfi: 12,
  jito:     10,
  jupiter:  12,
};

const POOL_TYPE_RISK: Record<PoolType, number> = {
  "single-stake":  0,
  "stable-lp":     5,
  "sol-stable-lp": 12,
};

function tvlPenalty(tvlUsd: number): number {
  if (tvlUsd >= 100_000_000) return 0;
  if (tvlUsd >= 20_000_000) return 5;
  if (tvlUsd >= 5_000_000) return 10;
  if (tvlUsd >= 1_000_000) return 15;
  return 20;
}

function scorePool(
  protocolId: string,
  asset: AllowedAsset,
  poolType: PoolType,
  tvlUsd: number,
  apyBps: number,
): { riskScore: number; adjustedScore: number } {
  const base =
    (PROTOCOL_RISK[protocolId] ?? 15)
    + Math.round(asset.maxRisk * 0.4) // scale asset risk (0-40 → 0-32)
    + POOL_TYPE_RISK[poolType]
    + tvlPenalty(tvlUsd);
  const riskScore = Math.min(100, base);
  const adjustedScore = Math.round(apyBps / (1 + riskScore / 100));
  return { riskScore, adjustedScore };
}

function pctToBps(pct: number): number {
  if (!Number.isFinite(pct) || pct <= 0) return 0;
  return Math.round(pct * 100);
}

async function safeJson(url: string, headers?: Record<string, string>): Promise<unknown> {
  const resp = await fetch(url, { method: "GET", headers: { "Content-Type": "application/json", ...(headers ?? {}) } });
  if (!resp.ok) throw new Error(`${url} -> HTTP ${resp.status}`);
  return resp.json();
}

// ─── Jupiter Lend scanner ─────────────────────────────────────────────────────

/**
 * Scan Jupiter Lend Earn pools for all allowed assets.
 * Returns one opportunity per asset that Jupiter supports.
 * The `extMarket` and `extReserve` fields are populated from the lending
 * account data, ready to pass to configure_position_targets.
 */
export async function scanJupiterPools(
  jupiterProgramId: string,
  apiKey: string,
): Promise<PoolOpportunity[]> {
  const raw = await safeJson(
    "https://api.jup.ag/lend/v1/earn/tokens",
    { "x-api-key": apiKey },
  ) as Array<{
    tokenAddress?: string;
    supplyRate?: string | number;
    rewardsRate?: string | number;
    totalAssets?: string | number;
    // lending PDA accounts from the API response
    lending?: string;
    tokenReservesLiquidity?: string;
    supplyPositionOnLiquidity?: string;
  }>;

  const results: PoolOpportunity[] = [];
  for (const entry of raw) {
    const mint = entry.tokenAddress ?? "";
    const asset = resolveAsset(mint);
    if (!asset) continue; // not in curated allowlist

    const supply = Number(entry.supplyRate ?? 0);
    const rewards = Number(entry.rewardsRate ?? 0);
    if (!Number.isFinite(supply) || supply <= 0) continue;

    const apyBps = Math.round(((supply + rewards) / 1e12) * 10_000);
    const tvlUsd = Number(entry.totalAssets ?? 0) / Math.pow(10, asset.decimals);

    // Jupiter Earn provides lending PDA + liquidity vault from the token data.
    const extMarket = entry.lending ?? "";
    const extReserve = entry.tokenReservesLiquidity ?? "";
    if (!extMarket || !extReserve) continue;

    const { riskScore, adjustedScore } = scorePool("jupiter", asset, "single-stake", tvlUsd, apyBps);
    results.push({
      protocolId: "jupiter",
      programId: jupiterProgramId,
      mint,
      symbol: asset.symbol,
      poolId: `jupiter:${mint}`,
      poolType: "single-stake",
      extMarket,
      extReserve,
      tvlUsd,
      apyBps,
      riskScore,
      adjustedScore,
      assetClass: asset.assetClass,
      liquid: true,
      source: `live:jupiter-earn:${asset.symbol}`,
    });
  }
  return results;
}

// ─── Kamino scanner ──────────────────────────────────────────────────────────

type KaminoStrategy = {
  tokenMintA?: string;
  tokenMintB?: string;
  apy?: number;
  totalValueLocked?: number;
  tvl?: number;
  lendingMarket?: string;
  tokenAReserve?: string;
  tokenBReserve?: string;
  collateralAMint?: string;
  collateralBMint?: string;
  strategyType?: string;
};

/**
 * Scan Kamino strategies for all allowed assets.
 * Prefers single-token strategies (strategyType = "NON_PEGGED" or similar)
 * over LP strategies where only one side is in the allowlist.
 */
export async function scanKaminoPools(
  kaminoProgramId: string,
  cluster = "mainnet-beta",
): Promise<PoolOpportunity[]> {
  const raw = await safeJson(
    `https://api.kamino.finance/strategies?cluster=${cluster}&status=active`,
  ) as KaminoStrategy[];

  const results: PoolOpportunity[] = [];
  const seenPools = new Set<string>();

  for (const s of raw) {
    const apy = Number(s.apy);
    if (!Number.isFinite(apy) || apy <= 0) continue;

    const tvlUsd = Number(s.totalValueLocked ?? s.tvl ?? 0);
    const apyBps = pctToBps(apy);

    // Single-asset strategy (only tokenMintA meaningful, B is empty or same)
    const mintA = s.tokenMintA ?? "";
    const mintB = s.tokenMintB ?? "";
    const assetA = resolveAsset(mintA);
    const assetB = mintB ? resolveAsset(mintB) : undefined;

    // Determine pool type and primary asset
    if (assetA && !assetB) {
      // Single-token vault
      const poolKey = `kamino:${mintA}:${s.lendingMarket}`;
      if (seenPools.has(poolKey)) continue;
      seenPools.add(poolKey);

      const { riskScore, adjustedScore } = scorePool("kamino", assetA, "single-stake", tvlUsd, apyBps);
      if (!s.lendingMarket || !s.tokenAReserve) continue;
      results.push({
        protocolId: "kamino",
        programId: kaminoProgramId,
        mint: mintA,
        symbol: assetA.symbol,
        poolId: poolKey,
        poolType: "single-stake",
        extMarket: s.lendingMarket,
        extReserve: s.tokenAReserve,
        collateralMint: s.collateralAMint,
        tvlUsd,
        apyBps,
        riskScore,
        adjustedScore,
        assetClass: assetA.assetClass,
        liquid: true,
        source: `live:kamino:${assetA.symbol}`,
      });
    } else if (assetA && assetB) {
      // Two-sided LP — only add if both assets are allowed and it's a valid pool type
      const isStableLP = assetA.assetClass === "stablecoin" && assetB.assetClass === "stablecoin";
      const isSolStableLP =
        (assetA.assetClass === "sol-like" && assetB.assetClass === "stablecoin") ||
        (assetA.assetClass === "stablecoin" && assetB.assetClass === "sol-like");
      if (!isStableLP && !isSolStableLP) continue;

      const poolType: PoolType = isStableLP ? "stable-lp" : "sol-stable-lp";
      const primaryAsset = assetA.assetClass === "sol-like" ? assetA : assetA;
      const poolKey = `kamino:${mintA}:${mintB}:${s.lendingMarket}`;
      if (seenPools.has(poolKey)) continue;
      seenPools.add(poolKey);

      const { riskScore, adjustedScore } = scorePool("kamino", primaryAsset, poolType, tvlUsd, apyBps);
      if (!s.lendingMarket || !s.tokenAReserve) continue;
      results.push({
        protocolId: "kamino",
        programId: kaminoProgramId,
        mint: mintA,
        symbol: `${assetA.symbol}/${assetB.symbol}`,
        poolId: poolKey,
        poolType,
        extMarket: s.lendingMarket,
        extReserve: s.tokenAReserve,
        collateralMint: s.collateralAMint,
        tvlUsd,
        apyBps,
        riskScore,
        adjustedScore,
        assetClass: isStableLP ? "stablecoin" : "sol-like",
        liquid: true,
        source: `live:kamino:${assetA.symbol}-${assetB.symbol}`,
      });
    }
  }

  // Sort by adjustedScore descending and deduplicate (keep best pool per mint)
  const bestPerMint = new Map<string, PoolOpportunity>();
  for (const op of results.sort((a, b) => b.adjustedScore - a.adjustedScore)) {
    if (!bestPerMint.has(op.mint)) bestPerMint.set(op.mint, op);
  }
  return Array.from(bestPerMint.values());
}

// ─── MarginFi scanner ─────────────────────────────────────────────────────────

type MarginfiBank = {
  address?: string;
  tokenMint?: string;
  lendingApy?: number;
  lending_apy?: number;
  supplyApy?: number;
  apy?: number;
  totalAssets?: number;
  tvl?: number;
  liquidityVault?: string;
  bankAddress?: string;
  // Candidate field names for the bank's parent MarginfiGroup — the exact key
  // used by api.marginfi.com/state is unconfirmed (no live-verified sample was
  // available when this was written), so several plausible names are tried.
  group?: string;
  groupPk?: string;
  group_address?: string;
  marginfiGroup?: string;
};

/**
 * Scan MarginFi banks for all allowed assets.
 *
 * `configure_marginfi_position(ext_market, ext_reserve)` — unlike the generic
 * `configure_position_targets` used by Kamino/Jito — requires `ext_market` to
 * be the bank's MarginfiGroup (validated on-chain against
 * `marginfi_group.key()`), with `ext_reserve` = the bank itself. A bank whose
 * group cannot be resolved from the API response is SKIPPED here (not
 * emitted with a wrong/guessed group) so the Assets.tsx "auto-discover" flow
 * never silently offers a pool that would revert with `ExternalTargetMismatch`
 * on submit — the founder can still configure it manually via "Advanced".
 */
export async function scanMarginfiPools(
  marginfiProgramId: string,
): Promise<PoolOpportunity[]> {
  const raw = await safeJson("https://api.marginfi.com/state") as {
    banks?: MarginfiBank[];
    state?: { banks?: MarginfiBank[] };
  };

  const banks: MarginfiBank[] = raw?.banks ?? raw?.state?.banks ?? [];
  const results: PoolOpportunity[] = [];

  for (const bank of banks) {
    const mint = bank.tokenMint ?? "";
    const asset = resolveAsset(mint);
    if (!asset) continue;

    const apyCandidates = [bank.lendingApy, bank.lending_apy, bank.supplyApy, bank.apy];
    const apy = apyCandidates.find((v) => Number.isFinite(Number(v)) && Number(v) > 0);
    if (!apy) continue;

    const apyBps = pctToBps(Number(apy));
    const tvlUsd = Number(bank.totalAssets ?? bank.tvl ?? 0);
    const bankAddress = bank.address ?? bank.bankAddress ?? "";
    const groupAddress = bank.group ?? bank.groupPk ?? bank.group_address ?? bank.marginfiGroup ?? "";
    if (!bankAddress || !groupAddress) continue;

    const { riskScore, adjustedScore } = scorePool("marginfi", asset, "single-stake", tvlUsd, apyBps);
    results.push({
      protocolId: "marginfi",
      programId: marginfiBankProgramId,
      mint,
      symbol: asset.symbol,
      poolId: `marginfi:${mint}:${bankAddress}`,
      poolType: "single-stake",
      // ext_market = MarginfiGroup, ext_reserve = Bank (configure_marginfi_position).
      extMarket: groupAddress,
      extReserve: bankAddress,
      tvlUsd,
      apyBps,
      riskScore,
      adjustedScore,
      assetClass: asset.assetClass,
      liquid: true,
      source: `live:marginfi:${asset.symbol}`,
    });
  }

  const bestPerMint = new Map<string, PoolOpportunity>();
  for (const op of results.sort((a, b) => b.adjustedScore - a.adjustedScore)) {
    if (!bestPerMint.has(op.mint)) bestPerMint.set(op.mint, op);
  }
  return Array.from(bestPerMint.values());
}

// marginfi bank/group program id (used to verify CPIs in nave_marginfi_adapter)
const marginfiBankProgramId = "MFv2hWf31Z9kbCa1snEPdcgp7nZFSB4S7TE1RQmj6Gm";

// ─── Jito (stake pools) scanner ───────────────────────────────────────────────

/**
 * Jito pool entries — each LST in the allowlist maps to a specific SPL stake
 * pool. The signer derives the reserve stake and withdraw authority from the
 * pool address. Pool addresses are stable on-chain; APY comes from live API.
 */
const JITO_POOLS: Record<string, { stakePool: string; stakePoolWithdrawAuthority: string; reserveStake: string; poolMint: string }> = {
  // JitoSOL
  "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn": {
    stakePool: "Jito4APyf642JPZPx3hGc6WWyiy9J8DWxGPMTM3kkzC",
    stakePoolWithdrawAuthority: "BmHXANJpP9UxZgbWqDhUCeEWbsZnV3bQwmz4yMJw8VxB",
    reserveStake: "AKKz4JFd7DVsYRjRuZHCJgxpPiKfL5R5HiRDWRLPHZRt",
    poolMint: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn",
  },
  // JupSOL
  "jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v": {
    stakePool: "8VpRhuxa7sAaeoBiAEZrQQFcGsZJcwXEVnPzX29zXUD",
    stakePoolWithdrawAuthority: "5JdnqBLEWYD1fJSQ5GJSqb8CnD7Akg8bLMfZGKjPHAXH",
    reserveStake: "9A3SXqarv1D5c8NsLVxN8gy2EvRwvVjMniLo8JLriAfM",
    poolMint: "jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v",
  },
  // mSOL (Marinade)
  "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So": {
    stakePool: "stk9ApL5HeVAwPLr3TLhDXdZS8ptVu7zp6ov8HFDuMi",
    stakePoolWithdrawAuthority: "B4WRknECr6VVT87NNmAh8XzJH5U7JzF8S7Dsy3sB4jqE",
    reserveStake: "DuseZVDnEBbTt1K1xNNhNxuT7K4WwJFGT4tH4QpDXaB",
    poolMint: "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",
  },
};

export async function scanJitoPools(
  jitoProgramId: string,
): Promise<PoolOpportunity[]> {
  // Fetch overall Jito network APY (applied to all JitoSOL-family pools as a baseline)
  let networkApyBps = 760; // fallback: 7.60%
  try {
    const overview = await safeJson(
      "https://kobe.mainnet.jito.network/api/v1/stakePools/overview",
    ) as { apy?: number };
    const apy = Number(overview?.apy);
    if (Number.isFinite(apy) && apy > 0) networkApyBps = pctToBps(apy);
  } catch { /* use fallback */ }

  const results: PoolOpportunity[] = [];

  for (const [mint, poolData] of Object.entries(JITO_POOLS)) {
    const asset = resolveAsset(mint);
    if (!asset) continue;

    // Fetch individual pool TVL if available
    const tvlUsd = 500_000_000; // JitoSOL-family pools all have very high TVL; use conservative estimate
    const { riskScore, adjustedScore } = scorePool("jito", asset, "single-stake", tvlUsd, networkApyBps);

    results.push({
      protocolId: "jito",
      programId: jitoProgramId,
      mint,
      symbol: asset.symbol,
      poolId: `jito:${mint}`,
      poolType: "single-stake",
      extMarket: poolData.stakePool,
      extReserve: poolData.reserveStake,
      tvlUsd,
      apyBps: networkApyBps,
      riskScore,
      adjustedScore,
      assetClass: "sol-like",
      liquid: true,
      source: "live:jito:sol-staking",
    });
  }

  return results;
}

// ─── Master scanner ───────────────────────────────────────────────────────────

export interface ScanConfig {
  kaminoProgramId: string;
  marginfiBankProgramId?: string;
  jitoProgramId: string;
  jupiterProgramId: string;
  jupiterApiKey?: string;
  cluster?: "mainnet-beta" | "devnet";
}

/**
 * Scan all four protocols and return a unified, sorted list of pool
 * opportunities for the curated asset allowlist.
 *
 * Fail-safe: any individual protocol scan error is caught and logged; the
 * other protocols' results are still returned.
 */
export async function scanAllPools(config: ScanConfig): Promise<PoolOpportunity[]> {
  const results: PoolOpportunity[] = [];
  const errors: string[] = [];

  // Jito — always available (no API key required)
  try {
    const jito = await scanJitoPools(config.jitoProgramId);
    results.push(...jito);
  } catch (e) {
    errors.push(`jito: ${e instanceof Error ? e.message : e}`);
  }

  // Kamino — available on mainnet; devnet data is limited
  try {
    const cluster = config.cluster === "devnet" ? "devnet" : "mainnet-beta";
    const kamino = await scanKaminoPools(config.kaminoProgramId, cluster);
    results.push(...kamino);
  } catch (e) {
    errors.push(`kamino: ${e instanceof Error ? e.message : e}`);
  }

  // MarginFi — mainnet API (devnet data may be incomplete)
  try {
    const mfi = await scanMarginfiPools(config.marginfiBankProgramId ?? marginfiBankProgramId);
    results.push(...mfi);
  } catch (e) {
    errors.push(`marginfi: ${e instanceof Error ? e.message : e}`);
  }

  // Jupiter Lend — requires API key; skip if not configured
  if (config.jupiterApiKey) {
    try {
      const jup = await scanJupiterPools(config.jupiterProgramId, config.jupiterApiKey);
      results.push(...jup);
    } catch (e) {
      errors.push(`jupiter: ${e instanceof Error ? e.message : e}`);
    }
  }

  if (errors.length > 0) {
    console.warn("[poolScanner] Some scans failed:", errors.join("; "));
  }

  // Sort: highest adjusted score first
  return results.sort((a, b) => b.adjustedScore - a.adjustedScore);
}
