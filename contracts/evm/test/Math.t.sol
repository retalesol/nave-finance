// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {FeeMath} from "../src/libraries/FeeMath.sol";
import {OracleMath} from "../src/libraries/OracleMath.sol";
import {BpsGates} from "../src/libraries/BpsGates.sol";
import {NaveErrors} from "../src/libraries/NaveErrors.sol";

/// @notice External wrapper so `vm.expectRevert` can catch reverts from the
/// inlined internal library functions (which otherwise revert at cheatcode depth).
contract MathHarness {
    function valueUsd(uint256 b, uint8 d, int64 p, int32 e) external pure returns (uint256) {
        return OracleMath.valueUsd(b, d, p, e);
    }

    function allocationCap(uint256 nav, uint16 bps, uint256 deployed, uint256 amount)
        external
        pure
    {
        BpsGates.enforceAllocationCap(nav, bps, deployed, amount);
    }

    function globalLimits(
        uint256 nav,
        uint256 deployed,
        uint256 amount,
        uint16 maxDep,
        uint16 minLiq
    ) external pure {
        BpsGates.enforceGlobalLimits(nav, deployed, amount, maxDep, minLiq);
    }

    function stablecoinReserve(uint256 nav, uint16 bps, bool isStable, uint256 idleAfter)
        external
        pure
    {
        BpsGates.enforceStablecoinReserve(nav, bps, isStable, idleAfter);
    }
}

/// @notice Ports the Solana off-chain / Rust unit-test assertions for fee,
/// oracle, and bps-gate math to Foundry, locking in cross-chain parity.
contract MathTest is Test {
    MathHarness internal h;

    function setUp() public {
        h = new MathHarness();
    }

    // ───── performance fee: 8.5% (850 bps) of realized yield ─────────────────
    function test_perfSkim_taxesOnlyGainNotPrincipal() public pure {
        (uint256 gain, uint256 fee) = FeeMath.calculatePerformanceSkim(1100, 1000, 1100, 850);
        assertEq(gain, 100);
        assertEq(fee, 8);
    }

    function test_perfSkim_zeroWhenNoYield() public pure {
        (uint256 g1, uint256 f1) = FeeMath.calculatePerformanceSkim(1000, 1000, 1000, 850);
        assertEq(g1, 0);
        assertEq(f1, 0);
        (uint256 g2, uint256 f2) = FeeMath.calculatePerformanceSkim(900, 1000, 900, 850);
        assertEq(g2, 0);
        assertEq(f2, 0);
    }

    function test_perfSkim_zeroWhenBpsOrAmountZero() public pure {
        (uint256 g1, uint256 f1) = FeeMath.calculatePerformanceSkim(1100, 1000, 1100, 0);
        assertEq(g1 | f1, 0);
        (uint256 g2, uint256 f2) = FeeMath.calculatePerformanceSkim(0, 1000, 1100, 850);
        assertEq(g2 | f2, 0);
    }

    function test_perfSkim_proportionalOnPartialWithdrawal() public pure {
        (uint256 gain, uint256 fee) = FeeMath.calculatePerformanceSkim(600, 1000, 1200, 850);
        assertEq(gain, 100);
        assertEq(fee, 8);
    }

    function test_perfSkim_multiTrancheSumsToFullGain() public pure {
        (uint256 gA, uint256 fA) = FeeMath.calculatePerformanceSkim(600, 1000, 1200, 850);
        (uint256 gB, uint256 fB) = FeeMath.calculatePerformanceSkim(600, 500, 600, 850);
        assertEq(gA + gB, 200);
        assertEq(fA + fB, 16);
    }

    function test_perfSkim_fullRateTakesEntireGain() public pure {
        (uint256 gain, uint256 fee) = FeeMath.calculatePerformanceSkim(1100, 1000, 1100, 10_000);
        assertEq(gain, 100);
        assertEq(fee, 100);
    }

    function test_perfSkim_pureYieldPosition() public pure {
        (uint256 gain, uint256 fee) = FeeMath.calculatePerformanceSkim(500, 0, 500, 850);
        assertEq(gain, 500);
        assertEq(fee, 42);
    }

    // ───── management fee: discrete annual 0.65% (65 bps) ────────────────────
    function test_mgmtFee_notDueBeforeYear() public pure {
        uint256 anchor = FeeMath.floorToUtcMidnight(1_700_000_000);
        assertFalse(FeeMath.managementFeeDue(anchor, anchor));
        assertFalse(FeeMath.managementFeeDue(anchor, anchor + 365 * 86_400 - 1));
    }

    function test_mgmtFee_dueExactlyAtOneYear() public pure {
        uint256 anchor = FeeMath.floorToUtcMidnight(1_700_000_000);
        assertTrue(FeeMath.managementFeeDue(anchor, anchor + 365 * 86_400));
        assertTrue(FeeMath.managementFeeDue(anchor, anchor + 365 * 86_400 + 86_400));
    }

    function test_mgmtFee_is65BpsOfBalance() public pure {
        assertEq(FeeMath.annualManagementFee(1_000_000, 65), 6500);
        assertEq(FeeMath.annualManagementFee(2_000_000, 65), 13_000);
        assertEq(FeeMath.annualManagementFee(500_000_000, 65), 3_250_000);
        assertEq(FeeMath.annualManagementFee(0, 65), 0);
        assertEq(FeeMath.annualManagementFee(1_000_000, 0), 0);
    }

    function test_floorToUtcMidnight_idempotent() public pure {
        uint256 m = FeeMath.floorToUtcMidnight(1_700_050_000);
        assertEq(m % 86_400, 0);
        assertEq(FeeMath.floorToUtcMidnight(m), m);
    }

    // ───── revised NE-8 withdraw cap ─────────────────────────────────────────
    function test_withdrawCap_principalWhenNoGain() public pure {
        assertEq(FeeMath.realizedYieldWithdrawCap(100, 100, 100), 100);
        assertEq(FeeMath.realizedYieldWithdrawCap(100, 100, 90), 100); // drawdown saturates
        assertEq(FeeMath.realizedYieldWithdrawCap(100, 0, 0), 100); // unreadable position
    }

    function test_withdrawCap_admitsMarkedGain() public pure {
        assertEq(FeeMath.realizedYieldWithdrawCap(100, 100, 110), 110);
    }

    // ───── oracle valuation (value_usd / value_stable / confidence) ──────────
    function test_valueUsd_solAt150() public pure {
        // 1 SOL (9 decimals) at $150 with expo -8 => $150.000000 micro-USD.
        uint256 micro = OracleMath.valueUsd(1_000_000_000, 9, 15_000_000_000, -8);
        assertEq(micro, 150_000_000);
    }

    function test_valueStable_decimals() public pure {
        assertEq(OracleMath.valueStable(1_000_000, 6), 1_000_000);
        assertEq(OracleMath.valueStable(1_234_560_000, 6), 1_234_560_000);
        assertEq(OracleMath.valueStable(100_000_000, 8), 1_000_000);
    }

    function test_valueUsd_rejectsNonPositivePrice() public {
        vm.expectRevert(NaveErrors.InvalidOraclePrice.selector);
        h.valueUsd(1, 9, 0, -8);
    }

    function test_confidence_acceptsTightRejectsWide() public pure {
        int64 price = 15_000_000_000;
        assertTrue(OracleMath.confidenceWithinBounds(price, uint64(uint256(int256(price)) / 100))); // 1%
        assertTrue(
            OracleMath.confidenceWithinBounds(price, uint64(uint256(int256(price)) * 200 / 10_000))
        ); // 2% boundary
        assertFalse(
            OracleMath.confidenceWithinBounds(price, uint64(uint256(int256(price)) * 300 / 10_000))
        ); // 3%
        assertFalse(OracleMath.confidenceWithinBounds(0, 0));
        assertFalse(OracleMath.confidenceWithinBounds(-1, 0));
    }

    // ───── bps gates ─────────────────────────────────────────────────────────
    function test_allocationCap_singleAndCumulative() public pure {
        // nav 1000, 50% cap => 500.
        BpsGates.enforceAllocationCap(1000, 5000, 0, 400);
        BpsGates.enforceAllocationCap(1000, 5000, 0, 500);
        BpsGates.enforceAllocationCap(1000, 5000, 400, 100);
    }

    function test_allocationCap_cumulativeOverflowReverts() public {
        vm.expectRevert(NaveErrors.AllocationLimitExceeded.selector);
        h.allocationCap(1000, 5000, 400, 200);
    }

    function test_globalLimits_deploymentCap() public {
        BpsGates.enforceGlobalLimits(1000, 0, 500, 5000, 0);
        vm.expectRevert(NaveErrors.DeploymentCapExceeded.selector);
        h.globalLimits(1000, 0, 501, 5000, 0);
    }

    function test_globalLimits_liquidityFloor() public {
        BpsGates.enforceGlobalLimits(1000, 0, 800, 0, 2000); // 20% liquid => deploy <= 80%
        vm.expectRevert(NaveErrors.LiquidityFloorBreached.selector);
        h.globalLimits(1000, 0, 801, 0, 2000);
    }

    function test_stablecoinReserve() public {
        // nav 1000, 35% reserve => need 350 idle stable USD remaining.
        BpsGates.enforceStablecoinReserve(1000, 3500, true, 350);
        vm.expectRevert(NaveErrors.StablecoinReserveBreached.selector);
        h.stablecoinReserve(1000, 3500, true, 349);
        // non-stable asset: no-op.
        BpsGates.enforceStablecoinReserve(1000, 3500, false, 0);
    }

    function test_effectiveMaxDeployedBps() public pure {
        assertEq(BpsGates.effectiveMaxDeployedBps(5000, 2000), 5000); // cap tighter
        assertEq(BpsGates.effectiveMaxDeployedBps(0, 2000), 8000); // liquidity-implied
    }
}
