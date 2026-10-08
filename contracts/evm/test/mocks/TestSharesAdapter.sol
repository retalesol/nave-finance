// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BaseStrategyAdapter} from "../../src/adapters/BaseStrategyAdapter.sol";
import {AssetKind} from "../../src/libraries/NaveEnums.sol";
import {MockERC20} from "./MockERC20.sol";

/// @notice Concrete {BaseStrategyAdapter} backed by an internal `pooled` counter
/// (a stand-in protocol) so the share-accounting model can be invariant-tested
/// without a live lending market. `pooled` always equals the adapter's raw
/// token balance by construction.
contract TestSharesAdapter is BaseStrategyAdapter {
    address public immutable asset;
    uint256 public pooled;

    constructor(address protocol_, address asset_)
        BaseStrategyAdapter(protocol_, AssetKind.Other, "test-shares")
    {
        asset = asset_;
    }

    function _supply(address, uint256 amount, uint256) internal override {
        pooled += amount;
    }

    function _redeem(address a, uint256 amount, address to, uint256)
        internal
        override
        returns (uint256)
    {
        pooled -= amount;
        IERC20(a).transfer(to, amount);
        return amount;
    }

    function _totalUnderlying(address) internal view override returns (uint256) {
        return pooled;
    }

    function _supportsAsset(address a) internal view override returns (bool) {
        return a == asset;
    }

    /// Simulate yield accrual.
    function accrue(uint256 gain) external {
        pooled += gain;
        MockERC20(asset).mint(address(this), gain);
    }
}
