// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

interface IRevaluable {
    function revalueTreasury() external;
}

/// @notice Malicious 6-decimal token that re-enters the treasury's permissionless
/// `revalueTreasury()` during a transfer leaving the treasury. Used to prove the
/// CEI ordering fix in `NaveTreasury._executeTreasuryTransfer` (audit H-1): the
/// NAV deduction must happen BEFORE the external transfer, otherwise this hook
/// re-enters and the post-transfer code double-counts the deduction.
contract ReentrantToken is ERC20 {
    address public treasury;
    bool public armed;

    constructor() ERC20("Reentrant", "REE") {}

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
        // Re-enter only on a transfer OUT of the treasury — the attack window.
        if (armed && treasury != address(0) && from == treasury) {
            // Best-effort re-entry; auth-gated revalueTreasury reverts for non-founder
            // callers — swallow so the outer transfer still completes (CEI is tested).
            try IRevaluable(treasury).revalueTreasury() {} catch {}
        }
    }
}
