// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title INaveGovernor
/// @notice Read surface of a per-DAO governor consumed by `NaveExecution` to
/// validate that a passed proposal authorizes a capital movement.
interface INaveGovernor {
    function treasury() external view returns (address);

    /// Proposal fields needed by the execution pipeline.
    function proposalCore(uint64 index)
        external
        view
        returns (
            uint8 proposalType,
            uint8 status,
            bytes32 payloadHash,
            uint256 finalizedAt,
            address proposer
        );

    /// Mark a proposal as executed (execution-gated).
    function markExecuted(uint64 index) external;

    /// Consume a Passed MoonlightRequest / MoonlightDistribution proposal
    /// (DaoStake-gated, P6-3 anti-replay).
    function markMoonlightProposalExecuted(uint64 index) external;
}
