use anchor_lang::prelude::*;

/// Fee configuration with normal and frozen rates.
///
/// Fee model:
///   - Performance fee = 1500 bps (15%) of realized yield, skimmed on the
///     strategy-withdrawal path straight into the `protocol_revenue_wallet`'s
///     ATA for the withdrawn mint. Principal is not charged. Frozen treasuries
///     use the same rate. `record_strategy_withdrawal` charges 1500 bps even
///     when this account still stores an older value, then writes 1500.
///   - Management fee = 0. `collect_management_fee` transfers nothing and
///     clears any stored management rate back to 0. It does not advance the
///     annual anchor. The fields stay so this account's byte layout does not
///     move.
#[account]
pub struct FeeConfig {
    /// PDA bump seed.
    pub bump: u8,
    /// Owning DAO registry key.
    pub dao: Pubkey,
    /// Management fee in basis points. Canonical value is 0.
    pub management_fee_bps: u16,
    /// Performance fee in basis points. Canonical value is 1500 (15% of
    /// realized yield on withdrawal).
    pub performance_fee_bps: u16,
    /// Frozen-state management fee in basis points.
    pub frozen_management_fee_bps: u16,
    /// Frozen-state performance fee in basis points.
    pub frozen_performance_fee_bps: u16,
    /// LEGACY (pre-redesign): SPL token account that the old USD-denominated
    /// `collect_*_fee` paths paid into. Retained for account-layout stability;
    /// the new model pays to the `protocol_revenue_wallet`'s ATA per mint
    /// instead. No longer read by the fee instructions.
    pub fee_recipient: Pubkey,
    /// LEGACY (pre-redesign): mint of the stablecoin USD-denominated fees were
    /// paid in. Retained for layout stability; unused by the in-kind fee model.
    pub fee_asset_mint: Pubkey,
    /// Protocol revenue wallet (the SYSTEM/owner account, NOT a token account).
    /// Destination for BOTH the performance-fee skim and the annual management
    /// fee: each fee is paid to this wallet's associated token account for the
    /// relevant mint. Also funds off-chain agent-wallet replenishment (consumed
    /// by the off-chain worker). Must be set at DAO creation.
    pub protocol_revenue_wallet: Pubkey,
}

impl FeeConfig {
    pub const LEN: usize = 8 + 1 + 32 + 2 + 2 + 2 + 2 + 32 + 32 + 32;

    /// Creation accepts only the canonical pair: 0 management bps and 1500
    /// performance bps. Frozen and normal rates are the same pair.
    pub fn validate_bps(management: u16, performance: u16) -> Result<()> {
        require!(
            management == crate::constants::DEFAULT_MANAGEMENT_FEE_BPS
                && performance == crate::constants::DEFAULT_PERFORMANCE_FEE_BPS,
            crate::errors::NaveError::InvalidBps
        );
        Ok(())
    }

    /// Lazy storage correction. Charge paths already use the canonical rates;
    /// this writes them back when an older treasury still stores something else.
    pub fn sync_canonical_rates(&mut self) {
        let management = crate::constants::DEFAULT_MANAGEMENT_FEE_BPS;
        let performance = crate::constants::DEFAULT_PERFORMANCE_FEE_BPS;
        if self.management_fee_bps != management
            || self.frozen_management_fee_bps != management
            || self.performance_fee_bps != performance
            || self.frozen_performance_fee_bps != performance
        {
            self.management_fee_bps = management;
            self.frozen_management_fee_bps = management;
            self.performance_fee_bps = performance;
            self.frozen_performance_fee_bps = performance;
        }
    }
}
