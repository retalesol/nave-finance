// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Minimal 18-decimal ERC20 with a settable `getRate()`, standing in for
/// a Balancer rate-provider BPT (or reused as a plain mintable/burnable LP
/// token for {MockCurvePool}). Mint/burn are open so test harnesses can drive
/// balances directly without routing through a full pool implementation.
contract MockRateToken is ERC20 {
    uint256 public rate = 1e18;

    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    function setRate(uint256 r) external {
        rate = r;
    }

    function getRate() external view returns (uint256) {
        return rate;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external {
        _burn(from, amount);
    }
}
