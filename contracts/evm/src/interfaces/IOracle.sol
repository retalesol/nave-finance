// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IOracle
/// @notice Minimal price surface consumed by `NaveExecution` for USD valuation.
/// Implemented by {PythOracle} (Pyth primary, Chainlink fallback). Mirrors the
/// Solana valuation path (`value_amount_usd`): a 32-byte Pyth feed id, a 60s
/// staleness bound, and the 2% confidence guard.
interface IOracle {
    /// Value `amount` base units of an asset (with `decimals`) in micro-USD
    /// (1e6) using the asset's configured price feed. Reverts on a missing /
    /// stale / wide-confidence price. `pythFeedId` may be bytes32(0) when only
    /// a Chainlink feed is configured for the asset.
    function valueUsd(address asset, bytes32 pythFeedId, uint8 decimals, uint256 amount)
        external
        view
        returns (uint256 microUsd);

    /// Whether a usable (fresh, in-confidence) price exists for `asset`.
    function hasFreshPrice(address asset, bytes32 pythFeedId) external view returns (bool);
}
