//! Legacy DAO creation stake (Phase 3).
//!
//! New treasuries do not call this. Formation is fee-free and does not require
//! a NAVE lock; `initialize_dao*` succeeds on its own, and `restore_dao` does
//! not restake. This instruction remains so a client can still lock NAVE into
//! `DaoStakeLock` for a treasury that wants the old escrow, and so moonlight
//! can later release that lock. On-chain it still enforces the NAVE floor
//! (`MIN_DAO_STAKE_NAVE_BASE_UNITS`), full receipt into escrow, and — once a
//! trusted `NAVE_USD_PYTH_FEED_ID` is pinned — a fresh Pyth NAVE/USD check.
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;

use crate::constants::{
    pyth_receiver_program, StakeStatus, DAO_REGISTRY_SEED, DAO_STAKE_LOCK_SEED,
    DAO_STAKE_TARGET_USD_MICRO, GLOBAL_CONFIG_SEED, MIN_DAO_STAKE_NAVE_BASE_UNITS,
    NAVE_USD_PYTH_FEED_ID, PYTH_MAX_PRICE_AGE_SECS, STAKE_ESCROW_SEED,
};
use crate::errors::NaveError;
use crate::events::DaoStakeLocked;
use crate::state::{DaoRegistry, DaoStakeLock, NaveGlobalConfig};
use crate::utils::{require_confidence, require_not_paused, value_usd};

pub fn stake_dao_creation_handler(
    ctx: Context<StakeDaoCreation>,
    amount: u64,
    price_usd_micro: u64,
) -> Result<()> {
    require_not_paused(&ctx.accounts.global_config)?;
    require!(
        amount >= MIN_DAO_STAKE_NAVE_BASE_UNITS,
        NaveError::StakeAmountTooLow
    );

    // When the canonical NAVE mint is pinned on global_config, enforce it.
    // While unset (zero pubkey), the devnet/test bootstrap fixture is allowed to
    // stake with any mint it holds — but ONLY on non-mainnet builds. A mainnet
    // build (`--features mainnet`, the only build mainnet-cutover.mjs ever
    // deploys) must never silently accept an arbitrary mint as "NAVE": that
    // build hard-requires `nave_mint` to already be pinned (mainnet-cutover.mjs
    // pins it via `set_nave_mint` before the authority handoff, so this should
    // never actually trip in a correct mainnet launch — it exists as a
    // structural backstop, not a normal-path check).
    let pinned = ctx.accounts.global_config.nave_mint;
    if pinned != Pubkey::default() {
        require!(
            ctx.accounts.nave_mint.key() == pinned,
            NaveError::StakeMintMismatch
        );
    } else {
        require!(cfg!(not(feature = "mainnet")), NaveError::StakeMintUnset);
    }

    // SEC-M2 (optional USD leg): when a trusted Pyth NAVE/USD feed id is pinned
    // in `NAVE_USD_PYTH_FEED_ID`, the founder must supply that feed's
    // `PriceUpdateV2` as the first remaining account, the price must be fresh
    // and confidence-bounded (same gates as treasury valuation), and the staked
    // NAVE must be worth at least the `$99` target. While the feed id is unset
    // (all-zero — no NAVE/USD feed exists yet on any cluster) this block is
    // skipped and only the NAVE floor above is enforced; passed via
    // `remaining_accounts` so the account struct/IDL stays unchanged for
    // existing callers until the feed is activated by a program upgrade.
    if NAVE_USD_PYTH_FEED_ID != [0u8; 32] {
        let price_ai = ctx
            .remaining_accounts
            .first()
            .ok_or(NaveError::InvalidOracleAccount)?;
        require!(
            price_ai.owner == &pyth_receiver_program::ID,
            NaveError::InvalidOracleAccount
        );
        let price_update: PriceUpdateV2 = {
            let data = price_ai.try_borrow_data()?;
            PriceUpdateV2::try_deserialize(&mut &data[..])?
        };
        let clock = Clock::get()?;
        let p = price_update
            .get_price_no_older_than(&clock, PYTH_MAX_PRICE_AGE_SECS, &NAVE_USD_PYTH_FEED_ID)
            .map_err(|_| error!(NaveError::StaleOracle))?;
        require_confidence(p.price, p.conf)?;
        let stake_value_usd_micro =
            value_usd(amount, ctx.accounts.nave_mint.decimals, p.price, p.exponent)?;
        require!(
            stake_value_usd_micro >= DAO_STAKE_TARGET_USD_MICRO,
            NaveError::StakeAmountTooLow
        );
    }

    // Pull NAVE from the founder ATA into the per-DAO escrow (founder signs).
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.founder_nave_account.to_account_info(),
                to: ctx.accounts.stake_escrow.to_account_info(),
                authority: ctx.accounts.founder.to_account_info(),
            },
        ),
        amount,
    )?;

    // Enforce the escrow actually received the full amount (guards against
    // fee-on-transfer / partial-credit mints diluting the stake gate).
    ctx.accounts.stake_escrow.reload()?;
    require!(
        ctx.accounts.stake_escrow.amount >= amount,
        NaveError::StakeNotFullyFunded
    );

    let now = Clock::get()?.unix_timestamp;
    let dao_key = ctx.accounts.dao_registry.key();

    let lock = &mut ctx.accounts.dao_stake_lock;
    lock.bump = ctx.bumps.dao_stake_lock;
    lock.dao = dao_key;
    lock.founder = ctx.accounts.founder.key();
    lock.nave_mint = ctx.accounts.nave_mint.key();
    lock.escrow_token_account = ctx.accounts.stake_escrow.key();
    lock.locked_amount = amount;
    lock.price_usd_micro = price_usd_micro;
    lock.stake_value_usd_micro = DAO_STAKE_TARGET_USD_MICRO;
    lock.status = StakeStatus::Locked as u8;
    lock.unlock_eligible = false;
    lock.locked_at = now;
    lock.released_at = 0;

    emit!(DaoStakeLocked {
        dao: dao_key,
        founder: lock.founder,
        nave_mint: lock.nave_mint,
        escrow: lock.escrow_token_account,
        amount,
        price_usd_micro,
        locked_at: now,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct StakeDaoCreation<'info> {
    #[account(mut)]
    pub founder: Signer<'info>,

    #[account(seeds = [GLOBAL_CONFIG_SEED], bump = global_config.bump)]
    pub global_config: Box<Account<'info, NaveGlobalConfig>>,

    #[account(
        seeds = [DAO_REGISTRY_SEED, dao_registry.founder.as_ref(), &dao_registry.dao_id.to_le_bytes()],
        bump = dao_registry.bump,
        has_one = founder @ NaveError::Unauthorized
    )]
    pub dao_registry: Box<Account<'info, DaoRegistry>>,

    pub nave_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        constraint = founder_nave_account.mint == nave_mint.key() @ NaveError::StakeMintMismatch,
        constraint = founder_nave_account.owner == founder.key() @ NaveError::Unauthorized
    )]
    pub founder_nave_account: Box<Account<'info, TokenAccount>>,

    #[account(
        init,
        payer = founder,
        space = DaoStakeLock::LEN,
        seeds = [DAO_STAKE_LOCK_SEED, dao_registry.key().as_ref()],
        bump
    )]
    pub dao_stake_lock: Box<Account<'info, DaoStakeLock>>,

    #[account(
        init,
        payer = founder,
        seeds = [STAKE_ESCROW_SEED, dao_registry.key().as_ref()],
        bump,
        token::mint = nave_mint,
        token::authority = dao_stake_lock,
    )]
    pub stake_escrow: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}
