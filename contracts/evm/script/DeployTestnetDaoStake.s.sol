// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {NaveDaoStake} from "../src/NaveDaoStake.sol";
import {NaveProtocol} from "../src/NaveProtocol.sol";

/// @title DeployTestnetDaoStake
/// @notice Deploys `NaveDaoStake` for an existing testnet protocol and, when
/// the broadcaster is the protocol owner, wires it. Testnet owner stays the
/// deployer EOA. `DeployDaoStake.s.sol` remains the Safe-only mainnet path.
///
/// Canonical wNAVE (hardened-bridge artifacts, not portal or older staking
/// tokens):
///   - Sepolia 11155111:      0x1d1d988e8ffE542f1f8F7932DE3A634251D4A042
///   - Base Sepolia 84532:    0xC286e67D59F643a725cf4998af6Bb4f8D1354280
///   - Robinhood testnet 46630: 0x7860FF876b49a5A992a7F3a4a6043ea57f17eD96
/// Arc testnet has no wNAVE. The default there is a zero-stake exception
/// (`STAKE_TOKEN=0`, `REQUIRED_STAKE=0`) until a canonical token exists.
///
/// Env (all optional except where the chain has no default):
///   - PROTOCOL         current NaveProtocol proxy
///   - STAKE_TOKEN      canonical wNAVE
///   - REQUIRED_STAKE   base units, 6 decimals. Default 100_000 (0.1 wNAVE)
///                      on chains with a token, 0 on Arc
///   - STACK_OWNER      defaults to the broadcaster (testnet EOA)
contract DeployTestnetDaoStake is Script {
    address internal constant SEPOLIA_PROTOCOL = 0x8D6dFa14Ac28077E3C746C10Fb40C0C424f848D1;
    address internal constant SEPOLIA_WNAVE = 0x1d1d988e8ffE542f1f8F7932DE3A634251D4A042;
    address internal constant BASE_SEPOLIA_PROTOCOL = 0xF37271a4A120eD904543bbE648D2f64Fa27b3bC6;
    address internal constant BASE_SEPOLIA_WNAVE = 0xC286e67D59F643a725cf4998af6Bb4f8D1354280;
    address internal constant ROBINHOOD_TESTNET_WNAVE = 0x7860FF876b49a5A992a7F3a4a6043ea57f17eD96;

    function run() external {
        uint256 chainId = block.chainid;
        address protocolAddr = vm.envOr("PROTOCOL", _defaultProtocol(chainId));
        address stakeToken = vm.envOr("STAKE_TOKEN", _defaultToken(chainId));
        uint256 required = vm.envOr("REQUIRED_STAKE", _defaultRequired(chainId));
        address owner_ = vm.envOr("STACK_OWNER", msg.sender);

        require(protocolAddr != address(0) && protocolAddr.code.length > 0, "PROTOCOL");
        require(owner_ != address(0), "STACK_OWNER");
        if (required > 0) {
            require(stakeToken != address(0), "STAKE_TOKEN required when REQUIRED_STAKE > 0");
        }

        vm.startBroadcast();
        NaveDaoStake impl = new NaveDaoStake();
        NaveDaoStake stake = NaveDaoStake(
            address(
                new ERC1967Proxy(
                    address(impl), abi.encodeCall(NaveDaoStake.initialize, (owner_, protocolAddr))
                )
            )
        );

        NaveProtocol protocol = NaveProtocol(payable(protocolAddr));
        bool wired = protocol.owner() == msg.sender;
        if (wired) {
            protocol.setDaoStake(address(stake));
            protocol.setNaveStakeConfig(stakeToken, required);
        }
        vm.stopBroadcast();

        console2.log("chainId", chainId);
        console2.log("daoStakeImplementation", address(impl));
        console2.log("daoStake", address(stake));
        console2.log("owner", owner_);
        console2.log("protocol", protocolAddr);
        console2.log("stakeToken", stakeToken);
        console2.log("requiredStake", required);
        console2.log("wired", wired);

        _writeArtifact(chainId, protocolAddr, address(impl), address(stake), owner_, stakeToken, required, wired);
    }

    function _defaultProtocol(uint256 chainId) internal pure returns (address) {
        if (chainId == 11_155_111) return SEPOLIA_PROTOCOL;
        if (chainId == 84_532) return BASE_SEPOLIA_PROTOCOL;
        return address(0);
    }

    function _defaultToken(uint256 chainId) internal pure returns (address) {
        if (chainId == 11_155_111) return SEPOLIA_WNAVE;
        if (chainId == 84_532) return BASE_SEPOLIA_WNAVE;
        if (chainId == 46_630) return ROBINHOOD_TESTNET_WNAVE;
        return address(0);
    }

    /// 0.1 wNAVE (6 decimals) on chains that have a canonical token.
    /// Arc (5042002) stays at 0 until a wNAVE exists.
    function _defaultRequired(uint256 chainId) internal pure returns (uint256) {
        if (chainId == 5_042_002) return 0;
        return 100_000;
    }

    function _writeArtifact(
        uint256 chainId,
        address protocol,
        address implementation,
        address stake,
        address owner_,
        address stakeToken,
        uint256 required,
        bool wired
    ) internal {
        string memory root = "daoStake";
        vm.serializeUint(root, "chainId", chainId);
        vm.serializeAddress(root, "protocol", protocol);
        vm.serializeAddress(root, "daoStakeImplementation", implementation);
        vm.serializeAddress(root, "daoStake", stake);
        vm.serializeAddress(root, "owner", owner_);
        vm.serializeAddress(root, "stakeToken", stakeToken);
        vm.serializeUint(root, "requiredStake", required);
        string memory json = vm.serializeBool(root, "wired", wired);
        vm.writeJson(json, string.concat("deployments/dao-stake-", vm.toString(chainId), ".json"));
    }
}
