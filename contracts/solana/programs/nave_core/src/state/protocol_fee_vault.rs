use anchor_lang::prelude::*;

/// Program-owned vault that accumulates token-mint fees and funds revoke rewards.
///
/// Lamports are moved in/out via direct lamport arithmetic because the account is
/// owned by this program (a system transfer cannot debit a data-bearing PDA).
#[account]
pub struct ProtocolFeeVault {
    /// PDA bump seed.
    pub bump: u8,
    /// Cumulative lamports collected from token mint fees.
    pub total_collected: u64,
    /// Cumulative lamports paid out as revoke rewards.
    pub total_rewarded: u64,
}

impl ProtocolFeeVault {
    pub const LEN: usize = 8 + 1 + 8 + 8;
}
