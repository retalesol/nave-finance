// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {NaveProtocol} from "../src/NaveProtocol.sol";
import {NaveDAOFactory} from "../src/NaveDAOFactory.sol";
import {NaveTreasury} from "../src/NaveTreasury.sol";
import {NaveGovernor} from "../src/NaveGovernor.sol";
import {NaveExecution} from "../src/NaveExecution.sol";
import {NaveTokenDeployer} from "../src/NaveTokenDeployer.sol";
import {PythOracle} from "../src/oracle/PythOracle.sol";
import {TestnetPegOracle} from "../src/oracle/TestnetPegOracle.sol";
import {NaveConstants} from "../src/libraries/NaveConstants.sol";
import {DaoImplRole} from "../src/libraries/NaveEnums.sol";
import {NaveAddressRegistry} from "./config/NaveAddressRegistry.sol";

/// @title DeployDeterministicStack
/// @notice Deploys one Nave factory and the treasury/governor/execution
/// implementations at the same addresses on every testnet, via Arachnid's
/// canonical CREATE2 deployer (`0x4e59…956C`).
///
/// Same-address treasuries need more than a shared salt. {NaveERC1967Proxy}
/// embeds the implementation address in its creation code (the same constraint
/// EIP-1167 minimal proxies have). The factory address is the CREATE2 deployer
/// of those proxies. Both must match across chains or
/// `keccak256(abi.encode(founder, slug))` still yields different treasuries.
/// Already-deployed factories keep their old chain-scoped salt; this script
/// does not move them and does not touch mainnet.
///
/// The factory proxy's own init args must also be identical, so this script
/// initializes it with the deterministic PythOracle *implementation* as a
/// placeholder and then {NaveDAOFactory.setOracle} to the chain-local oracle.
/// `PROTOCOL_OWNER`, `PROTOCOL_TREASURY`, and the fee env values must be the
/// same on every chain or the proxy addresses diverge.
///
/// Env (never printed):
///   EVM_DEPLOY_PRIVATE_KEY   broadcaster; must be PROTOCOL_OWNER
///   PROTOCOL_OWNER           shared owner address
///   PROTOCOL_TREASURY        shared revenue wallet
///   RELAYER_ADDRESS          protocol relayer (defaults to the broadcaster)
///   FORMATION_FEE_WEI        default 0; must match across chains
///   TOKEN_MINT_FEE_WEI       default 0; must match across chains
///
/// Testnets only: 11155111, 84532, 46630, 5042002.
contract DeployDeterministicStack is Script {
    /// Arachnid deterministic deployment proxy. Same address on every chain.
    address internal constant CANONICAL_CREATE2 = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    /// Pre-signed keyless deployment of {CANONICAL_CREATE2}. Public, not a Nave key.
    bytes internal constant CANONICAL_CREATE2_TX =
        hex"f8a58085174876e800830186a08080b853604580600e600039806000f350fe7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf31ba02222222222222222222222222222222222222222222222222222222222222222a02222222222222222222222222222222222222222222222222222222222222222";

    bytes32 internal constant SALT_PROTOCOL_IMPL = keccak256("nave.deterministic.protocol.impl.v1");
    bytes32 internal constant SALT_PROTOCOL_PROXY = keccak256("nave.deterministic.protocol.proxy.v1");
    bytes32 internal constant SALT_FACTORY_IMPL = keccak256("nave.deterministic.factory.impl.v1");
    bytes32 internal constant SALT_FACTORY_PROXY = keccak256("nave.deterministic.factory.proxy.v1");
    bytes32 internal constant SALT_TREASURY_IMPL = keccak256("nave.deterministic.treasury.impl.v1");
    bytes32 internal constant SALT_GOVERNOR_IMPL = keccak256("nave.deterministic.governor.impl.v1");
    bytes32 internal constant SALT_EXECUTION_IMPL = keccak256("nave.deterministic.execution.impl.v1");
    bytes32 internal constant SALT_TOKEN_DEPLOYER = keccak256("nave.deterministic.token-deployer.v1");
    bytes32 internal constant SALT_PYTH_IMPL = keccak256("nave.deterministic.pyth-oracle.impl.v1");

    function run() external {
        uint256 id = block.chainid;
        require(
            id == 11_155_111 || id == 84_532 || id == 46_630 || id == 5_042_002,
            "DeployDeterministicStack: testnets only (11155111, 84532, 46630, 5042002)"
        );

        address owner = vm.envAddress("PROTOCOL_OWNER");
        address protocolTreasury = vm.envAddress("PROTOCOL_TREASURY");
        uint256 formationFee = vm.envOr("FORMATION_FEE_WEI", uint256(0));
        uint256 tokenMintFee = vm.envOr("TOKEN_MINT_FEE_WEI", uint256(0));
        address relayer = vm.envOr("RELAYER_ADDRESS", msg.sender);
        require(owner != address(0) && protocolTreasury != address(0), "owner and revenue wallet required");
        require(relayer != address(0), "relayer required");
        require(relayer != protocolTreasury, "relayer and revenue wallet must be different addresses");

        _ensureCanonicalDeployer();

        vm.startBroadcast();

        address protocolImpl = _deploy(SALT_PROTOCOL_IMPL, type(NaveProtocol).creationCode);
        address factoryImpl = _deploy(SALT_FACTORY_IMPL, type(NaveDAOFactory).creationCode);
        address treasuryImpl = _deploy(SALT_TREASURY_IMPL, type(NaveTreasury).creationCode);
        address governorImpl = _deploy(SALT_GOVERNOR_IMPL, type(NaveGovernor).creationCode);
        address executionImpl = _deploy(SALT_EXECUTION_IMPL, type(NaveExecution).creationCode);
        address tokenDeployer = _deploy(SALT_TOKEN_DEPLOYER, type(NaveTokenDeployer).creationCode);
        address pythImpl = _deploy(SALT_PYTH_IMPL, type(PythOracle).creationCode);

        address protocolProxy = _deploy(
            SALT_PROTOCOL_PROXY,
            abi.encodePacked(
                type(ERC1967Proxy).creationCode,
                abi.encode(
                    protocolImpl,
                    abi.encodeCall(NaveProtocol.initialize, (owner, protocolTreasury, formationFee, tokenMintFee))
                )
            )
        );
        // Placeholder oracle is the shared Pyth implementation address so the
        // factory proxy init code matches on every chain. setOracle below
        // points the factory at this chain's real oracle.
        address factoryProxy = _deploy(
            SALT_FACTORY_PROXY,
            abi.encodePacked(
                type(ERC1967Proxy).creationCode,
                abi.encode(
                    factoryImpl,
                    abi.encodeCall(
                        NaveDAOFactory.initialize, (owner, protocolProxy, pythImpl, tokenDeployer)
                    )
                )
            )
        );

        NaveProtocol protocol = NaveProtocol(payable(protocolProxy));
        NaveDAOFactory factory = NaveDAOFactory(factoryProxy);

        address oracleAddress = factory.oracle();
        // The proxy is initialized with the shared Pyth implementation as a
        // placeholder. Replace it once, then leave the chain-local oracle in
        // place on later runs.
        if (oracleAddress == pythImpl || oracleAddress.code.length == 0) {
            oracleAddress = _deployChainOracle(owner);
        }
        if (factory.oracle() != oracleAddress) factory.setOracle(oracleAddress);

        address wrappedNative = vm.envOr("WRAPPED_NATIVE", NaveAddressRegistry.weth(block.chainid));
        if (wrappedNative != address(0) && wrappedNative.code.length > 0) {
            if (protocol.wrappedNative() != wrappedNative) {
                protocol.setWrappedNative(wrappedNative, NaveConstants.PYTH_ETH_USD_FEED_ID);
            }
        }

        protocol.publishImplementation(uint8(DaoImplRole.Treasury), treasuryImpl);
        protocol.publishImplementation(uint8(DaoImplRole.Governor), governorImpl);
        protocol.publishImplementation(uint8(DaoImplRole.Execution), executionImpl);

        if (protocol.factory() == address(0)) {
            protocol.setFactory(factoryProxy);
        } else if (protocol.factory() != factoryProxy) {
            protocol.updateFactory(factoryProxy);
        }
        if (protocol.relayer() != relayer) protocol.setRelayer(relayer);

        vm.stopBroadcast();

        console2.log("chainId              ", block.chainid);
        console2.log("canonical CREATE2     ", CANONICAL_CREATE2);
        console2.log("NaveProtocol          ", protocolProxy);
        console2.log("protocolImpl          ", protocolImpl);
        console2.log("NaveDAOFactory        ", factoryProxy);
        console2.log("factoryImpl           ", factoryImpl);
        console2.log("treasuryImpl          ", treasuryImpl);
        console2.log("governorImpl          ", governorImpl);
        console2.log("executionImpl         ", executionImpl);
        console2.log("tokenDeployer         ", tokenDeployer);
        console2.log("oracle (chain-local)  ", oracleAddress);
        console2.log("relayer               ", relayer);
        console2.log("revenue wallet        ", protocolTreasury);
        console2.log("Same addresses require this factory AND these impls on every chain.");

        string memory root = "det";
        vm.serializeUint(root, "chainId", block.chainid);
        vm.serializeAddress(root, "create2Deployer", CANONICAL_CREATE2);
        vm.serializeAddress(root, "protocol", protocolProxy);
        vm.serializeAddress(root, "protocolImplementation", protocolImpl);
        vm.serializeAddress(root, "factory", factoryProxy);
        vm.serializeAddress(root, "factoryImplementation", factoryImpl);
        vm.serializeAddress(root, "treasuryImplementation", treasuryImpl);
        vm.serializeAddress(root, "governorImplementation", governorImpl);
        vm.serializeAddress(root, "executionImplementation", executionImpl);
        vm.serializeAddress(root, "tokenDeployer", tokenDeployer);
        vm.serializeAddress(root, "oracle", oracleAddress);
        vm.serializeAddress(root, "relayer", relayer);
        string memory json = vm.serializeAddress(root, "protocolTreasury", protocolTreasury);
        vm.writeJson(json, string.concat("deployments/deterministic-", vm.toString(block.chainid), ".json"));
    }

    function _deployChainOracle(address owner) internal returns (address) {
        bool pegChain = block.chainid == 46_630 || block.chainid == 5_042_002;
        address pyth = vm.envOr("PYTH_ADDRESS", NaveAddressRegistry.pyth(block.chainid));
        bool pythHasCode = pyth != address(0) && pyth.code.length > 0;
        if (pegChain && !pythHasCode) {
            return address(new TestnetPegOracle(NaveAddressRegistry.config(block.chainid).usdc));
        }
        require(pyth != address(0), "DeployDeterministicStack: PYTH_ADDRESS missing");
        PythOracle impl = PythOracle(_deploy(SALT_PYTH_IMPL, type(PythOracle).creationCode));
        return address(new ERC1967Proxy(address(impl), abi.encodeCall(PythOracle.initialize, (pyth, owner))));
    }

    function _ensureCanonicalDeployer() internal {
        if (CANONICAL_CREATE2.code.length > 0) return;
        // The raw transaction is the public keyless deployer deployment. It
        // does not use the Nave key.
        vm.broadcastRawTransaction(CANONICAL_CREATE2_TX);
        require(CANONICAL_CREATE2.code.length > 0, "canonical CREATE2 deployer still missing");
    }

    /// Deploy `initCode` through the canonical deployer when the predicted
    /// address is empty. A second run on the same chain is a no-op.
    /// The deployer returns the address, but a broadcast simulation sometimes
    /// drops that return data, so the CREATE2 address is the source of truth.
    function _deploy(bytes32 salt, bytes memory initCode) internal returns (address deployed) {
        deployed = Create2.computeAddress(salt, keccak256(initCode), CANONICAL_CREATE2);
        if (deployed.code.length > 0) return deployed;
        (bool ok, bytes memory ret) = CANONICAL_CREATE2.call(abi.encodePacked(salt, initCode));
        if (ok && ret.length >= 32) {
            address returned = address(uint160(uint256(bytes32(ret))));
            require(returned == deployed, "canonical CREATE2 address mismatch");
        }
        require(deployed.code.length > 0, "canonical CREATE2 deploy failed");
    }
}
