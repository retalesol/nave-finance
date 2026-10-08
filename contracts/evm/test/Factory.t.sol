// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {NaveBase} from "./NaveBase.t.sol";
import {NaveDAOFactory} from "../src/NaveDAOFactory.sol";
import {NaveTreasury} from "../src/NaveTreasury.sol";
import {NaveGovernor} from "../src/NaveGovernor.sol";
import {NaveExecution} from "../src/NaveExecution.sol";
import {NaveErrors} from "../src/libraries/NaveErrors.sol";
import {NaveConstants} from "../src/libraries/NaveConstants.sol";
import {TestProxies} from "./helpers/TestProxies.sol";

/// @notice Coverage for the formation-fee carve-out + treasury seed wired into
/// `NaveDAOFactory.createDao` (plan Workstream 3, EVM parity).
contract FactoryTest is NaveBase {
    function _setSplit(uint256 fee, uint256 seed) internal {
        vm.startPrank(owner);
        protocol.setFormationFee(fee);
        protocol.setTreasurySeed(seed);
        vm.stopPrank();
    }

    // ── Devnet config: formation fee → protocol; user seed via msg.value surplus ─
    function test_devnetSplit_feeToProtocol_userSurplusToTreasury() public {
        uint256 fee = NaveConstants.DEVNET_FORMATION_FEE_WEI;
        uint256 userSeed = 0.005 ether;
        _setSplit(fee, 0);

        uint256 sent = fee + userSeed;
        vm.deal(founder, sent);
        uint256 protoBefore = protocolTreasury.balance;
        vm.prank(founder);
        (, address tAddr,,) = factory.createDao{value: sent}(_daoParams(0));
        NaveTreasury t = NaveTreasury(payable(tAddr));

        assertEq(t.nativeSeeded(), userSeed, "user seed recorded");
        assertEq(address(t).balance, 0, "raw ETH wrapped away");
        assertEq(weth.balanceOf(address(t)), userSeed, "treasury holds WETH seed");
        assertEq(protocolTreasury.balance - protoBefore, fee, "formation fee to protocol");
    }

    // ── Mainnet-style split: protocol portion + treasury seed ─────────────
    function test_mainnetStyleSplit_protocolPlusSeed() public {
        uint256 fee = 0.06 ether;
        uint256 seed = 0.01 ether; // ~1/6, mirrors the Solana 0.3/1.8 ratio
        _setSplit(fee, seed);

        uint256 protoBefore = protocolTreasury.balance;
        (, NaveTreasury t,,) = _createDaoWithValue(0, fee);

        assertEq(t.nativeSeeded(), seed, "seed recorded");
        assertEq(address(t).balance, 0, "raw ETH wrapped away");
        assertEq(weth.balanceOf(address(t)), seed, "treasury holds WETH seed");
        assertEq(protocolTreasury.balance - protoBefore, fee - seed, "protocol gets remainder");
    }

    // ── Surplus over the fee is forwarded to seedNativeTreasury ──────────
    // With the new fee model (treasurySeed=0), surplus represents the user's
    // chosen treasury seed and is deposited into the new treasury clone.
    function test_surplusForwardedToTreasury() public {
        uint256 fee = 0.02 ether;
        _setSplit(fee, 0); // seed=0: full fee goes to protocol

        uint256 sent = 0.05 ether; // 0.03 surplus = user treasury seed
        vm.deal(founder, sent);
        uint256 protoBefore = protocolTreasury.balance;
        uint256 founderBefore = founder.balance;
        vm.prank(founder);
        (, address tAddr,,) = factory.createDao{value: sent}(_daoParams(0));

        assertEq(weth.balanceOf(tAddr), sent - fee, "surplus wrapped into WETH");
        assertEq(address(tAddr).balance, 0, "raw ETH wrapped away");
        assertEq(protocolTreasury.balance - protoBefore, fee, "full fee to protocol (seed=0)");
        assertEq(founder.balance, founderBefore - sent, "no refund to founder");
    }

    // ── Fee carve-out seed AND msg.value surplus together (regression) ────
    // Previously createDao called seedNativeTreasury twice (once for the fee
    // carve-out, once for the surplus); the second call reverted on the
    // one-time `nativeSeeded` guard, bricking any creation that combined a
    // configured treasury seed with a user surplus. They must now combine into
    // a single seed equal to seed + surplus.
    function test_feeSeedPlusSurplus_combinedIntoSingleSeed() public {
        uint256 fee = 0.06 ether;
        uint256 seed = 0.01 ether; // carve-out from the fee
        _setSplit(fee, seed);

        uint256 surplus = 0.03 ether;
        uint256 sent = fee + surplus;
        vm.deal(founder, sent);
        uint256 protoBefore = protocolTreasury.balance;
        vm.prank(founder);
        (, address tAddr,,) = factory.createDao{value: sent}(_daoParams(0));
        NaveTreasury t = NaveTreasury(payable(tAddr));

        assertEq(t.nativeSeeded(), seed + surplus, "seed + surplus recorded");
        assertEq(address(t).balance, 0, "raw ETH wrapped away");
        assertEq(weth.balanceOf(address(t)), seed + surplus, "treasury holds WETH seed + surplus");
        assertEq(protocolTreasury.balance - protoBefore, fee - seed, "protocol gets fee remainder");
    }

    // ── Zero-config (default) still forwards full fee to protocol ──────────
    function test_zeroSeed_defaultForwardsFullFeeToProtocol() public {
        uint256 fee = 0.02 ether;
        _setSplit(fee, 0);

        uint256 protoBefore = protocolTreasury.balance;
        (, NaveTreasury t,,) = _createDaoWithValue(0, fee);

        assertEq(t.nativeSeeded(), 0, "no seed");
        assertEq(address(t).balance, 0, "treasury empty");
        assertEq(protocolTreasury.balance - protoBefore, fee, "full fee to protocol");
    }

    // ── Underpayment reverts (unchanged guard) ────────────────────────────
    function test_insufficientFee_reverts() public {
        _setSplit(0.02 ether, 0.01 ether);
        vm.deal(founder, 0.01 ether);
        vm.prank(founder);
        vm.expectRevert(NaveErrors.InsufficientFormationFee.selector);
        factory.createDao{value: 0.01 ether}(_daoParams(0));
    }

    function test_updateFactory_replacesFactory() public {
        NaveDAOFactory factory2 =
            TestProxies.deployFactory(owner, address(protocol), address(oracle), address(tokenDeployer));
        address oldFactory = address(factory);
        vm.prank(owner);
        protocol.updateFactory(address(factory2));
        assertEq(protocol.factory(), address(factory2));
        assertTrue(protocol.factory() != oldFactory);
    }

    function test_setFactory_twiceReverts() public {
        NaveDAOFactory factory2 =
            TestProxies.deployFactory(owner, address(protocol), address(oracle), address(tokenDeployer));
        vm.prank(owner);
        vm.expectRevert(NaveErrors.AlreadyInitialized.selector);
        protocol.setFactory(address(factory2));
    }

    // ── Config guards: seed may not exceed the formation fee ──────────────
    function test_setTreasurySeed_exceedingFeeReverts() public {
        vm.prank(owner);
        protocol.setFormationFee(0.01 ether);
        vm.prank(owner);
        vm.expectRevert(NaveErrors.InvalidTreasurySeed.selector);
        protocol.setTreasurySeed(0.02 ether);
    }

    function test_setFormationFee_belowExistingSeedReverts() public {
        _setSplit(0.02 ether, 0.02 ether);
        vm.prank(owner);
        vm.expectRevert(NaveErrors.InvalidTreasurySeed.selector);
        protocol.setFormationFee(0.01 ether);
    }

    // ── seedNativeTreasury is factory-gated ───────────────────────────────
    function test_seedNativeTreasury_onlyFactory() public {
        (, NaveTreasury t,,) = _createDaoWithValue(0, 0);
        vm.deal(address(this), 1 ether);
        vm.expectRevert(NaveErrors.Unauthorized.selector);
        t.seedNativeTreasury{value: 1 ether}();
    }

    function test_seedNativeTreasury_cannotDoubleSeed() public {
        _setSplit(0.01 ether, 0.01 ether);
        (, NaveTreasury t,,) = _createDaoWithValue(0, 0.01 ether);
        // Re-seeding (even by the factory) reverts once seeded.
        vm.deal(address(factory), 1 ether);
        vm.prank(address(factory));
        vm.expectRevert(NaveErrors.TreasuryAlreadySeeded.selector);
        t.seedNativeTreasury{value: 1 ether}();
    }

    // ── Cross-chain address uniqueness (CREATE2, chain-scoped salt) ────────
    /// The app registry keys DAOs by on-chain address globally. Factories are
    /// deployed by the same deployer/nonce on every chain (same factory address),
    /// so the N-th DAO on Base and the N-th DAO on Robinhood must still land on
    /// different proxy addresses. Identical deployer/nonce state is reproduced
    /// via an EVM snapshot; only `block.chainid` differs between the two runs.
    function test_createDao_addressesDifferAcrossChains_sameFactoryState() public {
        uint256 snap = vm.snapshotState();

        vm.chainId(8453); // Base
        (address t1, address g1_, address e1) = _predictAndCreate();

        vm.revertToState(snap); // identical nonces, storage, factory address
        vm.chainId(4663); // Robinhood Chain
        (address t2, address g2_, address e2) = _predictAndCreate();

        assertTrue(t1 != t2, "treasury address must differ across chains");
        assertTrue(g1_ != g2_, "governor address must differ across chains");
        assertTrue(e1 != e2, "execution address must differ across chains");
        // The three roles never collide with each other either.
        assertTrue(t1 != g1_ && g1_ != e1 && t1 != e1);
    }

    /// Same chain, same state → same addresses (deterministic), and the salt
    /// formula is exactly keccak256(abi.encode(chainid, factory, daoId, founder)).
    function test_createDao_deterministicOnSameChain_andSaltFormula() public {
        uint256 snap = vm.snapshotState();
        (address t1, address g1_, address e1) = _predictAndCreate();
        vm.revertToState(snap);
        (address t2, address g2_, address e2) = _predictAndCreate();
        assertEq(t1, t2);
        assertEq(g1_, g2_);
        assertEq(e1, e2);

        uint256 nextId = protocol.daoCount();
        assertEq(
            factory.daoSalt(nextId, founder),
            keccak256(abi.encode(block.chainid, address(factory), nextId, founder))
        );
        // Successive DAOs by the same founder get distinct addresses (daoId in salt).
        vm.prank(founder);
        (, address tA,,) = factory.createDao(_daoParams(0));
        vm.prank(founder);
        (, address tB,,) = factory.createDao(_daoParams(0));
        assertTrue(tA != tB);
    }

    /// Predict, create, and check the prediction matched.
    function _predictAndCreate() internal returns (address t, address g, address e) {
        (address pt, address pg, address pe) = factory.predictDaoAddresses(founder);
        vm.prank(founder);
        (, t, g, e) = factory.createDao(_daoParams(0));
        assertEq(t, pt, "predicted treasury");
        assertEq(g, pg, "predicted governor");
        assertEq(e, pe, "predicted execution");
        assertTrue(protocol.isNaveTreasury(t));
    }
}
