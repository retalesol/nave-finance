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
        a.markedValueBase += amount;
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
        a.markedValueBase -= amount < a.markedValueBase ? amount : a.markedValueBase;
        newDeployedCapital = deployedCapital > amountUsd ? deployedCapital - amountUsd : 0;
    }

    /// Apply a mark read from the adapter by `NaveExecution.syncPositionValue`.
    /// Marks feed the allocation cap, the realized-yield withdrawal cap and the
    /// performance-fee split, so upward moves are capped at
    /// MAX_POSITION_DRIFT_BPS_PER_DAY of max(currentValue, principal) per day
    /// since the last update (a manipulated adapter read cannot mint fictitious
    /// gains). Losses are applied in full.
    /// @return applied The value actually booked.
    function syncPositionValue(
        Position storage pos,
        NaveStructs.AssetRecord storage a,
        uint256 observed
    ) external returns (uint256 applied) {
        if (!pos.initialized) revert NaveErrors.ProtocolNotApproved();
        uint256 base = pos.currentValue > pos.depositedAmount ? pos.currentValue : pos.depositedAmount;
        uint256 maxUp = base
            + (base * NaveConstants.MAX_POSITION_DRIFT_BPS_PER_DAY * (block.timestamp - pos.lastUpdated))
                / (NaveConstants.BPS_DENOMINATOR * uint256(int256(NaveConstants.SECONDS_PER_DAY)));
        applied = observed > maxUp ? maxUp : observed;
        uint256 previous = pos.currentValue;
        a.markedValueBase = a.markedValueBase - (previous < a.markedValueBase ? previous : a.markedValueBase) + applied;
        pos.currentValue = applied;
        pos.lastUpdated = block.timestamp;
        pos.lastMarkedAt = block.timestamp;
    }
}
