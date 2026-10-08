use anchor_lang::prelude::*;

/// Fee configuration with normal and frozen rates.
///
/// Fee model (post-redesign):
///   - Performance fee = `performance_fee_bps` (default 850 = 8.5%) of realized
///     yield, skimmed on the strategy-withdrawal path straight into the
///     `protocol_revenue_wallet`'s ATA for the withdrawn mint (it never touches
///     the treasury balance). Replaces the old high-water-mark
///     `collect_performance_fee` instruction, which was inert (Finding C).
///   - Management fee = `management_fee_bps` (default 65 = 0.65%) of each
///     registered treasury asset's idle balance, collected at most once per
///     `SECONDS_PER_YEAR` and paid in-kind to the same
///     `protocol_revenue_wallet` ATA for that mint.
#[account]
pub struct FeeConfig {
    /// PDA bump seed.
    pub bump: u8,
    /// Owning DAO registry key.
    pub dao: Pubkey,
    /// Management fee in basis points (default `DEFAULT_MANAGEMENT_FEE_BPS`, 65).
    pub management_fee_bps: u16,
    /// Performance fee in basis points (default `DEFAULT_PERFORMANCE_FEE_BPS`,
    /// 850). Applied to realized yield on withdrawal.
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

    pub fn validate_bps(management: u16, performance: u16) -> Result<()> {
        require!(
            (management as u32) <= 10_000 && (performance as u32) <= 10_000,
            crate::errors::NaveError::InvalidBps
        );
        Ok(())
    }
}
