// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {NaveInitializable} from "./upgradeable/NaveInitializable.sol";
import {NaveUUPSBase} from "./upgradeable/NaveUUPSBase.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";

import {INaveTreasury} from "./interfaces/INaveTreasury.sol";
import {INaveProtocol} from "./interfaces/INaveProtocol.sol";
import {IOracle} from "./interfaces/IOracle.sol";
import {NaveConstants} from "./libraries/NaveConstants.sol";
import {NaveErrors} from "./libraries/NaveErrors.sol";
import {NaveStructs} from "./libraries/NaveStructs.sol";
import {TreasuryAdminLib} from "./libraries/TreasuryAdminLib.sol";
import {TreasuryGuardianLib} from "./libraries/TreasuryGuardianLib.sol";
import {TreasuryStrategyLib} from "./libraries/TreasuryStrategyLib.sol";
import {TreasuryValuationLib} from "./libraries/TreasuryValuationLib.sol";
import {TreasuryViewLib} from "./libraries/TreasuryViewLib.sol";
import {
    AgentRole,
    AgentStatus,
    GovernanceType,
    PrivacyMode,
    AnnotationStatus,
    DaoImplRole
} from "./libraries/NaveEnums.sol";

/// @title NaveTreasury
/// @notice Per-DAO treasury UUPS proxy. EVM port of the DAO-level `nave_core` state.
contract NaveTreasury is INaveTreasury, NaveInitializable, NaveUUPSBase, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── Structs ───────────────────────────────────────────────────────────

    // ── Wiring ────────────────────────────────────────────────────────────
    INaveProtocol public protocolContract;
    address public governor;
    address public execution;
    IOracle public oracle;
    address public tokenDeployer;

    // ── Registry / lifecycle ──────────────────────────────────────────────
    uint256 public daoId;
    address public founder;
    string public name;
    uint8 public privacyMode;
    bool public frozen;
    bool public override agentsEnabled;
    uint64 public override proposalCount;
    uint64 public archivedProposals;
    uint64 public override nextProposalIndex;
    uint256 public createdAt;
    uint16 public override quorumBps;
    uint8 public override governanceType;
    address public override votingToken;

    // ── Vault accounting (micro-USD) ──────────────────────────────────────
    uint256 public totalDeposited;
    uint256 public totalWithdrawn;
    uint256 public override currentNav;
    uint256 public highWaterMark;
    uint256 public override deployedCapital;
    uint256 public override lastRevaluedAt;

    // ── Native treasury seed (formation-fee carve-out) ────────────────────
    /// Native (ETH) seeded at DAO creation, immediately wrapped to protocol WETH
    /// (Solana wSOL parity). Register WETH via {registerAsset} for NAV inclusion.
    uint256 public nativeSeeded;

    // ── Fees ──────────────────────────────────────────────────────────────
    uint16 public managementFeeBps;
    uint16 public performanceFeeBps;
    uint16 public frozenManagementFeeBps;
    uint16 public frozenPerformanceFeeBps;
    address public protocolRevenueWallet;

    // ── Agent threshold (mirrors Solana constitution.agent_threshold_usd) ──
    /// Minimum treasury NAV (micro-USD) agents must see before deploying capital.
    /// Updated via updateConstitution. Zero disables the gate.
    uint256 public agentThresholdUsd;

    // ── Agents ────────────────────────────────────────────────────────────
    TreasuryAdminLib.AgentSlot[4] internal _agents;
    TreasuryAdminLib.PendingRotation[4] internal _pendingRotations;

    // ── Guardians ─────────────────────────────────────────────────────────
    address[] internal _guardianWallets;
    uint8 public guardianThreshold;
    mapping(bytes32 => bool) internal _usedGuardianDigest;
    /// False until the founder completes ActivationHub one-shot guardian edit
    /// (or the first Permission proposal executes). After true, only the
    /// governor may change the set via a passed Permission proposal.
    bool public guardiansBootstrapped;
    /// Sister treasuries for agent-automated cross-chain capital hops.
    /// `linkedTreasury[destChainId] = destTreasury`.
    mapping(uint256 => address) public linkedTreasury;

    // ── Constitution / policy ─────────────────────────────────────────────
    address[] internal _approvedAdapters;
    mapping(address => NaveStructs.ProtocolEntry) internal _constitution;
    uint8 public confidenceThreshold;
    /// Stored review window. Read through {reviewWindowSecs}, which resolves a
    /// queued reduction once its delay has elapsed (same slot as before).
    int64 internal _reviewWindowSecs;
    uint16 public minStablecoinReserveBps;
    uint16 public maxTotalDeployedBps;
    uint16 public minLiquidityBps;
    int64 public rebalanceFrequencySecs;
    int64 public lastRebalanceAt;

    // ── Tokens ────────────────────────────────────────────────────────────
    NaveStructs.TokenSlot[] internal _tokens;
    mapping(address => uint256) internal _tokenIndexPlusOne;

    // ── Assets ────────────────────────────────────────────────────────────
    address[] internal _registeredAssets;
    mapping(address => NaveStructs.AssetRecord) internal _assets;

    // ── Positions / annotations ───────────────────────────────────────────
    mapping(address => TreasuryStrategyLib.Position) internal _positions; // keyed by adapter
    mapping(address => NaveStructs.Annotation) internal _annotations; // keyed by holder

    // ── EVM-H1: frozen-guardian recovery ──────────────────────────────────
    /// When the DAO entered its current frozen state (0 when not frozen).
    /// Anchors the protocol-owner force-unfreeze timelock.
    uint256 public frozenAt;
    /// Founder-queued guardian replacement, executable only while frozen and
    /// after GUARDIAN_RECOVERY_TIMELOCK_SECS. Guardians can veto via M-of-N.
    TreasuryGuardianLib.RecoveryState internal _guardianRecovery;

    // ── Review-window reduction timelock (pre-redeploy hardening) ─────────
    /// Queued (shorter) review window; 0 when nothing is pending.
    int64 internal _pendingReviewWindowSecs;
    /// Timestamp from which the queued reduction is in force.
    uint256 internal _pendingReviewWindowEffectiveAt;

    // ── Events (parity with Solana emitted events) ────────────────────────
    event DaoInitialized(uint256 indexed daoId, address founder, string name);
    event DaoPrivacyUpdated(uint8 privacyMode);
    event ConstitutionUpdated(uint8 protocolCount);
    event ReviewWindowUpdated(int64 reviewWindowSecs);
    /// A review-window REDUCTION was queued; applies at `effectiveAt`.
    event ReviewWindowChangeQueued(int64 reviewWindowSecs, uint256 effectiveAt);
    event PolicyParametersUpdated(
        uint16 reserveBps, uint16 deployedBps, uint16 liquidityBps, int64 rebalanceFreq
    );
    event GuardianConfigUpdated(uint8 threshold, uint8 walletCount);
    event GuardiansBootstrapped(uint8 threshold, uint8 walletCount);
    event LinkedTreasurySet(uint256 indexed destChainId, address treasury);
    event AgentRotationScheduled(uint256 effectiveAt);
    event AgentRotationApplied(uint8 role, address newAuthority);
    event AgentsToggled(bool enabled);
    event AgentNullified(uint8 role, address agent);
    event AgentRestored(uint8 role, address agent);
    event AgentStatusChanged(uint8 slot, uint8 oldStatus, uint8 newStatus);
    event AgentKeyRotated(uint8 slot, address oldKey, address newKey);
    event DaoEmergencyFrozen(address triggeredBy);
    event DaoEmergencyUnfrozen(address triggeredBy);
    event GuardianRecoveryQueued(uint256 executableAt, uint8 walletCount, uint8 threshold);
    event GuardianRecoveryCancelled(address by);
    event GuardianRecoveryExecuted(uint8 threshold, uint8 walletCount);
    event DaoForceUnfrozen(address by);
    event DaoTokenRegistered(address mint);
    event AdditionalTokensMinted(address mint, uint256 amount);
    event TokenAuthorityRevoked(address mint);
    event TokenMetadataUpdated(address mint);
    event AssetRegistered(address mint, uint8 assetKind, bool isStablecoin);
    event TreasurySeeded(uint256 amount, uint256 nativeBalance);
    event VaultDeposited(address depositor, address mint, uint256 amount, uint256 newNav);
    event ManagementFeeCollected(
        address mint, uint256 amount, uint256 balance, uint256 newAnchor, bool frozenRate
    );
    event PerformanceFeeSkimmed(address mint, uint256 gain, uint256 fee);
    event TreasuryRevalued(uint256 nav, uint256 deployed);
    event StrategyPositionValueUpdated(address adapter, uint256 newValue);
    event StrategyDeposited(address adapter, address mint, uint256 amount, uint256 amountUsd);
    event StrategyWithdrawn(address adapter, address mint, uint256 amount, uint256 amountUsd);
    event TransferExecuted(address mint, address recipient, uint256 amount);
    event NftTransferExecuted(address indexed collection, address indexed recipient, uint256 tokenId);
    event ProposalCountRecorded(uint64 proposalCount);
    event HolderAnnotationSet(address holder);
    event HolderAnnotationReviewed(address holder, uint8 status);

    // ── Modifiers ─────────────────────────────────────────────────────────
    // Modifier bodies are inlined into EVERY function that uses them; routing
    // through one shared internal check keeps the facade under EIP-170.
    modifier onlyFounder() {
        _only(founder);
        _;
    }

    modifier onlyGovernor() {
        _only(governor);
        _;
    }

    modifier onlyExecution() {
        _only(execution);
        _;
    }

    modifier notPaused() {
        _checkNotPaused();
        _;
    }

    modifier notFrozen() {
        _checkNotFrozen();
        _;
    }

    function _only(address authorized) internal view {
        if (msg.sender != authorized) revert NaveErrors.Unauthorized();
    }

    function _checkNotPaused() internal view {
        if (protocolContract.paused()) revert NaveErrors.GlobalPaused();
    }

    function _checkNotFrozen() internal view {
        if (frozen) revert NaveErrors.DaoFrozen();
    }

    receive() external payable {
        if (msg.value > 0) TreasuryAdminLib.wrapNativeBalance(protocolContract);
    }

    // ── NFT custody (ERC-721 / ERC-1155 receive hooks) ────────────────────
    // Without these, any NFT sent to the treasury via safeTransferFrom reverts
    // and (for unsafe transfers) would be permanently stuck. Returning the magic
    // selectors lets the treasury HOLD NFTs; they exit only via the governance
    // path (executeGovernanceNftTransfer). Selectors are the standard EIP-721 /
    // EIP-1155 receiver magic values (hardcoded to keep the facade small).
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return 0x150b7a02; // IERC721Receiver.onERC721Received.selector
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return 0xf23a6e61; // IERC1155Receiver.onERC1155Received.selector
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return 0xbc197c81; // IERC1155Receiver.onERC1155BatchReceived.selector
    }

    /// Governor-only: send a held ERC-721 to `recipient` after a passed
    /// governance NFT-transfer proposal (binding verified in NaveGovernor). The
    /// treasury holds NFTs at $0 NAV (no oracle pricing), so this does not touch
    /// NAV accounting — it only moves custody out under governance authority.
    function executeGovernanceNftTransfer(address collection, uint256 tokenId, address recipient)
        external
        onlyGovernor
    {
        IERC721(collection).safeTransferFrom(address(this), recipient, tokenId);
        emit NftTransferExecuted(collection, recipient, tokenId);
    }

    /// One-time native treasury seed, called by the factory during DAO creation
    /// with the treasury-seed carve-out of the formation fee. Wraps to WETH.
    /// Gated to the protocol's registered factory. Founder registers WETH for NAV.
    function seedNativeTreasury() external payable {
        TreasuryAdminLib.seedNativeTreasury(protocolContract, nativeSeeded);
        nativeSeeded = msg.value;
        emit TreasurySeeded(msg.value, address(this).balance);
    }

    /// Native (ETH) balance currently custodied by this treasury clone.
    /// After wrap-on-receive this should be zero outside a mid-call window.
    function nativeBalance() external view returns (uint256) {
        return address(this).balance;
    }

    /// Per-clone EIP-712 domain separator. Computed on demand (not cached) so
    /// each clone binds to its own `address(this)` and the live chain id.
    function domainSeparator() external view returns (bytes32) {
        return TreasuryGuardianLib.domainSeparator(address(this));
    }

    // ── Initialization (UUPS proxy) ───────────────────────────────────────
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(TreasuryAdminLib.InitParams calldata p) external initializer {
        TreasuryAdminLib.validateInitParams(p);
        TreasuryAdminLib.requireUniqueGuardians(p.guardianWallets);

        protocolContract = INaveProtocol(p.protocol);
        governor = p.governor;
        execution = p.execution;
        oracle = IOracle(p.oracle);
        tokenDeployer = p.tokenDeployer;
        daoId = p.daoId;
        founder = p.founder;
        name = p.name;
        privacyMode = p.privacyMode;
        quorumBps = p.quorumBps < NaveConstants.DEFAULT_QUORUM_BPS
            ? NaveConstants.DEFAULT_QUORUM_BPS
            : p.quorumBps;
        governanceType = p.governanceType;
        createdAt = block.timestamp;

        managementFeeBps = p.managementFeeBps;
        performanceFeeBps = p.performanceFeeBps;
        frozenManagementFeeBps = p.frozenManagementFeeBps;
        frozenPerformanceFeeBps = p.frozenPerformanceFeeBps;
        protocolRevenueWallet = p.protocolRevenueWallet;

        TreasuryAdminLib.initAgents(_agents, p.agentAuthorities);
        guardianThreshold = p.guardianThreshold;
        TreasuryAdminLib.initGuardians(_guardianWallets, p.guardianWallets);

        confidenceThreshold = NaveConstants.DEFAULT_CONFIDENCE_THRESHOLD;
        _reviewWindowSecs = NaveConstants.DEFAULT_REVIEW_WINDOW_SECONDS;
        minStablecoinReserveBps = NaveConstants.DEFAULT_MIN_STABLECOIN_RESERVE_BPS;
        maxTotalDeployedBps = NaveConstants.DEFAULT_MAX_TOTAL_DEPLOYED_BPS;
        minLiquidityBps = NaveConstants.DEFAULT_MIN_LIQUIDITY_BPS;
        rebalanceFrequencySecs = NaveConstants.DEFAULT_REBALANCE_FREQUENCY_SECONDS;

        emit DaoInitialized(p.daoId, p.founder, p.name);
    }

    // ── Views: protocol / agents / guardians ──────────────────────────────
    function protocol() external view returns (address) {
        return address(protocolContract);
    }

    function agent(AgentRole role) external view returns (address authority, bool operational) {
        TreasuryAdminLib.AgentSlot storage s = _agents[uint8(role)];
        authority = s.authority;
        operational = _operational(s);
    }

    function guardianCount() external view returns (uint8) {
        return uint8(_guardianWallets.length);
    }

    /// On-chain enumerable guardian set (source of truth for UI / agents).
    function getGuardians() external view returns (address[] memory wallets, uint8 threshold) {
        return (_guardianWallets, guardianThreshold);
    }

    function isGuardian(address wallet) public view returns (bool) {
        return TreasuryGuardianLib.isGuardian(_guardianWallets, wallet);
    }

    // ── Views: constitution ───────────────────────────────────────────────
    function isAdapterApproved(address adapter) external view returns (bool) {
        return _constitution[adapter].approved;
    }

    function adapterMaxAllocationBps(address adapter) external view returns (uint16) {
        return _constitution[adapter].maxAllocationBps;
    }

    function policyBps()
        external
        view
        returns (uint16 minStableReserveBps, uint16 maxTotalDeployedBps_, uint16 minLiquidityBps_)
    {
        return (minStablecoinReserveBps, maxTotalDeployedBps, minLiquidityBps);
    }

    function getApprovedAdapters()
        external
        view
        returns (
            address[] memory adapters,
            uint16[] memory maxAllocationBps,
            bool[] memory approved,
            string[] memory protocolIds
        )
    {
        return TreasuryViewLib.getApprovedAdapters(_approvedAdapters, _constitution);
    }

    // ── Views: assets / positions ─────────────────────────────────────────
    function assetInfo(address asset)
        external
        view
        returns (
            bool registered,
            bool enabled,
            bool isStablecoin,
            uint8 assetKind,
            bytes32 pythFeedId,
            uint8 decimals
        )
    {
        NaveStructs.AssetRecord storage a = _assets[asset];
        return (a.registered, a.enabled, a.isStablecoin, a.assetKind, a.pythFeedId, a.decimals);
    }

    function getRegisteredAssets() external view returns (address[] memory assets) {
        return _registeredAssets;
    }

    function idleBalance(address asset) public view returns (uint256) {
        return IERC20(asset).balanceOf(address(this));
    }

    function position(address adapter)
        external
        view
        returns (address asset, uint256 depositedAmount, uint256 currentValue)
    {
        TreasuryStrategyLib.Position storage pos = _positions[adapter];
        return (pos.asset, pos.depositedAmount, pos.currentValue);
    }

    function isTokenRegistered(address mint) external view returns (bool) {
        return _tokenIndexPlusOne[mint] != 0;
    }

    function tokenAuthorityRevoked(address mint) external view returns (bool) {
        uint256 idx = _tokenIndexPlusOne[mint];
        if (idx == 0) revert NaveErrors.TokenNotInRegistry();
        return _tokens[idx - 1].authorityRevoked;
    }

    /// Value `amount` base units of `asset` in micro-USD. Stables at $1, else
    /// the configured oracle. Mirrors `value_amount_usd`.
    function valueAssetUsd(address asset, uint256 amount) public view returns (uint256) {
        return TreasuryValuationLib.valueAssetUsdByKey(oracle, _assets, asset, amount);
    }

    // ── Founder: privacy / constitution / policy ──────────────────────────
    function setDaoPrivacy(uint8 mode) external notPaused onlyFounder {
        if (mode > uint8(PrivacyMode.Private)) revert NaveErrors.InvalidPrivacyMode();
        privacyMode = mode;
        emit DaoPrivacyUpdated(mode);
    }

    function updateConstitution(
        address[] calldata adapters,
        uint16[] calldata maxAllocationBps,
        bool[] calldata approved,
        string[] calldata protocolIds,
        uint8 newConfidenceThreshold,
        uint256 agentThresholdUsd_
    ) external notPaused notFrozen onlyFounder {
        // Every adapter must be on the protocol-level allowlist: the founder
        // cannot route capital into an arbitrary contract by editing the
        // constitution alone. (Confidence-threshold bound is checked in the lib.)
        uint8 count = TreasuryAdminLib.updateConstitution(
            protocolContract,
            _constitution,
            _approvedAdapters,
            adapters,
            maxAllocationBps,
            approved,
            protocolIds,
            newConfidenceThreshold
        );
        confidenceThreshold = newConfidenceThreshold;
        agentThresholdUsd = agentThresholdUsd_;
        emit ConstitutionUpdated(count);
    }

    /// Increases (or equal) apply immediately. REDUCTIONS are queued and come
    /// into force only after the CURRENT window has elapsed (no extra tx: see
    /// {reviewWindowSecs}), so the founder cannot shorten the window and
    /// immediately push a request through the shorter one. Floor is
    /// `NaveConstants.MIN_REVIEW_WINDOW_SECONDS` (1 hour).
    function setReviewWindow(int64 secs) external notPaused notFrozen onlyFounder {
        (_reviewWindowSecs, _pendingReviewWindowSecs, _pendingReviewWindowEffectiveAt) =
            TreasuryAdminLib.setReviewWindow(reviewWindowSecs(), secs);
    }

    /// Effective review window: a queued reduction is in force once its delay
    /// has elapsed. `NaveExecution` reads this when stamping `reviewEnd`.
    function reviewWindowSecs() public view returns (int64) {
        int64 pending = _pendingReviewWindowSecs;
        if (pending != 0 && block.timestamp >= _pendingReviewWindowEffectiveAt) return pending;
        return _reviewWindowSecs;
    }

    /// Queued review-window reduction (`secs == 0` when none is pending).
    function pendingReviewWindow() external view returns (int64 secs, uint256 effectiveAt) {
        return (_pendingReviewWindowSecs, _pendingReviewWindowEffectiveAt);
    }

    function setPolicyParameters(
        uint16 reserveBps,
        uint16 deployedBps,
        uint16 liquidityBps,
        int64 rebalanceFreq
    ) external notPaused notFrozen onlyFounder {
        TreasuryAdminLib.validatePolicyParameters(reserveBps, deployedBps, liquidityBps, rebalanceFreq);
        minStablecoinReserveBps = reserveBps;
        maxTotalDeployedBps = deployedBps;
        minLiquidityBps = liquidityBps;
        rebalanceFrequencySecs = rebalanceFreq;
        emit PolicyParametersUpdated(reserveBps, deployedBps, liquidityBps, rebalanceFreq);
    }

    // ── Guardian config / agent rotation ──────────────────────────────────
    /// Founder one-shot bootstrap (ActivationHub). After `guardiansBootstrapped`
    /// is true, further changes require a passed Permission proposal via
    /// {applyGuardianConfigFromGovernor}.
    function updateGuardianConfig(address[] calldata wallets, uint8 threshold)
        external
        notPaused
        notFrozen
        onlyFounder
    {
        if (guardiansBootstrapped) revert NaveErrors.GuardiansAlreadyBootstrapped();
        TreasuryAdminLib.updateGuardianConfig(_guardianWallets, wallets, threshold);
        guardianThreshold = threshold;
        guardiansBootstrapped = true;
        emit GuardiansBootstrapped(threshold, uint8(wallets.length));
        emit GuardianConfigUpdated(threshold, uint8(wallets.length));
    }

    /// Governor-only: apply a passed Permission proposal (or mark bootstrap done
    /// if the first change arrives via governance before founder bootstrap).
    function applyGuardianConfigFromGovernor(address[] calldata wallets, uint8 threshold)
        external
        notPaused
        notFrozen
        onlyGovernor
    {
        TreasuryAdminLib.updateGuardianConfig(_guardianWallets, wallets, threshold);
        guardianThreshold = threshold;
        if (!guardiansBootstrapped) {
            guardiansBootstrapped = true;
            emit GuardiansBootstrapped(threshold, uint8(wallets.length));
        }
        emit GuardianConfigUpdated(threshold, uint8(wallets.length));
    }

    /// Founder registers a sister treasury on `destChainId` for agent bridges.
    /// Overwrites are allowed while unfrozen so ops can rotate destinations;
    /// agents always read the live allowlist. The target must be a sister
    /// treasury the protocol owner has registered for that chain
    /// (`NaveProtocol.isRemoteTreasury`); `address(0)` clears the link.
    function setLinkedTreasury(uint256 destChainId, address treasury_)
        external
        notPaused
        notFrozen
        onlyFounder
    {
        TreasuryAdminLib.validateLinkedTreasury(protocolContract, destChainId, treasury_);
        linkedTreasury[destChainId] = treasury_;
        emit LinkedTreasurySet(destChainId, treasury_);
    }

    /// Schedule agent authority rotations behind the 48h timelock (parity with
    /// `update_agent_set`). A nullified slot is skipped; an unchanged authority
    /// clears any pending rotation.
    function updateAgentSet(address[4] calldata authorities)
        external
        notPaused
        notFrozen
        onlyFounder
    {
        uint256 effectiveAt =
            TreasuryAdminLib.scheduleAgentRotations(_agents, _pendingRotations, authorities);
        emit AgentRotationScheduled(effectiveAt);
    }

    function applyAgentRotation(uint8 role) external notPaused onlyFounder {
        address newAuthority = TreasuryAdminLib.applyAgentRotation(_agents, _pendingRotations, role);
        emit AgentRotationApplied(role, newAuthority);
    }

    // ── Agent enable / nullify / restore ──────────────────────────────────
    /// Enabling the pipeline is an Executive op. Disabling goes through the
    /// guardian M-of-N {guardianDisableAgents} (NE-6).
    function toggleAgents(bool enabled) external notPaused {
        if (!enabled) revert NaveErrors.AgentsDisableRequiresGuardians();
        _requireAgentAuthority(msg.sender, AgentRole.Executive);
        agentsEnabled = true;
        emit AgentsToggled(true);
    }

    /// Nullify an agent slot and freeze the DAO. Parity with Solana
    /// `nullify_agent` (SOL-H2): guardian M-of-N only — Executive cannot
    /// unilaterally nullify → freeze and then break-glass-execute a
    /// pre-approval request. `agentSlot` is the role index (0–3).
    function nullifyAgent(
        uint8 role,
        uint64 nonce,
        uint64 deadline,
        bytes[] calldata signatures
    ) external notPaused {
        frozenAt = TreasuryGuardianLib.nullifyAgent(
            _usedGuardianDigest,
            _guardianWallets,
            guardianThreshold,
            _agents,
            frozenAt,
            role,
            nonce,
            deadline,
            signatures
        );
        frozen = true;
    }

    /// Executive may restore a previously nullified slot. Does NOT unfreeze —
    /// guardians must explicitly {emergencyUnfreeze}.
    function restoreAgent(uint8 role) external notPaused {
        _requireAgentAuthority(msg.sender, AgentRole.Executive);
        address authority = TreasuryAdminLib.restoreAgent(_agents, role);
        emit AgentRestored(role, authority);
    }

    // NOTE: the single-actor `emergencyPauseAgents()` (founder OR any one
    // guardian) was removed. Disabling agents unlocks the Executive break-glass
    // `NaveExecution.executeDirect` path, so a single key could manufacture the
    // condition that bypasses the live agent pipeline. Agent-disable now
    // requires the guardian M-of-N {guardianDisableAgents} (NE-6).

    // ── Guardian M-of-N (EIP-712 + bitmask aggregation) ───────────────────
    function emergencyFreeze(uint64 nonce, uint64 deadline, bytes[] calldata signatures)
        external
        notPaused
    {
        frozenAt = TreasuryGuardianLib.emergencyFreeze(
            _usedGuardianDigest,
            _guardianWallets,
            guardianThreshold,
            frozenAt,
            nonce,
            deadline,
            signatures
        );
        frozen = true;
    }

    function emergencyUnfreeze(uint64 nonce, uint64 deadline, bytes[] calldata signatures)
        external
        notPaused
    {
        TreasuryGuardianLib.emergencyUnfreeze(
            _usedGuardianDigest,
            _guardianWallets,
            guardianThreshold,
            _guardianRecovery,
            nonce,
            deadline,
            signatures
        );
        frozen = false;
        frozenAt = 0;
    }

    function queueGuardianRecovery(address[] calldata wallets, uint8 threshold)
        external
        notPaused
        onlyFounder
    {
        TreasuryGuardianLib.queueGuardianRecovery(frozen, _guardianRecovery, wallets, threshold);
    }

    function executeGuardianRecovery() external notPaused onlyFounder {
        guardianThreshold = TreasuryGuardianLib.executeGuardianRecovery(
            frozen, _guardianRecovery, _guardianWallets
        );
    }

    function cancelGuardianRecovery() external notPaused onlyFounder {
        TreasuryGuardianLib.cancelGuardianRecovery(_guardianRecovery);
    }

    function guardianVetoRecovery(uint64 nonce, uint64 deadline, bytes[] calldata signatures)
        external
        notPaused
    {
        TreasuryGuardianLib.guardianVetoRecovery(
            _usedGuardianDigest,
            _guardianWallets,
            guardianThreshold,
            _guardianRecovery,
            nonce,
            deadline,
            signatures
        );
    }

    function guardianRecoveryPending()
        external
        view
        returns (uint256 executableAt, uint8 pendingThreshold, uint256 pendingWalletCount)
    {
        return TreasuryGuardianLib.recoveryPending(_guardianRecovery);
    }

    function forceUnfreeze() external notPaused {
        TreasuryGuardianLib.forceUnfreeze(protocolContract, frozen, frozenAt, _guardianRecovery);
        frozen = false;
        frozenAt = 0;
    }

    function guardianDisableAgents(uint64 nonce, uint64 deadline, bytes[] calldata signatures)
        external
        notPaused
    {
        TreasuryGuardianLib.guardianDisableAgents(
            _usedGuardianDigest,
            _guardianWallets,
            guardianThreshold,
            nonce,
            deadline,
            signatures
        );
        agentsEnabled = false;
    }

    function updateAgentStatus(
        uint8 slot,
        uint8 newStatus,
        uint64 nonce,
        uint64 deadline,
        bytes[] calldata signatures
    ) external notPaused {
        TreasuryGuardianLib.updateAgentStatus(
            _usedGuardianDigest,
            _guardianWallets,
            guardianThreshold,
            _agents,
            slot,
            newStatus,
            nonce,
            deadline,
            signatures
        );
    }

    function rotateAgentKey(
        uint8 slot,
        address newKey,
        uint64 nonce,
        uint64 deadline,
        bytes[] calldata signatures
    ) external notPaused {
        TreasuryGuardianLib.rotateAgentKey(
            _usedGuardianDigest,
            _guardianWallets,
            guardianThreshold,
            _agents,
            _pendingRotations,
            slot,
            newKey,
            nonce,
            deadline,
            signatures
        );
    }

    // ── Tokens ────────────────────────────────────────────────────────────
    function registerDaoToken(
        string calldata tokenName,
        string calldata symbol,
        uint8 decimals_,
        uint256 initialSupply,
        address initialRecipient
    ) external payable notPaused onlyFounder returns (address mint) {
        TreasuryAdminLib.chargeTokenMintFee(protocolContract, msg.value, msg.sender);
        mint = TreasuryAdminLib.registerDaoToken(
            _tokens,
            _tokenIndexPlusOne,
            tokenDeployer,
            tokenName,
            symbol,
            decimals_,
            initialSupply,
            initialRecipient
        );
        // First registered token becomes the default voting token.
        if (votingToken == address(0)) votingToken = mint;
        emit DaoTokenRegistered(mint);
    }

    /// Founder: register an existing ERC-20 for token-weighted governance (no deploy).
    function registerExternalDaoToken(
        address mint,
        string calldata tokenName,
        string calldata symbol,
        uint8 decimals_
    ) external notPaused onlyFounder {
        TreasuryAdminLib.registerExternalDaoToken(
            _tokens, _tokenIndexPlusOne, mint, tokenName, symbol, decimals_
        );
        if (votingToken == address(0)) votingToken = mint;
        emit DaoTokenRegistered(mint);
    }

    /// Governor-gated: mint additional supply of a registered, non-revoked token
    /// (the founder check lives in the Governor).
    function mintRegisteredToken(address mint, address to, uint256 amount) external onlyGovernor {
        TreasuryAdminLib.mintRegisteredToken(_tokens, _tokenIndexPlusOne, mint, to, amount);
        emit AdditionalTokensMinted(mint, amount);
    }

    function revokeTokenAuthority(address mint) external notPaused onlyFounder {
        TreasuryAdminLib.revokeTokenAuthority(_tokens, _tokenIndexPlusOne, mint);
        emit TokenAuthorityRevoked(mint);
    }

    function updateTokenMetadata(address mint, string calldata tokenName, string calldata symbol)
        external
        notPaused
        onlyFounder
    {
        TreasuryAdminLib.updateTokenMetadata(_tokens, _tokenIndexPlusOne, mint, tokenName, symbol);
        emit TokenMetadataUpdated(mint);
    }

    /// Governor-gated voting-system switch (parity with `switch_voting_system`).
    function switchVotingSystem(uint8 newGovernanceType, address newVotingToken)
        external
        onlyGovernor
    {
        if (newGovernanceType > uint8(GovernanceType.Token)) {
            revert NaveErrors.InvalidGovernanceType();
        }
        governanceType = newGovernanceType;
        votingToken = newVotingToken;
    }

    // ── Assets: register / deposit / fee / revalue ────────────────────────
    function registerAsset(address asset, bytes32 pythFeedId, bool isStablecoin, uint8 assetKind)
        external
        notPaused
        notFrozen
        onlyFounder
    {
        TreasuryAdminLib.registerAsset(
            _assets, _registeredAssets, asset, pythFeedId, isStablecoin, assetKind
        );
        emit AssetRegistered(asset, assetKind, isStablecoin);
    }

    function setAssetEnabled(address asset, bool enabled) external notPaused onlyFounder {
        TreasuryAdminLib.setAssetEnabled(_assets, asset, enabled);
    }

    function deposit(address asset, uint256 amount) external nonReentrant notPaused notFrozen {
        TreasuryAdminLib.requireNotMoonlighting(protocolContract);
        (totalDeposited, currentNav, highWaterMark) = TreasuryAdminLib.deposit(
            oracle, _assets, asset, amount, totalDeposited, currentNav, highWaterMark
        );
        emit VaultDeposited(msg.sender, asset, amount, currentNav);
    }

    /// Treasury withdrawals must flow through the execution pipeline.
    function withdrawFromVault(address, uint256) external pure {
        revert NaveErrors.ExecutionRequestRequired();
    }

    /// Discrete annual management fee for one registered asset, paid in-kind to
    /// the protocol revenue wallet. Permissionless-but-validated.
    function collectManagementFee(address asset) external nonReentrant notPaused {
        uint16 feeBps = frozen ? frozenManagementFeeBps : managementFeeBps;
        uint256 balance = idleBalance(asset);
        (uint256 fee, uint256 newAnchor) = TreasuryAdminLib.collectManagementFee(
            IERC20(asset), _assets[asset], feeBps, protocolRevenueWallet, balance
        );
        emit ManagementFeeCollected(asset, fee, balance, newAnchor, frozen);
    }

    /// Recompute NAV (idle + deployed base units valued in USD) across all
    /// registered assets. Mirrors `revalue_treasury`. SEC-M5: nonReentrant
    /// (shared guard with {deposit}) so a hook-bearing token can never reenter
    /// a revalue mid-deposit and double-count NAV.
    function revalueTreasury() external nonReentrant notPaused {
        _requireFounderOrOperational();
        (uint256 nav, uint256 deployedUsd) =
            TreasuryValuationLib.revalueAll(address(this), oracle, _assets, _registeredAssets);
        currentNav = nav;
        deployedCapital = deployedUsd;
        if (nav > highWaterMark) highWaterMark = nav;
        lastRevaluedAt = block.timestamp;
        emit TreasuryRevalued(nav, deployedUsd);
    }

    /// Mark a strategy position's value (reflecting accrued yield). Founder or
    /// Operational agent. Mirrors `update_strategy_position_value`.
    function updateStrategyPositionValue(address adapter, uint256 newValue) external notPaused {
        _requireFounderOrOperational();
        TreasuryStrategyLib.updatePositionValue(_positions[adapter], newValue);
        emit StrategyPositionValueUpdated(adapter, newValue);
    }

    // ── Holder annotations ────────────────────────────────────────────────
    function setHolderAnnotation(string calldata text) external notPaused {
        TreasuryAdminLib.setHolderAnnotation(_annotations, text);
        emit HolderAnnotationSet(msg.sender);
    }

    function approveHolderAnnotation(address holder) external notPaused {
        _reviewAnnotation(holder, uint8(AnnotationStatus.Approved));
    }

    function denyHolderAnnotation(address holder) external notPaused {
        _reviewAnnotation(holder, uint8(AnnotationStatus.Denied));
    }

    function holderAnnotation(address holder)
        external
        view
        returns (bool exists, uint8 status, string memory text)
    {
        NaveStructs.Annotation storage ann = _annotations[holder];
        return (ann.exists, ann.status, ann.text);
    }

    // ── Governor-gated mutators ───────────────────────────────────────────
    function recordProposalCreation() external onlyGovernor {
        proposalCount += 1;
        nextProposalIndex += 1;
        emit ProposalCountRecorded(proposalCount);
    }

    function archiveProposals(uint64 count) external notPaused onlyFounder {
        if (count == 0 || count > proposalCount) revert NaveErrors.MathOverflow();
        proposalCount -= count;
        archivedProposals += count;
    }

    // ── Execution-gated strategy hooks ────────────────────────────────────
    /// Move idle `asset` to an approved `adapter` ahead of a deposit. The
    /// allocation / reserve / NAV checks live in `NaveExecution`.
    function transferForStrategy(address asset, address adapter, uint256 amount)
        external
        onlyExecution
    {
        IERC20(asset).safeTransfer(adapter, amount);
    }

    function recordStrategyDeposit(
        address adapter,
        address asset,
        uint256 amount,
        uint256 amountUsd
    ) external onlyExecution {
        TreasuryStrategyLib.recordDeposit(
            _positions[adapter], _assets[asset], adapter, asset, amount, amountUsd
        );
        deployedCapital += amountUsd;
        emit StrategyDeposited(adapter, asset, amount, amountUsd);
    }

    /// Record a strategy withdrawal. The adapter has already returned the
    /// underlying to this treasury. The 8.5% performance skim is taken on the
    /// realized gain and sent to the protocol revenue wallet before the position
    /// counters are reduced. Mirrors `record_strategy_withdrawal` + the inline
    /// performance-fee skim.
    function recordStrategyWithdrawal(
        address adapter,
        address asset,
        uint256 amount,
        uint256 amountUsd
    ) external onlyExecution nonReentrant returns (uint256 perfFeeSkimmed) {
        uint16 feeBps = frozen ? frozenPerformanceFeeBps : performanceFeeBps;
        uint256 gain;
        (perfFeeSkimmed, deployedCapital, gain, totalWithdrawn) = TreasuryAdminLib.recordStrategyWithdrawal(
            _positions,
            _assets,
            adapter,
            asset,
            amount,
            amountUsd,
            deployedCapital,
            feeBps,
            protocolRevenueWallet,
            totalWithdrawn
        );
        if (perfFeeSkimmed > 0) emit PerformanceFeeSkimmed(asset, gain, perfFeeSkimmed);
        emit StrategyWithdrawn(adapter, asset, amount, amountUsd);
    }

    /// Transfer-proposal (type 8) handler: move `amount` of `asset` to
    /// `recipient`. Authorized exclusively via the `NaveExecution` pipeline.
    function executeTransfer(address asset, address recipient, uint256 amount)
        external
        onlyExecution
    {
        _executeTreasuryTransfer(asset, recipient, amount);
    }

    /// Governor-only: same payout as `executeTransfer` for direct post-vote
    /// execution of passed Transfer proposals (no agent pipeline).
    function executeGovernanceTransfer(address asset, address recipient, uint256 amount)
        external
        onlyGovernor
    {
        _executeTreasuryTransfer(asset, recipient, amount);
    }

    function _executeTreasuryTransfer(address asset, address recipient, uint256 amount) internal {
        (currentNav, totalWithdrawn) = TreasuryAdminLib.executeTransfer(
            oracle, _assets, asset, recipient, amount, currentNav, totalWithdrawn
        );
        emit TransferExecuted(asset, recipient, amount);
    }

    // ── Internal helpers ──────────────────────────────────────────────────
    function _reviewAnnotation(address holder, uint8 status) internal {
        TreasuryGuardianLib.requireFounderOrGuardian(_guardianWallets, founder, msg.sender);
        TreasuryAdminLib.reviewAnnotation(_annotations, holder, status);
        emit HolderAnnotationReviewed(holder, status);
    }

    function _requireAgentAuthority(address signer, AgentRole role) internal view {
        TreasuryAdminLib.AgentSlot storage s = _agents[uint8(role)];
        if (!_operational(s)) revert NaveErrors.AgentNullified();
        if (signer != s.authority) revert NaveErrors.Unauthorized();
    }

    function _requireFounderOrOperational() internal view {
        if (msg.sender != founder && !_isOperationalAgent(AgentRole.Operational, msg.sender)) {
            revert NaveErrors.Unauthorized();
        }
    }

    function _isOperationalAgent(AgentRole role, address signer) internal view returns (bool) {
        TreasuryAdminLib.AgentSlot storage s = _agents[uint8(role)];
        return _operational(s) && signer == s.authority;
    }

    /// Single definition of "operational" shared by {agent},
    /// {_requireAgentAuthority} and {_isOperationalAgent} (bytecode).
    function _operational(TreasuryAdminLib.AgentSlot storage s) internal view returns (bool) {
        return s.active && !s.nullified && s.status == uint8(AgentStatus.Active)
            && s.authority != address(0);
    }

    function _authorizeUpgrade(address newImplementation) internal override {
        if (msg.sender != governor) revert NaveErrors.Unauthorized();
        if (
            !protocolContract.isApprovedImplementation(
                uint8(DaoImplRole.Treasury), newImplementation
            )
        ) revert NaveErrors.ImplNotApproved();
    }

    function currentImplementation() external view returns (address) {
        return ERC1967Utils.getImplementation();
    }

    /// True if any of this DAO's T/G/E proxies differs from protocol latest.
    function needsUpgrade() external view returns (bool) {
        return TreasuryViewLib.needsUpgrade(address(protocolContract), governor, execution);
    }

    /// Was 40; two slots consumed by `pendingReviewWindowSecs` +
    /// `pendingReviewWindowEffectiveAt` (appended after `_guardianRecovery`).
    uint256[38] private __gap;
}
