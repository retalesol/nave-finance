// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {NaveErrors} from "../libraries/NaveErrors.sol";

/// @title TestnetMintableERC20
/// @notice Capped-faucet ERC-20 token used on testnets without a canonical
/// published stablecoin (e.g. Robinhood Chain Testnet 46630 USDC).
contract TestnetMintableERC20 is ERC20 {
    error MintCapExceeded(uint256 requested, uint256 maxPerCall);

    uint8 private immutable _tokenDecimals;
    uint256 public immutable maxMintPerCall;

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        uint256 maxMintPerCall_
    ) ERC20(name_, symbol_) {
        _tokenDecimals = decimals_;
        maxMintPerCall = maxMintPerCall_;
    }

    function decimals() public view override returns (uint8) {
        return _tokenDecimals;
    }

    /// @notice Mint up to `maxMintPerCall` base units to `to`.
    function mint(address to, uint256 amount) external {
        if (to == address(0)) revert NaveErrors.ZeroAddress();
        if (amount == 0) revert NaveErrors.MathOverflow();
        if (maxMintPerCall != 0 && amount > maxMintPerCall) {
            revert MintCapExceeded(amount, maxMintPerCall);
        }
        _mint(to, amount);
    }
}
