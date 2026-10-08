/// Singleton staking pool config PDA.
pub const STAKE_POOL_SEED: &[u8] = b"stake_pool";
/// Pool authority PDA (owns the stake vault + reward vault; signs payouts).
pub const POOL_AUTHORITY_SEED: &[u8] = b"stake_pool_authority";
/// Stake vault token account PDA (holds staked NAVE principal).
pub const STAKE_VAULT_SEED: &[u8] = b"stake_vault";
/// Reward vault token account PDA (receives the 1% bridge staking fee in NAVE
/// and any relayer-mirrored EVM-side reward top-ups; paid out on claim).
pub const REWARD_VAULT_SEED: &[u8] = b"reward_vault";
/// Per-staker position PDA.
pub const USER_STAKE_SEED: &[u8] = b"user_stake";
/// One-time record that a staker's principal from the closed mainnet pool was
/// credited on this program. Init of this PDA is the replay guard.
pub const LEGACY_CREDIT_SEED: &[u8] = b"legacy_credit";

/// Fixed-point scale for `acc_reward_per_share` (1e12), MasterChef-style. Large
/// enough that per-share rounding dust is negligible for a 6-decimal token.
pub const ACC_SCALE: u128 = 1_000_000_000_000;

/// Fixed-point scale for `reward_rate` (1e12). `reward_rate` stores
/// `tokens_per_second * RATE_SCALE`, so `reward_rate * elapsed / RATE_SCALE`
/// yields the whole-token amount dripped over `elapsed` seconds. The scale keeps
/// sub-token-per-second emission precise for a 6-decimal token over a 365-day
/// window.
pub const RATE_SCALE: u128 = 1_000_000_000_000;

/// Default drip window: rewards funded into the pool are metered out linearly
/// over a rolling 365-day period (Synthetix-style). Stored in seconds.
pub const DEFAULT_REWARD_DURATION: i64 = 365 * 24 * 60 * 60;
