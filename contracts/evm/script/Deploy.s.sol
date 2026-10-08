// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {NaveProtocol} from "../src/NaveProtocol.sol";
import {NaveDAOFactory} from "../src/NaveDAOFactory.sol";
import {NaveTreasury} from "../src/NaveTreasury.sol";
import {NaveGovernor} from "../src/NaveGovernor.sol";
import {NaveExecution} from "../src/NaveExecution.sol";
import {NaveTokenDeployer} from "../src/NaveTokenDeployer.sol";
import {PythOracle} from "../src/oracle/PythOracle.sol";
import {Ownable2StepUpgradeable} from
    "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {NaveConstants} from "../src/libraries/NaveConstants.sol";
import {DaoImplRole} from "../src/libraries/NaveEnums.sol";
import {NaveAddressRegistry} from "./config/NaveAddressRegistry.sol";

/// @title Deploy
/// @notice Deploys the Nave EVM core: `NaveProtocol`, the three clone
/// implementations, `NaveTokenDeployer`, `PythOracle`, and `NaveDAOFactory`,
/// then wires the factory into the protocol. Designed for Ethereum (1) / Base
/// (8453) / Robinhood (4663) mainnets and Sepolia (11155111) / Base Sepolia
/// (84532) / Robinhood Testnet (46630) — the chain-id guard hard-rejects any
/// other EVM network (e.g. BSC 56).
///
/// Configure via env:
///   - PROTOCOL_OWNER, PROTOCOL_TREASURY (fee recipient)
///   - FORMATION_FEE_WEI, TOKEN_MINT_FEE_WEI
///   - PYTH_ADDRESS (per-chain Pyth contract)
///   - WRAPPED_NATIVE (optional override; defaults from NaveAddressRegistry)
///   - SAFE_ADDRESS + HANDOFF_TO_SAFE=true (optional one-shot Ownable2Step
///       authority handoff: starts transferOwnership(protocol+oracle) → Safe;
///       the Safe must call acceptOwnership() to finalize)
///
/// Writes a `deployments/<chainId>.json` artifact consumed by the EVM cutover
/// orchestrator (solana/scripts/evm-mainnet-cutover.mjs).
contract Deploy is Script {
    /// The only EVM chain ids Nave supports. Any other id aborts the deploy.
    function _assertSupportedChain() internal view {
        uint256 id = block.chainid;
        require(
            id == 1 || id == 8453 || id == 4663 || id == 11_155_111 || id == 84_532 || id == 46_630,
            "Deploy: unsupported EVM chain id (Nave supports 1, 8453, 4663, 11155111, 84532, 46630)"
        );
    }

    function run() external {
        _assertSupportedChain();

        address owner = vm.envAddress("PROTOCOL_OWNER");
        address protocolTreasury = vm.envAddress("PROTOCOL_TREASURY");
        uint256 formationFee = vm.envOr("FORMATION_FEE_WEI", uint256(0));
        uint256 tokenMintFee = vm.envOr("TOKEN_MINT_FEE_WEI", uint256(0));
        // Treasury-seed carve-out of the formation fee (deposited into each new
        // DAO treasury at creation). Devnet: 0.01 ETH all-to-seed; mainnet split
        // is configured at cutover (must be <= FORMATION_FEE_WEI).
        uint256 treasurySeed = vm.envOr("TREASURY_SEED_WEI", uint256(0));
        address pyth = vm.envAddress("PYTH_ADDRESS");
        bool handoff = vm.envOr("HANDOFF_TO_SAFE", false);
        address safe = vm.envOr("SAFE_ADDRESS", address(0));

        vm.startBroadcast();

        NaveProtocol protocolImplementation = new NaveProtocol();
        NaveProtocol protocol = NaveProtocol(payable(
            address(
                new ERC1967Proxy(
                    address(protocolImplementation),
                    abi.encodeCall(
                        NaveProtocol.initialize, (owner, protocolTreasury, formationFee, tokenMintFee)
                    )
                )
            )
        ));
        if (treasurySeed > 0) {
            // Owner-gated; the broadcasting key must be `owner`.
            protocol.setTreasurySeed(treasurySeed);
        }
        // Wire WETH so native treasury seeds / top-ups wrap instead of locking.
        address wrappedNative = vm.envOr("WRAPPED_NATIVE", NaveAddressRegistry.weth(block.chainid));
        if (wrappedNative != address(0)) {
            protocol.setWrappedNative(wrappedNative, NaveConstants.PYTH_ETH_USD_FEED_ID);
        }
        NaveTokenDeployer tokenDeployer = new NaveTokenDeployer();
        PythOracle oracleImplementation = new PythOracle();
        PythOracle oracle = PythOracle(
            address(
                new ERC1967Proxy(
                    address(oracleImplementation), abi.encodeCall(PythOracle.initialize, (pyth, owner))
                )
            )
        );

        address treasuryImpl = address(new NaveTreasury());
        address governorImpl = address(new NaveGovernor());
        address executionImpl = address(new NaveExecution());
        protocol.publishImplementation(uint8(DaoImplRole.Treasury), treasuryImpl);
        protocol.publishImplementation(uint8(DaoImplRole.Governor), governorImpl);
        protocol.publishImplementation(uint8(DaoImplRole.Execution), executionImpl);

        NaveDAOFactory factoryImplementation = new NaveDAOFactory();
        NaveDAOFactory factory = NaveDAOFactory(
            address(
                new ERC1967Proxy(
                    address(factoryImplementation),
                    abi.encodeCall(
                        NaveDAOFactory.initialize,
                        (owner, address(protocol), address(oracle), address(tokenDeployer))
                    )
                )
            )
        );

        // `setFactory` is owner-gated; the broadcasting key must be `owner` (or
        // run this leg from the owner/Safe separately).
        protocol.setFactory(address(factory));

        // Optional one-shot Safe authority handoff. Both proxy instances use
        // Ownable2Step (pending → accept), so the Safe finalizes each transfer.
        if (handoff) {
            require(safe != address(0), "Deploy: HANDOFF_TO_SAFE set but SAFE_ADDRESS is zero");
            protocol.transferOwnership(safe);
            oracle.transferOwnership(safe);
            factory.transferOwnership(safe);
        }

        vm.stopBroadcast();

        console2.log("chainId           ", block.chainid);
        console2.log("NaveProtocol      ", address(protocol));
        console2.log("protocolImpl      ", address(protocolImplementation));
        console2.log("NaveDAOFactory    ", address(factory));
        console2.log("factoryImpl       ", address(factoryImplementation));
        console2.log("PythOracle        ", address(oracle));
        console2.log("oracleImpl        ", address(oracleImplementation));
        console2.log("NaveTokenDeployer ", address(tokenDeployer));
        console2.log("Treasury impl     ", treasuryImpl);
        console2.log("Governor impl     ", governorImpl);
        console2.log("Execution impl    ", executionImpl);
        if (handoff) {
            console2.log("Ownership transfer STARTED to Safe (accept pending):", safe);
        }

        _writeArtifact(
            address(protocol),
            address(protocolImplementation),
            address(factory),
            address(factoryImplementation),
            address(oracle),
            address(oracleImplementation),
            address(tokenDeployer),
            treasuryImpl,
            governorImpl,
            executionImpl,
            handoff ? safe : owner
        );
    }

    /// Write deployments/<chainId>.json (addresses keyed by chain id) for the
    /// cutover orchestrator + app env wiring.
    function _writeArtifact(
        address protocol,
        address protocolImplementation,
        address factory,
        address factoryImplementation,
        address oracle,
        address oracleImplementation,
        address tokenDeployer,
        address treasuryImpl,
        address governorImpl,
        address executionImpl,
        address authority
    ) internal {
        string memory root = "deploy";
        vm.serializeUint(root, "chainId", block.chainid);
        vm.serializeString(root, "proxyPattern", "uups-singleton+uups-dao-consent");
        vm.serializeAddress(root, "protocol", protocol);
        vm.serializeAddress(root, "protocolImplementation", protocolImplementation);
        vm.serializeAddress(root, "factory", factory);
        vm.serializeAddress(root, "factoryImplementation", factoryImplementation);
        vm.serializeAddress(root, "oracle", oracle);
        vm.serializeAddress(root, "oracleImplementation", oracleImplementation);
        vm.serializeAddress(root, "tokenDeployer", tokenDeployer);
        vm.serializeAddress(root, "treasuryImplementation", treasuryImpl);
        vm.serializeAddress(root, "governorImplementation", governorImpl);
        // Keep legacy keys for older cutover readers.
        vm.serializeAddress(root, "treasuryImpl", treasuryImpl);
        vm.serializeAddress(root, "governorImpl", governorImpl);
        vm.serializeAddress(root, "executionImpl", executionImpl);
        string memory json = vm.serializeAddress(root, "executionImplementation", executionImpl);
        json = vm.serializeAddress(root, "authority", authority);

        string memory path = string.concat("deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(json, path);
    }
}
