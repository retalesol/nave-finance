use anchor_lang::prelude::*;

use crate::constants::MAX_GUARDIAN_WALLETS;

/// Tracks partial guardian signatures for threshold-gated actions.
#[account]
pub struct GuardianAction {
    /// PDA bump seed.
    pub bump: u8,
    /// Owning DAO registry key.
    pub dao: Pubkey,
    /// Action discriminator (0=freeze, 1=unfreeze).
    pub action_type: u8,
    /// Unique nonce per action attempt.
    pub nonce: u64,
    /// Bitmask of guardian indices that have signed (bit i = wallet i).
    pub signed_mask: u16,
    /// Number of signatures collected.
    pub signature_count: u8,
    /// Whether the action has been executed.
    pub executed: bool,
    /// Creation timestamp.
    pub created_at: i64,
    /// Reserved guardian wallet snapshot count.
    pub wallet_count: u8,
    /// Guardian M-of-N threshold snapshotted at initiation. Comparing the
    /// accumulated `signature_count` against THIS snapshot (not the live
    /// `guardian_config.threshold`) prevents a mid-accumulation guardian-config
    /// change from retroactively lowering (or raising) the bar for an action
    /// that has already started collecting signatures.
    pub threshold: u8,
    /// Snapshot of guardian wallets at initiation.
    pub wallets: [Pubkey; MAX_GUARDIAN_WALLETS],
}

impl GuardianAction {
    pub const LEN: usize = 8 + 1 + 32 + 1 + 8 + 2 + 1 + 1 + 8 + 1 + 1 + (32 * MAX_GUARDIAN_WALLETS);

    pub fn guardian_index(&self, wallet: &Pubkey) -> Option<usize> {
        self.wallets[..self.wallet_count as usize]
            .iter()
            .position(|w| w == wallet)
    }

    pub fn has_signed(&self, index: usize) -> bool {
        (self.signed_mask & (1u16 << index)) != 0
    }

    pub fn record_signature(&mut self, index: usize) -> Result<()> {
        require!(index < self.wallet_count as usize, crate::errors::NaveError::GuardianNotFound);
        require!(!self.has_signed(index), crate::errors::NaveError::DuplicateGuardianSignature);
        self.signed_mask |= 1u16 << index;
        self.signature_count = self.signature_count.saturating_add(1);
        Ok(())
    }
}
