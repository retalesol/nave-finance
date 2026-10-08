// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {NaveStaking} from "../src/NaveStaking.sol";

/// @title DeployNaveStaking
/// @notice Deploys the EVM staking mirror {NaveStaking} on the supported EVM
/// testnets (Sepolia 11155111 / Base Sepolia 84532). Stakers stake wNAVE; the
/// relayer delivers this chain's share of the central Solana reward pool via
/// {NaveStaking.notifyReward}.
///
/// Configure via env:
///   - STAKING_WRAPPED_NAVE (the deployed WrappedNave token address)
///   - STAKING_OWNER        (administrative owner; a Safe/multisig on mainnet)
///   - STAKING_REWARDER     (relayer address allowed to deliver reward top-ups)
contract DeployNaveStaking is Script {
    function _assertTestnet() internal view {
        uint256 id = block.chainid;
        require(
            id == 11_155_111 || id == 84_532,
            "DeployNaveStaking: testnet only (Sepolia 11155111 / Base Sepolia 84532)"
        );
    }

    function run() external {
        _assertTestnet();

        address wnave = vm.envAddress("STAKING_WRAPPED_NAVE");
        address owner = vm.envAddress("STAKING_OWNER");
        address rewarder = vm.envAddress("STAKING_REWARDER");

        vm.startBroadcast();
        NaveStaking implementation = new NaveStaking();
        NaveStaking staking = NaveStaking(
            address(
                new ERC1967Proxy(
                    address(implementation),
                    abi.encodeCall(NaveStaking.initialize, (wnave, owner, rewarder))
                )
            )
        );
        vm.stopBroadcast();

        console2.log("chainId    ", block.chainid);
        console2.log("NaveStaking", address(staking));
        console2.log("wNAVE      ", wnave);
        console2.log("owner      ", owner);
        console2.log("rewarder   ", rewarder);

        string memory root = "naveStakingDeploy";
        vm.serializeUint(root, "chainId", block.chainid);
        vm.serializeAddress(root, "naveStaking", address(staking));
        vm.serializeAddress(root, "wrappedNave", wnave);
        vm.serializeAddress(root, "owner", owner);
        string memory json = vm.serializeAddress(root, "rewarder", rewarder);

        string memory path =
            string.concat("deployments/nave-staking-", vm.toString(block.chainid), ".json");
        vm.writeJson(json, path);
    }
}
