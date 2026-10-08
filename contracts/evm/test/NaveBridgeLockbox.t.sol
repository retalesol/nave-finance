// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {WrappedNave} from "../src/WrappedNave.sol";
import {NaveBridge} from "../src/NaveBridge.sol";
import {NaveErrors} from "../src/libraries/NaveErrors.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {TestProxies} from "./helpers/TestProxies.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/// @notice Unit tests for the inbound-mint lockbox {NaveBridge} plus the new
/// {WrappedNave} freeze/control-revocation and one-signature `bridgeBurn`.
contract NaveBridgeLockboxTest is Test {
    WrappedNave internal token;
    NaveBridge internal bridge;

    address internal owner = makeAddr("owner");
    address internal relayer = makeAddr("relayer");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    bytes32 internal constant SOL_RECIPIENT = bytes32(uint256(0x1234));
    uint64 internal constant SRC_CHAIN = 900;

    event BridgeIn(address indexed recipient, uint256 netAmount, uint64 indexed srcChainId, uint64 indexed srcNonce);
    event BridgeBurnTo(address indexed from, bytes32 indexed solanaRecipient, uint256 amount);

    function setUp() public {
        // Owner deploys the token, deploys the lockbox, and rotates the token
        // minter to the lockbox (two-step) so all inbound supply flows through it.
        token = TestProxies.deployWrappedNave("Wrapped NAVE", "NAVE", 6, owner, owner);
        // per-tx cap 100 NAVE, daily cap 250 NAVE (6 decimals).
        bridge = TestProxies.deployBridge(address(token), owner, relayer, 100_000_000, 250_000_000);
        vm.prank(owner);
        token.setMinter(address(bridge));
        // Real-chain rotation path: the lockbox owner relays the claim through
        // the contract (a contract cannot sign its own acceptMinter call).
        vm.prank(owner);
        bridge.acceptMinterRole();
        assertEq(token.minter(), address(bridge));
    }

    // ── bridgeIn (inbound mint) ────────────────────────────────────────────

    function test_bridgeIn_mintsNetToRecipient() public {
        vm.expectEmit(true, true, true, true);
        emit BridgeIn(alice, 10_000_000, SRC_CHAIN, 1);
        vm.prank(relayer);
        bridge.bridgeIn(alice, 10_000_000, SRC_CHAIN, 1);
        assertEq(token.balanceOf(alice), 10_000_000);
    }

    function test_bridgeIn_onlyRelayer() public {
        vm.prank(alice);
        vm.expectRevert(NaveErrors.Unauthorized.selector);
        bridge.bridgeIn(alice, 1_000_000, SRC_CHAIN, 1);
    }

    function test_bridgeIn_replayRejected() public {
        vm.prank(relayer);
        bridge.bridgeIn(alice, 10_000_000, SRC_CHAIN, 7);
        vm.prank(relayer);
        vm.expectRevert(NaveErrors.AlreadyProcessed.selector);
        bridge.bridgeIn(alice, 10_000_000, SRC_CHAIN, 7);
    }

    function test_bridgeIn_perTxCapEnforced() public {
        vm.prank(relayer);
        vm.expectRevert(NaveErrors.PerTxCapExceeded.selector);
        bridge.bridgeIn(alice, 100_000_001, SRC_CHAIN, 1);
    }

    function test_bridgeIn_dailyCapEnforced() public {
        vm.startPrank(relayer);
        bridge.bridgeIn(alice, 100_000_000, SRC_CHAIN, 1);
        bridge.bridgeIn(alice, 100_000_000, SRC_CHAIN, 2);
        // Third would bring total to 300 NAVE > 250 daily cap.
        vm.expectRevert(NaveErrors.DailyCapExceeded.selector);
        bridge.bridgeIn(alice, 100_000_000, SRC_CHAIN, 3);
        vm.stopPrank();
    }

    function test_bridgeIn_dailyCapResetsAfterWindow() public {
        vm.startPrank(relayer);
        bridge.bridgeIn(alice, 100_000_000, SRC_CHAIN, 1);
        bridge.bridgeIn(alice, 100_000_000, SRC_CHAIN, 2);
        vm.warp(block.timestamp + 1 days + 1);
        // New window: cap resets, this succeeds.
        bridge.bridgeIn(alice, 100_000_000, SRC_CHAIN, 3);
        vm.stopPrank();
        assertEq(token.balanceOf(alice), 300_000_000);
    }

    function test_bridgeIn_pausedBlocks() public {
        vm.prank(owner);
        bridge.setPaused(true);
        vm.prank(relayer);
        vm.expectRevert(NaveErrors.BridgePaused.selector);
        bridge.bridgeIn(alice, 1_000_000, SRC_CHAIN, 1);
    }

    // ── one-signature bridgeBurn ───────────────────────────────────────────

    function test_bridgeBurn_burnsAndEmitsRecipient() public {
        vm.prank(relayer);
        bridge.bridgeIn(alice, 50_000_000, SRC_CHAIN, 1);

        vm.expectEmit(true, true, false, true);
        emit BridgeBurnTo(alice, SOL_RECIPIENT, 20_000_000);
        vm.prank(alice);
        token.bridgeBurn(20_000_000, SOL_RECIPIENT);
        assertEq(token.balanceOf(alice), 30_000_000);
    }

    function test_bridgeBurn_zeroRecipientReverts() public {
        vm.prank(relayer);
        bridge.bridgeIn(alice, 50_000_000, SRC_CHAIN, 1);
        vm.prank(alice);
        vm.expectRevert(NaveErrors.InvalidRecipient.selector);
        token.bridgeBurn(1_000_000, bytes32(0));
    }

    // ── freeze / control revocation ────────────────────────────────────────

    function test_freeze_blocksTransfers() public {
        vm.prank(relayer);
        bridge.bridgeIn(alice, 10_000_000, SRC_CHAIN, 1);
        vm.prank(owner);
        token.setFrozen(alice, true);
        vm.prank(alice);
        vm.expectRevert(NaveErrors.AccountIsFrozen.selector);
        token.transfer(bob, 1_000_000);
    }

    function test_freeze_blocksBurn() public {
        vm.prank(relayer);
        bridge.bridgeIn(alice, 10_000_000, SRC_CHAIN, 1);
        vm.prank(owner);
        token.setFrozen(alice, true);
        vm.prank(alice);
        vm.expectRevert(NaveErrors.AccountIsFrozen.selector);
        token.bridgeBurn(1_000_000, SOL_RECIPIENT);
    }

    function test_renounceControl_disablesFreezePermanently() public {
        vm.prank(owner);
        token.setFrozen(alice, true);
        vm.prank(owner);
        token.renounceControl();
        assertTrue(token.controlRevoked());

        // setFrozen now reverts forever.
        vm.prank(owner);
        vm.expectRevert(NaveErrors.ControlAlreadyRevoked.selector);
        token.setFrozen(bob, true);

        // And the previously-frozen account can transfer again (checks skipped).
        vm.prank(relayer);
        bridge.bridgeIn(alice, 5_000_000, SRC_CHAIN, 2);
        vm.prank(alice);
        token.transfer(bob, 1_000_000);
        assertEq(token.balanceOf(bob), 1_000_000);
    }

    function test_setFrozen_onlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, alice));
        token.setFrozen(bob, true);
    }

    // ── lockbox admin ──────────────────────────────────────────────────────

    function test_twoStepOwnership() public {
        vm.prank(owner);
        bridge.transferOwnership(bob);
        assertEq(bridge.owner(), owner);
        vm.prank(bob);
        bridge.acceptOwnership();
        assertEq(bridge.owner(), bob);
    }

    function test_acceptOwnership_onlyPending() public {
        vm.prank(owner);
        bridge.transferOwnership(bob);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, alice));
        bridge.acceptOwnership();
    }

    // ── Privileged roles must be distinct keys (pre-redeploy hardening) ──────
    /// The relayer hot key may never also be the owner: one compromised key
    /// could otherwise mint AND lift pause / caps.
    function test_initialize_relayerEqualsOwnerReverts() public {
        NaveBridge impl = new NaveBridge();
        vm.expectRevert(NaveErrors.PrivilegedRolesMustDiffer.selector);
        new ERC1967Proxy(
            address(impl),
            abi.encodeCall(NaveBridge.initialize, (address(token), owner, owner, 1, 1))
        );
    }

    function test_setRelayer_cannotBeOwnerOrPendingOwner() public {
        vm.prank(owner);
        vm.expectRevert(NaveErrors.PrivilegedRolesMustDiffer.selector);
        bridge.setRelayer(owner);

        vm.prank(owner);
        bridge.transferOwnership(bob); // bob is now pendingOwner
        vm.prank(owner);
        vm.expectRevert(NaveErrors.PrivilegedRolesMustDiffer.selector);
        bridge.setRelayer(bob);

        // A distinct key is still accepted.
        vm.prank(owner);
        bridge.setRelayer(alice);
        assertEq(bridge.relayer(), alice);
    }

    function test_transferOwnership_cannotTargetRelayer() public {
        vm.prank(owner);
        vm.expectRevert(NaveErrors.PrivilegedRolesMustDiffer.selector);
        bridge.transferOwnership(relayer);
        assertEq(bridge.pendingOwner(), address(0));
    }

    /// Caps are live: both the per-tx ceiling and the rolling daily total are
    /// enforced by `bridgeIn` (see the dedicated cap tests above); `setCaps`
    /// is owner-only.
    function test_setCaps_onlyOwner() public {
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, relayer));
        bridge.setCaps(1, 1);
        assertEq(bridge.perTxCap(), 100_000_000);
        assertEq(bridge.dailyCap(), 250_000_000);
    }
}
