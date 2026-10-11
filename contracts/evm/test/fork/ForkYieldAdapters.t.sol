// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {NaveProtocol} from "../../src/NaveProtocol.sol";
import {ERC4626VaultAdapter} from "../../src/adapters/ERC4626VaultAdapter.sol";
import {EthenaSUSDeAdapter} from "../../src/adapters/EthenaSUSDeAdapter.sol";
import {MapleSyrupAdapter} from "../../src/adapters/MapleSyrupAdapter.sol";
import {PendlePTAdapter} from "../../src/adapters/PendlePTAdapter.sol";
import {NaveErrors} from "../../src/libraries/NaveErrors.sol";
import {TestProxies} from "../helpers/TestProxies.sol";

interface IMaplePermissionManager {
    function setLenderAllowlist(address poolManager, address[] calldata lenders, bool[] calldata allowed)
        external;
}

interface IMaplePoolManagerView {
    function poolPermissionManager() external view returns (address);
}

interface IMaplePoolManagerViewShim {
    function manager() external view returns (address);
}

interface IPendleOracleState {
    function getOracleState(address market, uint32 duration)
        external
        view
        returns (bool increaseCardinalityRequired, uint16 cardinalityRequired, bool oldestObservationSatisfied);
}

interface IMapleWMProcess {
    function processRedemptions(uint256 maxSharesToProcess) external;
    function totalShares() external view returns (uint256);
}

/// @notice Ethereum mainnet-fork tests for the Tier 2 / Tier 3 venues that
/// have no testnet deployment: Morpho/Sky/Spark ERC-4626 vaults, Ethena sUSDe,
/// Maple syrupUSDC and Pendle PT-sUSDe. Skips unless `ETH_MAINNET_RPC_URL` is
/// set (a public endpoint such as https://ethereum-rpc.publicnode.com works).
/// Base, Robinhood Chain and Arc vault cases use BASE_MAINNET_RPC_URL,
/// ROBINHOOD_MAINNET_RPC_URL and ARC_MAINNET_RPC_URL the same way:
///
///   ETH_MAINNET_RPC_URL=https://ethereum-rpc.publicnode.com \
///   BASE_MAINNET_RPC_URL=https://base-rpc.publicnode.com \
///   ROBINHOOD_MAINNET_RPC_URL=https://robinhood-rpc.publicnode.com \
///     forge test --match-path test/fork/ForkYieldAdapters.t.sol -vvv
///
/// The test contract stands in for a DAO's NaveExecution (registered with the
/// protocol) and for its treasury's guardian set (Pendle early-exit approval).
contract ForkYieldAdaptersTest is Test {
    uint256 internal constant DEAD = 1000;

    address internal constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address internal constant USDS = 0xdC035D45d973E3EC169d2276DDab16f1e407384F;
    address internal constant USDE = 0x4c9EDD5852cd905f086C759E8383e09bff1E68B3;
    address internal constant SUSDE = 0x9D39A5DE30e57443BfF2A8307A4256c8797A3497;
    address internal constant STEAKHOUSE_USDC = 0xBEEF01735c132Ada46AA9aA4c54623cAA92A64CB;
    address internal constant GAUNTLET_PRIME_USDC = 0xdd0f28e19C1780eb6396170735D45153D261490d;
    address internal constant SKY_SUSDS = 0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD;
    address internal constant SPARK_SUSDC = 0xBc65ad17c5C0a2A4D159fa5a503f4992c7B545FE;
    address internal constant MAPLE_SYRUP_USDC = 0x80ac24aA929eaF5013f6436cdA2a7ba190f5Cc0b;
    address internal constant MAPLE_POOL_DELEGATE = 0xC1e18FFD8825FfB286D177DDEbeba345EC70B49f;
    address internal constant PENDLE_ROUTER = 0x888888888889758F76e7103c6CbF23ABbF58F946;
    address internal constant PENDLE_ORACLE = 0x9a9Fa8338dd5E5B2188006f1Cd2Ef26d921650C2;
    address internal constant PENDLE_PT_SUSDE_NOV26 = 0x47ad2Cd1DD15739A7a035b9d3B7828d916FEF77E;

    address internal constant BASE_GAUNTLET_PRIME_USDC = 0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61;
    address internal constant BASE_STEAKHOUSE_USDC = 0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183;
    address internal constant BASE_SPARK_USDC = 0x7BfA7C4f149E7415b73bdeDfe609237e29CBF34A;
    address internal constant BASE_STEAKHOUSE_HIGH_YIELD_USDC = 0xBEEFA7B88064FeEF0cEe02AAeBBd95D30df3878F;
    /// Robinhood Chain (4663) Morpho vault over real USDG (0x5fc5360D...).
    address internal constant RH_STEAKHOUSE_USDG = 0xBeEff033F34C046626B8D0A041844C5d1A5409dd;
    address internal constant RH_USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    /// Arc (5042) Morpho vault; only forked when ARC_MAINNET_RPC_URL is set.
    address internal constant ARC_STEAKHOUSE_PRIME_USDC = 0xbeef0016cb2Fd5C352ea7CA08a9f54739DFa7298;

    address internal recipient = makeAddr("treasuryRecipient");

    // Guardian set the Pendle adapter reads through `treasuryContract()`.
    uint256 internal gk1 = 0xA11CE;
    uint256 internal gk2 = 0xB0B;
    uint256 internal gk3 = 0xCA7;
    uint8 public guardianThreshold = 2;

    function treasuryContract() external view returns (address) {
        return address(this);
    }

    function isGuardian(address w) external view returns (bool) {
        return w == vm.addr(gk1) || w == vm.addr(gk2) || w == vm.addr(gk3);
    }

    // ── ERC-4626 vaults (Tier 1/2) ────────────────────────────────────────
    function test_fork_vault_steakhouseUsdc() public {
        _vault("ETH_MAINNET_RPC_URL", STEAKHOUSE_USDC, "morpho-steakhouse-usdc", 10_000e6);
    }

    function test_fork_vault_gauntletPrimeUsdc() public {
        _vault("ETH_MAINNET_RPC_URL", GAUNTLET_PRIME_USDC, "morpho-gauntlet-usdc", 10_000e6);
    }

    function test_fork_vault_skySusds() public {
        _vault("ETH_MAINNET_RPC_URL", SKY_SUSDS, "sky-susds", 10_000e18);
    }

    function test_fork_vault_sparkSusdc() public {
        _vault("ETH_MAINNET_RPC_URL", SPARK_SUSDC, "spark-susdc", 10_000e6);
    }

    function test_fork_vault_base_gauntletPrimeUsdc() public {
        _vault("BASE_MAINNET_RPC_URL", BASE_GAUNTLET_PRIME_USDC, "morpho-gauntlet-usdc", 10_000e6);
    }

    function test_fork_vault_base_steakhouseUsdc() public {
        _vault("BASE_MAINNET_RPC_URL", BASE_STEAKHOUSE_USDC, "morpho-steakhouse-usdc", 10_000e6);
    }

    function test_fork_vault_base_sparkUsdc() public {
        _vault("BASE_MAINNET_RPC_URL", BASE_SPARK_USDC, "spark-usdc", 10_000e6);
    }

    function test_fork_vault_base_steakhouseHighYieldUsdc() public {
        _vault("BASE_MAINNET_RPC_URL", BASE_STEAKHOUSE_HIGH_YIELD_USDC, "morpho-steakhouse-hy-usdc", 10_000e6);
    }

    function test_fork_vault_robinhood_steakhouseUsdg() public {
        if (!_maybeForkAt("ROBINHOOD_MAINNET_RPC_URL")) return;
        assertEq(ERC4626VaultAdapter(_newVaultAdapter(RH_STEAKHOUSE_USDG)).underlying(), RH_USDG);
        _vaultOnCurrentFork(RH_STEAKHOUSE_USDG, "morpho-steakhouse-usdg", 10_000e6);
    }

    function test_fork_vault_arc_steakhousePrimeUsdc() public {
        _vault("ARC_MAINNET_RPC_URL", ARC_STEAKHOUSE_PRIME_USDC, "morpho-steakhouse-usdc", 1_000e6);
    }

    function _newVaultAdapter(address vault) internal returns (address) {
        return address(new ERC4626VaultAdapter(address(_protocolWithSelfAsExecution()), vault, "probe"));
    }

    function _vault(string memory rpcKey, address vault, string memory id, uint256 amount) internal {
        if (!_maybeForkAt(rpcKey)) return;
        _vaultOnCurrentFork(vault, id, amount);
    }

    function _vaultOnCurrentFork(address vault, string memory id, uint256 amount) internal {
        NaveProtocol p = _protocolWithSelfAsExecution();
        ERC4626VaultAdapter adapter = new ERC4626VaultAdapter(address(p), vault, id);
        address asset = adapter.underlying();
        assertTrue(adapter.supportsAsset(asset));

        deal(asset, address(this), amount);
        IERC20(asset).transfer(address(adapter), amount);
        adapter.deposit(asset, amount, 1);
        uint256 pos = adapter.positionValue(asset);
        // NaveExecution requires the mark to land within 0.5% of the deposit.
        assertGe(pos, (amount * 9950) / 10_000, "vault mark within deposit slippage bound");

        vm.warp(block.timestamp + 30 days);
        vm.roll(block.number + 216_000);
        assertGe(adapter.positionValue(asset), pos, "vault value does not drop over time");

        uint256 half = pos / 2;
        adapter.withdraw(asset, half, recipient, half);
        assertEq(IERC20(asset).balanceOf(recipient), half);
    }

    // ── Ethena sUSDe (Tier 3): cooldown exit ──────────────────────────────
    function test_fork_ethena_cooldownExit() public {
        if (!_maybeFork()) return;
        NaveProtocol p = _protocolWithSelfAsExecution();
        EthenaSUSDeAdapter adapter = new EthenaSUSDeAdapter(address(p), SUSDE);
        assertEq(adapter.underlying(), USDE);
        uint256 delay = adapter.exitDelay();

        uint256 amount = 10_000e18;
        deal(USDE, address(this), amount);
        IERC20(USDE).transfer(address(adapter), amount);
        adapter.deposit(USDE, amount, 1);
        uint256 pos = adapter.positionValue(USDE);
        assertApproxEqAbs(pos, amount - DEAD, 2);

        vm.expectRevert(NaveErrors.ExitNotReady.selector);
        adapter.withdraw(USDE, 1e18, recipient, 1);

        uint256 exitAmt = pos / 2;
        uint256 readyAt = adapter.requestExit(USDE, exitAmt);
        assertEq(readyAt, block.timestamp + delay, "readyAt follows Ethena's live cooldown");
        assertApproxEqAbs(adapter.positionValue(USDE), pos, 2, "queued value still counted");

        if (delay > 0) {
            vm.expectRevert(NaveErrors.ExitNotReady.selector);
            adapter.withdraw(USDE, exitAmt, recipient, exitAmt);
            vm.warp(readyAt);
        }
        adapter.withdraw(USDE, exitAmt, recipient, exitAmt);
        assertEq(IERC20(USDE).balanceOf(recipient), exitAmt);
    }

    // ── Maple syrupUSDC (Tier 3): redemption queue ────────────────────────
    function test_fork_maple_queueExit() public {
        if (!_maybeFork()) return;
        NaveProtocol p = _protocolWithSelfAsExecution();
        MapleSyrupAdapter adapter = new MapleSyrupAdapter(address(p), MAPLE_SYRUP_USDC);
        assertEq(adapter.underlying(), USDC);

        // syrupUSDC is allowlist-only: Maple must onboard the adapter address.
        address pm = IMaplePoolManagerViewShim(MAPLE_SYRUP_USDC).manager();
        address[] memory lenders = new address[](1);
        lenders[0] = address(adapter);
        bool[] memory allowed = new bool[](1);
        allowed[0] = true;
        IMaplePermissionManager ppm =
            IMaplePermissionManager(IMaplePoolManagerView(pm).poolPermissionManager());
        vm.prank(MAPLE_POOL_DELEGATE);
        ppm.setLenderAllowlist(pm, lenders, allowed);

        uint256 amount = 10_000e6;
        deal(USDC, address(this), amount);
        IERC20(USDC).transfer(address(adapter), amount);
        adapter.deposit(USDC, amount, 1);
        uint256 pos = adapter.positionValue(USDC);
        assertGe(pos, (amount * 9950) / 10_000, "maple mark within deposit slippage bound");

        uint256 exitAmt = pos / 2;
        adapter.requestExit(USDC, exitAmt);
        assertFalse(adapter.exitReady());
        vm.expectRevert(NaveErrors.ExitNotReady.selector);
        adapter.withdraw(USDC, exitAmt, recipient, exitAmt);

        // The pool delegate processes the queue (off-chain keeper in prod).
        IMapleWMProcess wm = IMapleWMProcess(address(adapter.withdrawalManager()));
        uint256 queued = wm.totalShares();
        vm.prank(MAPLE_POOL_DELEGATE);
        wm.processRedemptions(queued);
        assertTrue(adapter.exitReady());

        adapter.settle();
        uint256 claim = adapter.claims(address(this));
        // Share rounding on the exit can cost at most a few base units.
        assertApproxEqAbs(claim, exitAmt, 2);
        adapter.withdraw(USDC, claim, recipient, claim);
        assertEq(IERC20(USDC).balanceOf(recipient), claim);
    }

    // ── Pendle PT-sUSDe (Tier 3): fixed rate to maturity ──────────────────
    function test_fork_pendle_ptLifecycle() public {
        if (!_maybeFork()) return;
        NaveProtocol p = _protocolWithSelfAsExecution();
        PendlePTAdapter adapter = new PendlePTAdapter(
            address(p),
            PENDLE_ROUTER,
            PENDLE_ORACLE,
            PENDLE_PT_SUSDE_NOV26,
            SUSDE,
            _pendleTwap(),
            "pendle-pt-susde"
        );
        assertFalse(adapter.matured());

        uint256 amount = 10_000e18;
        deal(SUSDE, address(this), amount);
        IERC20(SUSDE).transfer(address(adapter), amount);
        adapter.deposit(SUSDE, amount, (amount * 99) / 100);
        uint256 pos = adapter.positionValue(SUSDE);
        assertGe(pos, (amount * 9950) / 10_000, "PT mark within deposit slippage bound");
        assertLe(pos, (amount * 10_050) / 10_000, "PT mark not above deposit");

        // Before maturity the position is locked without a guardian quorum.
        uint256 part = pos / 4;
        vm.expectRevert(NaveErrors.PtNotMatured.selector);
        adapter.withdraw(SUSDE, part, recipient, (part * 98) / 100);

        // A single guardian is below the threshold of two.
        uint256 until = block.timestamp + 1 days;
        bytes[] memory one = new bytes[](1);
        one[0] = _sig(gk1, adapter.earlyExitDigest(address(this), until));
        vm.expectRevert(NaveErrors.InvalidGuardianApproval.selector);
        adapter.approveEarlyExit(address(this), until, one);

        adapter.approveEarlyExit(address(this), until, _quorum(adapter, until));
        uint256 out = adapter.withdraw(SUSDE, part, recipient, (part * 98) / 100);
        assertGe(out, (part * 98) / 100);

        // Replaying the same signatures fails (nonce advanced).
        bytes[] memory sigs = _quorumAtNonce(adapter.earlyExitDigest(address(this), until));
        adapter.approveEarlyExit(address(this), until, sigs);
        vm.expectRevert(NaveErrors.InvalidGuardianApproval.selector);
        adapter.approveEarlyExit(address(this), until, sigs);

        // After maturity PT redeems at par through the router, no approval needed.
        vm.warp(adapter.maturity() + 1);
        uint256 rest = adapter.positionValue(SUSDE);
        uint256 got = adapter.withdraw(SUSDE, rest / 2, recipient, (rest / 2) * 99 / 100);
        assertGe(got, (rest / 2) * 99 / 100);
    }

    // ── Helpers ───────────────────────────────────────────────────────────
    /// Longest standard TWAP window the market's observation buffer supports.
    function _pendleTwap() internal view returns (uint32) {
        uint32[3] memory windows = [uint32(900), 600, 300];
        for (uint256 i; i < windows.length; ++i) {
            (bool grow,, bool ok) = IPendleOracleState(PENDLE_ORACLE).getOracleState(
                PENDLE_PT_SUSDE_NOV26, windows[i]
            );
            if (!grow && ok) return windows[i];
        }
        return 300;
    }

    function _quorum(PendlePTAdapter adapter, uint256 until) internal view returns (bytes[] memory) {
        return _quorumAtNonce(adapter.earlyExitDigest(address(this), until));
    }

    function _quorumAtNonce(bytes32 digest) internal view returns (bytes[] memory s) {
        (uint256 lo, uint256 hi) =
            vm.addr(gk1) < vm.addr(gk2) ? (gk1, gk2) : (gk2, gk1);
        s = new bytes[](2);
        s[0] = _sig(lo, digest);
        s[1] = _sig(hi, digest);
    }

    function _sig(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 sv) = vm.sign(key, digest);
        return abi.encodePacked(r, sv, v);
    }

    function _protocolWithSelfAsExecution() internal returns (NaveProtocol p) {
        p = TestProxies.deployProtocol(address(this), address(0xFEE), 0, 0);
        p.setFactory(address(this));
        p.registerDao(makeAddr("t"), makeAddr("g"), address(this));
    }

    function _maybeFork() internal returns (bool) {
        return _maybeForkAt("ETH_MAINNET_RPC_URL");
    }

    function _maybeForkAt(string memory key) internal returns (bool) {
        string memory rpc = vm.envOr(key, string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return false;
        }
        vm.createSelectFork(rpc);
        return true;
    }
}
