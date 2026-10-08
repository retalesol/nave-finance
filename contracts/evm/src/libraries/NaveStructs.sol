// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title NaveStructs
/// @notice Storage struct types shared between `NaveTreasury` and its linked
/// admin library (`TreasuryAdminLib`). Declared in one place so the library can
/// take storage references to the treasury's mappings/arrays of these types.
library NaveStructs {
    struct ProtocolEntry {
        uint16 maxAllocationBps;
        bool approved;
        string protocolId;
    }

    struct TokenSlot {
        address mint;
        bool authorityRevoked;
        uint8 decimals;
        string name;
        string symbol;
    }

    struct Annotation {
        bool exists;
        uint8 status;
        uint256 submittedAt;
        uint256 reviewedAt;
        string text;
    }

    struct AssetRecord {
        bool registered;
        bool enabled;
        bool isStablecoin;
        uint8 assetKind;
        uint8 decimals;
        bytes32 pythFeedId;
        uint256 deposited; // base units cumulative
        uint256 deployedCapitalBase; // base units deployed
        uint256 lastValuedUsd;
        uint256 lastValuedAt;
        uint256 lastManagementFeeAt;
    }
}
