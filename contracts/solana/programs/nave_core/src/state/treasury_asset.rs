use anchor_lang::prelude::*;

/// Per-(dao, mint) treasury accounting record. Each held asset has its own
/// holding token account (the `asset_vault` PDA owned by `vault_authority`) and
/// tracks principal in that asset's base units. Portfolio-level USD aggregates
/// live on `TreasuryVault`; this record holds the raw token figures that the
/// `revalue_treasury` instruction prices into USD.
#[account]
pub struct TreasuryAsset {
    /// PDA bump seed.
    pub bump: u8,
    /// Owning DAO registry key.
    pub dao: Pubkey,
    /// SPL mint of the held asset.
    pub mint: Pubkey,
    /// The `asset_vault` holding token account (owned by vault_authority).
    pub token_account: Pubkey,
    /// Cumulative deposits in base units.
    pub deposited: u64,
    /// Capital currently deployed to strategies in base units (sum across
    /// protocols for this mint).
    pub deployed_capital: u64,
    /// USD micro-units value of this asset (idle + deployed) at the last
    /// `revalue_treasury`. Diagnostic / reconciliation aid.
    pub last_valued_usd: u64,
    /// Timestamp of the last valuation.
    pub last_valued_at: i64,
    /// Accounting anchor for the discrete annual management fee, floored to a
    /// midnight-UTC boundary. The fee becomes due when
    /// `now >= last_management_fee_at + SECONDS_PER_YEAR`; on collection this is
    /// advanced to `floor_to_utc_midnight(now)`. Seeded at asset registration so
    /// the first period is anchored to (the UTC midnight of) registration time.
    /// Per-asset (not vault-level) so each asset's annual cycle is independent.
    pub last_management_fee_at: i64,
}

impl TreasuryAsset {
    pub const LEN: usize = 8 + 1 + 32 + 32 + 32 + 8 + 8 + 8 + 8 + 8;
}
