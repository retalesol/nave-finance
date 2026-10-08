use anchor_lang::prelude::*;

use crate::constants::{
    ProposalStatus, ProposalType, VoteChoice, VoteMethod, MAX_PROPOSAL_DESCRIPTION_LEN,
    MAX_PROPOSAL_PAYLOAD_LEN, MAX_PROPOSAL_TITLE_LEN,
};

#[account]
pub struct Proposal {
    pub bump: u8,
    pub dao: Pubkey,
    pub proposal_index: u64,
    pub proposer: Pubkey,
    pub proposal_type: u8,
    pub status: u8,
    pub title: [u8; MAX_PROPOSAL_TITLE_LEN],
    pub title_len: u8,
    pub description: [u8; MAX_PROPOSAL_DESCRIPTION_LEN],
    pub description_len: u16,
    pub payload: [u8; MAX_PROPOSAL_PAYLOAD_LEN],
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
    /// Governance token mint this proposal is voted with. Snapshotted from
    /// `dao_registry.voting_token` at creation for token-weighted DAOs and
    /// enforced by `lock_tokens_and_vote` (`dao_token_mint` MUST equal this),
    /// so a voter cannot supply an arbitrary attacker-minted token to buy
    /// unbounded voting weight. `Pubkey::default()` for wallet-governed DAOs
    /// (which never lock tokens). Appended at the END of the layout so the
    /// byte offsets consumed by `nave_core::GovernanceProposalLayout` and
    /// off-chain decoders are preserved.
    pub token_mint: Pubkey,
}

impl Proposal {
    pub const LEN: usize = 8
        + 1
        + 32
        + 8
        + 32
        + 1
        + 1
        + MAX_PROPOSAL_TITLE_LEN
        + 1
        + MAX_PROPOSAL_DESCRIPTION_LEN
        + 2
        + MAX_PROPOSAL_PAYLOAD_LEN
        + 2
        + 32
        + 8
        + 8
        + 8
        + 8
        + 8
        + 8
        + 8
        + 8
        + 32; // token_mint

    pub fn set_title(&mut self, title: &[u8]) -> Result<()> {
        require!(
            !title.is_empty() && title.len() <= MAX_PROPOSAL_TITLE_LEN,
            crate::errors::GovernanceError::InvalidTitleLength
        );
        self.title = [0u8; MAX_PROPOSAL_TITLE_LEN];
        self.title[..title.len()].copy_from_slice(title);
        self.title_len = title.len() as u8;
        Ok(())
    }

    pub fn set_description(&mut self, description: &[u8]) -> Result<()> {
        require!(
            description.len() <= MAX_PROPOSAL_DESCRIPTION_LEN,
            crate::errors::GovernanceError::InvalidDescriptionLength
        );
        self.description = [0u8; MAX_PROPOSAL_DESCRIPTION_LEN];
        if !description.is_empty() {
            self.description[..description.len()].copy_from_slice(description);
        }
        self.description_len = description.len() as u16;
        Ok(())
    }

    pub fn set_payload(&mut self, payload: &[u8]) -> Result<()> {
        require!(
            payload.len() <= MAX_PROPOSAL_PAYLOAD_LEN,
            crate::errors::GovernanceError::InvalidPayloadLength
        );
        self.payload = [0u8; MAX_PROPOSAL_PAYLOAD_LEN];
        if !payload.is_empty() {
            self.payload[..payload.len()].copy_from_slice(payload);
        }
        self.payload_len = payload.len() as u16;
        Ok(())
    }

    pub fn is_active(&self) -> bool {
        self.status == ProposalStatus::Active as u8
    }
}

#[account]
pub struct VoteRecord {
    pub bump: u8,
    pub proposal: Pubkey,
    pub voter: Pubkey,
    pub choice: u8,
    pub method: u8,
    pub weight: u64,
    pub voted_at: i64,
}

impl VoteRecord {
    pub const LEN: usize = 8 + 1 + 32 + 32 + 1 + 1 + 8 + 8;
}

/// SEC-M3: persistent per-(dao, mint) record that the one-time ungated
/// "genesis" supply mint has been consumed. `mint_additional_tokens` previously
/// re-derived `is_genesis = mint.supply == 0` on every call, so a founder
/// controlling 100% of supply could burn it all to zero and repeat the ungated
/// genesis mint indefinitely. Once ANY mint (genesis or a passed-proposal mint)
/// runs for a token, `minted` is latched true here and every subsequent mint —
/// regardless of the mint's current supply — must go through the passed
/// `TokenMint` proposal path.
#[account]
pub struct TokenGenesisRecord {
    pub bump: u8,
    pub dao: Pubkey,
    pub mint: Pubkey,
    pub minted: bool,
}

impl TokenGenesisRecord {
    pub const LEN: usize = 8 + 1 + 32 + 32 + 1;
}

#[account]
pub struct VoteEscrow {
    pub bump: u8,
    pub proposal: Pubkey,
    pub voter: Pubkey,
    pub mint: Pubkey,
    pub escrow_token_account: Pubkey,
    pub locked_amount: u64,
    pub released: bool,
    pub locked_at: i64,
    pub released_at: i64,
}

impl VoteEscrow {
    pub const LEN: usize = 8 + 1 + 32 + 32 + 32 + 32 + 8 + 1 + 8 + 8;
}
