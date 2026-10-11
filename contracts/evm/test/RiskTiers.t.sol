// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {NaveBase} from "./NaveBase.t.sol";
import {NaveTreasury} from "../src/NaveTreasury.sol";
import {NaveGovernor} from "../src/NaveGovernor.sol";
import {NaveExecution} from "../src/NaveExecution.sol";
import {MockStrategyAdapter} from "./mocks/MockStrategyAdapter.sol";
import {NaveErrors} from "../src/libraries/NaveErrors.sol";
import {PayloadHash} from "../src/libraries/PayloadHash.sol";
import {ProposalType, VoteChoice} from "../src/libraries/NaveEnums.sol";

/// Venue risk tiers: protocol classification and constitution tier ceilings.
contract RiskTiersTest is NaveBase {
    NaveTreasury internal t;
    NaveGovernor internal g;
    NaveExecution internal e;
    MockStrategyAdapter internal tier1;
    MockStrategyAdapter internal tier3a;
    MockStrategyAdapter internal tier3b;

    function setUp() public override {
        super.setUp();
        (t, g, e) = _createDao(0);
        tier1 = new MockStrategyAdapter(address(protocol));
        tier3a = new MockStrategyAdapter(address(protocol));
        tier3b = new MockStrategyAdapter(address(protocol));
        vm.startPrank(owner);
        protocol.setAdapterRiskTier(address(tier3a), 3);
        protocol.setAdapterRiskTier(address(tier3b), 3);
        vm.stopPrank();
        _protocolApproveAdapter(address(tier1));
        _protocolApproveAdapter(address(tier3a));
        _protocolApproveAdapter(address(tier3b));
    }

    function _constitution(uint16 cap1, uint16 cap3a, uint16 cap3b) internal {
        address[] memory adapters = new address[](3);
        adapters[0] = address(tier1);
        adapters[1] = address(tier3a);
        adapters[2] = address(tier3b);
        uint16[] memory bps = new uint16[](3);
        bps[0] = cap1;
        bps[1] = cap3a;
        bps[2] = cap3b;
        bool[] memory approved = new bool[](3);
        approved[0] = approved[1] = approved[2] = true;
        string[] memory ids = new string[](3);
        ids[0] = "aave";
        ids[1] = "maple-syrup";
        ids[2] = "ethena-susde";
        vm.prank(founder);
        t.updateConstitution(adapters, bps, approved, ids, 70, 0);
    }

    function test_unsetTierReadsAsTierOne() public view {
        assertEq(protocol.riskTierOf(address(tier1)), 1);
        assertEq(protocol.riskTierOf(address(tier3a)), 3);
    }

    function test_setRiskTier_onlyOwnerAndValidRange() public {
        vm.expectRevert();
        protocol.setAdapterRiskTier(address(tier1), 2);
        vm.startPrank(owner);
        vm.expectRevert(NaveErrors.InvalidRiskTier.selector);
        protocol.setAdapterRiskTier(address(tier1), 0);
        vm.expectRevert(NaveErrors.InvalidRiskTier.selector);
        protocol.setAdapterRiskTier(address(tier1), 4);
        vm.stopPrank();
    }

    function test_approvedAdapterTierCanRiseButNotFall() public {
        vm.startPrank(owner);
        protocol.setAdapterRiskTier(address(tier1), 2);
        vm.expectRevert(NaveErrors.RiskTierLowerRequiresReapproval.selector);
        protocol.setAdapterRiskTier(address(tier3a), 1);
        // Revoke, reclassify, then the re-approval is delayed again.
        protocol.setAdapterApproved(address(tier3a), false);
        protocol.setAdapterRiskTier(address(tier3a), 1);
        vm.stopPrank();
        assertEq(protocol.riskTierOf(address(tier3a)), 1);
    }

    function test_tierThreeTotalWithinFifteenPercent() public {
        _constitution(10_000, 750, 750);
        assertEq(t.adapterMaxAllocationBps(address(tier3a)), 750);
    }

    function test_tierThreeTotalAboveFifteenPercentReverts() public {
        vm.expectRevert(NaveErrors.RiskTierCapExceeded.selector);
        _constitution(10_000, 1_000, 501);
    }

    function test_unapprovedEntriesDoNotCountTowardTierTotal() public {
        address[] memory adapters = new address[](2);
        adapters[0] = address(tier3a);
        adapters[1] = address(tier3b);
        uint16[] memory bps = new uint16[](2);
        bps[0] = 1_500;
        bps[1] = 5_000;
        bool[] memory approved = new bool[](2);
        approved[0] = true;
        string[] memory ids = new string[](2);
        ids[0] = "maple-syrup";
        ids[1] = "ethena-susde";
        vm.prank(founder);
        t.updateConstitution(adapters, bps, approved, ids, 70, 0);
    }

    /// A venue reclassified to Tier 3 after the constitution was written is
    /// held to the Tier 3 ceiling at execution time.
    function test_reclassifiedVenueClampedAtExecution() public {
        vm.prank(founder);
        t.registerAsset(address(usdc), bytes32(0), true, 0);
        address user = makeAddr("depositor");
        usdc.mint(user, 1_000e6);
        vm.startPrank(user);
        usdc.approve(address(t), 1_000e6);
        t.deposit(address(usdc), 1_000e6);
        vm.stopPrank();
        _constitution(5_000, 0, 0);
        vm.prank(exec);
        t.toggleAgents(true);

        vm.prank(owner);
        protocol.setAdapterRiskTier(address(tier1), 3);

        uint256 amount = 200e6; // 20% of NAV: inside the 50% cap, above Tier 3's 15%
        vm.prank(g1);
        uint64 idx = g.createProposal(
            NaveGovernor.CreateProposalParams({
                title: "deploy",
                description: "",
                payload: abi.encode(address(tier1), amount, address(usdc)),
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
        e.createStrategyRequest(idx, amount, address(tier1), address(usdc));
        bytes32 ph = PayloadHash.strategyHash(address(tier1), amount, address(usdc));
        vm.prank(exec);
        e.executiveApprove(idx, keccak256("r"));
        vm.prank(fin);
        e.financialApprove(idx, ph, keccak256("r"));
        vm.prank(over);
        e.oversightApprove(idx, ph, keccak256("r"));
        vm.warp(block.timestamp + 1 days + 1);
        _revalueTreasury(t);
        vm.prank(exec);
        vm.expectRevert(NaveErrors.AllocationLimitExceeded.selector);
        e.execute(idx, 1);
    }
}
