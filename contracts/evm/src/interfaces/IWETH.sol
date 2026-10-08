// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IWETH
/// @notice Minimal WETH9 deposit/withdraw surface used by treasury native wrap.
interface IWETH {
    function deposit() external payable;
    function withdraw(uint256 wad) external;
    function balanceOf(address account) external view returns (uint256);
}
