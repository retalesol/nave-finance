// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {NaveErrors} from "./libraries/NaveErrors.sol";

/// @title NaveDaoToken
/// @notice The ERC-20 a DAO issues for token-weighted governance. EVM analogue
/// of an SPL mint whose mint authority is the DAO PDA: here the controlling
/// `NaveTreasury` is the sole minter, and authority can be permanently revoked
/// (mirrors `revoke_token_authority`). `ERC20Permit` enables gasless approvals.
contract NaveDaoToken is ERC20, ERC20Permit {
    address public immutable controller;
    uint8 private immutable _decimals;
    bool public mintingRevoked;

    event MintingRevoked();

    modifier onlyController() {
        if (msg.sender != controller) revert NaveErrors.Unauthorized();
        _;
    }

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        address controller_,
        uint256 initialSupply,
        address initialRecipient
    ) ERC20(name_, symbol_) ERC20Permit(name_) {
        controller = controller_;
        _decimals = decimals_;
        if (initialSupply > 0) {
            _mint(initialRecipient, initialSupply);
        }
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external onlyController {
        if (mintingRevoked) revert NaveErrors.AuthorityAlreadyRevoked();
        _mint(to, amount);
    }

    /// Permanently disable minting (parity with revoking SPL mint authority).
    function revokeMinting() external onlyController {
        mintingRevoked = true;
        emit MintingRevoked();
    }
}
