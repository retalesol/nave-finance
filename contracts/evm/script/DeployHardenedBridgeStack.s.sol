// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {WrappedNave} from "../src/WrappedNave.sol";
import {NaveBridge} from "../src/NaveBridge.sol";
import {NaveStaking} from "../src/NaveStaking.sol";

/// @title DeployHardenedBridgeStack
/// @notice One-shot deployment of the full hardened bridge stack:
///   1. WrappedNave (mintable/burnable/freezable/controllable wNAVE, 6 decimals)
///   2. NaveBridge lockbox (sole minter: pause + caps + replay guards)
///   3. NaveStaking mirror (stake wNAVE, relayer-funded rewards)
///   4. Wiring: minter rotated to the lockbox (two-step), supplyCap set.
///
/// Ownership posture:
///   - Constructor `owner` is ALWAYS the broadcaster so post-deploy wiring
///     (`setMinter` / `acceptMinterRole` / `setSupplyCap`) can succeed in the
///     same broadcast. Those calls are `onlyOwner`.
///   - Testnets: broadcaster remains the lasting owner (fast iteration).
///   - Mainnets: `STACK_OWNER` MUST be set to the Safe multisig (cutover
///     defaults it from `SAFE_ADDRESS`). It is recorded as `intendedOwner` in
///     the artifact; the separate cutover `--phase handoff` proposes
///     `transferOwnership(Safe)`, and the Safe finalizes with `acceptOwnership()`.
///     This script does NOT auto-handoff (matches cutover "never auto-handoff
///     on deploy").
///
/// Configure via env:
///   - STACK_OWNER        intended final admin (REQUIRED on mainnet = Safe;
///                        ignored as constructor owner; defaults to broadcaster
///                        on testnet for the artifact field)
///   - STACK_RELAYER      relayer EOA for bridgeIn/notifyReward (REQUIRED; must
///                        differ from the broadcaster and STACK_OWNER — the
///                        lockbox/staking reject relayer == owner)
///   - STACK_SUPPLY_CAP   wNAVE hard supply cap in base units (default 100_000 NAVE)
///   - STACK_PER_TX_CAP   lockbox per-tx net mint cap (default 1_000 NAVE)
///   - STACK_DAILY_CAP    lockbox rolling 24h net mint cap (default 10_000 NAVE)
///
/// Writes `deployments/hardened-bridge-<chainId>.json`.
contract DeployHardenedBridgeStack is Script {
    function _isTestnet() internal view returns (bool) {
        uint256 id = block.chainid;
        return id == 11_155_111 || id == 84_532 || id == 46_630;
    }

    function _isMainnet() internal view returns (bool) {
        uint256 id = block.chainid;
        return id == 1 || id == 8453 || id == 4663;
    }

    function _assertSupportedChain() internal view {
        require(_isTestnet() || _isMainnet(), "DeployHardenedBridgeStack: unsupported chain id");
    }

    /// Current on-chain owner at the end of this script (= broadcaster).
    function _resolveDeployOwner() internal view returns (address) {
        return msg.sender;
    }

    /// Intended lasting owner after cutover handoff. Mainnet requires Safe via
    /// `STACK_OWNER`; testnet keeps the broadcaster.
    function _resolveIntendedOwner() internal view returns (address) {
        if (_isTestnet()) {
            return msg.sender;
        }
        address intended = vm.envAddress("STACK_OWNER");
        require(intended != address(0), "DeployHardenedBridgeStack: STACK_OWNER is zero");
        require(
            intended != msg.sender,
            "DeployHardenedBridgeStack: STACK_OWNER must be Safe, not the deploy wallet"
        );
        return intended;
    }

    /// @dev Backward-compatible alias used by gate tests: mainnet still requires
    /// `STACK_OWNER` (intended Safe), testnet returns the broadcaster.
    function _resolveOwner() internal view returns (address) {
        return _resolveIntendedOwner();
    }

    /// Relayer hot key (bridgeIn / notifyReward). REQUIRED and must differ from
    /// both the deploy-time owner and the intended Safe: `NaveBridge` /
    /// `NaveStaking.initialize` revert `PrivilegedRolesMustDiffer` when
    /// relayer == owner, so fail here with a readable reason instead.
    function _resolveRelayer(address deployOwner, address intendedOwner)
        internal
        view
        returns (address relayer)
    {
        relayer = vm.envAddress("STACK_RELAYER");
        require(relayer != address(0), "DeployHardenedBridgeStack: STACK_RELAYER is zero");
        require(
            relayer != deployOwner && relayer != intendedOwner,
            "DeployHardenedBridgeStack: STACK_RELAYER must differ from owner"
        );
    }

    function run() external {
        _assertSupportedChain();

        address deployOwner = _resolveDeployOwner();
        address intendedOwner = _resolveIntendedOwner();
        address relayer = _resolveRelayer(deployOwner, intendedOwner);
        // 6-decimal base units. Defaults mirror the Solana devnet config.
        uint256 supplyCap = vm.envOr("STACK_SUPPLY_CAP", uint256(100_000_000_000)); // 100k NAVE
        uint256 perTxCap = vm.envOr("STACK_PER_TX_CAP", uint256(1_000_000_000)); // 1k NAVE
        uint256 dailyCap = vm.envOr("STACK_DAILY_CAP", uint256(25_000_000_000)); // 25k NAVE

        vm.startBroadcast();

        // 1. Token (owner + temporary minter = deployer). Name/symbol are the
        // user-facing on-chain identity of the mirror token: "Wrapped Nave
        // Shares" / "wNAVE" (case-sensitive) — distinct from the Solana home
        // token so explorers show the wrapped share, not a duplicate "NAVE".
        WrappedNave wnaveImplementation = new WrappedNave();
        WrappedNave wnave = WrappedNave(
            address(
                new ERC1967Proxy(
                    address(wnaveImplementation),
                    abi.encodeCall(
                        WrappedNave.initialize,
                        ("Wrapped Nave Shares", "wNAVE", uint8(6), deployOwner, msg.sender)
                    )
                )
            )
        );

        // 2. Lockbox (owner = deploy wallet so acceptMinterRole works; Safe
        // handoff is a later cutover phase).
        NaveBridge lockboxImplementation = new NaveBridge();
        NaveBridge lockbox = NaveBridge(
            address(
                new ERC1967Proxy(
                    address(lockboxImplementation),
                    abi.encodeCall(
                        NaveBridge.initialize, (address(wnave), deployOwner, relayer, perTxCap, dailyCap)
                    )
                )
            )
        );

        // 3. Staking mirror.
        NaveStaking stakingImplementation = new NaveStaking();
        NaveStaking staking = NaveStaking(
            address(
                new ERC1967Proxy(
                    address(stakingImplementation),
                    abi.encodeCall(NaveStaking.initialize, (address(wnave), deployOwner, relayer))
                )
            )
        );

        // 4. Wiring: two-step minter rotation to the lockbox + supply cap.
        // Requires deployOwner == msg.sender (constructor owner above).
        wnave.setMinter(address(lockbox));
        lockbox.acceptMinterRole();
        wnave.setSupplyCap(supplyCap);

        vm.stopBroadcast();

        require(wnave.minter() == address(lockbox), "minter rotation failed");
        require(wnave.owner() == deployOwner, "unexpected token owner");
        require(lockbox.owner() == deployOwner, "unexpected lockbox owner");
        require(staking.owner() == deployOwner, "unexpected staking owner");

        console2.log("chainId       ", block.chainid);
        console2.log("WrappedNave   ", address(wnave));
        console2.log("NaveBridge    ", address(lockbox));
        console2.log("NaveStaking   ", address(staking));
        console2.log("owner         ", deployOwner);
        console2.log("intendedOwner ", intendedOwner);
        console2.log("relayer       ", relayer);

        string memory root = "hardenedBridgeStack";
        vm.serializeUint(root, "chainId", block.chainid);
        vm.serializeAddress(root, "wrappedNave", address(wnave));
        vm.serializeAddress(root, "wrappedNaveImplementation", address(wnaveImplementation));
        vm.serializeAddress(root, "naveBridge", address(lockbox));
        vm.serializeAddress(root, "naveBridgeImplementation", address(lockboxImplementation));
        vm.serializeAddress(root, "naveStaking", address(staking));
        vm.serializeAddress(root, "naveStakingImplementation", address(stakingImplementation));
        vm.serializeString(root, "proxyPattern", "uups-singleton+uups-dao-consent");
        vm.serializeAddress(root, "owner", deployOwner);
        vm.serializeAddress(root, "intendedOwner", intendedOwner);
        vm.serializeAddress(root, "relayer", relayer);
        vm.serializeUint(root, "supplyCap", supplyCap);
        vm.serializeUint(root, "perTxCap", perTxCap);
        string memory json = vm.serializeUint(root, "dailyCap", dailyCap);

        string memory path =
            string.concat("deployments/hardened-bridge-", vm.toString(block.chainid), ".json");
        vm.writeJson(json, path);
    }
}
