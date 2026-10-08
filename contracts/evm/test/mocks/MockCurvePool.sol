// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockRateToken} from "./MockRateToken.sol";

/// @notice Minimal Curve StableSwap pool stand-in for testing manipulation-
/// resistant LP pricing (EVM-C2). `virtualPrice` models the real,
/// invariant-derived `get_virtual_price()` (only moves when the harness calls
/// {setVirtualPrice}, mimicking fee accrual). `spoofedWithdrawOneCoin` is an
/// INDEPENDENTLY settable value standing in for the pre-fix vulnerable
/// `calc_withdraw_one_coin` metric, which reflects the pool's current
/// (flash-loan-movable) balances — a real attacker could swing it far from
/// `virtualPrice` within a single block without paying more than swap fees.
contract MockCurvePool {
    IERC20 public immutable coin;
    MockRateToken public immutable lp;

    uint256 public virtualPrice = 1e18;
    uint256 public spoofedWithdrawOneCoin;

    constructor(address coin_, address lp_) {
        coin = IERC20(coin_);
        lp = MockRateToken(lp_);
    }

    function setVirtualPrice(uint256 v) external {
        virtualPrice = v;
    }

    function setSpoofedWithdrawOneCoin(uint256 v) external {
        spoofedWithdrawOneCoin = v;
    }

    function add_liquidity(uint256[] calldata amounts, uint256 minMintAmount)
        external
        returns (uint256 minted)
    {
        uint256 amountIn = amounts[0];
        coin.transferFrom(msg.sender, address(this), amountIn);
        minted = (amountIn * 1e18) / virtualPrice;
        require(minted >= minMintAmount, "MockCurvePool: slippage");
        lp.mint(msg.sender, minted);
    }

    function remove_liquidity_one_coin(uint256 lpAmount, int128, uint256 minReceived)
        external
        returns (uint256 received)
    {
        lp.burn(msg.sender, lpAmount);
        received = (lpAmount * virtualPrice) / 1e18;
        require(received >= minReceived, "MockCurvePool: slippage");
        coin.transfer(msg.sender, received);
    }

    function calc_withdraw_one_coin(uint256, int128) external view returns (uint256) {
        return spoofedWithdrawOneCoin;
    }

    function get_virtual_price() external view returns (uint256) {
        return virtualPrice;
    }

    function coins(uint256) external view returns (address) {
        return address(coin);
    }
}
