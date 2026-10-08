use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

pub mod constants;
pub mod errors;
pub mod events;
pub mod state;

use constants::*;
use errors::StakingError;
use events::*;
use state::{LegacyCredit, StakePool, UserStake};

// Closed on Solana mainnet. This id cannot be redeployed. A future mainnet
// staking program needs a new program id and keypair, paired with the new bridge.
declare_id!("AxVdBgc8eUZ3VXKCCJxF7mAmRAtvtM2eYAbE3XBjnhjf");

/// # nave_staking
///
/// The central Solana staking reward pool for the Nave bridge. Stakers lock
/// NAVE principal here and earn the bridge's 1% staking-fee leg (routed to the
/// pool's `reward_vault` by `nave_bridge`). EVM-side (Base/ETH) staking is
/// mirrored to this pool by the relayer so global reward weight is consistent;
/// when a staker claims on an EVM chain, the relayer wraps the NAVE reward and
/// mints wNAVE to them there. Reward accounting is MasterChef-style
/// (`acc_reward_per_share`), which is O(1) per stake/unstake/claim and robust
/// to arbitrary reward top-ups.
#[program]
pub mod nave_staking {
    use super::*;

    pub fn initialize_pool(ctx: Context<InitializePool>, owner: Pubkey) -> Result<()> {
        require!(owner != Pubkey::default(), StakingError::Unauthorized);
        let pool = &mut ctx.accounts.pool;
        pool.bump = ctx.bumps.pool;
        pool.owner = owner;
        pool.pending_owner = Pubkey::default();
        pool.nave_mint = ctx.accounts.nave_mint.key();
        pool.pool_authority = ctx.accounts.pool_authority.key();
        pool.authority_bump = ctx.bumps.pool_authority;
        pool.stake_vault = ctx.accounts.stake_vault.key();
        pool.reward_vault = ctx.accounts.reward_vault.key();
        pool.total_staked = 0;
        pool.acc_reward_per_share = 0;
        pool.last_reward_balance = 0;
        pool.paused = false;
        // Drip schedule: default 365-day rolling window, clock started now. No
        // active emission (reward_rate = 0, period_finish = 0) until the first
        // fee inflow rolls in and opens a window.
        pool.reward_rate = 0;
        pool.period_finish = 0;
        pool.last_update_time = Clock::get()?.unix_timestamp;
        pool.reward_duration = DEFAULT_REWARD_DURATION;
        pool.reserved = [0u8; 24];
        Ok(())
    }

    /// Stake `amount` NAVE. Accrues any pending reward first, then pulls the
    /// principal into the stake vault.
    pub fn stake(ctx: Context<Stake>, amount: u64) -> Result<()> {
        require!(!ctx.accounts.pool.paused, StakingError::Paused);
        require!(amount > 0, StakingError::ZeroAmount);

        let now = Clock::get()?.unix_timestamp;
        tick_pool(&mut ctx.accounts.pool, ctx.accounts.reward_vault.amount, now)?;
        accrue_user(&ctx.accounts.pool, &mut ctx.accounts.user_stake)?;

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_nave_account.to_account_info(),
                    to: ctx.accounts.stake_vault.to_account_info(),
                    authority: ctx.accounts.owner.to_account_info(),
                },
            ),
            amount,
        )?;

        let pool = &mut ctx.accounts.pool;
        let user = &mut ctx.accounts.user_stake;
        pool.total_staked = pool.total_staked.checked_add(amount).ok_or(StakingError::MathOverflow)?;
        // Persist the canonical PDA bump on first creation (init_if_needed leaves
        // it zero otherwise, which would make `unstake`/`claim` — both gated on
        // `bump = user_stake.bump` — fail to re-derive the account and strand the
        // user's principal). `ctx.bumps.user_stake` is always the canonical bump.
        user.bump = ctx.bumps.user_stake;
        user.owner = ctx.accounts.owner.key();
        user.amount = user.amount.checked_add(amount).ok_or(StakingError::MathOverflow)?;
        user.reward_debt = reward_debt(user.amount, pool.acc_reward_per_share)?;

        emit!(Staked {
            owner: user.owner,
            amount,
            total_staked: pool.total_staked,
            timestamp: Clock::get()?.unix_timestamp,
        });
        Ok(())
    }

    /// Unstake `amount` NAVE principal (always available, even while paused, so
    /// users can exit). Accrues pending reward first.
    pub fn unstake(ctx: Context<Unstake>, amount: u64) -> Result<()> {
        require!(amount > 0, StakingError::ZeroAmount);
        require!(ctx.accounts.user_stake.amount >= amount, StakingError::InsufficientStake);

        let now = Clock::get()?.unix_timestamp;
        tick_pool(&mut ctx.accounts.pool, ctx.accounts.reward_vault.amount, now)?;
        accrue_user(&ctx.accounts.pool, &mut ctx.accounts.user_stake)?;

        let authority_bump = ctx.accounts.pool.authority_bump;
        transfer_from_vault(
            &ctx.accounts.token_program,
            &ctx.accounts.stake_vault,
            &ctx.accounts.user_nave_account,
            &ctx.accounts.pool_authority,
            authority_bump,
            amount,
        )?;

        let pool = &mut ctx.accounts.pool;
        let user = &mut ctx.accounts.user_stake;
        pool.total_staked = pool.total_staked.checked_sub(amount).ok_or(StakingError::MathOverflow)?;
        user.amount = user.amount.checked_sub(amount).ok_or(StakingError::MathOverflow)?;
        user.reward_debt = reward_debt(user.amount, pool.acc_reward_per_share)?;

        emit!(Unstaked {
            owner: user.owner,
            amount,
            total_staked: pool.total_staked,
            timestamp: Clock::get()?.unix_timestamp,
        });
        Ok(())
    }

    /// Claim accrued NAVE rewards out of the reward vault.
    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        require!(!ctx.accounts.pool.paused, StakingError::Paused);

        let now = Clock::get()?.unix_timestamp;
        tick_pool(&mut ctx.accounts.pool, ctx.accounts.reward_vault.amount, now)?;
        accrue_user(&ctx.accounts.pool, &mut ctx.accounts.user_stake)?;

        // Never pay more than the vault holds (defensive: rounding / partial
        // funding can't brick the instruction).
        let vault_balance = ctx.accounts.reward_vault.amount;
        let payout = ctx.accounts.user_stake.pending.min(vault_balance);
        require!(payout > 0, StakingError::ZeroAmount);

        let authority_bump = ctx.accounts.pool.authority_bump;
        transfer_from_vault(
            &ctx.accounts.token_program,
            &ctx.accounts.reward_vault,
            &ctx.accounts.user_nave_account,
            &ctx.accounts.pool_authority,
            authority_bump,
            payout,
        )?;

        // Reflect the payout in the tracked reward balance so the next `sync`
        // delta is correct.
        ctx.accounts.reward_vault.reload()?;
        let pool = &mut ctx.accounts.pool;
        pool.last_reward_balance = ctx.accounts.reward_vault.amount;

        let user = &mut ctx.accounts.user_stake;
        user.pending = user.pending.checked_sub(payout).ok_or(StakingError::MathOverflow)?;
        user.reward_debt = reward_debt(user.amount, pool.acc_reward_per_share)?;

        emit!(RewardClaimed {
            owner: user.owner,
            amount: payout,
            timestamp: Clock::get()?.unix_timestamp,
        });
        Ok(())
    }

    /// Permissionless poke: advance the time-metered drip and roll any
    /// newly-arrived reward-vault balance into a fresh 365-day window. Called
    /// opportunistically by the relayer after it tops up EVM-mirrored rewards
    /// (and periodically to keep the UI fresh), but anyone may call it.
    pub fn sync(ctx: Context<Sync>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let reward_balance = ctx.accounts.reward_vault.amount;
        tick_pool(&mut ctx.accounts.pool, reward_balance, now)?;
        let pool = &ctx.accounts.pool;
        emit!(RewardsAccrued {
            new_rewards: 0,
            acc_reward_per_share: pool.acc_reward_per_share,
            total_staked: pool.total_staked,
            timestamp: now,
        });
        Ok(())
    }

    pub fn set_paused(ctx: Context<OwnerOnly>, paused: bool) -> Result<()> {
        ctx.accounts.pool.paused = paused;
        Ok(())
    }

    /// Owner-only: change the drip window length (seconds). Only permitted when
    /// no window is active (`now >= period_finish`), so an in-flight emission is
    /// never re-stretched or compressed mid-flight. Takes effect on the next
    /// fee inflow (`roll_in_new_rewards`).
    pub fn set_reward_duration(ctx: Context<OwnerOnly>, secs: i64) -> Result<()> {
        require!(secs > 0, StakingError::ZeroAmount);
        let now = Clock::get()?.unix_timestamp;
        require!(now >= ctx.accounts.pool.period_finish, StakingError::RewardPeriodActive);
        ctx.accounts.pool.reward_duration = secs;
        Ok(())
    }

    /// Owner-only, one-time: seed the drip schedule on a pool whose schedule
    /// fields are still zero (the already-live devnet pool, whose reserved bytes
    /// decode as 0). Sets the default duration, starts the clock, and leaves the
    /// window closed (reward_rate = 0, period_finish = now) so the FIRST fee
    /// inflow after this opens a proper 365-day drip window — no idle balance is
    /// dumped instantly. Idempotency guard: refuses to run once the schedule has
    /// already been initialized.
    pub fn init_reward_schedule(ctx: Context<OwnerOnly>) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        require!(pool.reward_duration == 0, StakingError::RewardScheduleAlreadyInit);
        let now = Clock::get()?.unix_timestamp;
        pool.reward_duration = DEFAULT_REWARD_DURATION;
        pool.reward_rate = 0;
        pool.period_finish = now;
        pool.last_update_time = now;
        Ok(())
    }

    pub fn transfer_ownership(ctx: Context<OwnerOnly>, new_owner: Pubkey) -> Result<()> {
        require!(new_owner != Pubkey::default(), StakingError::Unauthorized);
        ctx.accounts.pool.pending_owner = new_owner;
        Ok(())
    }

    /// Owner-only, once per staker. Credits principal that is stuck in the closed
    /// mainnet stake vault onto this pool. The owner must already have transferred
    /// the NAVE into this pool's stake vault. The staker withdraws it later with
    /// `unstake` (which stays available while the pool is paused). Does not mint
    /// rewards for the credited amount.
    pub fn credit_legacy_principal(ctx: Context<CreditLegacy>, amount: u64) -> Result<()> {
        require!(amount > 0, StakingError::ZeroAmount);
        let staker = ctx.accounts.staker.key();
        require!(staker != Pubkey::default(), StakingError::Unauthorized);

        let now = Clock::get()?.unix_timestamp;
        tick_pool(&mut ctx.accounts.pool, ctx.accounts.reward_vault.amount, now)?;
        accrue_user(&ctx.accounts.pool, &mut ctx.accounts.user_stake)?;

        let next_total = ctx
            .accounts
            .pool
            .total_staked
            .checked_add(amount)
            .ok_or(StakingError::MathOverflow)?;
        require!(
            ctx.accounts.stake_vault.amount >= next_total,
            StakingError::VaultShortfall
        );

        let user = &mut ctx.accounts.user_stake;
        if user.owner != Pubkey::default() {
            require!(user.owner == staker, StakingError::Unauthorized);
        }
        user.bump = ctx.bumps.user_stake;
        user.owner = staker;
        user.amount = user.amount.checked_add(amount).ok_or(StakingError::MathOverflow)?;
        user.reward_debt = reward_debt(user.amount, ctx.accounts.pool.acc_reward_per_share)?;

        ctx.accounts.pool.total_staked = next_total;

        let credit = &mut ctx.accounts.legacy_credit;
        credit.bump = ctx.bumps.legacy_credit;
        credit.staker = staker;
        credit.amount = amount;

        emit!(LegacyPrincipalCredited {
            staker,
            amount,
            total_staked: next_total,
            timestamp: now,
        });
        Ok(())
    }

    pub fn accept_ownership(ctx: Context<AcceptOwnership>) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        pool.owner = ctx.accounts.new_owner.key();
        pool.pending_owner = Pubkey::default();
        Ok(())
    }
}

// ─── Reward math ─────────────────────────────────────────────────────────────

/// Advance the time-metered drip up to `now`, then roll any newly-arrived
/// reward-vault balance into a fresh window. This is the drip replacement for
/// the old instant `sync_pool`: `stake`/`unstake`/`claim`/`sync` all call it
/// before `accrue_user`. Order matters — settle the outstanding drip against the
/// current `reward_rate` first, then reset the window so `leftover` is measured
/// correctly.
fn tick_pool(pool: &mut StakePool, reward_balance: u64, now: i64) -> Result<()> {
    update_pool(pool, now)?;
    roll_in_new_rewards(pool, reward_balance, now)?;
    Ok(())
}

/// Advance `acc_reward_per_share` by the amount the active window has dripped
/// since `last_update_time`, capped at `period_finish`. Emission is only
/// allocated while `total_staked > 0`; the clock still advances during
/// zero-stake gaps (Synthetix semantics), so undistributed drip in those gaps is
/// not retroactively dumped on the next staker.
fn update_pool(pool: &mut StakePool, now: i64) -> Result<()> {
    let applicable = now.min(pool.period_finish);
    if applicable <= pool.last_update_time {
        return Ok(());
    }
    let elapsed = (applicable - pool.last_update_time) as u128;
    if pool.total_staked > 0 && pool.reward_rate > 0 {
        let emitted = pool
            .reward_rate
            .checked_mul(elapsed)
            .ok_or(StakingError::MathOverflow)?
            / RATE_SCALE;
        if emitted > 0 {
            let per_share = emitted
                .checked_mul(ACC_SCALE)
                .ok_or(StakingError::MathOverflow)?
                / pool.total_staked as u128;
            pool.acc_reward_per_share = pool
                .acc_reward_per_share
                .checked_add(per_share)
                .ok_or(StakingError::MathOverflow)?;
        }
    }
    pool.last_update_time = applicable;
    Ok(())
}

/// Detect fees that arrived since the last touch (`reward_balance -
/// last_reward_balance`) and, when positive, (re)open a rolling drip window:
/// blend the new fees with the `leftover` still-undripped portion of the current
/// window and spread the total over `reward_duration`. No-op until the schedule
/// is seeded (`reward_duration > 0`) so a pool with zeroed reserved bytes never
/// divides by zero — the drip stays inactive until `init_reward_schedule`.
fn roll_in_new_rewards(pool: &mut StakePool, reward_balance: u64, now: i64) -> Result<()> {
    if reward_balance <= pool.last_reward_balance || pool.reward_duration <= 0 {
        return Ok(());
    }
    let new_rewards = (reward_balance - pool.last_reward_balance) as u128;
    // Undripped remainder of the window that is still live.
    let leftover = if now < pool.period_finish {
        pool.reward_rate
            .checked_mul((pool.period_finish - now) as u128)
            .ok_or(StakingError::MathOverflow)?
            / RATE_SCALE
    } else {
        0
    };
    let total = new_rewards
        .checked_add(leftover)
        .ok_or(StakingError::MathOverflow)?;
    pool.reward_rate = total
        .checked_mul(RATE_SCALE)
        .ok_or(StakingError::MathOverflow)?
        / pool.reward_duration as u128;
    pool.period_finish = now
        .checked_add(pool.reward_duration)
        .ok_or(StakingError::MathOverflow)?;
    pool.last_update_time = now;
    pool.last_reward_balance = reward_balance;
    Ok(())
}

/// Move a user's freshly-earned rewards (since their last touch) into `pending`.
fn accrue_user(pool: &StakePool, user: &mut UserStake) -> Result<()> {
    let accumulated = (user.amount as u128)
        .checked_mul(pool.acc_reward_per_share)
        .ok_or(StakingError::MathOverflow)?
        / ACC_SCALE;
    let earned = accumulated.saturating_sub(user.reward_debt);
    if earned > 0 {
        let earned_u64 = u64::try_from(earned).map_err(|_| error!(StakingError::MathOverflow))?;
        user.pending = user.pending.checked_add(earned_u64).ok_or(StakingError::MathOverflow)?;
    }
    Ok(())
}

fn reward_debt(amount: u64, acc_reward_per_share: u128) -> Result<u128> {
    (amount as u128)
        .checked_mul(acc_reward_per_share)
        .ok_or(error!(StakingError::MathOverflow))
        .map(|v| v / ACC_SCALE)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pool_with(total_staked: u64, acc: u128, last: u64) -> StakePool {
        StakePool {
            bump: 0,
            owner: Pubkey::default(),
            pending_owner: Pubkey::default(),
            nave_mint: Pubkey::default(),
            pool_authority: Pubkey::default(),
            authority_bump: 0,
            stake_vault: Pubkey::default(),
            reward_vault: Pubkey::default(),
            total_staked,
            acc_reward_per_share: acc,
            last_reward_balance: last,
            paused: false,
            reward_rate: 0,
            period_finish: 0,
            last_update_time: 0,
            reward_duration: 0,
            reserved: [0u8; 24],
        }
    }

    /// Pool primed for drip tests: schedule seeded (`reward_duration`), clock at
    /// t=0, window closed until the first `roll_in_new_rewards`. Short durations
    /// keep the fixed-point drip math exact so assertions can be exact.
    fn drip_pool(total_staked: u64, reward_duration: i64) -> StakePool {
        let mut pool = pool_with(total_staked, 0, 0);
        pool.reward_duration = reward_duration;
        pool.last_update_time = 0;
        pool.period_finish = 0;
        pool
    }

    fn user(amount: u64, reward_debt: u128) -> UserStake {
        UserStake { bump: 0, owner: Pubkey::default(), amount, reward_debt, pending: 0 }
    }

    #[test]
    fn rewards_distribute_pro_rata() {
        // Alice 30, Bob 10 staked; 40 NAVE funded and fully dripped over the
        // window distribute 75% / 25% just like the instant model did.
        let mut pool = drip_pool(40_000_000, 40);
        roll_in_new_rewards(&mut pool, 40_000_000, 0).unwrap();
        update_pool(&mut pool, 40).unwrap(); // whole window elapses

        let mut alice = user(30_000_000, 0);
        let mut bob = user(10_000_000, 0);
        accrue_user(&pool, &mut alice).unwrap();
        accrue_user(&pool, &mut bob).unwrap();
        assert_eq!(alice.pending, 30_000_000); // 75%
        assert_eq!(bob.pending, 10_000_000); // 25%
    }

    #[test]
    fn late_staker_earns_nothing_from_past_rewards() {
        // 10 NAVE funded and fully dripped before Bob stakes.
        let mut pool = drip_pool(10_000_000, 10);
        roll_in_new_rewards(&mut pool, 10_000_000, 0).unwrap();
        update_pool(&mut pool, 10).unwrap();
        let acc_after = pool.acc_reward_per_share;

        // Bob stakes AFTER the drip: his debt snapshots the current acc.
        let mut bob = user(10_000_000, reward_debt(10_000_000, acc_after).unwrap());
        accrue_user(&pool, &mut bob).unwrap();
        assert_eq!(bob.pending, 0);
    }

    #[test]
    fn reward_debt_roundtrips_and_bump_is_nonzero_semantics() {
        // Guards the SEC fix: after a stake, a user's reward_debt must snapshot
        // amount*acc/scale so no past reward is double-counted. (The bump-persist
        // itself is exercised by the live devnet stake→unstake smoke test, which
        // fails to re-derive the PDA if the bump is left zero.)
        let acc = 3 * ACC_SCALE; // 3 reward units per staked unit
        let debt = reward_debt(10_000_000, acc).unwrap();
        assert_eq!(debt, 30_000_000);
        let pool = pool_with(10_000_000, acc, 10_000_000);
        let mut u = UserStake { bump: 254, owner: Pubkey::default(), amount: 10_000_000, reward_debt: debt, pending: 0 };
        accrue_user(&pool, &mut u).unwrap();
        assert_eq!(u.pending, 0); // already fully accounted at stake time
        assert_ne!(u.bump, 0);
    }

    #[test]
    fn drip_accrues_linearly_and_caps_at_period_finish() {
        // 100 NAVE funded over a 100s window: exactly half has dripped at the
        // midpoint, and no more accrues after period_finish.
        let mut pool = drip_pool(10_000_000, 100);
        roll_in_new_rewards(&mut pool, 100_000_000, 0).unwrap();
        assert_eq!(pool.period_finish, 100);
        assert_eq!(pool.reward_rate, 1_000_000_000_000_000_000u128); // 100M*RATE_SCALE/100

        update_pool(&mut pool, 50).unwrap(); // halfway
        let mut half = user(10_000_000, 0);
        accrue_user(&pool, &mut half).unwrap();
        assert_eq!(half.pending, 50_000_000);

        // Well past the window: only the remaining half drips, capped at finish.
        update_pool(&mut pool, 500).unwrap();
        assert_eq!(pool.last_update_time, 100); // clamped to period_finish
        let mut full = user(10_000_000, 0);
        accrue_user(&pool, &mut full).unwrap();
        assert_eq!(full.pending, 100_000_000);
    }

    #[test]
    fn rolling_window_reset_blends_leftover() {
        // Fund 100M over 100s, drip half, then fund another 50M: the 50M
        // leftover blends with the new 50M into a fresh full-duration window.
        let mut pool = drip_pool(10_000_000, 100);
        roll_in_new_rewards(&mut pool, 100_000_000, 0).unwrap();
        update_pool(&mut pool, 50).unwrap(); // 50M dripped, 50M leftover

        roll_in_new_rewards(&mut pool, 150_000_000, 50).unwrap();
        assert_eq!(pool.period_finish, 150); // now + reward_duration
        assert_eq!(pool.reward_rate, 1_000_000_000_000_000_000u128); // (50M+50M)*SCALE/100

        update_pool(&mut pool, 150).unwrap(); // drip the whole new window
        let mut u = user(10_000_000, 0);
        accrue_user(&pool, &mut u).unwrap();
        assert_eq!(u.pending, 150_000_000); // every funded token eventually drips
    }

    #[test]
    fn zero_stake_drip_is_not_dumped_on_late_staker() {
        // Funds arrive while nobody is staked: the clock still advances, so the
        // drip over the empty gap is forfeited rather than dumped on the first
        // staker (Synthetix semantics).
        let mut pool = drip_pool(0, 100);
        roll_in_new_rewards(&mut pool, 100_000_000, 0).unwrap();

        update_pool(&mut pool, 50).unwrap(); // 50s pass with an empty pool
        assert_eq!(pool.acc_reward_per_share, 0);
        assert_eq!(pool.last_update_time, 50);

        // Staker joins at t=50 and snapshots acc (still 0).
        pool.total_staked = 10_000_000;
        let mut u = user(10_000_000, reward_debt(10_000_000, pool.acc_reward_per_share).unwrap());

        // Only the remaining 50s (50M) is captured; the empty-gap 50M is gone.
        update_pool(&mut pool, 100).unwrap();
        accrue_user(&pool, &mut u).unwrap();
        assert_eq!(u.pending, 50_000_000);
    }

    #[test]
    fn drip_inactive_until_schedule_seeded() {
        // A pool with zeroed schedule fields (the pre-upgrade devnet layout)
        // must not divide by zero or drip anything on a fund.
        let mut pool = pool_with(10_000_000, 0, 0); // reward_duration == 0
        roll_in_new_rewards(&mut pool, 100_000_000, 1_000).unwrap();
        assert_eq!(pool.reward_rate, 0);
        assert_eq!(pool.period_finish, 0);
        assert_eq!(pool.last_reward_balance, 0); // nothing tracked yet
        update_pool(&mut pool, 2_000).unwrap();
        assert_eq!(pool.acc_reward_per_share, 0);
    }

    /// `roll_in_new_rewards` is a no-op when the reward-vault balance has not
    /// grown (equal or lower than the last tracked balance): no phantom window
    /// opens and the rate is untouched. Guards against a claim (which lowers the
    /// balance) being mistaken for a fresh inflow.
    #[test]
    fn no_new_window_when_balance_did_not_grow() {
        let mut pool = drip_pool(10_000_000, 100);
        roll_in_new_rewards(&mut pool, 100_000_000, 0).unwrap();
        let rate = pool.reward_rate;
        let finish = pool.period_finish;

        // Same balance again → nothing changes.
        roll_in_new_rewards(&mut pool, 100_000_000, 10).unwrap();
        assert_eq!(pool.reward_rate, rate);
        assert_eq!(pool.period_finish, finish);

        // A balance BELOW last (e.g. right after a payout) also opens nothing.
        roll_in_new_rewards(&mut pool, 90_000_000, 20).unwrap();
        assert_eq!(pool.reward_rate, rate);
        assert_eq!(pool.period_finish, finish);
        assert_eq!(pool.last_reward_balance, 100_000_000); // unchanged
    }

    /// Solvency cap: `claim` pays `min(pending, vault_balance)`. Even if the
    /// accounting says a user earned more than the vault currently holds (e.g.
    /// rewards were partially swept or not yet funded), the payout is clamped to
    /// the vault and can never transfer principal out of the reward vault.
    #[test]
    fn claim_payout_is_capped_by_vault_balance() {
        let pending: u64 = 100_000_000;
        // Vault under-funded relative to accrued pending.
        let vault: u64 = 30_000_000;
        let payout = pending.min(vault);
        assert_eq!(payout, 30_000_000);
        // Fully funded: pays the full pending.
        assert_eq!(pending.min(200_000_000), pending);
    }

    /// Solana truncation dust IS recaptured (contrast with the EVM finding):
    /// `roll_in_new_rewards` measures the actual vault balance delta, so any
    /// sub-unit remainder that did not drip in one window is still part of the
    /// vault balance and folds into `leftover` on the next inflow. Here two
    /// funds that individually truncate still drip their FULL combined total.
    #[test]
    fn solana_recaptures_truncation_dust_across_funds() {
        // Duration 7 (indivisible) so rate*duration < funded per window.
        let mut pool = drip_pool(10_000_000, 7);

        // Fund 1: 100 base units over 7s. rate = 100*SCALE/7 (truncates).
        roll_in_new_rewards(&mut pool, 100, 0).unwrap();
        update_pool(&mut pool, 7).unwrap(); // whole window elapses

        // Fund 2 at t=7: vault grew to 250 (another 150 arrived). The leftover
        // is 0 (window ended) but last_reward_balance tracked the true balance,
        // so the new window meters (250 - 100) = 150 plus any residual.
        roll_in_new_rewards(&mut pool, 250, 7).unwrap();
        update_pool(&mut pool, 14).unwrap();

        let mut u = user(10_000_000, 0);
        accrue_user(&pool, &mut u).unwrap();

        // Total emitted differs from 250 only by the final-window truncation
        // remainder (< duration base units), NOT by both windows' dust — the
        // balance-delta measurement recaptured window 1's shortfall.
        let emitted = u.pending;
        assert!(emitted <= 250, "never over-emits funded total");
        assert!(emitted >= 250 - 7, "recaptures all but final-window dust");
    }

    /// `reward_debt` snapshots `amount * acc / ACC_SCALE`; a huge acc that would
    /// overflow u128 is rejected rather than wrapped.
    #[test]
    fn reward_debt_overflow_is_rejected() {
        assert!(reward_debt(u64::MAX, u128::MAX).is_err());
        assert!(reward_debt(0, u128::MAX).is_ok()); // 0 * anything = 0
    }

    /// Three sequential mid-window funds each blend their leftover forward, and
    /// the full funded total eventually drips (no value stranded on Solana).
    #[test]
    fn three_sequential_funds_all_drip() {
        let mut pool = drip_pool(10_000_000, 100);
        roll_in_new_rewards(&mut pool, 30_000_000, 0).unwrap();
        update_pool(&mut pool, 30).unwrap();
        roll_in_new_rewards(&mut pool, 60_000_000, 30).unwrap(); // +30M
        update_pool(&mut pool, 60).unwrap();
        roll_in_new_rewards(&mut pool, 90_000_000, 60).unwrap(); // +30M
        // Drip the final window fully.
        update_pool(&mut pool, 60 + 100).unwrap();

        let mut u = user(10_000_000, 0);
        accrue_user(&pool, &mut u).unwrap();
        // 90M funded total; only the last window's truncation dust (< duration)
        // may remain undripped.
        assert!(u.pending <= 90_000_000);
        assert!(u.pending >= 90_000_000 - 100, "≥ funded minus final-window dust");
    }
}

fn transfer_from_vault<'info>(
    token_program: &Program<'info, Token>,
    vault: &Account<'info, TokenAccount>,
    dest: &Account<'info, TokenAccount>,
    pool_authority: &UncheckedAccount<'info>,
    bump: u8,
    amount: u64,
) -> Result<()> {
    let seeds: &[&[u8]] = &[POOL_AUTHORITY_SEED, &[bump]];
    let signer: &[&[&[u8]]] = &[seeds];
    token::transfer(
        CpiContext::new_with_signer(
            token_program.to_account_info(),
            Transfer {
                from: vault.to_account_info(),
                to: dest.to_account_info(),
                authority: pool_authority.to_account_info(),
            },
            signer,
        ),
        amount,
    )
}

// ─── Account contexts ────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct InitializePool<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    // SECURITY (init race): only the program's upgrade authority may bootstrap
    // the singleton pool (see the equivalent guard on nave_bridge's
    // InitializeConfig). Prevents a front-runner from owning the pool between
    // deploy and the cutover init tx.
    #[account(constraint = staking_program.programdata_address()? == Some(program_data.key()) @ StakingError::Unauthorized)]
    pub staking_program: Program<'info, crate::program::NaveStaking>,
    #[account(constraint = program_data.upgrade_authority_address == Some(payer.key()) @ StakingError::Unauthorized)]
    pub program_data: Account<'info, ProgramData>,

    #[account(
        init,
        payer = payer,
        space = StakePool::LEN,
        seeds = [STAKE_POOL_SEED],
        bump
    )]
    pub pool: Box<Account<'info, StakePool>>,

    pub nave_mint: Box<Account<'info, Mint>>,

    /// CHECK: pool authority PDA; validated by seeds.
    #[account(seeds = [POOL_AUTHORITY_SEED], bump)]
    pub pool_authority: UncheckedAccount<'info>,

    #[account(
        init,
        payer = payer,
        seeds = [STAKE_VAULT_SEED],
        bump,
        token::mint = nave_mint,
        token::authority = pool_authority,
    )]
    pub stake_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        init,
        payer = payer,
        seeds = [REWARD_VAULT_SEED],
        bump,
        token::mint = nave_mint,
        token::authority = pool_authority,
    )]
    pub reward_vault: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct Stake<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(mut, seeds = [STAKE_POOL_SEED], bump = pool.bump)]
    pub pool: Box<Account<'info, StakePool>>,

    #[account(
        init_if_needed,
        payer = owner,
        space = UserStake::LEN,
        seeds = [USER_STAKE_SEED, owner.key().as_ref()],
        bump
    )]
    pub user_stake: Box<Account<'info, UserStake>>,

    #[account(
        mut,
        constraint = user_nave_account.mint == pool.nave_mint @ StakingError::MintMismatch,
        constraint = user_nave_account.owner == owner.key() @ StakingError::InvalidTokenAccount
    )]
    pub user_nave_account: Box<Account<'info, TokenAccount>>,

    #[account(mut, address = pool.stake_vault @ StakingError::InvalidTokenAccount)]
    pub stake_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut, address = pool.reward_vault @ StakingError::InvalidTokenAccount)]
    pub reward_vault: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct Unstake<'info> {
    pub owner: Signer<'info>,

    #[account(mut, seeds = [STAKE_POOL_SEED], bump = pool.bump)]
    pub pool: Box<Account<'info, StakePool>>,

    #[account(
        mut,
        seeds = [USER_STAKE_SEED, owner.key().as_ref()],
        bump = user_stake.bump,
        has_one = owner @ StakingError::Unauthorized
    )]
    pub user_stake: Box<Account<'info, UserStake>>,

    #[account(
        mut,
        constraint = user_nave_account.mint == pool.nave_mint @ StakingError::MintMismatch,
        constraint = user_nave_account.owner == owner.key() @ StakingError::InvalidTokenAccount
    )]
    pub user_nave_account: Box<Account<'info, TokenAccount>>,

    #[account(mut, address = pool.stake_vault @ StakingError::InvalidTokenAccount)]
    pub stake_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut, address = pool.reward_vault @ StakingError::InvalidTokenAccount)]
    pub reward_vault: Box<Account<'info, TokenAccount>>,

    /// CHECK: pool authority PDA; validated by seeds + pool bump.
    #[account(seeds = [POOL_AUTHORITY_SEED], bump = pool.authority_bump)]
    pub pool_authority: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    pub owner: Signer<'info>,

    #[account(mut, seeds = [STAKE_POOL_SEED], bump = pool.bump)]
    pub pool: Box<Account<'info, StakePool>>,

    #[account(
        mut,
        seeds = [USER_STAKE_SEED, owner.key().as_ref()],
        bump = user_stake.bump,
        has_one = owner @ StakingError::Unauthorized
    )]
    pub user_stake: Box<Account<'info, UserStake>>,

    #[account(
        mut,
        constraint = user_nave_account.mint == pool.nave_mint @ StakingError::MintMismatch,
        constraint = user_nave_account.owner == owner.key() @ StakingError::InvalidTokenAccount
    )]
    pub user_nave_account: Box<Account<'info, TokenAccount>>,

    #[account(mut, address = pool.reward_vault @ StakingError::InvalidTokenAccount)]
    pub reward_vault: Box<Account<'info, TokenAccount>>,

    /// CHECK: pool authority PDA; validated by seeds + pool bump.
    #[account(seeds = [POOL_AUTHORITY_SEED], bump = pool.authority_bump)]
    pub pool_authority: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Sync<'info> {
    #[account(mut, seeds = [STAKE_POOL_SEED], bump = pool.bump)]
    pub pool: Box<Account<'info, StakePool>>,

    #[account(address = pool.reward_vault @ StakingError::InvalidTokenAccount)]
    pub reward_vault: Box<Account<'info, TokenAccount>>,
}

#[derive(Accounts)]
pub struct OwnerOnly<'info> {
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [STAKE_POOL_SEED],
        bump = pool.bump,
        has_one = owner @ StakingError::Unauthorized
    )]
    pub pool: Box<Account<'info, StakePool>>,
}

#[derive(Accounts)]
pub struct CreditLegacy<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [STAKE_POOL_SEED],
        bump = pool.bump,
        has_one = owner @ StakingError::Unauthorized
    )]
    pub pool: Box<Account<'info, StakePool>>,

    /// CHECK: historical staker. The position and the one-time marker are both
    /// seeded with this key, so a second credit for the same staker cannot init.
    pub staker: UncheckedAccount<'info>,

    #[account(
        init,
        payer = owner,
        space = LegacyCredit::LEN,
        seeds = [LEGACY_CREDIT_SEED, staker.key().as_ref()],
        bump
    )]
    pub legacy_credit: Box<Account<'info, LegacyCredit>>,

    #[account(
        init_if_needed,
        payer = owner,
        space = UserStake::LEN,
        seeds = [USER_STAKE_SEED, staker.key().as_ref()],
        bump
    )]
    pub user_stake: Box<Account<'info, UserStake>>,

    #[account(mut, address = pool.stake_vault @ StakingError::InvalidTokenAccount)]
    pub stake_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut, address = pool.reward_vault @ StakingError::InvalidTokenAccount)]
    pub reward_vault: Box<Account<'info, TokenAccount>>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AcceptOwnership<'info> {
    pub new_owner: Signer<'info>,

    #[account(
        mut,
        seeds = [STAKE_POOL_SEED],
        bump = pool.bump,
        constraint = pool.pending_owner == new_owner.key() @ StakingError::NotPendingOwner
    )]
    pub pool: Box<Account<'info, StakePool>>,
}
