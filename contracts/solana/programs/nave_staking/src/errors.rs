use anchor_lang::prelude::*;

#[error_code]
pub enum StakingError {
    #[msg("Caller is not authorized for this action.")]
    Unauthorized,
    #[msg("Amount must be greater than zero.")]
    ZeroAmount,
    #[msg("Arithmetic overflow.")]
    MathOverflow,
    #[msg("Insufficient staked balance.")]
    InsufficientStake,
    #[msg("Provided mint does not match the pool's NAVE mint.")]
    MintMismatch,
    #[msg("Provided token account is invalid for this action.")]
    InvalidTokenAccount,
    #[msg("Staking is paused.")]
    Paused,
    #[msg("Pending owner mismatch.")]
    NotPendingOwner,
    #[msg("Reward duration cannot change while a drip window is active.")]
    RewardPeriodActive,
    #[msg("Reward schedule has already been initialized.")]
    RewardScheduleAlreadyInit,
    #[msg("Stake vault does not hold enough NAVE to back this credit.")]
    VaultShortfall,
}
