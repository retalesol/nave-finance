// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {AaveV3Adapter} from "../src/adapters/AaveV3Adapter.sol";
import {CompoundV3Adapter} from "../src/adapters/CompoundV3Adapter.sol";
import {BalancerAdapter} from "../src/adapters/BalancerAdapter.sol";
import {NaveProtocol} from "../src/NaveProtocol.sol";
import {NaveAddressRegistry} from "./config/NaveAddressRegistry.sol";

/// @title DeployAdapters
/// @notice Deploys Nave strategy adapters (Aave v3, Compound v3,
/// Balancer v2) for a given chain, sourcing protocol
/// singletons from {NaveAddressRegistry} and pool-specific args from env. Run
/// AFTER `Deploy.s.sol` has deployed `NaveProtocol`. Supports the four EVM
/// chains Nave ships: Ethereum (1), Base (8453), Sepolia (11155111), Base
/// Sepolia (84532). Any other chain id aborts.
///
/// Adapters are NOT auto-approved for any DAO. Two gates apply:
///   1. Protocol allowlist — `NaveProtocol.setAdapterApproved(adapter, true)`
///      (protocol owner). A DAO constitution may only reference adapters on
///      this list. Set `APPROVE_ON_PROTOCOL=true` to have this script perform
///      the call when the broadcaster IS the protocol owner; otherwise the
///      owner (Safe) must submit it separately.
///   2. Each DAO's founder must add the adapter to its constitution
///      (`NaveTreasury.updateConstitution`) before the execution pipeline can
///      deploy capital into it.
///
/// ── Required env ──────────────────────────────────────────────────────────
///   NAVE_PROTOCOL        deployed NaveProtocol address (constructor arg #1 of
///                        every adapter; gates `deposit`/`withdraw` to that
///                        protocol's registered `NaveExecution` clones)
///
/// ── Selection flags (default false; set to true to deploy that adapter) ─────
///   DEPLOY_AAVE, DEPLOY_COMPOUND, DEPLOY_BALANCER
///   APPROVE_ON_PROTOCOL  also call `NaveProtocol.setAdapterApproved` for each
///                        deployed adapter (broadcaster must be protocol owner)
///
/// ── Per-chain constructor args ──────────────────────────────────────────────
/// Aave v3   AaveV3Adapter(NAVE_PROTOCOL, registry.aaveV3Pool)
///           Ethereum pool 0x8787...4E2  Base pool 0xA238...1c5
/// Compound  CompoundV3Adapter(NAVE_PROTOCOL, registry.compoundCometUsdc)
///           Ethereum cUSDCv3 0xc3d6...dc3  Base cUSDCv3 0xb125...b2F
///           (baseToken() is read from the Comet at construction)
/// Balancer  BalancerAdapter(NAVE_PROTOCOL, registry.balancerVault, BALANCER_POOL_ID,
///                           BALANCER_BPT, BALANCER_ROUTED_ASSET, BALANCER_ASSET_INDEX,
///                           BALANCER_TOKEN_COUNT)
///           Current adapter targets Balancer v2 Vault join/exit. Sepolia's
///           official Balancer v3 Vault/factories are not ABI-compatible here,
///           so testnet Balancer is skipped until a compatible v2 pool target is
///           validated. EVM-C2: the adapter now prices its BPT position via the
///           pool's `getRate()` (manipulation-resistant vs. raw pool balances),
///           so BALANCER_BPT/BALANCER_POOL_ID MUST point at a Stable /
///           ComposableStable / MetaStable / Linear pool that implements
///           `getRate()` — a plain (non-rate-provider) Weighted Pool (e.g. the
///           previously-referenced 50 USDC / 50 WETH pool) is NOT supported and
///           will revert on deposit/withdraw.
/// Curve is intentionally omitted until a vetted deployment/pool exists.
contract DeployAdapters is Script {
    struct Deployed {
        address aave;
        address compound;
        address balancer;
    }

    function run() external {
        uint256 chainId = block.chainid;
        NaveAddressRegistry.ChainConfig memory cfg = NaveAddressRegistry.config(chainId);

        address protocol = vm.envAddress("NAVE_PROTOCOL");
        require(protocol != address(0), "DeployAdapters: NAVE_PROTOCOL unset");

        bool doAave = vm.envOr("DEPLOY_AAVE", false);
        bool doCompound = vm.envOr("DEPLOY_COMPOUND", false);
        bool doBalancer = vm.envOr("DEPLOY_BALANCER", false);

        Deployed memory out;

        vm.startBroadcast();

        if (doAave) {
            require(cfg.aaveV3Pool != address(0), "DeployAdapters: no Aave Pool on this chain");
            out.aave = address(new AaveV3Adapter(protocol, cfg.aaveV3Pool));
        }

        if (doCompound) {
            require(cfg.compoundCometUsdc != address(0), "DeployAdapters: no Comet on this chain");
            out.compound = address(new CompoundV3Adapter(protocol, cfg.compoundCometUsdc));
        }

        if (doBalancer) {
            require(cfg.balancerVault != address(0), "DeployAdapters: no Balancer Vault");
            out.balancer = address(
                new BalancerAdapter(
                    protocol,
                    cfg.balancerVault,
                    vm.envBytes32("BALANCER_POOL_ID"),
                    vm.envAddress("BALANCER_BPT"),
                    vm.envAddress("BALANCER_ROUTED_ASSET"),
                    vm.envUint("BALANCER_ASSET_INDEX"),
                    vm.envUint("BALANCER_TOKEN_COUNT")
                )
            );
        }

        if (vm.envOr("APPROVE_ON_PROTOCOL", false)) {
            NaveProtocol p = NaveProtocol(payable(protocol));
            require(
                p.owner() == msg.sender,
                "DeployAdapters: APPROVE_ON_PROTOCOL requires broadcaster == protocol owner"
            );
            if (out.aave != address(0)) p.setAdapterApproved(out.aave, true);
            if (out.compound != address(0)) p.setAdapterApproved(out.compound, true);
            if (out.balancer != address(0)) p.setAdapterApproved(out.balancer, true);
        }

        vm.stopBroadcast();

        console2.log("chainId          ", chainId);
        console2.log("NaveProtocol     ", protocol);
        console2.log("AaveV3Adapter    ", out.aave);
        console2.log("CompoundV3Adapter", out.compound);
        console2.log("BalancerAdapter  ", out.balancer);

        _writeArtifact(chainId, protocol, out);
    }

    /// Write deployments/adapters-<chainId>.json for the cutover orchestrator and
    /// app constitution wiring.
    function _writeArtifact(uint256 chainId, address protocol, Deployed memory out) internal {
        string memory root = "adapters";
        vm.serializeUint(root, "chainId", chainId);
        vm.serializeAddress(root, "protocol", protocol);
        vm.serializeAddress(root, "aaveV3Adapter", out.aave);
        vm.serializeAddress(root, "compoundV3Adapter", out.compound);
        string memory json = vm.serializeAddress(root, "balancerAdapter", out.balancer);

        string memory path = string.concat("deployments/adapters-", vm.toString(chainId), ".json");
        vm.writeJson(json, path);
    }
}
