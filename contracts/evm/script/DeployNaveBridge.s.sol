// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {NaveBridge} from "../src/NaveBridge.sol";

/// @title DeployNaveBridge
/// @notice Deploys the inbound-mint lockbox {NaveBridge} on the supported EVM
/// testnets (Sepolia 11155111 / Base Sepolia 84532). After deployment, the
/// {WrappedNave} `owner` must rotate the token `minter` to this lockbox
/// (`setMinter` -> `acceptMinter`) so all inbound wNAVE supply is created behind
/// the lockbox's pause + caps + replay guards.
///
/// Configure via env:
///   - BRIDGE_WRAPPED_NAVE   (the deployed WrappedNave token address)
///   - BRIDGE_OWNER          (administrative owner; a Safe/multisig on mainnet)
///   - BRIDGE_RELAYER        (the relayer hot key allowed to call bridgeIn)
///   - BRIDGE_PER_TX_CAP     (per-tx net mint cap, base units; 0 = unlimited)
///   - BRIDGE_DAILY_CAP      (rolling 24h net mint cap, base units; 0 = unlimited)
contract DeployNaveBridge is Script {
    function _assertTestnet() internal view {
        uint256 id = block.chainid;
        require(
            id == 11_155_111 || id == 84_532,
            "DeployNaveBridge: testnet only (Sepolia 11155111 / Base Sepolia 84532)"
        );
    }

    function run() external {
        _assertTestnet();

        address wnave = vm.envAddress("BRIDGE_WRAPPED_NAVE");
        address owner = vm.envAddress("BRIDGE_OWNER");
        address relayer = vm.envAddress("BRIDGE_RELAYER");
        uint256 perTxCap = vm.envOr("BRIDGE_PER_TX_CAP", uint256(0));
        uint256 dailyCap = vm.envOr("BRIDGE_DAILY_CAP", uint256(0));

        vm.startBroadcast();
        NaveBridge implementation = new NaveBridge();
        NaveBridge bridge = NaveBridge(
            address(
                new ERC1967Proxy(
                    address(implementation),
                    abi.encodeCall(
                        NaveBridge.initialize, (wnave, owner, relayer, perTxCap, dailyCap)
                    )
                )
            )
        );
        vm.stopBroadcast();

        console2.log("chainId   ", block.chainid);
        console2.log("NaveBridge", address(bridge));
        console2.log("wNAVE     ", wnave);
        console2.log("owner     ", owner);
        console2.log("relayer   ", relayer);

        string memory root = "naveBridgeDeploy";
        vm.serializeUint(root, "chainId", block.chainid);
        vm.serializeAddress(root, "naveBridge", address(bridge));
        vm.serializeAddress(root, "wrappedNave", wnave);
        vm.serializeAddress(root, "owner", owner);
        vm.serializeUint(root, "perTxCap", perTxCap);
        string memory json = vm.serializeAddress(root, "relayer", relayer);

        string memory path =
            string.concat("deployments/nave-bridge-", vm.toString(block.chainid), ".json");
        vm.writeJson(json, path);
    }
}
