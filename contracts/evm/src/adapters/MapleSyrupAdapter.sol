// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";

import {QueuedExitAdapter} from "./QueuedExitAdapter.sol";
import {
    IMaplePool, IMaplePoolManager, IMapleWithdrawalManager
} from "./external/IExternalProtocols.sol";

/// @title MapleSyrupAdapter
/// @notice Deposits USDC into a Maple syrup pool (Tier 3: overcollateralized
/// institutional credit). Exits go through Maple's withdrawal queue; the pool
/// delegate processes requests and sends USDC straight to the adapter, after
/// which {settle} credits the requester. Value uses `convertToExitAssets`, so
/// unrealized pool losses are reflected.
contract MapleSyrupAdapter is QueuedExitAdapter {
    using SafeERC20 for IERC20;

    IERC4626 public immutable pool;

    constructor(address protocol_, address pool_)
        QueuedExitAdapter(protocol_, IERC4626(pool_).asset(), "maple-syrup")
    {
        pool = IERC4626(pool_);
    }

    function withdrawalManager() public view returns (IMapleWithdrawalManager) {
        return IMapleWithdrawalManager(
            IMaplePoolManager(IMaplePool(address(pool)).manager()).withdrawalManager()
        );
    }

    function _supply(address asset, uint256 amount, uint256) internal override {
        IERC20(asset).forceApprove(address(pool), amount);
        pool.deposit(amount, address(this));
    }

    function _totalUnderlying(address asset) internal view override returns (uint256) {
        if (asset != underlying) return 0;
        return IMaplePool(address(pool)).convertToExitAssets(pool.balanceOf(address(this)));
    }

    function _startVenueExit(uint256 amount) internal override returns (uint256) {
        uint256 exitShares = IMaplePool(address(pool)).convertToExitShares(amount);
        uint256 held = pool.balanceOf(address(this));
        if (exitShares > held) exitShares = held;
        IMaplePool(address(pool)).requestRedeem(exitShares, address(this));
        // Maple processes the queue off-chain; there is no on-chain ETA.
        return block.timestamp;
    }

    function _venueExitDone() internal view override returns (bool) {
        return withdrawalManager().requestIds(address(this)) == 0;
    }

    function _finishVenueExit() internal override {}
}
