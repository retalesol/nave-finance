// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IOracle} from "../interfaces/IOracle.sol";
import {NaveErrors} from "../libraries/NaveErrors.sol";

/// @title TestnetPegOracle
/// @notice Testnet stand-in for chains with no Pyth Core `getPriceNoOlderThan`
/// contract. Prices the configured USDC at one dollar (micro-USD, 1e6), allows
/// the owner to configure reference micro-USD unit prices for additional
/// testnet assets (e.g. Robinhood Testnet WETH), and reverts `StaleOracle` for
/// every unconfigured asset. When `usdc` is the zero address and no reference
/// price is set, every asset fails closed.
contract TestnetPegOracle is IOracle {
    address public immutable usdc;
    address public immutable owner;

    /// Per-whole-token reference price in micro-USD (1e6 = $1.00, 2_500_000_000 = $2,500.00).
    mapping(address => uint256) public referencePriceMicroUsd;

    event ReferencePriceSet(address indexed asset, uint256 priceMicroUsd);

    constructor(address usdc_) {
        usdc = usdc_;
        owner = msg.sender;
    }

    /// @notice Configure (or clear with 0) the reference micro-USD unit price for `asset`.
    function setReferencePrice(address asset, uint256 priceMicroUsd) external {
        if (msg.sender != owner) revert NaveErrors.Unauthorized();
        if (asset == address(0)) revert NaveErrors.ZeroAddress();
        referencePriceMicroUsd[asset] = priceMicroUsd;
        emit ReferencePriceSet(asset, priceMicroUsd);
    }

    /// @inheritdoc IOracle
    function valueUsd(address asset, bytes32, uint8 decimals, uint256 amount)
        external
        view
        returns (uint256 microUsd)
    {
        uint256 unitMicroUsd = _unitPriceMicroUsd(asset);
        if (unitMicroUsd == 0) revert NaveErrors.StaleOracle();
        if (amount == 0) return 0;
        if (decimals > 18) revert NaveErrors.StaleOracle();
        return (amount * unitMicroUsd) / (10 ** uint256(decimals));
    }

    /// @inheritdoc IOracle
    function hasFreshPrice(address asset, bytes32) external view returns (bool) {
        return _unitPriceMicroUsd(asset) != 0;
    }

    function _unitPriceMicroUsd(address asset) internal view returns (uint256) {
        if (asset == address(0)) return 0;
        uint256 ref = referencePriceMicroUsd[asset];
        if (ref != 0) return ref;
        if (usdc != address(0) && asset == usdc) return 1_000_000;
        return 0;
    }
}
