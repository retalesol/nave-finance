// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {NaveProtocol} from "../src/NaveProtocol.sol";
import {NaveTreasury} from "../src/NaveTreasury.sol";
import {NaveGovernor} from "../src/NaveGovernor.sol";
import {NaveExecution} from "../src/NaveExecution.sol";
import {DaoImplRole} from "../src/libraries/NaveEnums.sol";

/// @title UpgradeFactory
/// @notice DEPRECATED name kept for cutover compatibility. Publishes new DAO
/// implementation bytecode as protocol latest. Existing DAOs keep old logic
/// until they consent via ContractUpgrade governance.
///
/// Env: PROTOCOL_ADDRESS
contract UpgradeFactory is Script {
    function run() external {
        NaveProtocol protocol = NaveProtocol(payable(vm.envAddress("PROTOCOL_ADDRESS")));

        vm.startBroadcast();
        address treasuryImpl = address(new NaveTreasury());
        address governorImpl = address(new NaveGovernor());
        address executionImpl = address(new NaveExecution());
        protocol.publishImplementation(uint8(DaoImplRole.Treasury), treasuryImpl);
        protocol.publishImplementation(uint8(DaoImplRole.Governor), governorImpl);
        protocol.publishImplementation(uint8(DaoImplRole.Execution), executionImpl);
        vm.stopBroadcast();

        console2.log("Published DAO impls (existing DAOs unchanged until opt-in)");
        console2.log("treasuryImplementation", treasuryImpl);
        console2.log("governorImplementation", governorImpl);
        console2.log("executionImplementation", executionImpl);
    }
}
