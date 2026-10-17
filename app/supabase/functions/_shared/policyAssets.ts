// Binds policy deploys to an asset the treasury holds.
//
// The policy engine sizes moves against NAV, which is micro-USD. A governance
// proposal commits an asset and an amount in that asset's base units. This step
// picks the held asset for each deploy and converts the micro-USD size into its
// base units, capped by the idle balance and, for a stable asset, by the
// reserve floor. A deploy with no held, valued asset is withheld.

import type { RecommendedAction, RejectedAlternative } from "./policy.ts";

export interface HeldAsset {
  mint: string;
  /** null when the asset class is not on the allowlist. */
  stable: boolean | null;
  idleBase: number;
  idleMicroUsd: number;
}

export interface BindOptions {
  /** Held assets each venue may take, preferred first. */
  candidatesFor(action: RecommendedAction): HeldAsset[];
  /** Idle stable value in micro-USD. null when the composition is unknown. */
  stableMicroUsd: number | null;
  navMicroUsd: number;
  minStablecoinReserveBps: number;
}

const BPS = 10_000;

function rejectedFrom(action: RecommendedAction, reason: string): RejectedAlternative {
  return {
    protocolId: action.protocolId,
    programId: action.programId,
    apyBps: action.apyBps ?? 0,
    riskScore: action.riskScore ?? 0,
    reason,
  };
}

function microToBase(micro: number, asset: HeldAsset): number {
  if (asset.idleMicroUsd <= 0 || asset.idleBase <= 0) return 0;
  const base = (BigInt(micro) * BigInt(asset.idleBase)) / BigInt(asset.idleMicroUsd);
  return Number(base > BigInt(asset.idleBase) ? BigInt(asset.idleBase) : base);
}

function baseToMicro(base: number, asset: HeldAsset): number {
  if (asset.idleBase <= 0) return 0;
  return Number((BigInt(base) * BigInt(asset.idleMicroUsd)) / BigInt(asset.idleBase));
}

export function bindDeployActions(
  actions: RecommendedAction[],
  opts: BindOptions,
): { actions: RecommendedAction[]; rejected: RejectedAlternative[] } {
  const out: RecommendedAction[] = [];
  const rejected: RejectedAlternative[] = [];
  const spent = new Map<string, number>();
  let stableLeft = opts.stableMicroUsd;
  const reserveFloor = Math.ceil((opts.navMicroUsd * Math.max(0, opts.minStablecoinReserveBps)) / BPS);

  for (const action of actions) {
    if (action.actionType !== "deploy") {
      out.push(action);
      continue;
    }
    const held = opts.candidatesFor(action).filter((a) => a.idleBase > 0 && a.idleMicroUsd > 0);
    const asset = held[0];
    if (!asset) {
      rejected.push(rejectedFrom(action, "asset_not_held"));
      continue;
    }
    if (asset.stable == null) {
      rejected.push(rejectedFrom(action, "asset_class_unknown"));
      continue;
    }
    const used = spent.get(asset.mint) ?? 0;
    let micro = Math.min(action.amountBaseUnits, Math.max(0, asset.idleMicroUsd - used));
    if (asset.stable) {
      if (stableLeft == null) {
        rejected.push(rejectedFrom(action, "reserve_unknown"));
        continue;
      }
      micro = Math.min(micro, Math.max(0, stableLeft - reserveFloor));
    }
    const base = microToBase(micro, asset);
    if (base <= 0) {
      rejected.push(rejectedFrom(action, asset.stable ? "reserve_floor_reached" : "no_idle_balance"));
      continue;
    }
    const valued = baseToMicro(base, asset);
    spent.set(asset.mint, used + valued);
    if (asset.stable && stableLeft != null) stableLeft -= valued;
    out.push({ ...action, mint: asset.mint, amountBaseUnits: base });
  }
  return { actions: out, rejected };
}
