use anchor_lang::prelude::*;

use crate::constants::MAX_GUARDIAN_WALLETS;

/// Pre-`bootstrapped` layout size (discriminator + body). Existing on-chain
/// accounts created before the Permission-gated guardian update ship this size
/// and must be resized via `resize_guardian_config` before other loads succeed.
pub const GUARDIAN_CONFIG_LEGACY_LEN: usize = 8 + 1 + 32 + 1 + 1 + (32 * MAX_GUARDIAN_WALLETS);

/// Guardian multisig configuration for a DAO.
#[account]
pub struct GuardianConfig {
    /// PDA bump seed.
    pub bump: u8,
    /// Owning DAO registry key.
    pub dao: Pubkey,
    /// Required signatures for guardian actions.
    pub threshold: u8,
    /// Active guardian wallet count.
    pub wallet_count: u8,
    /// Fixed-size guardian wallet list.
    pub wallets: [Pubkey; MAX_GUARDIAN_WALLETS],
    /// False until the founder completes the ActivationHub one-shot guardian
    /// edit (or the first Permission proposal executes). After true, only a
    /// passed `ProposalType::Permission` governance path may change the set.
    /// Appended at the END of the layout to preserve byte offsets for
    /// off-chain decoders; legacy accounts omit this byte until resized.
    pub bootstrapped: bool,
}

impl GuardianConfig {
    pub const LEN: usize = GUARDIAN_CONFIG_LEGACY_LEN + 1;

    pub fn is_guardian(&self, wallet: &Pubkey) -> bool {
        self.wallets[..self.wallet_count as usize].contains(wallet)
    }
}
