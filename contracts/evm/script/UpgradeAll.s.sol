// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {NaveProtocol} from "../src/NaveProtocol.sol";
import {NaveTreasury} from "../src/NaveTreasury.sol";
import {NaveGovernor} from "../src/NaveGovernor.sol";
import {NaveExecution} from "../src/NaveExecution.sol";
import {AaveV3Adapter} from "../src/adapters/AaveV3Adapter.sol";
import {CompoundV3Adapter} from "../src/adapters/CompoundV3Adapter.sol";
import {DaoImplRole} from "../src/libraries/NaveEnums.sol";
import {NaveAddressRegistry} from "./config/NaveAddressRegistry.sol";

/// @title UpgradeAll
/// @notice Publishes new DAO T/G/E implementations as latest (opt-in for DAOs)
/// and optionally redeploys strategy adapters (still non-proxy; constitution
/// must be updated to point at new adapter addresses).
///
/// Env: PROTOCOL_ADDRESS
/// Optional: AAVE_POOL, COMPOUND_COMET (redeploy those adapters when set)
contract UpgradeAll is Script {
    function run() external {
        NaveProtocol protocol = NaveProtocol(payable(vm.envAddress("PROTOCOL_ADDRESS")));

        vm.startBroadcast();
        address treasuryImpl = address(new NaveTreasury());
        address governorImpl = address(new NaveGovernor());
        address executionImpl = address(new NaveExecution());
        protocol.publishImplementation(uint8(DaoImplRole.Treasury), treasuryImpl);
        protocol.publishImplementation(uint8(DaoImplRole.Governor), governorImpl);
        protocol.publishImplementation(uint8(DaoImplRole.Execution), executionImpl);

        NaveAddressRegistry.ChainConfig memory cfg = NaveAddressRegistry.config(block.chainid);
        address aavePool = vm.envOr("AAVE_POOL", cfg.aaveV3Pool);
        if (aavePool != address(0)) {
            address aave = address(new AaveV3Adapter(address(protocol), aavePool));
            console2.log("AaveV3Adapter", aave);
        }
        address comet = vm.envOr("COMPOUND_COMET", cfg.compoundCometUsdc);
        if (comet != address(0)) {
            address compound = address(new CompoundV3Adapter(address(protocol), comet));
            console2.log("CompoundV3Adapter", compound);
        }
        vm.stopBroadcast();

        console2.log("Published DAO impls (existing DAOs unchanged until opt-in)");
        console2.log("treasuryImplementation", treasuryImpl);
        console2.log("governorImplementation", governorImpl);
        console2.log("executionImplementation", executionImpl);
    }
}
