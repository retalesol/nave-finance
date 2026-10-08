// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";

import {NaveErrors} from "./NaveErrors.sol";
import {NaveStructs} from "./NaveStructs.sol";
import {INaveProtocol} from "../interfaces/INaveProtocol.sol";
import {TreasuryStrategyLib} from "./TreasuryStrategyLib.sol";

interface _NaveGovernorViews {
    function currentImplementation() external view returns (address);
}

interface _NaveExecutionViews {
    function currentImplementation() external view returns (address);
}

/// @title TreasuryViewLib
/// @notice External view helpers extracted from `NaveTreasury` for EIP-170 headroom.
/// Only fat bodies belong here — thin storage getters cost more as DELEGATECALL
/// stubs than they save.
library TreasuryViewLib {
    /// @dev Returns the address of the current ERC-1967 implementation behind this proxy.
    function currentImplementation() external view returns (address) {
        return ERC1967Utils.getImplementation();
    }

    /// @dev True if any of this DAO's T/G/E proxies differs from the protocol's latest.
    /// Called via DELEGATECALL from NaveTreasury so `address(this)` is the treasury proxy.
    function needsUpgrade(
        address protocolContract,
        address governor,
        address execution
    ) external view returns (bool) {
        (address tLatest, address gLatest, address eLatest) =
            INaveProtocol(protocolContract).latestImplementations();
        if (tLatest == address(0) || gLatest == address(0) || eLatest == address(0)) {
            return false;
        }
        if (ERC1967Utils.getImplementation() != tLatest) return true;
        address gImpl = _NaveGovernorViews(governor).currentImplementation();
        address eImpl = _NaveExecutionViews(execution).currentImplementation();
        return gImpl != gLatest || eImpl != eLatest;
    }

    /// Returns the 6-field asset record for `asset`. Extracted to save NaveTreasury bytecode.
    function assetInfo(
        mapping(address => NaveStructs.AssetRecord) storage assets,
        address asset
    )
        external
        view
        returns (
            bool registered,
            bool enabled,
            bool isStablecoin,
            uint8 assetKind,
            bytes32 pythFeedId,
            uint8 decimals
        )
    {
        NaveStructs.AssetRecord storage a = assets[asset];
        return (a.registered, a.enabled, a.isStablecoin, a.assetKind, a.pythFeedId, a.decimals);
    }

    /// Returns the holder annotation (exists, status, text). Extracted to save NaveTreasury bytecode.
    function holderAnnotation(
        mapping(address => NaveStructs.Annotation) storage annotations,
        address holder
    ) external view returns (bool exists, uint8 status, string memory text) {
        NaveStructs.Annotation storage ann = annotations[holder];
        return (ann.exists, ann.status, ann.text);
    }

    /// Returns strategy position info for `adapter`. Extracted to save NaveTreasury bytecode.
    function strategyPosition(
        mapping(address => TreasuryStrategyLib.Position) storage positions,
        address adapter
    ) external view returns (address asset, uint256 depositedAmount, uint256 currentValue) {
        TreasuryStrategyLib.Position storage pos = positions[adapter];
        return (pos.asset, pos.depositedAmount, pos.currentValue);
    }

    function getApprovedAdapters(
        address[] storage approvedAdapters,
        mapping(address => NaveStructs.ProtocolEntry) storage constitution
    )
        external
        view
        returns (
            address[] memory adapters,
            uint16[] memory maxAllocationBps,
            bool[] memory approved,
            string[] memory protocolIds
        )
    {
        uint256 n = approvedAdapters.length;
        adapters = new address[](n);
        maxAllocationBps = new uint16[](n);
        approved = new bool[](n);
        protocolIds = new string[](n);
        for (uint256 i; i < n; i++) {
            address adapter = approvedAdapters[i];
            NaveStructs.ProtocolEntry storage entry = constitution[adapter];
            adapters[i] = adapter;
            maxAllocationBps[i] = entry.maxAllocationBps;
            approved[i] = entry.approved;
            protocolIds[i] = entry.protocolId;
        }
    }
}
