// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IOracle} from "../interfaces/IOracle.sol";
import {NaveConstants} from "./NaveConstants.sol";

/// @title ProtocolFeeLib
/// @notice Quotes ETH-denominated protocol fees in wei and, on Arc, in USDC.
/// The oracle is used when WETH has a fresh price. Otherwise the documented
/// Arc testnet constant {NaveConstants.ARC_TESTNET_ETH_USD_MICRO} applies.
library ProtocolFeeLib {
    /// Micro-USD value of `ethWei` wei of ETH (1e6 = $1). USDC has 6 decimals,
    /// so this number is also the ERC-20 USDC amount.
    function ethToMicroUsd(IOracle oracle, address weth, bytes32 feed, uint256 ethWei)
        internal
        view
        returns (uint256 microUsd)
    {
        if (address(oracle) != address(0) && weth != address(0) && ethWei != 0) {
            try oracle.hasFreshPrice(weth, feed) returns (bool fresh) {
                if (fresh) {
                    try oracle.valueUsd(weth, feed, 18, ethWei) returns (uint256 micro) {
                        if (micro > 0) return micro;
                    } catch {}
                }
            } catch {}
        }
        return (ethWei * NaveConstants.ARC_TESTNET_ETH_USD_MICRO) / 1 ether;
    }

    /// 6-decimal ERC-20 USDC units equal to `ethWei` of ETH.
    function ethToUsdc6(IOracle oracle, address weth, bytes32 feed, uint256 ethWei)
        internal
        view
        returns (uint256)
    {
        return ethToMicroUsd(oracle, weth, feed, ethWei);
    }

    /// 18-decimal native units. Arc's gas token is 18-decimal USDC, so the
    /// native amount is the micro-USD value scaled from 6 decimals to 18.
    function ethToArcNative(IOracle oracle, address weth, bytes32 feed, uint256 ethWei)
        internal
        view
        returns (uint256)
    {
        return ethToMicroUsd(oracle, weth, feed, ethWei) * 1e12;
    }

    function isArc(uint256 chainId) internal pure returns (bool) {
        return chainId == NaveConstants.ARC_TESTNET_CHAIN_ID;
    }

    /// Excess above `reserve` that a sweep sends to the revenue wallet.
    /// The wallet keeps `reserve` (0.05 ETH, or the Arc native equivalent).
    function sweepExcess(uint256 balance, uint256 reserve) internal pure returns (uint256) {
        if (balance <= reserve) return 0;
        return balance - reserve;
    }
}
