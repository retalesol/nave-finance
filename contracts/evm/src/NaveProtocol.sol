// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable2StepUpgradeable} from
    "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {OwnableUpgradeable} from
    "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";

import {INaveProtocol} from "./interfaces/INaveProtocol.sol";
import {DaoImplRole} from "./libraries/NaveEnums.sol";
import {NaveErrors} from "./libraries/NaveErrors.sol";
import {NaveConstants} from "./libraries/NaveConstants.sol";

/// @title NaveProtocol
/// @notice Singleton protocol configuration + DAO registry (UUPS upgradeable).
/// Also hosts the approved/latest implementation registry used for opt-in DAO
/// Treasury/Governor/Execution upgrades.
contract NaveProtocol is Initializable, Ownable2StepUpgradeable, UUPSUpgradeable, INaveProtocol {
    /// Recipient of formation + token-mint fees.
    address public protocolTreasury;
    /// Global kill-switch (mirrors `NaveGlobalConfig.paused`).
    bool public paused;
    /// Native-currency fee required to form a DAO (the TOTAL the founder pays).
    uint256 public formationFee;
    /// Portion of `formationFee` deposited into the new DAO treasury as its
    /// starting balance (the rest goes to `protocolTreasury`). Must be
    /// `<= formationFee`. Defaults to 0 (full fee to protocol) until configured.
    uint256 public treasurySeed;
    /// Native-currency fee charged when a DAO registers/mints a token.
    uint256 public tokenMintFee;
    /// Monotonic DAO counter (mirrors `dao_count`).
    uint256 public daoCount;
    /// The single authorized factory.
    address public factory;
    /// Wrapped-NAVE ERC-20 accepted for the DAO creation stake on this chain.
    address public naveStakeToken;
    /// Required wrapped-NAVE creation stake in token base units.
    uint256 public requiredNaveStake;
    /// `NaveDaoStake` escrow/moonlight module for this chain.
    address public daoStake;
    /// Per-chain wrapped-native ERC-20 (WETH).
    address public wrappedNative;
    /// Pyth feed id used when auto-registering `wrappedNative`.
    bytes32 public ethUsdFeedId;

    mapping(address => bool) public isNaveTreasury;
    mapping(address => bool) public isNaveGovernor;
    mapping(address => bool) public isNaveExecution;
    mapping(address => uint256) internal _daoOf;

    /// role => impl => approved
    mapping(uint8 => mapping(address => bool)) public approvedImplementation;
    /// role => latest approved impl (used at DAO creation + migrate-to-latest)
    mapping(uint8 => address) public latestImplementation;

    // ── Appended (pre-redeploy hardening) — never reorder above ───────────
    /// Protocol-level strategy/bridge adapter allowlist. A DAO constitution may
    /// only reference adapters approved here (`TreasuryAdminLib.updateConstitution`).
    mapping(address => bool) public isApprovedAdapter;
    /// Cross-chain sister-treasury registry: chainId => treasury => registered.
    /// Populated by the protocol owner from the sibling chain's factory
    /// deployments; `NaveTreasury.setLinkedTreasury` targets must be listed.
    mapping(uint256 => mapping(address => bool)) internal _remoteTreasury;
    /// Queued adapter approvals (0 when none). See {setAdapterApproved}.
    mapping(address => uint256) public adapterApprovalEffectiveAt;
    /// Venue risk tier per adapter (0 = unset, read as Tier 1). See {riskTierOf}.
    mapping(address => uint8) public adapterRiskTier;
    /// Hot key that receives the 0.0005 ETH outbound relayer fee. Not a caller
    /// argument. Zero until {setRelayer}. Appended — do not reorder.
    address public relayer;

    event Paused(bool paused);
    event FormationFeeUpdated(uint256 fee);
    event TreasurySeedUpdated(uint256 seed);
    event TokenMintFeeUpdated(uint256 fee);
    event ProtocolTreasuryUpdated(address treasury);
    event FactorySet(address factory);
    event NaveStakeConfigUpdated(address naveStakeToken, uint256 requiredNaveStake);
    event DaoStakeModuleUpdated(address daoStake);
    event WrappedNativeUpdated(address wrappedNative, bytes32 ethUsdFeedId);
    event DaoRegistered(
        uint256 indexed daoId, address treasury, address governor, address execution
    );
    event ImplementationApproved(uint8 indexed role, address indexed implementation, bool approved);
    event LatestImplementationSet(uint8 indexed role, address indexed implementation);
    event AdapterApprovalSet(address indexed adapter, bool approved);
    event AdapterApprovalQueued(address indexed adapter, uint256 effectiveAt);
    event RemoteTreasurySet(uint256 indexed chainId, address indexed treasury, bool registered);
    event AdapterRiskTierSet(address indexed adapter, uint8 tier);
    event RelayerUpdated(address indexed previousRelayer, address indexed relayer);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address owner_,
        address protocolTreasury_,
        uint256 formationFee_,
        uint256 tokenMintFee_
    ) external initializer {
        if (protocolTreasury_ == address(0)) revert NaveErrors.ZeroAddress();
        __Ownable_init(owner_);
        __Ownable2Step_init();
        protocolTreasury = protocolTreasury_;
        formationFee = formationFee_;
        tokenMintFee = tokenMintFee_;
    }

    modifier onlyFactory() {
        if (msg.sender != factory) revert NaveErrors.Unauthorized();
        _;
    }

    /// Disambiguate the Ownable owner for the INaveProtocol interface.
    function owner() public view override(OwnableUpgradeable, INaveProtocol) returns (address) {
        return OwnableUpgradeable.owner();
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    // ── Admin ─────────────────────────────────────────────────────────────
    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit Paused(paused_);
    }

    function setFormationFee(uint256 fee) external onlyOwner {
        if (treasurySeed > fee) revert NaveErrors.InvalidTreasurySeed();
        formationFee = fee;
        emit FormationFeeUpdated(fee);
    }

    function setTreasurySeed(uint256 seed) external onlyOwner {
        if (seed > formationFee) revert NaveErrors.InvalidTreasurySeed();
        treasurySeed = seed;
        emit TreasurySeedUpdated(seed);
    }

    function setTokenMintFee(uint256 fee) external onlyOwner {
        tokenMintFee = fee;
        emit TokenMintFeeUpdated(fee);
    }

    function setProtocolTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert NaveErrors.ZeroAddress();
        protocolTreasury = treasury_;
        emit ProtocolTreasuryUpdated(treasury_);
    }

    function setNaveStakeConfig(address token, uint256 amount) external onlyOwner {
        naveStakeToken = token;
        requiredNaveStake = amount;
        emit NaveStakeConfigUpdated(token, amount);
    }

    function setDaoStake(address daoStake_) external onlyOwner {
        daoStake = daoStake_;
        emit DaoStakeModuleUpdated(daoStake_);
    }

    function setWrappedNative(address token, bytes32 feedId) external onlyOwner {
        wrappedNative = token;
        ethUsdFeedId = feedId;
        emit WrappedNativeUpdated(token, feedId);
    }

    /// Protocol relayer. Outbound treasury fees pay this address and no other.
    function setRelayer(address relayer_) external onlyOwner {
        if (relayer_ == address(0)) revert NaveErrors.ZeroAddress();
        emit RelayerUpdated(relayer, relayer_);
        relayer = relayer_;
    }

    function setFactory(address factory_) external onlyOwner {
        if (factory != address(0)) revert NaveErrors.AlreadyInitialized();
        if (factory_ == address(0)) revert NaveErrors.ZeroAddress();
        factory = factory_;
        emit FactorySet(factory_);
    }

    /// Replace the factory (escape hatch). New DAOs use the new factory wiring;
    /// existing DAO proxies keep their own UUPS logic until they opt in.
    function updateFactory(address factory_) external onlyOwner {
        if (factory_ == address(0)) revert NaveErrors.ZeroAddress();
        factory = factory_;
        emit FactorySet(factory_);
    }

    // ── DAO implementation registry ───────────────────────────────────────
    function approveImplementation(uint8 role, address implementation, bool approved)
        external
        onlyOwner
    {
        if (role > uint8(DaoImplRole.Execution)) revert NaveErrors.InvalidImplRole();
        if (implementation == address(0)) revert NaveErrors.ZeroAddress();
        approvedImplementation[role][implementation] = approved;
        if (!approved && latestImplementation[role] == implementation) {
            latestImplementation[role] = address(0);
            emit LatestImplementationSet(role, address(0));
        }
        emit ImplementationApproved(role, implementation, approved);
    }

    function setLatestImplementation(uint8 role, address implementation) external onlyOwner {
        if (role > uint8(DaoImplRole.Execution)) revert NaveErrors.InvalidImplRole();
        if (implementation == address(0)) revert NaveErrors.ZeroAddress();
        if (!approvedImplementation[role][implementation]) revert NaveErrors.LatestImplNotApproved();
        latestImplementation[role] = implementation;
        emit LatestImplementationSet(role, implementation);
    }

    /// One-shot publish used by deploy/upgrade scripts: approve + set latest.
    function publishImplementation(uint8 role, address implementation) external onlyOwner {
        if (role > uint8(DaoImplRole.Execution)) revert NaveErrors.InvalidImplRole();
        if (implementation == address(0)) revert NaveErrors.ZeroAddress();
        approvedImplementation[role][implementation] = true;
        latestImplementation[role] = implementation;
        emit ImplementationApproved(role, implementation, true);
        emit LatestImplementationSet(role, implementation);
    }

    function isApprovedImplementation(uint8 role, address implementation)
        external
        view
        returns (bool)
    {
        return approvedImplementation[role][implementation];
    }

    function latestImplementations()
        external
        view
        returns (address treasury, address governor, address execution)
    {
        return (
            latestImplementation[uint8(DaoImplRole.Treasury)],
            latestImplementation[uint8(DaoImplRole.Governor)],
            latestImplementation[uint8(DaoImplRole.Execution)]
        );
    }

    // ── Adapter allowlist ─────────────────────────────────────────────────
    /// Owner-managed protocol allowlist of strategy / bridge adapters.
    /// Revocation is immediate and `NaveExecution` re-checks it at execute
    /// time, so existing constitutions cannot keep routing into a revoked
    /// adapter. Approval is immediate only while no DAO exists (initial
    /// deployment); afterwards it is queued for ADAPTER_APPROVAL_DELAY_SECS and
    /// applied with {applyAdapterApproval}, so DAOs can see a new venue coming.
    function setAdapterApproved(address adapter, bool approved) external onlyOwner {
        if (adapter == address(0)) revert NaveErrors.ZeroAddress();
        if (approved && daoCount != 0) {
            uint256 effectiveAt = block.timestamp + NaveConstants.adapterApprovalDelaySecs();
            adapterApprovalEffectiveAt[adapter] = effectiveAt;
            emit AdapterApprovalQueued(adapter, effectiveAt);
            return;
        }
        adapterApprovalEffectiveAt[adapter] = 0;
        isApprovedAdapter[adapter] = approved;
        emit AdapterApprovalSet(adapter, approved);
    }

    function applyAdapterApproval(address adapter) external {
        uint256 effectiveAt = adapterApprovalEffectiveAt[adapter];
        if (effectiveAt == 0 || block.timestamp < effectiveAt) {
            revert NaveErrors.AdapterApprovalNotReady();
        }
        adapterApprovalEffectiveAt[adapter] = 0;
        isApprovedAdapter[adapter] = true;
        emit AdapterApprovalSet(adapter, true);
    }

    /// Classify a venue: 1 lending/savings, 2 curated or higher-utilization
    /// vaults, 3 credit / synthetic-dollar / fixed-term. Constitutions cap the
    /// combined allocation per tier. Raising a tier is immediate; lowering it on
    /// an approved adapter requires revoking and re-approving (delayed).
    function setAdapterRiskTier(address adapter, uint8 tier) external onlyOwner {
        if (adapter == address(0)) revert NaveErrors.ZeroAddress();
        if (tier == 0 || tier > NaveConstants.MAX_RISK_TIER) revert NaveErrors.InvalidRiskTier();
        if (isApprovedAdapter[adapter] && tier < riskTierOf(adapter)) {
            revert NaveErrors.RiskTierLowerRequiresReapproval();
        }
        adapterRiskTier[adapter] = tier;
        emit AdapterRiskTierSet(adapter, tier);
    }

    function riskTierOf(address adapter) public view returns (uint8) {
        uint8 tier = adapterRiskTier[adapter];
        return tier == 0 ? 1 : tier;
    }

    // ── Sister (remote-chain) treasury registry ───────────────────────────
    /// Owner-managed registry of DAO treasuries deployed by the Nave factory on
    /// OTHER chains. Local `isNaveTreasury` cannot vouch for remote addresses,
    /// so bridge destinations are allowlisted here before a founder may link
    /// them via `NaveTreasury.setLinkedTreasury`.
    function setRemoteTreasury(uint256 chainId, address treasury, bool registered)
        external
        onlyOwner
    {
        if (chainId == 0 || chainId == block.chainid) revert NaveErrors.InvalidChainId();
        if (treasury == address(0)) revert NaveErrors.ZeroAddress();
        _remoteTreasury[chainId][treasury] = registered;
        emit RemoteTreasurySet(chainId, treasury, registered);
    }

    function isRemoteTreasury(uint256 chainId, address treasury) external view returns (bool) {
        return _remoteTreasury[chainId][treasury];
    }

    // ── Registry ──────────────────────────────────────────────────────────
    function registerDao(address treasury, address governor, address execution)
        external
        onlyFactory
        returns (uint256 daoId)
    {
        daoId = daoCount;
        daoCount = daoId + 1;
        isNaveTreasury[treasury] = true;
        isNaveGovernor[governor] = true;
        isNaveExecution[execution] = true;
        _daoOf[treasury] = daoId;
        _daoOf[governor] = daoId;
        _daoOf[execution] = daoId;
        emit DaoRegistered(daoId, treasury, governor, execution);
    }

    function daoOf(address clone) external view returns (uint256) {
        return _daoOf[clone];
    }

    /// Receive native fees forwarded by the factory / treasuries.
    receive() external payable {}

    /// Was 40; slots consumed by `isApprovedAdapter`, `_remoteTreasury`,
    /// `adapterApprovalEffectiveAt`, `adapterRiskTier`, and `relayer`.
    uint256[35] private __gap;
}
