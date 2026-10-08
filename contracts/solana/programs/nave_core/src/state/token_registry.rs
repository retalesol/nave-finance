use anchor_lang::prelude::*;

use crate::constants::{MAX_TOKEN_NAME_LEN, MAX_TOKEN_REGISTRY, MAX_TOKEN_SYMBOL_LEN};

/// Token slot within a DAO token registry.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, Debug)]
pub struct TokenSlot {
    /// SPL token mint.
    pub mint: Pubkey,
    /// Whether mint authority has been revoked.
    pub authority_revoked: bool,
    /// Token decimals.
    pub decimals: u8,
    /// Fixed-size token name.
    pub name: [u8; MAX_TOKEN_NAME_LEN],
    /// Active name length.
    pub name_len: u8,
    /// Fixed-size token symbol.
    pub symbol: [u8; MAX_TOKEN_SYMBOL_LEN],
    /// Active symbol length.
    pub symbol_len: u8,
}

/// DAO token registry (max 3 tokens).
#[account]
pub struct TokenRegistry {
    /// PDA bump seed.
    pub bump: u8,
    /// Owning DAO registry key.
    pub dao: Pubkey,
    /// Active token count.
    pub token_count: u8,
    /// Fixed-size token slots.
    pub tokens: [TokenSlot; MAX_TOKEN_REGISTRY],
}

impl TokenRegistry {
    pub const LEN: usize = 8
        + 1
        + 32
        + 1
        + (MAX_TOKEN_REGISTRY * (32 + 1 + 1 + MAX_TOKEN_NAME_LEN + 1 + MAX_TOKEN_SYMBOL_LEN + 1));

    pub fn find_token_index(&self, mint: &Pubkey) -> Option<usize> {
        self.tokens[..self.token_count as usize]
            .iter()
            .position(|slot| slot.mint == *mint)
    }
}
