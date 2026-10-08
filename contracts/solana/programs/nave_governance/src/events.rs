use anchor_lang::prelude::*;

#[event]
pub struct ProposalCreated {
    pub dao: Pubkey,
    pub proposal: Pubkey,
    pub proposal_index: u64,
    pub proposal_type: u8,
    pub snapshot_slot: u64,
    pub snapshot_supply: u64,
}

#[event]
pub struct VoteCast {
    pub proposal: Pubkey,
    pub voter: Pubkey,
    pub choice: u8,
    pub method: u8,
    pub weight: u64,
}

#[event]
pub struct VoteEscrowLocked {
    pub proposal: Pubkey,
    pub voter: Pubkey,
    pub amount: u64,
}

#[event]
pub struct VoteEscrowReleased {
    pub proposal: Pubkey,
    pub voter: Pubkey,
    pub amount: u64,
}

#[event]
pub struct ProposalFinalized {
    pub proposal: Pubkey,
    pub status: u8,
    pub votes_for: u64,
    pub votes_against: u64,
}

#[event]
pub struct ProposalCancelled {
    pub proposal: Pubkey,
}

#[event]
pub struct DaoTokenMinted {
    pub dao: Pubkey,
    pub mint: Pubkey,
}

#[event]
pub struct AdditionalTokensMinted {
    pub dao: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
}

#[event]
pub struct TokenAuthorityRevoked {
    pub dao: Pubkey,
    pub mint: Pubkey,
}

#[event]
pub struct TokenMetadataUpdated {
    pub dao: Pubkey,
    pub mint: Pubkey,
}

#[event]
pub struct ExecutionRequestQueued {
    pub proposal: Pubkey,
    pub dao: Pubkey,
    pub payload_hash: [u8; 32],
}
