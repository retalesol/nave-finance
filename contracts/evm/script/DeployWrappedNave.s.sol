// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {WrappedNave} from "../src/WrappedNave.sol";

/// @title DeployWrappedNave
/// @notice Deploys the trusted-relayer `WrappedNave` ERC-20 (the wrapped
/// representation of the Solana NAVE SPL token) on EVM TESTNETS ONLY — Ethereum
/// Sepolia (11155111) and Base Sepolia (84532). Any other chain id aborts.
///
/// Configure via env:
///   - WRAPPED_NAVE_OWNER  (administrative owner who can rotate the minter)
///   - WRAPPED_NAVE_MINTER (the bridge manager / relayer; defaults to owner)
///
/// Writes `deployments/wrapped-nave-<chainId>.json` consumed by the off-chain
/// relayer + app env wiring.
contract DeployWrappedNave is Script {
    /// Restrict to the supported EVM testnets only.
    function _assertTestnet() internal view {
        uint256 id = block.chainid;
        require(
            id == 11_155_111 || id == 84_532,
            "DeployWrappedNave: testnet only (Sepolia 11155111 / Base Sepolia 84532)"
        );
    }

    function run() external {
        _assertTestnet();

        address owner = vm.envAddress("WRAPPED_NAVE_OWNER");
        address minter = vm.envOr("WRAPPED_NAVE_MINTER", owner);

        vm.startBroadcast();
        WrappedNave implementation = new WrappedNave();
        WrappedNave wrappedNave = WrappedNave(
            address(
                new ERC1967Proxy(
                    address(implementation),
                    abi.encodeCall(
                        WrappedNave.initialize, ("Wrapped NAVE", "NAVE", uint8(6), owner, minter)
                    )
                )
            )
        );
        vm.stopBroadcast();

        console2.log("chainId     ", block.chainid);
        console2.log("WrappedNave ", address(wrappedNave));
        console2.log("owner       ", owner);
        console2.log("minter      ", minter);

        _writeArtifact(address(wrappedNave), owner, minter);
    }

    function _writeArtifact(address wrappedNave, address owner, address minter) internal {
        string memory root = "wrappedNaveDeploy";
        vm.serializeUint(root, "chainId", block.chainid);
        vm.serializeAddress(root, "wrappedNave", wrappedNave);
        vm.serializeAddress(root, "owner", owner);
        string memory json = vm.serializeAddress(root, "minter", minter);

        string memory path =
            string.concat("deployments/wrapped-nave-", vm.toString(block.chainid), ".json");
        vm.writeJson(json, path);
    }
}
