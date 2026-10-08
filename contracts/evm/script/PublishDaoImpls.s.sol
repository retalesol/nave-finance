// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {NaveProtocol} from "../src/NaveProtocol.sol";
import {NaveTreasury} from "../src/NaveTreasury.sol";
import {NaveGovernor} from "../src/NaveGovernor.sol";
import {NaveExecution} from "../src/NaveExecution.sol";
import {DaoImplRole} from "../src/libraries/NaveEnums.sol";

/// @title PublishDaoImpls
/// @notice Deploy new Treasury/Governor/Execution implementations and publish
/// them as protocol-approved latest. Existing DAOs are NOT mutated — the
/// upgrade monitor / DAO governance must opt in.
///
/// Env:
///   PROTOCOL_ADDRESS — NaveProtocol proxy
///   PUBLISH_TREASURY (default true)
///   PUBLISH_GOVERNOR (default true)
///   PUBLISH_EXECUTION (default true)
contract PublishDaoImpls is Script {
    function run() external {
        NaveProtocol protocol = NaveProtocol(payable(vm.envAddress("PROTOCOL_ADDRESS")));
        bool pubT = vm.envOr("PUBLISH_TREASURY", true);
        bool pubG = vm.envOr("PUBLISH_GOVERNOR", true);
        bool pubE = vm.envOr("PUBLISH_EXECUTION", true);

        vm.startBroadcast();
        if (pubT) {
            address impl = address(new NaveTreasury());
            protocol.publishImplementation(uint8(DaoImplRole.Treasury), impl);
            console2.log("treasuryImplementation", impl);
        }
        if (pubG) {
            address impl = address(new NaveGovernor());
            protocol.publishImplementation(uint8(DaoImplRole.Governor), impl);
            console2.log("governorImplementation", impl);
        }
        if (pubE) {
            address impl = address(new NaveExecution());
            protocol.publishImplementation(uint8(DaoImplRole.Execution), impl);
            console2.log("executionImplementation", impl);
        }
        vm.stopBroadcast();
    }
}
