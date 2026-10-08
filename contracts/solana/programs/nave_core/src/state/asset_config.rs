use anchor_lang::prelude::*;

/// Per-(dao, mint) configuration for a treasury-eligible asset. Governs how the
/// asset is valued in USD on-chain (Pyth feed + decimals) and how the agent
/// pipeline is allowed to route it (asset_kind). Distinct from `TokenRegistry`,
/// which tracks tokens the DAO itself *issues* rather than *holds*.
#[account]
pub struct AssetConfig {
    /// PDA bump seed.
    pub bump: u8,
    /// Owning DAO registry key.
    pub dao: Pubkey,
    /// SPL mint of the held asset.
    pub mint: Pubkey,
    /// Mint decimals (cached for valuation math).
    pub decimals: u8,
    /// Pyth price-feed id (32-byte feed id, NOT a price account address). Used
    /// with `get_price_no_older_than` to value the asset in USD. May be all
    /// zeroes for stablecoins valued at a hard $1.
    pub pyth_feed_id: [u8; 32],
    /// Whether the asset is a USD-pegged stablecoin valued at exactly $1.
    pub is_stablecoin: bool,
    /// `AssetKind` discriminant for protocol routing.
    pub asset_kind: u8,
    /// Whether the asset is currently enabled for deposits/deployment.
    pub enabled: bool,
}

impl AssetConfig {
    pub const LEN: usize = 8 + 1 + 32 + 32 + 1 + 32 + 1 + 1 + 1;
}
