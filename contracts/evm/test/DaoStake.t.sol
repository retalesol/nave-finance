// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {NaveBase} from "./NaveBase.t.sol";
import {NaveDaoStake} from "../src/NaveDaoStake.sol";
import {NaveTreasury} from "../src/NaveTreasury.sol";
import {NaveGovernor} from "../src/NaveGovernor.sol";
import {NaveExecution} from "../src/NaveExecution.sol";
import {NaveErrors} from "../src/libraries/NaveErrors.sol";
import {
    ProposalType,
    ProposalStatus,
    VoteChoice,
    MoonlightStatus,
    GuardianActionType
} from "../src/libraries/NaveEnums.sol";
import {NaveConstants} from "../src/libraries/NaveConstants.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/// @notice Moonlight lifecycle tests. Creation is fee-free and does not lock
/// NAVE. A treasury that already has a lock still releases it on moonlight.
/// Reopening does not demand a new lock.
contract DaoStakeTest is NaveBase {
    NaveDaoStake internal stakeModule;
    MockERC20 internal nave; // wrapped NAVE (18 decimals)

    // Devnet fixed price ($10) ⇒ $99 stake = 9.9 NAVE.
    uint256 internal constant STAKE_AMOUNT = 9.9 ether;
    address internal recipient = makeAddr("moonlightRecipient");

    function setUp() public override {
        super.setUp();
        nave = new MockERC20("Wrapped NAVE", "wNAVE", 18);
        NaveDaoStake stakeImpl = new NaveDaoStake();
        stakeModule = NaveDaoStake(
            address(
                new ERC1967Proxy(
                    address(stakeImpl),
                    abi.encodeCall(NaveDaoStake.initialize, (owner, address(protocol)))
                )
            )
        );
        vm.startPrank(owner);
        protocol.setDaoStake(address(stakeModule));
        protocol.setNaveStakeConfig(address(nave), STAKE_AMOUNT);
        vm.stopPrank();
    }

    /// Create, then lock the way the factory used to, so moonlight can still
    /// release a pre-upgrade stake. `createDao` itself does not lock.
    function _createStaked()
        internal
        returns (NaveTreasury treasury, NaveGovernor governor, NaveExecution execution)
    {
        (treasury, governor, execution) = _createDao(0);
        nave.mint(founder, STAKE_AMOUNT);
        vm.prank(founder);
        nave.approve(address(stakeModule), STAKE_AMOUNT);
        vm.prank(address(factory));
        stakeModule.lockStake(address(treasury), founder, address(nave), STAKE_AMOUNT, 0);
    }

    function test_createDao_isFeeFree_andDoesNotLockStake() public {
        assertEq(protocol.formationFee(), 0, "creation must be fee-free");
        assertGt(protocol.requiredNaveStake(), 0, "old config may still be non-zero");
        nave.mint(founder, STAKE_AMOUNT);
        vm.prank(founder);
        nave.approve(address(stakeModule), STAKE_AMOUNT);

        (NaveTreasury treasury,,) = _createDao(0);

        (address sFounder, address sToken, uint256 sAmount,,,) = _stakeHead(address(treasury));
        assertEq(sFounder, address(0));
        assertEq(sToken, address(0));
        assertEq(sAmount, 0);
        assertEq(nave.balanceOf(address(stakeModule)), 0, "factory did not pull NAVE");
        assertEq(nave.balanceOf(founder), STAKE_AMOUNT);
    }

    function _stakeHead(address treasury)
        internal
        view
        returns (
            address sFounder,
            address sToken,
            uint256 sAmount,
            bool sReleased,
            uint256 priceUsdMicro,
            uint8 sStatus
        )
    {
        (sFounder, sToken, sAmount, sReleased, priceUsdMicro, sStatus,,,,) =
            stakeModule.stakes(treasury);
    }

    function test_lockStake_onlyFactory() public {
        (NaveTreasury treasury,,) = _createStaked();
        vm.expectRevert(NaveErrors.Unauthorized.selector);
        stakeModule.lockStake(address(treasury), founder, address(nave), STAKE_AMOUNT, 0);
    }

    function test_moonlight_fullLifecycle_releasesStake_andRestores() public {
        (NaveTreasury treasury, NaveGovernor governor,) = _createStaked();

        // ── Phase: approved MoonlightRequest (type 9) ───────────────────────
        uint64 reqIdx = _passProposal(governor, uint8(ProposalType.MoonlightRequest), "");
        stakeModule.recordMoonlightRequest(address(treasury), address(governor), reqIdx);
        assertEq(stakeModule.moonlightStatus(address(treasury)), uint8(MoonlightStatus.Requested));
        assertTrue(stakeModule.isMoonlighting(address(treasury)));

        // ── Distribution wizard: proposal creator enters the recipient ──────
        vm.prank(founder); // founder was the proposer (initiatedBy)
        stakeModule.setMoonlightRecipient(address(treasury), recipient);
        assertEq(
            stakeModule.moonlightStatus(address(treasury)),
            uint8(MoonlightStatus.DistributionPending)
        );

        // ── Approved MoonlightDistribution (type 10) binding the recipient ──
        uint64 distIdx =
            _passProposal(governor, uint8(ProposalType.MoonlightDistribution), abi.encode(recipient));
        stakeModule.executeMoonlightDistribution(address(treasury), address(governor), distIdx);

        // Stake released to the recipient.
        assertEq(nave.balanceOf(recipient), STAKE_AMOUNT, "stake paid to recipient");
        assertEq(nave.balanceOf(address(stakeModule)), 0);
        assertEq(stakeModule.moonlightStatus(address(treasury)), uint8(MoonlightStatus.Distributing));

        // ── Final phase: moonlighted / hidden ──────────────────────────────
        vm.prank(founder);
        stakeModule.finalizeMoonlight(address(treasury));
        assertEq(stakeModule.moonlightStatus(address(treasury)), uint8(MoonlightStatus.Moonlighted));

        // ── Reopen: no new NAVE lock ────────────────────────────────────────
        vm.prank(founder);
        stakeModule.restoreDao(address(treasury), STAKE_AMOUNT, 0);
        assertEq(stakeModule.moonlightStatus(address(treasury)), uint8(MoonlightStatus.Active));
        assertFalse(stakeModule.isMoonlighting(address(treasury)));
        assertEq(nave.balanceOf(address(stakeModule)), 0, "restore does not lock NAVE");
    }

    function test_setMoonlightRecipient_onlyInitiator() public {
        (NaveTreasury treasury, NaveGovernor governor,) = _createStaked();
        uint64 reqIdx = _passProposal(governor, uint8(ProposalType.MoonlightRequest), "");
        stakeModule.recordMoonlightRequest(address(treasury), address(governor), reqIdx);
        vm.prank(recipient); // not the proposer
        vm.expectRevert(NaveErrors.Unauthorized.selector);
        stakeModule.setMoonlightRecipient(address(treasury), recipient);
    }

    function test_restoreDao_onlyFounder() public {
        (NaveTreasury treasury, NaveGovernor governor,) = _createStaked();
        uint64 reqIdx = _passProposal(governor, uint8(ProposalType.MoonlightRequest), "");
        stakeModule.recordMoonlightRequest(address(treasury), address(governor), reqIdx);
        vm.prank(founder);
        stakeModule.setMoonlightRecipient(address(treasury), recipient);
        uint64 distIdx =
            _passProposal(governor, uint8(ProposalType.MoonlightDistribution), abi.encode(recipient));
        stakeModule.executeMoonlightDistribution(address(treasury), address(governor), distIdx);
        vm.prank(founder);
        stakeModule.finalizeMoonlight(address(treasury));

        vm.prank(recipient);
        vm.expectRevert(NaveErrors.Unauthorized.selector);
        stakeModule.restoreDao(address(treasury), STAKE_AMOUNT, 0);
    }

    /// Critical invariant: moonlight unlock returns the EXACT token amount that
    /// was locked at creation — never a fresh `$99` recomputation at today's
    /// price. If `requiredNaveStake` rises or falls after lock, the recipient
    /// still receives the original escrowed base units (no pool imbalance).
    function test_moonlight_releasesExactLockedAmount_notCurrentRequiredStake() public {
        (NaveTreasury treasury, NaveGovernor governor,) = _createStaked();
        uint256 lockedAtCreate = STAKE_AMOUNT;
        assertEq(nave.balanceOf(address(stakeModule)), lockedAtCreate);

        // Simulate NAVE price drop: $99 now requires MORE tokens than at lock.
        uint256 newRequired = 20 ether;
        vm.prank(owner);
        protocol.setNaveStakeConfig(address(nave), newRequired);
        assertEq(protocol.requiredNaveStake(), newRequired);
        assertTrue(newRequired != lockedAtCreate, "price drift must change required stake");

        uint64 reqIdx = _passProposal(governor, uint8(ProposalType.MoonlightRequest), "");
        stakeModule.recordMoonlightRequest(address(treasury), address(governor), reqIdx);
        vm.prank(founder);
        stakeModule.setMoonlightRecipient(address(treasury), recipient);
        uint64 distIdx =
            _passProposal(governor, uint8(ProposalType.MoonlightDistribution), abi.encode(recipient));
        stakeModule.executeMoonlightDistribution(address(treasury), address(governor), distIdx);

        assertEq(nave.balanceOf(recipient), lockedAtCreate, "must unlock exact locked tokens");
        assertTrue(nave.balanceOf(recipient) != newRequired, "must not pay current $99 amount");
        assertEq(nave.balanceOf(address(stakeModule)), 0);

        vm.prank(founder);
        stakeModule.finalizeMoonlight(address(treasury));

        // Reopen does not demand the new required stake, or any stake.
        vm.prank(founder);
        stakeModule.restoreDao(address(treasury), 0, 0);
        assertEq(nave.balanceOf(address(stakeModule)), 0, "restore does not pull a new stake");
        assertEq(nave.balanceOf(recipient), lockedAtCreate, "released amount stays with recipient");
        assertEq(stakeModule.moonlightStatus(address(treasury)), uint8(MoonlightStatus.Active));
    }

    // ── P6-3: moonlight proposals are consumed (no cross-cycle replay) ────
    /// A single Passed MoonlightRequest could previously re-trigger a moonlight
    /// cycle after `restoreDao` forever. It is now consumed (Passed → Executed)
    /// on first use, mirroring Solana `mark_moonlight_proposal_executed`.
    function test_moonlightRequest_consumed_cannotReplayAfterRestore() public {
        (NaveTreasury treasury, NaveGovernor governor,) = _createStaked();
        uint64 reqIdx = _passProposal(governor, uint8(ProposalType.MoonlightRequest), "");

        vm.expectEmit(true, false, false, true, address(governor));
        emit NaveGovernor.MoonlightProposalConsumed(reqIdx, uint8(ProposalType.MoonlightRequest));
        stakeModule.recordMoonlightRequest(address(treasury), address(governor), reqIdx);
        assertEq(uint8(governor.getProposal(reqIdx).status), uint8(ProposalStatus.Executed));

        // Complete the cycle and reopen the DAO.
        vm.prank(founder);
        stakeModule.setMoonlightRecipient(address(treasury), recipient);
        uint64 distIdx =
            _passProposal(governor, uint8(ProposalType.MoonlightDistribution), abi.encode(recipient));
        stakeModule.executeMoonlightDistribution(address(treasury), address(governor), distIdx);
        assertEq(uint8(governor.getProposal(distIdx).status), uint8(ProposalStatus.Executed));
        vm.prank(founder);
        stakeModule.finalizeMoonlight(address(treasury));
        vm.prank(founder);
        stakeModule.restoreDao(address(treasury), 0, 0);
        assertEq(stakeModule.moonlightStatus(address(treasury)), uint8(MoonlightStatus.Active));

        // Replay of the old request approval is rejected.
        vm.expectRevert(NaveErrors.MoonlightProposalInvalid.selector);
        stakeModule.recordMoonlightRequest(address(treasury), address(governor), reqIdx);
        assertEq(stakeModule.moonlightStatus(address(treasury)), uint8(MoonlightStatus.Active));

        // A fresh approval is required for a second cycle.
        uint64 reqIdx2 = _passProposal(governor, uint8(ProposalType.MoonlightRequest), "");
        stakeModule.recordMoonlightRequest(address(treasury), address(governor), reqIdx2);
        assertEq(stakeModule.moonlightStatus(address(treasury)), uint8(MoonlightStatus.Requested));

        // ...and the old distribution approval cannot be reused either.
        vm.prank(founder);
        stakeModule.setMoonlightRecipient(address(treasury), recipient);
        vm.expectRevert(NaveErrors.MoonlightProposalInvalid.selector);
        stakeModule.executeMoonlightDistribution(address(treasury), address(governor), distIdx);
        assertEq(nave.balanceOf(address(stakeModule)), 0, "replay does not lock a new stake");
    }

    /// The distribution approval is consumed atomically with the stake release,
    /// so a second `executeMoonlightDistribution` with the same proposal reverts.
    function test_moonlightDistribution_consumed_secondCallReverts() public {
        (NaveTreasury treasury, NaveGovernor governor,) = _createStaked();
        uint64 reqIdx = _passProposal(governor, uint8(ProposalType.MoonlightRequest), "");
        stakeModule.recordMoonlightRequest(address(treasury), address(governor), reqIdx);
        vm.prank(founder);
        stakeModule.setMoonlightRecipient(address(treasury), recipient);
        uint64 distIdx =
            _passProposal(governor, uint8(ProposalType.MoonlightDistribution), abi.encode(recipient));
        stakeModule.executeMoonlightDistribution(address(treasury), address(governor), distIdx);
        assertEq(nave.balanceOf(recipient), STAKE_AMOUNT);

        vm.expectRevert(NaveErrors.MoonlightProposalInvalid.selector);
        stakeModule.executeMoonlightDistribution(address(treasury), address(governor), distIdx);
        assertEq(nave.balanceOf(recipient), STAKE_AMOUNT, "no double payout");
    }

    /// Solana `require_not_moonlighting` parity: the break-glass `executeDirect`
    /// path is refused while the DAO is moonlighting, even when the agents are
    /// disabled (the condition that would otherwise unlock it).
    function test_executeDirect_blockedWhileMoonlighting() public {
        (NaveTreasury treasury, NaveGovernor governor, NaveExecution execution) = _createStaked();
        uint64 reqIdx = _passProposal(governor, uint8(ProposalType.MoonlightRequest), "");
        stakeModule.recordMoonlightRequest(address(treasury), address(governor), reqIdx);
        assertTrue(stakeModule.isMoonlighting(address(treasury)));

        // Agents disabled by guardian quorum → direct path would normally open.
        uint64 d = _deadline();
        bytes[] memory sigs = _guardianSigs(
            treasury, GuardianActionType.DISABLE_AGENTS, 0, 0, address(0), 1, d
        );
        treasury.guardianAction(_gp(GuardianActionType.DISABLE_AGENTS, 0, 0, address(0), 1, d), sigs);
        assertFalse(treasury.agentsEnabled());

        vm.prank(exec);
        vm.expectRevert(NaveErrors.DaoMoonlighting.selector);
        execution.executeDirect(0, 1);
    }

    /// Only the protocol-registered DaoStake module may consume moonlight
    /// proposals, and only Passed moonlight-typed ones.
    function test_markMoonlightProposalExecuted_gated() public {
        (, NaveGovernor governor,) = _createStaked();
        uint64 reqIdx = _passProposal(governor, uint8(ProposalType.MoonlightRequest), "");

        vm.expectRevert(NaveErrors.Unauthorized.selector);
        governor.markMoonlightProposalExecuted(reqIdx);
        vm.prank(founder);
        vm.expectRevert(NaveErrors.Unauthorized.selector);
        governor.markMoonlightProposalExecuted(reqIdx);

        // Wrong type (General) is refused even from the stake module.
        uint64 genIdx = _passProposal(governor, uint8(ProposalType.General), "");
        vm.prank(address(stakeModule));
        vm.expectRevert(NaveErrors.InvalidProposalType.selector);
        governor.markMoonlightProposalExecuted(genIdx);

        // Stake module consumes once; second consumption refused.
        vm.prank(address(stakeModule));
        governor.markMoonlightProposalExecuted(reqIdx);
        assertEq(uint8(governor.getProposal(reqIdx).status), uint8(ProposalStatus.Executed));
        vm.prank(address(stakeModule));
        vm.expectRevert(NaveErrors.ProposalNotPassed.selector);
        governor.markMoonlightProposalExecuted(reqIdx);
    }

    /// A treasury that never locked NAVE can still moonlight and reopen.
    function test_moonlight_withoutStake_releasesNothing_andRestores() public {
        (NaveTreasury treasury, NaveGovernor governor,) = _createDao(0);
        assertEq(nave.balanceOf(address(stakeModule)), 0);

        uint64 reqIdx = _passProposal(governor, uint8(ProposalType.MoonlightRequest), "");
        stakeModule.recordMoonlightRequest(address(treasury), address(governor), reqIdx);
        vm.prank(founder);
        stakeModule.setMoonlightRecipient(address(treasury), recipient);
        uint64 distIdx =
            _passProposal(governor, uint8(ProposalType.MoonlightDistribution), abi.encode(recipient));
        stakeModule.executeMoonlightDistribution(address(treasury), address(governor), distIdx);

        assertEq(nave.balanceOf(recipient), 0, "nothing to release");
        assertEq(nave.balanceOf(address(stakeModule)), 0);
        assertEq(stakeModule.moonlightStatus(address(treasury)), uint8(MoonlightStatus.Distributing));

        vm.prank(founder);
        stakeModule.finalizeMoonlight(address(treasury));
        vm.prank(founder);
        stakeModule.restoreDao(address(treasury), 0, 0);
        assertEq(stakeModule.moonlightStatus(address(treasury)), uint8(MoonlightStatus.Active));
        assertFalse(stakeModule.isMoonlighting(address(treasury)));
        assertEq(nave.balanceOf(address(stakeModule)), 0);
    }

    // ── Helpers ───────────────────────────────────────────────────────────
    /// Create a wallet-governance proposal as `founder`, pass it with 2-of-3
    /// guardian FOR votes, and finalize after the voting period.
    function _passProposal(NaveGovernor governor, uint8 proposalType, bytes memory payload)
        internal
        returns (uint64 index)
    {
        NaveGovernor.CreateProposalParams memory p = NaveGovernor.CreateProposalParams({
            title: "Moonlight",
            description: "wind down",
            payload: payload,
            proposalType: proposalType,
            votingPeriodSeconds: NaveConstants.MIN_VOTING_PERIOD,
            votingMint: address(0)
        });
        vm.prank(founder);
        index = governor.createProposal(p);

        vm.prank(g1);
        governor.castVoteWallet(index, uint8(VoteChoice.For));
        vm.prank(g2);
        governor.castVoteWallet(index, uint8(VoteChoice.For));

        vm.warp(block.timestamp + NaveConstants.MIN_VOTING_PERIOD + 1);
        governor.finalizeProposal(index);
    }
}
