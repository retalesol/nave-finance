use anchor_lang::prelude::*;

/// Central staking pool singleton. Stakers deposit NAVE principal into
/// `stake_vault`; bridge fees (1% staking leg) and relayer-mirrored EVM reward
/// top-ups accrue in `reward_vault` and are distributed MasterChef-style via
/// `acc_reward_per_share`.
#[account]
pub struct StakePool {
    pub bump: u8,
    /// Administrative owner (multisig on mainnet).
    pub owner: Pubkey,
    /// Pending owner for a two-step handoff.
    pub pending_owner: Pubkey,
    /// The NAVE SPL mint staked / rewarded.
    pub nave_mint: Pubkey,
    /// Pool authority PDA (owns both vaults, signs payouts).
    pub pool_authority: Pubkey,
    /// Pool authority PDA bump.
    pub authority_bump: u8,
    /// Token account holding staked principal.
    pub stake_vault: Pubkey,
    /// Token account holding undistributed rewards (bridge fee destination).
    pub reward_vault: Pubkey,
    /// Total NAVE principal currently staked.
    pub total_staked: u64,
    /// Accumulated reward per staked unit, scaled by `ACC_SCALE`.
    pub acc_reward_per_share: u128,
    /// Reward-vault balance the last time rewards were accrued; the delta above
    /// this is treated as newly-arrived reward when `sync` runs.
    pub last_reward_balance: u64,
    /// Whether stake/claim are paused (unstake stays available so users exit).
    pub paused: bool,
    // ── Drip emission (Synthetix-style rolling window) ───────────────────────
    // These four fields were carved out of the original `reserved: [u8; 64]`
    // WITHOUT changing the total account byte size (299), so the already-live
    // devnet pool stays layout-compatible: its reserved bytes are all zero, so
    // these decode as 0 (reward_rate = 0, period_finish = 0, last_update_time =
    // 0, reward_duration = 0) = drip inactive until `init_reward_schedule` seeds
    // the window and the first fund arrives. They sit AFTER `paused`, so decode
    // offsets for every field above are unchanged.
    /// Emission rate in `tokens_per_second * RATE_SCALE`. `0` = no active drip.
    pub reward_rate: u128,
    /// Unix timestamp the current drip window ends. `0` = uninitialized.
    pub period_finish: i64,
    /// Unix timestamp `acc_reward_per_share` was last advanced by the drip.
    pub last_update_time: i64,
    /// Length of the rolling drip window in seconds (default 365 days).
    pub reward_duration: i64,
    pub reserved: [u8; 24],
}

impl StakePool {
    pub const LEN: usize = 8
        + 1                 // bump
        + 32                // owner
        + 32                // pending_owner
        + 32                // nave_mint
        + 32                // pool_authority
        + 1                 // authority_bump
        + 32                // stake_vault
        + 32                // reward_vault
        + 8                 // total_staked
        + 16                // acc_reward_per_share
        + 8                 // last_reward_balance
        + 1                 // paused
        + 16                // reward_rate
        + 8                 // period_finish
        + 8                 // last_update_time
        + 8                 // reward_duration
        + 24; // reserved
}

/// Per-staker position.
#[account]
pub struct UserStake {
    pub bump: u8,
    pub owner: Pubkey,
    /// Amount of NAVE principal this user has staked.
    pub amount: u64,
    /// Reward debt: `amount * acc_reward_per_share / ACC_SCALE` at last update.
    pub reward_debt: u128,
    /// Rewards accrued but not yet withdrawn.
    pub pending: u64,
}

impl UserStake {
    pub const LEN: usize = 8 + 1 + 32 + 8 + 16 + 8;
}

/// One-time marker that `staker` already received a legacy principal credit.
/// The account's existence is the replay guard; the amount is the audit trail.
#[account]
pub struct LegacyCredit {
    pub bump: u8,
    pub staker: Pubkey,
    pub amount: u64,
}

impl LegacyCredit {
    pub const LEN: usize = 8 + 1 + 32 + 8;
}
