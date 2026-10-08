// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ExecutionStatus, ExecutionKind} from "../libraries/NaveEnums.sol";

/// @title INaveExecution
/// @notice Read surface of a per-DAO execution clone.
interface INaveExecution {
    function treasury() external view returns (address);
    function governor() external view returns (address);
    function currentImplementation() external view returns (address);
    function requestStatus(uint64 proposalIndex) external view returns (ExecutionStatus);
    /// Whether an execution request has been created for `proposalIndex`. Used by
    /// the governor's direct Transfer path to refuse disbursing a proposal that
    /// is already claimed by the agent pipeline (double-spend seal). `status`
    /// alone cannot distinguish a non-existent request from a Pending one (both
    /// read as enum 0), so existence is exposed explicitly.
    function requestExists(uint64 proposalIndex) external view returns (bool);
    /// Whether the one-time founder zero-review-window bootstrap was consumed.
    function bootstrapUsed() external view returns (bool);
}
