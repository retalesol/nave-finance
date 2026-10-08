// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {NaveStructs} from "./NaveStructs.sol";
import {NaveConstants} from "./NaveConstants.sol";
import {NaveErrors} from "./NaveErrors.sol";
import {FeeMath} from "./FeeMath.sol";

/// @title TreasuryStrategyLib
/// @notice Strategy position accounting extracted from `NaveTreasury`.
library TreasuryStrategyLib {
    struct Position {
        bool initialized;
        address asset;
        uint256 depositedAmount;
        uint256 currentValue;
        uint256 lastUpdated;
        /// SEC-M5: last MANUAL mark ({updatePositionValue}) timestamp — the
        /// mark cooldown keys on this, not on pipeline deposits/withdrawals.
        uint256 lastMarkedAt;
    }

    function recordDeposit(
        Position storage pos,
        NaveStructs.AssetRecord storage a,
        address adapter,
        address asset,
        uint256 amount,
        uint256 amountUsd
    ) external {
        pos.initialized = true;
        pos.asset = asset;
        pos.depositedAmount += amount;
        pos.currentValue += amount;
        pos.lastUpdated = block.timestamp;
        a.deployedCapitalBase += amount;
    }

    /// @return perfFeeSkimmed Performance fee taken in asset base units.
    /// @return newDeployedCapital Updated treasury-level deployed USD counter.
    function recordWithdrawal(
        Position storage pos,
        NaveStructs.AssetRecord storage a,
        uint256 deployedCapital,
        uint16 feeBps,
        address asset,
        uint256 amount,
        uint256 amountUsd
    ) external returns (uint256 perfFeeSkimmed, uint256 newDeployedCapital, uint256 gain) {
        if (pos.currentValue < amount) revert NaveErrors.InsufficientVaultBalance();

        (gain, perfFeeSkimmed) =
            FeeMath.calculatePerformanceSkim(amount, pos.depositedAmount, pos.currentValue, feeBps);

        uint256 principalUnwound =
            FeeMath.proportionalPrincipalUnwound(amount, pos.depositedAmount, pos.currentValue);

        pos.depositedAmount -= principalUnwound;
        pos.currentValue -= amount;
        pos.lastUpdated = block.timestamp;

        a.deployedCapitalBase -= principalUnwound < a.deployedCapitalBase
            ? principalUnwound
            : a.deployedCapitalBase;
        newDeployedCapital = deployedCapital > amountUsd ? deployedCapital - amountUsd : 0;
    }

    /// SEC-M5 (parity with the audited Solana M8 fix): manual marks feed the
    /// allocation cap, the realized-yield withdrawal cap, and the perf-fee
    /// gain/principal split, so an unbounded single call could hide deployed
    /// capital or inflate fictitious gains. Bound each mark to a
    /// MAX_POSITION_MARK_STEP_BPS (50%) step from the pre-update value (or
    /// depositedAmount if never marked) and enforce a 5-minute cooldown so the
    /// step bound also bounds total drift per unit time.
    function updatePositionValue(Position storage pos, uint256 newValue) external {
        if (!pos.initialized) revert NaveErrors.ProtocolNotApproved();
        if (
            pos.lastMarkedAt > 0
                && block.timestamp - pos.lastMarkedAt < NaveConstants.POSITION_MARK_COOLDOWN_SECS
        ) {
            revert NaveErrors.PositionMarkOutOfBounds();
        }
        uint256 base = pos.currentValue > 0 ? pos.currentValue : pos.depositedAmount;
        if (base > 0) {
            uint256 step = (base * NaveConstants.MAX_POSITION_MARK_STEP_BPS)
                / NaveConstants.BPS_DENOMINATOR;
            if (newValue > base + step || newValue + step < base) {
                revert NaveErrors.PositionMarkOutOfBounds();
            }
        }
        pos.currentValue = newValue;
        pos.lastUpdated = block.timestamp;
        pos.lastMarkedAt = block.timestamp;
    }
}
