// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable2StepUpgradeable} from
    "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";
import {NaveERC1967Proxy} from "./upgradeable/NaveERC1967Proxy.sol";

import {INaveProtocol} from "./interfaces/INaveProtocol.sol";
import {IOracle} from "./interfaces/IOracle.sol";
import {DaoImplRole} from "./libraries/NaveEnums.sol";
import {NaveErrors} from "./libraries/NaveErrors.sol";
import {NaveConstants} from "./libraries/NaveConstants.sol";
import {ProtocolFeeLib} from "./libraries/ProtocolFeeLib.sol";
import {NaveTreasury} from "./NaveTreasury.sol";
import {TreasuryAdminLib} from "./libraries/TreasuryAdminLib.sol";
import {NaveGovernor} from "./NaveGovernor.sol";
import {NaveExecution} from "./NaveExecution.sol";

/// @title NaveDAOFactory
/// @notice Deploys each DAO as three ERC1967 proxies (treasury, governor,
/// execution) at the protocol's latest approved implementations.
///
/// {createDao} keeps the original chain-scoped salt
/// (`keccak256(abi.encode(chainid, factory, daoId, founder))`). Those
/// treasuries cannot move. New treasuries use {createCrossChainDao} and
/// {activateDao}, whose salt is `keccak256(abi.encode(founder, slug))` with
/// no chain id and no dao counter.
///
/// Identical proxy addresses across chains also require this factory and the
/// treasury/governor/execution implementation addresses to match on every
/// chain. The ERC1967 proxy creation code embeds the implementation address
/// (the same constraint EIP-1167 clones have), so a different factory or a
/// different implementation produces a different treasury address even when
/// the salt matches. {script/DeployDeterministicStack.s.sol} deploys that
/// stack through the canonical CREATE2 deployer.
contract NaveDAOFactory is Initializable, Ownable2StepUpgradeable, UUPSUpgradeable {
    using SafeERC20 for IERC20;
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
    event DaoActivated(
        uint256 indexed daoId,
        address indexed founder,
        address treasury,
        address governor,
        address execution,
        bytes32 salt
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

    /// Form a DAO. `DEVNET_FORMATION_FEE_WEI` is 0 and the protocol formation
    /// fee stays 0 unless an owner sets one. While that fee is 0, all of
    /// `msg.value` is the founder's own treasury seed, not a protocol charge.
    /// Creation does not lock NAVE, even when `requiredNaveStake` is still
    /// non-zero. Returns the assigned id and the three proxy addresses.
    ///
    /// The salt includes `block.chainid` and the per-chain dao counter. Use
    /// {createCrossChainDao} for a new treasury that should activate at the
    /// same addresses on other chains.
    function createDao(CreateDaoParams calldata params)
        external
        payable
        returns (uint256 daoId, address treasury, address governor, address execution)
    {
        // `protocol.daoCount()` is the id `registerDao` assigns below.
        bytes32 salt = daoSalt(protocol.daoCount(), msg.sender);
        return _createWithSalt(params, salt, true);
    }

    /// Home-chain create for a NEW treasury. Salt is
    /// `keccak256(abi.encode(founder, slug))` — no chain id, no dao counter.
    /// The formation-fee split matches {createDao}. Other chains call
    /// {activateDao} with the same founder and slug.
    function createCrossChainDao(CreateDaoParams calldata params, string calldata slug)
        external
        payable
        returns (uint256 daoId, address treasury, address governor, address execution)
    {
        _validateSlug(slug);
        bytes32 salt = crossChainSalt(msg.sender, slug);
        _revertIfDeployed(salt);
        (daoId, treasury, governor, execution) = _createWithSalt(params, salt, true);
        _rememberLatestIfEmpty(salt);
    }

    /// Deploy treasury, governor, and execution at the same addresses as the
    /// home chain. `params` are the constitution fields the app read off that
    /// home treasury (name, privacy, guardians, agents, fees, quorum,
    /// governance, revenue wallet). Forwards 0.001 ETH to the protocol revenue
    /// wallet. Gas is extra. On Arc the fee is the USDC value of 0.001 ETH,
    /// paid in {NaveConstants.ARC_TESTNET_USDC}.
    ///
    /// Adapter allowlists, the review window, and policy bps are not part of
    /// initialize. The founder copies those with the existing treasury setters
    /// after this call, using the same home-chain reads.
    function activateDao(CreateDaoParams calldata params, string calldata slug)
        external
        payable
        returns (uint256 daoId, address treasury, address governor, address execution)
    {
        return _activate(params, slug);
    }

    /// Sister-chain activate using the implementations that created the home
    /// proxies. {latestImplementation} can move after that create; the proxy
    /// address only matches when the creation code embeds the original
    /// implementations. Each address must already be an approved implementation.
    function activateDao(
        CreateDaoParams calldata params,
        string calldata slug,
        address treasuryImpl,
        address governorImpl,
        address executionImpl
    ) external payable returns (uint256 daoId, address treasury, address governor, address execution) {
        bytes32 salt = crossChainSalt(msg.sender, slug);
        _requireApprovedImpl(DaoImplRole.Treasury, treasuryImpl);
        _requireApprovedImpl(DaoImplRole.Governor, governorImpl);
        _requireApprovedImpl(DaoImplRole.Execution, executionImpl);
        _remember(salt, treasuryImpl, governorImpl, executionImpl);
        return _activate(params, slug);
    }

    function _activate(CreateDaoParams calldata params, string calldata slug)
        internal
        returns (uint256 daoId, address treasury, address governor, address execution)
    {
        if (protocol.paused()) revert NaveErrors.GlobalPaused();
        _validateSlug(slug);
        bytes32 salt = crossChainSalt(msg.sender, slug);
        _revertIfDeployed(salt);
        _collectActivationFee();
        (daoId, treasury, governor, execution) = _deployAndInit(params, salt);
        _rememberLatestIfEmpty(salt);
        emit DaoActivated(daoId, msg.sender, treasury, governor, execution, salt);
    }

    /// Native wei and Arc ERC-20 USDC (6 decimals) required by {activateDao}
    /// on the current chain. One of the two is zero.
    function activationFeeQuote() external view returns (uint256 nativeWei, uint256 arcUsdcAmount) {
        if (ProtocolFeeLib.isArc(block.chainid)) {
            return (
                0,
                ProtocolFeeLib.ethToUsdc6(
                    IOracle(oracle), protocol.wrappedNative(), protocol.ethUsdFeedId(), NaveConstants.ACTIVATION_FEE_WEI
                )
            );
        }
        return (NaveConstants.ACTIVATION_FEE_WEI, 0);
    }

    function _createWithSalt(CreateDaoParams calldata params, bytes32 salt, bool settleFormationFee)
        internal
        returns (uint256 daoId, address treasury, address governor, address execution)
    {
        if (protocol.paused()) revert NaveErrors.GlobalPaused();
        uint256 fee = protocol.formationFee();
        if (msg.value < fee) revert NaveErrors.InsufficientFormationFee();
        (daoId, treasury, governor, execution) = _deployAndInit(params, salt);
        if (!settleFormationFee) return (daoId, treasury, governor, execution);

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
        return (daoId, treasury, governor, execution);
    }

    function _deployAndInit(CreateDaoParams calldata params, bytes32 salt)
        internal
        returns (uint256 daoId, address treasury, address governor, address execution)
    {
        address treasuryImpl = _resolveImpl(salt, DaoImplRole.Treasury);
        address governorImpl = _resolveImpl(salt, DaoImplRole.Governor);
        address executionImpl = _resolveImpl(salt, DaoImplRole.Execution);
        if (
            treasuryImpl == address(0) || governorImpl == address(0) || executionImpl == address(0)
        ) {
            revert NaveErrors.ZeroAddress();
        }

        treasury = address(new NaveERC1967Proxy{salt: _roleSalt(salt, DaoImplRole.Treasury)}(treasuryImpl, ""));
        governor = address(new NaveERC1967Proxy{salt: _roleSalt(salt, DaoImplRole.Governor)}(governorImpl, ""));
        execution = address(new NaveERC1967Proxy{salt: _roleSalt(salt, DaoImplRole.Execution)}(executionImpl, ""));

        daoId = protocol.registerDao(treasury, governor, execution);
        this.initializeTriplet(treasury, governor, execution, daoId, msg.sender, params);
        emit DaoCreated(daoId, msg.sender, treasury, governor, execution);
    }

    /// Separate call frame so the init-params struct does not blow the
    /// factory's stack. Called only by this contract. The treasury sees
    /// `msg.sender` as the factory.
    function initializeTriplet(
        address treasury,
        address governor,
        address execution,
        uint256 daoId,
        address founder_,
        CreateDaoParams calldata params
    ) external {
        if (msg.sender != address(this)) revert NaveErrors.Unauthorized();
        NaveTreasury(payable(treasury))
            .initialize(
                TreasuryAdminLib.InitParams({
                    protocol: address(protocol),
                    governor: governor,
                    execution: execution,
                    oracle: oracle,
                    tokenDeployer: tokenDeployer,
                    daoId: daoId,
                    founder: founder_,
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
    }

    function _collectActivationFee() internal {
        address revenue = protocol.protocolTreasury();
        if (revenue == address(0)) revert NaveErrors.ZeroAddress();
        if (ProtocolFeeLib.isArc(block.chainid)) {
            uint256 usdcFee = ProtocolFeeLib.ethToUsdc6(
                IOracle(oracle), protocol.wrappedNative(), protocol.ethUsdFeedId(), NaveConstants.ACTIVATION_FEE_WEI
            );
            IERC20(NaveConstants.ARC_TESTNET_USDC).safeTransferFrom(msg.sender, revenue, usdcFee);
            if (msg.value > 0) {
                (bool refunded,) = msg.sender.call{value: msg.value}("");
                if (!refunded) revert NaveErrors.InsufficientActivationFee();
            }
            return;
        }
        if (msg.value < NaveConstants.ACTIVATION_FEE_WEI) revert NaveErrors.InsufficientActivationFee();
        (bool ok,) = revenue.call{value: NaveConstants.ACTIVATION_FEE_WEI}("");
        if (!ok) revert NaveErrors.InsufficientActivationFee();
        if (msg.value > NaveConstants.ACTIVATION_FEE_WEI) {
            (bool refunded,) = msg.sender.call{value: msg.value - NaveConstants.ACTIVATION_FEE_WEI}("");
            if (!refunded) revert NaveErrors.InsufficientActivationFee();
        }
    }

    function _revertIfDeployed(bytes32 salt) internal view {
        address predicted = _predict(salt, DaoImplRole.Treasury);
        if (predicted.code.length != 0) revert NaveErrors.DaoAlreadyActivated();
    }

    function _validateSlug(string calldata slug) internal pure {
        bytes memory b = bytes(slug);
        uint256 n = b.length;
        if (n < 3 || n > 32) revert NaveErrors.InvalidSlug();
        if (b[0] < 0x61 || b[0] > 0x7a) revert NaveErrors.InvalidSlug();
        for (uint256 i; i < n; ++i) {
            bytes1 c = b[i];
            bool ok = (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39) || c == 0x2d;
            if (!ok) revert NaveErrors.InvalidSlug();
        }
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

    /// Salt for {createCrossChainDao} and {activateDao}. No chain id and no
    /// per-chain counter, so the same founder and slug predict the same proxy
    /// addresses on every chain whose factory and implementations match.
    function crossChainSalt(address founder, string calldata slug) public pure returns (bytes32) {
        return keccak256(abi.encode(founder, slug));
    }

    function predictCrossChainAddresses(address founder, string calldata slug)
        external
        view
        returns (address treasury, address governor, address execution)
    {
        bytes32 salt = crossChainSalt(founder, slug);
        treasury = _predict(salt, DaoImplRole.Treasury);
        governor = _predict(salt, DaoImplRole.Governor);
        execution = _predict(salt, DaoImplRole.Execution);
    }

    /// Predict the proxies for a founder and slug using an explicit
    /// implementation set. This is the address {activateDao} will deploy when
    /// those implementations are pinned, including after {latestImplementation}
    /// has moved.
    function predictCrossChainAddresses(
        address founder,
        string calldata slug,
        address treasuryImpl,
        address governorImpl,
        address executionImpl
    ) external view returns (address treasury, address governor, address execution) {
        bytes32 salt = crossChainSalt(founder, slug);
        treasury = _predictWith(salt, DaoImplRole.Treasury, treasuryImpl);
        governor = _predictWith(salt, DaoImplRole.Governor, governorImpl);
        execution = _predictWith(salt, DaoImplRole.Execution, executionImpl);
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
        return _predictWith(salt, role, _resolveImpl(salt, role));
    }

    function _predictWith(bytes32 salt, DaoImplRole role, address impl) internal view returns (address) {
        bytes32 initCodeHash = keccak256(
            abi.encodePacked(type(NaveERC1967Proxy).creationCode, abi.encode(impl, bytes("")))
        );
        return Create2.computeAddress(_roleSalt(salt, role), initCodeHash, address(this));
    }

    function _resolveImpl(bytes32 salt, DaoImplRole role) internal view returns (address) {
        CrossChainImpls memory pinned = crossChainImpls[salt];
        if (role == DaoImplRole.Treasury && pinned.treasury != address(0)) return pinned.treasury;
        if (role == DaoImplRole.Governor && pinned.governor != address(0)) return pinned.governor;
        if (role == DaoImplRole.Execution && pinned.execution != address(0)) return pinned.execution;
        return protocol.latestImplementation(uint8(role));
    }

    function _requireApprovedImpl(DaoImplRole role, address impl) internal view {
        if (impl == address(0) || impl.code.length == 0) revert NaveErrors.ZeroAddress();
        if (!protocol.isApprovedImplementation(uint8(role), impl)) revert NaveErrors.LatestImplNotApproved();
    }

    function _remember(bytes32 salt, address treasuryImpl, address governorImpl, address executionImpl) internal {
        crossChainImpls[salt] = CrossChainImpls(treasuryImpl, governorImpl, executionImpl);
    }

    function _rememberLatestIfEmpty(bytes32 salt) internal {
        if (crossChainImpls[salt].treasury != address(0)) return;
        _remember(
            salt,
            protocol.latestImplementation(uint8(DaoImplRole.Treasury)),
            protocol.latestImplementation(uint8(DaoImplRole.Governor)),
            protocol.latestImplementation(uint8(DaoImplRole.Execution))
        );
    }

    struct CrossChainImpls {
        address treasury;
        address governor;
        address execution;
    }

    /// Implementations pinned for a cross-chain salt. Empty until the home
    /// create or an explicit {activateDao} records them.
    mapping(bytes32 => CrossChainImpls) public crossChainImpls;

    uint256[46] private __gap;
}
