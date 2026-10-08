// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {NaveConstants} from "./NaveConstants.sol";

/// @title FeeMath
/// @notice Pure fee + withdrawal-cap math ported 1:1 from
/// `nave_core::utils::fees` and `nave_core::utils::strategy`. All values are in
/// the asset's base units unless stated otherwise.
library FeeMath {
    /// Realized-yield (gain) portion of an `amount`-unit withdrawal and the
    /// performance-fee skim taken from that gain. Returns `(gain, fee)` where
    /// `fee = gain * feeBps / 10_000`. Both `0` at/below principal, when
    /// `feeBps == 0`, or when `amount == 0`. Invariant: `fee <= gain <= amount`.
    /// Caller must guarantee `amount <= currentValue`.
    function calculatePerformanceSkim(
        uint256 amount,
        uint256 depositedAmount,
        uint256 currentValue,
        uint16 feeBps
    ) internal pure returns (uint256 gain, uint256 fee) {
        if (amount == 0 || feeBps == 0 || currentValue == 0 || currentValue <= depositedAmount) {
            return (0, 0);
        }
        uint256 excess = currentValue - depositedAmount;
        gain = (amount * excess) / currentValue;
        fee = (gain * feeBps) / NaveConstants.BPS_DENOMINATOR;
    }

    /// Floor a unix timestamp to the start of its UTC day (00:00:00 UTC). Used
    /// to anchor the annual management-fee cycle to a midnight boundary.
    function floorToUtcMidnight(uint256 ts) internal pure returns (uint256) {
        return ts - (ts % uint256(int256(NaveConstants.SECONDS_PER_DAY)));
    }

    /// Whether the discrete annual management fee is due: at least one full
    /// `SECONDS_PER_YEAR` has elapsed since the anchor.
    function managementFeeDue(uint256 lastCollectedAt, uint256 now_) internal pure returns (bool) {
        return now_ >= lastCollectedAt + uint256(int256(NaveConstants.SECONDS_PER_YEAR));
    }

    /// Annual management fee on a `balance` at `feeBps` (`balance * feeBps / 1e4`).
    function annualManagementFee(uint256 balance, uint16 feeBps) internal pure returns (uint256) {
        if (balance == 0 || feeBps == 0) return 0;
        return (balance * feeBps) / NaveConstants.BPS_DENOMINATOR;
    }

    /// Revised NE-8 cap (realized-yield path): the max cumulative base units a
    /// single request may withdraw is its deployed principal PLUS the position's
    /// marked realized gain (`positionValue - positionDeposited`, saturating).
    function realizedYieldWithdrawCap(
        uint256 requestPrincipal,
        uint256 positionDeposited,
        uint256 positionValue
    ) internal pure returns (uint256) {
        uint256 gain = positionValue > positionDeposited ? positionValue - positionDeposited : 0;
        return requestPrincipal + gain;
    }

    /// Reduce a position's principal PROPORTIONALLY to the marked value being
    /// unwound (mirrors `record_strategy_withdrawal`). Returns the principal
    /// unwound for `amount` out of `currentValue` given `depositedAmount`.
    function proportionalPrincipalUnwound(
        uint256 amount,
        uint256 depositedAmount,
        uint256 currentValue
    ) internal pure returns (uint256) {
        if (currentValue == 0) return 0;
        uint256 unwound = (amount * depositedAmount) / currentValue;
        return unwound < depositedAmount ? unwound : depositedAmount;
    }
}
