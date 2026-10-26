// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title INaveProtocol
/// @notice Singleton protocol config + DAO clone registry. EVM equivalent of
/// `NaveGlobalConfig` (+ the `ProtocolFeeVault` role). Adapters and per-DAO
/// contracts read it to gate cross-contract calls.
interface INaveProtocol {
    /// Protocol admin (Ownable2Step owner). Read by treasuries for the EVM-H1
    /// last-resort force-unfreeze authority.
    function owner() external view returns (address);
    function protocolTreasury() external view returns (address);
    /// Hot key that receives the outbound relayer fee. Stored on the protocol,
    /// never taken from a caller argument. Zero until the owner sets it.
    function relayer() external view returns (address);
    function paused() external view returns (bool);
    function formationFee() external view returns (uint256);
    /// Portion of `formationFee` seeded into a new DAO treasury at creation.
    function treasurySeed() external view returns (uint256);
    function tokenMintFee() external view returns (uint256);
    function daoCount() external view returns (uint256);
    function factory() external view returns (address);
    /// Wrapped-NAVE token + required base-unit stake for DAO creation. Zero ⇒
    /// stake disabled (testnet / pre-bridge).
    function naveStakeToken() external view returns (address);
    function requiredNaveStake() external view returns (uint256);
    /// `NaveDaoStake` escrow/moonlight module (zero ⇒ disabled).
    function daoStake() external view returns (address);
    /// Per-chain WETH for wrapping treasury native ETH (zero ⇒ native disabled).
    function wrappedNative() external view returns (address);
    /// Pyth feed id used when auto-registering wrapped native.
    function ethUsdFeedId() external view returns (bytes32);

    /// Clone-registry membership checks (set by the factory at DAO creation).
    function isNaveTreasury(address) external view returns (bool);
    function isNaveGovernor(address) external view returns (bool);
    function isNaveExecution(address) external view returns (bool);

    /// Resolve the sibling contracts of a DAO from any one of its clones.
    function daoOf(address clone) external view returns (uint256);

    /// Factory-only: register a freshly created DAO triplet and assign its id.
    function registerDao(address treasury, address governor, address execution)
        external
        returns (uint256 daoId);

    /// DAO UUPS targets must be protocol-approved for the given DaoImplRole.
    function isApprovedImplementation(uint8 role, address implementation)
        external
        view
        returns (bool);

    /// Latest approved impls for Treasury / Governor / Execution.
    function latestImplementation(uint8 role) external view returns (address);

    function latestImplementations()
        external
        view
        returns (address treasury, address governor, address execution);

    /// Protocol-level adapter allowlist; every adapter in a DAO constitution
    /// must be approved here.
    function isApprovedAdapter(address adapter) external view returns (bool);
    function riskTierOf(address adapter) external view returns (uint8);

    /// Owner-registered sister treasury on another chain (bridge destination).
    function isRemoteTreasury(uint256 chainId, address treasury) external view returns (bool);
}
