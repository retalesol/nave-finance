// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {NaveProtocol} from "../src/NaveProtocol.sol";
import {FeeMath} from "../src/libraries/FeeMath.sol";
import {TestSharesAdapter} from "./mocks/TestSharesAdapter.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {TestProxies} from "./helpers/TestProxies.sol";

/// @notice Drives random deposit/withdraw/accrue against a {TestSharesAdapter}
/// from two distinct (registered) execution callers, so the invariant suite can
/// assert the share-accounting model never lets one DAO touch another's funds.
contract AdapterHandler is Test {
    TestSharesAdapter public adapter;
    MockERC20 public asset;
    address public callerA;
    address public callerB;

    constructor(TestSharesAdapter adapter_, MockERC20 asset_, address a, address b) {
        adapter = adapter_;
        asset = asset_;
        callerA = a;
        callerB = b;
    }

    function _caller(uint256 seed) internal view returns (address) {
        return seed % 2 == 0 ? callerA : callerB;
    }

    function deposit(uint256 seed, uint256 amount) public {
        amount = bound(amount, 1, 1_000_000e6);
        address c = _caller(seed);
        asset.mint(address(this), amount);
        asset.transfer(address(adapter), amount); // execution funds the adapter first
        vm.prank(c);
        adapter.deposit(address(asset), amount, 0);
    }

    function withdraw(uint256 seed, uint256 amount) public {
        address c = _caller(seed);
        uint256 max = _positionOf(c);
        if (max == 0) return;
        amount = bound(amount, 1, max);
        vm.prank(c);
        adapter.withdraw(address(asset), amount, address(0xBEEF), 0);
    }

    function accrue(uint256 gain) public {
        gain = bound(gain, 0, 100_000e6);
        if (gain == 0) return;
        adapter.accrue(gain);
    }

    function _positionOf(address c) internal returns (uint256) {
        vm.prank(c);
        return adapter.positionValue(address(asset));
    }

    function positionA() external returns (uint256) {
        return _positionOf(callerA);
    }

    function positionB() external returns (uint256) {
        return _positionOf(callerB);
    }
}

contract InvariantTest is Test {
    NaveProtocol internal protocol;
    TestSharesAdapter internal adapter;
    MockERC20 internal asset;
    AdapterHandler internal handler;
    address internal callerA = makeAddr("execA");
    address internal callerB = makeAddr("execB");

    function setUp() public {
        protocol = TestProxies.deployProtocol(address(this), address(0xFEE), 0, 0);
        protocol.setFactory(address(this));
        // Register the two callers as execution clones (treasury/governor unused).
        protocol.registerDao(makeAddr("tA"), makeAddr("gA"), callerA);
        protocol.registerDao(makeAddr("tB"), makeAddr("gB"), callerB);

        asset = new MockERC20("USD Coin", "USDC", 6);
        adapter = new TestSharesAdapter(address(protocol), address(asset));
        handler = new AdapterHandler(adapter, asset, callerA, callerB);

        targetContract(address(handler));
    }

    /// Total shares always equals the sum of each caller's shares plus the
    /// permanently locked first-deposit dead shares (C-2 inflation guard).
    function invariant_sharesConserved() public view {
        uint256 sumShares = adapter.shares(callerA, address(asset))
            + adapter.shares(callerB, address(asset))
            + adapter.shares(address(0xdead), address(asset));
        assertEq(sumShares, adapter.totalShares(address(asset)));
    }

    /// The sum of both callers' position values never exceeds the pooled
    /// underlying (no value is conjured; rounding only ever leaves dust behind).
    function invariant_positionsDoNotExceedPool() public {
        uint256 a = handler.positionA();
        uint256 b = handler.positionB();
        assertLe(a + b, adapter.pooled());
    }

    // ── Stateless property: performance skim is always bounded ────────────
    function testFuzz_perfSkimBounded(
        uint256 amount,
        uint256 deposited,
        uint256 currentValue,
        uint256 feeBps
    ) public pure {
        amount = bound(amount, 0, 1e30);
        currentValue = bound(currentValue, amount, 1e30); // caller guarantees amount <= currentValue
        deposited = bound(deposited, 0, 1e30);
        // Fee bps are validated to <= 10_000 on-chain (FeeConfig bounds).
        uint16 feeBpsBounded = uint16(bound(feeBps, 0, 10_000));
        (uint256 gain, uint256 fee) =
            FeeMath.calculatePerformanceSkim(amount, deposited, currentValue, feeBpsBounded);
        assertLe(fee, gain);
        assertLe(gain, amount);
    }
}
