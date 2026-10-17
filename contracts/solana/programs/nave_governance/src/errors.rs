use anchor_lang::prelude::*;

#[error_code]
pub enum GovernanceError {
    #[msg("Global protocol is paused")]
    GlobalPaused,
    #[msg("DAO is frozen")]
    DaoFrozen,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("DAO ownership mismatch")]
    DaoOwnershipMismatch,
    #[msg("Max proposals reached")]
    MaxProposalsReached,
    #[msg("Invalid proposal type")]
    InvalidProposalType,
    #[msg("Invalid proposal status")]
    InvalidProposalStatus,
    #[msg("Invalid vote choice")]
    InvalidVoteChoice,
    #[msg("Proposal not active")]
    ProposalNotActive,
    #[msg("Proposal already finalized")]
    ProposalAlreadyFinalized,
    #[msg("Voting period ended")]
    VotingPeriodEnded,
    #[msg("Voting period not ended")]
    VotingPeriodNotEnded,
    #[msg("Already voted")]
    AlreadyVoted,
    #[msg("Guardian membership required for wallet voting")]
    GuardianRequired,
    #[msg("Token not in registry")]
    TokenNotInRegistry,
    #[msg("Token registry full")]
    TokenRegistryFull,
    #[msg("Token authority already revoked")]
    AuthorityAlreadyRevoked,
    #[msg("Escrow not locked")]
    EscrowNotLocked,
    #[msg("Escrow still locked")]
    EscrowStillLocked,
    #[msg("Invalid title length")]
    InvalidTitleLength,
    #[msg("Invalid description length")]
    InvalidDescriptionLength,
    #[msg("Invalid payload length")]
    InvalidPayloadLength,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Insufficient escrow balance")]
    InsufficientEscrowBalance,
    #[msg("Quorum not met")]
    QuorumNotMet,
    #[msg("Token mint not registered")]
    TokenMintNotRegistered,
    #[msg("Wrong governance mode for this voting method")]
    WrongGovernanceMode,
    #[msg("Proposal type has no execution path and cannot be created")]
    ProposalTypeNotImplemented,
    #[msg("Mint/destination/amount does not match the proposal payload")]
    PayloadMismatch,
    #[msg("Voting period out of allowed bounds")]
    InvalidVotingPeriod,
    #[msg("Token mint does not match the proposal's governance voting mint")]
    VotingMintMismatch,
    #[msg("Token governance requires a non-zero voting-token supply")]
    ZeroVotingSupply,
}
