// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title INaveDaoStake
/// @notice Minimal surface for treasury/execution moonlight halt checks.
interface INaveDaoStake {
    function isMoonlighting(address treasury) external view returns (bool);
}
