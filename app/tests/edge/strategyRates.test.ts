import assert from "node:assert/strict";
import test from "node:test";
import {
  STRATEGY_VENUES,
  TIER2_TOTAL_CAP_PCT,
  TIER3_TOTAL_CAP_PCT,
  blendedEstimate,
  constitutionCapsBps,
  effectiveApy,
  findVenue,
  isTemporaryRate,
  packSolanaAllocation,
  presetRisks,
  unpackSolanaAllocation,
  type StrategyRate,
} from "../../supabase/functions/_shared/strategyCatalog.ts";
import { fetchStrategyRates, fromStrategyRateRow, toStrategyRateRow } from "../../supabase/functions/_shared/apySource.ts";
import { applyLiveRates } from "../../supabase/functions/_shared/yieldSources.ts";

function rate(venueId: string, chain: StrategyRate["chain"], baseApy: number, mean30dApy: number | null = null): StrategyRate {
  return { venueId, chain, baseApy, rewardApy: null, mean30dApy, tvlUsd: 1e6, source: `test:${venueId}`, fetchedAt: "2026-10-10T00:00:00Z" };
}

test("catalog ids are unique per chain and every venue has a tier and exit note", () => {
  const seen = new Set<string>();
  for (const v of STRATEGY_VENUES) {
    const key = `${v.chain}:${v.id}`;
    assert.equal(seen.has(key), false, `duplicate ${key}`);
    seen.add(key);
    assert.ok([1, 2, 3].includes(v.tier));
    assert.ok(v.exitNote.length > 0);
    if (v.availability === "later") assert.ok(v.laterReason, `${key} needs a laterReason`);
  }
  assert.equal(findVenue("solana", "jito")?.stable, false);
  assert.equal(findVenue("solana", "marginfi")?.hiddenByDefault, true);
  assert.equal(findVenue("ethereum", "maple-syrup")?.tier, 3);
  assert.equal(findVenue("ethereum", "pendle-pt-susde")?.exit, "maturity");
  assert.equal(findVenue("robinhood", "morpho-steakhouse-usdg")?.availability, "testnet");
  assert.equal(findVenue("arc", "morpho-steakhouse-usdc")?.availability, "testnet");
});

test("effectiveApy ignores rewards and falls back to the 30-day mean on a spike", () => {
  assert.equal(effectiveApy({ baseApy: 4.5, mean30dApy: 4.2 }, 1), 4.5);
  assert.equal(effectiveApy({ baseApy: 9, mean30dApy: 5 }, 1), 5);
  assert.equal(isTemporaryRate({ baseApy: 9, mean30dApy: 5 }), true);
  assert.equal(effectiveApy({ baseApy: 6.4, mean30dApy: 5 }, 1), 6.4);
  assert.equal(effectiveApy(null, 3.3), 3.3);
  assert.equal(effectiveApy({ baseApy: null, mean30dApy: 4 }, 3.3), 3.3);
});

test("tier caps split the tier ceiling across approved venues", () => {
  const caps = constitutionCapsBps(
    [
      { id: "aave", tier: 1 },
      { id: "hy", tier: 2 },
      { id: "maple", tier: 3 },
      { id: "ethena", tier: 3 },
      { id: "pendle", tier: 3 },
    ],
    40,
  );
  assert.equal(caps.get("aave"), 4000);
  assert.equal(caps.get("hy"), TIER2_TOTAL_CAP_PCT * 100);
  const tier3 = ["maple", "ethena", "pendle"].reduce((s, id) => s + (caps.get(id) ?? 0), 0);
  assert.ok(tier3 <= TIER3_TOTAL_CAP_PCT * 100, `tier 3 total ${tier3}`);
  assert.equal(caps.get("maple"), 500);
  // A lower per-venue limit wins over the tier share.
  assert.equal(constitutionCapsBps([{ id: "hy", tier: 2 }], 10).get("hy"), 1000);
});

test("solana allocation packing round-trips and legacy values read as tier 1", () => {
  for (const tier of [1, 2, 3] as const) {
    const packed = packSolanaAllocation(1500, tier);
    assert.deepEqual(unpackSolanaAllocation(packed), { bps: 1500, riskTier: tier });
  }
  assert.deepEqual(unpackSolanaAllocation(10_000), { bps: 10_000, riskTier: 1 });
  assert.equal(packSolanaAllocation(20_000, 1), 10_000);
});

test("yield6 blend on ethereum is honest about the 6% target", () => {
  const rates = new Map<string, StrategyRate>([
    ["aave", rate("aave", "ethereum", 4.3)],
    ["morpho-steakhouse-usdc", rate("morpho-steakhouse-usdc", "ethereum", 4.5)],
    ["maple-syrup", rate("maple-syrup", "ethereum", 5.2)],
    ["ethena-susde", rate("ethena-susde", "ethereum", 4.9)],
    ["pendle-pt-susde", rate("pendle-pt-susde", "ethereum", 5.0)],
  ]);
  const est = blendedEstimate("ethereum", "yield6", rates);
  const totalWeight = [...est.weights.values()].reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(totalWeight - 1) < 1e-9);
  const tier3Weight = ["maple-syrup", "ethena-susde", "pendle-pt-susde"].reduce((s, id) => s + (est.weights.get(id) ?? 0), 0);
  assert.ok(Math.abs(tier3Weight - 0.15) < 1e-9);
  assert.equal(est.meetsTarget, false);
  assert.ok(est.apy > 4.5 && est.apy < 6, `apy ${est.apy}`);

  const high = new Map(rates);
  for (const id of ["maple-syrup", "ethena-susde", "pendle-pt-susde"]) high.set(id, rate(id, "ethereum", 12));
  high.set("morpho-steakhouse-usdc", rate("morpho-steakhouse-usdc", "ethereum", 5.2));
  assert.equal(blendedEstimate("ethereum", "yield6", high).meetsTarget, true);

  assert.equal(blendedEstimate("ethereum", "conservative", rates).meetsTarget, null);
  assert.ok(presetRisks("ethereum", "yield6").some((r) => r.includes("Synthetic dollar")));
  assert.equal(presetRisks("ethereum", "conservative").some((r) => r.includes("Synthetic dollar")), false);
});

test("fetchStrategyRates maps each source and skips failed ones", async () => {
  const venues = [
    findVenue("ethereum", "aave")!,
    findVenue("base", "morpho-steakhouse-hy-usdc")!,
    findVenue("arc", "morpho-steakhouse-usdc")!,
    findVenue("solana", "kamino")!,
    findVenue("ethereum", "pendle-pt-susde")!,
  ];
  const calls: string[] = [];
  const fetcher = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push(url);
    if (url.includes("yields.llama.fi")) {
      return Response.json({ data: [{ pool: "aa70268e-4b52-42bf-a116-608b370f9501", apyBase: 4.3, apyReward: 1.1, apyMean30d: 4.1, tvlUsd: 9e8 }] });
    }
    if (url.includes("morpho")) {
      assert.match(String(init?.body), /netApy/);
      return Response.json({
        data: {
          vaults: { items: [{ address: "0xBEEFA7B88064FeEF0cEe02AAeBBd95D30df3878F", chain: { id: 8453 }, state: { netApy: 0.0559, totalAssetsUsd: 8e5 } }] },
          vaultV2s: { items: [{ address: "0xbeef0016cb2Fd5C352ea7CA08a9f54739DFa7298", chain: { id: 5042 }, netApy: 0.023, totalAssetsUsd: 5e6 }] },
        },
      });
    }
    if (url.includes("kamino")) return new Response("down", { status: 503 });
    if (url.includes("pendle")) return Response.json({ impliedApy: 0.05011, liquidity: { usd: 2e7 } });
    throw new Error(`unexpected ${url}`);
  };
  const rows = await fetchStrategyRates(fetcher, venues, new Date("2026-10-10T12:00:00Z"));
  const byKey = new Map(rows.map((r) => [`${r.chain}:${r.venueId}`, r]));
  assert.equal(byKey.get("ethereum:aave")?.baseApy, 4.3);
  assert.equal(byKey.get("ethereum:aave")?.rewardApy, 1.1);
  assert.equal(byKey.get("base:morpho-steakhouse-hy-usdc")?.baseApy, 5.59);
  assert.equal(byKey.get("arc:morpho-steakhouse-usdc")?.baseApy, 2.3);
  assert.equal(byKey.get("ethereum:pendle-pt-susde")?.baseApy, 5.011);
  assert.equal(byKey.has("solana:kamino"), false);
  assert.ok(calls.some((u) => u.includes("/v1/1/markets/0x47ad2cd1dd15739a7a035b9d3b7828d916fef77e")));

  const row = toStrategyRateRow(byKey.get("ethereum:aave")!);
  assert.deepEqual(fromStrategyRateRow({ ...row, base_apy: "4.3" }), byKey.get("ethereum:aave"));
});

test("applyLiveRates uses the mainnet reference rate on testnet and ranks best first", () => {
  const opps = [
    { protocolId: "aave", programId: "0xA", apyBps: 450, riskScore: 16, assetClass: "stablecoin" as const, liquid: true, source: "testnet-rate:aave-v3" },
    { protocolId: "compound", programId: "0xC", apyBps: 420, riskScore: 18, assetClass: "stablecoin" as const, liquid: true, source: "testnet-rate:compound-v3" },
    { protocolId: "cctp", programId: "0xB", apyBps: 414, riskScore: 28, assetClass: "stablecoin" as const, liquid: true, source: "testnet-rate:cctp" },
  ];
  const out = applyLiveRates(opps, "ethereum", 11155111, [
    rate("aave", "ethereum", 3.9, 3.8),
    rate("compound", "ethereum", 7.5, 4.6),
    rate("aave", "base", 9),
  ]);
  assert.deepEqual(out.map((o) => o.protocolId), ["compound", "cctp", "aave"]);
  assert.equal(out.find((o) => o.protocolId === "compound")?.apyBps, 460);
  assert.equal(out.find((o) => o.protocolId === "aave")?.apyBps, 390);
  assert.match(out.find((o) => o.protocolId === "aave")!.source, /^mainnet-reference-rate:/);
  assert.equal(out.find((o) => o.protocolId === "cctp")?.source, "testnet-rate:cctp");

  const solana = applyLiveRates(
    [{ protocolId: "kamino", programId: "K", apyBps: 640, riskScore: 18, assetClass: "stablecoin" as const, liquid: true, source: "builtin:kamino" }],
    "solana",
    null,
    [rate("kamino", "solana", 4.55)],
  );
  assert.equal(solana[0].apyBps, 455);
  assert.match(solana[0].source, /^live-rate:/);
});
