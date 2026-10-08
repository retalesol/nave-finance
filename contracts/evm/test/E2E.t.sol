// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {NaveBase} from "./NaveBase.t.sol";
import {NaveTreasury} from "../src/NaveTreasury.sol";
import {NaveGovernor} from "../src/NaveGovernor.sol";
import {NaveExecution} from "../src/NaveExecution.sol";
import {MockStrategyAdapter} from "./mocks/MockStrategyAdapter.sol";
import {PayloadHash} from "../src/libraries/PayloadHash.sol";
import {NaveConstants} from "../src/libraries/NaveConstants.sol";
import {
    ProposalType,
    ProposalStatus,
    VoteChoice,
    VoteMethod,
    ExecutionStatus
} from "../src/libraries/NaveEnums.sol";

/// @title E2E
/// @notice Single-flow end-to-end exercise of the full Nave EVM lifecycle,
/// matching the Part E app E2E checklist:
///   create DAO -> deposit -> proposal -> vote -> finalize -> execution pipeline
///   -> adapter deposit -> (yield) -> withdrawal + fee skim -> transfer proposal
///   -> management-fee collection, plus a token-governance vote path.
///
/// This is the runnable substitute for a live Sepolia / Base Sepolia E2E when
/// testnet RPC + funds are unavailable (it runs on Foundry's local EVM with the
/// MockPyth oracle + MockStrategyAdapter). The on-chain logic, payload-hash
/// binding, 4-agent approvals, review window, and fee math exercised here are
/// chain-agnostic and identical on Sepolia / Base Sepolia. See
/// docs (E2E_REPORT in the integration summary) for what additionally needs
/// live testnet credentials.
contract E2ETest is NaveBase {
    bytes32 internal constant RH = keccak256("reasoning");
    uint256 internal constant FUND = 1000e6;
    uint256 internal constant DEPLOY = 100e6;
    uint256 internal constant GAIN = 10e6;

    function test_e2e_walletGov_fullLifecycle() public {
        // 1. Create DAO (wallet governance) via the factory clones.
        (NaveTreasury t, NaveGovernor g, NaveExecution e) = _createDao(0);
        MockStrategyAdapter adapter = new MockStrategyAdapter(address(protocol));

        // 2. Register the stablecoin asset + deposit treasury capital.
        vm.prank(founder);
        t.registerAsset(address(usdc), bytes32(0), true, 0);
        address depositor = makeAddr("depositor");
        usdc.mint(depositor, FUND);
        vm.startPrank(depositor);
        usdc.approve(address(t), FUND);
        t.deposit(address(usdc), FUND);
        vm.stopPrank();
        assertEq(t.currentNav(), FUND, "nav credited at $1 for stablecoin deposit");

        // 3. Approve the adapter in the constitution + enable the agent pipeline.
        _approveAdapter(t, address(adapter));
        vm.prank(exec);
        t.toggleAgents(true);

        // 4. Strategy proposal -> wallet votes -> finalize (Passed).
        bytes memory payload = abi.encode(address(adapter), DEPLOY, address(usdc));
        vm.prank(g1);
        uint64 idx = g.createProposal(
            NaveGovernor.CreateProposalParams({
                title: "deploy-usdc",
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
        (, uint8 status,,,) = g.proposalCore(idx);
        assertEq(status, uint8(ProposalStatus.Passed), "strategy proposal passed");

        // 5. Execution pipeline: bind request -> 4-agent approvals -> execute.
        e.createStrategyRequest(idx, DEPLOY, address(adapter), address(usdc));
        bytes32 ph = PayloadHash.strategyHash(address(adapter), DEPLOY, address(usdc));
        vm.prank(exec);
        e.executiveApprove(idx, RH);
        vm.prank(fin);
        e.financialApprove(idx, ph, RH);
        vm.prank(over);
        e.oversightApprove(idx, ph, RH);

        vm.warp(block.timestamp + 1 days + 1); // clear review window
        _revalueTreasury(t); // fresh NAV (deploy hard-blocks on stale NAV)
        // Non-zero slippage floor: the 1:1 mock adapter returns `amount`, so a
        // minOut == amount join must clear without reverting (C-3/C-4 threading).
        vm.prank(exec);
        e.execute(idx, DEPLOY);
        assertEq(uint8(e.requestStatus(idx)), uint8(ExecutionStatus.Executed), "executed");
        assertEq(usdc.balanceOf(address(adapter)), DEPLOY, "capital deployed to adapter");

        // 6. Simulate yield, mark the position up, withdraw with the 8.5% skim.
        adapter.accrue(address(e), address(usdc), GAIN);
        vm.prank(founder);
        t.updateStrategyPositionValue(address(adapter), DEPLOY + GAIN);
        uint256 revBefore = usdc.balanceOf(revenueWallet);
        vm.prank(exec);
        // Non-zero minOut on the exit too (1:1 mock returns the full amount).
        e.withdrawFromStrategy(idx, DEPLOY + GAIN, DEPLOY + GAIN);
        // 8.5% of 10 USDC realized gain = 0.85 USDC.
        assertEq(usdc.balanceOf(revenueWallet) - revBefore, 850_000, "perf fee skimmed 8.5%");

        // 7. Transfer proposal (type 8) -> approvals -> execute disbursement.
        address grantee = makeAddr("grantee");
        uint256 grant = 50e6;
        bytes memory tpayload = abi.encode(address(usdc), grantee, grant);
        vm.prank(g1);
        uint64 tIdx = g.createProposal(
            NaveGovernor.CreateProposalParams({
                title: "grant",
                description: "",
                payload: tpayload,
                proposalType: uint8(ProposalType.Transfer),
                votingPeriodSeconds: 1 days,
                votingMint: address(0)
            })
        );
        vm.prank(g1);
        g.castVoteWallet(tIdx, uint8(VoteChoice.For));
        vm.prank(g2);
        g.castVoteWallet(tIdx, uint8(VoteChoice.For));
        g.finalizeProposal(tIdx);
        g.executeTransferProposal(tIdx, address(usdc), grantee, grant);
        assertEq(usdc.balanceOf(grantee), grant, "transfer proposal disbursed");
        (, uint8 tSt,,,) = g.proposalCore(tIdx);
        assertEq(tSt, uint8(ProposalStatus.Executed), "transfer proposal consumed");

        // 8. Token-mint governance (H-1): additional supply requires a PASSED
        //    TokenMint proposal (type 5, 25% quorum) whose payload binds exactly
        //    (mint, to, amount); the proposal is consumed on use.
        address rewardSeed = makeAddr("rewardSeed");
        vm.prank(founder);
        address daoToken = t.registerDaoToken("Reward", "RWD", 6, 1000e6, rewardSeed);
        address mintTo = makeAddr("mintRecipient");
        uint256 mintAmount = 250e6;
        bytes memory mpayload = abi.encode(daoToken, mintTo, mintAmount);
        vm.prank(g1);
        uint64 mIdx = g.createProposal(
            NaveGovernor.CreateProposalParams({
                title: "mint-rewards",
                description: "",
                payload: mpayload,
                proposalType: uint8(ProposalType.TokenMint),
                votingPeriodSeconds: 1 days,
                votingMint: address(0)
            })
        );
        vm.prank(g1);
        g.castVoteWallet(mIdx, uint8(VoteChoice.For));
        vm.prank(g2);
        g.castVoteWallet(mIdx, uint8(VoteChoice.For));
        g.finalizeProposal(mIdx); // early-finalize: 2 For > all remaining votes
        (, uint8 mStatus,,,) = g.proposalCore(mIdx);
        assertEq(mStatus, uint8(ProposalStatus.Passed), "token-mint proposal passed");

        uint256 mintBefore = IERC20(daoToken).balanceOf(mintTo);
        g.mintAdditionalTokens(mIdx, daoToken, mintTo, mintAmount);
        assertEq(
            IERC20(daoToken).balanceOf(mintTo) - mintBefore,
            mintAmount,
            "additional tokens minted via passed TokenMint proposal"
        );
        (, uint8 mStatusAfter,,,) = g.proposalCore(mIdx);
        assertEq(mStatusAfter, uint8(ProposalStatus.Executed), "token-mint proposal consumed");

        // 9. Management fee collection (0.65%/yr, in-kind to the revenue wallet).
        vm.warp(block.timestamp + 366 days);
        uint256 revBeforeMgmt = usdc.balanceOf(revenueWallet);
        t.collectManagementFee(address(usdc));
        assertGt(usdc.balanceOf(revenueWallet), revBeforeMgmt, "management fee collected");
    }

    /// Unified DAO creation flow: formation fee to protocol; user seed via surplus;
    /// founder bootstrap deploys immediately after ratification.
    function test_e2e_unifiedCreation_seedAndBootstrap() public {
        uint256 fee = NaveConstants.DEVNET_FORMATION_FEE_WEI;
        uint256 userSeed = 0.005 ether;
        vm.startPrank(owner);
        protocol.setFormationFee(fee);
        protocol.setTreasurySeed(0);
        vm.stopPrank();

        uint256 protoBefore = protocolTreasury.balance;
        vm.deal(founder, fee + userSeed);
        vm.prank(founder);
        (, address tAddr, address gAddr, address eAddr) =
            factory.createDao{value: fee + userSeed}(_daoParams(0));
        NaveTreasury t = NaveTreasury(payable(tAddr));
        NaveGovernor g = NaveGovernor(gAddr);
        NaveExecution e = NaveExecution(eAddr);

        assertEq(t.nativeSeeded(), userSeed, "user seed in treasury");
        assertEq(address(t).balance, 0, "raw ETH wrapped away");
        assertEq(weth.balanceOf(address(t)), userSeed, "seed custodied as WETH");
        assertEq(protocolTreasury.balance - protoBefore, fee, "formation fee to protocol");

        // Register + fund a stablecoin so a strategy can deploy.
        MockStrategyAdapter adapter = new MockStrategyAdapter(address(protocol));
        vm.prank(founder);
        t.registerAsset(address(usdc), bytes32(0), true, 0);
        address depositor = makeAddr("depositor");
        usdc.mint(depositor, FUND);
        vm.startPrank(depositor);
        usdc.approve(address(t), FUND);
        t.deposit(address(usdc), FUND);
        vm.stopPrank();
        _approveAdapter(t, address(adapter));
        vm.prank(exec);
        t.toggleAgents(true);

        // Strategy proposal -> vote -> finalize.
        bytes memory payload = abi.encode(address(adapter), DEPLOY, address(usdc));
        vm.prank(g1);
        uint64 idx = g.createProposal(
            NaveGovernor.CreateProposalParams({
                title: "bootstrap-deploy",
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

        // Founder uses the one-time bootstrap path: review window = 0.
        vm.prank(founder);
        e.createStrategyRequestBootstrap(idx, DEPLOY, address(adapter), address(usdc));
        assertTrue(e.bootstrapUsed(), "bootstrap consumed");

        bytes32 ph = PayloadHash.strategyHash(address(adapter), DEPLOY, address(usdc));
        vm.prank(exec);
        e.executiveApprove(idx, RH);
        vm.prank(fin);
        e.financialApprove(idx, ph, RH);
        vm.prank(over);
        e.oversightApprove(idx, ph, RH);

        // No time warp — the bootstrap action executes immediately.
        _revalueTreasury(t);
        vm.prank(exec);
        e.execute(idx, DEPLOY);
        assertEq(uint8(e.requestStatus(idx)), uint8(ExecutionStatus.Executed), "immediate deploy");
        assertEq(usdc.balanceOf(address(adapter)), DEPLOY, "capital deployed at creation");
    }

    function test_e2e_tokenGov_voteAndFinalize() public {
        // Token-governance DAO: register a DAO token, mint to a voter, then run
        // the escrow-voting path end to end (lock -> vote -> finalize -> release).
        (NaveTreasury t, NaveGovernor g,) = _createDao(1);

        address voter = makeAddr("tokenVoter");
        vm.prank(founder);
        address mint = t.registerDaoToken("Gov", "GOV", 6, 1000e6, voter);
        assertEq(t.votingToken(), mint, "first token becomes the voting token");

        // Register + deposit so a Transfer could later execute (governance focus
        // here is the vote/finalize path).
        vm.prank(founder);
        t.registerAsset(address(usdc), bytes32(0), true, 0);

        bytes memory payload = abi.encode(address(usdc), voter, uint256(10e6));
        vm.prank(voter);
        uint64 idx = g.createProposal(
            NaveGovernor.CreateProposalParams({
                title: "token-grant",
                description: "",
                payload: payload,
                proposalType: uint8(ProposalType.Transfer),
                votingPeriodSeconds: 1 days,
                votingMint: mint
            })
        );

        // Lock 200 GOV For. snapshotSupply = 1000 GOV; Transfer quorum = treasury
        // quorumBps (1000 = 10%) => required 100 GOV. 200 For clears quorum.
        uint256 lock = 200e6;
        vm.startPrank(voter);
        IERC20(mint).approve(address(g), lock);
        g.lockTokensAndVote(idx, lock, uint8(VoteChoice.For));
        vm.stopPrank();

        vm.warp(block.timestamp + 1 days + 1);
        g.finalizeProposal(idx);
        (, uint8 status,,,) = g.proposalCore(idx);
        assertEq(status, uint8(ProposalStatus.Passed), "token-gov proposal passed");

        // Release the escrow after the proposal concludes.
        uint256 balBefore = IERC20(mint).balanceOf(voter);
        vm.prank(voter);
        g.releaseVoteEscrow(idx);
        assertEq(IERC20(mint).balanceOf(voter) - balBefore, lock, "escrow returned");
    }

    function _approveAdapter(NaveTreasury t, address adapter) internal {
        _approveAdapterInConstitution(t, adapter);
    }
}
