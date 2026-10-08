// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {BaseStrategyAdapter} from "./BaseStrategyAdapter.sol";
import {IAaveV3Pool} from "./external/IExternalProtocols.sol";
import {AssetKind} from "../libraries/NaveEnums.sol";

/// @title AaveV3Adapter
/// @notice `IStrategyAdapter` over the Aave v3 lending pool (Ethereum + Base).
/// Supplies the DAO's asset to earn the supply APY; aTokens are held by the
/// adapter and partitioned per-DAO via the {BaseStrategyAdapter} share ledger.
contract AaveV3Adapter is BaseStrategyAdapter {
    using SafeERC20 for IERC20;

    IAaveV3Pool public immutable pool;

    constructor(address protocol_, address pool_)
        BaseStrategyAdapter(protocol_, AssetKind.Other, "aave-v3")
    {
        pool = IAaveV3Pool(pool_);
    }

    function _supply(address asset, uint256 amount, uint256) internal override {
        // Aave supplies 1:1 (aToken mints at par), so no join slippage applies.
        IERC20(asset).forceApprove(address(pool), amount);
        pool.supply(asset, amount, address(this), 0);
    }

    function _redeem(address asset, uint256 amount, address to, uint256)
        internal
        override
        returns (uint256)
    {
        // Aave returns exactly `amount` underlying (capped at the position), so
        // the caller's `minOut` is enforced by the base contract's post-check.
        return pool.withdraw(asset, amount, to);
    }

    function _totalUnderlying(address asset) internal view override returns (uint256) {
        address aToken = pool.getReserveData(asset).aTokenAddress;
        if (aToken == address(0)) return 0;
        return IERC20(aToken).balanceOf(address(this));
    }

    function _supportsAsset(address asset) internal view override returns (bool) {
        return pool.getReserveData(asset).aTokenAddress != address(0);
    }

    /// The aToken backing `asset` (for reconciliation / off-chain indexing).
    function aTokenFor(address asset) external view returns (address) {
        return pool.getReserveData(asset).aTokenAddress;
    }
}
