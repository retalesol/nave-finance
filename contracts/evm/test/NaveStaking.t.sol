// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

import {WrappedNave} from "../src/WrappedNave.sol";
import {NaveStaking} from "../src/NaveStaking.sol";
import {NaveErrors} from "../src/libraries/NaveErrors.sol";
import {ReentrantStakeToken} from "./mocks/ReentrantStakeToken.sol";
import {TestProxies} from "./helpers/TestProxies.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

contract NaveStakingTest is Test {
    WrappedNave internal token;
    NaveStaking internal staking;

    address internal owner = makeAddr("owner");
    address internal minter = makeAddr("minter");
    address internal rewarder = makeAddr("rewarder");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    /// Default rolling drip window (matches the contract default).
    uint256 internal constant RD = 365 days; // 31_536_000 seconds

    function setUp() public {
        token = TestProxies.deployWrappedNave("Wrapped NAVE", "NAVE", 6, owner, minter);
        staking = TestProxies.deployStaking(address(token), owner, rewarder);

        vm.startPrank(minter);
        token.mint(alice, 1_000_000_000);
        token.mint(bob, 1_000_000_000);
        token.mint(rewarder, 1_000_000_000);
        vm.stopPrank();

        // Start from a non-zero, stable timestamp so warp math is unambiguous.
        vm.warp(1_000_000);
    }

    function _stake(address who, uint256 amount) internal {
        vm.startPrank(who);
        token.approve(address(staking), amount);
        staking.stake(amount);
        vm.stopPrank();
    }

    function _notify(uint256 amount) internal {
        vm.startPrank(rewarder);
        token.approve(address(staking), amount);
        staking.notifyReward(amount);
        vm.stopPrank();
    }

    function test_stakeAndUnstake() public {
        _stake(alice, 10_000_000);
        (uint256 amount,,) = staking.users(alice);
        assertEq(amount, 10_000_000);
        assertEq(staking.totalStaked(), 10_000_000);

        vm.prank(alice);
        staking.unstake(4_000_000);
        (amount,,) = staking.users(alice);
        assertEq(amount, 6_000_000);
        assertEq(staking.totalStaked(), 6_000_000);
    }

    function test_defaultRewardsDuration() public view {
        assertEq(staking.rewardsDuration(), RD);
    }

    // ── Drip over time ─────────────────────────────────────────────────────

    /// A notified reward is not instantly claimable; it drips over the window
    /// and is fully paid out only after `rewardsDuration` elapses.
    function test_dripAccruesOverTime() public {
        _stake(alice, 10_000_000);

        // rate = RD / RD = 1 token/sec; drips exactly RD tokens over the window.
        _notify(RD);
        assertEq(staking.rewardRate(), 1);
        assertEq(staking.periodFinish(), block.timestamp + RD);

        // Nothing has elapsed yet -> nothing pending.
        assertEq(staking.pendingReward(alice), 0);

        // Halfway through the window -> half the emission.
        vm.warp(block.timestamp + RD / 2);
        assertEq(staking.pendingReward(alice), RD / 2);

        // End of the window -> full emission, and it stops (no over-drip).
        vm.warp(block.timestamp + RD);
        assertEq(staking.pendingReward(alice), RD);
    }

    /// The `pendingReward` view must equal what a `claim` actually pays.
    function test_pendingRewardMatchesClaim() public {
        _stake(alice, 10_000_000);
        _notify(RD);

        vm.warp(block.timestamp + RD / 3);
        uint256 quoted = staking.pendingReward(alice);
        assertGt(quoted, 0);

        uint256 beforeBal = token.balanceOf(alice);
        vm.prank(alice);
        staking.claim();
        assertEq(token.balanceOf(alice) - beforeBal, quoted);
        assertEq(staking.pendingReward(alice), 0);
    }

    /// Claim never pays beyond the solvency cap (balance - totalStaked).
    function test_claimSolvencyCapped() public {
        _stake(alice, 10_000_000);
        _notify(RD);
        vm.warp(block.timestamp + 2 * RD); // fully dripped

        // Only RD reward tokens were ever funded; principal stays untouched.
        vm.prank(alice);
        staking.claim();
        assertEq(token.balanceOf(address(staking)), 10_000_000); // just principal
        assertEq(staking.totalStaked(), 10_000_000);
    }

    // ── Rolling-window reset on a second notify ────────────────────────────

    /// A second notify mid-window folds the undripped leftover into a fresh
    /// full-length window (Synthetix rolling reset).
    function test_rollingWindowReset() public {
        _stake(alice, 10_000_000);

        // rate = 2*RD / RD = 2 tokens/sec.
        _notify(2 * RD);
        assertEq(staking.rewardRate(), 2);

        // Halfway: RD dripped, RD leftover (2 * RD/2).
        vm.warp(block.timestamp + RD / 2);
        assertEq(staking.pendingReward(alice), RD); // 2 * (RD/2)

        uint256 resetAt = block.timestamp;
        // Second notify of 2*RD: leftover(RD) + 2*RD = 3*RD over RD -> rate 3.
        _notify(2 * RD);
        assertEq(staking.rewardRate(), 3);
        assertEq(staking.periodFinish(), resetAt + RD);

        // Run the fresh window to completion.
        vm.warp(block.timestamp + RD);

        // Total emitted == everything funded: RD (first half) + 3*RD = 4*RD,
        // which is exactly the 2 * (2*RD) that was notified.
        assertEq(staking.pendingReward(alice), 4 * RD);
    }

    // ── Pro-rata correctness across two stakers ────────────────────────────

    function test_proRataAcrossTwoStakers() public {
        _stake(alice, 30_000_000); // 75%
        _stake(bob, 10_000_000); // 25%

        _notify(RD); // drips RD over the full window

        vm.warp(block.timestamp + RD); // fully elapsed

        assertEq(staking.pendingReward(alice), (RD * 3) / 4); // 75%
        assertEq(staking.pendingReward(bob), RD / 4); // 25%

        // The two shares add up to the full emission (no dust lost here).
        assertEq(staking.pendingReward(alice) + staking.pendingReward(bob), RD);

        uint256 beforeAlice = token.balanceOf(alice);
        vm.prank(alice);
        staking.claim();
        assertEq(token.balanceOf(alice) - beforeAlice, (RD * 3) / 4);
        assertEq(staking.pendingReward(alice), 0);
    }

    /// A staker who enters after the window has fully dripped earns nothing
    /// from the already-elapsed emission.
    function test_lateStakerDoesNotStealPastRewards() public {
        _stake(alice, 10_000_000);
        _notify(RD);
        vm.warp(block.timestamp + RD); // fully dripped to alice

        _stake(bob, 10_000_000); // enters after the window closed
        assertEq(staking.pendingReward(alice), RD);
        assertEq(staking.pendingReward(bob), 0);
    }

    // ── Access control / guards ────────────────────────────────────────────

    function test_notifyReward_onlyRewarder() public {
        _stake(alice, 10_000_000);
        vm.prank(alice);
        vm.expectRevert(NaveErrors.Unauthorized.selector);
        staking.notifyReward(1_000_000);
    }

    function test_notifyReward_noStakersReverts() public {
        vm.startPrank(rewarder);
        token.approve(address(staking), 1_000_000);
        vm.expectRevert(NaveErrors.InsufficientVaultBalance.selector);
        staking.notifyReward(1_000_000);
        vm.stopPrank();
    }

    function test_pauseBlocksStakeButNotUnstake() public {
        _stake(alice, 10_000_000);
        vm.prank(owner);
        staking.setPaused(true);

        vm.startPrank(alice);
        token.approve(address(staking), 1_000_000);
        vm.expectRevert(NaveErrors.BridgePaused.selector);
        staking.stake(1_000_000);
        // Unstake still works while paused.
        staking.unstake(1_000_000);
        vm.stopPrank();
    }

    // ── setRewardsDuration ─────────────────────────────────────────────────

    function test_setRewardsDuration_betweenWindows() public {
        // No active window yet (periodFinish == 0) -> owner may set.
        vm.prank(owner);
        staking.setRewardsDuration(30 days);
        assertEq(staking.rewardsDuration(), 30 days);
    }

    function test_setRewardsDuration_revertsWhileActive() public {
        _stake(alice, 10_000_000);
        _notify(RD); // opens a window ending at now + RD

        vm.prank(owner);
        vm.expectRevert(NaveErrors.InvalidStateTransition.selector);
        staking.setRewardsDuration(60 days);

        // Once the window fully elapses, the change is allowed.
        vm.warp(block.timestamp + RD);
        vm.prank(owner);
        staking.setRewardsDuration(60 days);
        assertEq(staking.rewardsDuration(), 60 days);
    }

    function test_setRewardsDuration_onlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, alice));
        staking.setRewardsDuration(30 days);
    }

    function test_setRewardsDuration_zeroReverts() public {
        vm.prank(owner);
        vm.expectRevert(NaveErrors.ZeroAmount.selector);
        staking.setRewardsDuration(0);
    }

    // ── Claim-while-paused revert ───────────────────────────────────────────

    /// Claim is a privileged withdrawal of rewards and is blocked while paused
    /// (unlike unstake, which must always be available). Pin the revert so a
    /// future refactor cannot silently open reward drains during an incident.
    function test_claim_revertsWhilePaused() public {
        _stake(alice, 10_000_000);
        _notify(RD);
        vm.warp(block.timestamp + RD / 2); // rewards have accrued

        assertGt(staking.pendingReward(alice), 0);

        vm.prank(owner);
        staking.setPaused(true);

        vm.prank(alice);
        vm.expectRevert(NaveErrors.BridgePaused.selector);
        staking.claim();

        // Unstake still exits while paused, and once unpaused claim works again.
        vm.prank(alice);
        staking.unstake(1_000_000);

        vm.prank(owner);
        staking.setPaused(false);
        vm.prank(alice);
        staking.claim();
        assertEq(staking.pendingReward(alice), 0);
    }

    // ── setRewarder / two-step ownership ────────────────────────────────────

    function test_setRewarder_onlyOwner_andRotationMovesTheGate() public {
        _stake(alice, 10_000_000);

        // Non-owner cannot rotate the rewarder.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, alice));
        staking.setRewarder(alice);

        // Zero address is guarded.
        vm.prank(owner);
        vm.expectRevert(NaveErrors.ZeroAddress.selector);
        staking.setRewarder(address(0));

        // Owner rotates to bob; the OLD rewarder immediately loses notify rights.
        vm.prank(owner);
        staking.setRewarder(bob);
        assertEq(staking.rewarder(), bob);

        vm.startPrank(rewarder);
        token.approve(address(staking), 1_000_000);
        vm.expectRevert(NaveErrors.Unauthorized.selector);
        staking.notifyReward(1_000_000);
        vm.stopPrank();

        // The new rewarder can notify.
        vm.prank(minter);
        token.mint(bob, 1_000_000);
        vm.startPrank(bob);
        token.approve(address(staking), 1_000_000);
        staking.notifyReward(1_000_000);
        vm.stopPrank();
    }

    // ── Privileged roles must be distinct keys (pre-redeploy hardening) ─────
    function test_initialize_rewarderEqualsOwnerReverts() public {
        NaveStaking impl = new NaveStaking();
        vm.expectRevert(NaveErrors.PrivilegedRolesMustDiffer.selector);
        new ERC1967Proxy(
            address(impl), abi.encodeCall(NaveStaking.initialize, (address(token), owner, owner))
        );
    }

    function test_setRewarder_cannotBeOwnerOrPendingOwner() public {
        vm.prank(owner);
        vm.expectRevert(NaveErrors.PrivilegedRolesMustDiffer.selector);
        staking.setRewarder(owner);

        vm.prank(owner);
        staking.transferOwnership(bob); // bob is pendingOwner
        vm.prank(owner);
        vm.expectRevert(NaveErrors.PrivilegedRolesMustDiffer.selector);
        staking.setRewarder(bob);
    }

    function test_transferOwnership_cannotTargetRewarder() public {
        vm.prank(owner);
        vm.expectRevert(NaveErrors.PrivilegedRolesMustDiffer.selector);
        staking.transferOwnership(rewarder);
        assertEq(staking.pendingOwner(), address(0));
    }

    function test_twoStepOwnership_proposeThenAccept() public {
        vm.prank(owner);
        staking.transferOwnership(bob);
        // Not transferred until accepted.
        assertEq(staking.owner(), owner);

        // A non-pending caller cannot claim ownership.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, alice));
        staking.acceptOwnership();

        vm.prank(bob);
        staking.acceptOwnership();
        assertEq(staking.owner(), bob);

        // Old owner loses admin rights.
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, owner));
        staking.setPaused(true);
    }

    function test_transferOwnership_zeroCancelsPending_andOnlyOwner() public {
        vm.prank(owner);
        staking.transferOwnership(bob);
        assertEq(staking.pendingOwner(), bob);

        // Ownable2Step: address(0) cancels a pending transfer (does not renounce).
        vm.prank(owner);
        staking.transferOwnership(address(0));
        assertEq(staking.pendingOwner(), address(0));
        assertEq(staking.owner(), owner);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, alice));
        staking.transferOwnership(alice);
    }

    // ── Reentrancy (nonReentrant) with a hostile hook token ─────────────────

    function _seedEvilStaking() internal returns (ReentrantStakeToken evil, NaveStaking evilStaking) {
        evil = new ReentrantStakeToken();
        evilStaking = TestProxies.deployStaking(address(evil), owner, rewarder);
        evil.setStaking(address(evilStaking));
        evil.mint(alice, 100_000_000);
        evil.mint(rewarder, 100_000_000);

        vm.startPrank(alice);
        evil.approve(address(evilStaking), 100_000_000);
        evilStaking.stake(50_000_000);
        vm.stopPrank();

        vm.startPrank(rewarder);
        evil.approve(address(evilStaking), 100_000_000);
        evilStaking.notifyReward(RD); // rate 1/sec, plenty of headroom
        vm.stopPrank();

        vm.warp(block.timestamp + RD / 2); // accrue claimable rewards
    }

    /// A reward token with an ERC-777-style transfer hook that re-enters
    /// `claim()` during payout is stopped by `nonReentrant`: the re-entrant call
    /// reverts, so the pool cannot be looped/drained.
    function test_reentrancy_claimIsGuarded() public {
        (ReentrantStakeToken evil, NaveStaking evilStaking) = _seedEvilStaking();

        evil.arm(0, 0); // re-enter claim() on the payout transfer
        uint256 beforeBal = evil.balanceOf(alice);
        vm.prank(alice);
        evilStaking.claim();

        assertTrue(evil.reentrantReverted(), "re-entrant claim rejected by nonReentrant");
        // Exactly one payout happened (no double claim via reentry).
        assertGt(evil.balanceOf(alice), beforeBal);
        assertEq(evilStaking.pendingReward(alice), 0);
    }

    /// The same guard protects `unstake` against a re-entrant principal loop.
    function test_reentrancy_unstakeIsGuarded() public {
        (ReentrantStakeToken evil, NaveStaking evilStaking) = _seedEvilStaking();

        evil.arm(1, 10_000_000); // re-enter unstake() on the principal return
        vm.prank(alice);
        evilStaking.unstake(10_000_000);

        assertTrue(evil.reentrantReverted(), "re-entrant unstake rejected by nonReentrant");
        (uint256 amount,,) = evilStaking.users(alice);
        // Only the outer unstake reduced the principal (50 - 10 = 40).
        assertEq(amount, 40_000_000);
        assertEq(evilStaking.totalStaked(), 40_000_000);
    }

    // ── rewardRate truncation dust ──────────────────────────────────────────

    /// notifyReward computes `rewardRate = (amount + leftover) / rewardsDuration`
    /// with integer division, so `amount % rewardsDuration` base units never
    /// drip and are left undistributed in the contract until a later notify
    /// folds them into `leftover`. This asserts the exact truncation dust and
    /// bounds it below `rewardsDuration` base units (~31.536 NAVE at 6 decimals
    /// for the 365-day default). Never previously asserted (audit finding).
    function test_rewardRate_truncationDustIsBoundedAndStranded() public {
        _stake(alice, 10_000_000);

        // Choose an amount deliberately indivisible by the window length.
        uint256 amount = 3 * RD + 12_345; // rate floors to 3 tokens/sec
        _notify(amount);

        assertEq(staking.rewardRate(), 3, "rate truncates toward zero");

        uint256 dripPerWindow = staking.rewardRate() * RD; // 3 * RD
        uint256 dust = amount - dripPerWindow; // undripped remainder
        assertEq(dust, 12_345, "exact truncation dust");
        assertLt(dust, RD, "dust strictly below one window of base units (~31.536 NAVE)");

        // Run the entire window: total paid equals rate*RD, NOT `amount`.
        vm.warp(block.timestamp + RD);
        assertEq(staking.pendingReward(alice), dripPerWindow, "only rate*RD ever drips");

        uint256 beforeBal = token.balanceOf(alice);
        vm.prank(alice);
        staking.claim();
        assertEq(token.balanceOf(alice) - beforeBal, dripPerWindow);

        // The dust remains in the contract above the (untouched) principal —
        // it is not lost, and (audit remediation) is now recoverable by the
        // owner via {sweepDust} once the window has elapsed.
        uint256 rewardResidue = token.balanceOf(address(staking)) - staking.totalStaked();
        assertEq(rewardResidue, dust, "truncation dust retained, not lost");

        // Window has fully elapsed above (warped +RD) so the owner can sweep the
        // dust. Alice already claimed, so no owed rewards remain.
        uint256 ownerBefore = token.balanceOf(owner);
        vm.prank(owner);
        uint256 swept = staking.sweepDust(owner);
        assertEq(swept, dust, "sweepDust recovers exactly the truncation dust");
        assertEq(token.balanceOf(owner) - ownerBefore, dust);
        assertEq(token.balanceOf(address(staking)), staking.totalStaked(), "only principal remains");
    }

    /// FINDING (low, EVM/Solana asymmetry): on EVM, `notifyReward` derives the
    /// next rate from the PASSED `amount` plus a rate-derived `leftover` — it
    /// never reads the contract's token balance. So truncation dust from a prior
    /// notify is NOT folded into a later window by `notifyReward` itself. This
    /// contrasts with the Solana pool, whose `roll_in_new_rewards` measures the
    /// actual vault balance delta and recaptures the dust on the next inflow.
    /// This test pins that `notifyReward` alone does not recapture the dust; the
    /// EVM remediation is the owner {sweepDust} path (asserted at the end).
    function test_rewardRate_dustNotRecapturedByNotifyButSweepable() public {
        uint256 t0 = block.timestamp;
        _stake(alice, 10_000_000);
        _notify(3 * RD + 12_345); // window 1 ends at t0 + RD
        vm.warp(t0 + RD); // first window fully elapsed, dust stranded

        vm.prank(alice);
        staking.claim(); // sweep the dripped portion (3*RD)

        uint256 strandedBefore = token.balanceOf(address(staking)) - staking.totalStaked();
        assertEq(strandedBefore, 12_345);

        // A fresh, evenly-divisible notify: rate = RD/RD = 1, drips exactly RD.
        _notify(RD); // opens window 2 at t0 + RD, ending at t0 + 2*RD
        vm.warp(t0 + 2 * RD);

        // Alice's claimable is exactly the new window's emission — the old dust
        // is NOT added because the rate ignores the residual balance.
        assertEq(staking.pendingReward(alice), RD, "new window only; dust excluded from rate");

        uint256 beforeBal = token.balanceOf(alice);
        vm.prank(alice);
        staking.claim();
        assertEq(token.balanceOf(alice) - beforeBal, RD, "dust not paid out by notify/claim");

        // notifyReward did not recapture the dust; it still sits in the contract.
        uint256 strandedAfter = token.balanceOf(address(staking)) - staking.totalStaked();
        assertEq(strandedAfter, 12_345, "notifyReward alone leaves the dust");

        // Remediation: the owner sweeps it now that window 2 has elapsed and
        // Alice has claimed everything owed.
        vm.prank(owner);
        uint256 swept = staking.sweepDust(owner);
        assertEq(swept, 12_345, "sweepDust recovers the previously-stranded dust");
        assertEq(token.balanceOf(address(staking)), staking.totalStaked(), "only principal remains");
    }

    // ── sweepDust guards ────────────────────────────────────────────────────

    function test_sweepDust_onlyOwner() public {
        _stake(alice, 10_000_000);
        _notify(3 * RD + 12_345);
        vm.warp(block.timestamp + RD);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, alice));
        staking.sweepDust(alice);
    }

    function test_sweepDust_revertsWhileWindowActive() public {
        _stake(alice, 10_000_000);
        _notify(3 * RD + 12_345);
        // Mid-window: sweeping is disallowed so a live drip is never disturbed.
        vm.warp(block.timestamp + RD / 2);
        vm.prank(owner);
        vm.expectRevert(NaveErrors.InvalidStateTransition.selector);
        staking.sweepDust(owner);
    }

    function test_sweepDust_revertsWhenNothingToSweep() public {
        // Evenly-divisible amount → no truncation dust; nothing to sweep after
        // all rewards are claimed.
        _stake(alice, 10_000_000);
        _notify(RD); // rate = 1, no remainder
        vm.warp(block.timestamp + RD);
        vm.prank(alice);
        staking.claim();
        vm.prank(owner);
        vm.expectRevert(NaveErrors.ZeroAmount.selector);
        staking.sweepDust(owner);
    }

    function test_sweepDust_neverTouchesUnclaimedRewards() public {
        // Alice does NOT claim; her earned rewards must remain claimable after a
        // sweep — only the truncation dust is removed.
        _stake(alice, 10_000_000);
        _notify(3 * RD + 12_345);
        vm.warp(block.timestamp + RD);

        uint256 owed = staking.pendingReward(alice); // == 3 * RD
        assertEq(owed, 3 * RD);

        vm.prank(owner);
        uint256 swept = staking.sweepDust(owner);
        assertEq(swept, 12_345, "only the dust is swept, not owed rewards");

        // Alice can still claim her full earned rewards after the sweep.
        uint256 beforeBal = token.balanceOf(alice);
        vm.prank(alice);
        staking.claim();
        assertEq(token.balanceOf(alice) - beforeBal, owed, "owed rewards intact after sweep");
    }
}
