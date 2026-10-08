import { assert } from "chai";
import {
  APY_SCENARIOS_BPS,
  allocateByCaps,
  projectTreasuryGrowth,
  rawToUsdc,
  simulateYield,
  usdcToRaw,
} from "./helpers/apy-simulator";
import { DAO_PRESETS } from "./helpers/governance-math";

describe("simulated DeFi APY (up to 12%) and treasury growth models", () => {
  it("accrues compound yield for APY scenarios up to 12%", () => {
    const principal = usdcToRaw(100_000);
    for (const apyBps of APY_SCENARIOS_BPS) {
      const yield12mo = simulateYield(principal, apyBps, 365);
      assert.isAbove(Number(yield12mo), 0);
      assert.isAtMost(Number(yield12mo) / Number(principal), 0.13);
    }
  });

  it("projects treasury NAV growth across DAO sizes and APY bands", () => {
    for (const preset of DAO_PRESETS) {
      const totalUsdc = preset.members * preset.depositPerMemberUsdc;
      const deployedUsdc = Math.floor(totalUsdc * 0.6);
      for (const apyBps of APY_SCENARIOS_BPS) {
        const snap = projectTreasuryGrowth(
          preset.label,
          totalUsdc,
          deployedUsdc,
          apyBps,
          12
        );
        assert.equal(snap.totalNavUsdc, totalUsdc + snap.simulatedYieldUsdc);
        assert.isAbove(snap.simulatedYieldUsdc, 0);
      }
    }
  });

  it("respects constitution allocation caps when splitting deployable capital", () => {
    const nav = usdcToRaw(200_000);
    const caps = [4000, 3000, 3000];
    const [kamino, jito, marginfi] = allocateByCaps(nav, caps);
    assert.equal(kamino + jito + marginfi, nav);
    assert.approximately(rawToUsdc(kamino), 80_000, 1);
    assert.approximately(rawToUsdc(jito), 60_000, 1);
    assert.approximately(rawToUsdc(marginfi), 60_000, 1);
  });

  it("models incremental monthly yield on deployed capital", () => {
    const deployed = usdcToRaw(80_000);
    let cumulative = 0n;
    for (let month = 1; month <= 12; month++) {
      cumulative += simulateYield(deployed, 800, 30);
    }
    assert.isAbove(Number(cumulative), 0);
    assert.approximately(Number(cumulative) / Number(deployed), 0.08, 0.02);
  });
});
