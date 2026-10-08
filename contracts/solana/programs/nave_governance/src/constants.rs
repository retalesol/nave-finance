use anchor_lang::prelude::*;

pub const PROPOSAL_SEED: &[u8] = b"proposal";
pub const VOTE_RECORD_SEED: &[u8] = b"vote_record";
pub const VOTE_ESCROW_SEED: &[u8] = b"vote_escrow";
/// SEC-M3: seed for the persistent per-(dao, mint) genesis-mint latch PDA.
pub const TOKEN_GENESIS_SEED: &[u8] = b"token_genesis";

pub const MAX_PROPOSALS_PER_DAO: u64 = 88;
pub const MAX_PROPOSAL_TITLE_LEN: usize = 64;
pub const MAX_PROPOSAL_DESCRIPTION_LEN: usize = 512;
pub const MAX_PROPOSAL_PAYLOAD_LEN: usize = 512;

/// Quorum (bps of snapshot supply) required to mint a new token (25%).
pub const TOKEN_MINT_QUORUM_BPS: u16 = 2_500;
/// Quorum (bps of snapshot supply) required to switch the voting system (70%).
pub const SWITCH_VOTING_QUORUM_BPS: u16 = 7_000;
/// Minimum quorum (bps) for treasury Transfer proposals — the highest-value
/// governance action. A DAO with a very low configured quorum must still clear
/// this floor to drain treasury funds (audit M4).
pub const TRANSFER_MIN_QUORUM_BPS: u16 = 2_500;
/// Upper bound on a proposal's voting period (30 days). Prevents a proposer from
/// locking a proposal open effectively forever with i64::MAX (audit M5).
pub const MAX_VOTING_PERIOD_SECONDS: i64 = 30 * 86_400;

/// Minimum quorum (bps) for the high-impact moonlighting proposals
/// (`MoonlightRequest` / `MoonlightDistribution`). Winding a DAO down and
/// distributing its assets + staked NAVE is at least as consequential as a
/// treasury Transfer, so they clear the same minimum floor.
pub const MOONLIGHT_MIN_QUORUM_BPS: u16 = 2_500;

#[repr(u8)]
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum ProposalType {
    Policy = 0,
    Strategy = 1,
    Permission = 2,
    Emergency = 3,
    General = 4,
    TokenMint = 5,
    TokenRevoke = 6,
    SwitchVotingSystem = 7,
    Transfer = 8,
    /// Phase 5 moonlighting: approved request to wind the DAO down. Passing it
    /// halts agents + blocks new strategy/deposit (enforced in nave_core via
    /// `record_moonlight_request`).
    MoonlightRequest = 9,
    /// Phase 5 moonlighting: binds the approved recipient + asset/stake payout.
    /// Passing it authorizes `nave_core::execute_moonlight_distribution` (stake
    /// release) and the recipient-bound governance Transfer payouts.
    MoonlightDistribution = 10,
}

impl ProposalType {
    pub fn from_u8(value: u8) -> Option<Self> {
        match value {
            0 => Some(Self::Policy),
            1 => Some(Self::Strategy),
            2 => Some(Self::Permission),
            3 => Some(Self::Emergency),
            4 => Some(Self::General),
            5 => Some(Self::TokenMint),
            6 => Some(Self::TokenRevoke),
            7 => Some(Self::SwitchVotingSystem),
            8 => Some(Self::Transfer),
            9 => Some(Self::MoonlightRequest),
            10 => Some(Self::MoonlightDistribution),
            _ => None,
        }
    }

    /// Quorum (bps of snapshot supply) required for this proposal type to pass.
    /// Falls back to the DAO's configured quorum for standard proposal types.
    pub fn quorum_bps(&self, dao_quorum_bps: u16) -> u16 {
        match self {
            Self::TokenMint => TOKEN_MINT_QUORUM_BPS,
            Self::SwitchVotingSystem => SWITCH_VOTING_QUORUM_BPS,
            // Treasury transfers must clear a minimum quorum floor regardless of
            // a (possibly very low) DAO-configured quorum.
            Self::Transfer => dao_quorum_bps.max(TRANSFER_MIN_QUORUM_BPS),
            // Moonlighting is high-impact: enforce the same minimum floor.
            Self::MoonlightRequest | Self::MoonlightDistribution => {
                dao_quorum_bps.max(MOONLIGHT_MIN_QUORUM_BPS)
            }
            _ => dao_quorum_bps,
        }
    }
}

// ── EXTENSION POINT (stub — do NOT build yet) ────────────────────────────────
// Future governance voting-weight = staked-amount: a DAO could weight votes by
// each member's locked DAO-stake (mirroring the `DaoStakeLock` escrow) instead
// of (or alongside) token-escrow weight. Left intentionally unimplemented; the
// `DaoLifecycle.reserved` bytes in nave_core are kept zeroed to accommodate it
// without a layout migration. See the plan's stub note.

#[repr(u8)]
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum ProposalStatus {
    Active = 0,
    Passed = 1,
    Failed = 2,
    Cancelled = 3,
    Executed = 4,
}

impl ProposalStatus {
    pub fn from_u8(value: u8) -> Option<Self> {
        match value {
            0 => Some(Self::Active),
            1 => Some(Self::Passed),
            2 => Some(Self::Failed),
            3 => Some(Self::Cancelled),
            4 => Some(Self::Executed),
            _ => None,
        }
    }
}

#[repr(u8)]
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum VoteChoice {
    For = 0,
    Against = 1,
    Abstain = 2,
}

impl VoteChoice {
    pub fn from_u8(value: u8) -> Option<Self> {
        match value {
            0 => Some(Self::For),
            1 => Some(Self::Against),
            2 => Some(Self::Abstain),
            _ => None,
        }
    }
}

#[repr(u8)]
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum VoteMethod {
    Wallet = 0,
    Escrow = 1,
}
