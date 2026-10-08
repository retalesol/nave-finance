//! Wire layout mirror of `nave_governance::state::Proposal` (minus the 8-byte
//! Anchor account discriminator). Kept in sync manually with
//! `programs/nave_governance/src/state.rs` — if that struct changes, update
//! this definition and run Solana program tests.
use anchor_lang::prelude::*;

pub const GOV_MAX_TITLE_LEN: usize = 64;
pub const GOV_MAX_DESCRIPTION_LEN: usize = 512;
pub const GOV_MAX_PAYLOAD_LEN: usize = 512;

/// Must match field order and sizes in `nave_governance::state::Proposal`.
#[derive(AnchorDeserialize, Clone)]
pub struct GovernanceProposalLayout {
    pub bump: u8,
    pub dao: Pubkey,
    pub proposal_index: u64,
    pub proposer: Pubkey,
    pub proposal_type: u8,
    pub status: u8,
    pub title: [u8; GOV_MAX_TITLE_LEN],
    pub title_len: u8,
    pub description: [u8; GOV_MAX_DESCRIPTION_LEN],
    pub description_len: u16,
    pub payload: [u8; GOV_MAX_PAYLOAD_LEN],
    pub payload_len: u16,
    pub payload_hash: [u8; 32],
    pub snapshot_slot: u64,
    pub snapshot_supply: u64,
    pub votes_for: u64,
    pub votes_against: u64,
    pub votes_abstain: u64,
    pub voting_end: i64,
    pub created_at: i64,
    pub finalized_at: i64,
    /// Governance token mint the proposal is voted with (`Pubkey::default()`
    /// for wallet-governed DAOs). Appended at the end of the layout.
    pub token_mint: Pubkey,
}

/// Minimum on-chain size of a `nave_governance::state::Proposal` account
/// (8-byte Anchor discriminator + Borsh body). Keep aligned with
/// `Proposal::LEN` in nave_governance.
pub const GOVERNANCE_PROPOSAL_ACCOUNT_MIN_LEN: usize = 1304;

impl GovernanceProposalLayout {
    /// Deserialize body after the standard 8-byte Anchor account discriminator.
    pub fn try_deserialize_skip_discriminator(data: &[u8]) -> Result<Self> {
        require!(
            data.len() >= GOVERNANCE_PROPOSAL_ACCOUNT_MIN_LEN,
            crate::errors::NaveError::InvalidGovernanceProposal
        );
        let mut slice: &[u8] = &data[8..];
        Self::deserialize(&mut slice).map_err(|_| error!(crate::errors::NaveError::InvalidGovernanceProposal))
    }
}
