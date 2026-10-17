// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {NaveErrors} from "../libraries/NaveErrors.sol";

interface IMintableTestnetAsset {
    function mint(address to, uint256 amount) external;
}

/// @title TestnetERC4626YieldVault
/// @notice First-party synchronous ERC-4626 yield vault for testnets without a
/// third-party lending pool (Robinhood Testnet 46630 and Arc Testnet 5042002).
/// Supports deterministic yield simulation via {accrue} (transfers underlying
/// from the caller into the vault) and {drip} (mints underlying directly into
/// the vault when the asset is a {TestnetMintableERC20}).
contract TestnetERC4626YieldVault is ERC4626 {
    using SafeERC20 for IERC20;
    using Math for uint256;

    event YieldAccrued(address indexed caller, uint256 amount);

    constructor(IERC20 asset_, string memory name_, string memory symbol_)
        ERC20(name_, symbol_)
        ERC4626(asset_)
    {
        if (address(asset_) == address(0)) revert NaveErrors.ZeroAddress();
    }

    /// @notice Donate `amount` of underlying `asset()` from `msg.sender` into
    /// the vault so share value increases deterministically for existing
    /// depositors.
    function accrue(uint256 amount) external {
        if (amount == 0) revert NaveErrors.MathOverflow();
        IERC20(asset()).safeTransferFrom(msg.sender, address(this), amount);
        emit YieldAccrued(msg.sender, amount);
    }

    /// @notice Mint `amount` of underlying directly into the vault when the
    /// underlying token exposes a public `mint(address,uint256)` faucet.
    function drip(uint256 amount) public {
        if (amount == 0) revert NaveErrors.MathOverflow();
        IMintableTestnetAsset(asset()).mint(address(this), amount);
        emit YieldAccrued(msg.sender, amount);
    }

    /// @notice Convenience zero-arg drip: accrues 1% of current `totalAssets()`
    /// (or 1 whole token if the vault is empty).
    function drip() external {
        uint256 current = totalAssets();
        uint256 amount = current >= 100 ? current / 100 : (10 ** uint256(decimals()));
        drip(amount);
    }

    function _convertToShares(uint256 assets, Math.Rounding rounding)
        internal
        view
        override
        returns (uint256)
    {
        uint256 supply = totalSupply();
        uint256 total = totalAssets();
        if (supply == 0 || total == 0) return assets;
        return assets.mulDiv(supply, total, rounding);
    }

    function _convertToAssets(uint256 shares, Math.Rounding rounding)
        internal
        view
        override
        returns (uint256)
    {
        uint256 supply = totalSupply();
        if (supply == 0) return shares;
        return shares.mulDiv(totalAssets(), supply, rounding);
    }
}
