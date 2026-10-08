use anchor_lang::prelude::*;

/// Per-DAO moonlighting lifecycle. Companion PDA to `DaoRegistry`
/// (seeds `["dao_lifecycle", dao]`), created on first moonlight action so the
/// registry byte layout stays frozen for existing decoders/IDL clients.
///
/// Phases (see `MoonlightStatus`):
///   - `Requested`: an approved `MoonlightRequest` proposal halts the agents and
///     blocks new strategy/deposit while controlled unwind/distribution runs.
///   - `DistributionPending`: the proposal creator entered the recipient wallet
///     and bound a second `MoonlightDistribution` proposal.
///   - `Distributing`: the distribution proposal passed; assets (SOL/SPL/NFT via
///     the existing governance transfer instructions) and the staked NAVE are
///     released to the recipient.
///   - `Moonlighted`: distribution complete; the DAO is hidden from participants
///     and can only be restored by the founder restaking the current `$99`.
#[account]
pub struct DaoLifecycle {
    /// PDA bump seed.
    pub bump: u8,
    /// Owning DAO registry key.
    pub dao: Pubkey,
    /// Moonlight state machine value (see `MoonlightStatus`).
    pub status: u8,
    /// Passed `MoonlightRequest` proposal that opened the request phase.
    pub request_proposal: Pubkey,
    /// Passed `MoonlightDistribution` proposal binding the recipient + payout.
    pub distribution_proposal: Pubkey,
    /// Approved recipient wallet for the asset + stake distribution.
    pub recipient: Pubkey,
    /// Proposal creator who is authorized to drive the distribution wizard.
    pub initiated_by: Pubkey,
    /// Unix timestamp the moonlight request was recorded.
    pub requested_at: i64,
    /// Unix timestamp distribution was executed (stake released).
    pub distributed_at: i64,
    /// Unix timestamp the DAO was marked moonlighted/hidden.
    pub moonlighted_at: i64,
    /// Unix timestamp the founder restored the DAO (restaked).
    pub restored_at: i64,
    /// EXTENSION POINT (stub — do NOT implement yet): future governance
    /// voting-weight = staked-amount accounting. Reserved bytes are kept zeroed
    /// so the concept can be layered on without a layout migration. See the
    /// plan's "Stub the future voting-weight = staked-amount concept".
    pub reserved: [u8; 64],
}

impl DaoLifecycle {
    pub const LEN: usize = 8  // discriminator
        + 1   // bump
        + 32  // dao
        + 1   // status
        + 32  // request_proposal
        + 32  // distribution_proposal
        + 32  // recipient
        + 32  // initiated_by
        + 8   // requested_at
        + 8   // distributed_at
        + 8   // moonlighted_at
        + 8   // restored_at
        + 64; // reserved (voting-weight extension stub)
}
