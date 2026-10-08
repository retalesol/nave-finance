// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {NaveDaoStake} from "../src/NaveDaoStake.sol";

/// @title DeployDaoStake
/// @notice Deploys UUPS NaveDaoStake for an existing NaveProtocol. Owner is
///         set to STACK_OWNER (Safe) at initialize — no acceptOwnership needed
///         for the module. Safe must still call protocol.setNaveStakeConfig +
///         setDaoStake to activate the creation gate.
///
/// Env:
///   - PROTOCOL       NaveProtocol proxy
///   - STACK_OWNER    Safe multisig (module owner)
contract DeployDaoStake is Script {
    function run() external {
        address protocol = vm.envAddress("PROTOCOL");
        address owner_ = vm.envAddress("STACK_OWNER");
        require(protocol != address(0) && protocol.code.length > 0, "PROTOCOL");
        require(owner_ != address(0), "STACK_OWNER");
        require(owner_ != msg.sender, "STACK_OWNER must be Safe");

        vm.startBroadcast();
        NaveDaoStake impl = new NaveDaoStake();
        NaveDaoStake stake = NaveDaoStake(
            address(
                new ERC1967Proxy(
                    address(impl), abi.encodeCall(NaveDaoStake.initialize, (owner_, protocol))
                )
            )
        );
        vm.stopBroadcast();

        console2.log("daoStakeImplementation", address(impl));
        console2.log("daoStake", address(stake));
        console2.log("owner", owner_);
        console2.log("protocol", protocol);
    }
}
