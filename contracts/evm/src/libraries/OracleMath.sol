// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {NaveConstants} from "./NaveConstants.sol";
import {NaveErrors} from "./NaveErrors.sol";

/// @title OracleMath
/// @notice USD valuation + Pyth confidence guard ported 1:1 from
/// `nave_core::utils::oracle`. Results are in micro-USD (1e6).
library OracleMath {
    /// Deterministic Pyth confidence-interval guard: reject any price whose
    /// 1-sigma confidence band exceeds `PYTH_MAX_CONFIDENCE_BPS` (2%) of the
    /// price. Returns false (reject) when `price <= 0`.
    function confidenceWithinBounds(int64 price, uint64 conf) internal pure returns (bool) {
        if (price <= 0) return false;
        uint256 lhs = uint256(conf) * NaveConstants.BPS_DENOMINATOR;
        uint256 rhs = uint256(uint64(price)) * NaveConstants.PYTH_MAX_CONFIDENCE_BPS;
        return lhs <= rhs;
    }

    /// Convert a token `balance` (base units) into micro-USD (1e6) given a Pyth
    /// price and its (typically negative) exponent.
    ///   micro_usd = balance * price * 10^(exponent + 6 - decimals)
    function valueUsd(uint256 balance, uint8 decimals, int64 price, int32 exponent)
        internal
        pure
        returns (uint256)
    {
        if (price <= 0) revert NaveErrors.InvalidOraclePrice();
        uint256 base = balance * uint256(uint64(price));
        int256 exp = int256(exponent) + 6 - int256(uint256(decimals));
        if (exp >= 0) {
            return base * (10 ** uint256(exp));
        } else {
            return base / (10 ** uint256(-exp));
        }
    }

    /// Value a USD-pegged stablecoin `balance` at exactly $1, in micro-USD.
    ///   micro_usd = balance * 10^(6 - decimals)
    function valueStable(uint256 balance, uint8 decimals) internal pure returns (uint256) {
        int256 exp = int256(6) - int256(uint256(decimals));
        if (exp >= 0) {
            return balance * (10 ** uint256(exp));
        } else {
            return balance / (10 ** uint256(-exp));
        }
    }

    /// Inverse of {valueStable}: micro-USD -> stablecoin base units.
    function usdToStableBase(uint256 usdMicro, uint8 decimals) internal pure returns (uint256) {
        int256 exp = int256(uint256(decimals)) - 6;
        if (exp >= 0) {
            return usdMicro * (10 ** uint256(exp));
        } else {
            return usdMicro / (10 ** uint256(-exp));
        }
    }
}
