// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {NaveBase} from "./NaveBase.t.sol";
import {NaveTreasury} from "../src/NaveTreasury.sol";
import {NaveGovernor} from "../src/NaveGovernor.sol";
import {NaveExecution} from "../src/NaveExecution.sol";
import {MockStrategyAdapter} from "./mocks/MockStrategyAdapter.sol";
import {LossyStrategyAdapter} from "./mocks/LossyStrategyAdapter.sol";
import {MockERC721} from "./mocks/MockERC721.sol";
import {MockBridgeAdapter} from "./mocks/MockBridgeAdapter.sol";
import {NaveConstants} from "../src/libraries/NaveConstants.sol";
import {NaveErrors} from "../src/libraries/NaveErrors.sol";
import {PayloadHash} from "../src/libraries/PayloadHash.sol";
import {
    AgentRole,
    ProposalType,
    ProposalStatus,
    VoteChoice,
    ExecutionStatus,
    GuardianActionType
} from "../src/libraries/NaveEnums.sol";

contract ExecutionTest is NaveBase {
    NaveTreasury internal t;
    NaveGovernor internal g;
    NaveExecution internal e;
    MockStrategyAdapter internal adapter;

    bytes32 internal constant RH = keccak256("reasoning");
    uint256 internal constant FUND = 1000e6;
    uint256 internal constant DEPLOY = 100e6;

    function setUp() public override {
        super.setUp();
        (t, g, e) = _createDao(0); // wallet governance
        adapter = new MockStrategyAdapter(address(protocol));

        // register + fund stablecoin treasury
        vm.prank(founder);
        t.registerAsset(address(usdc), bytes32(0), true, 0);
        address user = makeAddr("depositor");
        usdc.mint(user, FUND);
        vm.startPrank(user);
        usdc.approve(address(t), FUND);
        t.deposit(address(usdc), FUND);
        vm.stopPrank();

        // approve adapter on the protocol allowlist + in the constitution
        _approveAdapterInConstitution(t, address(adapter));

        // enable agents
        vm.prank(exec);
        t.toggleAgents(true);
    }

    function _passStrategyProposal(uint256 amount) internal returns (uint64 idx) {
        bytes memory payload = abi.encode(address(adapter), amount, address(usdc));
        vm.prank(g1);
        idx = g.createProposal(
            NaveGovernor.CreateProposalParams({
                title: "deploy",
                description: "",
                payload: payload,
                proposalType: uint8(ProposalType.Strategy),
                votingPeriodSeconds: 1 days,
                votingMint: address(0)
            })
        );
        vm.prank(g1);
        g.castVoteWallet(idx, uint8(VoteChoice.For));
        vm.prank(g2);
        g.castVoteWallet(idx, uint8(VoteChoice.For));
        g.finalizeProposal(idx);
    }

    function _approveToInReview(uint64 idx) internal {
        bytes32 ph = PayloadHash.strategyHash(address(adapter), DEPLOY, address(usdc));
        vm.prank(exec);
        e.executiveApprove(idx, RH);
        vm.prank(fin);
        e.financialApprove(idx, ph, RH);
        vm.prank(over);
        e.oversightApprove(idx, ph, RH);
    }

    // ── Happy path ────────────────────────────────────────────────────────
    function test_fullPipeline_deploys() public {
        uint64 idx = _passStrategyProposal(DEPLOY);
        e.createStrategyRequest(idx, DEPLOY, address(adapter), address(usdc));
        _approveToInReview(idx);

        vm.warp(block.timestamp + 1 days + 1);
        _revalueTreasury(t);
        vm.prank(exec);
        e.execute(idx, 1);

        assertEq(uint8(e.requestStatus(idx)), uint8(ExecutionStatus.Executed));
        assertEq(usdc.balanceOf(address(t)), FUND - DEPLOY);
        assertEq(usdc.balanceOf(address(adapter)), DEPLOY);
        (, uint256 dep, uint256 cur) = t.position(address(adapter));
        assertEq(dep, DEPLOY);
        assertEq(cur, DEPLOY);
    }

    // ── Payload-hash binding ──────────────────────────────────────────────
    function test_createRequest_wrongAmountReverts() public {
        uint64 idx = _passStrategyProposal(DEPLOY);
        vm.expectRevert(NaveErrors.PayloadHashMismatch.selector);
        e.createStrategyRequest(idx, DEPLOY + 1, address(adapter), address(usdc));
    }

    function test_financialApprove_payloadBinding() public {
        uint64 idx = _passStrategyProposal(DEPLOY);
        e.createStrategyRequest(idx, DEPLOY, address(adapter), address(usdc));
        vm.prank(exec);
        e.executiveApprove(idx, RH);
        vm.prank(fin);
        vm.expectRevert(NaveErrors.PayloadHashMismatch.selector);
        e.financialApprove(idx, keccak256("wrong"), RH);
    }

    function test_executiveApprove_wrongAgentReverts() public {
        uint64 idx = _passStrategyProposal(DEPLOY);
        e.createStrategyRequest(idx, DEPLOY, address(adapter), address(usdc));
        vm.prank(fin); // not executive
        vm.expectRevert(NaveErrors.Unauthorized.selector);
        e.executiveApprove(idx, RH);
    }

    // ── Bootstrap: one-time founder zero-review-window first action ────────
    event BootstrapExecutionRequest(uint64 indexed index, uint8 kind, address founder);

    function test_bootstrap_firstStrategyExecutesImmediately() public {
        uint64 idx = _passStrategyProposal(DEPLOY);

        vm.expectEmit(true, false, false, true, address(e));
        emit BootstrapExecutionRequest(idx, uint8(0), founder); // ExecutionKind.Strategy == 0
        vm.prank(founder);
        e.createStrategyRequestBootstrap(idx, DEPLOY, address(adapter), address(usdc));
        assertTrue(e.bootstrapUsed(), "bootstrap flag consumed");

        _approveToInReview(idx);
        // No time warp: the bootstrap request snapshots a review window of 0, so
        // it is immediately executable.
        _revalueTreasury(t);
        vm.prank(exec);
        e.execute(idx, 1);
        assertEq(uint8(e.requestStatus(idx)), uint8(ExecutionStatus.Executed), "executed now");
        assertEq(usdc.balanceOf(address(adapter)), DEPLOY, "deployed immediately");
    }

    function test_bootstrap_onlyFounder() public {
        uint64 idx = _passStrategyProposal(DEPLOY);
        // Caller is the test contract, not the founder.
        vm.expectRevert(NaveErrors.Unauthorized.selector);
        e.createStrategyRequestBootstrap(idx, DEPLOY, address(adapter), address(usdc));
        assertFalse(e.bootstrapUsed(), "flag untouched on failed attempt");
    }

    function test_bootstrap_onlyOnce() public {
        uint64 idx1 = _passStrategyProposal(DEPLOY);
        vm.prank(founder);
        e.createStrategyRequestBootstrap(idx1, DEPLOY, address(adapter), address(usdc));

        uint64 idx2 = _passStrategyProposal(DEPLOY + 1);
        vm.prank(founder);
        vm.expectRevert(NaveErrors.BootstrapAlreadyUsed.selector);
        e.createStrategyRequestBootstrap(idx2, DEPLOY + 1, address(adapter), address(usdc));
    }

    function test_bootstrap_secondRequestStillHonorsReviewWindow() public {
        // Consume the bootstrap on the first request.
        uint64 idx1 = _passStrategyProposal(DEPLOY);
        vm.prank(founder);
        e.createStrategyRequestBootstrap(idx1, DEPLOY, address(adapter), address(usdc));

        // A normal (non-bootstrap) request must still wait out the window.
        uint64 idx2 = _passStrategyProposal(DEPLOY + 1);
        e.createStrategyRequest(idx2, DEPLOY + 1, address(adapter), address(usdc));
        bytes32 ph = PayloadHash.strategyHash(address(adapter), DEPLOY + 1, address(usdc));
        vm.prank(exec);
        e.executiveApprove(idx2, RH);
        vm.prank(fin);
        e.financialApprove(idx2, ph, RH);
        vm.prank(over);
        e.oversightApprove(idx2, ph, RH);
        _revalueTreasury(t);
        vm.prank(exec);
        vm.expectRevert(NaveErrors.ReviewWindowActive.selector);
        e.execute(idx2, 1);
    }

    function test_bootstrap_transferPathRemoved() public {
        (bool ok,) = address(e).call(
            abi.encodeWithSignature(
                "createTransferRequestBootstrap(uint64,address,address,uint256)",
                uint64(0),
                address(usdc),
                address(1),
                uint256(1)
            )
        );
        assertFalse(ok, "transfers never get a zero review window");
    }

    // ── Review window ─────────────────────────────────────────────────────
    function test_execute_beforeReviewWindowReverts() public {
        uint64 idx = _passStrategyProposal(DEPLOY);
        e.createStrategyRequest(idx, DEPLOY, address(adapter), address(usdc));
        _approveToInReview(idx);
        _revalueTreasury(t);
        vm.prank(exec);
        vm.expectRevert(NaveErrors.ReviewWindowActive.selector);
        e.execute(idx, 1);
    }

    // ── EVM-C2: execute() is Executive-only ──────────────────────────────
    /// A fully-approved, review-window-cleared request can only be triggered
    /// by the Executive — not a third party who would dictate `minOut`, and not
    /// the Financial / Operational / Oversight agents (role boundary).
    function test_execute_onlyExecutive() public {
        uint64 idx = _passStrategyProposal(DEPLOY);
        e.createStrategyRequest(idx, DEPLOY, address(adapter), address(usdc));
        _approveToInReview(idx);
        vm.warp(block.timestamp + 1 days + 1);
        _revalueTreasury(t);

        address rando = makeAddr("randoThirdParty");
        vm.prank(rando);
        vm.expectRevert(NaveErrors.Unauthorized.selector);
        e.execute(idx, 1);

        address[3] memory others = [fin, over, oper];
        for (uint256 i; i < others.length; i++) {
            vm.prank(others[i]);
            vm.expectRevert(NaveErrors.Unauthorized.selector);
            e.execute(idx, 1);
        }

        vm.prank(exec);
        e.execute(idx, 1);
        assertEq(uint8(e.requestStatus(idx)), uint8(ExecutionStatus.Executed));
    }

    // ── Halt / clear / expire ─────────────────────────────────────────────
    function test_operationalHaltAndClear() public {
        uint64 idx = _passStrategyProposal(DEPLOY);
        e.createStrategyRequest(idx, DEPLOY, address(adapter), address(usdc));
        _approveToInReview(idx);
        vm.prank(oper);
        e.operationalHalt(idx, RH);
        assertEq(uint8(e.requestStatus(idx)), uint8(ExecutionStatus.Halted));
        vm.prank(oper);
        vm.expectRevert(NaveErrors.ReasoningHashRequired.selector);
        e.operationalClear(idx, bytes32(0));
        vm.prank(oper);
        e.operationalClear(idx, RH);
        assertEq(uint8(e.requestStatus(idx)), uint8(ExecutionStatus.InReview));
    }

    function test_expireRequest_afterWindow() public {
        uint64 idx = _passStrategyProposal(DEPLOY);
        e.createStrategyRequest(idx, DEPLOY, address(adapter), address(usdc));
        _approveToInReview(idx);
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(oper);
        e.expireRequest(idx);
        assertEq(uint8(e.requestStatus(idx)), uint8(ExecutionStatus.Expired));
    }

    // ── Break-glass direct execution (frozen DAO) ─────────────────────────
    function test_executeDirect_whenFrozen() public {
        uint64 idx = _passStrategyProposal(DEPLOY);
        e.createStrategyRequest(idx, DEPLOY, address(adapter), address(usdc));
        _approveToInReview(idx);
        vm.warp(block.timestamp + 1 days + 1);
        _revalueTreasury(t);

        // Freeze via guardians.
        uint64 d = _deadline();
        bytes[] memory sigs = _guardianSigs(t, GuardianActionType.FREEZE, 0, 0, address(0), 1, d);
        t.guardianAction(_gp(GuardianActionType.FREEZE, 0, 0, address(0), 1, d), sigs);

        // Normal execute now blocked; break-glass Executive path works.
        vm.expectRevert(NaveErrors.DaoFrozen.selector);
        e.execute(idx, 1);
        vm.prank(exec);
        e.executeDirect(idx, 1);
        assertEq(uint8(e.requestStatus(idx)), uint8(ExecutionStatus.Executed));
    }

    /// SOL-H2 / EVM parity: Executive cannot break-glass a still-Pending request
    /// even after the DAO is frozen. Requires InReview or OversightApproved.
    function test_executeDirect_rejectsPendingWhenFrozen() public {
        uint64 idx = _passStrategyProposal(DEPLOY);
        e.createStrategyRequest(idx, DEPLOY, address(adapter), address(usdc));
        // Leave at Pending — no agent approvals.

        uint64 d = _deadline();
        bytes[] memory sigs = _guardianSigs(t, GuardianActionType.FREEZE, 0, 0, address(0), 2, d);
        t.guardianAction(_gp(GuardianActionType.FREEZE, 0, 0, address(0), 2, d), sigs);

        _revalueTreasury(t);
        vm.prank(exec);
        vm.expectRevert(NaveErrors.InvalidStateTransition.selector);
        e.executeDirect(idx, 1);
        assertEq(uint8(e.requestStatus(idx)), uint8(ExecutionStatus.Pending));
    }

    function test_executeDirect_rejectsExecutiveApprovedWhenFrozen() public {
        uint64 idx = _passStrategyProposal(DEPLOY);
        e.createStrategyRequest(idx, DEPLOY, address(adapter), address(usdc));
        vm.prank(exec);
        e.executiveApprove(idx, RH);

        uint64 d = _deadline();
        bytes[] memory sigs = _guardianSigs(t, GuardianActionType.FREEZE, 0, 0, address(0), 3, d);
        t.guardianAction(_gp(GuardianActionType.FREEZE, 0, 0, address(0), 3, d), sigs);

        _revalueTreasury(t);
        vm.prank(exec);
        vm.expectRevert(NaveErrors.InvalidStateTransition.selector);
        e.executeDirect(idx, 1);
        assertEq(uint8(e.requestStatus(idx)), uint8(ExecutionStatus.ExecutiveApproved));
    }

    // ── Hardening: executeDirect is not a review-window bypass ────────────
    function test_executeDirect_inReviewBeforeReviewEndReverts() public {
        uint64 idx = _passStrategyProposal(DEPLOY);
        e.createStrategyRequest(idx, DEPLOY, address(adapter), address(usdc));
        _approveToInReview(idx);
        assertEq(uint8(e.requestStatus(idx)), uint8(ExecutionStatus.InReview));

        uint64 d = _deadline();
        bytes[] memory sigs = _guardianSigs(t, GuardianActionType.FREEZE, 0, 0, address(0), 1, d);
        t.guardianAction(_gp(GuardianActionType.FREEZE, 0, 0, address(0), 1, d), sigs);
        _revalueTreasury(t);

        // Still inside the review window → refused, request untouched.
        vm.prank(exec);
        vm.expectRevert(NaveErrors.ReviewWindowActive.selector);
        e.executeDirect(idx, 1);
        assertEq(uint8(e.requestStatus(idx)), uint8(ExecutionStatus.InReview));
        assertEq(usdc.balanceOf(address(adapter)), 0);

        // One second before the end still refused; at/after the end allowed.
        uint256 reviewEnd = e.getRequest(idx).reviewEnd;
        vm.warp(reviewEnd - 1);
        vm.prank(exec);
        vm.expectRevert(NaveErrors.ReviewWindowActive.selector);
        e.executeDirect(idx, 1);
        vm.warp(reviewEnd);
        _revalueTreasury(t);
        vm.prank(exec);
        e.executeDirect(idx, 1);
        assertEq(uint8(e.requestStatus(idx)), uint8(ExecutionStatus.Executed));
    }

    // ── Hardening: executeDirect is Strategy-only ─────────────────────────
    function test_executeDirect_transferKindReverts() public {
        address to = makeAddr("grantRecipient");
        uint256 amount = 50e6;
        uint64 idx = _passTransferProposal(to, amount);
        e.createTransferRequest(idx, address(usdc), to, amount);
        bytes32 ph = PayloadHash.transferHash(address(usdc), to, amount);
        vm.prank(exec);
        e.executiveApprove(idx, RH);
        vm.prank(fin);
        e.financialApprove(idx, ph, RH);
        vm.prank(over);
        e.oversightApprove(idx, ph, RH);
        vm.warp(block.timestamp + 1 days + 1);

        uint64 d = _deadline();
        bytes[] memory sigs = _guardianSigs(t, GuardianActionType.FREEZE, 0, 0, address(0), 1, d);
        t.guardianAction(_gp(GuardianActionType.FREEZE, 0, 0, address(0), 1, d), sigs);

        vm.prank(exec);
        vm.expectRevert(NaveErrors.DirectExecutionKindNotAllowed.selector);
        e.executeDirect(idx, 1);
        assertEq(usdc.balanceOf(to), 0, "no funds left the treasury");
        assertEq(uint8(e.requestStatus(idx)), uint8(ExecutionStatus.InReview));
    }

    function test_executeDirect_bridgeKindReverts() public {
        MockBridgeAdapter bridge = new MockBridgeAdapter();
        _approveAdapterInConstitution(t, address(bridge));
        uint256 destChain = 8453;
        address destTreasury = makeAddr("remoteTreasury");
        vm.prank(owner);
        protocol.setRemoteTreasury(destChain, destTreasury, true);
        vm.prank(founder);
        t.setLinkedTreasury(destChain, destTreasury);

        uint256 amount = 40e6;
        bytes memory payload =
            abi.encode(address(bridge), amount, address(usdc), destChain, destTreasury);
        vm.prank(g1);
        uint64 idx = g.createProposal(
            NaveGovernor.CreateProposalParams({
                title: "bridge",
                description: "",
                payload: payload,
                proposalType: uint8(ProposalType.Strategy),
                votingPeriodSeconds: 1 days,
                votingMint: address(0)
            })
        );
        vm.prank(g1);
        g.castVoteWallet(idx, uint8(VoteChoice.For));
        vm.prank(g2);
        g.castVoteWallet(idx, uint8(VoteChoice.For));
        g.finalizeProposal(idx);

        e.createBridgeRequest(idx, amount, address(bridge), address(usdc), destChain, destTreasury);
        bytes32 ph =
            PayloadHash.bridgeHash(address(bridge), amount, address(usdc), destChain, destTreasury);
        vm.prank(exec);
        e.executiveApprove(idx, RH);
        vm.prank(fin);
        e.financialApprove(idx, ph, RH);
        vm.prank(over);
        e.oversightApprove(idx, ph, RH);
        vm.warp(block.timestamp + 1 days + 1);

        uint64 d = _deadline();
        bytes[] memory sigs = _guardianSigs(t, GuardianActionType.FREEZE, 0, 0, address(0), 1, d);
        t.guardianAction(_gp(GuardianActionType.FREEZE, 0, 0, address(0), 1, d), sigs);

        vm.prank(exec);
        vm.expectRevert(NaveErrors.DirectExecutionKindNotAllowed.selector);
        e.executeDirect(idx, 1);
        assertEq(bridge.bridgedOut(), 0, "nothing bridged out");
        assertEq(usdc.balanceOf(address(t)), FUND);
    }

    /// Agents can only be disabled through the guardian M-of-N path; that is
    /// the (non-frozen) condition that unlocks `executeDirect`. Confirms the
    /// combination end-to-end: single guardian cannot unlock it, quorum can.
    function test_executeDirect_unlockedOnlyByGuardianQuorumDisable() public {
        uint64 idx = _passStrategyProposal(DEPLOY);
        e.createStrategyRequest(idx, DEPLOY, address(adapter), address(usdc));
        _approveToInReview(idx);
        vm.warp(block.timestamp + 1 days + 1);
        _revalueTreasury(t);

        // Agents enabled + not frozen → direct path closed.
        vm.prank(exec);
        vm.expectRevert(NaveErrors.DirectExecutionNotAllowed.selector);
        e.executeDirect(idx, 1);

        // A single guardian (or the founder) cannot disable agents.
        vm.prank(g1);
        vm.expectRevert(NaveErrors.AgentsDisableRequiresGuardians.selector);
        t.toggleAgents(false);
        vm.prank(founder);
        vm.expectRevert(NaveErrors.AgentsDisableRequiresGuardians.selector);
        t.toggleAgents(false);
        assertTrue(t.agentsEnabled());

        // Guardian quorum disables agents → direct path opens for Strategy.
        uint64 d = _deadline();
        bytes[] memory sigs =
            _guardianSigs(t, GuardianActionType.DISABLE_AGENTS, 0, 0, address(0), 1, d);
        t.guardianAction(_gp(GuardianActionType.DISABLE_AGENTS, 0, 0, address(0), 1, d), sigs);
        assertFalse(t.agentsEnabled());
        vm.prank(exec);
        e.executeDirect(idx, 1);
        assertEq(uint8(e.requestStatus(idx)), uint8(ExecutionStatus.Executed));
    }

    // ── Hardening: queued review-window reduction cannot rush a request ───
    /// A founder who queues a shorter window cannot immediately push a request
    /// through it: requests created before the delay elapses are stamped with
    /// the still-effective long window; only later requests get the short one.
    function test_reviewWindowReduction_notUsableUntilDelayElapses() public {
        _useProductionDelays(t);
        int64 longWin = t.reviewWindowSecs(); // 24h default
        int64 shortWin = 3600;
        vm.prank(founder);
        t.setReviewWindow(shortWin);
        (, uint256 effectiveAt) = t.pendingReviewWindow();

        // Request created while the reduction is queued → long window.
        uint64 idx1 = _passStrategyProposal(DEPLOY);
        e.createStrategyRequest(idx1, DEPLOY, address(adapter), address(usdc));
        _approveToInReview(idx1);
        NaveExecution.ExecutionRequest memory r1 = e.getRequest(idx1);
        assertEq(r1.reviewWindow, longWin, "stamped with the effective long window");
        assertEq(r1.reviewEnd, block.timestamp + uint256(int256(longWin)));
        vm.warp(block.timestamp + uint256(int256(shortWin)) + 1);
        _revalueTreasury(t);
        vm.prank(exec);
        vm.expectRevert(NaveErrors.ReviewWindowActive.selector);
        e.execute(idx1, 1);

        // After the delay the short window is live for NEW requests only.
        vm.warp(effectiveAt);
        assertEq(t.reviewWindowSecs(), shortWin);
        uint64 idx2 = _passStrategyProposal(DEPLOY);
        e.createStrategyRequest(idx2, DEPLOY, address(adapter), address(usdc));
        assertEq(e.getRequest(idx2).reviewWindow, shortWin);
        assertEq(e.getRequest(idx1).reviewWindow, longWin, "existing request unchanged");
    }

    // ── Capital accounting: strategy round-trip ───────────────────────────
    /// After deploy → withdraw, the tokens physically held by treasury + adapter
    /// must cover the treasury's recorded `deployedCapitalBase` for the asset
    /// (no phantom deployed capital).
    function test_strategyRoundTrip_balancesCoverDeployedCapital() public {
        uint64 idx = _passStrategyProposal(DEPLOY);
        e.createStrategyRequest(idx, DEPLOY, address(adapter), address(usdc));
        _approveToInReview(idx);
        vm.warp(block.timestamp + 1 days + 1);
        _revalueTreasury(t);
        vm.prank(exec);
        e.execute(idx, 1);
        _assertBalancesCoverDeployed();
        assertEq(_deployedBase(), DEPLOY);

        // Partial unwind.
        vm.prank(exec);
        e.withdrawFromStrategy(idx, DEPLOY / 2, 1);
        _assertBalancesCoverDeployed();
        assertEq(_deployedBase(), DEPLOY / 2);

        // Full unwind.
        vm.prank(exec);
        e.withdrawFromStrategy(idx, DEPLOY / 2, 1);
        _assertBalancesCoverDeployed();
        assertEq(_deployedBase(), 0);
        assertEq(usdc.balanceOf(address(t)), FUND);
    }

    /// Base units the treasury records as deployed into `adapter` (the per-asset
    /// `deployedCapitalBase` is the sum of these across adapters; only one
    /// adapter is used here).
    function _deployedBase() internal view returns (uint256 deployedBase) {
        (, deployedBase,) = t.position(address(adapter));
    }

    function _assertBalancesCoverDeployed() internal view {
        uint256 held = usdc.balanceOf(address(t)) + usdc.balanceOf(address(adapter));
        assertGe(held, _deployedBase(), "treasury+adapter >= deployed base");
    }

    function _passTransferProposal(address to, uint256 amount) internal returns (uint64 idx) {
        bytes memory payload = abi.encode(address(usdc), to, amount);
        vm.prank(g1);
        idx = g.createProposal(
            NaveGovernor.CreateProposalParams({
                title: "grant",
                description: "",
                payload: payload,
                proposalType: uint8(ProposalType.Transfer),
                votingPeriodSeconds: 1 days,
                votingMint: address(0)
            })
        );
        vm.prank(g1);
        g.castVoteWallet(idx, uint8(VoteChoice.For));
        vm.prank(g2);
        g.castVoteWallet(idx, uint8(VoteChoice.For));
        g.finalizeProposal(idx);
    }

    // ── Withdraw + 8.5% performance skim ──────────────────────────────────
    function test_withdrawWithYield_skims85pct() public {
        uint64 idx = _passStrategyProposal(DEPLOY);
        e.createStrategyRequest(idx, DEPLOY, address(adapter), address(usdc));
        _approveToInReview(idx);
        vm.warp(block.timestamp + 1 days + 1);
        _revalueTreasury(t);
        vm.prank(exec);
        e.execute(idx, 1);

        // Simulate 10 USDC of yield over 10 days and sync the mark from the
        // adapter (10% fits the 1%/day drift cap after 10 days).
        uint256 gain = 10e6;
        adapter.accrue(address(e), address(usdc), gain);
        vm.warp(block.timestamp + 10 days);
        vm.prank(founder);
        e.syncPositionValue(address(adapter));

        uint256 revBefore = usdc.balanceOf(revenueWallet);
        uint256 treBefore = usdc.balanceOf(address(t));
        vm.prank(exec);
        e.withdrawFromStrategy(idx, DEPLOY + gain, 1);

        // 8.5% of 10 USDC gain = 0.85 USDC to the revenue wallet.
        assertEq(usdc.balanceOf(revenueWallet) - revBefore, 850_000);
        // Treasury receives the unwound principal + gain minus the skim.
        assertEq(usdc.balanceOf(address(t)) - treBefore, DEPLOY + gain - 850_000);
    }

    // ── Position marks are read from the adapter, with a daily drift cap ───
    function _deployDefault() internal returns (uint64 idx) {
        idx = _passStrategyProposal(DEPLOY);
        e.createStrategyRequest(idx, DEPLOY, address(adapter), address(usdc));
        _approveToInReview(idx);
        vm.warp(block.timestamp + 1 days + 1);
        _revalueTreasury(t);
        vm.prank(exec);
        e.execute(idx, 1); // position now marked at DEPLOY (100e6)
    }

    function test_syncPositionValue_capsUpwardDrift() public {
        _deployDefault();
        // The adapter reports +50% (e.g. a manipulated read); one day later only
        // +1% of principal can be booked.
        adapter.accrue(address(e), address(usdc), 50e6);
        vm.warp(block.timestamp + 1 days);
        vm.prank(oper);
        uint256 applied = e.syncPositionValue(address(adapter));
        assertEq(applied, 101e6);
        (,, uint256 cur) = t.position(address(adapter));
        assertEq(cur, 101e6);
    }

    function test_revalue_countsMarkedPositionValue() public {
        uint64 idx = _deployDefault();
        _revalueTreasury(t);
        uint256 navAtPrincipal = t.currentNav();

        adapter.accrue(address(e), address(usdc), 10e6);
        vm.warp(block.timestamp + 10 days);
        vm.prank(oper);
        e.syncPositionValue(address(adapter));
        _revalueTreasury(t);
        // USDC at par: +10 USDC of marked yield = +10e6 micro-USD of NAV.
        assertEq(t.currentNav(), navAtPrincipal + 10e6);

        // Unwinding the position moves value from marked to idle; NAV is unchanged
        // apart from the 8.5% performance skim on the gain.
        vm.prank(exec);
        e.withdrawFromStrategy(idx, DEPLOY + 10e6, 1);
        _revalueTreasury(t);
        assertEq(t.currentNav(), navAtPrincipal + 10e6 - 850_000);
    }

    function test_syncPositionValue_roleBoundary() public {
        _deployDefault();
        address[3] memory denied = [exec, fin, over];
        for (uint256 i; i < denied.length; i++) {
            vm.prank(denied[i]);
            vm.expectRevert(NaveErrors.Unauthorized.selector);
            e.syncPositionValue(address(adapter));
        }
        vm.prank(makeAddr("rando"));
        vm.expectRevert(NaveErrors.Unauthorized.selector);
        e.syncPositionValue(address(adapter));
        // The treasury setter only accepts the execution contract.
        vm.prank(founder);
        vm.expectRevert(NaveErrors.Unauthorized.selector);
        t.syncPositionValue(address(adapter), 1);
        // The old caller-supplied mark is gone.
        vm.prank(founder);
        (bool ok,) = address(t).call(
            abi.encodeWithSignature(
                "updateStrategyPositionValue(address,uint256)", address(adapter), 150e6
            )
        );
        assertFalse(ok);
    }

    function test_execute_depositSlippageFloor() public {
        LossyStrategyAdapter lossy = new LossyStrategyAdapter(address(protocol));
        lossy.setDepositLossBps(100); // 1% > 0.5% floor
        _approveAdapterInConstitution(t, address(lossy));
        bytes memory payload = abi.encode(address(lossy), DEPLOY, address(usdc));
        vm.prank(g1);
        uint64 idx = g.createProposal(
            NaveGovernor.CreateProposalParams({
                title: "slip",
                description: "",
                payload: payload,
                proposalType: uint8(ProposalType.Strategy),
                votingPeriodSeconds: 1 days,
                votingMint: address(0)
            })
        );
        vm.prank(g1);
        g.castVoteWallet(idx, uint8(VoteChoice.For));
        vm.prank(g2);
        g.castVoteWallet(idx, uint8(VoteChoice.For));
        g.finalizeProposal(idx);
        e.createStrategyRequest(idx, DEPLOY, address(lossy), address(usdc));
        bytes32 ph = PayloadHash.strategyHash(address(lossy), DEPLOY, address(usdc));
        vm.prank(exec);
        e.executiveApprove(idx, RH);
        vm.prank(fin);
        e.financialApprove(idx, ph, RH);
        vm.prank(over);
        e.oversightApprove(idx, ph, RH);
        vm.warp(block.timestamp + 1 days + 1);
        _revalueTreasury(t);
        vm.prank(exec);
        vm.expectRevert(NaveErrors.DepositSlippageExceeded.selector);
        e.execute(idx, 1);
    }

    function test_execute_protocolRevocationBlocksDeposit() public {
        uint64 idx = _passStrategyProposal(DEPLOY);
        e.createStrategyRequest(idx, DEPLOY, address(adapter), address(usdc));
        _approveToInReview(idx);
        vm.prank(owner);
        protocol.setAdapterApproved(address(adapter), false);
        vm.warp(block.timestamp + 1 days + 1);
        _revalueTreasury(t);
        vm.prank(exec);
        vm.expectRevert(NaveErrors.AdapterNotProtocolApproved.selector);
        e.execute(idx, 1);
    }

    function test_execute_blockedWhenAgentsDisabled() public {
        uint64 idx = _passStrategyProposal(DEPLOY);
        e.createStrategyRequest(idx, DEPLOY, address(adapter), address(usdc));
        _approveToInReview(idx);
        vm.warp(block.timestamp + 1 days + 1);
        _revalueTreasury(t);
        uint64 d = _deadline();
        bytes[] memory sigs =
            _guardianSigs(t, GuardianActionType.DISABLE_AGENTS, 0, 0, address(0), 90, d);
        t.guardianAction(_gp(GuardianActionType.DISABLE_AGENTS, 0, 0, address(0), 90, d), sigs);
        vm.prank(exec);
        vm.expectRevert(NaveErrors.AgentsDisabled.selector);
        e.execute(idx, 1);
    }

    function test_strategy_zeroMinOutReverts() public {
        uint64 idx = _passStrategyProposal(DEPLOY);
        e.createStrategyRequest(idx, DEPLOY, address(adapter), address(usdc));
        _approveToInReview(idx);
        vm.warp(block.timestamp + 1 days + 1);
        _revalueTreasury(t);
        vm.prank(exec);
        vm.expectRevert(NaveErrors.SlippageBoundRequired.selector);
        e.execute(idx, 0);
        vm.prank(exec);
        e.execute(idx, DEPLOY);
        vm.prank(exec);
        vm.expectRevert(NaveErrors.SlippageBoundRequired.selector);
        e.withdrawFromStrategy(idx, DEPLOY, 0);
    }

    function test_oversightApprove_rejectsZeroPayloadHash() public {
        uint64 idx = _passStrategyProposal(DEPLOY);
        e.createStrategyRequest(idx, DEPLOY, address(adapter), address(usdc));
        bytes32 ph = PayloadHash.strategyHash(address(adapter), DEPLOY, address(usdc));
        vm.prank(exec);
        e.executiveApprove(idx, RH);
        vm.prank(fin);
        e.financialApprove(idx, ph, RH);
        vm.prank(over);
        vm.expectRevert(NaveErrors.PayloadHashMismatch.selector);
        e.oversightApprove(idx, bytes32(0), RH);
    }

    // ── EVM-H2: lossy exits book the ACTUAL underlying returned ────────────
    /// Deploy into a lossy adapter (models Balancer/Curve exit slippage) and
    /// run the full pipeline so the withdrawal accounting can be asserted.
    function _deployIntoLossy(uint16 lossBps) internal returns (LossyStrategyAdapter lossy, uint64 idx) {
        lossy = new LossyStrategyAdapter(address(protocol));
        lossy.setLossBps(lossBps);
        _protocolApproveAdapter(address(lossy));

        // Approve BOTH adapters (updateConstitution replaces the whole list).
        address[] memory adapters = new address[](2);
        adapters[0] = address(adapter);
        adapters[1] = address(lossy);
        uint16[] memory bps = new uint16[](2);
        bps[0] = 10_000;
        bps[1] = 10_000;
        bool[] memory approved = new bool[](2);
        approved[0] = true;
        approved[1] = true;
        string[] memory ids = new string[](2);
        ids[0] = "mock";
        ids[1] = "lossy-mock";
        vm.prank(founder);
        t.updateConstitution(adapters, bps, approved, ids, 70, 0);

        bytes memory payload = abi.encode(address(lossy), DEPLOY, address(usdc));
        vm.prank(g1);
        idx = g.createProposal(
            NaveGovernor.CreateProposalParams({
                title: "lossy-deploy",
                description: "",
                payload: payload,
                proposalType: uint8(ProposalType.Strategy),
                votingPeriodSeconds: 1 days,
                votingMint: address(0)
            })
        );
        vm.prank(g1);
        g.castVoteWallet(idx, uint8(VoteChoice.For));
        vm.prank(g2);
        g.castVoteWallet(idx, uint8(VoteChoice.For));
        g.finalizeProposal(idx);

        e.createStrategyRequest(idx, DEPLOY, address(lossy), address(usdc));
        bytes32 ph = PayloadHash.strategyHash(address(lossy), DEPLOY, address(usdc));
        vm.prank(exec);
        e.executiveApprove(idx, RH);
        vm.prank(fin);
        e.financialApprove(idx, ph, RH);
        vm.prank(over);
        e.oversightApprove(idx, ph, RH);
        vm.warp(block.timestamp + 1 days + 1);
        _revalueTreasury(t);
        vm.prank(exec);
        e.execute(idx, 1);
    }

    /// A within-tolerance lossy exit succeeds and books the underlying that
    /// ACTUALLY arrived — not the requested amount — into the treasury's
    /// deployedCapital/NAV counters (pre-fix the requested amount was booked,
    /// silently desyncing accounting from real balances).
    function test_EVMH2_lossyWithdraw_booksActualUnderlyingOut() public {
        // 0.5% loss: inside the 1% shortfall tolerance.
        (LossyStrategyAdapter lossy, uint64 idx) = _deployIntoLossy(50);

        uint256 requested = 50e6;
        uint256 expectedOut = requested - (requested * 50) / 10_000; // 49.75 USDC
        uint256 treBefore = usdc.balanceOf(address(t));
        uint256 deployedBefore = t.deployedCapital();

        vm.prank(exec);
        e.withdrawFromStrategy(idx, requested, 1);

        // Treasury received exactly the lossy actual-out.
        assertEq(usdc.balanceOf(address(t)) - treBefore, expectedOut, "actual out received");
        // deployedCapital reduced by the USD value of the ACTUAL out (49.75),
        // not the requested 50 — the residue reflects value genuinely lost.
        assertEq(
            deployedBefore - t.deployedCapital(),
            expectedOut, // $1 stable: micro-USD == base units
            "deployedCapital reduced by actual out"
        );
        // The lossy shortfall stayed in the adapter (like pool slippage).
        (,, uint256 posValue) = t.position(address(lossy));
        assertEq(posValue, DEPLOY - expectedOut, "position marked down by actual out");
    }

    /// Beyond the 1% tolerance the withdrawal reverts: the caller must
    /// re-quote instead of accepting an arbitrarily lossy, mispriced exit.
    function test_EVMH2_lossyWithdraw_beyondToleranceReverts() public {
        // 2% loss: outside WITHDRAW_SHORTFALL_TOLERANCE_BPS (1%).
        (, uint64 idx) = _deployIntoLossy(200);

        vm.prank(exec);
        vm.expectRevert(NaveErrors.WithdrawShortfallExceeded.selector);
        e.withdrawFromStrategy(idx, 50e6, 1);
    }

    // ── Transfer proposal (type 8) execution handler ──────────────────────
    function test_transferProposal_executes() public {
        address to = makeAddr("grantRecipient");
        uint256 amount = 50e6;
        bytes memory payload = abi.encode(address(usdc), to, amount);
        vm.prank(g1);
        uint64 idx = g.createProposal(
            NaveGovernor.CreateProposalParams({
                title: "grant",
                description: "",
                payload: payload,
                proposalType: uint8(ProposalType.Transfer),
                votingPeriodSeconds: 1 days,
                votingMint: address(0)
            })
        );
        vm.prank(g1);
        g.castVoteWallet(idx, uint8(VoteChoice.For));
        vm.prank(g2);
        g.castVoteWallet(idx, uint8(VoteChoice.For));
        g.finalizeProposal(idx);

        g.executeTransferProposal(idx, address(usdc), to, amount);

        assertEq(usdc.balanceOf(to), amount);
        (, uint8 st,,,) = g.proposalCore(idx);
        assertEq(st, uint8(ProposalStatus.Executed));
    }

    /// Legacy path: transfer disbursement via the four-agent execution pipeline.
    function test_transferProposal_executes_viaExecutionPipeline() public {
        address to = makeAddr("grantRecipient");
        uint256 amount = 50e6;
        bytes memory payload = abi.encode(address(usdc), to, amount);
        vm.prank(g1);
        uint64 idx = g.createProposal(
            NaveGovernor.CreateProposalParams({
                title: "grant",
                description: "",
                payload: payload,
                proposalType: uint8(ProposalType.Transfer),
                votingPeriodSeconds: 1 days,
                votingMint: address(0)
            })
        );
        vm.prank(g1);
        g.castVoteWallet(idx, uint8(VoteChoice.For));
        vm.prank(g2);
        g.castVoteWallet(idx, uint8(VoteChoice.For));
        g.finalizeProposal(idx);

        e.createTransferRequest(idx, address(usdc), to, amount);
        bytes32 ph = PayloadHash.transferHash(address(usdc), to, amount);
        vm.prank(exec);
        e.executiveApprove(idx, RH);
        vm.prank(fin);
        e.financialApprove(idx, ph, RH);
        vm.prank(over);
        e.oversightApprove(idx, ph, RH);
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(exec);
        e.execute(idx, 1);

        assertEq(usdc.balanceOf(to), amount);
        assertEq(uint8(e.requestStatus(idx)), uint8(ExecutionStatus.Executed));
    }

    /// Double-spend seal: once the agent pipeline has created an execution
    /// request for a Transfer proposal, the direct governor path must refuse to
    /// disburse it (otherwise both paths would move funds).
    function test_transferProposal_doubleSpend_pipelineBlocksDirect() public {
        address to = makeAddr("grantRecipient");
        uint256 amount = 50e6;
        bytes memory payload = abi.encode(address(usdc), to, amount);
        vm.prank(g1);
        uint64 idx = g.createProposal(
            NaveGovernor.CreateProposalParams({
                title: "grant",
                description: "",
                payload: payload,
                proposalType: uint8(ProposalType.Transfer),
                votingPeriodSeconds: 1 days,
                votingMint: address(0)
            })
        );
        vm.prank(g1);
        g.castVoteWallet(idx, uint8(VoteChoice.For));
        vm.prank(g2);
        g.castVoteWallet(idx, uint8(VoteChoice.For));
        g.finalizeProposal(idx);

        // Pipeline claims the proposal first.
        e.createTransferRequest(idx, address(usdc), to, amount);

        // Direct path must now revert (request already exists).
        vm.expectRevert(NaveErrors.ExecutionRequestExists.selector);
        g.executeTransferProposal(idx, address(usdc), to, amount);

        // No funds moved via the direct path.
        assertEq(usdc.balanceOf(to), 0);
    }

    /// Double-spend seal (reverse ordering): once the direct governor path has
    /// executed a Transfer proposal (status -> Executed), the agent pipeline must
    /// refuse to create an execution request for it.
    function test_transferProposal_doubleSpend_directBlocksPipeline() public {
        address to = makeAddr("grantRecipient");
        uint256 amount = 50e6;
        bytes memory payload = abi.encode(address(usdc), to, amount);
        vm.prank(g1);
        uint64 idx = g.createProposal(
            NaveGovernor.CreateProposalParams({
                title: "grant",
                description: "",
                payload: payload,
                proposalType: uint8(ProposalType.Transfer),
                votingPeriodSeconds: 1 days,
                votingMint: address(0)
            })
        );
        vm.prank(g1);
        g.castVoteWallet(idx, uint8(VoteChoice.For));
        vm.prank(g2);
        g.castVoteWallet(idx, uint8(VoteChoice.For));
        g.finalizeProposal(idx);

        // Direct path executes first.
        g.executeTransferProposal(idx, address(usdc), to, amount);
        assertEq(usdc.balanceOf(to), amount);

        // Pipeline can no longer claim the (now-Executed) proposal.
        vm.expectRevert(NaveErrors.ProposalNotPassed.selector);
        e.createTransferRequest(idx, address(usdc), to, amount);
    }

    /// The treasury can RECEIVE an ERC-721 (onERC721Received) and SEND it under a
    /// passed governance NFT-transfer proposal.
    function test_nftTransfer_receiveAndGovernanceSend() public {
        MockERC721 nft = new MockERC721();
        uint256 tokenId = 7;
        // safeMint into the treasury — reverts unless onERC721Received is wired.
        nft.safeMint(address(t), tokenId);
        assertEq(nft.ownerOf(tokenId), address(t), "treasury holds NFT");

        address to = makeAddr("nftRecipient");
        bytes memory payload = abi.encode("NFT_TRANSFER", address(nft), to, tokenId);
        vm.prank(g1);
        uint64 idx = g.createProposal(
            NaveGovernor.CreateProposalParams({
                title: "grant nft",
                description: "",
                payload: payload,
                proposalType: uint8(ProposalType.Transfer),
                votingPeriodSeconds: 1 days,
                votingMint: address(0)
            })
        );
        vm.prank(g1);
        g.castVoteWallet(idx, uint8(VoteChoice.For));
        vm.prank(g2);
        g.castVoteWallet(idx, uint8(VoteChoice.For));
        g.finalizeProposal(idx);

        g.executeNftTransferProposal(idx, address(nft), to, tokenId);
        assertEq(nft.ownerOf(tokenId), to, "NFT transferred to recipient");

        // Replay blocked (proposal consumed).
        vm.expectRevert(NaveErrors.ProposalNotPassed.selector);
        g.executeNftTransferProposal(idx, address(nft), to, tokenId);
    }
}
