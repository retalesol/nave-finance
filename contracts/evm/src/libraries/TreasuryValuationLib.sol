// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IOracle} from "../interfaces/IOracle.sol";
import {NaveConstants} from "./NaveConstants.sol";
import {NaveErrors} from "./NaveErrors.sol";
import {NaveStructs} from "./NaveStructs.sol";
import {OracleMath} from "./OracleMath.sol";

/// @title TreasuryValuationLib
/// @notice NAV revaluation helpers extracted from `NaveTreasury`.
library TreasuryValuationLib {
    function valueAsset(
        IOracle oracle,
        NaveStructs.AssetRecord storage a,
        address asset,
        uint256 amount
    ) internal view returns (uint256) {
        if (amount == 0) return 0;
        if (a.isStablecoin) return valueStablecoin(oracle, a, asset, amount);
        return oracle.valueUsd(asset, a.pythFeedId, a.decimals, amount);
    }

    /// SEC-M5: stablecoins with a configured/available price feed are valued at
    /// the ORACLE price — no longer a hardcoded $1 — guarded by a tight peg
    /// band: a unit price further than STABLECOIN_PEG_BAND_BPS (2%) from $1
    /// reverts (depeg: the asset must be disabled or the peg recover before
    /// NAV/valuation proceeds). Stables with NO feed configured (no Pyth id and
    /// no fresh Chainlink fallback — the testnet posture) keep par valuation.
    function valueStablecoin(
        IOracle oracle,
        NaveStructs.AssetRecord storage a,
        address asset,
        uint256 amount
    ) internal view returns (uint256) {
        if (a.pythFeedId == bytes32(0) && !oracle.hasFreshPrice(asset, bytes32(0))) {
            return OracleMath.valueStable(amount, a.decimals);
        }
        // Peg band checked on the UNIT price (avoids tiny-amount rounding
        // false positives): 1 whole token must value within the band of $1.
        uint256 unitUsd = oracle.valueUsd(asset, a.pythFeedId, a.decimals, 10 ** a.decimals);
        uint256 par = NaveConstants.USD_SCALE; // $1 in micro-USD
        uint256 diff = unitUsd > par ? unitUsd - par : par - unitUsd;
        if (diff * NaveConstants.BPS_DENOMINATOR > par * NaveConstants.STABLECOIN_PEG_BAND_BPS) {
            revert NaveErrors.StablecoinDepegged();
        }
        return oracle.valueUsd(asset, a.pythFeedId, a.decimals, amount);
    }

    function valueAssetUsd(
        IOracle oracle,
        NaveStructs.AssetRecord storage a,
        address asset,
        uint256 amount
    ) external view returns (uint256) {
        return valueAsset(oracle, a, asset, amount);
    }

    /// Lookup asset by key, validate registration, then value. Extracted from
    /// NaveTreasury.valueAssetUsd to stay under EIP-170.
    function valueAssetUsdByKey(
        IOracle oracle,
        mapping(address => NaveStructs.AssetRecord) storage assets,
        address asset,
        uint256 amount
    ) external view returns (uint256) {
        NaveStructs.AssetRecord storage a = assets[asset];
        if (!a.registered) revert NaveErrors.AssetNotRegistered();
        return valueAsset(oracle, a, asset, amount);
    }

    function revalueAll(
        address treasury,
        IOracle oracle,
        mapping(address => NaveStructs.AssetRecord) storage assets,
        address[] storage registeredAssets
    ) external returns (uint256 nav, uint256 deployedUsd) {
        uint256 n = registeredAssets.length;
        for (uint256 i; i < n; i++) {
            address asset = registeredAssets[i];
            NaveStructs.AssetRecord storage a = assets[asset];
            uint256 idle = IERC20(asset).balanceOf(treasury);
            uint256 holdings = idle + a.deployedCapitalBase;
            uint256 usd = valueAsset(oracle, a, asset, holdings);
            uint256 deployedAssetUsd = valueAsset(oracle, a, asset, a.deployedCapitalBase);
            a.lastValuedUsd = usd;
            a.lastValuedAt = block.timestamp;
            nav += usd;
            deployedUsd += deployedAssetUsd;
        }
    }
}
