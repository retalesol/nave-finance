// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IOracle} from "../interfaces/IOracle.sol";
import {NaveErrors} from "../libraries/NaveErrors.sol";

/// @title TestnetPegOracle
/// @notice Testnet stand-in for chains with no Pyth Core `getPriceNoOlderThan`
/// contract. Prices the configured USDC at one dollar (micro-USD, 1e6) and
/// reverts `StaleOracle` for every other asset. When `usdc` is the zero
/// address, every asset fails closed — including the configured stablecoin.
/// This is not a price feed for WETH or any other token.
contract TestnetPegOracle is IOracle {
    address public immutable usdc;

    constructor(address usdc_) {
        usdc = usdc_;
    }

    /// @inheritdoc IOracle
    function valueUsd(address asset, bytes32, uint8 decimals, uint256 amount)
        external
        view
        returns (uint256 microUsd)
    {
        if (!_priced(asset)) revert NaveErrors.StaleOracle();
        if (amount == 0) return 0;
        if (decimals > 18) revert NaveErrors.StaleOracle();
        return (amount * 1_000_000) / (10 ** uint256(decimals));
    }

    /// @inheritdoc IOracle
    function hasFreshPrice(address asset, bytes32) external view returns (bool) {
        return _priced(asset);
    }

    function _priced(address asset) internal view returns (bool) {
        return usdc != address(0) && asset == usdc;
    }
}
