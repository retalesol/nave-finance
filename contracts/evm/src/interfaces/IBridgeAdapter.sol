// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IBridgeAdapter
/// @notice Cross-chain capital hop for treasury USDC/ETH. Distinct from
/// `IStrategyAdapter` (same-chain yield): funds leave this chain toward an
/// allowlisted sister treasury. Gated to registered `NaveExecution` callers.
interface IBridgeAdapter {
    /// Human-readable protocol id (e.g. "cctp", "op-standard-bridge", "arbitrum-bridge").
    function protocolId() external view returns (string memory);

    /// Whether this adapter can bridge `asset` from the current chain to `destChainId`.
    function supportsRoute(address asset, uint256 destChainId) external view returns (bool);

    /// Bridge `amount` of `asset` (already held by this adapter) to `destTreasury`
    /// on `destChainId`. Returns a correlation / nonce for off-chain finalize.
    function bridgeOut(
        address asset,
        uint256 amount,
        uint256 destChainId,
        address destTreasury
    ) external returns (bytes32 correlationId);
}
