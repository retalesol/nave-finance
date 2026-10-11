// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {TestnetPegOracle} from "../src/oracle/TestnetPegOracle.sol";
import {NaveErrors} from "../src/libraries/NaveErrors.sol";

contract TestnetPegOracleTest is Test {
    address internal constant USDC = address(0xCAFE);
    address internal constant WETH = address(0xBEEF);

    function test_pricesConfiguredUsdcAtOneDollar() public {
        TestnetPegOracle oracle = new TestnetPegOracle(USDC);
        assertTrue(oracle.hasFreshPrice(USDC, bytes32(0)));
        // 1.5 USDC (6 decimals) = 1_500_000 micro-USD.
        assertEq(oracle.valueUsd(USDC, bytes32(0), 6, 1_500_000), 1_500_000);
        assertEq(oracle.valueUsd(USDC, bytes32(0), 6, 0), 0);
    }

    function test_failsClosedForEveryOtherAsset() public {
        TestnetPegOracle oracle = new TestnetPegOracle(USDC);
        assertFalse(oracle.hasFreshPrice(WETH, bytes32(0)));
        vm.expectRevert(NaveErrors.StaleOracle.selector);
        oracle.valueUsd(WETH, bytes32(0), 18, 1 ether);
    }

    function test_zeroUsdcFailsClosedForAllAssets() public {
        TestnetPegOracle oracle = new TestnetPegOracle(address(0));
        assertFalse(oracle.hasFreshPrice(USDC, bytes32(0)));
        vm.expectRevert(NaveErrors.StaleOracle.selector);
        oracle.valueUsd(USDC, bytes32(0), 6, 1_000_000);
    }
}
