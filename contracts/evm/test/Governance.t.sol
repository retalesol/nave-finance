// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {NaveBase} from "./NaveBase.t.sol";
import {NaveTreasury} from "../src/NaveTreasury.sol";
import {NaveGovernor} from "../src/NaveGovernor.sol";
import {NaveExecution} from "../src/NaveExecution.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {NaveErrors} from "../src/libraries/NaveErrors.sol";
import {PayloadHash} from "../src/libraries/PayloadHash.sol";
import {
    ProposalType,
    ProposalStatus,
    VoteChoice,
    GovernanceType
} from "../src/libraries/NaveEnums.sol";

contract GovernanceTest is NaveBase {
    function _proposalParams(uint8 ptype, address votingMint, bytes memory payload)
        internal
        pure
        returns (NaveGovernor.CreateProposalParams memory p)
    {
        p = NaveGovernor.CreateProposalParams({
            title: "T",
            description: "D",
            payload: payload,
            proposalType: ptype,
            votingPeriodSeconds: 1 days,
            votingMint: votingMint
        });
    }

    // ── Wallet governance: guardian votes + early finalization ────────────
    function test_walletGov_earlyFinalizationPasses() public {
        (NaveTreasury t, NaveGovernor g,) = _createDao(0);
        vm.prank(g1);
        uint64 idx = g.createProposal(_proposalParams(uint8(ProposalType.General), address(0), ""));

        vm.prank(g1);
        g.castVoteWallet(idx, uint8(VoteChoice.For));
        vm.prank(g2);
        g.castVoteWallet(idx, uint8(VoteChoice.For));

        // 3 guardians eligible, 2 For, lead 2 > remaining 1 -> early finalize.
        g.finalizeProposal(idx);
        (, uint8 status,,,) = g.proposalCore(idx);
        assertEq(status, uint8(ProposalStatus.Passed));
        t; // silence
    }

    function test_walletGov_nonGuardianCannotVote() public {
        (, NaveGovernor g,) = _createDao(0);
        vm.prank(g1);
        uint64 idx = g.createProposal(_proposalParams(uint8(ProposalType.General), address(0), ""));
        vm.prank(makeAddr("rando"));
        vm.expectRevert(NaveErrors.GuardianRequired.selector);
        g.castVoteWallet(idx, uint8(VoteChoice.For));
    }

    function test_walletGov_doubleVoteReverts() public {
        (, NaveGovernor g,) = _createDao(0);
        vm.prank(g1);
        uint64 idx = g.createProposal(_proposalParams(uint8(ProposalType.General), address(0), ""));
        vm.prank(g1);
        g.castVoteWallet(idx, uint8(VoteChoice.For));
        vm.prank(g1);
        vm.expectRevert(NaveErrors.AlreadyVoted.selector);
        g.castVoteWallet(idx, uint8(VoteChoice.For));
    }

    function test_tokenGov_wrongModeForWalletVote() public {
        (, NaveGovernor g,) = _tokenDao();
        vm.prank(g1);
        vm.expectRevert(NaveErrors.WrongGovernanceMode.selector);
        g.castVoteWallet(0, uint8(VoteChoice.For));
    }

    function test_cancelProposal_onlyProposer() public {
        (, NaveGovernor g,) = _createDao(0);
        vm.prank(g1);
        uint64 idx = g.createProposal(_proposalParams(uint8(ProposalType.General), address(0), ""));
        vm.prank(g2);
        vm.expectRevert(NaveErrors.Unauthorized.selector);
        g.cancelProposal(idx);
        vm.prank(g1);
        g.cancelProposal(idx);
        (, uint8 status,,,) = g.proposalCore(idx);
        assertEq(status, uint8(ProposalStatus.Cancelled));
    }

    // ── Token governance: escrow voting + per-type quorum dispatch ─────────
    function _tokenDao() internal returns (NaveTreasury t, NaveGovernor g, address mint) {
        (t, g,) = _createDao(1); // token governance
        vm.prank(founder);
        mint = t.registerDaoToken("Gov", "GOV", 18, 1000e18, address(this));
    }

    function _voteWith(NaveGovernor g, address mint, uint64 idx, uint256 amount, uint8 choice)
        internal
    {
        IERC20(mint).approve(address(g), amount);
        g.lockTokensAndVote(idx, amount, choice);
    }

    function test_tokenGov_rejectsOtherRegisteredMint() public {
        (NaveTreasury t, NaveGovernor g, address mint) = _tokenDao();
        vm.prank(founder);
        address other = t.registerDaoToken("Other", "OTH", 18, 1e18, address(this));
        vm.expectRevert(NaveErrors.VotingMintMismatch.selector);
        g.createProposal(_proposalParams(uint8(ProposalType.Transfer), other, ""));
        mint;
    }

    function test_tokenGov_majorityCannotFinalizeBeforeVotingEnd() public {
        (, NaveGovernor g, address mint) = _tokenDao();
        uint64 idx = g.createProposal(_proposalParams(uint8(ProposalType.Transfer), mint, ""));
        _voteWith(g, mint, idx, 600e18, uint8(VoteChoice.For));
        vm.expectRevert(NaveErrors.VotingPeriodNotEnded.selector);
        g.finalizeProposal(idx);
    }

    function test_tokenGov_transferExecutesOnlyAfterVotingEnd() public {
        (NaveTreasury t, NaveGovernor g, address mint) = _tokenDao();
        vm.prank(founder);
        t.registerAsset(address(usdc), bytes32(0), true, 0);
        usdc.mint(address(this), 100e6);
        usdc.approve(address(t), 100e6);
        t.deposit(address(usdc), 100e6);
        address to = makeAddr("payee");
        uint256 amount = 40e6;
        uint64 idx = g.createProposal(
            _proposalParams(uint8(ProposalType.Transfer), mint, abi.encode(address(usdc), to, amount))
        );
        _voteWith(g, mint, idx, 600e18, uint8(VoteChoice.For));
        vm.expectRevert(NaveErrors.VotingPeriodNotEnded.selector);
        g.finalizeProposal(idx);
        vm.warp(block.timestamp + 2 days);
        g.finalizeProposal(idx);
        g.executeTransferProposal(idx, address(usdc), to, amount);
        assertEq(usdc.balanceOf(to), amount);
    }

    function test_tokenGov_general_passesOnMajorityAndQuorum() public {
        (, NaveGovernor g, address mint) = _tokenDao();
        uint64 idx = g.createProposal(_proposalParams(uint8(ProposalType.General), mint, ""));
        // quorum for General = dao quorum 10% of 1000e18 = 100e18.
        _voteWith(g, mint, idx, 200e18, uint8(VoteChoice.For));
        vm.warp(block.timestamp + 2 days);
        g.finalizeProposal(idx);
        (, uint8 status,,,) = g.proposalCore(idx);
        assertEq(status, uint8(ProposalStatus.Passed));
    }

    function test_tokenGov_tokenMintQuorum25pct() public {
        (, NaveGovernor g, address mint) = _tokenDao();
        // TokenMint requires 25% = 250e18 participation.
        uint64 idxFail = g.createProposal(_proposalParams(uint8(ProposalType.TokenMint), mint, ""));
        _voteWith(g, mint, idxFail, 200e18, uint8(VoteChoice.For)); // < 250e18
        vm.warp(block.timestamp + 2 days);
        // Missed quorum after votingEnd resolves to a terminal Failed status
        // (no longer reverts QuorumNotMet and strands the proposal Active).
        g.finalizeProposal(idxFail);
        (, uint8 status,,,) = g.proposalCore(idxFail);
        assertEq(status, uint8(ProposalStatus.Failed));
    }

    // ── Hardening: missed quorum → Failed, escrow releasable ──────────────
    /// Pre-fix `finalizeProposal` reverted `QuorumNotMet` after `votingEnd`, so
    /// the proposal stayed `Active` forever and `releaseVoteEscrow` (which
    /// requires a terminal status) could never return the voters' tokens
    /// unless the proposer happened to cancel.
    function test_finalize_missedQuorum_failsAndReleasesEscrow() public {
        (, NaveGovernor g, address mint) = _tokenDao();
        uint64 idx = g.createProposal(_proposalParams(uint8(ProposalType.TokenMint), mint, ""));
        uint256 balBefore = IERC20(mint).balanceOf(address(this));
        uint256 lock = 200e18; // < 25% quorum (250e18)
        _voteWith(g, mint, idx, lock, uint8(VoteChoice.For));
        assertEq(IERC20(mint).balanceOf(address(this)), balBefore - lock);

        // Escrow is locked while Active; cannot finalize early (quorum unmet).
        vm.expectRevert(NaveErrors.EscrowStillLocked.selector);
        g.releaseVoteEscrow(idx);
        vm.expectRevert(NaveErrors.VotingPeriodNotEnded.selector);
        g.finalizeProposal(idx);

        vm.warp(block.timestamp + 2 days);
        g.finalizeProposal(idx);
        NaveGovernor.Proposal memory p = g.getProposal(idx);
        assertEq(p.status, uint8(ProposalStatus.Failed), "terminal Failed");
        assertGt(p.finalizedAt, 0);

        // Escrow now releasable.
        g.releaseVoteEscrow(idx);
        assertEq(IERC20(mint).balanceOf(address(this)), balBefore, "tokens returned");

        // Terminal: cannot finalize again or vote.
        vm.expectRevert(NaveErrors.ProposalNotActive.selector);
        g.finalizeProposal(idx);
        // A Failed proposal cannot be consumed by any execution path.
        vm.expectRevert(NaveErrors.ProposalNotPassed.selector);
        g.mintAdditionalTokens(idx, mint, address(this), 1e18);
    }

    /// Wallet-governance variant: SwitchVotingSystem needs 70% of 3 guardians
    /// (ceil(2.1) == 3); a single vote misses quorum → Failed, not a revert.
    function test_finalize_missedQuorum_walletGov_failsNotReverts() public {
        (, NaveGovernor g,) = _createDao(0);
        vm.prank(g1);
        uint64 idx = g.createProposal(
            _proposalParams(uint8(ProposalType.SwitchVotingSystem), address(0), "")
        );
        vm.prank(g1);
        g.castVoteWallet(idx, uint8(VoteChoice.For));
        vm.warp(block.timestamp + 2 days);
        g.finalizeProposal(idx);
        (, uint8 status,,,) = g.proposalCore(idx);
        assertEq(status, uint8(ProposalStatus.Failed));
    }

    /// Early finalization semantics are unchanged: before `votingEnd` a
    /// proposal without a mathematically certain outcome still reverts
    /// `VotingPeriodNotEnded` (never silently fails early).
    function test_finalize_beforeVotingEnd_stillRequiresCertainOutcome() public {
        (, NaveGovernor g,) = _createDao(0);
        vm.prank(g1);
        uint64 idx = g.createProposal(_proposalParams(uint8(ProposalType.General), address(0), ""));
        vm.prank(g1);
        g.castVoteWallet(idx, uint8(VoteChoice.For)); // 1 of 3: lead 1, remaining 2
        vm.expectRevert(NaveErrors.VotingPeriodNotEnded.selector);
        g.finalizeProposal(idx);
        (, uint8 status,,,) = g.proposalCore(idx);
        assertEq(status, uint8(ProposalStatus.Active));
    }

    // ── Hardening: markExecuted requires a Passed, finalized proposal ─────
    function test_markExecuted_requiresPassedProposal() public {
        (, NaveGovernor g, NaveExecution e) = _createDao(0);
        vm.prank(g1);
        uint64 idx = g.createProposal(_proposalParams(uint8(ProposalType.General), address(0), ""));

        // Active → refused.
        vm.prank(address(e));
        vm.expectRevert(NaveErrors.ProposalNotPassed.selector);
        g.markExecuted(idx);

        // Cancelled → refused.
        vm.prank(g1);
        g.cancelProposal(idx);
        vm.prank(address(e));
        vm.expectRevert(NaveErrors.ProposalNotPassed.selector);
        g.markExecuted(idx);

        // Passed → consumed exactly once.
        vm.prank(g1);
        uint64 idx2 = g.createProposal(_proposalParams(uint8(ProposalType.General), address(0), ""));
        vm.prank(g1);
        g.castVoteWallet(idx2, uint8(VoteChoice.For));
        vm.prank(g2);
        g.castVoteWallet(idx2, uint8(VoteChoice.For));
        g.finalizeProposal(idx2);
        vm.prank(address(e));
        g.markExecuted(idx2);
        (, uint8 status,,,) = g.proposalCore(idx2);
        assertEq(status, uint8(ProposalStatus.Executed));
        vm.prank(address(e));
        vm.expectRevert(NaveErrors.ProposalNotPassed.selector);
        g.markExecuted(idx2);
    }

    // ── Hardening: UPGRADE_TO_LATEST sentinel removed ─────────────────────
    /// The sentinel payload no longer has an execution handler; a proposal
    /// carrying it can never be executed (the only upgrade path binds explicit
    /// implementation addresses).
    function test_upgradeToLatestSentinel_hasNoExecutionPath() public {
        (, NaveGovernor g,) = _createDao(0);
        bytes memory payload = abi.encode("UPGRADE_TO_LATEST");
        vm.prank(g1);
        uint64 idx = g.createProposal(
            _proposalParams(uint8(ProposalType.ContractUpgrade), address(0), payload)
        );
        vm.prank(g1);
        g.castVoteWallet(idx, uint8(VoteChoice.For));
        vm.prank(g2);
        g.castVoteWallet(idx, uint8(VoteChoice.For));
        vm.prank(g3);
        g.castVoteWallet(idx, uint8(VoteChoice.For));
        g.finalizeProposal(idx);

        // Removed function: the selector no longer exists on the governor.
        (bool ok,) = address(g).call(
            abi.encodeWithSignature("executeContractUpgradeToLatest(uint64)", idx)
        );
        assertFalse(ok, "executeContractUpgradeToLatest must be removed");

        // Explicit path refuses the sentinel hash even with the current latest impls.
        (address tI, address gI, address eI) = protocol.latestImplementations();
        vm.expectRevert(NaveErrors.PayloadHashMismatch.selector);
        g.executeContractUpgrade(idx, tI, gI, eI);
        (, uint8 status,,,) = g.proposalCore(idx);
        assertEq(status, uint8(ProposalStatus.Passed), "never consumed");
    }

    function test_tokenGov_switchVotingQuorum70pct() public {
        (, NaveGovernor g, address mint) = _tokenDao();
        uint64 idx =
            g.createProposal(_proposalParams(uint8(ProposalType.SwitchVotingSystem), mint, ""));
        // 70% of 1000e18 = 700e18 required.
        _voteWith(g, mint, idx, 800e18, uint8(VoteChoice.For));
        vm.warp(block.timestamp + 2 days);
        g.finalizeProposal(idx);
        (, uint8 status,,,) = g.proposalCore(idx);
        assertEq(status, uint8(ProposalStatus.Passed));
    }

    // ── EVM-M3: executeSwitchVotingSystem actually switches the treasury ────
    /// A passed SwitchVotingSystem proposal (Token -> Wallet) now takes effect:
    /// pre-fix NaveTreasury.switchVotingSystem had no call site, so the escape
    /// hatch was dead code.
    function test_EVMM3_executeSwitchVotingSystem_switchesToWallet() public {
        (NaveTreasury t, NaveGovernor g, address mint) = _tokenDao();
        assertEq(t.governanceType(), uint8(GovernanceType.Token), "starts token-gov");

        bytes memory payload = abi.encode(uint8(GovernanceType.Wallet), address(0));
        uint64 idx = g.createProposal(
            _proposalParams(uint8(ProposalType.SwitchVotingSystem), mint, payload)
        );
        _voteWith(g, mint, idx, 800e18, uint8(VoteChoice.For)); // > 70%
        vm.warp(block.timestamp + 2 days);
        g.finalizeProposal(idx);

        g.executeSwitchVotingSystem(idx, uint8(GovernanceType.Wallet), address(0));

        assertEq(t.governanceType(), uint8(GovernanceType.Wallet), "switched to wallet-gov");
        assertEq(t.votingToken(), address(0), "voting token cleared");
        (, uint8 status,,,) = g.proposalCore(idx);
        assertEq(status, uint8(ProposalStatus.Executed), "proposal consumed");

        // Replay blocked.
        vm.expectRevert(NaveErrors.ProposalNotPassed.selector);
        g.executeSwitchVotingSystem(idx, uint8(GovernanceType.Wallet), address(0));
    }

    /// The executed switch must match the approved payload hash exactly.
    function test_EVMM3_executeSwitchVotingSystem_payloadBinding() public {
        (, NaveGovernor g, address mint) = _tokenDao();
        bytes memory payload = abi.encode(uint8(GovernanceType.Wallet), address(0));
        uint64 idx = g.createProposal(
            _proposalParams(uint8(ProposalType.SwitchVotingSystem), mint, payload)
        );
        _voteWith(g, mint, idx, 800e18, uint8(VoteChoice.For));
        vm.warp(block.timestamp + 2 days);
        g.finalizeProposal(idx);

        // Wrong params (switch to Token with an arbitrary token) don't match the hash.
        vm.expectRevert(NaveErrors.PayloadHashMismatch.selector);
        g.executeSwitchVotingSystem(idx, uint8(GovernanceType.Token), mint);
    }

    /// Switching TO token-gov requires a registered voting token so the DAO
    /// cannot strand itself with no way to vote.
    function test_EVMM3_switchToToken_requiresRegisteredToken() public {
        // Wallet-gov DAO switching to token-gov with an UNregistered token.
        (NaveTreasury t, NaveGovernor g,) = _createDao(0);
        address bogus = makeAddr("unregisteredToken");
        bytes memory payload = abi.encode(uint8(GovernanceType.Token), bogus);
        vm.prank(g1);
        uint64 idx = g.createProposal(
            _proposalParams(uint8(ProposalType.SwitchVotingSystem), address(0), payload)
        );
        vm.prank(g1);
        g.castVoteWallet(idx, uint8(VoteChoice.For));
        vm.prank(g2);
        g.castVoteWallet(idx, uint8(VoteChoice.For));
        vm.prank(g3);
        g.castVoteWallet(idx, uint8(VoteChoice.For));
        vm.warp(block.timestamp + 2 days);
        g.finalizeProposal(idx);

        vm.expectRevert(NaveErrors.TokenMintNotRegistered.selector);
        g.executeSwitchVotingSystem(idx, uint8(GovernanceType.Token), bogus);
        t;
    }

    /// Existing ERC-20 registered at creation time (CreateDAO existing-token path).
    function test_registerExternalDaoToken_enablesTokenProposals() public {
        (NaveTreasury t, NaveGovernor g,) = _createDao(1);
        MockERC20 ext = new MockERC20("External", "EXT", 18);
        ext.mint(address(this), 1000e18);

        vm.prank(founder);
        t.registerExternalDaoToken(address(ext), "External", "EXT", 18);

        assertTrue(t.isTokenRegistered(address(ext)));
        assertEq(t.votingToken(), address(ext));

        vm.prank(g1);
        uint64 idx = g.createProposal(_proposalParams(uint8(ProposalType.General), address(ext), ""));
        _voteWith(g, address(ext), idx, 200e18, uint8(VoteChoice.For));
        vm.warp(block.timestamp + 2 days);
        g.finalizeProposal(idx);
        (, uint8 status,,,) = g.proposalCore(idx);
        assertEq(status, uint8(ProposalStatus.Passed));
    }

    function test_tokenGov_escrowReleaseAfterFinalize() public {
        (, NaveGovernor g, address mint) = _tokenDao();
        uint64 idx = g.createProposal(_proposalParams(uint8(ProposalType.General), mint, ""));
        uint256 balBefore = IERC20(mint).balanceOf(address(this));
        _voteWith(g, mint, idx, 200e18, uint8(VoteChoice.For));
        assertEq(IERC20(mint).balanceOf(address(this)), balBefore - 200e18);
        vm.warp(block.timestamp + 2 days);
        g.finalizeProposal(idx);
        g.releaseVoteEscrow(idx);
        assertEq(IERC20(mint).balanceOf(address(this)), balBefore);
    }

    // ── H-1: additional minting requires a PASSED TokenMint proposal ──────
    /// Drive a TokenMint proposal binding (mint, dest, amount) to a Pass.
    function _passTokenMint(NaveGovernor g, address mint, address dest, uint256 amount)
        internal
        returns (uint64 idx)
    {
        bytes memory payload = abi.encode(mint, dest, amount);
        idx = g.createProposal(_proposalParams(uint8(ProposalType.TokenMint), mint, payload));
        // TokenMint quorum = 25% of 1000e18 snapshot = 250e18.
        _voteWith(g, mint, idx, 300e18, uint8(VoteChoice.For));
        vm.warp(block.timestamp + 2 days);
        g.finalizeProposal(idx);
        (, uint8 status,,,) = g.proposalCore(idx);
        assertEq(status, uint8(ProposalStatus.Passed), "token-mint proposal passed");
    }

    function test_mintAdditional_requiresPassedTokenMintProposal() public {
        (NaveTreasury t, NaveGovernor g, address mint) = _tokenDao();
        address dest = makeAddr("dest");
        uint64 idx = _passTokenMint(g, mint, dest, 50e18);

        // Even the founder cannot mint without binding the passed proposal.
        vm.prank(founder);
        g.mintAdditionalTokens(idx, mint, dest, 50e18);
        assertEq(IERC20(mint).balanceOf(dest), 50e18);
        t;
    }

    function test_mintAdditional_rejectsUnboundAmount() public {
        (, NaveGovernor g, address mint) = _tokenDao();
        address dest = makeAddr("dest");
        uint64 idx = _passTokenMint(g, mint, dest, 50e18);
        // Same proposal, different amount than the one governance approved.
        vm.expectRevert(NaveErrors.PayloadHashMismatch.selector);
        g.mintAdditionalTokens(idx, mint, dest, 51e18);
    }

    function test_mintAdditional_rejectsNonPassedProposal() public {
        (, NaveGovernor g, address mint) = _tokenDao();
        address dest = makeAddr("dest");
        bytes memory payload = abi.encode(mint, dest, uint256(50e18));
        // Created but never voted/finalized -> still Active.
        uint64 idx = g.createProposal(_proposalParams(uint8(ProposalType.TokenMint), mint, payload));
        vm.prank(founder);
        vm.expectRevert(NaveErrors.ProposalNotPassed.selector);
        g.mintAdditionalTokens(idx, mint, dest, 50e18);
    }

    function test_mintAdditional_rejectsWrongProposalType() public {
        (, NaveGovernor g, address mint) = _tokenDao();
        address dest = makeAddr("dest");
        bytes memory payload = abi.encode(mint, dest, uint256(50e18));
        uint64 idx = g.createProposal(_proposalParams(uint8(ProposalType.General), mint, payload));
        _voteWith(g, mint, idx, 300e18, uint8(VoteChoice.For));
        vm.warp(block.timestamp + 2 days);
        g.finalizeProposal(idx);
        vm.expectRevert(NaveErrors.InvalidProposalType.selector);
        g.mintAdditionalTokens(idx, mint, dest, 50e18);
    }

    function test_mintAdditional_cannotReplaySameProposal() public {
        (, NaveGovernor g, address mint) = _tokenDao();
        address dest = makeAddr("dest");
        uint64 idx = _passTokenMint(g, mint, dest, 50e18);
        g.mintAdditionalTokens(idx, mint, dest, 50e18);
        assertEq(IERC20(mint).balanceOf(dest), 50e18);
        // The proposal is consumed (Executed); a second mint must revert.
        vm.expectRevert(NaveErrors.ProposalNotPassed.selector);
        g.mintAdditionalTokens(idx, mint, dest, 50e18);
    }

    function test_transferProposalType_allowedOnEvm() public {
        // Solana rejects Transfer (8) at creation; the EVM port allows it.
        (, NaveGovernor g, address mint) = _tokenDao();
        bytes memory payload = abi.encode(address(usdc), makeAddr("to"), uint256(1e6));
        uint64 idx = g.createProposal(_proposalParams(uint8(ProposalType.Transfer), mint, payload));
        (uint8 ptype,,,,) = g.proposalCore(idx);
        assertEq(ptype, uint8(ProposalType.Transfer));
    }

    function test_permissionProposal_updatesGuardians() public {
        (NaveTreasury t, NaveGovernor g,) = _createDao(0);
        address g4 = makeAddr("g4");
        address[] memory newSet = new address[](3);
        newSet[0] = g1;
        newSet[1] = g2;
        newSet[2] = g4;
        uint8 newThreshold = 2;
        bytes memory payload = abi.encode(newSet, newThreshold);

        vm.prank(g1);
        uint64 idx =
            g.createProposal(_proposalParams(uint8(ProposalType.Permission), address(0), payload));
        vm.prank(g1);
        g.castVoteWallet(idx, uint8(VoteChoice.For));
        vm.prank(g2);
        g.castVoteWallet(idx, uint8(VoteChoice.For));
        g.finalizeProposal(idx);

        g.executePermissionProposal(idx, newSet, newThreshold);
        assertTrue(t.guardiansBootstrapped());
        assertTrue(t.isGuardian(g4));
        assertFalse(t.isGuardian(g3));
        assertEq(t.guardianThreshold(), newThreshold);
        (address[] memory wallets, uint8 th) = t.getGuardians();
        assertEq(wallets.length, 3);
        assertEq(th, newThreshold);
    }

    function test_founderGuardianBootstrap_oneShot() public {
        (NaveTreasury t,,) = _createDao(0);
        address[] memory wallets = new address[](2);
        wallets[0] = g1;
        wallets[1] = g2;
        vm.prank(founder);
        t.updateGuardianConfig(wallets, 2);
        assertTrue(t.guardiansBootstrapped());
        vm.prank(founder);
        vm.expectRevert(NaveErrors.GuardiansAlreadyBootstrapped.selector);
        t.updateGuardianConfig(wallets, 2);
    }
}
