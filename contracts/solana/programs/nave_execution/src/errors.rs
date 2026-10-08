use anchor_lang::prelude::*;

#[error_code]
pub enum ExecutionError {
    #[msg("Global protocol is paused")]
    GlobalPaused,
    #[msg("DAO is frozen")]
    DaoFrozen,
    #[msg("Agents are disabled")]
    AgentsDisabled,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Invalid execution status")]
    InvalidExecutionStatus,
    #[msg("Invalid state transition")]
    InvalidStateTransition,
    #[msg("Payload hash mismatch")]
    PayloadHashMismatch,
    #[msg("Review window active")]
    ReviewWindowActive,
    #[msg("Protocol not approved")]
    ProtocolNotApproved,
    #[msg("Allocation limit exceeded")]
    AllocationLimitExceeded,
    #[msg("Already executed")]
    AlreadyExecuted,
    #[msg("Execution halted")]
    ExecutionHalted,
    #[msg("Direct execution not allowed")]
    DirectExecutionNotAllowed,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Proposal not passed")]
    ProposalNotPassed,
    #[msg("Proposal DAO mismatch")]
    ProposalDaoMismatch,
    #[msg("Invalid proposal type")]
    InvalidProposalType,
    #[msg("Insufficient vault balance")]
    InsufficientVaultBalance,
    #[msg("Unsupported adapter program")]
    UnsupportedAdapter,
    #[msg("Reasoning hash required")]
    ReasoningHashRequired,
    #[msg("Strategy escrow account does not match the canonical per-protocol PDA")]
    EscrowAccountMismatch,
    #[msg("Withdrawal exceeds the amount deployed for this request")]
    WithdrawExceedsDeployed,
    #[msg("Global deployment cap exceeded")]
    DeploymentCapExceeded,
    #[msg("Liquidity floor breached")]
    LiquidityFloorBreached,
    #[msg("Pyth price update account is not owned by the receiver program")]
    InvalidOracleAccount,
    #[msg("Pyth price is stale")]
    StaleOracle,
    #[msg("Asset mint does not match the execution request")]
    AssetMintMismatch,
    #[msg("Asset kind is not compatible with the target protocol")]
    AssetKindMismatch,
    #[msg("Stablecoin reserve floor breached")]
    StablecoinReserveBreached,
    #[msg("Treasury NAV is stale; a fresh revalue_treasury is required before deploying")]
    StaleNav,
    #[msg("Treasury NAV is below the agent operating threshold")]
    AgentThresholdNotMet,
    #[msg("DAO is moonlighting; new strategy deployments are blocked")]
    DaoMoonlighting,
}
