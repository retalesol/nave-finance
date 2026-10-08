// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {BaseStrategyAdapter} from "./BaseStrategyAdapter.sol";
import {IComet} from "./external/IExternalProtocols.sol";
import {AssetKind} from "../libraries/NaveEnums.sol";

/// @title CompoundV3Adapter
/// @notice `IStrategyAdapter` over a Compound v3 (Comet) market on Ethereum or
/// Base. Each Comet has a single base asset (e.g. USDC/WETH); the adapter is
/// configured per market. `comet.balanceOf(this)` is the interest-bearing
/// underlying balance, partitioned per-DAO via the share ledger.
contract CompoundV3Adapter is BaseStrategyAdapter {
    using SafeERC20 for IERC20;

    IComet public immutable comet;
    address public immutable baseToken;

    constructor(address protocol_, address comet_)
        BaseStrategyAdapter(protocol_, AssetKind.Other, "compound-v3")
    {
        comet = IComet(comet_);
        baseToken = IComet(comet_).baseToken();
    }

    function _supply(address asset, uint256 amount, uint256) internal override {
        // Comet base supply is 1:1, so no join slippage applies.
        IERC20(asset).forceApprove(address(comet), amount);
        comet.supply(asset, amount);
    }

    function _redeem(address asset, uint256 amount, address to, uint256)
        internal
        override
        returns (uint256)
    {
        comet.withdrawTo(to, asset, amount);
        return amount;
    }

    function _totalUnderlying(address) internal view override returns (uint256) {
        return comet.balanceOf(address(this));
    }

    function _supportsAsset(address asset) internal view override returns (bool) {
        return asset == baseToken;
    }
}
