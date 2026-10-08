// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {NaveBase} from "./NaveBase.t.sol";
import {NaveProtocol} from "../src/NaveProtocol.sol";
import {NaveTreasury} from "../src/NaveTreasury.sol";
import {NaveGovernor} from "../src/NaveGovernor.sol";
import {NaveExecution} from "../src/NaveExecution.sol";
import {NaveErrors} from "../src/libraries/NaveErrors.sol";
import {
    ProposalType,
    ProposalStatus,
    VoteChoice,
    DaoImplRole
} from "../src/libraries/NaveEnums.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";

/// @notice UUPS singleton + DAO consent-gated upgrade tests.
contract UpgradeabilityTest is NaveBase {
    function test_createDao_usesLatestImpls() public {
        (NaveTreasury t, NaveGovernor g, NaveExecution e) = _createDao(0);
        assertEq(t.currentImplementation(), treasuryImpl);
        assertEq(g.currentImplementation(), governorImpl);
        assertEq(e.currentImplementation(), executionImpl);
        assertFalse(t.needsUpgrade());
    }

    function test_protocolOwner_cannotForceUpgradeDaoProxy() public {
        (NaveTreasury t,,) = _createDao(0);
        address newImpl = address(new NaveTreasury());
        vm.prank(owner);
        protocol.publishImplementation(uint8(DaoImplRole.Treasury), newImpl);

        vm.prank(owner);
        vm.expectRevert(NaveErrors.Unauthorized.selector);
        UUPSUpgradeable(payable(address(t))).upgradeToAndCall(newImpl, "");
    }

    function test_unapprovedImpl_rejectedOnAuthorize() public {
        (NaveTreasury t, NaveGovernor g,) = _createDao(0);
        address rogue = address(new NaveTreasury());

        // Craft a passed ContractUpgrade proposal targeting rogue impls.
        bytes memory payload = abi.encode(rogue, governorImpl, executionImpl);
        vm.prank(g1);
        uint64 idx = g.createProposal(
            NaveGovernor.CreateProposalParams({
                title: "Bad upgrade",
                description: "should fail",
                payload: payload,
                proposalType: uint8(ProposalType.ContractUpgrade),
                votingPeriodSeconds: 3 days,
                votingMint: address(0)
            })
        );
        vm.prank(g1);
        g.castVoteWallet(idx, uint8(VoteChoice.For));
        vm.prank(g2);
        g.castVoteWallet(idx, uint8(VoteChoice.For));
        g.finalizeProposal(idx);

        vm.expectRevert(NaveErrors.ImplNotApproved.selector);
        g.executeContractUpgrade(idx, rogue, governorImpl, executionImpl);
    }

    function test_daoConsent_upgradeToLatest_preservesStorage() public {
        (NaveTreasury t, NaveGovernor g, NaveExecution e) = _createDao(0);
        string memory nameBefore = t.name();
        address founderBefore = t.founder();

        address newT = address(new NaveTreasury());
        address newG = address(new NaveGovernor());
        address newE = address(new NaveExecution());
        vm.startPrank(owner);
        protocol.publishImplementation(uint8(DaoImplRole.Treasury), newT);
        protocol.publishImplementation(uint8(DaoImplRole.Governor), newG);
        protocol.publishImplementation(uint8(DaoImplRole.Execution), newE);
        vm.stopPrank();

        assertTrue(t.needsUpgrade());

        // The vote binds the concrete implementation triplet (the former
        // `UPGRADE_TO_LATEST` sentinel, which resolved the targets at execution
        // time, was removed).
        bytes memory payload = abi.encode(newT, newG, newE);
        vm.prank(g1);
        uint64 idx = g.createProposal(
            NaveGovernor.CreateProposalParams({
                title: "Protocol update",
                description: "Update your DAO to the latest Nave version",
                payload: payload,
                proposalType: uint8(ProposalType.ContractUpgrade),
                votingPeriodSeconds: 3 days,
                votingMint: address(0)
            })
        );
        vm.prank(g1);
        g.castVoteWallet(idx, uint8(VoteChoice.For));
        vm.prank(g2);
        g.castVoteWallet(idx, uint8(VoteChoice.For));
        g.finalizeProposal(idx);

        g.executeContractUpgrade(idx, newT, newG, newE);

        assertEq(t.currentImplementation(), newT);
        assertEq(NaveGovernor(payable(address(g))).currentImplementation(), newG);
        assertEq(e.currentImplementation(), newE);
        assertEq(t.name(), nameBefore);
        assertEq(t.founder(), founderBefore);
        assertFalse(t.needsUpgrade());
        assertEq(uint8(g.getProposal(idx).status), uint8(ProposalStatus.Executed));
    }

    /// Hardening (finding 5): the protocol owner publishing a NEW "latest"
    /// implementation after the DAO voted must not change what the DAO
    /// consented to. The vote is bound to explicit addresses; only those can
    /// be applied, and the sentinel path no longer exists.
    function test_upgrade_boundToVotedAddresses_notLatestAtExecution() public {
        (NaveTreasury t, NaveGovernor g, NaveExecution e) = _createDao(0);

        address votedT = address(new NaveTreasury());
        vm.prank(owner);
        protocol.publishImplementation(uint8(DaoImplRole.Treasury), votedT);

        bytes memory payload = abi.encode(votedT, governorImpl, executionImpl);
        vm.prank(g1);
        uint64 idx = g.createProposal(
            NaveGovernor.CreateProposalParams({
                title: "Upgrade treasury",
                description: "",
                payload: payload,
                proposalType: uint8(ProposalType.ContractUpgrade),
                votingPeriodSeconds: 3 days,
                votingMint: address(0)
            })
        );
        vm.prank(g1);
        g.castVoteWallet(idx, uint8(VoteChoice.For));
        vm.prank(g2);
        g.castVoteWallet(idx, uint8(VoteChoice.For));
        g.finalizeProposal(idx);

        // Owner swaps "latest" AFTER the vote closed.
        address swappedT = address(new NaveTreasury());
        vm.prank(owner);
        protocol.publishImplementation(uint8(DaoImplRole.Treasury), swappedT);
        (address latestT,,) = protocol.latestImplementations();
        assertEq(latestT, swappedT);

        // Applying the swapped-in latest is refused — not what was voted.
        vm.expectRevert(NaveErrors.PayloadHashMismatch.selector);
        g.executeContractUpgrade(idx, swappedT, governorImpl, executionImpl);

        // Sentinel selector is gone from the ABI.
        (bool ok,) =
            address(g).call(abi.encodeWithSignature("executeContractUpgradeToLatest(uint64)", idx));
        assertFalse(ok);

        // Only the voted triplet applies.
        g.executeContractUpgrade(idx, votedT, governorImpl, executionImpl);
        assertEq(t.currentImplementation(), votedT);
        assertEq(e.currentImplementation(), executionImpl);
    }

    function test_singleton_ownerCanUpgradeProtocol() public {
        address newImpl = address(new NaveProtocol());
        vm.prank(owner);
        UUPSUpgradeable(payable(address(protocol))).upgradeToAndCall(newImpl, "");
        assertEq(protocol.owner(), owner);
        assertEq(protocol.protocolTreasury(), protocolTreasury);
    }

    function test_singleton_nonOwnerCannotUpgrade() public {
        address newImpl = address(new NaveProtocol());
        vm.prank(founder);
        vm.expectRevert();
        UUPSUpgradeable(payable(address(protocol))).upgradeToAndCall(newImpl, "");
    }
}
