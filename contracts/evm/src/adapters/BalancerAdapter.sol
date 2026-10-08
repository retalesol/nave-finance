// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {BaseStrategyAdapter} from "./BaseStrategyAdapter.sol";
import {IBalancerVault, IRateProviderPool} from "./external/IExternalProtocols.sol";
import {AssetKind} from "../libraries/NaveEnums.sol";

/// @title BalancerAdapter
/// @notice `IStrategyAdapter` over a Balancer v2 pool whose BPT implements the
/// standard rate-provider interface (Stable / ComposableStable / MetaStable /
/// Linear pools — Ethereum + Base). Single-asset join
/// (`EXACT_TOKENS_IN_FOR_BPT_OUT`) / single-asset exit
/// (`EXACT_BPT_IN_FOR_ONE_TOKEN_OUT`). The adapter is configured with the
/// pool's registered `assets` ordering and the index of the routed asset; its
/// BPT balance is the position.
///
/// Pricing (EVM-C2): `_totalUnderlying` values the BPT position via the pool's
/// own `getRate()` (invariant/rate-provider based), NOT the raw
/// `getPoolTokens()` balance ratio — a flash loan can skew pool balances
/// (and therefore a balance-ratio price) within a single block immediately
/// before a deposit/withdraw, letting an attacker distort share minting in
/// this shared (one-per-chain) adapter. Plain Weighted Pools without a rate
/// provider are not supported.
///
/// Slippage (C-3): join uses the caller-supplied `minOut` as `minBptOut` and exit
/// uses it as the routed-token `minAmountsOut[assetIndex]`. A `minOut == 0` call
/// is rejected on mainnet (Ethereum/Base) by {BaseStrategyAdapter}; callers
/// (`NaveExecution`) must thread an off-chain-quoted bound.
contract BalancerAdapter is BaseStrategyAdapter {
    using SafeERC20 for IERC20;

    IBalancerVault public immutable vault;
    bytes32 public immutable poolId;
    IERC20 public immutable bpt;
    address public immutable routedAsset;
    uint256 public immutable assetIndex;
    uint256 public immutable tokenCount;
    uint8 public immutable routedAssetDecimals;

    constructor(
        address protocol_,
        address vault_,
        bytes32 poolId_,
        address bpt_,
        address routedAsset_,
        uint256 assetIndex_,
        uint256 tokenCount_
    ) BaseStrategyAdapter(protocol_, AssetKind.Other, "balancer-v2") {
        vault = IBalancerVault(vault_);
        poolId = poolId_;
        bpt = IERC20(bpt_);
        routedAsset = routedAsset_;
        assetIndex = assetIndex_;
        tokenCount = tokenCount_;
        routedAssetDecimals = IERC20Metadata(routedAsset_).decimals();
    }

    function _poolAssets() internal view returns (address[] memory assets) {
        (assets,,) = vault.getPoolTokens(poolId);
    }

    function _supply(address asset, uint256 amount, uint256 minOut) internal override {
        address[] memory assets = _poolAssets();
        uint256[] memory maxAmountsIn = new uint256[](assets.length);
        maxAmountsIn[assetIndex] = amount;
        // `minOut` is the minimum BPT the caller will accept for this join.
        bytes memory userData = abi.encode(
            uint256(IBalancerVault.JoinKind.EXACT_TOKENS_IN_FOR_BPT_OUT), maxAmountsIn, minOut
        );
        IERC20(asset).forceApprove(address(vault), amount);
        vault.joinPool(
            poolId,
            address(this),
            address(this),
            IBalancerVault.JoinPoolRequest({
                assets: assets,
                maxAmountsIn: maxAmountsIn,
                userData: userData,
                fromInternalBalance: false
            })
        );
    }

    function _redeem(address asset, uint256 amount, address to, uint256 minOut)
        internal
        override
        returns (uint256 out)
    {
        uint256 bptBal = bpt.balanceOf(address(this));
        uint256 total = _totalUnderlying(asset);
        uint256 bptToBurn = total == 0 ? 0 : (bptBal * amount) / total;
        if (bptToBurn > bptBal) bptToBurn = bptBal;

        address[] memory assets = _poolAssets();
        // `minOut` is the minimum routed-token the caller will accept for the exit.
        uint256[] memory minAmountsOut = new uint256[](assets.length);
        minAmountsOut[assetIndex] = minOut;
        bytes memory userData = abi.encode(
            uint256(IBalancerVault.ExitKind.EXACT_BPT_IN_FOR_ONE_TOKEN_OUT), bptToBurn, assetIndex
        );

        uint256 balBefore = IERC20(asset).balanceOf(address(this));
        vault.exitPool(
            poolId,
            address(this),
            payable(address(this)),
            IBalancerVault.ExitPoolRequest({
                assets: assets,
                minAmountsOut: minAmountsOut,
                userData: userData,
                toInternalBalance: false
            })
        );
        out = IERC20(asset).balanceOf(address(this)) - balBefore;
        IERC20(asset).safeTransfer(to, out);
    }

    function _totalUnderlying(address) internal view override returns (uint256) {
        uint256 bptBal = bpt.balanceOf(address(this));
        if (bptBal == 0) return 0;
        // EVM-C2: price via the BPT's own rate-provider `getRate()` (18-decimal
        // fixed point, base-asset-denominated) instead of the raw
        // `getPoolTokens()` balance ratio, which a flash loan can move
        // materially within a single block.
        uint256 rate = IRateProviderPool(address(bpt)).getRate();
        uint256 value18 = (bptBal * rate) / 1e18;
        return _scaleFrom18(value18, routedAssetDecimals);
    }

    function _supportsAsset(address asset) internal view override returns (bool) {
        return asset == routedAsset;
    }

    function _requiresSlippageBound() internal pure override returns (bool) {
        return true;
    }
}
