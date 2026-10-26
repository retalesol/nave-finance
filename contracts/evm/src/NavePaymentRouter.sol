// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";

import {IWETH} from "./interfaces/IWETH.sol";
import {NaveErrors} from "./libraries/NaveErrors.sol";

/// @notice Treasury surface this router needs. `deposit` pulls `amount` of
/// `asset` from `msg.sender`, so the forwarder must hold the tokens and
/// approve the treasury. `VaultDeposited.depositor` is then the forwarder.
interface IPaymentTreasury {
    function deposit(address asset, uint256 amount) external;
    function protocol() external view returns (address);
}

interface IPaymentProtocol {
    function wrappedNative() external view returns (address);
}

/// @title NavePaymentForwarder
/// @notice CREATE2 payment address for one `(treasury, invoiceId, asset)`.
/// `asset == address(0)` receives native ETH. Every other asset receives that
/// ERC-20. Sweep is permissionless and can only pay the bound treasury.
contract NavePaymentForwarder {
    using SafeERC20 for IERC20;

    /// Re-entered `sweep` while a deposit is in progress.
    error SweepInProgress();
    /// `deposit` returned without pulling the tokens this forwarder approved.
    error DepositNotPulled();

    /// @notice Bound treasury proxy.
    address public immutable treasury;
    /// @notice Books invoice id. Attribution for indexers that watch this event.
    bytes32 public immutable invoiceId;
    /// @notice `address(0)` for native ETH. Otherwise the ERC-20 customers pay.
    address public immutable asset;

    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;
    uint256 private _status;

    /// Swept balance was passed to `NaveTreasury.deposit`.
    /// @param asset The CREATE2 asset (`address(0)` when the invoice is native ETH).
    /// @param depositAsset The ERC-20 `deposit` was called with. WETH for native ETH.
    event InvoiceSwept(
        address indexed treasury,
        bytes32 indexed invoiceId,
        address indexed asset,
        address forwarder,
        address depositAsset,
        uint256 amount
    );

    constructor(address treasury_, bytes32 invoiceId_, address asset_) {
        if (treasury_ == address(0)) revert NaveErrors.ZeroAddress();
        treasury = treasury_;
        invoiceId = invoiceId_;
        asset = asset_;
        _status = _NOT_ENTERED;
    }

    receive() external payable {}

    modifier nonReentrant() {
        if (_status == _ENTERED) revert SweepInProgress();
        _status = _ENTERED;
        _;
        _status = _NOT_ENTERED;
    }

    /// @notice Pull this address's balance into the treasury via `deposit`.
    /// A zero balance is a successful no-op so a crank can retry.
    function sweep() external nonReentrant returns (uint256 amount) {
        address depositAsset;
        if (asset == address(0)) {
            (depositAsset, amount) = _wrapNative();
        } else {
            depositAsset = asset;
            amount = IERC20(asset).balanceOf(address(this));
        }
        if (amount == 0) return 0;

        uint256 beforeBal = IERC20(depositAsset).balanceOf(address(this));
        IERC20(depositAsset).forceApprove(treasury, amount);
        IPaymentTreasury(treasury).deposit(depositAsset, amount);
        if (IERC20(depositAsset).balanceOf(address(this)) != beforeBal - amount) {
            revert DepositNotPulled();
        }
        emit InvoiceSwept(treasury, invoiceId, asset, address(this), depositAsset, amount);
    }

    /// Wrap the entire native balance into the treasury protocol's WETH, then
    /// report the full WETH balance (including any WETH already sent here).
    function _wrapNative() internal returns (address weth, uint256 amount) {
        weth = IPaymentProtocol(IPaymentTreasury(treasury).protocol()).wrappedNative();
        uint256 ethBal = address(this).balance;
        if (ethBal > 0) {
            if (weth == address(0)) revert NaveErrors.WrappedNativeNotConfigured();
            uint256 beforeWeth = IERC20(weth).balanceOf(address(this));
            IWETH(weth).deposit{value: ethBal}();
            if (IERC20(weth).balanceOf(address(this)) != beforeWeth + ethBal) {
                revert DepositNotPulled();
            }
        }
        if (weth == address(0)) return (address(0), 0);
        amount = IERC20(weth).balanceOf(address(this));
    }
}

/// @title NavePaymentRouter
/// @notice Protocol CREATE2 factory for per-invoice payment addresses.
/// @dev The address is known before deployment:
///      `CREATE2(this, keccak256(abi.encode(treasury, invoiceId, asset)), initCode)`
///      where `initCode` is `NavePaymentForwarder` constructed with that same
///      triple. Changing the forwarder bytecode changes every predicted address.
///      This router is not upgradeable so a deployed instance keeps its addresses.
contract NavePaymentRouter {
    /// CREATE2 produced a different address than `predictAddress`.
    error ForwarderMismatch(address predicted, address created);

    /// @notice Address that will hold funds for this invoice and asset.
    /// `asset == address(0)` is the native ETH address. The treasury must be
    /// non-zero. The invoice id may be zero.
    function predictAddress(address treasury, bytes32 invoiceId, address asset)
        public
        view
        returns (address)
    {
        if (treasury == address(0)) revert NaveErrors.ZeroAddress();
        return Create2.computeAddress(
            _salt(treasury, invoiceId, asset),
            keccak256(_initCode(treasury, invoiceId, asset)),
            address(this)
        );
    }

    /// @notice Deploy the forwarder if it is not already deployed.
    function deploy(address treasury, bytes32 invoiceId, address asset)
        public
        returns (address forwarder)
    {
        forwarder = predictAddress(treasury, invoiceId, asset);
        if (forwarder.code.length != 0) return forwarder;
        address created = Create2.deploy(
            0, _salt(treasury, invoiceId, asset), _initCode(treasury, invoiceId, asset)
        );
        if (created != forwarder) revert ForwarderMismatch(forwarder, created);
    }

    /// @notice Deploy if needed, then sweep. Permissionless. Returns the amount
    /// passed to `NaveTreasury.deposit`, or zero when the forwarder was empty.
    function sweep(address treasury, bytes32 invoiceId, address asset)
        external
        returns (uint256 amount)
    {
        address forwarder = deploy(treasury, invoiceId, asset);
        amount = NavePaymentForwarder(payable(forwarder)).sweep();
    }

    function _salt(address treasury, bytes32 invoiceId, address asset)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(treasury, invoiceId, asset));
    }

    function _initCode(address treasury, bytes32 invoiceId, address asset)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(
            type(NavePaymentForwarder).creationCode, abi.encode(treasury, invoiceId, asset)
        );
    }
}
