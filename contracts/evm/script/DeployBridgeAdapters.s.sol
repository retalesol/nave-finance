// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {CctpBridgeAdapter} from "../src/adapters/CctpBridgeAdapter.sol";
import {OpStandardBridgeAdapter} from "../src/adapters/OpStandardBridgeAdapter.sol";
import {ArbitrumBridgeAdapter} from "../src/adapters/ArbitrumBridgeAdapter.sol";
import {NaveAddressRegistry} from "./config/NaveAddressRegistry.sol";

/// @title DeployBridgeAdapters
/// @notice Deploys capital-bridge adapters (CCTP / OP StandardBridge / Arbitrum
/// Nitro) for treasury bridge-out. Distinct from yield `DeployAdapters.s.sol`.
///
/// Required env:
///   NAVE_PROTOCOL — NaveProtocol on this chain
///
/// Selection flags (default false):
///   DEPLOY_CCTP, DEPLOY_OP_BRIDGE, DEPLOY_ARB_BRIDGE
///
/// Optional overrides:
///   CCTP_TOKEN_MESSENGER, ARB_GATEWAY_ROUTER, OP_BRIDGE, OP_REMOTE_WETH,
///   OP_MIN_GAS_LIMIT, ARB_BRIDGEABLE_WETH
contract DeployBridgeAdapters is Script {
    struct Deployed {
        address cctp;
        address opBridge;
        address arbBridge;
    }

    function run() external {
        uint256 chainId = block.chainid;
        NaveAddressRegistry.ChainConfig memory cfg = NaveAddressRegistry.config(chainId);
        address protocol = vm.envAddress("NAVE_PROTOCOL");
        require(protocol != address(0), "DeployBridgeAdapters: NAVE_PROTOCOL unset");

        bool doCctp = vm.envOr("DEPLOY_CCTP", false);
        bool doOp = vm.envOr("DEPLOY_OP_BRIDGE", false);
        bool doArb = vm.envOr("DEPLOY_ARB_BRIDGE", false);

        Deployed memory out;

        vm.startBroadcast();

        if (doCctp) {
            require(cfg.usdc != address(0), "DeployBridgeAdapters: no USDC on this chain");
            (uint256[] memory destIds, uint32[] memory domains) = _cctpDestinations(chainId);
            require(destIds.length > 0, "DeployBridgeAdapters: no CCTP destinations");
            bool defaultV2 = chainId == NaveAddressRegistry.ARC_TESTNET
                || chainId == NaveAddressRegistry.SEPOLIA;
            bool messengerV2 = vm.envOr("CCTP_MESSENGER_V2", defaultV2);
            address defaultMessenger = messengerV2
                ? NaveAddressRegistry.CCTP_TOKEN_MESSENGER_V2
                : NaveAddressRegistry.CCTP_TOKEN_MESSENGER;
            address messenger = vm.envOr("CCTP_TOKEN_MESSENGER", defaultMessenger);
            out.cctp = address(
                new CctpBridgeAdapter(
                    protocol, messenger, cfg.usdc, chainId, destIds, domains, messengerV2
                )
            );
        }

        if (doOp) {
            require(
                chainId == NaveAddressRegistry.ETHEREUM || chainId == NaveAddressRegistry.BASE,
                "DeployBridgeAdapters: OP bridge only on Eth/Base"
            );
            bool isL2 = chainId == NaveAddressRegistry.BASE;
            address bridge = vm.envOr(
                "OP_BRIDGE",
                isL2
                    ? NaveAddressRegistry.BASE_L2_STANDARD_BRIDGE
                    : NaveAddressRegistry.ETH_L1_STANDARD_BRIDGE_BASE
            );
            uint256 remoteId = isL2 ? NaveAddressRegistry.ETHEREUM : NaveAddressRegistry.BASE;
            address remoteWeth = vm.envOr(
                "OP_REMOTE_WETH",
                isL2 ? NaveAddressRegistry.weth(NaveAddressRegistry.ETHEREUM) : NaveAddressRegistry.weth(NaveAddressRegistry.BASE)
            );
            uint32 minGas = uint32(vm.envOr("OP_MIN_GAS_LIMIT", uint256(200_000)));
            out.opBridge = address(
                new OpStandardBridgeAdapter(
                    protocol, bridge, cfg.weth, remoteWeth, chainId, remoteId, isL2, minGas
                )
            );
        }

        if (doArb) {
            require(
                chainId == NaveAddressRegistry.ROBINHOOD
                    || chainId == NaveAddressRegistry.ROBINHOOD_TESTNET,
                "DeployBridgeAdapters: Arb bridge only on Robinhood"
            );
            require(cfg.weth != address(0), "DeployBridgeAdapters: no WETH on Robinhood");
            address gateway = vm.envOr("ARB_GATEWAY_ROUTER", NaveAddressRegistry.ARB_L2_GATEWAY_ROUTER);
            address bridgeable = vm.envOr("ARB_BRIDGEABLE_WETH", cfg.weth);
            out.arbBridge = address(
                new ArbitrumBridgeAdapter(
                    protocol,
                    gateway,
                    cfg.weth,
                    bridgeable,
                    chainId,
                    NaveAddressRegistry.ETHEREUM
                )
            );
        }

        vm.stopBroadcast();

        console2.log("chainId              ", chainId);
        console2.log("NaveProtocol         ", protocol);
        console2.log("CctpBridgeAdapter    ", out.cctp);
        console2.log("OpStandardBridgeAdapter", out.opBridge);
        console2.log("ArbitrumBridgeAdapter", out.arbBridge);

        _writeArtifact(chainId, protocol, out);
    }

    function _cctpDestinations(uint256 chainId)
        internal
        pure
        returns (uint256[] memory destIds, uint32[] memory domains)
    {
        if (chainId == NaveAddressRegistry.ETHEREUM) {
            destIds = new uint256[](1);
            domains = new uint32[](1);
            destIds[0] = NaveAddressRegistry.BASE;
            domains[0] = NaveAddressRegistry.CCTP_DOMAIN_BASE;
            return (destIds, domains);
        }
        if (chainId == NaveAddressRegistry.BASE) {
            destIds = new uint256[](1);
            domains = new uint32[](1);
            destIds[0] = NaveAddressRegistry.ETHEREUM;
            domains[0] = NaveAddressRegistry.CCTP_DOMAIN_ETHEREUM;
            return (destIds, domains);
        }
        // Arc burns USDC toward Sepolia (CCTP domain 0). Domain 0 is valid.
        if (chainId == NaveAddressRegistry.ARC_TESTNET) {
            destIds = new uint256[](1);
            domains = new uint32[](1);
            destIds[0] = NaveAddressRegistry.SEPOLIA;
            domains[0] = NaveAddressRegistry.CCTP_DOMAIN_ETHEREUM;
            return (destIds, domains);
        }
        // Return leg: Sepolia burns toward Arc (domain 26), then Aave V3 stays on Sepolia.
        if (chainId == NaveAddressRegistry.SEPOLIA) {
            destIds = new uint256[](1);
            domains = new uint32[](1);
            destIds[0] = NaveAddressRegistry.ARC_TESTNET;
            domains[0] = NaveAddressRegistry.CCTP_DOMAIN_ARC;
            return (destIds, domains);
        }
        // Robinhood testnet USDC is unpublished, so CCTP stays empty (cfg.usdc == 0
        // also skips the deploy). Do not invent a domain.
        destIds = new uint256[](0);
        domains = new uint32[](0);
    }

    function _writeArtifact(uint256 chainId, address protocol, Deployed memory out) internal {
        string memory root = "bridgeAdapters";
        vm.serializeUint(root, "chainId", chainId);
        vm.serializeAddress(root, "protocol", protocol);
        vm.serializeAddress(root, "cctpBridgeAdapter", out.cctp);
        vm.serializeAddress(root, "opStandardBridgeAdapter", out.opBridge);
        string memory json = vm.serializeAddress(root, "arbitrumBridgeAdapter", out.arbBridge);
        string memory path =
            string.concat("deployments/bridge-adapters-", vm.toString(chainId), ".json");
        vm.writeJson(json, path);
    }
}
