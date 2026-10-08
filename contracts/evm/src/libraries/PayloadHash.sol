// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title PayloadHash
/// @notice keccak256 payload-binding helpers. Mirrors the Solana NE-7 binding
/// (`sha256(program ‖ amount_le ‖ mint)`) that ties a permissionless execution
/// request to the exact values governance approved. The off-chain proposal
/// builder MUST set `proposal.payloadHash` to the matching hash.
library PayloadHash {
    /// Strategy proposal binding: (adapter, amount, asset).
    /// Off-chain payload == abi.encode(adapter, amount, asset).
    function strategyHash(address adapter, uint256 amount, address asset)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(adapter, amount, asset));
    }

    /// Transfer proposal (type 8) binding: (asset, recipient, amount).
    /// Off-chain payload == abi.encode(asset, recipient, amount).
    function transferHash(address asset, address recipient, uint256 amount)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(asset, recipient, amount));
    }

    /// SwitchVotingSystem proposal (type 7) binding: (newGovernanceType,
    /// newVotingToken). Off-chain payload == abi.encode(newGovernanceType,
    /// newVotingToken) with newGovernanceType widened to uint8.
    function switchVotingHash(uint8 newGovernanceType, address newVotingToken)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(newGovernanceType, newVotingToken));
    }

    /// NFT transfer proposal binding: (collection, recipient, tokenId). Reuses
    /// the Transfer proposal type but binds an ERC-721 (collection, tokenId)
    /// rather than a fungible (asset, amount). A distinct domain tag prevents a
    /// fungible Transfer payload from ever matching an NFT transfer.
    function nftTransferHash(address collection, address recipient, uint256 tokenId)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode("NFT_TRANSFER", collection, recipient, tokenId));
    }

    /// Permission proposal (type 2) binding: (wallets, threshold).
    /// Off-chain payload == abi.encode(wallets, threshold).
    function permissionHash(address[] memory wallets, uint8 threshold)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(wallets, threshold));
    }

    /// Cross-chain bridge strategy binding: (adapter, amount, asset, destChainId, destTreasury).
    /// Off-chain payload == abi.encode(adapter, amount, asset, destChainId, destTreasury).
    function bridgeHash(
        address adapter,
        uint256 amount,
        address asset,
        uint256 destChainId,
        address destTreasury
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(adapter, amount, asset, destChainId, destTreasury));
    }

    /// ContractUpgrade (type 11): upgrade DAO triplet to explicit impls.
    /// Off-chain payload == abi.encode(treasuryImpl, governorImpl, executionImpl).
    function contractUpgradeHash(address treasuryImpl, address governorImpl, address executionImpl)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(treasuryImpl, governorImpl, executionImpl));
    }
    // NOTE: the `UPGRADE_TO_LATEST` sentinel hash was removed — upgrade
    // proposals must bind the concrete implementation triplet above.
}
