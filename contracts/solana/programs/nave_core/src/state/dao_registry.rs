use anchor_lang::prelude::*;

use crate::constants::MAX_DAO_NAME_LEN;

/// Per-DAO registry and lifecycle state.
#[account]
pub struct DaoRegistry {
    /// PDA bump seed.
    pub bump: u8,
    /// Monotonic DAO identifier.
    pub dao_id: u64,
    /// DAO founder authority.
    pub founder: Pubkey,
    /// Fixed-size DAO name bytes.
    pub name: [u8; MAX_DAO_NAME_LEN],
    /// Active name length.
    pub name_len: u8,
    /// Privacy mode (see PrivacyMode enum).
    pub privacy_mode: u8,
    /// Emergency freeze flag.
    pub frozen: bool,
    /// Whether agent approvals are enabled.
    pub agents_enabled: bool,
    /// Active proposal counter (governance-linked). Incremented on creation and
    /// DECREMENTED by `archive_proposals`; used only for the
    /// `MAX_PROPOSALS_PER_DAO` active-limit enforcement, never as a PDA seed.
    pub proposal_count: u64,
    /// Cumulative archived proposals.
    pub archived_proposals: u64,
    /// Unix timestamp of creation.
    pub created_at: i64,
    /// Unix timestamp of last update.
    pub updated_at: i64,
    /// Minimum participation for proposal passage (basis points of snapshot supply).
    pub quorum_bps: u16,
    /// Active governance/voting model (see GovernanceType enum: 0 = Wallet, 1 = Token).
    pub governance_type: u8,
    /// Designated voting token mint when governance_type == Token (default when none).
    pub voting_token: Pubkey,
    /// Monotonic proposal index. Only ever INCREMENTS (on proposal creation);
    /// `archive_proposals` never touches it. Used as the per-proposal PDA seed
    /// (`PROPOSAL_SEED`) and `proposal_index` so an archived slot's index can
    /// never be reused — which previously caused a PDA `init` collision because
    /// the seed was derived from the decremented `proposal_count`.
    pub next_proposal_index: u64,
    /// One-time founder bootstrap latch. `false` at creation; flipped to `true`
    /// the first time the founder creates a bootstrap execution request (which
    /// snapshots `review_window = 0` for immediate execution). Once set it can
    /// never be reset, so the zero-review-window path is available exactly once
    /// per DAO. Mutated only by `record_bootstrap_usage` (CPI from
    /// `nave_execution`). Appended at the END of the layout to preserve the byte
    /// offsets consumed by off-chain decoders / IDL clients.
    pub bootstrap_used: bool,
}

impl DaoRegistry {
    pub const LEN: usize =
        8 + 1 + 8 + 32 + MAX_DAO_NAME_LEN + 1 + 1 + 1 + 1 + 8 + 8 + 8 + 8 + 2 + 1 + 32 + 8 + 1;

    pub fn set_name(&mut self, name: &[u8]) -> Result<()> {
        require!(
            !name.is_empty() && name.len() <= MAX_DAO_NAME_LEN,
            crate::errors::NaveError::InvalidNameLength
        );
        self.name = [0u8; MAX_DAO_NAME_LEN];
        self.name[..name.len()].copy_from_slice(name);
        self.name_len = name.len() as u8;
        Ok(())
    }
}
