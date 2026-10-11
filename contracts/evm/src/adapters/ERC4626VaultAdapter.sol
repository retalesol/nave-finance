// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";

import {BaseStrategyAdapter} from "./BaseStrategyAdapter.sol";
import {NaveErrors} from "../libraries/NaveErrors.sol";
import {AssetKind} from "../libraries/NaveEnums.sol";

/// @title ERC4626VaultAdapter
/// @notice `IStrategyAdapter` over one synchronous ERC-4626 vault (Morpho
/// MetaMorpho vaults such as Steakhouse / Gauntlet USDC, Sky sUSDS, Spark
/// sUSDC). One deployment per vault; the vault's `asset()` is the only
/// supported asset. Vault shares are held by the adapter and partitioned per
/// DAO through the {BaseStrategyAdapter} share ledger.
contract ERC4626VaultAdapter is BaseStrategyAdapter {
    using SafeERC20 for IERC20;

    IERC4626 public immutable vault;
    address public immutable underlying;

    constructor(address protocol_, address vault_, string memory protocolId_)
        BaseStrategyAdapter(protocol_, AssetKind.Stable, protocolId_)
    {
        if (vault_ == address(0)) revert NaveErrors.ZeroAddress();
        vault = IERC4626(vault_);
        underlying = IERC4626(vault_).asset();
    }

    function _supply(address asset, uint256 amount, uint256) internal override {
        // Share price drift is bounded by NaveExecution's position-value check
        // (DEPOSIT_SLIPPAGE_BPS), so `minOut` (an underlying floor) is not
        // compared against vault shares here.
        IERC20(asset).forceApprove(address(vault), amount);
        vault.deposit(amount, address(this));
    }

    function _redeem(address, uint256 amount, address to, uint256)
        internal
        override
        returns (uint256)
    {
        vault.withdraw(amount, to, address(this));
        return amount;
    }

    function _totalUnderlying(address asset) internal view override returns (uint256) {
        if (asset != underlying) return 0;
        return vault.previewRedeem(vault.balanceOf(address(this)));
    }

    function _supportsAsset(address asset) internal view override returns (bool) {
        return asset == underlying;
    }
}
