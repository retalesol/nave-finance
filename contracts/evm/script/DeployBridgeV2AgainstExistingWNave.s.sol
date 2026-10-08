// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {WrappedNave} from "../src/WrappedNave.sol";
import {NaveBridge} from "../src/NaveBridge.sol";
import {NaveStaking} from "../src/NaveStaking.sol";

/// @title DeployBridgeV2AgainstExistingWNave
/// @notice Deploys UUPS NaveBridge + NaveStaking pointed at an **existing**
///         WrappedNave (v1). Does NOT deploy a new wNAVE and does NOT rotate
///         the minter — the Safe (token owner) must later:
///           1. wnave.setMinter(v2Lockbox)
///           2. v2Lockbox.acceptMinterRole()   (callable by lockbox owner)
///         Until that rotation, v1 lockbox remains the sole minter; burns on
///         the existing wNAVE keep working either way.
///
/// Env:
///   - EXISTING_WNAVE     required — canonical wNAVE (v1)
///   - STACK_OWNER        mainnet intended Safe (artifact only)
///   - STACK_RELAYER      bridgeIn / rewarder hot key (REQUIRED; must differ from
///                        the broadcaster and STACK_OWNER)
///   - STACK_PER_TX_CAP / STACK_DAILY_CAP
///
/// Writes `deployments/hardened-bridge-<chainId>.json` (v2 primary artifact)
/// without overwriting `hardened-bridge-v1-<chainId>.json`.
contract DeployBridgeV2AgainstExistingWNave is Script {
    function _isTestnet() internal view returns (bool) {
        uint256 id = block.chainid;
        return id == 11_155_111 || id == 84_532 || id == 46_630;
    }

    function _isMainnet() internal view returns (bool) {
        uint256 id = block.chainid;
        return id == 1 || id == 8453 || id == 4663;
    }

    function run() external {
        require(_isTestnet() || _isMainnet(), "unsupported chain");

        address existing = vm.envAddress("EXISTING_WNAVE");
        require(existing != address(0), "EXISTING_WNAVE zero");
        require(existing.code.length > 0, "EXISTING_WNAVE has no code");

        WrappedNave wnave = WrappedNave(existing);
        require(wnave.decimals() == 6, "unexpected decimals");

        address deployOwner = msg.sender;
        address intendedOwner;
        if (_isTestnet()) {
            intendedOwner = msg.sender;
        } else {
            intendedOwner = vm.envAddress("STACK_OWNER");
            require(intendedOwner != address(0), "STACK_OWNER zero");
            require(intendedOwner != msg.sender, "STACK_OWNER must be Safe");
        }

        // Lockbox/staking reject relayer == owner (PrivilegedRolesMustDiffer);
        // require an explicit, distinct hot key up front.
        address relayer = vm.envAddress("STACK_RELAYER");
        require(relayer != address(0), "STACK_RELAYER zero");
        require(
            relayer != deployOwner && relayer != intendedOwner,
            "STACK_RELAYER must differ from owner"
        );
        uint256 perTxCap = vm.envOr("STACK_PER_TX_CAP", uint256(1_000_000_000));
        uint256 dailyCap = vm.envOr("STACK_DAILY_CAP", uint256(25_000_000_000));

        vm.startBroadcast();

        NaveBridge lockboxImplementation = new NaveBridge();
        NaveBridge lockbox = NaveBridge(
            address(
                new ERC1967Proxy(
                    address(lockboxImplementation),
                    abi.encodeCall(
                        NaveBridge.initialize, (existing, deployOwner, relayer, perTxCap, dailyCap)
                    )
                )
            )
        );

        NaveStaking stakingImplementation = new NaveStaking();
        NaveStaking staking = NaveStaking(
            address(
                new ERC1967Proxy(
                    address(stakingImplementation),
                    abi.encodeCall(NaveStaking.initialize, (existing, deployOwner, relayer))
                )
            )
        );

        vm.stopBroadcast();

        require(address(lockbox.wnave()) == existing, "lockbox wnave mismatch");
        require(address(staking.stakingToken()) == existing, "staking token mismatch");

        console2.log("chainId       ", block.chainid);
        console2.log("WrappedNave   ", existing);
        console2.log("  (existing - minter NOT rotated in this script)");
        console2.log("  currentMinter", wnave.minter());
        console2.log("NaveBridge v2 ", address(lockbox));
        console2.log("NaveStaking v2", address(staking));
        console2.log("owner         ", deployOwner);
        console2.log("intendedOwner ", intendedOwner);
        console2.log("relayer       ", relayer);
        console2.log("NEXT: Safe calls wnave.setMinter(v2Lockbox); then lockbox.acceptMinterRole()");

        string memory root = "hardenedBridgeStack";
        vm.serializeUint(root, "chainId", block.chainid);
        vm.serializeAddress(root, "wrappedNave", existing);
        vm.serializeAddress(root, "naveBridge", address(lockbox));
        vm.serializeAddress(root, "naveBridgeImplementation", address(lockboxImplementation));
        vm.serializeAddress(root, "naveStaking", address(staking));
        vm.serializeAddress(root, "naveStakingImplementation", address(stakingImplementation));
        vm.serializeString(root, "proxyPattern", "uups-singleton+uups-dao-consent");
        vm.serializeString(root, "stack", "v2-uups-shared-wnave");
        vm.serializeString(root, "status", "primary-awaiting-minter-rotation");
        vm.serializeAddress(root, "legacyV1Lockbox", wnave.minter());
        vm.serializeAddress(root, "owner", deployOwner);
        vm.serializeAddress(root, "intendedOwner", intendedOwner);
        vm.serializeAddress(root, "relayer", relayer);
        vm.serializeUint(root, "perTxCap", perTxCap);
        string memory json = vm.serializeUint(root, "dailyCap", dailyCap);

        string memory path =
            string.concat("deployments/hardened-bridge-", vm.toString(block.chainid), ".json");
        vm.writeJson(json, path);
    }
}
