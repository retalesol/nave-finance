// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

interface IRevaluableDep {
    function revalueTreasury() external;
}

/// @notice ERC-777-style hook token that re-enters the treasury's
/// `revalueTreasury()` on a transfer INTO the treasury (the deposit window).
/// Used to prove SEC-M5: with `deposit` following checks-effects-interactions
/// and `revalueTreasury` sharing the `nonReentrant` guard, the reentrant
/// revalue cannot double-count NAV mid-deposit.
contract ReentrantDepositToken is ERC20 {
    address public treasury;
    bool public armed;

    constructor() ERC20("ReentrantDep", "RDEP") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setTreasury(address t) external {
        treasury = t;
    }

    function arm(bool v) external {
        armed = v;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        // Re-enter on a transfer INTO the treasury (the deposit path).
        if (armed && treasury != address(0) && to == treasury) {
            IRevaluableDep(treasury).revalueTreasury();
        }
    }
}
