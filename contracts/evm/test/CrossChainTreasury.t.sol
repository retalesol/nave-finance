// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {NaveBase} from "./NaveBase.t.sol";
import {NaveTreasury} from "../src/NaveTreasury.sol";
import {NaveExecution} from "../src/NaveExecution.sol";
import {NaveErrors} from "../src/libraries/NaveErrors.sol";
import {NaveConstants} from "../src/libraries/NaveConstants.sol";
import {DaoImplRole} from "../src/libraries/NaveEnums.sol";
import {ProtocolFeeLib} from "../src/libraries/ProtocolFeeLib.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/// @notice Same-address CREATE2 salt, activation fee, outbound relayer fee,
/// and relayer-sweep arithmetic. Old {createDao} stays chain-scoped.
contract CrossChainTreasuryTest is NaveBase {
    address internal relayer_ = makeAddr("relayer");
    address internal grantee = makeAddr("grantee");

    function test_crossChainSalt_ignoresChainIdAndDaoCounter() public {
        vm.chainId(84532);
        bytes32 saltA = factory.crossChainSalt(founder, "nave-dao");
        (address tA, address gA, address eA) = factory.predictCrossChainAddresses(founder, "nave-dao");

        vm.chainId(11155111);
        bytes32 saltB = factory.crossChainSalt(founder, "nave-dao");
        (address tB, address gB, address eB) = factory.predictCrossChainAddresses(founder, "nave-dao");

        assertEq(saltA, saltB, "salt ignores chain id");
        assertEq(saltA, keccak256(abi.encode(founder, "nave-dao")));
        assertEq(tA, tB);
        assertEq(gA, gB);
        assertEq(eA, eB);

        vm.prank(founder);
        factory.createDao(_daoParams(0));
        (address tC,,) = factory.predictCrossChainAddresses(founder, "nave-dao");
        assertEq(tC, tB, "salt ignores dao counter");
        assertTrue(saltA != factory.daoSalt(0, founder));
        assertTrue(saltA != factory.daoSalt(protocol.daoCount(), founder));
    }

    function test_createAndActivate_sameAddresses_feeToRevenue() public {
        uint256 snap = vm.snapshotState();

        vm.chainId(84532);
        vm.prank(founder);
        (, address home, address homeGov, address homeExec) =
            factory.createCrossChainDao(_daoParams(0), "nave-dao");

        vm.revertToState(snap);
        vm.chainId(11155111);
        vm.deal(founder, 0.005 ether);
        uint256 revenueBefore = protocolTreasury.balance;
        uint256 founderBefore = founder.balance;
        vm.prank(founder);
        (, address activated, address actGov, address actExec) =
            factory.activateDao{value: 0.005 ether}(_daoParams(0), "nave-dao");

        assertEq(activated, home, "treasury address matches across chains");
        assertEq(actGov, homeGov);
        assertEq(actExec, homeExec);
        assertEq(protocolTreasury.balance - revenueBefore, NaveConstants.ACTIVATION_FEE_WEI);
        assertEq(founderBefore - founder.balance, NaveConstants.ACTIVATION_FEE_WEI, "excess refunded");
        assertEq(NaveTreasury(payable(activated)).name(), "Test DAO");
        assertEq(NaveTreasury(payable(activated)).founder(), founder);
    }

    function test_activate_insufficientFeeReverts() public {
        vm.deal(founder, 0.0001 ether);
        vm.prank(founder);
        vm.expectRevert(NaveErrors.InsufficientActivationFee.selector);
        factory.activateDao{value: 0.0001 ether}(_daoParams(0), "nave-dao");
    }

    function test_activate_arcPaysUsdcConstantWhenOracleHasNoEthPrice() public {
        MockERC20 impl = new MockERC20("USD Coin", "USDC", 6);
        vm.etch(NaveConstants.ARC_TESTNET_USDC, address(impl).code);
        MockERC20 arcUsdc = MockERC20(NaveConstants.ARC_TESTNET_USDC);

        vm.chainId(NaveConstants.ARC_TESTNET_CHAIN_ID);
        vm.prank(owner);
        protocol.setWrappedNative(address(0), bytes32(0));

        (uint256 nativeWei, uint256 usdcFee) = factory.activationFeeQuote();
        assertEq(nativeWei, 0);
        assertEq(usdcFee, 2_500_000, "0.001 ETH at the documented $2,500 testnet price");

        arcUsdc.mint(founder, usdcFee);
        vm.prank(founder);
        arcUsdc.approve(address(factory), usdcFee);
        uint256 revenueBefore = arcUsdc.balanceOf(protocolTreasury);
        vm.prank(founder);
        factory.activateDao(_daoParams(0), "arc-dao");
        assertEq(arcUsdc.balanceOf(protocolTreasury) - revenueBefore, usdcFee);
    }

    function test_deposit_doesNotPayRelayer_andEmptyNativeReverts() public {
        vm.prank(owner);
        protocol.setRelayer(relayer_);
        (NaveTreasury t,,) = _createDao(0);

        vm.prank(founder);
        t.registerAsset(address(usdc), bytes32(0), true, 0);
        usdc.mint(founder, 100e6);
        vm.prank(founder);
        usdc.approve(address(t), 100e6);

        uint256 relayerBeforeDeposit = relayer_.balance;
        vm.prank(founder);
        t.deposit(address(usdc), 40e6);
        assertEq(relayer_.balance, relayerBeforeDeposit, "deposit does not pay the relayer");
        assertEq(address(t).balance, 0);

        usdc.mint(address(t), 50e6);
        vm.prank(address(t.governor()));
        vm.expectRevert(NaveErrors.InsufficientNativeForRelayerFee.selector);
        t.executeGovernanceTransfer(address(usdc), grantee, 10e6);
    }

    function test_outboundTransfer_paysConfiguredRelayer() public {
        vm.prank(owner);
        protocol.setRelayer(relayer_);
        (NaveTreasury t,,) = _createDao(0);
        vm.prank(founder);
        t.registerAsset(address(usdc), bytes32(0), true, 0);
        usdc.mint(address(t), 50e6);
        vm.deal(address(t), 1 ether);

        uint256 before = relayer_.balance;
        vm.prank(address(t.governor()));
        t.executeGovernanceTransfer(address(usdc), grantee, 10e6);

        assertEq(relayer_.balance - before, NaveConstants.OUTBOUND_RELAYER_FEE_WEI);
        assertEq(usdc.balanceOf(grantee), 10e6);
        assertEq(address(t).balance, 1 ether - NaveConstants.OUTBOUND_RELAYER_FEE_WEI);
    }

    function test_outboundTransfer_unwrapsWethWhenNativeBalanceIsWrapped() public {
        vm.prank(owner);
        protocol.setRelayer(relayer_);
        (NaveTreasury t,,) = _createDao(0);
        vm.prank(founder);
        t.registerAsset(address(usdc), bytes32(0), true, 0);
        usdc.mint(address(t), 50e6);

        vm.deal(founder, 1 ether);
        vm.prank(founder);
        (bool seeded,) = address(t).call{value: 1 ether}("");
        assertTrue(seeded);
        assertEq(address(t).balance, 0, "receive wraps native ETH");
        assertEq(weth.balanceOf(address(t)), 1 ether);

        vm.prank(address(t.governor()));
        t.executeGovernanceTransfer(address(usdc), grantee, 1e6);
        assertEq(relayer_.balance, NaveConstants.OUTBOUND_RELAYER_FEE_WEI);
        assertEq(weth.balanceOf(address(t)), 1 ether - NaveConstants.OUTBOUND_RELAYER_FEE_WEI);
    }

    function test_bridgeDeparture_paysRelayer() public {
        vm.prank(owner);
        protocol.setRelayer(relayer_);
        (NaveTreasury t,, NaveExecution e) = _createDao(0);
        vm.prank(founder);
        t.registerAsset(address(usdc), bytes32(0), true, 0);
        vm.deal(address(t), 1 ether);

        vm.prank(address(e));
        t.noteCapitalDeparture(address(usdc), 1e6);
        assertEq(relayer_.balance, NaveConstants.OUTBOUND_RELAYER_FEE_WEI);
    }

    function test_sameAddressSister_doesNotNeedRemoteRegistry() public {
        (NaveTreasury t,,) = _createDao(0);
        vm.prank(founder);
        t.setLinkedTreasury(11_155_111, address(t));
        assertEq(t.linkedTreasury(11_155_111), address(t));

        vm.prank(founder);
        vm.expectRevert(NaveErrors.InvalidChainId.selector);
        t.setLinkedTreasury(block.chainid, address(t));
    }

    function test_strategyWithdrawal_pullsRelayerFee() public {
        vm.prank(owner);
        protocol.setRelayer(relayer_);
        (NaveTreasury t, , NaveExecution e) = _createDao(0);
        vm.prank(founder);
        t.registerAsset(address(usdc), bytes32(0), true, 0);
        usdc.mint(address(t), 20e6);
        vm.deal(address(t), 1 ether);
        vm.prank(address(e));
        t.recordStrategyDeposit(address(0xBEEF), address(usdc), 10e6, 10e6);

        vm.prank(address(e));
        t.recordStrategyWithdrawal(address(0xBEEF), address(usdc), 10e6, 10e6);
        assertEq(relayer_.balance, NaveConstants.OUTBOUND_RELAYER_FEE_WEI);
    }

    function test_activate_usesCreationImplsAfterLatestChanges() public {
        uint256 snap = vm.snapshotState();

        vm.prank(founder);
        (, address home,,) = factory.createCrossChainDao(_daoParams(0), "nave-dao");
        (address created,,) = factory.predictCrossChainAddresses(founder, "nave-dao");
        assertEq(created, home, "home predict stays on the implementations used at create");

        NaveTreasury newer = new NaveTreasury();
        vm.prank(owner);
        protocol.publishImplementation(uint8(DaoImplRole.Treasury), address(newer));
        (address drifted,,) = factory.predictCrossChainAddresses(founder, "nave-dao");
        assertEq(drifted, home, "a later latest implementation does not move an existing salt");
        (address fresh,,) = factory.predictCrossChainAddresses(founder, "other-dao");
        assertTrue(fresh != home, "a new slug follows the new implementation");

        vm.revertToState(snap);
        vm.chainId(11_155_111);
        newer = new NaveTreasury();
        vm.prank(owner);
        protocol.publishImplementation(uint8(DaoImplRole.Treasury), address(newer));
        vm.deal(founder, 1 ether);
        vm.prank(founder);
        (, address activated,,) = factory.activateDao{value: 0.001 ether}(
            _daoParams(0), "nave-dao", treasuryImpl, governorImpl, executionImpl
        );
        assertEq(activated, home, "sister chain deploys the original implementation set");
    }

    function test_activate_rejectsUnapprovedImpl() public {
        address bogus = address(new NaveTreasury());
        vm.deal(founder, 1 ether);
        vm.prank(founder);
        vm.expectRevert(NaveErrors.LatestImplNotApproved.selector);
        factory.activateDao{value: 0.001 ether}(
            _daoParams(0), "nave-dao", bogus, governorImpl, executionImpl
        );
    }

    function test_sweepMath_leavesReserve() public pure {
        uint256 reserve = NaveConstants.RELAYER_SWEEP_RESERVE_WEI;
        assertEq(reserve, 0.05 ether);
        assertEq(ProtocolFeeLib.sweepExcess(0.08 ether, reserve), 0.03 ether);
        assertEq(0.08 ether - ProtocolFeeLib.sweepExcess(0.08 ether, reserve), reserve);
        assertEq(ProtocolFeeLib.sweepExcess(reserve, reserve), 0);
        assertEq(ProtocolFeeLib.sweepExcess(0.01 ether, reserve), 0);
    }
}
