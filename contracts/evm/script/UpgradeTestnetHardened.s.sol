// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";

import {NaveProtocol} from "../src/NaveProtocol.sol";
import {NaveTreasury} from "../src/NaveTreasury.sol";
import {NaveGovernor} from "../src/NaveGovernor.sol";
import {NaveExecution} from "../src/NaveExecution.sol";
import {AaveV3Adapter} from "../src/adapters/AaveV3Adapter.sol";
import {CompoundV3Adapter} from "../src/adapters/CompoundV3Adapter.sol";
import {DaoImplRole} from "../src/libraries/NaveEnums.sol";
import {NaveAddressRegistry} from "./config/NaveAddressRegistry.sol";

/// @title UpgradeTestnetHardened
/// @notice Testnet-only roll of the hardened EVM stack onto an existing
/// protocol: UUPS-upgrades NaveProtocol (risk tiers), publishes the hardened
/// Treasury / Governor / Execution implementations for new DAOs, and deploys
/// fresh Aave V3 / Compound V3 adapters where the chain has the pool. New
/// adapters get Tier 1 and a queued approval (ADAPTER_APPROVAL_DELAY_SECS once
/// any DAO exists); run `applyAdapterApproval` after the delay.
///
/// Env: PROTOCOL_ADDRESS, SKIP_ADAPTERS (optional; republish implementations only)
contract UpgradeTestnetHardened is Script {
    function run() external {
        uint256 id = block.chainid;
        require(
            id == 11_155_111 || id == 84_532 || id == 46_630 || id == 5_042_002,
            "UpgradeTestnetHardened: testnets only"
        );
        NaveProtocol protocol = NaveProtocol(payable(vm.envAddress("PROTOCOL_ADDRESS")));
        NaveAddressRegistry.ChainConfig memory cfg = NaveAddressRegistry.config(id);
        bool skipAdapters = vm.envOr("SKIP_ADAPTERS", false);

        vm.startBroadcast();
        address protocolImpl = address(new NaveProtocol());
        UUPSUpgradeable(address(protocol)).upgradeToAndCall(protocolImpl, "");

        address treasuryImpl = address(new NaveTreasury());
        address governorImpl = address(new NaveGovernor());
        address executionImpl = address(new NaveExecution());
        protocol.publishImplementation(uint8(DaoImplRole.Treasury), treasuryImpl);
        protocol.publishImplementation(uint8(DaoImplRole.Governor), governorImpl);
        protocol.publishImplementation(uint8(DaoImplRole.Execution), executionImpl);

        address aave;
        if (!skipAdapters && cfg.aaveV3Pool != address(0)) {
            aave = address(new AaveV3Adapter(address(protocol), cfg.aaveV3Pool));
            protocol.setAdapterRiskTier(aave, 1);
            protocol.setAdapterApproved(aave, true);
        }
        address compound;
        if (!skipAdapters && cfg.compoundCometUsdc != address(0)) {
            compound = address(new CompoundV3Adapter(address(protocol), cfg.compoundCometUsdc));
            protocol.setAdapterRiskTier(compound, 1);
            protocol.setAdapterApproved(compound, true);
        }
        vm.stopBroadcast();

        console2.log("protocolImplementation", protocolImpl);
        console2.log("treasuryImplementation", treasuryImpl);
        console2.log("governorImplementation", governorImpl);
        console2.log("executionImplementation", executionImpl);
        console2.log("aaveV3Adapter", aave);
        console2.log("compoundV3Adapter", compound);
        if (aave != address(0)) console2.log("aaveApprovalEffectiveAt", protocol.adapterApprovalEffectiveAt(aave));
        if (compound != address(0)) {
            console2.log("compoundApprovalEffectiveAt", protocol.adapterApprovalEffectiveAt(compound));
        }
    }
}
