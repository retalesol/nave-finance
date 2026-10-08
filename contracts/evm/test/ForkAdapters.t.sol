// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {NaveProtocol} from "../src/NaveProtocol.sol";
import {AaveV3Adapter} from "../src/adapters/AaveV3Adapter.sol";
import {CompoundV3Adapter} from "../src/adapters/CompoundV3Adapter.sol";
import {BalancerAdapter} from "../src/adapters/BalancerAdapter.sol";
import {CurveAdapter} from "../src/adapters/CurveAdapter.sol";
import {IComet} from "../src/adapters/external/IExternalProtocols.sol";
import {NaveAddressRegistry} from "../script/config/NaveAddressRegistry.sol";
import {TestProxies} from "./helpers/TestProxies.sol";

/// @notice Mainnet-fork integration tests for the four strategy adapters against
/// LIVE Aave v3, Compound v3, Balancer v2 and Curve deployments.
///
/// Each test forks only when its RPC env var is set, otherwise it skips — so
/// `forge test` is green out of the box and the fork suite runs in CI when
/// `ETH_MAINNET_RPC_URL` / `BASE_MAINNET_RPC_URL` are provided. Run explicitly:
///
///   ETH_MAINNET_RPC_URL=https://... BASE_MAINNET_RPC_URL=https://... \
///     forge test --match-path test/ForkAdapters.t.sol -vvv
///
/// Coverage:
///   - Aave v3     (ETH + Base): supply USDC -> aUSDC -> withdraw to treasury.
///   - Compound v3 (ETH + Base): supply USDC -> Comet balance -> withdrawTo.
///   - Balancer v2 (ETH):        single-asset join/exit, with caller-supplied
///                               slippage (`BALANCER_MIN_BPT_OUT` required).
///                               EVM-C2: {BalancerAdapter} now prices via the
///                               BPT's `getRate()` (Stable/ComposableStable/
///                               MetaStable/Linear pools only) instead of raw
///                               getPoolTokens() balances — the previously
///                               pinned 50/50 USDC/WETH Weighted Pool does NOT
///                               implement getRate(), so this test skips
///                               unless BALANCER_POOL_ID/BPT env vars pin a
///                               rate-provider pool.
///   - Curve NG    (env-pinned): single-coin add/remove with slippage. Requires
///                               a StableSwap-NG pool (dynamic-array ABI); set
///                               CURVE_POOL/CURVE_LP_TOKEN/CURVE_COIN/
///                               CURVE_COIN_INDEX/CURVE_N_COINS and
///                               `CURVE_MIN_LP_OUT` or it skips.
///
/// Note on the share ledger: {BaseStrategyAdapter} permanently locks
/// `MIN_DEAD_SHARES` (1_000 base units) on the first deposit (C-2 inflation
/// guard), so a single caller's `positionValue` reads ~`MIN_DEAD_SHARES` below
/// the raw deposit; tolerances below account for this.
contract ForkAdaptersTest is Test {
    uint256 internal constant DEAD = 1000; // BaseStrategyAdapter.MIN_DEAD_SHARES

    address internal recipient = makeAddr("treasuryRecipient");

    // ── Aave: Ethereum + Base ─────────────────────────────────────────────
    function test_fork_aave_ethereum() public {
        _aave(
            "ETH_MAINNET_RPC_URL",
            NaveAddressRegistry.ETH_AAVE_V3_POOL,
            NaveAddressRegistry.ETH_USDC
        );
    }

    function test_fork_aave_base() public {
        _aave(
            "BASE_MAINNET_RPC_URL",
            NaveAddressRegistry.BASE_AAVE_V3_POOL,
            NaveAddressRegistry.BASE_USDC
        );
    }

    // ── Compound v3: Ethereum + Base ──────────────────────────────────────
    function test_fork_compound_ethereum() public {
        _compound("ETH_MAINNET_RPC_URL", NaveAddressRegistry.ETH_COMET_USDC);
    }

    function test_fork_compound_base() public {
        _compound("BASE_MAINNET_RPC_URL", NaveAddressRegistry.BASE_COMET_USDC);
    }

    // ── Balancer v2: Ethereum, rate-provider pool required (EVM-C2) ───────
    /// Default pin: wstETH/WETH MetaStable pool (implements `getRate()`).
    /// Override with BALANCER_POOL_ID / BALANCER_BPT / BALANCER_ROUTED_ASSET /
    /// BALANCER_ASSET_INDEX / BALANCER_TOKEN_COUNT / BALANCER_MIN_BPT_OUT.
    /// Plain Weighted Pools without getRate() are NOT supported.
    address internal constant BALANCER_PIN_BPT = 0x32296969Ef14EB0c6d29669C550D4a0449130230;
    bytes32 internal constant BALANCER_PIN_POOL_ID =
        bytes32(0x32296969ef14eb0c6d29669c550d4a0449130230000200000000000000000080);
    /// Vault token order for this pool: [wstETH, WETH] → WETH at index 1.
    uint256 internal constant BALANCER_PIN_WETH_INDEX = 1;
    uint256 internal constant BALANCER_PIN_TOKEN_COUNT = 2;

    function test_fork_balancer_ethereum() public {
        if (!_maybeFork("ETH_MAINNET_RPC_URL")) return;
        address bpt = vm.envOr("BALANCER_BPT", BALANCER_PIN_BPT);
        bytes32 poolId = vm.envOr("BALANCER_POOL_ID", BALANCER_PIN_POOL_ID);
        address routed = vm.envOr("BALANCER_ROUTED_ASSET", NaveAddressRegistry.ETH_WETH);
        uint256 assetIndex = vm.envOr("BALANCER_ASSET_INDEX", BALANCER_PIN_WETH_INDEX);
        uint256 tokenCount = vm.envOr("BALANCER_TOKEN_COUNT", BALANCER_PIN_TOKEN_COUNT);

        NaveProtocol p = _protocolWithSelfAsExecution();
        BalancerAdapter adapter = new BalancerAdapter(
            address(p),
            NaveAddressRegistry.BALANCER_V2_VAULT,
            poolId,
            bpt,
            routed,
            assetIndex,
            tokenCount
        );
        assertTrue(adapter.supportsAsset(routed));

        uint256 amount = 10 ether; // 10 WETH
        deal(routed, address(this), amount);
        IERC20(routed).transfer(address(adapter), amount);
        uint256 minBptOut = vm.envOr("BALANCER_MIN_BPT_OUT", uint256(0));
        if (minBptOut == 0) {
            // Conservative join floor: ~85% of notional in 18-dec BPT terms.
            minBptOut = (amount * 85) / 100;
            if (minBptOut == 0) minBptOut = 1;
        }
        adapter.deposit(routed, amount, minBptOut);

        uint256 pos = adapter.positionValue(routed);
        assertGt(pos, (amount * 90) / 100, "balancer position within ~10% of deposit");

        uint256 half = pos / 2;
        uint256 out = adapter.withdraw(routed, half, recipient, (half * 95) / 100);
        assertGe(out, (half * 95) / 100, "balancer exit honored slippage floor");
        assertEq(IERC20(routed).balanceOf(recipient), out);
    }

    // ── Curve StableSwap-NG: env-pinned pool ──────────────────────────────
    function test_fork_curve_ng() public {
        if (!_maybeFork("ETH_MAINNET_RPC_URL")) return;
        address pool = vm.envOr("CURVE_POOL", address(0));
        if (pool == address(0)) {
            // No NG pool pinned for this run — see NaveAddressRegistry Curve note.
            vm.skip(true);
            return;
        }
        address lp = vm.envAddress("CURVE_LP_TOKEN");
        address coin = vm.envAddress("CURVE_COIN");
        int128 coinIndex = int128(int256(vm.envInt("CURVE_COIN_INDEX")));
        uint256 nCoins = vm.envUint("CURVE_N_COINS");
        uint256 amount = 10_000e6;
        uint256 minLpOut = vm.envOr("CURVE_MIN_LP_OUT", uint256(0));
        if (minLpOut == 0) {
            minLpOut = (amount * 90) / 100 / 1e12;
            if (minLpOut == 0) minLpOut = 1;
        }

        NaveProtocol p = _protocolWithSelfAsExecution();
        CurveAdapter adapter = new CurveAdapter(address(p), pool, lp, coin, coinIndex, nCoins, 100);
        assertTrue(adapter.supportsAsset(coin));

        deal(coin, address(this), amount);
        IERC20(coin).transfer(address(adapter), amount);
        adapter.deposit(coin, amount, minLpOut);

        uint256 pos = adapter.positionValue(coin);
        assertGt(pos, (amount * 95) / 100, "curve position within ~5% of deposit");

        uint256 half = pos / 2;
        uint256 out = adapter.withdraw(coin, half, recipient, (half * 95) / 100);
        assertGe(out, (half * 95) / 100, "curve exit honored slippage floor");
    }

    // ── Helpers ───────────────────────────────────────────────────────────
    /// Deploy a protocol that treats `address(this)` as a registered execution
    /// so the adapter authorizes our direct calls (mirrors the per-DAO gate).
    function _protocolWithSelfAsExecution() internal returns (NaveProtocol p) {
        p = TestProxies.deployProtocol(address(this), address(0xFEE), 0, 0);
        p.setFactory(address(this));
        p.registerDao(makeAddr("t"), makeAddr("g"), address(this));
    }

    function _maybeFork(string memory key) internal returns (bool) {
        string memory rpc = vm.envOr(key, string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return false;
        }
        vm.createSelectFork(rpc);
        return true;
    }

    function _aave(string memory rpcKey, address pool, address usdc) internal {
        if (!_maybeFork(rpcKey)) return;
        NaveProtocol p = _protocolWithSelfAsExecution();
        AaveV3Adapter adapter = new AaveV3Adapter(address(p), pool);
        assertTrue(adapter.supportsAsset(usdc));

        uint256 amount = 1000e6;
        deal(usdc, address(this), amount);
        IERC20(usdc).transfer(address(adapter), amount);
        adapter.deposit(usdc, amount, 0); // 1:1 lending, no slippage bound needed

        // Caller's position is the deposit minus the locked dead shares.
        uint256 pos = adapter.positionValue(usdc);
        assertApproxEqAbs(pos, amount - DEAD, DEAD);
        assertGe(IERC20(adapter.aTokenFor(usdc)).balanceOf(address(adapter)), amount - 2);

        // Withdraw half to the treasury recipient.
        uint256 half = amount / 2;
        adapter.withdraw(usdc, half, recipient, 0);
        assertApproxEqAbs(IERC20(usdc).balanceOf(recipient), half, 2);
    }

    function _compound(string memory rpcKey, address comet) internal {
        if (!_maybeFork(rpcKey)) return;
        NaveProtocol p = _protocolWithSelfAsExecution();
        CompoundV3Adapter adapter = new CompoundV3Adapter(address(p), comet);
        address usdc = IComet(comet).baseToken();
        assertTrue(adapter.supportsAsset(usdc));

        uint256 amount = 1000e6;
        deal(usdc, address(this), amount);
        IERC20(usdc).transfer(address(adapter), amount);
        adapter.deposit(usdc, amount, 0);

        uint256 pos = adapter.positionValue(usdc);
        assertApproxEqAbs(pos, amount - DEAD, DEAD + 2);

        uint256 half = amount / 2;
        adapter.withdraw(usdc, half, recipient, 0);
        assertApproxEqAbs(IERC20(usdc).balanceOf(recipient), half, 2);
    }
}
