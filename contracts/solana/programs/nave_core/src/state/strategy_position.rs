use anchor_lang::prelude::*;

use crate::constants::MAX_PROTOCOL_ID_LEN;

/// On-chain strategy position tracking per (protocol, asset mint). A DAO can
/// hold positions in the same protocol for different mints, and the same mint
/// across different protocols, so positions are keyed by both.
#[account]
pub struct StrategyPosition {
    /// PDA bump seed.
    pub bump: u8,
    /// Owning DAO registry key.
    pub dao: Pubkey,
    /// Asset mint this position deploys (matches the funding `TreasuryAsset`).
    pub mint: Pubkey,
    /// Receipt-token account holding protocol receipt tokens (cTokens / poolSOL)
    /// for this position; `Pubkey::default()` when the position is escrow-only.
    pub position_token_account: Pubkey,
    /// Approved external venue/market for this position (Kamino lending market,
    /// or Jito SPL stake pool). Bound at init; every protocol CPI must target it.
    /// `Pubkey::default()` until a real on-chain integration is configured.
    pub ext_market: Pubkey,
    /// Approved external reserve/pool account (Kamino reserve, or Jito stake pool
    /// — same as `ext_market` for venues without a separate reserve). Bound at
    /// init; prevents an agent from misrouting escrow into an arbitrary reserve.
    pub ext_reserve: Pubkey,
    /// Fixed-size protocol identifier.
    pub protocol_id: [u8; MAX_PROTOCOL_ID_LEN],
    /// Active protocol id length.
    pub protocol_id_len: u8,
    /// Deposited principal amount (in `mint` base units).
    pub deposited_amount: u64,
    /// Current marked value (in `mint` base units).
    pub current_value: u64,
    /// Last update timestamp.
    pub last_updated: i64,
}

impl StrategyPosition {
    pub const LEN: usize = 8 + 1 + 32 + 32 + 32 + 32 + 32 + MAX_PROTOCOL_ID_LEN + 1 + 8 + 8 + 8;

    pub fn protocol_id_slice(&self) -> &[u8] {
        &self.protocol_id[..self.protocol_id_len as usize]
    }
}
