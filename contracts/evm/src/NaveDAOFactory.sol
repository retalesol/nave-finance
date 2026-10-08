// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable2StepUpgradeable} from
    "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";
import {NaveERC1967Proxy} from "./upgradeable/NaveERC1967Proxy.sol";

import {INaveProtocol} from "./interfaces/INaveProtocol.sol";
import {DaoImplRole} from "./libraries/NaveEnums.sol";
import {NaveErrors} from "./libraries/NaveErrors.sol";
import {NaveTreasury} from "./NaveTreasury.sol";
import {TreasuryAdminLib} from "./libraries/TreasuryAdminLib.sol";
import {NaveGovernor} from "./NaveGovernor.sol";
import {NaveExecution} from "./NaveExecution.sol";
import {NaveDaoStake} from "./NaveDaoStake.sol";

/// @title NaveDAOFactory
/// @notice Deploys each DAO as three ERC1967 UUPS proxies (treasury, governor,
/// execution) at the protocol's latest approved implementations, charges the
/// native formation fee, and registers the triplet with `NaveProtocol`.
/// Proxies are deployed with CREATE2 under a chain-scoped salt so DAO addresses
/// are globally unique across the chains Nave runs on (see {daoSalt}).
contract NaveDAOFactory is Initializable, Ownable2StepUpgradeable, UUPSUpgradeable {
    INaveProtocol public protocol;
    /// Shared per-chain price oracle (PythOracle + Chainlink fallback).
    address public oracle;
    /// Shared DAO-token deployer (keeps treasury bytecode under EIP-170).
    address public tokenDeployer;

    struct CreateDaoParams {
        string name;
        uint8 privacyMode;
        address[] guardianWallets;
        uint8 guardianThreshold;
        address[4] agentAuthorities;
        uint16 managementFeeBps;
        uint16 performanceFeeBps;
        uint16 frozenManagementFeeBps;
        uint16 frozenPerformanceFeeBps;
        address protocolRevenueWallet;
        uint16 quorumBps;
        uint8 governanceType;
    }

    event DaoCreated(
        uint256 indexed daoId,
        address indexed founder,
        address treasury,
        address governor,
        address execution
    );
    event OracleUpdated(address oracle);
    event TokenDeployerUpdated(address tokenDeployer);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address owner_,
        address protocol_,
        address oracle_,
        address tokenDeployer_
    ) external initializer {
        if (
            owner_ == address(0) || protocol_ == address(0) || oracle_ == address(0)
                || tokenDeployer_ == address(0)
        ) revert NaveErrors.ZeroAddress();
        __Ownable_init(owner_);
        __Ownable2Step_init();
        protocol = INaveProtocol(protocol_);
        oracle = oracle_;
        tokenDeployer = tokenDeployer_;
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    function setOracle(address oracle_) external onlyOwner {
        if (oracle_ == address(0)) revert NaveErrors.ZeroAddress();
        oracle = oracle_;
        emit OracleUpdated(oracle_);
    }

    function setTokenDeployer(address tokenDeployer_) external onlyOwner {
        if (tokenDeployer_ == address(0)) revert NaveErrors.ZeroAddress();
        tokenDeployer = tokenDeployer_;
        emit TokenDeployerUpdated(tokenDeployer_);
    }

    /// Form a DAO. `msg.value` must cover `protocol.formationFee()`; any excess
    /// is refunded into the treasury seed. Returns the assigned id and the three
    /// proxy addresses.
    function createDao(CreateDaoParams calldata params)
        external
        payable
        returns (uint256 daoId, address treasury, address governor, address execution)
    {
        if (protocol.paused()) revert NaveErrors.GlobalPaused();
        uint256 fee = protocol.formationFee();
        if (msg.value < fee) revert NaveErrors.InsufficientFormationFee();

        address treasuryImpl = protocol.latestImplementation(uint8(DaoImplRole.Treasury));
        address governorImpl = protocol.latestImplementation(uint8(DaoImplRole.Governor));
        address executionImpl = protocol.latestImplementation(uint8(DaoImplRole.Execution));
        if (
            treasuryImpl == address(0) || governorImpl == address(0) || executionImpl == address(0)
        ) {
            revert NaveErrors.ZeroAddress();
        }

        // CREATE2 with a chain-scoped salt (see {daoSalt}). Factories deployed by
        // the same deployer/nonce on several chains share an address, so plain
        // CREATE would give the N-th DAO on every chain the SAME proxy addresses;
        // the app's registry keys DAOs by address globally, so that must never
        // happen. `protocol.daoCount()` is the id `registerDao` assigns below.
        bytes32 salt = daoSalt(protocol.daoCount(), msg.sender);
        treasury = address(new NaveERC1967Proxy{salt: _roleSalt(salt, DaoImplRole.Treasury)}(treasuryImpl, ""));
        governor = address(new NaveERC1967Proxy{salt: _roleSalt(salt, DaoImplRole.Governor)}(governorImpl, ""));
        execution = address(new NaveERC1967Proxy{salt: _roleSalt(salt, DaoImplRole.Execution)}(executionImpl, ""));

        daoId = protocol.registerDao(treasury, governor, execution);

        NaveTreasury(payable(treasury))
            .initialize(
                TreasuryAdminLib.InitParams({
                    protocol: address(protocol),
                    governor: governor,
                    execution: execution,
                    oracle: oracle,
                    tokenDeployer: tokenDeployer,
                    daoId: daoId,
                    founder: msg.sender,
                    name: params.name,
                    privacyMode: params.privacyMode,
                    guardianWallets: params.guardianWallets,
                    guardianThreshold: params.guardianThreshold,
                    agentAuthorities: params.agentAuthorities,
                    managementFeeBps: params.managementFeeBps,
                    performanceFeeBps: params.performanceFeeBps,
                    frozenManagementFeeBps: params.frozenManagementFeeBps,
                    frozenPerformanceFeeBps: params.frozenPerformanceFeeBps,
                    protocolRevenueWallet: params.protocolRevenueWallet,
                    quorumBps: params.quorumBps,
                    governanceType: params.governanceType
                })
            );
        NaveGovernor(governor).initialize(treasury, address(protocol), execution);
        NaveExecution(execution).initialize(treasury, governor, address(protocol));

        uint256 seed = protocol.treasurySeed();
        if (seed > fee) revert NaveErrors.InvalidTreasurySeed();
        uint256 protocolPortion = fee - seed;
        uint256 surplus = msg.value - fee;
        uint256 totalSeed = seed + surplus;

        if (totalSeed > 0) {
            NaveTreasury(payable(treasury)).seedNativeTreasury{value: totalSeed}();
        }
        if (protocolPortion > 0) {
            (bool ok,) = protocol.protocolTreasury().call{value: protocolPortion}("");
            if (!ok) revert NaveErrors.InsufficientFormationFee();
        }

        address stakeModule = protocol.daoStake();
        uint256 stakeAmount = protocol.requiredNaveStake();
        address stakeToken = protocol.naveStakeToken();
        if (stakeModule != address(0) && stakeAmount > 0 && stakeToken != address(0)) {
            NaveDaoStake(stakeModule).lockStake(treasury, msg.sender, stakeToken, stakeAmount, 0);
        }

        emit DaoCreated(daoId, msg.sender, treasury, governor, execution);
    }

    // ── Deterministic, chain-scoped DAO addresses ─────────────────────────
    /// Base CREATE2 salt for the DAO that will receive id `daoId` when formed by
    /// `founder`:
    ///   keccak256(abi.encode(block.chainid, address(this), daoId, founder))
    /// `block.chainid` keeps same-address factories on different chains from
    /// ever producing the same DAO proxy addresses; `daoId` keeps successive
    /// DAOs (even by the same founder) distinct.
    function daoSalt(uint256 daoId, address founder) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), daoId, founder));
    }

    /// Addresses the three proxies WOULD get if `founder` formed the next DAO
    /// now (with the protocol's current latest implementations).
    function predictDaoAddresses(address founder)
        external
        view
        returns (address treasury, address governor, address execution)
    {
        bytes32 salt = daoSalt(protocol.daoCount(), founder);
        treasury = _predict(salt, DaoImplRole.Treasury);
        governor = _predict(salt, DaoImplRole.Governor);
        execution = _predict(salt, DaoImplRole.Execution);
    }

    function _roleSalt(bytes32 salt, DaoImplRole role) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(salt, uint8(role)));
    }

    function _predict(bytes32 salt, DaoImplRole role) internal view returns (address) {
        address impl = protocol.latestImplementation(uint8(role));
        bytes32 initCodeHash = keccak256(
            abi.encodePacked(type(NaveERC1967Proxy).creationCode, abi.encode(impl, bytes("")))
        );
        return Create2.computeAddress(_roleSalt(salt, role), initCodeHash, address(this));
    }

    uint256[47] private __gap;
}
