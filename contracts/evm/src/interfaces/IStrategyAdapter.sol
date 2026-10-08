// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AssetKind} from "../libraries/NaveEnums.sol";

/// @title IStrategyAdapter
/// @notice EVM equivalent of the Solana adapter programs (jito/kamino/marginfi).
/// Adapters are authorization + accounting boundaries that route DAO capital
/// into a DeFi protocol (Aave v3, Compound v3, Balancer, Curve). Every mutating
/// call MUST be gated to a registered per-DAO `NaveExecution` (verified via
/// `NaveProtocol.isNaveExecution(msg.sender)`), mirroring the Solana
/// `verify_execution_authority` / `execution_authority` PDA gate.
///
/// Funds flow: `NaveExecution` first transfers `amount` of `asset` to the
/// adapter, then calls {deposit}. On unwind, {withdraw} redeems and returns the
/// underlying to `to` (the DAO treasury). Positions are isolated per
/// `(msg.sender, asset)` so DAOs can never touch each other's funds.
interface IStrategyAdapter {
    /// The asset class this adapter accepts (routing parity with Solana
    /// `required_asset_kind`). Adapters that accept any asset return `Other`.
    function assetKind() external view returns (AssetKind);

    /// Whether the adapter can route `asset` on the current chain.
    function supportsAsset(address asset) external view returns (bool);

    /// Supply the adapter's current `asset` balance (pre-funded by the caller)
    /// into the underlying protocol. Returns receipt units booked.
    /// `minOut` is the caller-supplied slippage floor for the underlying protocol
    /// join (e.g. min BPT / min LP minted). Adapters with real slippage
    /// (Balancer/Curve) MUST reject `minOut == 0` on mainnet; 1:1 lending
    /// adapters (Aave/Compound) ignore it.
    function deposit(address asset, uint256 amount, uint256 minOut)
        external
        returns (uint256 receiptOut);

    /// Redeem `amount` underlying `asset` from the protocol and send it to `to`.
    /// `minOut` is the caller-supplied minimum underlying to receive. Returns the
    /// underlying actually transferred out.
    function withdraw(address asset, uint256 amount, address to, uint256 minOut)
        external
        returns (uint256 underlyingOut);

    /// Current underlying value (base units) held for `msg.sender`'s position in
    /// `asset`. Used to mark positions and size realized-yield withdrawals.
    function positionValue(address asset) external view returns (uint256);

    /// Human-readable identifier (e.g. "aave-v3"), mirrors the Solana protocol_id.
    function protocolId() external view returns (string memory);
}
