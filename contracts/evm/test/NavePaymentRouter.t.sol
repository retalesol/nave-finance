// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Vm} from "forge-std/Vm.sol";

import {NaveBase} from "./NaveBase.t.sol";
import {NavePaymentForwarder, NavePaymentRouter} from "../src/NavePaymentRouter.sol";
import {NaveTreasury} from "../src/NaveTreasury.sol";
import {NaveErrors} from "../src/libraries/NaveErrors.sol";
import {NaveConstants} from "../src/libraries/NaveConstants.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/// Token whose `transferFrom` calls back into the forwarder sweep.
contract ReenteringToken is ERC20 {
    address public hook;

    constructor() ERC20("Reentering", "RE") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setHook(address hook_) external {
        hook = hook_;
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        if (hook != address(0)) {
            NavePaymentForwarder(payable(hook)).sweep();
        }
        return super.transferFrom(from, to, amount);
    }
}

contract NavePaymentRouterTest is NaveBase {
    NavePaymentRouter internal router;
    NaveTreasury internal treasury;

    bytes32 internal constant VAULT_DEPOSITED =
        keccak256("VaultDeposited(address,address,uint256,uint256)");
    bytes32 internal constant INVOICE_SWEPT =
        keccak256("InvoiceSwept(address,bytes32,address,address,address,uint256)");

    function setUp() public override {
        super.setUp();
        (treasury,,) = _createDao(0);
        router = new NavePaymentRouter();
    }

    function _registerUsdc() internal {
        vm.prank(founder);
        treasury.registerAsset(address(usdc), bytes32(0), true, 0);
    }

    function _registerWeth() internal {
        vm.prank(founder);
        treasury.registerAsset(address(weth), NaveConstants.PYTH_ETH_USD_FEED_ID, false, 0);
    }

    function _log(Vm.Log[] memory logs, bytes32 topic0, address emitter)
        internal
        pure
        returns (Vm.Log memory)
    {
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == emitter && logs[i].topics[0] == topic0) return logs[i];
        }
        revert("missing log");
    }

    function test_predictAddress_isKnownBeforeDeployAndUnique() public {
        bytes32 invoiceId = keccak256("invoice-1");
        address predicted = router.predictAddress(address(treasury), invoiceId, address(usdc));
        assertEq(predicted.code.length, 0);

        address otherInvoice =
            router.predictAddress(address(treasury), keccak256("invoice-2"), address(usdc));
        address nativeInvoice = router.predictAddress(address(treasury), invoiceId, address(0));
        address otherTreasury = router.predictAddress(makeAddr("other"), invoiceId, address(usdc));
        NavePaymentRouter second = new NavePaymentRouter();
        address otherRouter = second.predictAddress(address(treasury), invoiceId, address(usdc));
        assertTrue(predicted != otherInvoice);
        assertTrue(predicted != nativeInvoice);
        assertTrue(predicted != otherTreasury);
        assertTrue(predicted != otherRouter);

        // A zero invoice id is a valid id. A zero treasury is not.
        assertTrue(
            router.predictAddress(address(treasury), bytes32(0), address(usdc)) != address(0)
        );
        vm.expectRevert(NaveErrors.ZeroAddress.selector);
        router.predictAddress(address(0), invoiceId, address(usdc));

        address deployed = router.deploy(address(treasury), invoiceId, address(usdc));
        assertEq(deployed, predicted);
        assertGt(predicted.code.length, 0);
        assertEq(router.deploy(address(treasury), invoiceId, address(usdc)), predicted);

        NavePaymentForwarder forwarder = NavePaymentForwarder(payable(predicted));
        assertEq(forwarder.treasury(), address(treasury));
        assertEq(forwarder.invoiceId(), invoiceId);
        assertEq(forwarder.asset(), address(usdc));
    }

    function test_sweep_erc20_creditsDepositAndAttributesTheForwarder() public {
        _registerUsdc();
        bytes32 invoiceId = keccak256("usdc-invoice");
        uint256 amount = 250e6;
        address forwarder = router.predictAddress(address(treasury), invoiceId, address(usdc));

        // Direct deposit establishes the counter delta `deposit` itself writes.
        address user = makeAddr("user");
        usdc.mint(user, amount);
        vm.startPrank(user);
        usdc.approve(address(treasury), amount);
        treasury.deposit(address(usdc), amount);
        vm.stopPrank();
        uint256 afterDirect = treasury.totalDeposited();
        assertEq(afterDirect, amount);
        assertEq(treasury.currentNav(), amount);

        // Tokens can land before the forwarder contract exists.
        usdc.mint(forwarder, amount);
        assertEq(forwarder.code.length, 0);

        vm.recordLogs();
        address relayer = makeAddr("relayer");
        vm.prank(relayer);
        uint256 swept = router.sweep(address(treasury), invoiceId, address(usdc));

        assertEq(swept, amount);
        assertEq(usdc.balanceOf(forwarder), 0);
        assertEq(usdc.balanceOf(address(treasury)), amount * 2);
        assertEq(treasury.totalDeposited(), afterDirect + amount);
        assertEq(treasury.currentNav(), afterDirect + amount);
        // `deposit` seeds the high-water mark only while it is still zero.
        assertEq(treasury.highWaterMark(), afterDirect);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        Vm.Log memory deposited = _log(logs, VAULT_DEPOSITED, address(treasury));
        (address depositor, address mint, uint256 loggedAmount, uint256 newNav) =
            abi.decode(deposited.data, (address, address, uint256, uint256));
        assertEq(depositor, forwarder);
        assertTrue(depositor != relayer);
        assertTrue(depositor != address(router));
        assertEq(mint, address(usdc));
        assertEq(loggedAmount, amount);
        assertEq(newNav, afterDirect + amount);

        Vm.Log memory sweptLog = _log(logs, INVOICE_SWEPT, forwarder);
        assertEq(address(uint160(uint256(sweptLog.topics[1]))), address(treasury));
        assertEq(sweptLog.topics[2], invoiceId);
        assertEq(address(uint160(uint256(sweptLog.topics[3]))), address(usdc));
        (address loggedForwarder, address depositAsset, uint256 sweptAmount) =
            abi.decode(sweptLog.data, (address, address, uint256));
        assertEq(loggedForwarder, forwarder);
        assertEq(depositAsset, address(usdc));
        assertEq(sweptAmount, amount);
    }

    function test_sweep_erc20_isIdempotentAndTakesALaterPayment() public {
        _registerUsdc();
        bytes32 invoiceId = keccak256("partial");
        address forwarder = router.predictAddress(address(treasury), invoiceId, address(usdc));
        usdc.mint(forwarder, 40e6);

        assertEq(router.sweep(address(treasury), invoiceId, address(usdc)), 40e6);
        assertEq(router.sweep(address(treasury), invoiceId, address(usdc)), 0);
        assertEq(treasury.totalDeposited(), 40e6);

        usdc.mint(forwarder, 10e6);
        assertEq(NavePaymentForwarder(payable(forwarder)).sweep(), 10e6);
        assertEq(usdc.balanceOf(address(treasury)), 50e6);
        assertEq(treasury.totalDeposited(), 50e6);
        assertEq(treasury.currentNav(), 50e6);
    }

    function test_sweep_leavesTokensThatAreNotTheInvoiceAsset() public {
        _registerUsdc();
        MockERC20 other = new MockERC20("Other", "OTH", 6);
        bytes32 invoiceId = keccak256("usdc-only");
        address forwarder = router.predictAddress(address(treasury), invoiceId, address(usdc));
        usdc.mint(forwarder, 15e6);
        other.mint(forwarder, 15e6);

        router.sweep(address(treasury), invoiceId, address(usdc));
        assertEq(usdc.balanceOf(forwarder), 0);
        assertEq(other.balanceOf(forwarder), 15e6);
        assertEq(usdc.balanceOf(address(treasury)), 15e6);
    }

    function test_sweep_native_wrapsToWethAndCallsDeposit() public {
        _registerUsdc();
        _registerWeth();
        address user = makeAddr("user");
        usdc.mint(user, 100e6);
        vm.startPrank(user);
        usdc.approve(address(treasury), 100e6);
        treasury.deposit(address(usdc), 100e6);
        vm.stopPrank();
        _revalueTreasury(treasury);
        assertGt(treasury.lastRevaluedAt(), 0);
        assertEq(treasury.currentNav(), 100e6);

        bytes32 invoiceId = keccak256("eth-invoice");
        uint256 amount = 0.4 ether;
        address forwarder = router.predictAddress(address(treasury), invoiceId, address(0));
        vm.deal(forwarder, amount);
        assertEq(forwarder.code.length, 0);

        vm.recordLogs();
        uint256 swept = router.sweep(address(treasury), invoiceId, address(0));

        assertEq(swept, amount);
        assertEq(address(forwarder).balance, 0);
        assertEq(weth.balanceOf(forwarder), 0);
        assertEq(address(treasury).balance, 0, "ETH is wrapped before deposit, not forwarded raw");
        assertEq(weth.balanceOf(address(treasury)), amount);
        assertEq(treasury.currentNav(), 100e6, "non-stable deposit does not credit NAV");
        assertEq(treasury.totalDeposited(), 100e6);
        assertEq(treasury.lastRevaluedAt(), 0);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        Vm.Log memory deposited = _log(logs, VAULT_DEPOSITED, address(treasury));
        (address depositor, address mint, uint256 loggedAmount,) =
            abi.decode(deposited.data, (address, address, uint256, uint256));
        assertEq(depositor, forwarder);
        assertEq(mint, address(weth));
        assertEq(loggedAmount, amount);

        Vm.Log memory sweptLog = _log(logs, INVOICE_SWEPT, forwarder);
        assertEq(sweptLog.topics[2], invoiceId);
        assertEq(address(uint160(uint256(sweptLog.topics[3]))), address(0));
        (, address depositAsset, uint256 sweptAmount) =
            abi.decode(sweptLog.data, (address, address, uint256));
        assertEq(depositAsset, address(weth));
        assertEq(sweptAmount, amount);

        assertEq(router.sweep(address(treasury), invoiceId, address(0)), 0);

        vm.deal(forwarder, 0.1 ether);
        assertEq(router.sweep(address(treasury), invoiceId, address(0)), 0.1 ether);
        assertEq(weth.balanceOf(address(treasury)), amount + 0.1 ether);
    }

    function test_sweep_native_doesNotTakeAnErc20Balance() public {
        _registerWeth();
        bytes32 invoiceId = keccak256("eth-not-usdc");
        address forwarder = router.predictAddress(address(treasury), invoiceId, address(0));
        usdc.mint(forwarder, 20e6);
        vm.deal(forwarder, 0.2 ether);

        router.sweep(address(treasury), invoiceId, address(0));
        assertEq(usdc.balanceOf(forwarder), 20e6);
        assertEq(weth.balanceOf(address(treasury)), 0.2 ether);
    }

    function test_sweep_revertsWithoutCreditingWhenDepositCannotRun() public {
        bytes32 invoiceId = keccak256("early");
        address forwarder = router.predictAddress(address(treasury), invoiceId, address(usdc));
        usdc.mint(forwarder, 30e6);

        vm.expectRevert(NaveErrors.AssetNotRegistered.selector);
        router.sweep(address(treasury), invoiceId, address(usdc));
        assertEq(forwarder.code.length, 0);
        assertEq(usdc.balanceOf(forwarder), 30e6);
        assertEq(treasury.totalDeposited(), 0);

        _registerUsdc();
        router.deploy(address(treasury), invoiceId, address(usdc));
        vm.prank(founder);
        treasury.setAssetEnabled(address(usdc), false);
        vm.expectRevert(NaveErrors.AssetDisabled.selector);
        router.sweep(address(treasury), invoiceId, address(usdc));
        assertEq(usdc.balanceOf(forwarder), 30e6);

        vm.prank(founder);
        treasury.setAssetEnabled(address(usdc), true);
        vm.prank(owner);
        protocol.setPaused(true);
        vm.expectRevert(NaveErrors.GlobalPaused.selector);
        router.sweep(address(treasury), invoiceId, address(usdc));
        assertEq(usdc.balanceOf(forwarder), 30e6);
        assertEq(treasury.totalDeposited(), 0);

        vm.prank(owner);
        protocol.setPaused(false);
        assertEq(router.sweep(address(treasury), invoiceId, address(usdc)), 30e6);
        assertEq(treasury.totalDeposited(), 30e6);
        assertEq(treasury.currentNav(), 30e6);
    }

    function test_sweep_reentrancyDoesNotDoubleCredit() public {
        ReenteringToken token = new ReenteringToken();
        vm.prank(founder);
        treasury.registerAsset(address(token), bytes32(0), true, 0);

        bytes32 invoiceId = keccak256("reenter");
        address forwarder = router.predictAddress(address(treasury), invoiceId, address(token));
        token.setHook(forwarder);
        token.mint(forwarder, 80e6);

        vm.expectRevert(NavePaymentForwarder.SweepInProgress.selector);
        router.sweep(address(treasury), invoiceId, address(token));
        assertEq(token.balanceOf(forwarder), 80e6);
        assertEq(token.balanceOf(address(treasury)), 0);
        assertEq(treasury.totalDeposited(), 0);
    }

    function test_emptySweep_deploysAndReturnsZero() public {
        _registerUsdc();
        bytes32 invoiceId = keccak256("empty");
        address forwarder = router.predictAddress(address(treasury), invoiceId, address(usdc));
        assertEq(router.sweep(address(treasury), invoiceId, address(usdc)), 0);
        assertGt(forwarder.code.length, 0);
        assertEq(treasury.totalDeposited(), 0);
        assertEq(usdc.balanceOf(address(treasury)), 0);
    }
}
