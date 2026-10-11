// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {BaseStrategyAdapter} from "./BaseStrategyAdapter.sol";
import {NaveErrors} from "../libraries/NaveErrors.sol";
import {AssetKind} from "../libraries/NaveEnums.sol";

/// @title QueuedExitAdapter
/// @notice Base for venues whose exit cannot settle inside one transaction
/// (Ethena cooldown, Maple redemption queue). Exits are two-step:
///   1. `NaveExecution.requestStrategyExit` -> {requestExit}: the amount leaves
///      the share ledger and the venue exit starts.
///   2. Once the venue releases funds, {settle} (permissionless, also run by
///      every request/withdraw) moves them into the requester's claim and
///      `NaveExecution.withdrawFromStrategy` pays the claim out.
/// The venue runs one exit per owner, so the adapter runs one exit at a time.
/// Each deployment supports a single underlying asset.
abstract contract QueuedExitAdapter is BaseStrategyAdapter {
    using SafeERC20 for IERC20;

    address public immutable underlying;

    address public pendingExitOwner;
    uint256 public pendingExitAmount;
    uint256 public pendingExitReadyAt;
    /// execution => underlying ready to withdraw
    mapping(address => uint256) public claims;
    uint256 public totalClaims;

    event ExitSettled(address indexed execution, uint256 requested, uint256 credited);

    constructor(address protocol_, address underlying_, string memory protocolId_)
        BaseStrategyAdapter(protocol_, AssetKind.Stable, protocolId_)
    {
        if (underlying_ == address(0)) revert NaveErrors.ZeroAddress();
        underlying = underlying_;
    }

    /// Credit a finished venue exit to its requester. No-op while pending.
    function settle() external nonReentrant {
        _settle();
    }

    /// Whether the pending exit (if any) can be settled now.
    function exitReady() external view returns (bool) {
        return pendingExitOwner != address(0) && _venueExitDone();
    }

    function _queuedExit() internal pure override returns (bool) {
        return true;
    }

    function _queueExit(address caller, address, uint256 amount)
        internal
        override
        returns (uint256 readyAt)
    {
        _settle();
        if (pendingExitOwner != address(0)) revert NaveErrors.ExitInProgress();
        readyAt = _startVenueExit(amount);
        pendingExitOwner = caller;
        pendingExitAmount = amount;
        pendingExitReadyAt = readyAt;
    }

    function _payClaim(address caller, address asset, uint256 amount, address to)
        internal
        override
        returns (uint256)
    {
        _settle();
        if (amount > claims[caller]) revert NaveErrors.ExitNotReady();
        claims[caller] -= amount;
        totalClaims -= amount;
        IERC20(asset).safeTransfer(to, amount);
        return amount;
    }

    function _owedTo(address caller, address asset) internal view override returns (uint256) {
        if (asset != underlying) return 0;
        uint256 owed = claims[caller];
        if (pendingExitOwner == caller) owed += pendingExitAmount;
        return owed;
    }

    function _settle() internal {
        address owner = pendingExitOwner;
        if (owner == address(0) || !_venueExitDone()) return;
        _finishVenueExit();
        uint256 requested = pendingExitAmount;
        uint256 arrived = IERC20(underlying).balanceOf(address(this)) - totalClaims;
        // A venue loss while queued is borne by the requester. Idle surplus is
        // not counted in the ledger value: deposits measure value before and
        // after supply while the incoming funds already sit in the adapter.
        uint256 credited = arrived < requested ? arrived : requested;
        claims[owner] += credited;
        totalClaims += credited;
        delete pendingExitOwner;
        delete pendingExitAmount;
        delete pendingExitReadyAt;
        emit ExitSettled(owner, requested, credited);
    }

    function _supportsAsset(address asset) internal view override returns (bool) {
        return asset == underlying;
    }

    function _redeem(address, uint256, address, uint256) internal pure override returns (uint256) {
        revert NaveErrors.ExitNotReady();
    }

    function _startVenueExit(uint256 amount) internal virtual returns (uint256 readyAt);
    function _venueExitDone() internal view virtual returns (bool);
    function _finishVenueExit() internal virtual;
}
