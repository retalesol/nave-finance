// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {DeployHardenedBridgeStack} from "../script/DeployHardenedBridgeStack.s.sol";

/// Exposes internal chain/owner gates so the allowlist is testable.
contract DeployGateHarness is DeployHardenedBridgeStack {
    function assertSupportedChain() external view {
        _assertSupportedChain();
    }

    function isTestnet() external view returns (bool) {
        return _isTestnet();
    }

    function isMainnet() external view returns (bool) {
        return _isMainnet();
    }

    function resolveDeployOwner() external view returns (address) {
        return _resolveDeployOwner();
    }

    function resolveIntendedOwner() external view returns (address) {
        return _resolveIntendedOwner();
    }

    function resolveOwner() external view returns (address) {
        return _resolveOwner();
    }
}

/// @title DeployHardenedBridgeStackGateTest
/// @notice The hardened-bridge deploy script supports testnets and mainnets.
/// Constructor owner is always the broadcaster (so wiring works). Mainnet still
/// requires STACK_OWNER (= Safe) as the intended post-handoff owner.
contract DeployHardenedBridgeStackGateTest is Test {
    DeployGateHarness internal gate;

    function setUp() public {
        gate = new DeployGateHarness();
    }

    function test_allowsSupportedTestnets() public {
        for (uint256 id = 0; id < 3; id++) {
            uint256 chainId = id == 0 ? 11_155_111 : (id == 1 ? 84_532 : 46_630);
            vm.chainId(chainId);
            gate.assertSupportedChain();
            assertTrue(gate.isTestnet());
            assertFalse(gate.isMainnet());
            assertEq(gate.resolveDeployOwner(), address(this));
            assertEq(gate.resolveIntendedOwner(), address(this));
            assertEq(gate.resolveOwner(), address(this));
        }
    }

    /// Single sequential test so `vm.setEnv("STACK_OWNER", ...)` cannot race
    /// across Foundry's parallel test workers.
    function test_mainnetOwnerGates() public {
        // Ensure parent-shell STACK_OWNER (from cutover) cannot pollute asserts.
        vm.setEnv("STACK_OWNER", "");

        address safe = address(0xBEEF);

        vm.chainId(1);
        gate.assertSupportedChain();
        assertTrue(gate.isMainnet());
        assertEq(gate.resolveDeployOwner(), address(this));

        // Missing / empty STACK_OWNER → forge envAddress reverts.
        vm.expectRevert();
        gate.resolveIntendedOwner();

        vm.chainId(8453);
        vm.expectRevert();
        gate.resolveIntendedOwner();

        vm.chainId(4663);
        vm.expectRevert();
        gate.resolveIntendedOwner();

        // Zero Safe rejected.
        vm.chainId(1);
        vm.setEnv("STACK_OWNER", vm.toString(address(0)));
        vm.expectRevert("DeployHardenedBridgeStack: STACK_OWNER is zero");
        gate.resolveIntendedOwner();

        // Deploy wallet must not be the lasting owner on mainnet.
        vm.setEnv("STACK_OWNER", vm.toString(address(this)));
        vm.expectRevert("DeployHardenedBridgeStack: STACK_OWNER must be Safe, not the deploy wallet");
        gate.resolveIntendedOwner();

        // Happy path: deploy owner stays broadcaster; intended owner is Safe.
        vm.setEnv("STACK_OWNER", vm.toString(safe));
        assertEq(gate.resolveDeployOwner(), address(this));
        assertEq(gate.resolveIntendedOwner(), safe);
        assertEq(gate.resolveOwner(), safe);
    }

    function test_rejectsOutOfScopeChains() public {
        for (uint256 chainId = 0; chainId < 4; chainId++) {
            uint256 id = chainId == 0 ? 56 : (chainId == 1 ? 42_161 : (chainId == 2 ? 137 : 10));
            vm.chainId(id);
            vm.expectRevert("DeployHardenedBridgeStack: unsupported chain id");
            gate.assertSupportedChain();
        }
    }
}
