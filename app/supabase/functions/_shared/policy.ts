// Deterministic constitution-driven policy evaluator (Phase 2).
//
// Pure, dependency-light core of Nave's continuous treasury management. Given an
// authoritative snapshot of on-chain policy + vault state and a set of scanned
// yield opportunities, it produces a fully deterministic, auditable plan:
//   - drift diagnostics vs the constitution (reserve / deployment / liquidity /
//     rebalance cadence),
//   - a ranked, bounds-checked set of recommended actions,
//   - the rejected alternatives with explicit reasons,
//   - a reproducible proof hash over the canonical inputs + outputs.
//
// IMPORTANT: this module NEVER signs or submits anything. It only recommends.
// On-chain invariants and the deterministic guardrails remain the signing
// authority. Recommendations flow into governance (Phase 4), never directly to
// the signer. Keep this file free of network / wallet imports so it can be unit
// tested and reused by both the edge function and the guardrails.

export const POLICY_ENGINE_VERSION = "1.0.0";

/**
 * Matches the curated allowlist (`allowedAssets.ts`). Legacy feeds that say
 * `"sol"` are normalized to `"sol-like"`. The `yield_opportunities` check also
 * still accepts the legacy `"sol"` label on rows already stored.
 */
export type AssetClass = "stablecoin" | "sol-like" | "blue-chip" | "lp" | "other";

/** Values the yield_opportunities.asset_class check accepts. */
export const PERSISTED_ASSET_CLASSES = ["stablecoin", "sol", "sol-like", "blue-chip", "lp", "other"] as const;
export type PersistedAssetClass = (typeof PERSISTED_ASSET_CLASSES)[number];

/** 6–12% is a label on a live rate. It does not drop venues outside the band. */
export type YieldBand = "in-band" | "below-band" | "above-band";

/** A scored yield opportunity on an approved protocol. */
export interface YieldOpportunity {
  protocolId: string;
  programId: string;
  /**
   * Underlying asset mint for this specific pool (e.g. USDC mint).
   * Optional for backward compatibility with per-protocol-only entries.
   */
  mint?: string;
  /** Human-readable symbol of the underlying asset (e.g. "USDC"). */
  symbol?: string;
  /**
   * Protocol-specific pool identifier (e.g. "kamino:USDC:lendingMarket").
   * Populated by the pool scanner; absent for builtin/fallback entries.
   */
  poolId?: string;
  /**
   * External market address for configure_position_targets.
   * Optional; populated by live pool scanner.
   */
  extMarket?: string;
  /**
   * External reserve/vault address for configure_position_targets.
   * Optional; populated by live pool scanner.
   */
  extReserve?: string;
  /** Collateral mint for Kamino configure_position_targets. */
  collateralMint?: string;
  /** Annual percentage yield, in basis points (500 = 5.00%). */
  apyBps: number;
  /** Risk score 0..100 (0 = safest). Lower is better. */
  riskScore: number;
  /**
   * Risk-adjusted yield score. Populated by the pool scanner.
   * Higher is better: apyBps / (1 + riskScore/100).
   */
  adjustedScore?: number;
  /** Total value locked in USD (for risk assessment). */
  tvlUsd?: number;
  /** Asset class the opportunity is denominated in. */
  assetClass: AssetClass;
  /** True when funds can be withdrawn near-instantly (counts toward liquidity). */
  liquid: boolean;
  /** Free-form source label (e.g. "kamino:usdc-reserve"). */
  source?: string;
  /** Display name. Scoring uses protocolId. */
  label?: string;
  /**
   * Catalog chain whose stored rate applies. Cross-chain Ethereum venues on a
   * Base, Robinhood, or Arc treasury use `"ethereum"`.
   */
  rateChain?: "solana" | "ethereum" | "base" | "robinhood" | "arc";
  /** Catalog venue id when it differs from protocolId. */
  rateVenueId?: string;
  /**
   * False when apyBps is not a pool read and not a documented testnet static
   * rate. Callers must not present that apyBps as a market rate.
   */
  apyRead?: boolean;
  /** Venue APY before bridge drag. Set only when apyRead is not false. */
  venueApyBps?: number;
  /** Venue APY minus bridge cost spread over a 30-day hold. */
  netApyBps?: number;
  bridgeRequired?: boolean;
  /** One-way bridge cost in bps of principal, before 30-day annualization. */
  bridgeOneWayCostBps?: number;
  bridgeCostKind?: "estimate" | "live";
  /** Named estimate or live quote id, for example `estimate:cctp-standard-gas-15bps`. */
  bridgeCostSource?: string;
  bridgeLabel?: string;
  /**
   * False when a bridged venue must stay visible but must not become a deploy.
   * Unset means a same-chain venue the scanner already accepted.
   */
  executable?: boolean;
  executionLabel?: string;
  yieldBand?: YieldBand;
  /** Chain the venue itself lives on (1 or 11155111 for Ethereum-family rows). */
  venueChainId?: number;
  venueChainLabel?: string;
}

/** Per-protocol allocation cap (bps of NAV) from the constitution. */
export interface ApprovedProtocolCap {
  protocolId: string;
  programId: string;
  maxAllocationBps: number;
  approved: boolean;
}

/** Current per-protocol deployed value, base units. */
export interface ProtocolPosition {
  protocolId: string;
  currentValueBaseUnits: number;
  /**
   * SPL mint of the asset deployed in this position (base58).
   * Populated from on-chain StrategyPosition.mint when available; null when
   * the position reader could not decode it (legacy/uninitialized account).
   * Threaded into `withdraw` RecommendedActions so multi-asset same-kind DAOs
   * can resolve the correct withdrawal asset without ambiguity.
   */
  mint?: string | null;
}

/** The constitution's continuous-policy parameters. 0 bps = unset/disabled. */
export interface PolicyParams {
  minStablecoinReserveBps: number;
  maxTotalDeployedBps: number;
  minLiquidityBps: number;
  rebalanceFrequencySecs: number;
  lastRebalanceAt: number;
  /** Minimum model/opportunity confidence; mirrored from the constitution. */
  confidenceThreshold: number;
}

export interface PolicyInputs {
  daoAddress: string;
  /** Authoritative on-chain NAV in token base units. */
  navBaseUnits: number;
  /** Authoritative on-chain deployed capital, base units. */
  deployedBaseUnits: number;
  /**
   * Stablecoin holdings in base units, when known (e.g. from a treasury
   * snapshot). `null` => reserve composition unknown (fail-open with a flag,
   * never silently treated as compliant).
   */
  stablecoinBaseUnits: number | null;
  positions: ProtocolPosition[];
  approvedProtocols: ApprovedProtocolCap[];
  policy: PolicyParams;
  opportunities: YieldOpportunity[];
  /** Unix seconds the evaluation runs at. */
  nowSecs: number;
  /**
   * Hard ceiling on opportunity risk score the planner will recommend. Keeps
   * the planner biased toward "extremely low risk" per the constitution intent.
   */
  maxRiskScore?: number;
}

export type DriftFlag =
  | "deployment_cap_breached"
  | "liquidity_floor_breached"
  | "reserve_floor_breached"
  | "reserve_unknown"
  | "rebalance_due"
  | "idle_capital_available";

export interface PolicyDrift {
  navBaseUnits: number;
  deployedBaseUnits: number;
  liquidBaseUnits: number;
  deployedBps: number;
  liquidBps: number;
  stablecoinBps: number | null;
  /** Max base units that may be additionally deployed without breaching policy. */
  deployableHeadroomBaseUnits: number;
  rebalanceDue: boolean;
  flags: DriftFlag[];
}

export type RecommendedActionType = "deploy" | "withdraw" | "hold";

export interface RecommendedAction {
  actionType: RecommendedActionType;
  protocolId: string;
  programId: string;
  amountBaseUnits: number;
  /**
   * SPL mint of the specific asset being deployed/withdrawn for THIS action.
   * DAOs are multi-asset, so the deployed asset is NOT necessarily the DAO's
   * first registered token — this is the authoritative asset signal that must
   * be bound into the governance proposal payload (NE-7) so the on-chain
   * create_execution_request payload-hash equality holds.
   *
   * Populated for `deploy` actions from the scanned opportunity's mint (the
   * pool scanner resolves the exact pool asset). For `withdraw` actions derived
   * purely from on-chain per-protocol positions the mint is NOT available
   * off-chain (positions are read per-protocol, not per-asset) and is left
   * undefined; downstream the signer derives it from the DAO's registered
   * assets by matching the protocol's required AssetKind.
   */
  mint?: string;
  /** Opportunity APY this action targets (bps), when a deploy. */
  apyBps?: number;
  riskScore?: number;
  rationale: string;
}

export interface RejectedAlternative {
  protocolId: string;
  programId: string;
  apyBps: number;
  riskScore: number;
  reason: string;
}

export interface PolicyRecommendation {
  version: string;
  daoAddress: string;
  nowSecs: number;
  drift: PolicyDrift;
  /** Highest-level intent for the cycle. */
  intent: "rebalance" | "deploy_idle" | "reduce_exposure" | "hold";
  actions: RecommendedAction[];
  rejected: RejectedAlternative[];
  /** Human-readable, deterministic summary. */
  summary: string;
}

const BPS = 10_000;
/** Share of a cap's remaining room a single deploy may use (90%). */
const HEADROOM_USE_BPS = 9_000;

function bpsOf(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round((part * BPS) / whole);
}

/** Deterministic opportunity score: reward APY, penalize risk. Higher = better. */
export function scoreOpportunity(o: YieldOpportunity): number {
  // 12 bps of "score" lost per unit of risk score. Tunable but fixed so the
  // ranking is fully reproducible. Liquid opportunities get a small bonus
  // because they also help satisfy the liquidity floor.
  const liquidityBonus = o.liquid ? 25 : 0;
  return o.apyBps - o.riskScore * 12 + liquidityBonus;
}

/**
 * Stable ordering for opportunities: by score desc, then protocolId asc, then
 * programId asc. Guarantees identical inputs always yield identical plans.
 */
function rankOpportunities(opps: YieldOpportunity[]): YieldOpportunity[] {
  return [...opps].sort((a, b) => {
    const sb = scoreOpportunity(b) - scoreOpportunity(a);
    if (sb !== 0) return sb;
    if (a.protocolId !== b.protocolId) return a.protocolId < b.protocolId ? -1 : 1;
    return a.programId < b.programId ? -1 : a.programId > b.programId ? 1 : 0;
  });
}

/**
 * Compute the on-chain enforceable deployment ceiling in base units: the
 * smaller of the explicit global cap and the liquidity-implied ceiling. Mirrors
 * `TreasuryConstitution::effective_max_deployed_bps` on-chain.
 */
export function effectiveMaxDeployedBaseUnits(
  nav: number,
  policy: PolicyParams,
): number {
  const liquidityCeilingBps = Math.max(0, BPS - (policy.minLiquidityBps || 0));
  const capBps =
    policy.maxTotalDeployedBps > 0
      ? Math.min(policy.maxTotalDeployedBps, liquidityCeilingBps)
      : liquidityCeilingBps;
  return Math.floor((nav * capBps) / BPS);
}

export function computeDrift(input: PolicyInputs): PolicyDrift {
  const nav = Math.max(0, input.navBaseUnits);
  const deployed = Math.max(0, input.deployedBaseUnits);
  const liquid = Math.max(0, nav - deployed);
  const flags: DriftFlag[] = [];

  const deployedBps = bpsOf(deployed, nav);
  const liquidBps = bpsOf(liquid, nav);

  if (input.policy.maxTotalDeployedBps > 0 && deployedBps > input.policy.maxTotalDeployedBps) {
    flags.push("deployment_cap_breached");
  }
  if (input.policy.minLiquidityBps > 0 && liquidBps < input.policy.minLiquidityBps) {
    flags.push("liquidity_floor_breached");
  }

  let stablecoinBps: number | null = null;
  if (input.policy.minStablecoinReserveBps > 0) {
    if (input.stablecoinBaseUnits === null) {
      flags.push("reserve_unknown");
    } else {
      stablecoinBps = bpsOf(input.stablecoinBaseUnits, nav);
      // A treasury that holds no stablecoins is not yet bound by the floor,
      // matching the reserve_floor guardrail.
      if (input.stablecoinBaseUnits > 0 && stablecoinBps < input.policy.minStablecoinReserveBps) {
        flags.push("reserve_floor_breached");
      }
    }
  }

  const maxDeployable = effectiveMaxDeployedBaseUnits(nav, input.policy);
  const deployableHeadroom = Math.max(0, maxDeployable - deployed);
  if (deployableHeadroom > 0) flags.push("idle_capital_available");

  const rebalanceDue =
    input.policy.rebalanceFrequencySecs > 0 &&
    input.nowSecs - input.policy.lastRebalanceAt >= input.policy.rebalanceFrequencySecs;
  if (rebalanceDue) flags.push("rebalance_due");

  return {
    navBaseUnits: nav,
    deployedBaseUnits: deployed,
    liquidBaseUnits: liquid,
    deployedBps,
    liquidBps,
    stablecoinBps,
    deployableHeadroomBaseUnits: deployableHeadroom,
    rebalanceDue,
    flags,
  };
}

/**
 * Evaluate the full policy and produce a deterministic recommendation. Never
 * mutates inputs. Allocation respects per-protocol caps AND the global
 * deployment/liquidity ceilings, so a recommended plan can never breach the
 * constitution (the same invariants the on-chain program enforces).
 */
export function evaluatePolicy(input: PolicyInputs): PolicyRecommendation {
  const drift = computeDrift(input);
  const maxRisk = input.maxRiskScore ?? 40;
  const nav = drift.navBaseUnits;

  const approvedById = new Map(
    input.approvedProtocols.filter((p) => p.approved).map((p) => [p.programId, p]),
  );
  const positionByProtocol = new Map(
    input.positions.map((p) => [p.protocolId, p.currentValueBaseUnits]),
  );

  const actions: RecommendedAction[] = [];
  const rejected: RejectedAlternative[] = [];

  // 1. Reduce exposure first if any hard floor/cap is breached (compliance
  //    always takes precedence over chasing yield).
  if (drift.flags.includes("deployment_cap_breached") || drift.flags.includes("liquidity_floor_breached")) {
    const maxDeployable = effectiveMaxDeployedBaseUnits(nav, input.policy);
    const excess = Math.max(0, drift.deployedBaseUnits - maxDeployable);
    if (excess > 0) {
      // Unwind from the lowest-scoring currently-held positions first.
      const held = input.positions
        .filter((p) => p.currentValueBaseUnits > 0)
        .sort((a, b) => a.currentValueBaseUnits - b.currentValueBaseUnits);
      let remaining = excess;
      for (const pos of held) {
        if (remaining <= 0) break;
        const amount = Math.min(remaining, pos.currentValueBaseUnits);
        const meta = input.approvedProtocols.find((p) => p.protocolId === pos.protocolId);
        actions.push({
          actionType: "withdraw",
          protocolId: pos.protocolId,
          programId: meta?.programId ?? "",
          amountBaseUnits: amount,
          // Thread the asset mint from the on-chain StrategyPosition so the
          // signer can bind the correct mint into the NE-7 payload hash for
          // multi-asset DAOs, instead of falling back to a by-kind derivation
          // that fails when two same-kind assets are registered (e.g. USDC+USDT).
          mint: pos.mint ?? undefined,
          rationale: "Reduce exposure to restore deployment cap / liquidity floor compliance.",
        });
        remaining -= amount;
      }
    }
    return finalize(input, drift, "reduce_exposure", actions, rejected);
  }

  // 2. Otherwise deploy idle headroom into the best low-risk opportunities,
  //    respecting per-protocol caps. (Rebalance-due uses the same machinery; a
  //    full exit/re-enter cycle is orchestrated as withdraw+deploy by Phase 4.)
  //    Only part of each headroom is used: NAV moves between the vote and the
  //    execute, and an amount sized exactly to a cap is refused once it does.
  let headroom = Math.floor((drift.deployableHeadroomBaseUnits * HEADROOM_USE_BPS) / BPS);
  const ranked = rankOpportunities(input.opportunities);

  for (const opp of ranked) {
    // Bridged venues stay in the opportunity list for display. They are not
    // deploys until the treasury is linked on the venue chain and the outbound
    // bridge flag is on. An unread mainnet rate is not a deploy either.
    if (opp.executable === false) {
      rejected.push({ ...slim(opp), reason: "not_executable" });
      continue;
    }
    if (opp.apyRead === false) {
      rejected.push({ ...slim(opp), reason: "rate_not_read" });
      continue;
    }
    const cap = approvedById.get(opp.programId);
    if (!cap) {
      rejected.push({ ...slim(opp), reason: "protocol_not_approved" });
      continue;
    }
    if (opp.riskScore > maxRisk) {
      rejected.push({ ...slim(opp), reason: `risk_score_above_max(${maxRisk})` });
      continue;
    }
    if (headroom <= 0) {
      rejected.push({ ...slim(opp), reason: "no_deployment_headroom" });
      continue;
    }
    // Per-protocol remaining capacity = cap*NAV - current position.
    const protoCap = Math.floor((nav * cap.maxAllocationBps) / BPS);
    const current = positionByProtocol.get(cap.protocolId) ?? 0;
    const protoHeadroom = Math.floor((Math.max(0, protoCap - current) * HEADROOM_USE_BPS) / BPS);
    if (protoHeadroom <= 0) {
      rejected.push({ ...slim(opp), reason: "protocol_cap_reached" });
      continue;
    }
    const amount = Math.min(headroom, protoHeadroom);
    if (amount <= 0) {
      rejected.push({ ...slim(opp), reason: "no_allocatable_amount" });
      continue;
    }
    actions.push({
      actionType: "deploy",
      protocolId: opp.protocolId,
      programId: opp.programId,
      amountBaseUnits: amount,
      // Bind the exact pool asset mint when the scanner resolved one. This is
      // what the proposal payload must commit for multi-asset DAOs.
      mint: opp.mint,
      apyBps: opp.apyBps,
      riskScore: opp.riskScore,
      rationale: `Deploy idle capital into highest-scoring low-risk opportunity (apy ${opp.apyBps}bps, risk ${opp.riskScore}).`,
    });
    headroom -= amount;
  }

  const intent: PolicyRecommendation["intent"] =
    actions.length > 0 ? (drift.rebalanceDue ? "rebalance" : "deploy_idle") : "hold";
  return finalize(input, drift, intent, actions, rejected);
}

/** Same drift, new action list. Intent and summary follow the actions that remain. */
export function withActions(
  input: PolicyInputs,
  rec: PolicyRecommendation,
  actions: RecommendedAction[],
  extraRejected: RejectedAlternative[],
): PolicyRecommendation {
  let intent = rec.intent;
  if (intent !== "reduce_exposure") {
    intent = actions.length > 0 ? (rec.drift.rebalanceDue ? "rebalance" : "deploy_idle") : "hold";
  }
  return finalize(input, rec.drift, intent, actions, [...rec.rejected, ...extraRejected]);
}

function slim(o: YieldOpportunity): Omit<RejectedAlternative, "reason"> {
  return { protocolId: o.protocolId, programId: o.programId, apyBps: o.apyBps, riskScore: o.riskScore };
}

function finalize(
  input: PolicyInputs,
  drift: PolicyDrift,
  intent: PolicyRecommendation["intent"],
  actions: RecommendedAction[],
  rejected: RejectedAlternative[],
): PolicyRecommendation {
  const summary = buildSummary(intent, drift, actions);
  return {
    version: POLICY_ENGINE_VERSION,
    daoAddress: input.daoAddress,
    nowSecs: input.nowSecs,
    drift,
    intent,
    actions,
    rejected,
    summary,
  };
}

function buildSummary(
  intent: PolicyRecommendation["intent"],
  drift: PolicyDrift,
  actions: RecommendedAction[],
): string {
  const parts = [
    `intent=${intent}`,
    `deployed=${drift.deployedBps}bps`,
    `liquid=${drift.liquidBps}bps`,
    drift.stablecoinBps !== null ? `stable=${drift.stablecoinBps}bps` : `stable=unknown`,
    drift.flags.length ? `flags=[${drift.flags.join(",")}]` : "flags=[]",
    `actions=${actions.length}`,
  ];
  return parts.join(" ");
}

/**
 * Canonical, order-stable serialization of the evaluation (inputs + outputs)
 * for a reproducible audit/proof hash. Two evaluations with identical inputs
 * produce byte-identical canonical strings.
 */
export function canonicalPolicy(rec: PolicyRecommendation, input: PolicyInputs): string {
  return JSON.stringify({
    v: rec.version,
    dao: rec.daoAddress,
    now: rec.nowSecs,
    in: {
      nav: input.navBaseUnits,
      deployed: input.deployedBaseUnits,
      stable: input.stablecoinBaseUnits,
      policy: {
        reserve: input.policy.minStablecoinReserveBps,
        maxDeployed: input.policy.maxTotalDeployedBps,
        liquidity: input.policy.minLiquidityBps,
        rebalance: input.policy.rebalanceFrequencySecs,
        lastRebalance: input.policy.lastRebalanceAt,
      },
      protocols: [...input.approvedProtocols]
        .sort((a, b) => (a.programId < b.programId ? -1 : 1))
        .map((p) => ({ id: p.protocolId, pid: p.programId, cap: p.maxAllocationBps, ok: p.approved })),
      positions: [...input.positions]
        .sort((a, b) => (a.protocolId < b.protocolId ? -1 : 1))
        .map((p) => ({ id: p.protocolId, v: p.currentValueBaseUnits })),
      opportunities: [...input.opportunities]
        .sort((a, b) => (a.programId < b.programId ? -1 : 1))
        .map((o) => ({ id: o.protocolId, pid: o.programId, apy: o.apyBps, risk: o.riskScore, liquid: o.liquid, ac: o.assetClass })),
    },
    out: {
      intent: rec.intent,
      drift: rec.drift,
      actions: rec.actions,
      rejected: rec.rejected,
    },
  });
}

/** Hex SHA-256 of the canonical policy string (Web Crypto; Deno + Node 18+). */
export async function policyProofHash(canonical: string): Promise<string> {
  const data = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
