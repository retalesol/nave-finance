import test from "node:test";
import assert from "node:assert/strict";
import { bindDeployActions, type HeldAsset } from "../../supabase/functions/_shared/policyAssets.ts";
import { computeDrift, evaluatePolicy, type PolicyInputs, type RecommendedAction } from "../../supabase/functions/_shared/policy.ts";

const USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const WSOL = "So11111111111111111111111111111111111111112";
const JITOSOL = "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn";

function deploy(protocolId: string, amount: number, mint?: string): RecommendedAction {
  return {
    actionType: "deploy",
    protocolId,
    programId: protocolId === "compound-v3" ? "0x845d8310A861A95Ed1644643D1BAe086944B1AA0" : "E2fviyVGWF8iEwZK2M8ysrd63DM5yKxu6nuBMzjBQ2XT",
    amountBaseUnits: amount,
    mint,
    rationale: "test",
  };
}

test("a Sepolia USDC deploy is bound to the held asset in its own base units", () => {
  const usdc: HeldAsset = { mint: USDC, stable: true, idleBase: 2_000_000, idleMicroUsd: 1_999_720 };
  const out = bindDeployActions([deploy("compound-v3", 999_859)], {
    candidatesFor: () => [usdc],
    stableMicroUsd: 1_999_720,
    navMicroUsd: 1_999_721,
    minStablecoinReserveBps: 3500,
  });
  assert.equal(out.rejected.length, 0);
  assert.equal(out.actions[0].mint, USDC);
  assert.equal(out.actions[0].amountBaseUnits, 999_998);
  assert.ok(out.actions[0].amountBaseUnits <= usdc.idleBase);
});

test("a Jito deploy uses wrapped SOL lamports, not a dollar amount on the receipt mint", () => {
  const wsol: HeldAsset = { mint: WSOL, stable: false, idleBase: 49_996_844, idleMicroUsd: 5_273_637 };
  const out = bindDeployActions([deploy("jito", 2_642_111, JITOSOL)], {
    candidatesFor: () => [wsol],
    stableMicroUsd: 0,
    navMicroUsd: 5_284_222,
    minStablecoinReserveBps: 3500,
  });
  assert.equal(out.actions[0].mint, WSOL);
  assert.equal(out.actions[0].amountBaseUnits, 25_048_597);
  assert.notEqual(out.actions[0].mint, JITOSOL);
});

test("a treasury with no stablecoins is not flagged under the reserve floor; a thin one is", () => {
  const base: PolicyInputs = {
    daoAddress: "dao",
    navBaseUnits: 5_284_222,
    deployedBaseUnits: 0,
    stablecoinBaseUnits: 0,
    positions: [],
    approvedProtocols: [],
    policy: {
      minStablecoinReserveBps: 3500,
      maxTotalDeployedBps: 5000,
      minLiquidityBps: 2000,
      rebalanceFrequencySecs: 0,
      lastRebalanceAt: 0,
      confidenceThreshold: 70,
    },
    opportunities: [],
    nowSecs: 0,
  };
  assert.ok(!computeDrift(base).flags.includes("reserve_floor_breached"));
  assert.ok(computeDrift({ ...base, stablecoinBaseUnits: 100_000 }).flags.includes("reserve_floor_breached"));
});

test("a deploy uses 90% of the remaining cap so NAV drift before execute stays under it", () => {
  const rec = evaluatePolicy({
    daoAddress: "dao",
    navBaseUnits: 1_000_000,
    deployedBaseUnits: 0,
    stablecoinBaseUnits: 1_000_000,
    positions: [],
    approvedProtocols: [{ protocolId: "compound-v3", programId: "0xC", maxAllocationBps: 5000, approved: true }],
    policy: {
      minStablecoinReserveBps: 3500,
      maxTotalDeployedBps: 5000,
      minLiquidityBps: 2000,
      rebalanceFrequencySecs: 0,
      lastRebalanceAt: 0,
      confidenceThreshold: 70,
    },
    opportunities: [{ protocolId: "compound-v3", programId: "0xC", apyBps: 500, riskScore: 18, assetClass: "stablecoin", liquid: true }],
    nowSecs: 0,
  });
  assert.equal(rec.actions.length, 1);
  assert.equal(rec.actions[0].amountBaseUnits, 450_000);
});

test("a stable deploy stops at the reserve floor, and an unheld or unclassified asset is withheld", () => {
  const usdc: HeldAsset = { mint: USDC, stable: true, idleBase: 1_000_000, idleMicroUsd: 1_000_000 };
  const capped = bindDeployActions([deploy("compound-v3", 900_000)], {
    candidatesFor: () => [usdc],
    stableMicroUsd: 1_000_000,
    navMicroUsd: 1_000_000,
    minStablecoinReserveBps: 3500,
  });
  assert.equal(capped.actions[0].amountBaseUnits, 650_000);

  const none = bindDeployActions([deploy("compound-v3", 900_000)], {
    candidatesFor: () => [],
    stableMicroUsd: 1_000_000,
    navMicroUsd: 1_000_000,
    minStablecoinReserveBps: 3500,
  });
  assert.equal(none.actions.length, 0);
  assert.equal(none.rejected[0].reason, "asset_not_held");

  const unknown = bindDeployActions([deploy("compound-v3", 900_000)], {
    candidatesFor: () => [{ ...usdc, stable: null }],
    stableMicroUsd: null,
    navMicroUsd: 1_000_000,
    minStablecoinReserveBps: 3500,
  });
  assert.equal(unknown.rejected[0].reason, "asset_class_unknown");

  const reserveUnknown = bindDeployActions([deploy("compound-v3", 900_000)], {
    candidatesFor: () => [usdc],
    stableMicroUsd: null,
    navMicroUsd: 1_000_000,
    minStablecoinReserveBps: 3500,
  });
  assert.equal(reserveUnknown.rejected[0].reason, "reserve_unknown");
});
