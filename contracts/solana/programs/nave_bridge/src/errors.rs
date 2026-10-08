use anchor_lang::prelude::*;

#[error_code]
pub enum BridgeError {
    #[msg("Caller is not authorized for this action.")]
    Unauthorized,
    #[msg("The bridge is paused.")]
    BridgePaused,
    #[msg("Amount must be greater than zero.")]
    ZeroAmount,
    #[msg("Fee split (staking + protocol + burn) must equal the total fee bps.")]
    FeeSplitMismatch,
    #[msg("Configured fee exceeds the maximum allowed.")]
    FeeTooHigh,
    #[msg("Arithmetic overflow.")]
    MathOverflow,
    #[msg("Amount exceeds the per-transaction cap.")]
    PerTxCapExceeded,
    #[msg("Amount exceeds the rolling daily release cap.")]
    DailyCapExceeded,
    #[msg("This source message has already been processed (replay).")]
    AlreadyProcessed,
    #[msg("Provided mint does not match the configured NAVE mint.")]
    MintMismatch,
    #[msg("Provided token account owner/authority is invalid.")]
    InvalidTokenAccount,
    #[msg("Provided destination account does not match the configured destination.")]
    InvalidDestination,
    #[msg("Custody did not receive the full locked amount (fee-on-transfer mint?).")]
    LockNotFullyFunded,
    #[msg("EVM recipient must be a non-zero 20-byte address.")]
    InvalidEvmRecipient,
    #[msg("Destination chain id is not supported.")]
    UnsupportedChain,
    #[msg("Amount exceeds the rolling daily lock (outbound) cap.")]
    LockDailyCapExceeded,
    #[msg("Destination-chain allowlist is full.")]
    AllowlistFull,
    #[msg("Chain id must be non-zero.")]
    InvalidChainId,
}
