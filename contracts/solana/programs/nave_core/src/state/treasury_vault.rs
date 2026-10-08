use anchor_lang::prelude::*;

/// Portfolio-level treasury accounting. With the multi-asset redesign the
/// USD-denominated aggregates (`current_nav`, `high_water_mark`,
/// `deployed_capital`, `total_deposited`, `total_withdrawn`) are stored in
/// micro-USD (`USD_SCALE` = 1e6) and recomputed by `revalue_treasury` from each
/// per-mint `TreasuryAsset` priced via Pyth. The legacy single-mint
/// `vault_token_account` is retained only for migration of pre-multi-asset DAOs
/// and is otherwise unused once `asset_count > 0`.
#[account]
pub struct TreasuryVault {
    /// PDA bump seed.
    pub bump: u8,
    /// Owning DAO registry key.
    pub dao: Pubkey,
    /// Legacy single-mint vault token account (migration only).
    pub vault_token_account: Pubkey,
    /// Cumulative deposits in micro-USD.
    pub total_deposited: u64,
    /// Cumulative withdrawals in micro-USD.
    pub total_withdrawn: u64,
    /// Current portfolio net asset value in micro-USD (idle + deployed).
    pub current_nav: u64,
    /// High-water mark for performance fees, in micro-USD.
    pub high_water_mark: u64,
    /// Last management fee collection timestamp.
    pub last_management_fee_at: i64,
    /// Last performance fee collection timestamp.
    pub last_performance_fee_at: i64,
    /// Capital currently deployed to strategy positions, in micro-USD.
    pub deployed_capital: u64,
    /// Number of registered treasury assets (`TreasuryAsset` records).
    pub asset_count: u8,
    /// Unix timestamp of the last `revalue_treasury`. `0` means NAV has never
    /// been computed. Executable strategy deploys hard-block when this is `0`
    /// or older than the configured staleness window, so the USD-denominated
    /// allocation / deployment / reserve caps are always enforced against a
    /// fresh NAV rather than a stale snapshot.
    pub last_revalued_at: i64,
}

impl TreasuryVault {
    pub const LEN: usize = 8 + 1 + 32 + 32 + 8 + 8 + 8 + 8 + 8 + 8 + 8 + 1 + 8;
}
