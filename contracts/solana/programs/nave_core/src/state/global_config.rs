use anchor_lang::prelude::*;

/// Global protocol configuration singleton.
#[account]
pub struct NaveGlobalConfig {
    /// PDA bump seed.
    pub bump: u8,
    /// Protocol admin authority.
    pub authority: Pubkey,
    /// Treasury receiving formation fees.
    pub treasury: Pubkey,
    /// Whether all protocol activity is paused.
    pub paused: bool,
    /// Lamports required to initialize a DAO.
    pub formation_fee_lamports: u64,
    /// Monotonic DAO identifier counter.
    pub dao_count: u64,
    /// Canonical NAVE SPL mint accepted for the DAO creation stake on this
    /// cluster (mainnet real mint / devnet replica). Occupies the 32 bytes that
    /// were previously `reserved`, so the account byte layout is unchanged;
    /// legacy configs read this as the zero pubkey ("unset"), in which case the
    /// stake instruction accepts any mint until `set_nave_mint` pins it.
    pub nave_mint: Pubkey,
}

impl NaveGlobalConfig {
    pub const LEN: usize = 8 + 1 + 32 + 32 + 1 + 8 + 8 + 32;
}
