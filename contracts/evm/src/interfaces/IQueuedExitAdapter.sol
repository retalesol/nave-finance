// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// Strategy adapters whose venue exit is queued (cooldown / redemption queue).
interface IQueuedExitAdapter {
    /// Start an exit of `amount` underlying for the calling execution; returns
    /// the earliest payout time (`block.timestamp` when the venue gives no ETA).
    function requestExit(address asset, uint256 amount) external returns (uint256 readyAt);
}
