// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";

import {INaveExecution} from "./interfaces/INaveExecution.sol";
import {INaveTreasury} from "./interfaces/INaveTreasury.sol";
import {INaveGovernor} from "./interfaces/INaveGovernor.sol";
import {INaveProtocol} from "./interfaces/INaveProtocol.sol";
import {INaveDaoStake} from "./interfaces/INaveDaoStake.sol";
import {IStrategyAdapter} from "./interfaces/IStrategyAdapter.sol";
import {IBridgeAdapter} from "./interfaces/IBridgeAdapter.sol";
import {IQueuedExitAdapter} from "./interfaces/IQueuedExitAdapter.sol";
import {NaveConstants} from "./libraries/NaveConstants.sol";
import {NaveErrors} from "./libraries/NaveErrors.sol";
import {BpsGates} from "./libraries/BpsGates.sol";
import {FeeMath} from "./libraries/FeeMath.sol";
import {PayloadHash} from "./libraries/PayloadHash.sol";
import {
    AgentRole,
    ProposalType,
    ProposalStatus,
    ExecutionStatus,
    ExecutionKind,
    DaoImplRole
} from "./libraries/NaveEnums.sol";

/// @title NaveExecution
/// @notice Per-DAO execution UUPS proxy. EVM port of `nave_execution`.
contract NaveExecution is INaveExecution, Initializable, UUPSUpgradeable, ReentrancyGuard {
    struct ExecutionRequest {
        bool exists;
        uint8 kind; // ExecutionKind
        uint8 status; // ExecutionStatus
        bool bootstrap; // one-time founder zero-review-window first action
        uint64 proposalIndex;
        address adapter; // strategy / bridge target (0 for Transfer)
        address asset;
        address recipient; // Transfer destination OR bridge destTreasury
        uint256 amount;
        uint256 reviewEnd;
        int64 reviewWindow;
        uint256 withdrawnAmount;
        bytes32 txPayloadHash;
        bytes32 executiveReasoningHash;
        bytes32 financialReasoningHash;
        bytes32 oversightReasoningHash;
        bytes32 operationalHaltReasonHash;
        uint256 createdAt;
        uint256 updatedAt;
        uint256 executedAt;
        /// Destination chain for Bridge requests (0 for Strategy/Transfer).
        uint256 destChainId;
    }

    INaveTreasury public treasuryContract;
    INaveGovernor public governorContract;
    INaveProtocol public protocolContract;
    /// One-time gate: set true after the founder uses the zero-review-window
    /// bootstrap path so the FIRST action can execute immediately and every
    /// subsequent request falls back to the configured review window.
    bool public bootstrapUsed;

    mapping(uint64 => ExecutionRequest) internal _requests;

    event ExecutionRequestCreated(
        uint64 indexed index, uint8 kind, address adapter, address asset, uint256 amount
    );
    /// Emitted when the founder consumes the one-time zero-review-window
    /// bootstrap path (indexers should treat this request's review window as 0).
    event BootstrapExecutionRequest(uint64 indexed index, uint8 kind, address founder);
    event ExecutiveApproved(uint64 indexed index, address approver);
    event FinancialApproved(uint64 indexed index, address approver, bytes32 txPayloadHash);
    event OversightApproved(uint64 indexed index, address approver, uint256 reviewEnd);
    event OperationalHalt(uint64 indexed index, bytes32 reasonHash);
    event OperationalClear(uint64 indexed index, bytes32 reasonHash);
    event PositionSynced(address indexed adapter, uint256 observed, uint256 applied);
    event ExecutionExpired(uint64 indexed index);
    event StrategyExecuted(uint64 indexed index, uint256 amount);
    event DirectStrategyExecuted(uint64 indexed index, uint256 amount);
    event TransferExecuted(uint64 indexed index, address recipient, uint256 amount);
    event BridgeExecuted(
        uint64 indexed index, address adapter, address destTreasury, uint256 destChainId, bytes32 correlationId
    );
    event StrategyWithdrawn(uint64 indexed index, uint256 amount);
    event StrategyExitRequested(uint64 indexed index, uint256 amount, uint256 readyAt);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address treasury_, address governor_, address protocol_)
        external
        initializer
    {
        treasuryContract = INaveTreasury(treasury_);
        governorContract = INaveGovernor(governor_);
        protocolContract = INaveProtocol(protocol_);
    }

    function _authorizeUpgrade(address newImplementation) internal override {
        if (msg.sender != address(governorContract)) revert NaveErrors.Unauthorized();
        if (
            !protocolContract.isApprovedImplementation(
                uint8(DaoImplRole.Execution), newImplementation
            )
        ) revert NaveErrors.ImplNotApproved();
    }

    function currentImplementation() external view returns (address) {
        return ERC1967Utils.getImplementation();
    }

    function treasury() external view returns (address) {
        return address(treasuryContract);
    }

    function governor() external view returns (address) {
        return address(governorContract);
    }

    function requestStatus(uint64 index) external view returns (ExecutionStatus) {
        return ExecutionStatus(_requests[index].status);
    }

    /// True once an execution request has been created for `index`. The governor's
    /// direct Transfer path reads this to refuse disbursing a proposal already
    /// claimed by the agent pipeline.
    function requestExists(uint64 index) external view returns (bool) {
        return _requests[index].exists;
    }

    function getRequest(uint64 index) external view returns (ExecutionRequest memory) {
        return _requests[index];
    }

    modifier notPaused() {
        if (protocolContract.paused()) revert NaveErrors.GlobalPaused();
        _;
    }

    // ── Request creation ──────────────────────────────────────────────────
    /// Create a Strategy execution request bound to a passed Strategy proposal.
    /// Binds (adapter, amount, asset) to the governance-approved payload hash.
    function createStrategyRequest(
        uint64 proposalIndex,
        uint256 amount,
        address adapter,
        address asset
    ) external notPaused {
        _createStrategyRequest(proposalIndex, amount, adapter, asset, false);
    }

    /// One-time, founder-gated bootstrap: create the DAO's FIRST Strategy request
    /// with a review window of 0 so the agents can deploy immediately. Mirrors
    /// the Solana bootstrap path. All later requests use the configured window.
    function createStrategyRequestBootstrap(
        uint64 proposalIndex,
        uint256 amount,
        address adapter,
        address asset
    ) external notPaused {
        _requireBootstrapFounder();
        _createStrategyRequest(proposalIndex, amount, adapter, asset, true);
        emit BootstrapExecutionRequest(proposalIndex, uint8(ExecutionKind.Strategy), msg.sender);
    }

    /// Create a Transfer execution request bound to a passed Transfer (type 8)
    /// proposal. Binds (asset, recipient, amount) to the approved payload hash.
    function createTransferRequest(
        uint64 proposalIndex,
        address asset,
        address recipient,
        uint256 amount
    ) external notPaused {
        _createTransferRequest(proposalIndex, asset, recipient, amount);
    }

    /// Create a Bridge execution request bound to a passed Strategy proposal
    /// whose payload is `PayloadHash.bridgeHash(adapter, amount, asset, destChainId, destTreasury)`.
    function createBridgeRequest(
        uint64 proposalIndex,
        uint256 amount,
        address adapter,
        address asset,
        uint256 destChainId,
        address destTreasury
    ) external notPaused {
        _createBridgeRequest(
            proposalIndex, amount, adapter, asset, destChainId, destTreasury, false
        );
    }

    function _createStrategyRequest(
        uint64 proposalIndex,
        uint256 amount,
        address adapter,
        address asset,
        bool bootstrap
    ) internal {
        if (treasuryContract.frozen()) revert NaveErrors.DaoFrozen();
        _requireNotMoonlighting();
        if (amount == 0) revert NaveErrors.MathOverflow();
        _requireProposalPassed(proposalIndex, ProposalType.Strategy);
        if (!treasuryContract.isAdapterApproved(adapter)) revert NaveErrors.ProtocolNotApproved();

        (,, bytes32 payloadHash,,) = governorContract.proposalCore(proposalIndex);
        if (PayloadHash.strategyHash(adapter, amount, asset) != payloadHash) {
            revert NaveErrors.PayloadHashMismatch();
        }
        _createRequest(
            proposalIndex,
            ExecutionKind.Strategy,
            adapter,
            asset,
            address(0),
            amount,
            payloadHash,
            bootstrap
        );
        emit ExecutionRequestCreated(
            proposalIndex, uint8(ExecutionKind.Strategy), adapter, asset, amount
        );
    }

    function _createTransferRequest(
        uint64 proposalIndex,
        address asset,
        address recipient,
        uint256 amount
    ) internal {
        if (treasuryContract.frozen()) revert NaveErrors.DaoFrozen();
        if (amount == 0) revert NaveErrors.MathOverflow();
        if (recipient == address(0)) revert NaveErrors.ZeroAddress();
        _requireProposalPassed(proposalIndex, ProposalType.Transfer);

        (,, bytes32 payloadHash,,) = governorContract.proposalCore(proposalIndex);
        if (PayloadHash.transferHash(asset, recipient, amount) != payloadHash) {
            revert NaveErrors.PayloadHashMismatch();
        }
        _createRequest(
            proposalIndex,
            ExecutionKind.Transfer,
            address(0),
            asset,
            recipient,
            amount,
            payloadHash,
            false
        );
        emit ExecutionRequestCreated(
            proposalIndex, uint8(ExecutionKind.Transfer), address(0), asset, amount
        );
    }

    function _createBridgeRequest(
        uint64 proposalIndex,
        uint256 amount,
        address adapter,
        address asset,
        uint256 destChainId,
        address destTreasury,
        bool bootstrap
    ) internal {
        if (treasuryContract.frozen()) revert NaveErrors.DaoFrozen();
        _requireNotMoonlighting();
        if (amount == 0) revert NaveErrors.MathOverflow();
        if (destTreasury == address(0) || adapter == address(0)) revert NaveErrors.ZeroAddress();
        _requireProposalPassed(proposalIndex, ProposalType.Strategy);
        if (!treasuryContract.isAdapterApproved(adapter)) revert NaveErrors.ProtocolNotApproved();

        address linked = treasuryContract.linkedTreasury(destChainId);
        if (linked == address(0)) revert NaveErrors.LinkedTreasuryNotSet();
        if (linked != destTreasury) revert NaveErrors.LinkedTreasuryMismatch();
        if (!IBridgeAdapter(adapter).supportsRoute(asset, destChainId)) {
            revert NaveErrors.UnsupportedBridgeRoute();
        }

        (,, bytes32 payloadHash,,) = governorContract.proposalCore(proposalIndex);
        if (PayloadHash.bridgeHash(adapter, amount, asset, destChainId, destTreasury) != payloadHash)
        {
            revert NaveErrors.PayloadHashMismatch();
        }
        _createRequest(
            proposalIndex,
            ExecutionKind.Bridge,
            adapter,
            asset,
            destTreasury,
            amount,
            payloadHash,
            bootstrap
        );
        _requests[proposalIndex].destChainId = destChainId;
        emit ExecutionRequestCreated(
            proposalIndex, uint8(ExecutionKind.Bridge), adapter, asset, amount
        );
    }

    /// Consume the one-time founder bootstrap gate. Founder is read from the
    /// treasury clone; the bypass can be used exactly once per DAO.
    function _requireBootstrapFounder() internal {
        if (bootstrapUsed) revert NaveErrors.BootstrapAlreadyUsed();
        if (msg.sender != treasuryContract.founder()) revert NaveErrors.Unauthorized();
        bootstrapUsed = true;
    }

    function _requireNotMoonlighting() internal view {
        address stake = protocolContract.daoStake();
        if (stake == address(0)) return;
        if (INaveDaoStake(stake).isMoonlighting(address(treasuryContract))) {
            revert NaveErrors.DaoMoonlighting();
        }
    }

    // ── Approval pipeline ─────────────────────────────────────────────────
    function executiveApprove(uint64 index, bytes32 reasoningHash) external {
        _validateAgentSigner(AgentRole.Executive);
        if (reasoningHash == bytes32(0)) revert NaveErrors.ReasoningHashRequired();
        _transition(index, ExecutionStatus.Pending, ExecutionStatus.ExecutiveApproved);
        _requests[index].executiveReasoningHash = reasoningHash;
        emit ExecutiveApproved(index, msg.sender);
    }

    function financialApprove(uint64 index, bytes32 txPayloadHash, bytes32 reasoningHash) external {
        _validateAgentSigner(AgentRole.Financial);
        if (reasoningHash == bytes32(0)) revert NaveErrors.ReasoningHashRequired();
        _transition(index, ExecutionStatus.ExecutiveApproved, ExecutionStatus.FinancialApproved);
        // Bind to the hash captured at creation; the financial agent may not
        // substitute a different payload (it cannot overwrite the stored hash).
        if (txPayloadHash == bytes32(0) || txPayloadHash != _requests[index].txPayloadHash) {
            revert NaveErrors.PayloadHashMismatch();
        }
        _requests[index].financialReasoningHash = reasoningHash;
        emit FinancialApproved(index, msg.sender, txPayloadHash);
    }

    function oversightApprove(uint64 index, bytes32 txPayloadHash, bytes32 reasoningHash) external {
        _validateAgentSigner(AgentRole.Oversight);
        if (reasoningHash == bytes32(0)) revert NaveErrors.ReasoningHashRequired();
        ExecutionRequest storage r = _requests[index];
        if (txPayloadHash == bytes32(0) || txPayloadHash != r.txPayloadHash) {
            revert NaveErrors.PayloadHashMismatch();
        }
        _transition(index, ExecutionStatus.FinancialApproved, ExecutionStatus.OversightApproved);

        // Bootstrap requests force a 0 window (reviewEnd == now → immediately
        // executable). Non-bootstrap requests use the snapshotted window, falling
        // back to the default if it was somehow left unset.
        int64 window = r.bootstrap
            ? int64(0)
            : (r.reviewWindow > 0 ? r.reviewWindow : NaveConstants.defaultReviewWindowSecs());
        r.status = uint8(ExecutionStatus.InReview);
        r.reviewEnd = block.timestamp + uint256(int256(window));
        r.updatedAt = block.timestamp;
        r.oversightReasoningHash = reasoningHash;
        emit OversightApproved(index, msg.sender, r.reviewEnd);
    }

    function operationalHalt(uint64 index, bytes32 reasonHash) external {
        _validateAgentSigner(AgentRole.Operational);
        if (reasonHash == bytes32(0)) revert NaveErrors.ReasoningHashRequired();
        ExecutionRequest storage r = _requests[index];
        if (
            r.status != uint8(ExecutionStatus.InReview)
                && r.status != uint8(ExecutionStatus.OversightApproved)
        ) {
            revert NaveErrors.InvalidStateTransition();
        }
        r.status = uint8(ExecutionStatus.Halted);
        r.updatedAt = block.timestamp;
        r.operationalHaltReasonHash = reasonHash;
        emit OperationalHalt(index, reasonHash);
    }

    function operationalClear(uint64 index, bytes32 reasonHash) external {
        _validateAgentSigner(AgentRole.Operational);
        if (reasonHash == bytes32(0)) revert NaveErrors.ReasoningHashRequired();
        ExecutionRequest storage r = _requests[index];
        if (r.status != uint8(ExecutionStatus.Halted)) revert NaveErrors.InvalidStateTransition();
        r.status = uint8(ExecutionStatus.InReview);
        r.updatedAt = block.timestamp;
        emit OperationalClear(index, reasonHash);
    }

    function expireRequest(uint64 index) external {
        _validateAgentSigner(AgentRole.Operational);
        ExecutionRequest storage r = _requests[index];
        if (r.status != uint8(ExecutionStatus.InReview)) {
            revert NaveErrors.InvalidStateTransition();
        }
        if (block.timestamp < r.reviewEnd) revert NaveErrors.ReviewWindowActive();
        r.status = uint8(ExecutionStatus.Expired);
        r.updatedAt = block.timestamp;
        emit ExecutionExpired(index);
    }

    // ── Execution ─────────────────────────────────────────────────────────
    /// Post-review execution. Executive only, and only while agents are enabled
    /// and the DAO is not frozen (frozen DAOs may only move via
    /// {executeDirect}). `minOut` is the caller-supplied slippage floor for the
    /// underlying adapter join; strategy deposits additionally must book at
    /// least `amount * (1 - DEPOSIT_SLIPPAGE_BPS)` of adapter position value.
    /// It is ignored for Transfer requests.
    ///
    /// EVM-C2: a permissionless caller could time a flash loan against a
    /// shared adapter's pool state and dictate `minOut`. Restricting execution
    /// to the Executive (the role that opened the pipeline) closes that vector
    /// and keeps Financial / Oversight / Operational within their roles.
    function execute(uint64 index, uint256 minOut) external notPaused nonReentrant {
        _validateAgentSigner(AgentRole.Executive);
        ExecutionRequest storage r = _requests[index];
        if (
            r.status != uint8(ExecutionStatus.InReview)
                && r.status != uint8(ExecutionStatus.OversightApproved)
        ) {
            revert NaveErrors.InvalidStateTransition();
        }
        if (r.status == uint8(ExecutionStatus.InReview) && block.timestamp < r.reviewEnd) {
            revert NaveErrors.ReviewWindowActive();
        }
        // Solana `execute_strategy` parity: capital-deploying kinds (Strategy /
        // Bridge) are halted while the DAO is moonlighting. Transfers stay
        // allowed so an approved wind-down can still disburse assets.
        if (r.kind != uint8(ExecutionKind.Transfer)) _requireNotMoonlighting();
        _runExecution(index, minOut);
        emit StrategyExecuted(index, r.amount);
    }

    /// Break-glass: Executive override allowed only when the DAO is frozen or
    /// agents are disabled. Parity with Solana `execute_strategy_direct`: the
    /// request MUST already have completed the three-agent approval pipeline
    /// (`InReview` or `OversightApproved`). Rejecting earlier states prevents a
    /// rogue Executive from self-creating the frozen/disabled condition (e.g.
    /// via nullify) and then executing a still-Pending request that bypassed
    /// Financial and Oversight review. `minOut` threads the deposit slippage
    /// floor as in {execute}.
    ///
    /// Hardening (pre-redeploy audit):
    ///  * `InReview` requests must have cleared `reviewEnd` — the break-glass
    ///    path is NOT a review-window bypass (same gate as {execute}).
    ///  * Only `Strategy` requests (capital stays custodied by an approved
    ///    adapter) may be forced. `Transfer` and `Bridge` requests move funds to
    ///    EXTERNAL recipients and must go through {execute} with live agents.
    ///  * Blocked while the DAO is moonlighting (Solana `require_not_moonlighting`
    ///    parity): the moonlight halt disables agents, which is exactly the
    ///    condition that unlocks this path, so it must be refused explicitly.
    function executeDirect(uint64 index, uint256 minOut) external notPaused nonReentrant {
        if (!treasuryContract.frozen() && treasuryContract.agentsEnabled()) {
            revert NaveErrors.DirectExecutionNotAllowed();
        }
        _requireNotMoonlighting();
        _requireAgentIdentity(AgentRole.Executive);
        ExecutionRequest storage r = _requests[index];
        if (r.kind != uint8(ExecutionKind.Strategy)) {
            revert NaveErrors.DirectExecutionKindNotAllowed();
        }
        if (
            r.status != uint8(ExecutionStatus.InReview)
                && r.status != uint8(ExecutionStatus.OversightApproved)
        ) {
            revert NaveErrors.InvalidStateTransition();
        }
        if (r.status == uint8(ExecutionStatus.InReview) && block.timestamp < r.reviewEnd) {
            revert NaveErrors.ReviewWindowActive();
        }
        _runExecution(index, minOut);
        emit DirectStrategyExecuted(index, r.amount);
    }

    /// Unwind `amount` base units from a previously executed Strategy request.
    /// Executive-gated; capped by the revised NE-8 realized-yield bound. `minOut`
    /// is the caller-supplied minimum underlying to receive from the adapter exit.
    function withdrawFromStrategy(uint64 index, uint256 amount, uint256 minOut)
        external
        notPaused
        nonReentrant
    {
        _validateAgentSigner(AgentRole.Executive);
        ExecutionRequest storage r = _requests[index];
        if (r.status != uint8(ExecutionStatus.Executed)) {
            revert NaveErrors.InvalidStateTransition();
        }
        if (r.kind != uint8(ExecutionKind.Strategy)) revert NaveErrors.InvalidStateTransition();
        if (amount == 0) revert NaveErrors.MathOverflow();
        if (minOut == 0) revert NaveErrors.SlippageBoundRequired();

        (, uint256 posPrincipal, uint256 posValue) = treasuryContract.position(r.adapter);
        uint256 cap = FeeMath.realizedYieldWithdrawCap(r.amount, posPrincipal, posValue);
        uint256 newWithdrawn = r.withdrawnAmount + amount;
        if (newWithdrawn > cap) revert NaveErrors.WithdrawExceedsDeployed();

        // Adapter redeems and returns the underlying directly to the treasury.
        uint256 underlyingOut =
            IStrategyAdapter(r.adapter).withdraw(r.asset, amount, address(treasuryContract), minOut);
        // EVM-H2: a lossy exit (Balancer/Curve slippage) may return less than
        // requested. Beyond the tolerance the state is too far from the quote —
        // revert so the caller re-quotes with a realistic amount/minOut instead
        // of silently desyncing NAV/deployedCapital.
        if (
            underlyingOut < amount
                && (amount - underlyingOut) * NaveConstants.BPS_DENOMINATOR
                    > amount * NaveConstants.WITHDRAW_SHORTFALL_TOLERANCE_BPS
        ) {
            revert NaveErrors.WithdrawShortfallExceeded();
        }
        // EVM-H2: all bookkeeping uses the underlying ACTUALLY received, not the
        // requested amount, so treasury NAV/deployedCapital/fee math match the
        // real funds that arrived.
        uint256 amountUsd = treasuryContract.valueAssetUsd(r.asset, underlyingOut);
        treasuryContract.recordStrategyWithdrawal(r.adapter, r.asset, underlyingOut, amountUsd);

        // The cap counter still books the REQUESTED amount (>= actual out):
        // conservative — a lossy exit can never stretch the remaining headroom.
        r.withdrawnAmount = newWithdrawn;
        r.updatedAt = block.timestamp;
        emit StrategyWithdrawn(index, underlyingOut);
    }

    /// Start a queued exit (Maple redemption queue, Ethena cooldown) for
    /// `amount` base units of an executed Strategy request. Same Executive gate
    /// and realized-yield cap as {withdrawFromStrategy}, which pays the claim
    /// out once the adapter reports it ready. Moves no funds into the treasury,
    /// so `deployedCapital` still counts the queued amount as illiquid.
    function requestStrategyExit(uint64 index, uint256 amount)
        external
        notPaused
        nonReentrant
        returns (uint256 readyAt)
    {
        _validateAgentSigner(AgentRole.Executive);
        ExecutionRequest storage r = _requests[index];
        if (r.status != uint8(ExecutionStatus.Executed)) {
            revert NaveErrors.InvalidStateTransition();
        }
        if (r.kind != uint8(ExecutionKind.Strategy)) revert NaveErrors.InvalidStateTransition();
        if (amount == 0) revert NaveErrors.MathOverflow();
        (, uint256 posPrincipal, uint256 posValue) = treasuryContract.position(r.adapter);
        uint256 cap = FeeMath.realizedYieldWithdrawCap(r.amount, posPrincipal, posValue);
        if (r.withdrawnAmount + amount > cap) revert NaveErrors.WithdrawExceedsDeployed();
        readyAt = IQueuedExitAdapter(r.adapter).requestExit(r.asset, amount);
        r.updatedAt = block.timestamp;
        emit StrategyExitRequested(index, amount, readyAt);
    }

    /// Mark a strategy position from the adapter's own accounting. Adapters
    /// scope `positionValue` to `msg.sender`, so this contract is the only
    /// caller that reads this DAO's position. Founder or Oversight agent (`AgentRole.Operational`);
    /// the treasury caps upward drift per day. Accounting only (moves no
    /// funds), so it stays available while the DAO is frozen or agents are off.
    function syncPositionValue(address adapter) external notPaused returns (uint256 applied) {
        if (msg.sender != treasuryContract.founder()) _requireAgentIdentity(AgentRole.Operational);
        (address asset,,) = _positionValue(adapter);
        if (asset == address(0)) revert NaveErrors.ProtocolNotApproved();
        uint256 observed = IStrategyAdapter(adapter).positionValue(asset);
        applied = treasuryContract.syncPositionValue(adapter, observed);
        emit PositionSynced(adapter, observed, applied);
    }

    // ── Internal ──────────────────────────────────────────────────────────
    function _runExecution(uint64 index, uint256 minOut) internal {
        ExecutionRequest storage r = _requests[index];
        if (r.txPayloadHash == bytes32(0)) revert NaveErrors.PayloadHashMismatch();

        if (r.kind == uint8(ExecutionKind.Transfer)) {
            treasuryContract.executeTransfer(r.asset, r.recipient, r.amount);
            _markExecuted(index, r);
            emit TransferExecuted(index, r.recipient, r.amount);
            return;
        }

        if (r.kind == uint8(ExecutionKind.Bridge)) {
            _prepareStrategyDeposit(r.adapter, r.asset, r.amount);
            treasuryContract.transferForStrategy(r.asset, r.adapter, r.amount);
            bytes32 correlationId =
                IBridgeAdapter(r.adapter).bridgeOut(r.asset, r.amount, r.destChainId, r.recipient);
            // Idle already reduced by transferForStrategy; funds leave via the
            // bridge (no same-chain strategy position to unwind on source).
            _markExecuted(index, r);
            emit BridgeExecuted(index, r.adapter, r.recipient, r.destChainId, correlationId);
            return;
        }

        // Strategy path: enforce USD caps against a fresh NAV, then deploy.
        if (minOut == 0) revert NaveErrors.SlippageBoundRequired();
        _prepareStrategyDeposit(r.adapter, r.asset, r.amount);
        uint256 valueBefore = IStrategyAdapter(r.adapter).positionValue(r.asset);
        treasuryContract.transferForStrategy(r.asset, r.adapter, r.amount);
        IStrategyAdapter(r.adapter).deposit(r.asset, r.amount, minOut);
        uint256 valueAfter = IStrategyAdapter(r.adapter).positionValue(r.asset);
        if (
            valueAfter < valueBefore
                || (valueAfter - valueBefore) * NaveConstants.BPS_DENOMINATOR
                    < r.amount * (NaveConstants.BPS_DENOMINATOR - NaveConstants.DEPOSIT_SLIPPAGE_BPS)
        ) {
            revert NaveErrors.DepositSlippageExceeded();
        }
        uint256 amountUsd = treasuryContract.valueAssetUsd(r.asset, r.amount);
        treasuryContract.recordStrategyDeposit(r.adapter, r.asset, r.amount, amountUsd);
        _markExecuted(index, r);
    }

    function _prepareStrategyDeposit(address adapter, address asset, uint256 amount) internal view {
        (bool registered, bool enabled, bool isStablecoin,,,) = treasuryContract.assetInfo(asset);
        if (!registered) revert NaveErrors.AssetNotRegistered();
        if (!enabled) revert NaveErrors.AssetDisabled();

        // NAV staleness hard-block (parity with `StaleNav`).
        uint256 revaluedAt = treasuryContract.lastRevaluedAt();
        if (
            revaluedAt == 0
                || block.timestamp - revaluedAt
                    > uint256(int256(NaveConstants.NAV_MAX_STALENESS_SECS))
        ) {
            revert NaveErrors.StaleNav();
        }

        uint256 nav = treasuryContract.currentNav();

        // NAV threshold gate: mirrors Solana nave_execution constitution check.
        // Agents may not deploy capital until treasury NAV reaches the floor set
        // in updateConstitution. Zero threshold disables the gate (default).
        uint256 agentThreshold = treasuryContract.agentThresholdUsd();
        if (agentThreshold > 0 && nav < agentThreshold) revert NaveErrors.AgentThresholdNotMet();

        uint256 amountUsd = treasuryContract.valueAssetUsd(asset, amount);
        (, uint256 posValueBase,) = _positionValue(adapter);
        uint256 alreadyDeployedUsd = treasuryContract.valueAssetUsd(asset, posValueBase);

        if (!treasuryContract.isAdapterApproved(adapter)) revert NaveErrors.ProtocolNotApproved();
        // Protocol-level revocation takes effect at execution time, even for
        // constitutions written before the revoke.
        if (!protocolContract.isApprovedAdapter(adapter)) {
            revert NaveErrors.AdapterNotProtocolApproved();
        }
        BpsGates.enforceAllocationCap(nav, _tierBoundedCap(adapter), alreadyDeployedUsd, amountUsd);
        (uint16 reserveBps, uint16 maxDeployedBps, uint16 minLiqBps) = treasuryContract.policyBps();
        BpsGates.enforceGlobalLimits(
            nav, treasuryContract.deployedCapital(), amountUsd, maxDeployedBps, minLiqBps
        );

        // Per-asset stablecoin reserve floor on the idle remainder.
        uint256 idle = treasuryContract.idleBalance(asset);
        if (idle < amount) revert NaveErrors.InsufficientVaultBalance();
        uint256 idleAfterUsd = treasuryContract.valueAssetUsd(asset, idle - amount);
        BpsGates.enforceStablecoinReserve(nav, reserveBps, isStablecoin, idleAfterUsd);
    }

    /// The constitution cap, never above the venue tier's ceiling: a venue the
    /// protocol reclassified upward after the constitution was written cannot
    /// keep its older, looser cap.
    function _tierBoundedCap(address adapter) internal view returns (uint16 cap) {
        cap = treasuryContract.adapterMaxAllocationBps(adapter);
        uint8 tier = protocolContract.riskTierOf(adapter);
        uint256 ceiling = tier == 3
            ? NaveConstants.MAX_TIER3_TOTAL_BPS
            : tier == 2 ? NaveConstants.MAX_TIER2_TOTAL_BPS : 10_000;
        if (cap > ceiling) cap = uint16(ceiling);
    }

    function _positionValue(address adapter)
        internal
        view
        returns (address asset, uint256 value, uint256 deposited)
    {
        (asset, deposited, value) = treasuryContract.position(adapter);
    }

    function _markExecuted(uint64 index, ExecutionRequest storage r) internal {
        r.status = uint8(ExecutionStatus.Executed);
        r.executedAt = block.timestamp;
        r.updatedAt = block.timestamp;
        governorContract.markExecuted(index);
    }

    function _createRequest(
        uint64 proposalIndex,
        ExecutionKind kind,
        address adapter,
        address asset,
        address recipient,
        uint256 amount,
        bytes32 payloadHash,
        bool bootstrap
    ) internal {
        ExecutionRequest storage r = _requests[proposalIndex];
        if (r.exists) revert NaveErrors.ExecutionRequestExists();
        r.exists = true;
        r.kind = uint8(kind);
        r.status = uint8(ExecutionStatus.Pending);
        r.bootstrap = bootstrap;
        r.proposalIndex = proposalIndex;
        r.adapter = adapter;
        r.asset = asset;
        r.recipient = recipient;
        r.amount = amount;
        r.txPayloadHash = payloadHash;
        // Bootstrap requests snapshot a zero review window (immediate execution);
        // all others snapshot the DAO's configured window.
        r.reviewWindow = bootstrap ? int64(0) : treasuryContract.reviewWindowSecs();
        r.createdAt = block.timestamp;
        r.updatedAt = block.timestamp;
    }

    function _requireProposalPassed(uint64 index, ProposalType expectedType) internal view {
        (uint8 proposalType, uint8 status, bytes32 payloadHash, uint256 finalizedAt,) =
            governorContract.proposalCore(index);
        if (status != uint8(ProposalStatus.Passed)) revert NaveErrors.ProposalNotPassed();
        if (finalizedAt == 0) revert NaveErrors.ProposalNotPassed();
        if (proposalType != uint8(expectedType)) revert NaveErrors.InvalidProposalType();
        if (payloadHash == bytes32(0)) revert NaveErrors.PayloadHashMismatch();
    }

    function _validateAgentSigner(AgentRole role) internal view {
        if (protocolContract.paused()) revert NaveErrors.GlobalPaused();
        if (treasuryContract.frozen()) revert NaveErrors.DaoFrozen();
        if (!treasuryContract.agentsEnabled()) revert NaveErrors.AgentsDisabled();
        (address authority, bool operational) = treasuryContract.agent(role);
        if (!operational) revert NaveErrors.Unauthorized();
        if (msg.sender != authority) revert NaveErrors.Unauthorized();
    }

    /// `msg.sender` is the operational authority for `role`, ignoring the
    /// frozen / agents-disabled gates (break-glass and accounting paths).
    function _requireAgentIdentity(AgentRole role) internal view {
        if (protocolContract.paused()) revert NaveErrors.GlobalPaused();
        (address authority, bool operational) = treasuryContract.agent(role);
        if (!operational) revert NaveErrors.Unauthorized();
        if (msg.sender != authority) revert NaveErrors.Unauthorized();
    }

    function _transition(uint64 index, ExecutionStatus expected, ExecutionStatus next) internal {
        ExecutionRequest storage r = _requests[index];
        if (!r.exists) revert NaveErrors.InvalidStateTransition();
        if (r.status != uint8(expected)) revert NaveErrors.InvalidStateTransition();
        r.status = uint8(next);
        r.updatedAt = block.timestamp;
    }

    uint256[45] private __gap;
}
