// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AgentRole} from "../libraries/NaveEnums.sol";

/// @title INaveTreasury
/// @notice Cross-contract surface of a per-DAO treasury clone consumed by its
/// sibling `NaveGovernor` and `NaveExecution`. Combines the Solana `nave_core`
/// DAO-level state: registry, vault accounting, agents, guardians, constitution,
/// fees, asset config, and strategy positions.
interface INaveTreasury {
    // ── Registry / lifecycle ──────────────────────────────────────────────
    function protocol() external view returns (address);
    function founder() external view returns (address);
    function daoId() external view returns (uint256);
    function frozen() external view returns (bool);
    function agentsEnabled() external view returns (bool);
    function governanceType() external view returns (uint8);
    function quorumBps() external view returns (uint16);
    function votingToken() external view returns (address);
    function proposalCount() external view returns (uint64);
    function nextProposalIndex() external view returns (uint64);
    /// EIP-1967 implementation address for this treasury proxy.
    function currentImplementation() external view returns (address);
    /// True if T/G/E are behind protocol latest approved implementations.
    function needsUpgrade() external view returns (bool);

    // ── Guardians / agents ────────────────────────────────────────────────
    function guardianCount() external view returns (uint8);
    function isGuardian(address wallet) external view returns (bool);
    function guardianThreshold() external view returns (uint8);
    function getGuardians() external view returns (address[] memory wallets, uint8 threshold);
    function guardiansBootstrapped() external view returns (bool);
    function linkedTreasury(uint256 destChainId) external view returns (address);
    /// Agent slot authority + whether the slot is operational (active, not
    /// nullified, status Active, non-zero authority).
    function agent(AgentRole role) external view returns (address authority, bool operational);

    // ── Constitution / policy ─────────────────────────────────────────────
    function isAdapterApproved(address adapter) external view returns (bool);
    function adapterMaxAllocationBps(address adapter) external view returns (uint16);
    function reviewWindowSecs() external view returns (int64);
    /// Minimum treasury NAV (micro-USD) agents must see before deploying capital.
    /// Mirrors Solana constitution.agent_threshold_usd. Zero disables the gate.
    function agentThresholdUsd() external view returns (uint256);
    function policyBps()
        external
        view
        returns (uint16 minStableReserveBps, uint16 maxTotalDeployedBps, uint16 minLiquidityBps);
    function getApprovedAdapters()
        external
        view
        returns (
            address[] memory adapters,
            uint16[] memory maxAllocationBps,
            bool[] memory approved,
            string[] memory protocolIds
        );

    // ── Vault accounting (micro-USD) ──────────────────────────────────────
    function currentNav() external view returns (uint256);
    function deployedCapital() external view returns (uint256);
    function lastRevaluedAt() external view returns (uint256);

    // ── Asset config / per-asset accounting ───────────────────────────────
    function assetInfo(address asset)
        external
        view
        returns (
            bool registered,
            bool enabled,
            bool isStablecoin,
            uint8 assetKind,
            bytes32 pythFeedId,
            uint8 decimals
        );
    function getRegisteredAssets() external view returns (address[] memory assets);
    function idleBalance(address asset) external view returns (uint256);
    function valueAssetUsd(address asset, uint256 amount) external view returns (uint256);

    // ── Strategy positions (keyed by adapter) ─────────────────────────────
    function position(address adapter)
        external
        view
        returns (address asset, uint256 depositedAmount, uint256 currentValue);

    // ── Governor-gated mutators ───────────────────────────────────────────
    function recordProposalCreation() external;
    function isTokenRegistered(address mint) external view returns (bool);
    function tokenAuthorityRevoked(address mint) external view returns (bool);
    function mintRegisteredToken(address mint, address to, uint256 amount) external;
    /// EVM-M3: apply a passed SwitchVotingSystem proposal (Governor-only).
    function switchVotingSystem(uint8 newGovernanceType, address newVotingToken) external;
    /// Apply a passed Permission proposal (Governor-only).
    function applyGuardianConfigFromGovernor(address[] calldata wallets, uint8 threshold) external;

    // ── Execution-gated mutators ──────────────────────────────────────────
    function transferForStrategy(address asset, address adapter, uint256 amount) external;
    function recordStrategyDeposit(
        address adapter,
        address asset,
        uint256 amount,
        uint256 amountUsd
    ) external;
    /// Book assets that left via a bridge: lower NAV and raise deployed capital
    /// so a second move in the same block still sees the first.
    function noteCapitalDeparture(address asset, uint256 amount) external;
    function recordStrategyWithdrawal(
        address adapter,
        address asset,
        uint256 amount,
        uint256 amountUsd
    ) external returns (uint256 perfFeeSkimmed);
    function syncPositionValue(address adapter, uint256 observed) external returns (uint256 applied);
    function executeTransfer(address asset, address recipient, uint256 amount) external;
    /// Governor-only: direct disbursement after a passed Transfer proposal vote.
    function executeGovernanceTransfer(address asset, address recipient, uint256 amount) external;
    /// Governor-only: send a held ERC-721 after a passed NFT-transfer proposal.
    function executeGovernanceNftTransfer(address collection, uint256 tokenId, address recipient) external;
}
