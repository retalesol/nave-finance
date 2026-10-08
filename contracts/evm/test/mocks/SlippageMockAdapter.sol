// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseStrategyAdapter} from "../../src/adapters/BaseStrategyAdapter.sol";
import {AssetKind} from "../../src/libraries/NaveEnums.sol";

/// @notice A {BaseStrategyAdapter} that declares itself slippage-bearing (like
/// Balancer/Curve) but uses no-op protocol hooks, so the mainnet `minOut == 0`
/// guard (C-3/C-4) and the dead-share first-deposit floor (C-2) can be unit
/// tested without a live DEX fork.
contract SlippageMockAdapter is BaseStrategyAdapter {
    address public immutable asset;
    uint256 public pooled;

    constructor(address protocol_, address asset_)
        BaseStrategyAdapter(protocol_, AssetKind.Other, "slippage-mock")
    {
        asset = asset_;
    }

    function _supply(address, uint256 amount, uint256) internal override {
        pooled += amount;
    }

    function _redeem(address, uint256 amount, address, uint256)
        internal
        override
        returns (uint256)
    {
        pooled -= amount;
        return amount;
    }

    function _totalUnderlying(address) internal view override returns (uint256) {
        return pooled;
    }

    function _supportsAsset(address a) internal view override returns (bool) {
        return a == asset;
    }

    function _requiresSlippageBound() internal pure override returns (bool) {
        return true;
    }
}
