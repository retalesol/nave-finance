// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {NaveConstants} from "./NaveConstants.sol";
import {NaveErrors} from "./NaveErrors.sol";

/// @title BpsGates
/// @notice Constitution allocation / deployment / liquidity / reserve gates,
/// ported 1:1 from `nave_core::utils::strategy` + the execution-side
/// `enforce_constitution_global_limits` / `enforce_stablecoin_reserve`. All USD
/// inputs are micro-USD (1e6). A `0` bps disables that particular ceiling/floor.
library BpsGates {
    uint256 private constant BPS = 10_000;

    /// Per-protocol cumulative allocation cap: `alreadyDeployed + amount <=
    /// nav * maxAllocationBps / 1e4`.
    function enforceAllocationCap(
        uint256 currentNav,
        uint16 maxAllocationBps,
        uint256 alreadyDeployed,
        uint256 amount
    ) internal pure {
        uint256 cap = (currentNav * maxAllocationBps) / BPS;
        if (alreadyDeployed + amount > cap) revert NaveErrors.AllocationLimitExceeded();
    }

    /// Global deployment cap + liquidity floor against NAV using `deployedCapital`.
    function enforceGlobalLimits(
        uint256 currentNav,
        uint256 deployedCapital,
        uint256 amount,
        uint16 maxTotalDeployedBps,
        uint16 minLiquidityBps
    ) internal pure {
        uint256 projected = deployedCapital + amount;
        if (maxTotalDeployedBps > 0) {
            uint256 cap = (currentNav * maxTotalDeployedBps) / BPS;
            if (projected > cap) revert NaveErrors.DeploymentCapExceeded();
        }
        if (minLiquidityBps > 0) {
            uint256 deployableBps = minLiquidityBps >= 10_000 ? 0 : 10_000 - minLiquidityBps;
            uint256 maxDeployable = (currentNav * deployableBps) / BPS;
            if (projected > maxDeployable) revert NaveErrors.LiquidityFloorBreached();
        }
    }

    /// Per-asset stablecoin reserve floor: idle stable USD after a deployment
    /// must still cover `minReserveBps` of NAV. No-op when the asset is not a
    /// stablecoin or the floor is unset.
    function enforceStablecoinReserve(
        uint256 currentNav,
        uint16 minReserveBps,
        bool isStablecoin,
        uint256 idleAfterUsd
    ) internal pure {
        if (!isStablecoin || minReserveBps == 0) return;
        uint256 reserveRequired = (currentNav * minReserveBps) / BPS;
        if (idleAfterUsd < reserveRequired) revert NaveErrors.StablecoinReserveBreached();
    }

    /// On-chain enforceable deployment ceiling in bps (0..=10000): min of the
    /// explicit global cap and the liquidity-implied ceiling.
    function effectiveMaxDeployedBps(uint16 maxTotalDeployedBps, uint16 minLiquidityBps)
        internal
        pure
        returns (uint16)
    {
        uint16 liquidityCeiling = minLiquidityBps >= 10_000 ? 0 : 10_000 - minLiquidityBps;
        if (maxTotalDeployedBps == 0) return liquidityCeiling;
        return maxTotalDeployedBps < liquidityCeiling ? maxTotalDeployedBps : liquidityCeiling;
    }
}
