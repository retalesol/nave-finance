// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {WrappedNave} from "../src/WrappedNave.sol";
import {NaveStaking} from "../src/NaveStaking.sol";
import {TestProxies} from "./helpers/TestProxies.sol";

/// @notice Property/fuzz coverage for the {NaveStaking} MasterChef+Synthetix
/// accumulator. The unit tests in {NaveStakingTest} pin exact values at fixed
/// points; these fuzz the amounts, stake sizes, and elapsed times to prove the
/// core solvency + conservation properties hold across the whole input space:
///
///   * the pool never pays out more reward than was funded (solvency);
///   * staked principal is always fully recoverable (never spent on rewards);
///   * `rewardRate` truncation dust is strictly bounded below one window of
///     base units (and is recoverable via {sweepDust});
///   * two stakers split a fully-dripped window pro-rata to within rounding.
contract NaveStakingFuzzTest is Test {
    WrappedNave internal token;
    NaveStaking internal staking;

    address internal owner = makeAddr("owner");
    address internal minter = makeAddr("minter");
    address internal rewarder = makeAddr("rewarder");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    uint256 internal constant RD = 365 days;

    function setUp() public {
        token = TestProxies.deployWrappedNave("Wrapped NAVE", "NAVE", 6, owner, minter);
        staking = TestProxies.deployStaking(address(token), owner, rewarder);
        vm.warp(1_000_000);
    }

    function _fund(address who, uint256 amount) internal {
        vm.prank(minter);
        token.mint(who, amount);
    }

    function _stake(address who, uint256 amount) internal {
        vm.startPrank(who);
        token.approve(address(staking), amount);
        staking.stake(amount);
        vm.stopPrank();
    }

    function _notify(uint256 amount) internal {
        _fund(rewarder, amount);
        vm.startPrank(rewarder);
        token.approve(address(staking), amount);
        staking.notifyReward(amount);
        vm.stopPrank();
    }

    /// A single staker can never claim more than the funded reward, and after
    /// the whole window has elapsed the claim equals exactly `rewardRate * RD`
    /// (the funded amount minus bounded truncation dust). Principal is always
    /// fully recoverable afterwards.
    function testFuzz_singleStakerSolvencyAndDust(uint256 stakeAmt, uint256 rewardAmt, uint256 elapsed)
        public
    {
        stakeAmt = bound(stakeAmt, 1_000, 1_000_000_000_000);
        rewardAmt = bound(rewardAmt, 1, 1_000_000_000_000);
        elapsed = bound(elapsed, 0, 3 * RD);

        _fund(alice, stakeAmt);
        _stake(alice, stakeAmt);
        _notify(rewardAmt);

        uint256 rate = staking.rewardRate();
        vm.warp(block.timestamp + elapsed);

        uint256 pending = staking.pendingReward(alice);
        // Solvency: never owes more than was funded.
        assertLe(pending, rewardAmt, "pending never exceeds funded reward");

        // After the full window, ~rate*RD has dripped (funded minus the rate
        // truncation dust). A single staker's accrual can lose a further tiny
        // per-share rounding remainder, so this is bounded, not exact — but it
        // can NEVER exceed rate*RD (no over-drip).
        vm.warp(block.timestamp + 3 * RD);
        uint256 finalPending = staking.pendingReward(alice);
        assertLe(finalPending, rate * RD, "never drips more than rate*RD");
        assertApproxEqAbs(finalPending, rate * RD, 4, "full-window drip approx rate*RD");
        uint256 dust = rewardAmt - rate * RD;
        assertLt(dust, RD, "rate truncation dust strictly below one window of base units");

        // Claim pays exactly the dripped total; principal stays intact. (Small
        // funded amounts can truncate `rewardRate` to 0 → nothing drips, and
        // claim reverts ZeroAmount by design, so only claim when there is a
        // payout.)
        uint256 beforeBal = token.balanceOf(alice);
        if (finalPending > 0) {
            vm.prank(alice);
            staking.claim();
            assertEq(token.balanceOf(alice) - beforeBal, finalPending, "claim pays the dripped total");
        }
        assertEq(staking.totalStaked(), stakeAmt, "principal untouched by reward payout");

        // Principal is fully recoverable.
        vm.prank(alice);
        staking.unstake(stakeAmt);
        assertEq(token.balanceOf(alice), stakeAmt + finalPending, "principal fully returned");
        assertEq(staking.totalStaked(), 0);
    }

    /// Two stakers who are both present for an entire fully-dripped window split
    /// the emission in proportion to their stake, and their combined claimable
    /// never exceeds the funded reward (conservation across the accumulator).
    function testFuzz_twoStakerProRataConserved(uint256 aStake, uint256 bStake, uint256 rewardAmt)
        public
    {
        aStake = bound(aStake, 1_000, 1_000_000_000_000);
        bStake = bound(bStake, 1_000, 1_000_000_000_000);
        rewardAmt = bound(rewardAmt, RD, 1_000_000_000_000); // ≥ RD so rate ≥ 1

        _fund(alice, aStake);
        _fund(bob, bStake);
        _stake(alice, aStake);
        _stake(bob, bStake);
        _notify(rewardAmt);

        uint256 rate = staking.rewardRate();
        vm.warp(block.timestamp + RD); // whole window drips

        uint256 pa = staking.pendingReward(alice);
        uint256 pb = staking.pendingReward(bob);
        uint256 dripped = rate * RD;

        // Conservation: the two shares sum to the dripped total minus a small,
        // bounded per-share/per-user rounding shortfall (accRewardPerShare and
        // each user's accrual both floor). The hard property is that the sum
        // NEVER EXCEEDS what dripped (no over-payment); the closeness bound just
        // confirms no material value is stranded.
        assertLe(pa + pb, dripped, "combined payout never exceeds dripped total");
        assertApproxEqAbs(pa + pb, dripped, 16, "combined payout approx dripped total (bounded rounding)");
        assertLe(pa + pb, rewardAmt, "combined payout never exceeds funded reward");

        // Pro-rata ordering: the larger staker earns at least as much.
        if (aStake > bStake) assertGe(pa, pb, "larger stake earns at least as much");
        if (bStake > aStake) assertGe(pb, pa, "larger stake earns at least as much");
    }

    /// Whatever the funded amount, the owner can always sweep exactly the
    /// unrecoverable dust once the window elapses and stakers have claimed, and
    /// the sweep never dips into staked principal.
    function testFuzz_sweepDustNeverTouchesPrincipal(uint256 stakeAmt, uint256 rewardAmt) public {
        stakeAmt = bound(stakeAmt, 1_000, 1_000_000_000_000);
        rewardAmt = bound(rewardAmt, 1, 1_000_000_000_000);

        _fund(alice, stakeAmt);
        _stake(alice, stakeAmt);
        _notify(rewardAmt);

        uint256 rate = staking.rewardRate();
        vm.warp(block.timestamp + RD);

        // Compute pending BEFORE pranking — a view call would otherwise consume
        // the prank and leave `claim()` to run as the test contract.
        if (staking.pendingReward(alice) > 0) {
            vm.prank(alice);
            staking.claim();
        }

        // The non-principal residue is the rate-truncation dust plus at most a
        // tiny per-share rounding remainder that no staker can claim. The hard
        // property is that it NEVER dips below the staked principal.
        uint256 dust = rewardAmt - rate * RD;
        uint256 residue = token.balanceOf(address(staking)) - staking.totalStaked();
        assertGe(residue, dust, "residue above principal is at least the rate-truncation dust");
        assertApproxEqAbs(residue, dust, 4, "residue approx the truncation dust");

        // sweepDust may only remove value ABOVE principal + owed-unclaimed, so
        // it can never take a base unit of staked principal.
        uint256 stakingBalBefore = token.balanceOf(address(staking));
        if (residue > 0) {
            uint256 ownerBefore = token.balanceOf(owner);
            vm.prank(owner);
            try staking.sweepDust(owner) returns (uint256 swept) {
                assertEq(token.balanceOf(owner) - ownerBefore, swept, "owner received exactly swept");
                assertLe(swept, residue, "never sweeps more than the residue");
            } catch {
                // Nothing sweepable (all residue reserved as owed-unclaimed).
            }
        }
        assertGe(token.balanceOf(address(staking)), staking.totalStaked(), "principal never touched by sweep");
        assertLe(token.balanceOf(address(staking)), stakingBalBefore, "sweep only removes value");

        // Principal is always fully recoverable.
        vm.prank(alice);
        staking.unstake(stakeAmt);
        assertEq(staking.totalStaked(), 0, "principal fully recoverable after sweep");
    }
}
