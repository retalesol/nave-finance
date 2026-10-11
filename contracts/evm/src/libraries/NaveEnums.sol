// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title NaveEnums
/// @notice Enum surface ported 1:1 from the Solana programs. Discriminant
/// values are preserved exactly (e.g. `ProposalType.Transfer == 8`) so the
/// feature-parity matrix and any cross-chain tooling line up.

/// Four-role agent pipeline (Executive -> Financial -> Oversight, Operational monitors).
enum AgentRole {
    Executive, // 0
    Financial, // 1
    Oversight, // 2
    Operational // 3
}

/// Operational status of an agent slot.
enum AgentStatus {
    Active, // 0
    Paused, // 1
    Revoked, // 2
    Rotating // 3
}

/// Active governance/voting model for a DAO.
enum GovernanceType {
    Wallet, // 0 — guardian wallet votes (weight = 1)
    Token // 1 — token-escrow weighted votes
}

/// Asset classification used to route deployments to compatible protocols.
/// `Stable` is valued at $1; `NativeLike` (ETH/native + LSTs) and `Other` are
/// Pyth/Chainlink priced. (On Solana this enum was Stable/SolLike/Other.)
enum AssetKind {
    Stable, // 0
    NativeLike, // 1
    Other // 2
}

enum PrivacyMode {
    Public, // 0
    Private // 1
}

enum AnnotationStatus {
    Pending, // 0
    Approved, // 1
    Denied // 2
}

/// Proposal taxonomy. `Transfer` (8) now has an on-chain execution handler in
/// the EVM port (it was inert / rejected-at-creation on Solana). `MoonlightRequest`
/// (9) and `MoonlightDistribution` (10) mirror the Solana Phase 5 lifecycle.
enum ProposalType {
    Policy, // 0
    Strategy, // 1
    Permission, // 2
    Emergency, // 3
    General, // 4
    TokenMint, // 5
    TokenRevoke, // 6
    SwitchVotingSystem, // 7
    Transfer, // 8
    MoonlightRequest, // 9 — approved DAO wind-down request (halts agents)
    MoonlightDistribution, // 10 — binds recipient + authorizes asset/stake payout
    ContractUpgrade // 11 — opt-in upgrade of DAO Treasury/Governor/Execution proxies
}

/// Roles for protocol-approved DAO implementation registry (UUPS targets).
enum DaoImplRole {
    Treasury, // 0
    Governor, // 1
    Execution // 2
}

/// DAO moonlighting lifecycle (mirrors Solana `MoonlightStatus`).
/// `Active → Requested → DistributionPending → Distributing → Moonlighted`, with
/// `Moonlighted → Active` only via founder restake.
enum MoonlightStatus {
    Active, // 0
    Requested, // 1
    DistributionPending, // 2
    Distributing, // 3
    Moonlighted // 4
}

enum ProposalStatus {
    Active, // 0
    Passed, // 1
    Failed, // 2
    Cancelled, // 3
    Executed // 4
}

enum VoteChoice {
    For, // 0
    Against, // 1
    Abstain // 2
}

enum VoteMethod {
    Wallet, // 0
    Escrow // 1
}

/// Execution-request state machine.
enum ExecutionStatus {
    Pending, // 0
    ExecutiveApproved, // 1
    FinancialApproved, // 2
    OversightApproved, // 3
    InReview, // 4
    Executed, // 5
    Halted, // 6
    Expired // 7
}

/// What a passed proposal's execution request does once approved.
enum ExecutionKind {
    Strategy, // 0 — deploy into an approved adapter
    Transfer, // 1 — direct treasury transfer (proposal type 8)
    Bridge // 2 — cross-chain hop via an approved IBridgeAdapter
}

/// Guardian M-of-N action discriminators (mirrors the Solana action_type byte
/// for 0–4). EVM-only extensions continue from 5:
///   - CANCEL_RECOVERY (5) — EVM-H1 recovery veto (no Solana equivalent)
///   - NULLIFY_AGENT (6) — Solana uses discriminant 5 for nullify; EVM keeps
///     CANCEL_RECOVERY at 5 for ABI/digest stability and places nullify at 6.
library GuardianActionType {
    uint8 internal constant FREEZE = 0;
    uint8 internal constant UNFREEZE = 1;
    uint8 internal constant UPDATE_AGENT_STATUS = 2;
    uint8 internal constant ROTATE_AGENT_KEY = 3;
    uint8 internal constant DISABLE_AGENTS = 4;
    /// EVM-H1: veto a founder-queued frozen-guardian recovery. A live, honest
    /// guardian quorum signing this proves the recovery is unnecessary.
    uint8 internal constant CANCEL_RECOVERY = 5;
    /// Nullify an agent slot and freeze the DAO. Parity with Solana
    /// `nullify_agent` (guardian M-of-N). Discriminant differs from Solana's
    /// byte 5 — see library note above.
    uint8 internal constant NULLIFY_AGENT = 6;
    /// Clear the guardian lock set by DISABLE_AGENTS and re-enable the pipeline.
    /// The Executive cannot undo a guardian disable on its own.
    uint8 internal constant ENABLE_AGENTS = 7;
    /// Restore a nullified agent slot (does not unfreeze).
    uint8 internal constant RESTORE_AGENT = 8;
    /// Cancel a pending agent rotation (guardian veto of a founder rotation).
    uint8 internal constant CANCEL_AGENT_ROTATION = 9;
}
