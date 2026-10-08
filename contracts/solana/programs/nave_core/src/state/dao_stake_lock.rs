use anchor_lang::prelude::*;

/// Per-DAO recoverable creation stake. Companion PDA to `DaoRegistry`
/// (seeds `["dao_stake_lock", dao]`) so the registry byte layout consumed by
/// off-chain decoders / IDL clients is untouched. Holds the bookkeeping for the
/// `$99`-of-NAVE the founder locks at creation; the NAVE itself lives in the
/// dedicated `stake_escrow` token account whose authority is this PDA.
///
/// Formation takes NO protocol profit: this stake is fully recoverable and is
/// released to the approved recipient during an approved moonlight distribution
/// (see `DaoLifecycle`), or back to the founder on wind-down.
#[account]
pub struct DaoStakeLock {
    /// PDA bump seed.
    pub bump: u8,
    /// Owning DAO registry key.
    pub dao: Pubkey,
    /// Founder who locked the stake.
    pub founder: Pubkey,
    /// NAVE mint the stake is denominated in (matches `global_config.nave_mint`
    /// when pinned).
    pub nave_mint: Pubkey,
    /// Escrow token account (authority = this PDA) holding the locked NAVE.
    pub escrow_token_account: Pubkey,
    /// Currently locked NAVE base units.
    pub locked_amount: u64,
    // ── Price-snapshot metadata (for off-chain stake-amount auditing) ───────
    /// Accepted oracle NAVE/USD price at stake time, in micro-USD (e.g. devnet
    /// fixed $10 ⇒ 10_000_000). `0` when no price was supplied.
    pub price_usd_micro: u64,
    /// Target stake USD value at lock time, micro-USD (`$99` ⇒ 99_000_000).
    pub stake_value_usd_micro: u64,
    /// Lifecycle of the stake (see `StakeStatus`).
    pub status: u8,
    /// Whether the stake is eligible to be released (set when an approved
    /// moonlight distribution authorizes the payout to the recipient).
    pub unlock_eligible: bool,
    /// Unix timestamp the stake was (re)locked.
    pub locked_at: i64,
    /// Unix timestamp the stake was released (0 while locked).
    pub released_at: i64,
}

impl DaoStakeLock {
    pub const LEN: usize = 8  // discriminator
        + 1   // bump
        + 32  // dao
        + 32  // founder
        + 32  // nave_mint
        + 32  // escrow_token_account
        + 8   // locked_amount
        + 8   // price_usd_micro
        + 8   // stake_value_usd_micro
        + 1   // status
        + 1   // unlock_eligible
        + 8   // locked_at
        + 8; // released_at
}
