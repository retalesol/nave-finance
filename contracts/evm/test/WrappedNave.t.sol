// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {WrappedNave} from "../src/WrappedNave.sol";
import {NaveErrors} from "../src/libraries/NaveErrors.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {TestProxies} from "./helpers/TestProxies.sol";

/// @notice Standalone unit tests for the trusted-relayer WrappedNave bridge
/// token. No NaveBase / fork dependency so `forge test` stays green offline.
contract WrappedNaveTest is Test {
    WrappedNave internal token;

    address internal owner = makeAddr("owner");
    address internal minter = makeAddr("minter");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    event MinterUpdated(address indexed previous, address indexed current);
    event BridgeMint(address indexed to, uint256 amount);
    event BridgeBurn(address indexed from, uint256 amount);

    function setUp() public {
        token = TestProxies.deployWrappedNave("Wrapped NAVE", "NAVE", 6, owner, minter);
    }

    function test_metadata() public view {
        assertEq(token.name(), "Wrapped NAVE");
        assertEq(token.symbol(), "NAVE");
        assertEq(token.decimals(), 6);
        assertEq(token.owner(), owner);
        assertEq(token.minter(), minter);
    }

    function test_onlyMinterCanMint() public {
        vm.prank(minter);
        token.mint(alice, 1_000_000);
        assertEq(token.balanceOf(alice), 1_000_000);
    }

    function test_nonMinterMintReverts() public {
        vm.prank(alice);
        vm.expectRevert(NaveErrors.Unauthorized.selector);
        token.mint(alice, 1_000_000);
    }

    function test_mintEmitsBridgeMint() public {
        vm.expectEmit(true, false, false, true);
        emit BridgeMint(alice, 5_000_000);
        vm.prank(minter);
        token.mint(alice, 5_000_000);
    }

    function test_mintToZeroReverts() public {
        vm.prank(minter);
        vm.expectRevert(NaveErrors.ZeroAddress.selector);
        token.mint(address(0), 1);
    }

    function test_userCanBurnOwnBalance() public {
        vm.prank(minter);
        token.mint(alice, 3_000_000);

        vm.prank(alice);
        token.burn(1_000_000);
        assertEq(token.balanceOf(alice), 2_000_000);
    }

    function test_burnEmitsBridgeBurn() public {
        vm.prank(minter);
        token.mint(alice, 2_000_000);

        vm.expectEmit(true, false, false, true);
        emit BridgeBurn(alice, 2_000_000);
        vm.prank(alice);
        token.burn(2_000_000);
    }

    function test_burnFromSpendsAllowanceAndOnlyMinter() public {
        vm.prank(minter);
        token.mint(alice, 4_000_000);

        // Non-minter cannot burnFrom even with allowance.
        vm.prank(alice);
        token.approve(bob, 4_000_000);
        vm.prank(bob);
        vm.expectRevert(NaveErrors.Unauthorized.selector);
        token.burnFrom(alice, 1_000_000);

        // Holder approves the minter; minter burns via allowance.
        vm.prank(alice);
        token.approve(minter, 4_000_000);

        vm.expectEmit(true, false, false, true);
        emit BridgeBurn(alice, 1_500_000);
        vm.prank(minter);
        token.burnFrom(alice, 1_500_000);

        assertEq(token.balanceOf(alice), 2_500_000);
        assertEq(token.allowance(alice, minter), 2_500_000);
    }

    /// SEC-M5: minter rotation is TWO-step — the proposed key must accept
    /// before it gains rights, and the old key keeps operating until then.
    function test_ownerCanSetMinterAndOldLosesRights() public {
        address newMinter = makeAddr("newMinter");

        vm.prank(owner);
        token.setMinter(newMinter);
        assertEq(token.pendingMinter(), newMinter, "rotation proposed");
        // Until accepted, the OLD minter still operates (typo cannot brick).
        assertEq(token.minter(), minter);
        vm.prank(minter);
        token.mint(alice, 1);

        // Non-pending caller cannot claim the role.
        vm.prank(bob);
        vm.expectRevert(NaveErrors.NotPendingMinter.selector);
        token.acceptMinter();

        vm.expectEmit(true, true, false, false);
        emit MinterUpdated(minter, newMinter);
        vm.prank(newMinter);
        token.acceptMinter();
        assertEq(token.minter(), newMinter);
        assertEq(token.pendingMinter(), address(0), "pending cleared");

        // Old minter can no longer mint.
        vm.prank(minter);
        vm.expectRevert(NaveErrors.Unauthorized.selector);
        token.mint(alice, 1);

        // New minter can.
        vm.prank(newMinter);
        token.mint(alice, 1);
        assertEq(token.balanceOf(alice), 2);
    }

    // ── SEC-M5: mint cap + pause circuit breaker ──────────────────────────
    function test_supplyCapBoundsMint() public {
        vm.prank(owner);
        token.setSupplyCap(10_000_000);

        vm.prank(minter);
        token.mint(alice, 9_000_000);

        // Exceeding the cap reverts; exactly reaching it is allowed.
        vm.prank(minter);
        vm.expectRevert(NaveErrors.SupplyCapExceeded.selector);
        token.mint(alice, 1_000_001);
        vm.prank(minter);
        token.mint(alice, 1_000_000);
        assertEq(token.totalSupply(), 10_000_000);

        // Burning frees headroom under the cap.
        vm.prank(alice);
        token.burn(500_000);
        vm.prank(minter);
        token.mint(alice, 500_000);

        // Only the owner may set the cap.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, alice));
        token.setSupplyCap(1);
    }

    function test_mintPause_blocksMintButNotBurn() public {
        vm.prank(minter);
        token.mint(alice, 2_000_000);

        vm.prank(owner);
        token.setMintPaused(true);

        vm.prank(minter);
        vm.expectRevert(NaveErrors.MintPaused.selector);
        token.mint(alice, 1);

        // Users can still burn (bridge back out) while mint is paused.
        vm.prank(alice);
        token.burn(1_000_000);
        assertEq(token.balanceOf(alice), 1_000_000);

        vm.prank(owner);
        token.setMintPaused(false);
        vm.prank(minter);
        token.mint(alice, 1);

        // Only the owner may toggle the breaker.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, alice));
        token.setMintPaused(true);
    }

    function test_nonOwnerSetMinterReverts() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, alice));
        token.setMinter(alice);
    }

    function test_setMinterZeroReverts() public {
        vm.prank(owner);
        vm.expectRevert(NaveErrors.ZeroAddress.selector);
        token.setMinter(address(0));
    }

    function test_transferOwnership_isTwoStep() public {
        // Step 1: propose. Ownership does NOT change yet; old owner keeps rights.
        vm.prank(owner);
        token.transferOwnership(alice);
        assertEq(token.owner(), owner);
        assertEq(token.pendingOwner(), alice);

        // Old owner still administers until the handoff is accepted.
        vm.prank(owner);
        token.setMinter(bob);
        assertEq(token.pendingMinter(), bob);

        // Step 2: the pending owner accepts and ownership flips.
        vm.prank(alice);
        token.acceptOwnership();
        assertEq(token.owner(), alice);
        assertEq(token.pendingOwner(), address(0));

        // Old owner loses rights after acceptance.
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, owner));
        token.setMinter(bob);
    }

    function test_acceptOwnership_onlyPendingOwner() public {
        vm.prank(owner);
        token.transferOwnership(alice);

        // A non-pending address cannot accept.
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, bob));
        token.acceptOwnership();

        // Ownership is unchanged.
        assertEq(token.owner(), owner);
        assertEq(token.pendingOwner(), alice);
    }

    function test_transferOwnership_canBeReproposedBeforeAccept() public {
        vm.prank(owner);
        token.transferOwnership(alice);
        // Re-propose to bob before alice accepts; alice can no longer claim.
        vm.prank(owner);
        token.transferOwnership(bob);
        assertEq(token.pendingOwner(), bob);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, alice));
        token.acceptOwnership();

        vm.prank(bob);
        token.acceptOwnership();
        assertEq(token.owner(), bob);
    }

    function test_transferOwnershipZeroCancelsPending() public {
        vm.prank(owner);
        token.transferOwnership(alice);
        vm.prank(owner);
        token.transferOwnership(address(0));
        assertEq(token.pendingOwner(), address(0));
        assertEq(token.owner(), owner);
    }
}
