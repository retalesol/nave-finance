// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";

import {NaveProtocol} from "../src/NaveProtocol.sol";
import {NaveDAOFactory} from "../src/NaveDAOFactory.sol";
import {NaveDaoStake} from "../src/NaveDaoStake.sol";
import {PythOracle} from "../src/oracle/PythOracle.sol";
import {WrappedNave} from "../src/WrappedNave.sol";
import {NaveBridge} from "../src/NaveBridge.sol";
import {NaveStaking} from "../src/NaveStaking.sol";

/// @title UpgradeUups
/// @notice Deploy a new implementation and UUPS-upgrade a singleton proxy.
/// Does NOT upgrade per-DAO proxies (those require DAO consent).
///
/// Env:
///   PROXY_ADDRESS   — existing ERC1967 proxy
///   TARGET          — protocol | factory | daoStake | oracle | wrappedNave | bridge | staking
contract UpgradeUups is Script {
    function run() external {
        address proxy = vm.envAddress("PROXY_ADDRESS");
        string memory target = vm.envString("TARGET");

        vm.startBroadcast();
        address impl;
        if (_eq(target, "protocol")) {
            impl = address(new NaveProtocol());
        } else if (_eq(target, "factory")) {
            impl = address(new NaveDAOFactory());
        } else if (_eq(target, "daoStake")) {
            impl = address(new NaveDaoStake());
        } else if (_eq(target, "oracle")) {
            impl = address(new PythOracle());
        } else if (_eq(target, "wrappedNave")) {
            impl = address(new WrappedNave());
        } else if (_eq(target, "bridge")) {
            impl = address(new NaveBridge());
        } else if (_eq(target, "staking")) {
            impl = address(new NaveStaking());
        } else {
            revert("UpgradeUups: unknown TARGET");
        }

        UUPSUpgradeable(proxy).upgradeToAndCall(impl, "");
        vm.stopBroadcast();

        console2.log("upgraded", target);
        console2.log("proxy", proxy);
        console2.log("implementation", impl);
    }

    function _eq(string memory a, string memory b) internal pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }
}
