// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {BaseStrategyAdapter} from "./BaseStrategyAdapter.sol";
import {ICurvePool} from "./external/IExternalProtocols.sol";
import {NaveConstants} from "../libraries/NaveConstants.sol";
import {AssetKind} from "../libraries/NaveEnums.sol";

/// @title CurveAdapter
/// @notice `IStrategyAdapter` over a Curve StableSwap pool (Ethereum + Base).
/// One-sided liquidity: deposits `asset` at `coinIndex` via `add_liquidity` and
/// unwinds via `remove_liquidity_one_coin`. The adapter's LP-token balance is
/// the position, valued one-sided in `asset` and partitioned per-DAO.
///
/// Pricing (EVM-C2): the position is valued via the pool's own invariant-based
/// `get_virtual_price()`, NOT `calc_withdraw_one_coin`/raw balances — both of
/// the latter reflect the pool's *current* (single-block, flash-loan-movable)
/// balances, letting an attacker distort share pricing in this shared
/// (one-per-chain) adapter immediately before a deposit/withdraw executes.
/// `get_virtual_price()` only moves with accrued trading fees, which bounds
/// the manipulation an attacker can buy within one transaction.
///
/// Slippage (C-4): `add_liquidity` uses the caller-supplied `minOut` as `minMint`
/// and the withdrawal floor is `max(minOut, amount * (1 - maxSlippageBps))` — the
/// caller's off-chain-quoted bound takes precedence, with the configured
/// `maxSlippageBps` as a hard backstop. A `minOut == 0` deposit/withdraw is
/// rejected on mainnet (Ethereum/Base) by {BaseStrategyAdapter}.
contract CurveAdapter is BaseStrategyAdapter {
    using SafeERC20 for IERC20;

    ICurvePool public immutable pool;
    IERC20 public immutable lpToken;
    address public immutable coin;
    int128 public immutable coinIndex;
    uint256 public immutable nCoins;
    uint16 public immutable maxSlippageBps;
    uint8 public immutable coinDecimals;

    constructor(
        address protocol_,
        address pool_,
        address lpToken_,
        address coin_,
        int128 coinIndex_,
        uint256 nCoins_,
        uint16 maxSlippageBps_
    ) BaseStrategyAdapter(protocol_, AssetKind.Other, "curve") {
        pool = ICurvePool(pool_);
        lpToken = IERC20(lpToken_);
        coin = coin_;
        coinIndex = coinIndex_;
        nCoins = nCoins_;
        maxSlippageBps = maxSlippageBps_;
        coinDecimals = IERC20Metadata(coin_).decimals();
    }

    function _supply(address asset, uint256 amount, uint256 minOut) internal override {
        uint256[] memory amounts = new uint256[](nCoins);
        amounts[uint256(uint128(coinIndex))] = amount;
        IERC20(asset).forceApprove(address(pool), amount);
        // `minOut` is the minimum LP tokens the caller will accept for this join.
        pool.add_liquidity(amounts, minOut);
    }

    function _redeem(address asset, uint256 amount, address to, uint256 minOut)
        internal
        override
        returns (uint256 received)
    {
        uint256 lpBal = lpToken.balanceOf(address(this));
        // EVM-C2: burn-ratio is computed off the same manipulation-resistant
        // `_totalUnderlying` (get_virtual_price-based) used for share pricing,
        // not the pool's current calc_withdraw_one_coin/balances.
        uint256 total = _totalUnderlying(asset);
        uint256 lpToBurn = total == 0 ? 0 : (lpBal * amount) / total;
        if (lpToBurn > lpBal) lpToBurn = lpBal;
        // Hard backstop derived from the configured max slippage…
        uint256 floor = (amount * (NaveConstants.BPS_DENOMINATOR - maxSlippageBps))
            / NaveConstants.BPS_DENOMINATOR;
        // …but the caller's tighter off-chain-quoted bound always wins.
        uint256 minReceived = minOut > floor ? minOut : floor;
        received = pool.remove_liquidity_one_coin(lpToBurn, coinIndex, minReceived);
        IERC20(asset).safeTransfer(to, received);
    }

    function _totalUnderlying(address) internal view override returns (uint256) {
        uint256 lpBal = lpToken.balanceOf(address(this));
        if (lpBal == 0) return 0;
        // EVM-C2: `get_virtual_price()` is invariant-derived and only moves
        // with accrued trading fees, unlike `calc_withdraw_one_coin` which
        // reflects the pool's current (flash-loan-movable) balances.
        uint256 virtualPrice = pool.get_virtual_price();
        uint256 value18 = (lpBal * virtualPrice) / 1e18;
        return _scaleFrom18(value18, coinDecimals);
    }

    function _supportsAsset(address asset) internal view override returns (bool) {
        return asset == coin;
    }

    function _requiresSlippageBound() internal pure override returns (bool) {
        return true;
    }
}
