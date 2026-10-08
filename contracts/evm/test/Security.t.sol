// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {NaveBase} from "./NaveBase.t.sol";
import {NaveProtocol} from "../src/NaveProtocol.sol";
import {NaveDAOFactory} from "../src/NaveDAOFactory.sol";
import {NaveTreasury} from "../src/NaveTreasury.sol";
import {NaveGovernor} from "../src/NaveGovernor.sol";
import {NaveExecution} from "../src/NaveExecution.sol";
import {NaveTokenDeployer} from "../src/NaveTokenDeployer.sol";
import {BalancerAdapter} from "../src/adapters/BalancerAdapter.sol";
import {CurveAdapter} from "../src/adapters/CurveAdapter.sol";
import {NaveErrors} from "../src/libraries/NaveErrors.sol";
import {NaveConstants} from "../src/libraries/NaveConstants.sol";
import {
    ProposalType,
    ProposalStatus,
    VoteChoice,
    GuardianActionType
} from "../src/libraries/NaveEnums.sol";
import {TestSharesAdapter} from "./mocks/TestSharesAdapter.sol";
import {SlippageMockAdapter} from "./mocks/SlippageMockAdapter.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {ReentrantToken} from "./mocks/ReentrantToken.sol";
import {ReentrantDepositToken} from "./mocks/ReentrantDepositToken.sol";
import {MockRateToken} from "./mocks/MockRateToken.sol";
import {MockCurvePool} from "./mocks/MockCurvePool.sol";
import {MockBalancerVault} from "./mocks/MockBalancerVault.sol";
import {TestProxies} from "./helpers/TestProxies.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/// @notice Regression tests for the audit-blocking vulnerabilities fixed in this
/// change set: C-1 (cross-DAO markExecuted), C-2 (share inflation), C-3/C-4
/// (zero-slippage joins), H-2 (transfer NAV accounting), H-5 (factory oracle
/// zero-address). H-1 (token-mint governance gate) lives in Governance.t.sol.
/// EVM-C1 (quorum-rounding) and EVM-C2 (adapter pricing / execute() gating)
/// live at the bottom of this file.
contract SecurityTest is NaveBase {
    // ── C-1: NaveGovernor.markExecuted is bound to THIS DAO's execution ───
    function test_C1_markExecuted_rejectsForeignExecution() public {
        (, NaveGovernor gA, NaveExecution eA) = _createDao(0);
        (,, NaveExecution eB) = _createDao(0);

        // Create a proposal on DAO A so index 0 exists.
        vm.prank(g1);
        gA.createProposal(
            NaveGovernor.CreateProposalParams({
                title: "p",
                description: "",
                payload: "",
                proposalType: uint8(ProposalType.General),
                votingPeriodSeconds: 1 days,
                votingMint: address(0)
            })
        );

        // A foreign DAO's execution contract cannot finalize A's proposal.
        vm.prank(address(eB));
        vm.expectRevert(NaveErrors.Unauthorized.selector);
        gA.markExecuted(0);

        // A random caller cannot either.
        vm.prank(makeAddr("rando"));
        vm.expectRevert(NaveErrors.Unauthorized.selector);
        gA.markExecuted(0);

        // Only DAO A's own execution clone may — and only once the proposal
        // has actually PASSED (pre-redeploy hardening: `markExecuted` refuses
        // Active / Failed / Cancelled / already-Executed proposals).
        vm.prank(address(eA));
        vm.expectRevert(NaveErrors.ProposalNotPassed.selector);
        gA.markExecuted(0);

        vm.prank(g1);
        gA.castVoteWallet(0, uint8(VoteChoice.For));
        vm.prank(g2);
        gA.castVoteWallet(0, uint8(VoteChoice.For));
        gA.finalizeProposal(0);

        vm.prank(address(eA));
        gA.markExecuted(0);
        (, uint8 status,,,) = gA.proposalCore(0);
        assertEq(status, uint8(ProposalStatus.Executed));
    }

    // ── C-2: first-depositor share-inflation attack is defused ────────────
    function _twoExecProtocol() internal returns (NaveProtocol p, address a, address b) {
        a = makeAddr("execA");
        b = makeAddr("execB");
        p = TestProxies.deployProtocol(address(this), address(0xFEE), 0, 0);
        p.setFactory(address(this));
        p.registerDao(makeAddr("tA"), makeAddr("gA"), a);
        p.registerDao(makeAddr("tB"), makeAddr("gB"), b);
    }

    function test_C2_firstDepositBelowDeadFloorReverts() public {
        (NaveProtocol p, address a,) = _twoExecProtocol();
        MockERC20 asset = new MockERC20("USD Coin", "USDC", 6);
        TestSharesAdapter adapter = new TestSharesAdapter(address(p), address(asset));

        uint256 floor = adapter.MIN_DEAD_SHARES();
        vm.prank(a);
        vm.expectRevert(NaveErrors.DepositBelowMinimum.selector);
        adapter.deposit(address(asset), floor, 0);
    }

    function test_C2_inflationAttackMitigated() public {
        (NaveProtocol p, address attacker, address victim) = _twoExecProtocol();
        MockERC20 asset = new MockERC20("USD Coin", "USDC", 6);
        TestSharesAdapter adapter = new TestSharesAdapter(address(p), address(asset));

        // Attacker is the first depositor with the minimum viable amount.
        vm.prank(attacker);
        adapter.deposit(address(asset), 1001, 0);
        assertEq(adapter.shares(address(0xdead), address(asset)), 1000, "dead shares locked");
        assertEq(adapter.shares(attacker, address(asset)), 1, "attacker keeps only 1 share");

        // Attacker donates 10,000 USDC directly into the pool to inflate price.
        adapter.accrue(10_000e6);

        // Victim deposits 1,000 USDC.
        vm.prank(victim);
        adapter.deposit(address(asset), 1000e6, 0);

        // Victim must still receive shares worth ~their deposit (the donation is
        // overwhelmingly absorbed by the permanently locked dead shares, so the
        // rounding-to-zero theft is no longer profitable).
        vm.prank(victim);
        uint256 victimValue = adapter.positionValue(address(asset));
        assertGt(adapter.shares(victim, address(asset)), 0, "victim got non-zero shares");
        assertApproxEqRel(victimValue, 1000e6, 0.01e18, "victim retains ~all deposited value");
    }

    // ── C-3 / C-4: slippage-bearing adapters reject minOut == 0 on mainnet ─
    function test_C3C4_zeroSlippageRejectedOnMainnet() public {
        (NaveProtocol p, address a, address b) = _twoExecProtocol();
        MockERC20 asset = new MockERC20("USD Coin", "USDC", 6);
        SlippageMockAdapter adapter = new SlippageMockAdapter(address(p), address(asset));

        // Ethereum mainnet: unbounded join is rejected.
        vm.chainId(1);
        vm.prank(a);
        vm.expectRevert(NaveErrors.SlippageBoundRequired.selector);
        adapter.deposit(address(asset), 5000, 0);

        // A bounded join (minOut > 0) is accepted.
        vm.prank(a);
        adapter.deposit(address(asset), 5000, 1);

        // Unbounded withdraw is likewise rejected on mainnet.
        vm.prank(a);
        vm.expectRevert(NaveErrors.SlippageBoundRequired.selector);
        adapter.withdraw(address(asset), 100, address(0xBEEF), 0);

        // Base mainnet (8453) is also guarded.
        vm.chainId(8453);
        vm.prank(b);
        vm.expectRevert(NaveErrors.SlippageBoundRequired.selector);
        adapter.deposit(address(asset), 5000, 0);

        // Testnets (no deep liquidity) relax the guard so smoke flows can run.
        vm.chainId(11_155_111);
        vm.prank(b);
        adapter.deposit(address(asset), 5000, 0);
    }

    function test_C3C4_realAdaptersEnforceGuard() public {
        (NaveProtocol p, address a,) = _twoExecProtocol();
        address asset = address(new MockERC20("USD Coin", "USDC", 6));
        vm.chainId(1);

        // The guard runs before any external Vault/pool call, so dummy targets
        // are fine — we only assert the zero-slippage rejection.
        BalancerAdapter bal = new BalancerAdapter(
            address(p), address(0xBA12), bytes32(0), address(0xB97), asset, 0, 2
        );
        vm.prank(a);
        vm.expectRevert(NaveErrors.SlippageBoundRequired.selector);
        bal.deposit(asset, 100, 0);

        CurveAdapter cur =
            new CurveAdapter(address(p), address(0xC0), address(0xC1), asset, int128(0), 2, 100);
        vm.prank(a);
        vm.expectRevert(NaveErrors.SlippageBoundRequired.selector);
        cur.deposit(asset, 100, 0);
    }

    // ── H-2: executeTransfer updates NAV for non-stable assets ────────────
    function test_H2_executeTransfer_updatesNavForNonStable() public {
        (NaveTreasury t,, NaveExecution e) = _createDao(0);
        MockERC20 weth = new MockERC20("Wrapped Ether", "WETH", 18);
        bytes32 feed = keccak256("ETH/USD");

        // Register WETH as a non-stable (oracle-priced) asset at $2,000.
        vm.prank(founder);
        t.registerAsset(address(weth), feed, false, 1);
        _setPythPrice(feed, 2000e8, 1e8, -8);

        // Fund the treasury with 5 WETH and mark NAV.
        address user = makeAddr("user");
        weth.mint(user, 5e18);
        vm.startPrank(user);
        weth.approve(address(t), 5e18);
        t.deposit(address(weth), 5e18);
        vm.stopPrank();
        _revalueTreasury(t);
        assertEq(t.currentNav(), 10_000e6, "5 WETH @ $2000 = $10,000 NAV");

        // Transfer 1 WETH out via the execution path; NAV must fall by $2,000.
        vm.prank(address(e));
        t.executeTransfer(address(weth), makeAddr("grantee"), 1e18);
        assertEq(t.currentNav(), 8000e6, "NAV reduced by the transferred non-stable value");
        assertEq(weth.balanceOf(makeAddr("grantee")), 1e18);
    }

    // ── H-1: CEI ordering in _executeTreasuryTransfer (reentrancy) ────────
    function test_H1_executeTransfer_noDoubleNavDeductionOnReentrantToken() public {
        (NaveTreasury t,, NaveExecution e) = _createDao(0);
        ReentrantToken ree = new ReentrantToken();
        ree.setTreasury(address(t));

        // Register as a $1 stablecoin so NAV (micro-USD) equals the token balance.
        vm.prank(founder);
        t.registerAsset(address(ree), bytes32(0), true, 1);

        address user = makeAddr("user");
        ree.mint(user, 1000e6);
        vm.startPrank(user);
        ree.approve(address(t), 1000e6);
        t.deposit(address(ree), 1000e6);
        vm.stopPrank();
        _revalueTreasury(t);
        assertEq(t.currentNav(), 1000e6, "NAV seeded at $1000");

        // Arm the reentrancy: the token re-enters revalueTreasury() mid-transfer.
        ree.arm(true);
        vm.prank(address(e));
        t.executeTransfer(address(ree), makeAddr("grantee"), 300e6);

        // CEI ordering deducts NAV exactly once: $1000 - $300 = $700. The pre-fix
        // code would re-deduct during the reentrant hook, leaving $400.
        assertEq(
            t.currentNav(), 700e6, "NAV deducted exactly once (no reentrancy double-count)"
        );
        assertEq(ree.balanceOf(makeAddr("grantee")), 300e6);
    }

    // ── H-5: NaveDAOFactory rejects a zero oracle at construction ─────────
    function test_H5_factoryRejectsZeroOracle() public {
        NaveTokenDeployer td = new NaveTokenDeployer();
        NaveDAOFactory impl = new NaveDAOFactory();

        vm.expectRevert(NaveErrors.ZeroAddress.selector);
        new ERC1967Proxy(
            address(impl),
            abi.encodeCall(
                NaveDAOFactory.initialize,
                (address(this), address(protocol), address(0), address(td))
            )
        );
    }

    // ── EVM-C1: quorum requirement rounds UP, not down to a trivial 0/under-
    // threshold minimum ─────────────────────────────────────────────────────
    function _createSwitchProposal(NaveGovernor g) internal returns (uint64 idx) {
        vm.prank(g1);
        idx = g.createProposal(
            NaveGovernor.CreateProposalParams({
                title: "switch",
                description: "",
                payload: "",
                proposalType: uint8(ProposalType.SwitchVotingSystem),
                votingPeriodSeconds: 1 days,
                votingMint: address(0)
            })
        );
    }

    /// A `SwitchVotingSystem` proposal (70% quorum) on a 3-guardian wallet-gov
    /// DAO: pre-fix floor division computed `required = floor(3*7000/10_000)
    /// == 2`, so 2 of 3 guardians (66.7% turnout — LESS than the mandated 70%)
    /// wrongly satisfied quorum, and for smaller sets / lower-bps proposal
    /// types (e.g. 3 guardians, TokenMint's 2500 bps: floor(3*2500/10_000)
    /// == 0) quorum was trivially met with negligible or zero participation.
    /// The ceiling fix requires `ceil(2.1) == 3` — all three guardians — and
    /// floors `required` at 1 so a degenerate zero-eligible-voter set can
    /// never be trivially satisfied either.
    function test_EVMC1_switchVotingQuorum_twoOfThreeNoLongerSufficient() public {
        (, NaveGovernor g,) = _createDao(0); // wallet governance, 3 guardians (g1, g2, g3)

        uint64 idxPartial = _createSwitchProposal(g);
        vm.prank(g1);
        g.castVoteWallet(idxPartial, uint8(VoteChoice.For));
        vm.prank(g2);
        g.castVoteWallet(idxPartial, uint8(VoteChoice.For));
        // g3 never votes: only 2 of 3 guardians (66.7% turnout) participate.

        uint64 idxUnanimous = _createSwitchProposal(g);
        vm.prank(g1);
        g.castVoteWallet(idxUnanimous, uint8(VoteChoice.For));
        vm.prank(g2);
        g.castVoteWallet(idxUnanimous, uint8(VoteChoice.For));
        vm.prank(g3);
        g.castVoteWallet(idxUnanimous, uint8(VoteChoice.For));

        vm.warp(block.timestamp + 1 days + 1);

        // Pre-fix this would have PASSED (floor(3*7000/10_000) == 2, met by
        // the 2 votes cast). The ceiling fix now correctly demands all 3, and
        // (pre-redeploy hardening) a missed quorum after `votingEnd` resolves
        // to a terminal `Failed` status instead of reverting `QuorumNotMet`.
        g.finalizeProposal(idxPartial);
        (, uint8 partialStatus,,,) = g.proposalCore(idxPartial);
        assertEq(partialStatus, uint8(ProposalStatus.Failed), "2-of-3 misses 70% quorum");

        // Unanimous (3-of-3) participation still clears the 70% bar.
        g.finalizeProposal(idxUnanimous);
        (, uint8 status,,,) = g.proposalCore(idxUnanimous);
        assertEq(status, uint8(ProposalStatus.Passed), "unanimous vote still passes");
    }

    // ── EVM-C2: execute() is gated to the DAO's own registered agents ──────
    // (see test_execute_nonAgentThirdPartyReverts in Execution.t.sol for the
    // full pipeline regression; the property is restated here for locality
    // with the other EVM-C2 coverage.)

    // ── EVM-C2: BalancerAdapter prices via getRate(), not spot pool balances
    function test_EVMC2_balancerAdapter_ignoresManipulatedSpotBalances() public {
        (NaveProtocol p, address execA,) = _twoExecProtocol();

        MockERC20 weth = new MockERC20("Wrapped Ether", "WETH", 18);
        MockRateToken bpt = new MockRateToken("Mock BPT", "mBPT");
        MockBalancerVault vault = new MockBalancerVault(address(weth), address(bpt), 2, 0);
        BalancerAdapter adapter =
            new BalancerAdapter(address(p), address(vault), bytes32(0), address(bpt), address(weth), 0, 2);

        // Fund the adapter (as the execution pipeline would) and deposit at a
        // 1:1 rate.
        weth.mint(address(adapter), 1000e18);
        vm.prank(address(adapter));
        weth.approve(address(vault), type(uint256).max);
        vm.prank(execA);
        adapter.deposit(address(weth), 1000e18, 0);

        vm.prank(execA);
        uint256 valueBefore = adapter.positionValue(address(weth));
        assertApproxEqAbs(valueBefore, 1000e18, 1000, "~1000 WETH minus locked dead shares");

        // Flash-loan-style manipulation: swing the pool's raw getPoolTokens()
        // balance wildly (both far above and far below the "real" value) —
        // this is the pre-fix vulnerable pricing input and must now have NO
        // effect on the adapter's valuation.
        vault.setSpotBalance(0, 1);
        vm.prank(execA);
        assertEq(
            adapter.positionValue(address(weth)),
            valueBefore,
            "spot-balance manipulation must not move BPT valuation"
        );
        vault.setSpotBalance(0, 10_000_000e18);
        vm.prank(execA);
        assertEq(
            adapter.positionValue(address(weth)),
            valueBefore,
            "spot-balance manipulation must not move BPT valuation (other direction)"
        );

        // Sanity: the adapter genuinely reads getRate() (not a hardcoded
        // constant) — moving the REAL rate-provider rate does move valuation.
        bpt.setRate(2e18);
        vm.prank(execA);
        assertApproxEqAbs(
            adapter.positionValue(address(weth)),
            valueBefore * 2,
            2000,
            "getRate() genuinely drives valuation"
        );
    }

    // ── EVM-C2: CurveAdapter prices via get_virtual_price(), not
    // calc_withdraw_one_coin against current pool balances ──────────────────
    function test_EVMC2_curveAdapter_ignoresManipulatedWithdrawOneCoin() public {
        (NaveProtocol p, address execA,) = _twoExecProtocol();

        MockERC20 dai = new MockERC20("Dai", "DAI", 18);
        MockRateToken lp = new MockRateToken("Mock Curve LP", "mCRV");
        MockCurvePool pool = new MockCurvePool(address(dai), address(lp));
        CurveAdapter adapter =
            new CurveAdapter(address(p), address(pool), address(lp), address(dai), int128(0), 2, 100);

        dai.mint(address(adapter), 1000e18);
        vm.prank(address(adapter));
        dai.approve(address(pool), type(uint256).max);
        vm.prank(execA);
        adapter.deposit(address(dai), 1000e18, 0);

        vm.prank(execA);
        uint256 valueBefore = adapter.positionValue(address(dai));
        assertApproxEqAbs(valueBefore, 1000e18, 1000, "~1000 DAI minus locked dead shares");

        // Pre-fix vulnerable metric: calc_withdraw_one_coin, spoofed here to
        // simulate a flash-loan-skewed pool read. Must no longer move pricing.
        pool.setSpoofedWithdrawOneCoin(1);
        vm.prank(execA);
        assertEq(
            adapter.positionValue(address(dai)),
            valueBefore,
            "calc_withdraw_one_coin manipulation must not move LP valuation"
        );
        pool.setSpoofedWithdrawOneCoin(10_000_000e18);
        vm.prank(execA);
        assertEq(
            adapter.positionValue(address(dai)),
            valueBefore,
            "calc_withdraw_one_coin manipulation must not move LP valuation (other direction)"
        );

        // Sanity: get_virtual_price() genuinely drives valuation.
        pool.setVirtualPrice(2e18);
        vm.prank(execA);
        assertApproxEqAbs(
            adapter.positionValue(address(dai)),
            valueBefore * 2,
            2000,
            "get_virtual_price() genuinely drives valuation"
        );
    }

    // ── EVM-H1: frozen-guardian recovery escape hatch ──────────────────────
    function _freezeDao(NaveTreasury t) internal {
        uint64 d = _deadline();
        bytes[] memory sigs =
            _guardianSigs(t, GuardianActionType.FREEZE, 0, 0, address(0), 1, d);
        t.emergencyFreeze(1, d, sigs);
        assertTrue(t.frozen(), "frozen");
    }

    function test_EVMH1_queueRecovery_requiresFrozenAndFounder() public {
        (NaveTreasury t,,) = _createDao(0);
        address[] memory newSet = new address[](1);
        newSet[0] = makeAddr("newGuardian");

        // Not frozen: the normal updateGuardianConfig path applies instead.
        vm.prank(founder);
        vm.expectRevert(NaveErrors.DaoNotFrozen.selector);
        t.queueGuardianRecovery(newSet, 1);

        _freezeDao(t);

        // Only the founder can queue.
        vm.prank(makeAddr("rando"));
        vm.expectRevert(NaveErrors.Unauthorized.selector);
        t.queueGuardianRecovery(newSet, 1);

        vm.prank(founder);
        t.queueGuardianRecovery(newSet, 1);
        (uint256 executableAt,, uint256 count) = t.guardianRecoveryPending();
        assertEq(
            executableAt,
            block.timestamp + NaveConstants.GUARDIAN_RECOVERY_TIMELOCK_SECS,
            "timelock armed"
        );
        assertEq(count, 1);
    }

    /// Full recovery: freeze -> founder queues replacement -> timelock -> new
    /// guardian set installed (DAO stays frozen) -> NEW guardians unfreeze.
    function test_EVMH1_recoveryTimelock_replacesGuardians_thenNewSetUnfreezes() public {
        (NaveTreasury t,,) = _createDao(0);
        _freezeDao(t);

        (address n1, uint256 n1Key) = makeAddrAndKey("recoveryGuardian1");
        (address n2, uint256 n2Key) = makeAddrAndKey("recoveryGuardian2");
        address[] memory newSet = new address[](2);
        newSet[0] = n1;
        newSet[1] = n2;

        vm.prank(founder);
        t.queueGuardianRecovery(newSet, 2);

        // Timelock enforced.
        vm.prank(founder);
        vm.expectRevert(NaveErrors.RecoveryTimelockActive.selector);
        t.executeGuardianRecovery();

        vm.warp(block.timestamp + NaveConstants.GUARDIAN_RECOVERY_TIMELOCK_SECS + 1);
        vm.prank(founder);
        t.executeGuardianRecovery();

        // Old guardians replaced; DAO deliberately STAYS frozen.
        assertTrue(t.frozen(), "recovery does not auto-unfreeze");
        assertFalse(t.isGuardian(g1), "old guardian removed");
        assertTrue(t.isGuardian(n1), "new guardian installed");
        assertEq(t.guardianThreshold(), 2);

        // The NEW set unfreezes via the normal M-of-N path.
        uint64 d = _deadline();
        bytes32 digest =
            _guardianDigest(t, GuardianActionType.UNFREEZE, 0, 0, address(0), 7, d);
        bytes[] memory sigs = new bytes[](2);
        sigs[0] = _sign(n1Key, digest);
        sigs[1] = _sign(n2Key, digest);
        t.emergencyUnfreeze(7, d, sigs);
        assertFalse(t.frozen(), "new guardians unfroze the DAO");
        assertEq(t.frozenAt(), 0, "freeze anchor cleared");
    }

    /// A live, honest guardian quorum can veto a queued recovery (e.g. a
    /// compromised founder key trying to seize the guardian set).
    function test_EVMH1_guardianQuorumVetoesRecovery() public {
        (NaveTreasury t,,) = _createDao(0);
        _freezeDao(t);

        address[] memory newSet = new address[](1);
        newSet[0] = makeAddr("hostileGuardian");
        vm.prank(founder);
        t.queueGuardianRecovery(newSet, 1);

        uint64 d = _deadline();
        bytes[] memory sigs =
            _guardianSigs(t, GuardianActionType.CANCEL_RECOVERY, 0, 0, address(0), 2, d);
        t.guardianVetoRecovery(2, d, sigs);

        (uint256 executableAt,,) = t.guardianRecoveryPending();
        assertEq(executableAt, 0, "queue cleared by veto");

        vm.warp(block.timestamp + NaveConstants.GUARDIAN_RECOVERY_TIMELOCK_SECS + 1);
        vm.prank(founder);
        vm.expectRevert(NaveErrors.NoGuardianRecoveryPending.selector);
        t.executeGuardianRecovery();
        assertTrue(t.isGuardian(g1), "original guardians intact");
    }

    /// Guardians unfreezing (proving liveness) moots any queued recovery.
    function test_EVMH1_unfreezeClearsQueuedRecovery() public {
        (NaveTreasury t,,) = _createDao(0);
        _freezeDao(t);

        address[] memory newSet = new address[](1);
        newSet[0] = makeAddr("newGuardian");
        vm.prank(founder);
        t.queueGuardianRecovery(newSet, 1);

        uint64 d = _deadline();
        bytes[] memory sigs =
            _guardianSigs(t, GuardianActionType.UNFREEZE, 0, 0, address(0), 3, d);
        t.emergencyUnfreeze(3, d, sigs);

        (uint256 executableAt,,) = t.guardianRecoveryPending();
        assertEq(executableAt, 0, "unfreeze cleared the queued recovery");
    }

    /// Documented last resort: the protocol owner may force-unfreeze a DAO
    /// continuously frozen for 30+ days. Gated to the owner + long timelock.
    function test_EVMH1_protocolOwnerForceUnfreeze_after30Days() public {
        (NaveTreasury t,,) = _createDao(0);
        _freezeDao(t);

        // Not the protocol owner.
        vm.prank(founder);
        vm.expectRevert(NaveErrors.Unauthorized.selector);
        t.forceUnfreeze();

        // Owner, but the 30-day timelock has not elapsed.
        vm.prank(owner);
        vm.expectRevert(NaveErrors.RecoveryTimelockActive.selector);
        t.forceUnfreeze();

        vm.warp(block.timestamp + NaveConstants.PROTOCOL_FORCE_UNFREEZE_TIMELOCK_SECS + 1);
        vm.prank(owner);
        t.forceUnfreeze();
        assertFalse(t.frozen(), "force-unfrozen after 30d");

        // Not frozen anymore -> repeat call rejected.
        vm.prank(owner);
        vm.expectRevert(NaveErrors.DaoNotFrozen.selector);
        t.forceUnfreeze();
    }

    // ── SEC-M1: withdraw burns shares rounded UP (no co-tenant dilution) ───
    /// Two DAOs share one adapter. After yield accrues (share price > 1), a
    /// withdrawal amount that does not divide evenly by the share price must
    /// burn the CEILING number of shares — flooring let the withdrawer keep the
    /// dropped fraction, slowly siphoning value from the co-tenant.
    function test_SECM1_withdrawBurnsSharesRoundedUp() public {
        (NaveProtocol p, address a, address b) = _twoExecProtocol();
        MockERC20 asset = new MockERC20("USD Coin", "USDC", 6);
        TestSharesAdapter adapter = new TestSharesAdapter(address(p), address(asset));

        // Both tenants deposit 1,000,000 units (execution pre-funds the adapter).
        asset.mint(address(adapter), 1_000_000);
        vm.prank(a);
        adapter.deposit(address(asset), 1_000_000, 0);
        asset.mint(address(adapter), 1_000_000);
        vm.prank(b);
        adapter.deposit(address(asset), 1_000_000, 0);

        // Accrue yield so total underlying / total shares is no longer 1:1
        // (creates a fractional share price so rounding direction matters).
        adapter.accrue(777_777);

        uint256 tsBefore = adapter.totalShares(address(asset));
        uint256 aSharesBefore = adapter.shares(a, address(asset));
        uint256 totalUnderlyingBefore = adapter.pooled();
        vm.prank(a);
        uint256 aValueBefore = adapter.positionValue(address(asset));

        // Withdraw an odd amount that will not divide evenly.
        uint256 wd = 123_457;
        vm.prank(a);
        adapter.withdraw(address(asset), wd, address(0xBEEF), 0);

        uint256 burned = aSharesBefore - adapter.shares(a, address(asset));
        uint256 totalBurned = tsBefore - adapter.totalShares(address(asset));
        assertEq(burned, totalBurned, "only the withdrawer's shares burned");

        // Ceiling check: burned == ceil(wd * tsBefore / totalUnderlyingBefore).
        uint256 expectedCeil =
            (wd * tsBefore + totalUnderlyingBefore - 1) / totalUnderlyingBefore;
        assertEq(burned, expectedCeil, "shares burned rounded UP (ceil)");

        // The withdrawer must NOT retain more value than the floor result would
        // have left them — proving the co-tenant is not diluted by the rounding.
        vm.prank(a);
        uint256 aValueAfter = adapter.positionValue(address(asset));
        assertLe(aValueAfter, aValueBefore - wd + 1, "no value leaked to withdrawer");
    }

    // ── SEC-M5(a): stablecoins priced via oracle within a tight peg band ───
    function test_SECM5_stablecoinPricedByOracleWithinBand() public {
        (NaveTreasury t,,) = _createDao(0);
        MockERC20 dai = new MockERC20("Dai", "DAI", 18);
        bytes32 feed = keccak256("DAI/USD");

        // Register DAI as a stablecoin WITH an oracle feed.
        vm.prank(founder);
        t.registerAsset(address(dai), feed, true, 0);

        // Deposit credits NAV via the same oracle path as revalue — feed must
        // be fresh before deposit (otherwise StaleOracle).
        _setPythPrice(feed, 0.99e8, 1e6, -8);

        address user = makeAddr("user");
        dai.mint(user, 1000e18);
        vm.startPrank(user);
        dai.approve(address(t), 1000e18);
        t.deposit(address(dai), 1000e18);
        vm.stopPrank();

        // At $0.99 (within the 2% band) NAV reflects the oracle, not a flat $1.
        _revalueTreasury(t);
        assertApproxEqRel(t.currentNav(), 990e6, 0.001e18, "priced at oracle $0.99, not $1");
    }

    /// Depeg beyond the 2% band -> valuation (revalue) reverts, so a manipulated
    /// or genuinely broken stablecoin peg can't silently mis-mark NAV.
    function test_SECM5_stablecoinDepegReverts() public {
        (NaveTreasury t,,) = _createDao(0);
        MockERC20 dai = new MockERC20("Dai", "DAI", 18);
        bytes32 feed = keccak256("DAI/USD");
        vm.prank(founder);
        t.registerAsset(address(dai), feed, true, 0);

        // Seed a fresh in-band price so deposit can credit NAV.
        _setPythPrice(feed, 1e8, 1e6, -8);

        address user = makeAddr("user");
        dai.mint(user, 1000e18);
        vm.startPrank(user);
        dai.approve(address(t), 1000e18);
        t.deposit(address(dai), 1000e18);
        vm.stopPrank();

        // $0.90 — 10% off par, well outside the 2% band.
        // MockPyth only accepts updates with a newer publishTime than the last.
        _setPythPriceAt(feed, 0.90e8, 1e6, -8, uint64(block.timestamp) + 1);
        vm.prank(founder);
        vm.expectRevert(NaveErrors.StablecoinDepegged.selector);
        t.revalueTreasury();
    }

    /// A stablecoin with NO feed configured keeps flat $1 valuation (testnet
    /// posture) — the oracle path only engages when a feed exists.
    function test_SECM5_stablecoinNoFeedKeepsPar() public {
        (NaveTreasury t,,) = _createDao(0);
        // usdc registered with bytes32(0) feed and no chainlink fallback.
        vm.prank(founder);
        t.registerAsset(address(usdc), bytes32(0), true, 0);
        address user = makeAddr("user");
        usdc.mint(user, 1000e6);
        vm.startPrank(user);
        usdc.approve(address(t), 1000e6);
        t.deposit(address(usdc), 1000e6);
        vm.stopPrank();
        assertEq(t.currentNav(), 1000e6, "flat $1 when no feed configured");
    }

    // ── SEC-M5(d): revalueTreasury is reentrancy-guarded against hook tokens ─
    function test_SECM5_revalueTreasury_reentrancyGuarded() public {
        (NaveTreasury t,,) = _createDao(0);
        ReentrantDepositToken hook = new ReentrantDepositToken();
        hook.setTreasury(address(t));

        vm.prank(founder);
        t.registerAsset(address(hook), bytes32(0), true, 0);

        address user = makeAddr("user");
        hook.mint(user, 1000e6);
        hook.arm(true); // re-enter revalueTreasury() on transfer into treasury

        // The reentrant revalue hits the shared nonReentrant guard and reverts
        // the whole deposit — no double-counted NAV.
        vm.startPrank(user);
        hook.approve(address(t), 1000e6);
        vm.expectRevert(); // ReentrancyGuardReentrantCall
        t.deposit(address(hook), 1000e6);
        vm.stopPrank();
    }
}
