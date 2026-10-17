// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {TestnetPegOracle} from "../src/oracle/TestnetPegOracle.sol";
import {TestnetMintableERC20} from "../src/mocks/TestnetMintableERC20.sol";
import {TestnetERC4626YieldVault} from "../src/mocks/TestnetERC4626YieldVault.sol";
import {ERC4626VaultAdapter} from "../src/adapters/ERC4626VaultAdapter.sol";
import {NaveProtocol} from "../src/NaveProtocol.sol";
import {NaveErrors} from "../src/libraries/NaveErrors.sol";
import {TestProxies} from "./helpers/TestProxies.sol";

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

    function test_pricesConfiguredReferenceAsset() public {
        TestnetPegOracle oracle = new TestnetPegOracle(USDC);
        oracle.setReferencePrice(WETH, 2_500_000_000);
        assertTrue(oracle.hasFreshPrice(WETH, bytes32(0)));
        assertEq(oracle.valueUsd(WETH, bytes32(0), 18, 1 ether), 2_500_000_000);
        assertEq(oracle.valueUsd(WETH, bytes32(0), 18, 0.001 ether), 2_500_000);
    }

    function test_testnetERC4626YieldVaultAndAdapterLifecycle() public {
        NaveProtocol protocol = TestProxies.deployProtocol(address(this), address(0xFEE), 0, 0);
        protocol.setFactory(address(this));
        protocol.registerDao(makeAddr("treasury"), makeAddr("governor"), address(this));

        TestnetMintableERC20 token =
            new TestnetMintableERC20("USD Coin (Testnet)", "USDC", 6, 1_000_000e6);
        TestnetERC4626YieldVault vault =
            new TestnetERC4626YieldVault(token, "Nave Testnet USDC Vault", "nvUSDC");
        ERC4626VaultAdapter adapter =
            new ERC4626VaultAdapter(address(protocol), address(vault), "morpho-steakhouse-usdc");

        uint256 depositAmt = 10_000e6;
        token.mint(address(adapter), depositAmt);
        adapter.deposit(address(token), depositAmt, 1);

        uint256 posBefore = adapter.positionValue(address(token));
        assertEq(posBefore, depositAmt - adapter.MIN_DEAD_SHARES());

        // Accrue 500 USDC of yield via drip() and verify adapter positionValue increases.
        vault.drip(500e6);
        uint256 posAfter = adapter.positionValue(address(token));
        assertGt(posAfter, posBefore + 499e6);

        address recipient = makeAddr("recipient");
        adapter.withdraw(address(token), 5_000e6, recipient, 5_000e6);
        assertEq(token.balanceOf(recipient), 5_000e6);
    }
}
