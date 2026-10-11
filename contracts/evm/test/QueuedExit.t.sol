// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {NaveBase} from "./NaveBase.t.sol";
import {NaveTreasury} from "../src/NaveTreasury.sol";
import {NaveGovernor} from "../src/NaveGovernor.sol";
import {NaveExecution} from "../src/NaveExecution.sol";
import {EthenaSUSDeAdapter} from "../src/adapters/EthenaSUSDeAdapter.sol";
import {MockStakedUSDe} from "./mocks/MockStakedUSDe.sol";
import {NaveErrors} from "../src/libraries/NaveErrors.sol";
import {PayloadHash} from "../src/libraries/PayloadHash.sol";
import {ProposalType, VoteChoice} from "../src/libraries/NaveEnums.sol";

/// Two-step exits through NaveExecution for a cooldown venue.
contract QueuedExitTest is NaveBase {
    NaveTreasury internal t;
    NaveGovernor internal g;
    NaveExecution internal e;
    MockStakedUSDe internal vault;
    EthenaSUSDeAdapter internal adapter;

    uint256 internal constant FUND = 1000e6;
    uint256 internal constant DEPLOY = 100e6;
    uint256 internal constant DEAD = 1000;

    function setUp() public override {
        super.setUp();
        (t, g, e) = _createDao(0);
        vault = new MockStakedUSDe(address(usdc));
        adapter = new EthenaSUSDeAdapter(address(protocol), address(vault));

        vm.prank(founder);
        t.registerAsset(address(usdc), bytes32(0), true, 0);
        address user = makeAddr("depositor");
        usdc.mint(user, FUND);
        vm.startPrank(user);
        usdc.approve(address(t), FUND);
        t.deposit(address(usdc), FUND);
        vm.stopPrank();
        _approveAdapterInConstitution(t, address(adapter));
        vm.prank(exec);
        t.toggleAgents(true);
    }

    function _deploy() internal returns (uint64 idx) {
        vm.prank(g1);
        idx = g.createProposal(
            NaveGovernor.CreateProposalParams({
                title: "deploy",
                description: "",
                payload: abi.encode(address(adapter), DEPLOY, address(usdc)),
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
        e.createStrategyRequest(idx, DEPLOY, address(adapter), address(usdc));
        bytes32 ph = PayloadHash.strategyHash(address(adapter), DEPLOY, address(usdc));
        vm.prank(exec);
        e.executiveApprove(idx, keccak256("r"));
        vm.prank(fin);
        e.financialApprove(idx, ph, keccak256("r"));
        vm.prank(over);
        e.oversightApprove(idx, ph, keccak256("r"));
        vm.warp(block.timestamp + 1 days + 1);
        _revalueTreasury(t);
        vm.prank(exec);
        e.execute(idx, 1);
    }

    function test_directWithdrawRevertsUntilExitRequested() public {
        uint64 idx = _deploy();
        vm.prank(exec);
        vm.expectRevert(NaveErrors.ExitNotReady.selector);
        e.withdrawFromStrategy(idx, 10e6, 1);
    }

    function test_requestThenWithdrawAfterCooldown() public {
        uint64 idx = _deploy();
        uint256 amount = 50e6;
        vm.prank(exec);
        uint256 readyAt = e.requestStrategyExit(idx, amount);
        assertEq(readyAt, block.timestamp + 1 days);

        // Queued value still counts as the DAO's (illiquid) position.
        vm.prank(address(e));
        assertApproxEqAbs(adapter.positionValue(address(usdc)), DEPLOY - DEAD, 1);
        (, uint256 deployed,) = t.position(address(adapter));
        assertEq(deployed, DEPLOY);

        vm.prank(exec);
        vm.expectRevert(NaveErrors.ExitNotReady.selector);
        e.withdrawFromStrategy(idx, amount, 1);

        vm.warp(readyAt);
        uint256 before = usdc.balanceOf(address(t));
        vm.prank(exec);
        e.withdrawFromStrategy(idx, amount, amount);
        assertEq(usdc.balanceOf(address(t)) - before, amount);
        (, deployed,) = t.position(address(adapter));
        assertEq(deployed, DEPLOY - amount);
    }

    function test_oneExitAtATime() public {
        uint64 idx = _deploy();
        vm.prank(exec);
        e.requestStrategyExit(idx, 10e6);
        vm.prank(exec);
        vm.expectRevert(NaveErrors.ExitInProgress.selector);
        e.requestStrategyExit(idx, 10e6);
        // After the cooldown the finished exit settles and a new one can start.
        vm.warp(block.timestamp + 1 days);
        vm.prank(exec);
        e.requestStrategyExit(idx, 10e6);
        assertEq(adapter.claims(address(e)), 10e6);
    }

    function test_requestExit_onlyExecutive() public {
        uint64 idx = _deploy();
        vm.prank(oper);
        vm.expectRevert();
        e.requestStrategyExit(idx, 10e6);
    }

    function test_requestExit_cannotExceedPosition() public {
        uint64 idx = _deploy();
        vm.prank(exec);
        vm.expectRevert(NaveErrors.WithdrawExceedsDeployed.selector);
        e.requestStrategyExit(idx, DEPLOY + 1);
    }

    function test_adapterRejectsDirectCallers() public {
        vm.expectRevert(NaveErrors.Unauthorized.selector);
        adapter.requestExit(address(usdc), 1);
    }

    function test_zeroCooldownSettlesImmediately() public {
        uint64 idx = _deploy();
        vault.setCooldownDuration(0);
        vm.prank(exec);
        e.requestStrategyExit(idx, 20e6);
        vm.prank(exec);
        e.withdrawFromStrategy(idx, 20e6, 20e6);
        assertEq(adapter.claims(address(e)), 0);
    }

    function test_yieldAccruesAndIsWithdrawable() public {
        uint64 idx = _deploy();
        usdc.mint(address(this), 5e6);
        usdc.approve(address(vault), 5e6);
        vault.accrue(5e6);
        vm.prank(address(e));
        uint256 value = adapter.positionValue(address(usdc));
        assertGt(value, DEPLOY);
        vm.warp(block.timestamp + 5 days);
        vm.prank(founder);
        e.syncPositionValue(address(adapter));
        vm.prank(exec);
        e.requestStrategyExit(idx, value);
        vm.warp(block.timestamp + 1 days);
        vm.prank(exec);
        e.withdrawFromStrategy(idx, value, value);
        assertEq(usdc.balanceOf(address(adapter)), 0);
    }
}
