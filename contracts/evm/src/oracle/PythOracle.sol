// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable2StepUpgradeable} from
    "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {IPyth} from "@pythnetwork/pyth-sdk-solidity/IPyth.sol";
import {PythStructs} from "@pythnetwork/pyth-sdk-solidity/PythStructs.sol";
import {AggregatorV3Interface} from "@chainlink/shared/interfaces/AggregatorV3Interface.sol";

import {IOracle} from "../interfaces/IOracle.sol";
import {NaveConstants} from "../libraries/NaveConstants.sol";
import {NaveErrors} from "../libraries/NaveErrors.sol";
import {OracleMath} from "../libraries/OracleMath.sol";

/// @title PythOracle
/// @notice USD price oracle for the EVM port. Primary source is Pyth (reusing
/// the same 32-byte feed ids as Solana, with the 60s staleness bound and 2%
/// confidence guard from `nave_core::utils::oracle`). When a Pyth feed is
/// unset/stale/wide-confidence for an asset, an optional per-asset Chainlink
/// aggregator is used as a fallback on Ethereum/Base. Results are micro-USD (1e6).
contract PythOracle is Initializable, Ownable2StepUpgradeable, UUPSUpgradeable, IOracle {
    IPyth public pyth;

    struct ChainlinkFeed {
        address aggregator;
        uint256 maxStaleness; // seconds; 0 disables the fallback
    }

    mapping(address => ChainlinkFeed) public chainlinkFeeds;

    event ChainlinkFeedSet(address indexed asset, address aggregator, uint256 maxStaleness);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address pyth_, address owner_) external initializer {
        if (pyth_ == address(0)) revert NaveErrors.ZeroAddress();
        __Ownable_init(owner_);
        __Ownable2Step_init();
        pyth = IPyth(pyth_);
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    /// Configure (or clear) the Chainlink fallback for `asset`.
    function setChainlinkFeed(address asset, address aggregator, uint256 maxStaleness)
        external
        onlyOwner
    {
        chainlinkFeeds[asset] = ChainlinkFeed({aggregator: aggregator, maxStaleness: maxStaleness});
        emit ChainlinkFeedSet(asset, aggregator, maxStaleness);
    }

    /// @inheritdoc IOracle
    function valueUsd(address asset, bytes32 pythFeedId, uint8 decimals, uint256 amount)
        external
        view
        returns (uint256)
    {
        (bool ok, int64 price, int32 expo) = _resolvePrice(asset, pythFeedId);
        if (!ok) revert NaveErrors.StaleOracle();
        return OracleMath.valueUsd(amount, decimals, price, expo);
    }

    /// @inheritdoc IOracle
    function hasFreshPrice(address asset, bytes32 pythFeedId) external view returns (bool ok) {
        (ok,,) = _resolvePrice(asset, pythFeedId);
    }

    /// Pyth first (fresh + in-confidence), Chainlink fallback otherwise.
    function _resolvePrice(address asset, bytes32 pythFeedId)
        internal
        view
        returns (bool ok, int64 price, int32 expo)
    {
        if (pythFeedId != bytes32(0)) {
            (ok, price, expo) = _tryPyth(pythFeedId);
            if (ok) return (true, price, expo);
        }
        return _tryChainlink(asset);
    }

    function _tryPyth(bytes32 feedId) internal view returns (bool ok, int64 price, int32 expo) {
        try pyth.getPriceNoOlderThan(feedId, NaveConstants.PYTH_MAX_PRICE_AGE_SECS) returns (
            PythStructs.Price memory p
        ) {
            if (!OracleMath.confidenceWithinBounds(p.price, p.conf)) return (false, 0, 0);
            return (true, p.price, p.expo);
        } catch {
            return (false, 0, 0);
        }
    }

    function _tryChainlink(address asset) internal view returns (bool ok, int64 price, int32 expo) {
        ChainlinkFeed memory feed = chainlinkFeeds[asset];
        if (feed.aggregator == address(0) || feed.maxStaleness == 0) return (false, 0, 0);
        try AggregatorV3Interface(feed.aggregator).latestRoundData() returns (
            uint80, int256 answer, uint256, uint256 updatedAt, uint80
        ) {
            if (answer <= 0) return (false, 0, 0);
            if (updatedAt == 0 || block.timestamp - updatedAt > feed.maxStaleness) {
                return (false, 0, 0);
            }
            if (uint256(answer) > uint256(uint64(type(int64).max))) return (false, 0, 0);
            uint8 feedDecimals = AggregatorV3Interface(feed.aggregator).decimals();
            return (true, int64(answer), -int32(uint32(feedDecimals)));
        } catch {
            return (false, 0, 0);
        }
    }

    uint256[40] private __gap;
}
