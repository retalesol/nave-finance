// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {NaveBase} from "./NaveBase.t.sol";
import {NaveTreasury} from "../src/NaveTreasury.sol";
import {NaveGovernor} from "../src/NaveGovernor.sol";
import {NaveExecution} from "../src/NaveExecution.sol";
import {NaveDAOFactory} from "../src/NaveDAOFactory.sol";
import {NaveErrors} from "../src/libraries/NaveErrors.sol";
import {NaveConstants} from "../src/libraries/NaveConstants.sol";
import {TreasuryAdminLib} from "../src/libraries/TreasuryAdminLib.sol";
import {AgentRole, AgentStatus, GuardianActionType} from "../src/libraries/NaveEnums.sol";

contract TreasuryTest is NaveBase {
    NaveTreasury internal treasury;

    function setUp() public override {
        super.setUp();
        (treasury,,) = _createDao(0); // wallet governance
    }

    // ── Lifecycle / wiring ────────────────────────────────────────────────
    function test_init_setsFounderAndConfig() public view {
        assertEq(treasury.founder(), founder);
        assertEq(treasury.protocol(), address(protocol));
        assertEq(treasury.quorumBps(), 1000);
        assertEq(treasury.guardianCount(), 3);
        assertEq(treasury.guardianThreshold(), 2);
        assertEq(treasury.performanceFeeBps(), 850);
        assertEq(treasury.managementFeeBps(), 65);
        (address auth, bool op) = treasury.agent(AgentRole.Executive);
        assertEq(auth, exec);
        assertTrue(op);
    }

    function test_initialize_cannotBeCalledTwice() public {
        TreasuryAdminLib.InitParams memory p;
        p.protocol = address(protocol);
        p.founder = founder;
        p.name = "x";
        vm.expectRevert(NaveErrors.AlreadyInitialized.selector);
        treasury.initialize(p);
    }

    function test_protocolRegistersClones() public view {
        assertTrue(protocol.isNaveTreasury(address(treasury)));
        assertEq(protocol.daoCount(), 1);
    }

    // ── No direct withdraw (core invariant) ───────────────────────────────
    function test_withdrawFromVault_alwaysReverts() public {
        vm.expectRevert(NaveErrors.ExecutionRequestRequired.selector);
        treasury.withdrawFromVault(address(usdc), 1);
    }

    // ── Assets + deposit + NAV ────────────────────────────────────────────
    function _registerUsdc() internal {
        vm.prank(founder);
        treasury.registerAsset(address(usdc), bytes32(0), true, 0);
    }

    function test_registerAsset_onlyFounder() public {
        vm.expectRevert(NaveErrors.Unauthorized.selector);
        treasury.registerAsset(address(usdc), bytes32(0), true, 0);
        _registerUsdc();
        (bool registered, bool enabled, bool isStable,,, uint8 dec) =
            treasury.assetInfo(address(usdc));
        assertTrue(registered);
        assertTrue(enabled);
        assertTrue(isStable);
        assertEq(dec, 6);
    }

    function test_registeredAssetsGetter_enumeratesAssets() public {
        _registerUsdc();
        address[] memory assets = treasury.getRegisteredAssets();
        assertEq(assets.length, 1);
        assertEq(assets[0], address(usdc));
    }

    function test_approvedAdaptersGetter_enumeratesConstitution() public {
        address aave = makeAddr("aave");
        address compound = makeAddr("compound");
        address[] memory adapters = new address[](2);
        adapters[0] = aave;
        adapters[1] = compound;
        uint16[] memory caps = new uint16[](2);
        caps[0] = 2500;
        caps[1] = 1500;
        bool[] memory approved = new bool[](2);
        approved[0] = true;
        approved[1] = false;
        string[] memory protocolIds = new string[](2);
        protocolIds[0] = "aave";
        protocolIds[1] = "compound";

        _protocolApproveAdapter(aave);
        _protocolApproveAdapter(compound);
        vm.prank(founder);
        treasury.updateConstitution(adapters, caps, approved, protocolIds, 75, 0);

        (
            address[] memory gotAdapters,
            uint16[] memory gotCaps,
            bool[] memory gotApproved,
            string[] memory gotProtocolIds
        ) = treasury.getApprovedAdapters();
        assertEq(gotAdapters.length, 2);
        assertEq(gotAdapters[0], aave);
        assertEq(gotCaps[0], 2500);
        assertTrue(gotApproved[0]);
        assertEq(gotProtocolIds[0], "aave");
        assertEq(gotAdapters[1], compound);
        assertEq(gotCaps[1], 1500);
        assertFalse(gotApproved[1]);
        assertEq(gotProtocolIds[1], "compound");
    }

    function test_agentDetails_exposesLifecycleFlags() public {
        uint64 d = _deadline();
        bytes[] memory sigs = _guardianSigs(
            treasury, GuardianActionType.NULLIFY_AGENT, uint8(AgentRole.Operational), 0, address(0), 20, d
        );
        treasury.guardianAction(_gp(GuardianActionType.NULLIFY_AGENT, uint8(AgentRole.Operational), 0, address(0), 20, d), sigs);

        (address authority, bool operational) = treasury.agent(AgentRole.Operational);
        assertEq(authority, oper);
        assertFalse(operational);
        assertTrue(treasury.frozen(), "nullify freezes the DAO");
    }

    function test_nullifyAgent_requiresGuardianQuorum() public {
        // Executive alone cannot nullify (SOL-H2 parity).
        vm.prank(exec);
        vm.expectRevert(); // ECDSA / signature verification fails on empty sigs
        treasury.guardianAction(
            _gp(GuardianActionType.NULLIFY_AGENT, uint8(AgentRole.Operational), 0, address(0), 21, _deadline()),
            new bytes[](0)
        );

        (address authority, bool operational) = treasury.agent(AgentRole.Operational);
        assertEq(authority, oper);
        assertTrue(operational);
        assertFalse(treasury.frozen());
    }

    function test_deposit_stablecoinCreditsNavAtOneDollar() public {
        _registerUsdc();
        address user = makeAddr("user");
        usdc.mint(user, 1000e6);
        vm.startPrank(user);
        usdc.approve(address(treasury), 1000e6);
        treasury.deposit(address(usdc), 1000e6);
        vm.stopPrank();
        assertEq(treasury.currentNav(), 1000e6); // $1000 in micro-USD
        assertEq(usdc.balanceOf(address(treasury)), 1000e6);
    }

    // ── Management fee: dual rate + annual gate ───────────────────────────
    function test_managementFee_notDueBeforeYear() public {
        _registerUsdc();
        _fund(1000e6);
        vm.expectRevert(NaveErrors.NoManagementFeeDue.selector);
        treasury.collectManagementFee(address(usdc));
    }

    function test_managementFee_collects65bpsAfterYear() public {
        _registerUsdc();
        _fund(1000e6);
        vm.warp(block.timestamp + 365 days + 1);
        uint256 before = usdc.balanceOf(revenueWallet);
        treasury.collectManagementFee(address(usdc));
        // 0.65% of 1000e6 = 6.5e6
        assertEq(usdc.balanceOf(revenueWallet) - before, 6_500_000);
    }

    // ── Agent rotation 48h timelock ───────────────────────────────────────
    function test_agentRotation_respects48hTimelock() public {
        address newExec = makeAddr("newExec");
        vm.prank(founder);
        treasury.updateAgentSet([newExec, fin, over, oper]);

        // Not yet effective.
        vm.prank(founder);
        vm.expectRevert(NaveErrors.AgentRotationNotReady.selector);
        treasury.applyAgentRotation(uint8(AgentRole.Executive));

        vm.warp(block.timestamp + 48 hours);
        vm.prank(founder);
        treasury.applyAgentRotation(uint8(AgentRole.Executive));
        (address auth,) = treasury.agent(AgentRole.Executive);
        assertEq(auth, newExec);
    }

    function test_agentRotation_noPendingReverts() public {
        vm.prank(founder);
        vm.expectRevert(NaveErrors.NoPendingAgentRotation.selector);
        treasury.applyAgentRotation(uint8(AgentRole.Financial));
    }

    function test_toggleAgents_onlyExecutiveCanEnable() public {
        vm.prank(exec);
        treasury.toggleAgents(true);
        assertTrue(treasury.agentsEnabled());
        // disabling via toggle is forbidden (must go through guardians)
        vm.prank(exec);
        vm.expectRevert(NaveErrors.AgentsDisableRequiresGuardians.selector);
        treasury.toggleAgents(false);
    }

    // ── Hardening: no single actor can disable agents ─────────────────────
    /// Disabling agents unlocks the Executive break-glass `executeDirect` path,
    /// so the former founder-OR-any-guardian `emergencyPauseAgents()` was
    /// removed. A lone guardian (or the founder) must not be able to flip
    /// `agentsEnabled` by any remaining entry point.
    function test_singleGuardian_cannotDisableAgents() public {
        vm.prank(exec);
        treasury.toggleAgents(true);

        // The removed selector is gone from the ABI: the call falls through to
        // the (non-existent) fallback and fails.
        bytes memory removedCall = abi.encodeWithSignature("emergencyPauseAgents()");
        vm.prank(g1);
        (bool ok,) = address(treasury).call(removedCall);
        assertFalse(ok, "emergencyPauseAgents must no longer exist");
        vm.prank(founder);
        (ok,) = address(treasury).call(removedCall);
        assertFalse(ok, "founder cannot pause agents unilaterally either");

        // toggleAgents(false) is refused for everyone (guardian path required).
        vm.prank(g1);
        vm.expectRevert(NaveErrors.AgentsDisableRequiresGuardians.selector);
        treasury.toggleAgents(false);
        vm.prank(exec);
        vm.expectRevert(NaveErrors.AgentsDisableRequiresGuardians.selector);
        treasury.toggleAgents(false);

        // A single guardian signature is below the 2-of-3 threshold.
        uint64 d = _deadline();
        bytes32 digest =
            _guardianDigest(treasury, GuardianActionType.DISABLE_AGENTS, 0, 0, address(0), 77, d);
        bytes[] memory one = new bytes[](1);
        one[0] = _sign(g1Key, digest);
        vm.expectRevert(NaveErrors.InvalidGuardianThreshold.selector);
        treasury.guardianAction(_gp(GuardianActionType.DISABLE_AGENTS, 0, 0, address(0), 77, d), one);

        assertTrue(treasury.agentsEnabled(), "agents remain enabled");

        // The M-of-N path still works.
        bytes[] memory sigs =
            _guardianSigs(treasury, GuardianActionType.DISABLE_AGENTS, 0, 0, address(0), 78, d);
        treasury.guardianAction(_gp(GuardianActionType.DISABLE_AGENTS, 0, 0, address(0), 78, d), sigs);
        assertFalse(treasury.agentsEnabled());
    }

    // ── Hardening: protocol-level adapter allowlist ───────────────────────
    function test_updateConstitution_rejectsUnapprovedAdapter() public {
        address rogue = makeAddr("rogueAdapter");
        address[] memory adapters = new address[](1);
        adapters[0] = rogue;
        uint16[] memory caps = new uint16[](1);
        caps[0] = 5000;
        bool[] memory approved = new bool[](1);
        approved[0] = true;
        string[] memory ids = new string[](1);
        ids[0] = "rogue";

        vm.prank(founder);
        vm.expectRevert(NaveErrors.AdapterNotProtocolApproved.selector);
        treasury.updateConstitution(adapters, caps, approved, ids, 70, 0);
        assertFalse(treasury.isAdapterApproved(rogue));

        // Even an `approved == false` entry must be on the protocol list.
        approved[0] = false;
        vm.prank(founder);
        vm.expectRevert(NaveErrors.AdapterNotProtocolApproved.selector);
        treasury.updateConstitution(adapters, caps, approved, ids, 70, 0);

        // Once the protocol owner allowlists it, the founder may add it.
        _protocolApproveAdapter(rogue);
        approved[0] = true;
        vm.prank(founder);
        treasury.updateConstitution(adapters, caps, approved, ids, 70, 0);
        assertTrue(treasury.isAdapterApproved(rogue));

        // Revoking on the protocol blocks future constitutions that list it.
        vm.prank(owner);
        protocol.setAdapterApproved(rogue, false);
        vm.prank(founder);
        vm.expectRevert(NaveErrors.AdapterNotProtocolApproved.selector);
        treasury.updateConstitution(adapters, caps, approved, ids, 70, 0);
    }

    function test_setAdapterApproved_onlyOwner() public {
        vm.prank(founder);
        vm.expectRevert();
        protocol.setAdapterApproved(makeAddr("x"), true);
        vm.prank(owner);
        vm.expectRevert(NaveErrors.ZeroAddress.selector);
        protocol.setAdapterApproved(address(0), true);
    }

    // ── Hardening: review-window floor + timelocked reductions ────────────
    function test_setReviewWindow_belowFloorReverts() public {
        _useProductionDelays(treasury);
        assertEq(NaveConstants.MIN_REVIEW_WINDOW_SECONDS, 3600, "floor is 1 hour");
        vm.prank(founder);
        vm.expectRevert(NaveErrors.InvalidReviewWindow.selector);
        treasury.setReviewWindow(3599);
        vm.prank(founder);
        vm.expectRevert(NaveErrors.InvalidReviewWindow.selector);
        treasury.setReviewWindow(60); // the old 60s minimum is gone
        vm.prank(founder);
        vm.expectRevert(NaveErrors.InvalidReviewWindow.selector);
        treasury.setReviewWindow(NaveConstants.MAX_REVIEW_WINDOW_SECONDS + 1);
        assertEq(treasury.reviewWindowSecs(), NaveConstants.DEFAULT_REVIEW_WINDOW_SECONDS);
    }

    function test_setReviewWindow_increaseIsImmediate() public {
        int64 current = treasury.reviewWindowSecs(); // 24h default
        vm.prank(founder);
        treasury.setReviewWindow(current + 3600);
        assertEq(treasury.reviewWindowSecs(), current + 3600);
        (int64 pSecs, uint256 pAt) = treasury.pendingReviewWindow();
        assertEq(pSecs, 0);
        assertEq(pAt, 0);
    }

    function test_setReviewWindow_reductionIsDelayedByCurrentWindow() public {
        _useProductionDelays(treasury);
        int64 current = treasury.reviewWindowSecs(); // 86_400
        int64 shorter = 3600;
        uint256 queuedAt = block.timestamp;
        uint256 effectiveAt = queuedAt + uint256(int256(current));

        vm.prank(founder);
        vm.expectEmit(false, false, false, true, address(treasury));
        emit NaveTreasury.ReviewWindowChangeQueued(shorter, effectiveAt);
        treasury.setReviewWindow(shorter);

        // Not in force yet — the live window is unchanged and the change is queued.
        assertEq(treasury.reviewWindowSecs(), current, "reduction must not apply immediately");
        (int64 pSecs, uint256 pAt) = treasury.pendingReviewWindow();
        assertEq(pSecs, shorter);
        assertEq(pAt, effectiveAt, "delay == current window");

        // One second before the delay elapses the OLD window still applies.
        vm.warp(effectiveAt - 1);
        assertEq(treasury.reviewWindowSecs(), current);

        // From `effectiveAt` on, the reduction is in force (no extra tx needed).
        vm.warp(effectiveAt);
        assertEq(treasury.reviewWindowSecs(), shorter);
        (pSecs, pAt) = treasury.pendingReviewWindow();
        assertEq(pSecs, shorter, "queue record persists until superseded");
        assertEq(pAt, effectiveAt);
    }

    function test_setReviewWindow_increaseClearsQueuedReduction() public {
        _useProductionDelays(treasury);
        vm.prank(founder);
        treasury.setReviewWindow(3600); // queued
        (int64 pSecs,) = treasury.pendingReviewWindow();
        assertEq(pSecs, 3600);
        vm.prank(founder);
        treasury.setReviewWindow(2 days); // immediate increase supersedes the queue
        assertEq(treasury.reviewWindowSecs(), 2 days);
        uint256 pAt;
        (pSecs, pAt) = treasury.pendingReviewWindow();
        assertEq(pSecs, 0);
        assertEq(pAt, 0);
    }

    /// A second reduction queued after a first one has come into force is
    /// delayed by the (already reduced) effective window, and the earlier
    /// reduction is persisted as the stored base.
    function test_setReviewWindow_chainedReductions_useEffectiveWindow() public {
        vm.prank(founder);
        treasury.setReviewWindow(2 hours);
        vm.warp(block.timestamp + 1 days); // first reduction now in force
        assertEq(treasury.reviewWindowSecs(), 2 hours);

        uint256 t0 = block.timestamp;
        vm.prank(founder);
        treasury.setReviewWindow(1 hours);
        assertEq(treasury.reviewWindowSecs(), 2 hours, "still the effective 2h window");
        (int64 pSecs, uint256 pAt) = treasury.pendingReviewWindow();
        assertEq(pSecs, 1 hours);
        assertEq(pAt, t0 + 2 hours, "delay == effective (2h) window, not the 24h default");
        vm.warp(t0 + 2 hours);
        assertEq(treasury.reviewWindowSecs(), 1 hours);
    }

    function test_setReviewWindow_onlyFounder() public {
        vm.prank(g1);
        vm.expectRevert(NaveErrors.Unauthorized.selector);
        treasury.setReviewWindow(2 days);
    }

    // ── Hardening: linked treasury must be protocol-registered ────────────
    function test_setLinkedTreasury_rejectsUnregisteredTarget() public {
        uint256 destChain = 8453;
        address sister = makeAddr("sisterTreasury");

        vm.prank(founder);
        vm.expectRevert(NaveErrors.LinkedTreasuryNotRegistered.selector);
        treasury.setLinkedTreasury(destChain, sister);
        assertEq(treasury.linkedTreasury(destChain), address(0));

        // Registered on the protocol for a DIFFERENT chain is not enough.
        vm.prank(owner);
        protocol.setRemoteTreasury(1, sister, true);
        vm.prank(founder);
        vm.expectRevert(NaveErrors.LinkedTreasuryNotRegistered.selector);
        treasury.setLinkedTreasury(destChain, sister);

        // Registered for the destination chain → allowed.
        vm.prank(owner);
        protocol.setRemoteTreasury(destChain, sister, true);
        vm.prank(founder);
        treasury.setLinkedTreasury(destChain, sister);
        assertEq(treasury.linkedTreasury(destChain), sister);

        // Clearing the link is always allowed.
        vm.prank(founder);
        treasury.setLinkedTreasury(destChain, address(0));
        assertEq(treasury.linkedTreasury(destChain), address(0));

        // De-registered → founder cannot re-link it.
        vm.prank(owner);
        protocol.setRemoteTreasury(destChain, sister, false);
        vm.prank(founder);
        vm.expectRevert(NaveErrors.LinkedTreasuryNotRegistered.selector);
        treasury.setLinkedTreasury(destChain, sister);
    }

    function test_setRemoteTreasury_guards() public {
        address sister = makeAddr("sisterTreasury");
        vm.prank(founder);
        vm.expectRevert();
        protocol.setRemoteTreasury(8453, sister, true);
        vm.startPrank(owner);
        vm.expectRevert(NaveErrors.InvalidChainId.selector);
        protocol.setRemoteTreasury(0, sister, true);
        vm.expectRevert(NaveErrors.InvalidChainId.selector);
        protocol.setRemoteTreasury(block.chainid, sister, true);
        vm.expectRevert(NaveErrors.ZeroAddress.selector);
        protocol.setRemoteTreasury(8453, address(0), true);
        vm.stopPrank();
    }

    // ── Guardian M-of-N (EIP-712 + bitmask) ───────────────────────────────
    function test_guardianFreeze_twoOfThree() public {
        uint64 d = _deadline();
        bytes[] memory sigs =
            _guardianSigs(treasury, GuardianActionType.FREEZE, 0, 0, address(0), 1, d);
        treasury.guardianAction(_gp(GuardianActionType.FREEZE, 0, 0, address(0), 1, d), sigs);
        assertTrue(treasury.frozen());
    }

    function test_guardianFreeze_belowThresholdReverts() public {
        uint64 d = _deadline();
        bytes32 digest =
            _guardianDigest(treasury, GuardianActionType.FREEZE, 0, 0, address(0), 2, d);
        bytes[] memory one = new bytes[](1);
        one[0] = _sign(g1Key, digest);
        vm.expectRevert(NaveErrors.InvalidGuardianThreshold.selector);
        treasury.guardianAction(_gp(GuardianActionType.FREEZE, 0, 0, address(0), 2, d), one);
    }

    function test_guardianFreeze_duplicateSignerReverts() public {
        uint64 d = _deadline();
        bytes32 digest =
            _guardianDigest(treasury, GuardianActionType.FREEZE, 0, 0, address(0), 3, d);
        bytes[] memory dup = new bytes[](2);
        dup[0] = _sign(g1Key, digest);
        dup[1] = _sign(g1Key, digest);
        vm.expectRevert(NaveErrors.DuplicateGuardianSignature.selector);
        treasury.guardianAction(_gp(GuardianActionType.FREEZE, 0, 0, address(0), 3, d), dup);
    }

    function test_guardianFreeze_nonGuardianReverts() public {
        uint64 d = _deadline();
        (, uint256 strangerKey) = makeAddrAndKey("stranger");
        bytes32 digest =
            _guardianDigest(treasury, GuardianActionType.FREEZE, 0, 0, address(0), 4, d);
        bytes[] memory sigs = new bytes[](2);
        sigs[0] = _sign(g1Key, digest);
        sigs[1] = _sign(strangerKey, digest);
        vm.expectRevert(NaveErrors.GuardianNotFound.selector);
        treasury.guardianAction(_gp(GuardianActionType.FREEZE, 0, 0, address(0), 4, d), sigs);
    }

    function test_guardianFreeze_replayReverts() public {
        uint64 d = _deadline();
        bytes[] memory sigs =
            _guardianSigs(treasury, GuardianActionType.FREEZE, 0, 0, address(0), 5, d);
        treasury.guardianAction(_gp(GuardianActionType.FREEZE, 0, 0, address(0), 5, d), sigs);
        vm.expectRevert(NaveErrors.InvalidGuardianSignature.selector);
        treasury.guardianAction(_gp(GuardianActionType.FREEZE, 0, 0, address(0), 5, d), sigs);
    }

    function test_guardianFreeze_expiredDeadlineReverts() public {
        // A deadline in the past must be rejected (signatures cannot be valid
        // forever) — this is the H-2 fix making GUARDIAN_ACTION_STALE_SECS live.
        vm.warp(1_000_000);
        uint64 past = uint64(block.timestamp - 1);
        bytes[] memory sigs =
            _guardianSigs(treasury, GuardianActionType.FREEZE, 0, 0, address(0), 50, past);
        vm.expectRevert(NaveErrors.GuardianActionExpired.selector);
        treasury.guardianAction(_gp(GuardianActionType.FREEZE, 0, 0, address(0), 50, past), sigs);
    }

    function test_guardianFreeze_deadlineTooFarReverts() public {
        // A deadline more than 7 days out must be rejected so a single signature
        // cannot pre-authorize an action indefinitely.
        uint64 tooFar = uint64(block.timestamp + 8 days);
        bytes[] memory sigs =
            _guardianSigs(treasury, GuardianActionType.FREEZE, 0, 0, address(0), 51, tooFar);
        vm.expectRevert(NaveErrors.GuardianActionExpired.selector);
        treasury.guardianAction(_gp(GuardianActionType.FREEZE, 0, 0, address(0), 51, tooFar), sigs);
    }

    function test_guardianUnfreeze() public {
        uint64 d = _deadline();
        bytes[] memory f =
            _guardianSigs(treasury, GuardianActionType.FREEZE, 0, 0, address(0), 6, d);
        treasury.guardianAction(_gp(GuardianActionType.FREEZE, 0, 0, address(0), 6, d), f);
        assertTrue(treasury.frozen());
        bytes[] memory u =
            _guardianSigs(treasury, GuardianActionType.UNFREEZE, 0, 0, address(0), 7, d);
        treasury.guardianAction(_gp(GuardianActionType.UNFREEZE, 0, 0, address(0), 7, d), u);
        assertFalse(treasury.frozen());
    }

    function test_guardianDisableAgents() public {
        uint64 d = _deadline();
        vm.prank(exec);
        treasury.toggleAgents(true);
        bytes[] memory sigs =
            _guardianSigs(treasury, GuardianActionType.DISABLE_AGENTS, 0, 0, address(0), 8, d);
        treasury.guardianAction(_gp(GuardianActionType.DISABLE_AGENTS, 0, 0, address(0), 8, d), sigs);
        assertFalse(treasury.agentsEnabled());
    }

    function _guardianAct(uint8 action, uint8 slot, uint8 status, address key, uint64 nonce)
        internal
    {
        uint64 d = _deadline();
        bytes[] memory sigs = _guardianSigs(treasury, action, slot, status, key, nonce, d);
        treasury.guardianAction(_gp(action, slot, status, key, nonce, d), sigs);
    }

    function test_guardianRotateAgentKey_isTimelocked() public {
        vm.chainId(1);
        address newKey = makeAddr("rotatedExec");
        uint8 slot = uint8(AgentRole.Executive);
        _guardianAct(GuardianActionType.ROTATE_AGENT_KEY, slot, 0, newKey, 9);
        (address auth,) = treasury.agent(AgentRole.Executive);
        assertEq(auth, exec, "rotation is queued, not immediate");
        (address pending, uint256 at) = treasury.pendingAgentRotation(slot);
        assertEq(pending, newKey);
        assertEq(at, block.timestamp + NaveConstants.GUARDIAN_AGENT_CHANGE_DELAY_SECS);

        vm.expectRevert(NaveErrors.AgentRotationNotReady.selector);
        treasury.applyAgentRotation(slot);
        vm.warp(at);
        treasury.applyAgentRotation(slot); // permissionless once matured
        (auth,) = treasury.agent(AgentRole.Executive);
        assertEq(auth, newKey);
    }

    function test_testnetDelaysAreOneMinute() public {
        vm.chainId(84532);
        (NaveTreasury t,,) = _createDao(0);
        assertEq(t.reviewWindowSecs(), 60, "dev default review window");
        vm.prank(founder);
        vm.expectRevert(NaveErrors.InvalidReviewWindow.selector);
        t.setReviewWindow(59);

        uint8 slot = uint8(AgentRole.Executive);
        _guardianAct(GuardianActionType.ROTATE_AGENT_KEY, slot, 0, makeAddr("devRotated"), 11);
        (, uint256 at) = treasury.pendingAgentRotation(slot);
        assertEq(at, block.timestamp + 60, "dev guardian agent-change delay");

        vm.chainId(1);
        (NaveTreasury m,,) = _createDao(0);
        assertEq(m.reviewWindowSecs(), NaveConstants.DEFAULT_REVIEW_WINDOW_SECONDS, "mainnet keeps 24h");
    }

    function test_founderCanCancelGuardianRotation() public {
        address newKey = makeAddr("hostileExec");
        uint8 slot = uint8(AgentRole.Executive);
        _guardianAct(GuardianActionType.ROTATE_AGENT_KEY, slot, 0, newKey, 10);
        vm.prank(exec);
        vm.expectRevert(NaveErrors.Unauthorized.selector);
        treasury.cancelAgentRotation(slot);
        vm.prank(founder);
        treasury.cancelAgentRotation(slot);
        vm.warp(block.timestamp + 2 days);
        vm.expectRevert(NaveErrors.NoPendingAgentRotation.selector);
        treasury.applyAgentRotation(slot);
    }

    function test_guardiansCanCancelFounderRotation() public {
        address newExec = makeAddr("founderPickedExec");
        vm.prank(founder);
        treasury.updateAgentSet([newExec, fin, over, oper]);
        _guardianAct(
            GuardianActionType.CANCEL_AGENT_ROTATION, uint8(AgentRole.Executive), 0, address(0), 11
        );
        vm.warp(block.timestamp + 48 hours);
        vm.expectRevert(NaveErrors.NoPendingAgentRotation.selector);
        treasury.applyAgentRotation(uint8(AgentRole.Executive));
    }

    function test_agentKeys_mustBeDistinct() public {
        uint8 slot = uint8(AgentRole.Executive);
        uint64 d = _deadline();
        address[3] memory bad = [fin, founder, g1];
        for (uint256 i; i < bad.length; i++) {
            bytes[] memory sigs = _guardianSigs(
                treasury, GuardianActionType.ROTATE_AGENT_KEY, slot, 0, bad[i], uint64(30 + i), d
            );
            vm.expectRevert(NaveErrors.AgentKeyConflict.selector);
            treasury.guardianAction(
                _gp(GuardianActionType.ROTATE_AGENT_KEY, slot, 0, bad[i], uint64(30 + i), d), sigs
            );
        }
        vm.prank(founder);
        vm.expectRevert(NaveErrors.AgentKeyConflict.selector);
        treasury.updateAgentSet([fin, fin, over, oper]);
        vm.prank(founder);
        vm.expectRevert(NaveErrors.AgentKeyConflict.selector);
        treasury.updateAgentSet([founder, fin, over, oper]);
    }

    function test_createDao_rejectsSharedAgentKeys() public {
        NaveDAOFactory.CreateDaoParams memory p = _daoParams(0);
        p.agentAuthorities = [exec, exec, over, oper];
        vm.prank(founder);
        vm.expectRevert(NaveErrors.AgentKeyConflict.selector);
        factory.createDao(p);
        p.agentAuthorities = [exec, fin, over, g2];
        vm.prank(founder);
        vm.expectRevert(NaveErrors.AgentKeyConflict.selector);
        factory.createDao(p);
    }

    function test_guardianDisable_locksExecutiveReEnable() public {
        vm.prank(exec);
        treasury.toggleAgents(true);
        _guardianAct(GuardianActionType.DISABLE_AGENTS, 0, 0, address(0), 40);
        assertTrue(treasury.agentsGuardianLocked());
        vm.prank(exec);
        vm.expectRevert(NaveErrors.AgentsLockedByGuardians.selector);
        treasury.toggleAgents(true);

        _guardianAct(GuardianActionType.ENABLE_AGENTS, 0, 0, address(0), 41);
        assertTrue(treasury.agentsEnabled());
        assertFalse(treasury.agentsGuardianLocked());
    }

    function test_restoreAgent_requiresGuardianQuorum() public {
        uint8 slot = uint8(AgentRole.Operational);
        _guardianAct(GuardianActionType.NULLIFY_AGENT, slot, 0, address(0), 50);
        // The Executive restore path no longer exists.
        vm.prank(exec);
        (bool ok,) =
            address(treasury).call(abi.encodeWithSignature("restoreAgent(uint8)", slot));
        assertFalse(ok);

        _guardianAct(GuardianActionType.RESTORE_AGENT, slot, 0, address(0), 51);
        (, bool operational) = treasury.agent(AgentRole.Operational);
        assertTrue(operational);
        assertTrue(treasury.frozen(), "restore does not unfreeze");
    }

    function test_agentStatus_pauseImmediate_reactivateQueued() public {
        uint8 slot = uint8(AgentRole.Financial);
        _guardianAct(
            GuardianActionType.UPDATE_AGENT_STATUS, slot, uint8(AgentStatus.Paused), address(0), 60
        );
        (, bool operational) = treasury.agent(AgentRole.Financial);
        assertFalse(operational, "pause applies at once");

        _guardianAct(
            GuardianActionType.UPDATE_AGENT_STATUS, slot, uint8(AgentStatus.Active), address(0), 61
        );
        (, operational) = treasury.agent(AgentRole.Financial);
        assertFalse(operational, "re-activation is queued");
        vm.warp(block.timestamp + NaveConstants.GUARDIAN_AGENT_CHANGE_DELAY_SECS);
        treasury.applyAgentRotation(slot);
        (, operational) = treasury.agent(AgentRole.Financial);
        assertTrue(operational);
    }

    function test_guardianSignature_isBoundToActionType() public {
        uint64 d = _deadline();
        bytes[] memory disableSigs =
            _guardianSigs(treasury, GuardianActionType.DISABLE_AGENTS, 0, 0, address(0), 70, d);
        vm.expectRevert(NaveErrors.GuardianNotFound.selector);
        treasury.guardianAction(
            _gp(GuardianActionType.ENABLE_AGENTS, 0, 0, address(0), 70, d), disableSigs
        );
    }

    function test_guardianUpdate_rejectsAgentKeyAsGuardian() public {
        address[] memory wallets = new address[](2);
        wallets[0] = g1;
        wallets[1] = oper;
        vm.prank(founder);
        vm.expectRevert(NaveErrors.AgentKeyConflict.selector);
        treasury.updateGuardianConfig(wallets, 2);
    }

    function _fund(uint256 amount) internal {
        address user = makeAddr("funder");
        usdc.mint(user, amount);
        vm.startPrank(user);
        usdc.approve(address(treasury), amount);
        treasury.deposit(address(usdc), amount);
        vm.stopPrank();
    }
}
