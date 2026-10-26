import assert from "node:assert/strict";
import test from "node:test";
import { evaluatePolicy } from "../../supabase/functions/_shared/policy.ts";
import {
  persistedAssetClass,
  scoreEvmTestnetOpportunities,
  toPolicyAssetClass,
} from "../../supabase/functions/_shared/yieldSources.ts";
import {
  CCTP_USDC_ONE_WAY_COST_BPS_ESTIMATE,
  annualizedBridgeDragBps,
  bridgeCostFor,
  ethereumFamilyOpportunities,
  netOfBridgeApyBps,
  solanaYieldProtocolIds,
} from "../../supabase/functions/_shared/ethereumFamilyYield.ts";

test("asset class persistence keeps sol-like, blue-chip, and stablecoin", () => {
  assert.equal(toPolicyAssetClass("sol-like"), "sol-like");
  assert.equal(toPolicyAssetClass("SOL-like"), "sol-like");
  assert.equal(toPolicyAssetClass("sol"), "sol-like");
  assert.equal(toPolicyAssetClass("stablecoin"), "stablecoin");
  assert.equal(toPolicyAssetClass("blue-chip"), "blue-chip");
  assert.equal(toPolicyAssetClass("lp"), "lp");
  assert.equal(toPolicyAssetClass("other"), "other");

  assert.equal(persistedAssetClass({ protocolId: "jito", assetClass: "sol", symbol: "JitoSOL" }), "sol-like");
  assert.equal(persistedAssetClass({ protocolId: "jito", assetClass: "sol-like" }), "sol-like");
  assert.equal(persistedAssetClass({ protocolId: "aave", symbol: "USDC", assetClass: "stablecoin" }), "stablecoin");
  assert.equal(persistedAssetClass({ protocolId: "aave", symbol: "WETH", assetClass: "stablecoin" }), "blue-chip");
  assert.equal(persistedAssetClass({ protocolId: "wsteth", symbol: "wstETH" }), "blue-chip");
  assert.equal(persistedAssetClass({ protocolId: "aave-v3-weth", symbol: "WETH", assetClass: "blue-chip" }), "blue-chip");
  assert.equal(persistedAssetClass({ protocolId: "kamino", assetClass: "lp" }), "lp");
});

test("net of bridge subtracts the one-way cost spread over a 30-day hold", () => {
  assert.equal(annualizedBridgeDragBps(15, 30), 183);
  assert.equal(netOfBridgeApyBps(450, 15, 30), 267);
  assert.equal(bridgeCostFor(46630, "usdc").source, "estimate:cctp-standard-gas-15bps");
  assert.equal(bridgeCostFor(46630, "usdc").kind, "estimate");
  assert.equal(bridgeCostFor(46630, "eth").rail, "arbitrum-nitro");
  assert.equal(bridgeCostFor(84532, "eth").rail, "op-standard-bridge");
  assert.equal(bridgeCostFor(5042002, "eth").source, "estimate:arc-eth-bridge-unspecified-25bps");
  assert.equal(bridgeCostFor(5042002, "usdc").rail, "cctp");

  const row = ethereumFamilyOpportunities(84532).find((item) => item.protocolId === "aave-v3-usdc");
  assert.ok(row);
  assert.equal(row.venueApyBps, 450);
  assert.equal(row.bridgeOneWayCostBps, CCTP_USDC_ONE_WAY_COST_BPS_ESTIMATE);
  assert.equal(row.bridgeCostKind, "estimate");
  assert.equal(row.netApyBps, netOfBridgeApyBps(450, CCTP_USDC_ONE_WAY_COST_BPS_ESTIMATE));
  assert.equal(row.apyBps, row.netApyBps);
  assert.match(row.source ?? "", /bridge-required/);
  assert.match(row.source ?? "", /estimate:cctp-standard-gas-15bps/);
});

test("bridged venues stay visible and are not executable without a linked treasury and the outbound flag", () => {
  const hidden = ethereumFamilyOpportunities(46630);
  const aave = hidden.find((item) => item.protocolId === "aave-v3-usdc");
  const wsteth = hidden.find((item) => item.protocolId === "wsteth");
  assert.ok(aave);
  assert.ok(wsteth);
  assert.equal(aave.bridgeRequired, true);
  assert.equal(aave.executable, false);
  assert.match(aave.executionLabel ?? "", /not executable/);
  assert.match(aave.executionLabel ?? "", /no linked Ethereum treasury/);
  assert.match(aave.executionLabel ?? "", /outbound bridge is off/);
  assert.equal(aave.yieldBand, "below-band");
  assert.equal(wsteth.yieldBand, "below-band");
  assert.equal(wsteth.assetClass, "blue-chip");

  const linkOnly = ethereumFamilyOpportunities(84532, { linkedEthereumTreasury: true });
  assert.equal(linkOnly.find((item) => item.protocolId === "aave-v3-usdc")?.executable, false);

  const flagOnly = ethereumFamilyOpportunities(84532, { outboundBridgeEnabled: true });
  assert.equal(flagOnly.find((item) => item.protocolId === "aave-v3-usdc")?.executable, false);

  const ready = ethereumFamilyOpportunities(46630, {
    linkedEthereumTreasury: true,
    outboundBridgeEnabled: true,
  });
  assert.equal(ready.find((item) => item.protocolId === "aave-v3-usdc")?.executable, true);
  assert.equal(ready.find((item) => item.protocolId === "aave-v3-usdc")?.executionLabel, "executable");
  const spark = ready.find((item) => item.protocolId === "spark-susds");
  assert.ok(spark);
  assert.equal(spark.executable, false);
  assert.match(spark.executionLabel ?? "", /not executable: venue address is not allowlisted/);

  const rec = evaluatePolicy({
    daoAddress: "dao",
    navBaseUnits: 1_000_000,
    deployedBaseUnits: 0,
    stablecoinBaseUnits: 1_000_000,
    positions: [],
    approvedProtocols: [{ protocolId: "aave-v3-usdc", programId: aave.programId, maxAllocationBps: 5000, approved: true }],
    policy: {
      minStablecoinReserveBps: 0,
      maxTotalDeployedBps: 8000,
      minLiquidityBps: 0,
      rebalanceFrequencySecs: 0,
      lastRebalanceAt: 0,
      confidenceThreshold: 70,
    },
    opportunities: hidden,
    nowSecs: 0,
  });
  assert.equal(rec.actions.length, 0);
  assert.ok(rec.rejected.some((item) => item.reason === "not_executable" && item.protocolId === "aave-v3-usdc"));
});

test("solana yield list does not include Aave, and EVM treasuries do not see Solana venues", () => {
  const solana = solanaYieldProtocolIds(false);
  assert.deepEqual(solana, ["kamino", "jito", "jupiter"]);
  assert.equal(solana.includes("aave"), false);
  assert.equal(solana.includes("marginfi"), false);
  assert.equal(solanaYieldProtocolIds(true).includes("marginfi"), true);
  assert.equal(solanaYieldProtocolIds(true).includes("aave"), false);

  for (const home of [84532, 46630, 5042002, 8453, 4663, 5042]) {
    const rows = ethereumFamilyOpportunities(home);
    const ids = rows.map((row) => row.protocolId);
    assert.equal(ids.includes("aave-v3-usdc"), true, `home ${home} should see Aave`);
    assert.equal(ids.includes("aave-v3-weth"), true);
    assert.equal(ids.includes("compound-v3-usdc"), true);
    assert.equal(ids.includes("morpho-steakhouse-usdc"), true);
    assert.equal(ids.includes("morpho-gauntlet-usdc"), true);
    assert.equal(ids.includes("spark-susds"), true);
    assert.equal(ids.includes("wsteth"), true);
    for (const banned of ["kamino", "jito", "jupiter", "marginfi", "curve", "nexo", "nexus"]) {
      assert.equal(ids.includes(banned), false, `${banned} must not appear on home ${home}`);
    }
    assert.equal(rows.every((row) => row.bridgeRequired === true), true);
  }

  assert.deepEqual(ethereumFamilyOpportunities(11155111), []);
  assert.deepEqual(solanaYieldProtocolIds(false).filter((id) => id === "aave"), []);

  const baseSepolia = scoreEvmTestnetOpportunities([{ protocolId: "aave", programId: "" }], "base", 84532);
  const bridged = baseSepolia.filter((row) => row.bridgeRequired);
  assert.ok(bridged.some((row) => row.protocolId === "aave-v3-usdc" && row.venueChainId === 11155111));
  assert.equal(baseSepolia.some((row) => row.protocolId === "jito"), false);
  assert.equal(baseSepolia[0]?.source, "testnet-rate:aave-v3");
});

test("mainnet homes receive the Ethereum list without invented pool rates", () => {
  const unread = ethereumFamilyOpportunities(8453);
  assert.ok(unread.length > 0);
  for (const row of unread) {
    assert.equal(row.apyRead, false);
    assert.equal(row.venueApyBps, undefined);
    assert.equal(row.netApyBps, undefined);
    assert.equal((row.source ?? "").includes("testnet-rate"), false);
    assert.match(row.source ?? "", /mainnet:rate-not-read/);
    assert.equal(row.venueChainId, 1);
  }

  const rated = ethereumFamilyOpportunities(8453, { liveApyBps: { aave: 430 } });
  const usdc = rated.find((row) => row.protocolId === "aave-v3-usdc");
  const weth = rated.find((row) => row.protocolId === "aave-v3-weth");
  assert.ok(usdc);
  assert.ok(weth);
  assert.equal(usdc.apyRead, true);
  assert.equal(usdc.venueApyBps, 430);
  assert.equal(usdc.netApyBps, netOfBridgeApyBps(430, CCTP_USDC_ONE_WAY_COST_BPS_ESTIMATE));
  assert.equal(weth.apyRead, false);
  assert.equal(weth.venueApyBps, undefined);
});
