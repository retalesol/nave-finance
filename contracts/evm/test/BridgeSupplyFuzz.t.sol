// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {WrappedNave} from "../src/WrappedNave.sol";
import {NaveBridge} from "../src/NaveBridge.sol";
import {NaveErrors} from "../src/libraries/NaveErrors.sol";
import {TestProxies} from "./helpers/TestProxies.sol";

/// @notice Fuzz coverage for the EVM lockbox blast-radius bounds (per-tx cap,
/// rolling daily cap) and the {WrappedNave} supply cap. These are the on-chain
/// guardrails that bound a compromised relayer key (audit P1's mitigation), so
/// their boundaries are property-tested across the input space rather than only
/// at hand-picked points.
contract BridgeSupplyFuzzTest is Test {
    WrappedNave internal token;
    NaveBridge internal bridge;

    address internal owner = makeAddr("owner");
    address internal relayer = makeAddr("relayer");
    address internal alice = makeAddr("alice");

    uint64 internal constant SOL_CHAIN = 900;

    function _deploy(uint256 perTx, uint256 daily) internal {
        token = TestProxies.deployWrappedNave("Wrapped NAVE", "NAVE", 6, owner, owner);
        bridge = TestProxies.deployBridge(address(token), owner, relayer, perTx, daily);
        vm.prank(owner);
        token.setMinter(address(bridge));
        vm.prank(owner);
        bridge.acceptMinterRole();
    }

    /// A per-tx cap is a hard ceiling: any amount at or below it mints, any
    /// amount above it reverts — for every cap and amount.
    function testFuzz_perTxCapIsHardCeiling(uint256 cap, uint256 amount, uint64 nonce) public {
        cap = bound(cap, 1, 1_000_000_000_000);
        amount = bound(amount, 1, 2_000_000_000_000);
        _deploy(cap, 0);

        vm.prank(relayer);
        if (amount <= cap) {
            bridge.bridgeIn(alice, amount, SOL_CHAIN, nonce);
            assertEq(token.balanceOf(alice), amount);
        } else {
            vm.expectRevert(NaveErrors.PerTxCapExceeded.selector);
            bridge.bridgeIn(alice, amount, SOL_CHAIN, nonce);
        }
    }

    /// Within a single 24h window the cumulative minted amount can never exceed
    /// the daily cap, regardless of how the fuzzer splits it across two mints.
    function testFuzz_dailyCapBoundsWindowTotal(uint256 daily, uint256 a, uint256 b) public {
        daily = bound(daily, 2, 1_000_000_000_000);
        a = bound(a, 1, daily);
        b = bound(b, 1, daily);
        _deploy(0, daily); // no per-tx cap; daily cap is the only bound

        vm.prank(relayer);
        bridge.bridgeIn(alice, a, SOL_CHAIN, 1);

        vm.prank(relayer);
        if (a + b <= daily) {
            bridge.bridgeIn(alice, b, SOL_CHAIN, 2);
            assertEq(token.balanceOf(alice), a + b);
            assertLe(token.balanceOf(alice), daily, "window total within cap");
        } else {
            vm.expectRevert(NaveErrors.DailyCapExceeded.selector);
            bridge.bridgeIn(alice, b, SOL_CHAIN, 2);
            assertEq(token.balanceOf(alice), a);
        }
    }

    /// The known-and-documented 2x boundary burst (audit P3): filling the cap
    /// just before the fixed window rolls, then again right after, moves up to
    /// 2x the daily cap in a short wall-clock span — but never more than 2x
    /// across a single boundary.
    function testFuzz_dailyCapAcrossBoundaryIsAtMost2x(uint256 daily) public {
        daily = bound(daily, 1, 1_000_000_000_000);
        _deploy(0, daily);

        vm.startPrank(relayer);
        bridge.bridgeIn(alice, daily, SOL_CHAIN, 1); // fill window 1
        vm.expectRevert(NaveErrors.DailyCapExceeded.selector);
        bridge.bridgeIn(alice, 1, SOL_CHAIN, 2); // no more this window
        vm.warp(block.timestamp + 1 days + 1); // roll the fixed window
        bridge.bridgeIn(alice, daily, SOL_CHAIN, 3); // full cap available again
        vm.stopPrank();

        assertEq(token.balanceOf(alice), 2 * daily, "exactly 2x across the boundary, never more");
    }

    /// The {WrappedNave} supply cap is a hard ceiling on total supply: mints up
    /// to the cap succeed, a mint that would cross it reverts, for any cap.
    function testFuzz_supplyCapIsHardCeiling(uint256 cap, uint256 first, uint256 second) public {
        cap = bound(cap, 2, 1_000_000_000_000);
        first = bound(first, 1, cap);
        second = bound(second, 1, cap);
        _deploy(0, 0); // no bridge caps; isolate the token supply cap
        vm.prank(owner);
        token.setSupplyCap(cap);

        vm.prank(relayer);
        bridge.bridgeIn(alice, first, SOL_CHAIN, 1);
        assertEq(token.totalSupply(), first);

        vm.prank(relayer);
        if (first + second <= cap) {
            bridge.bridgeIn(alice, second, SOL_CHAIN, 2);
            assertLe(token.totalSupply(), cap, "supply never exceeds the cap");
        } else {
            vm.expectRevert(NaveErrors.SupplyCapExceeded.selector);
            bridge.bridgeIn(alice, second, SOL_CHAIN, 2);
            assertEq(token.totalSupply(), first);
        }
    }
}
