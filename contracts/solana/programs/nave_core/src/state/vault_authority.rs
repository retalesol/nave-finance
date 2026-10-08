use anchor_lang::prelude::*;

/// Vault authority PDA used as CPI signer for treasury operations.
#[account]
pub struct VaultAuthority {
    /// PDA bump seed.
    pub bump: u8,
    /// Owning DAO registry key.
    pub dao: Pubkey,
}

impl VaultAuthority {
    pub const LEN: usize = 8 + 1 + 32;
}
