//! DAO moonlighting lifecycle (Phase 5).
//!
//! Moonlighting is a first-class DAO lifecycle (NOT an overload of the emergency
//! freeze). It lets a DAO be wound down and its assets — including the
//! recoverable `$99` NAVE creation stake — distributed to an approved recipient
//! after two binding governance votes, then hidden from participants until the
//! founder restakes to reopen it.
//!
//! State machine (see `MoonlightStatus`): `Active → Requested →
//! DistributionPending → Distributing → Moonlighted`, with `Moonlighted →
//! Active` only via `restore_dao` (founder restakes the current `$99`).
//!
//! Lifecycle transitions are bound to PASSED `nave_governance` proposals read
//! off-chain-agnostic via `GovernanceProposalLayout` (the same wire mirror used
//! by the governance treasury transfers): `MoonlightRequest` (type 9) opens the
//! request phase; `MoonlightDistribution` (type 10) binds the recipient and
//! authorizes the asset + stake distribution.
//!
//! EXTENSION POINT (stubbed, do NOT build here): future governance
//! voting-weight = staked-amount. `DaoLifecycle.reserved` is kept zeroed for it.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::constants::{
    gov_proposal_type, MoonlightStatus, StakeStatus, AGENT_SET_SEED, DAO_LIFECYCLE_SEED,
    DAO_REGISTRY_SEED, DAO_STAKE_LOCK_SEED, GLOBAL_CONFIG_SEED, MIN_DAO_STAKE_NAVE_BASE_UNITS,
    STAKE_ESCROW_SEED,
};
use crate::errors::NaveError;
use crate::events::{
    DaoMoonlighted, DaoRestored, DaoStakeLocked, DaoStakeReleased, MoonlightDistributed,
    MoonlightDistributionSet, MoonlightRequested,
};
use crate::state::{
    AgentSet, DaoLifecycle, DaoRegistry, DaoStakeLock, GovernanceProposalLayout,
    NaveGlobalConfig,
};
use crate::constants::nave_governance_program;
use crate::utils::require_not_paused;

// Anchor global instruction discriminator: sha256("global:mark_moonlight_proposal_executed")[..8].
const DISC_MARK_MOONLIGHT_PROPOSAL_EXECUTED: [u8; 8] =
    [197, 174, 240, 144, 29, 209, 125, 219];

/// CPI into `nave_governance::mark_moonlight_proposal_executed`, flipping the
/// given `Passed` `MoonlightRequest`/`MoonlightDistribution` proposal to
/// `Executed` so it can never be replayed (closes P6-3: without this, the same
/// proposal pair could be reused after a `restore_dao` cycle to re-trigger
/// moonlighting without a fresh vote). `nave_core` cannot depend on the
/// `nave_governance` crate (the dependency already runs the other way, for
/// its treasury-transfer CPIs), so this is built as a raw, unsigned CPI —
/// `nave_governance` authorizes it purely by checking (via the instructions
/// sysvar) that the top-level instruction belongs to `nave_core`, the same
/// pattern `verify_governance_caller` uses in the opposite direction.
fn mark_moonlight_proposal_executed<'info>(
    governance_program: &AccountInfo<'info>,
    instructions_sysvar: &AccountInfo<'info>,
    dao_registry: &AccountInfo<'info>,
    proposal: &AccountInfo<'info>,
) -> Result<()> {
    require!(
        governance_program.key() == nave_governance_program::ID,
        NaveError::InvalidExternalProgram
    );
    let ix = Instruction {
        program_id: nave_governance_program::ID,
        accounts: vec![
            AccountMeta::new_readonly(instructions_sysvar.key(), false),
            AccountMeta::new_readonly(dao_registry.key(), false),
            AccountMeta::new(proposal.key(), false),
        ],
        data: DISC_MARK_MOONLIGHT_PROPOSAL_EXECUTED.to_vec(),
    };
    invoke(
        &ix,
        &[
            instructions_sysvar.clone(),
            dao_registry.clone(),
            proposal.clone(),
        ],
    )?;
    Ok(())
}

/// Load a `nave_governance`-owned proposal account, verify it is owned by the
/// governance program, bound to `dao`, of `expected_type`, and Passed.
fn load_passed_proposal(
    proposal_ai: &AccountInfo,
    dao: &Pubkey,
    expected_type: u8,
) -> Result<GovernanceProposalLayout> {
    require!(
        *proposal_ai.owner == nave_governance_program::ID,
        NaveError::MoonlightProposalInvalid
    );
    let data = proposal_ai.try_borrow_data()?;
    let prop = GovernanceProposalLayout::try_deserialize_skip_discriminator(&data)?;
    require!(prop.dao == *dao, NaveError::DaoOwnershipMismatch);
    require!(prop.proposal_type == expected_type, NaveError::MoonlightProposalInvalid);
    require!(
        prop.status == gov_proposal_type::STATUS_PASSED,
        NaveError::MoonlightProposalInvalid
    );
    require!(prop.finalized_at > 0, NaveError::MoonlightProposalInvalid);
    Ok(prop)
}

/// Record an approved moonlight request: halt the agent pipeline and block new
/// strategy/deposit activity (controlled unwind/distribution stays allowed),
/// recording the proposal creator as the authorized distribution driver.
///
/// Signed by the founder; bound to a PASSED `MoonlightRequest` (type 9). The
/// `DaoLifecycle` companion PDA is created on first use (registry layout
/// untouched).
pub fn record_moonlight_request_handler(ctx: Context<RecordMoonlightRequest>) -> Result<()> {
    require_not_paused(&ctx.accounts.global_config)?;

    let dao_key = ctx.accounts.dao_registry.key();
    let prop = load_passed_proposal(
        &ctx.accounts.request_proposal.to_account_info(),
        &dao_key,
        gov_proposal_type::MOONLIGHT_REQUEST,
    )?;

    // Consume the request proposal immediately so it can never be replayed
    // (e.g. re-fed into this same handler after a future restore_dao cycle).
    mark_moonlight_proposal_executed(
        &ctx.accounts.governance_program.to_account_info(),
        &ctx.accounts.instructions_sysvar.to_account_info(),
        &ctx.accounts.dao_registry.to_account_info(),
        &ctx.accounts.request_proposal.to_account_info(),
    )?;

    let now = Clock::get()?.unix_timestamp;
    let lifecycle = &mut ctx.accounts.dao_lifecycle;
    // Only openable from Active (or a freshly-initialized lifecycle).
    require!(
        lifecycle.status == MoonlightStatus::Active as u8,
        NaveError::MoonlightInvalidStatus
    );
    lifecycle.bump = ctx.bumps.dao_lifecycle;
    lifecycle.dao = dao_key;
    lifecycle.status = MoonlightStatus::Requested as u8;
    lifecycle.request_proposal = ctx.accounts.request_proposal.key();
    lifecycle.distribution_proposal = Pubkey::default();
    lifecycle.recipient = Pubkey::default();
    // The proposal creator (only) drives the distribution wizard.
    lifecycle.initiated_by = prop.proposer;
    lifecycle.requested_at = now;
    lifecycle.distributed_at = 0;
    lifecycle.moonlighted_at = 0;
    lifecycle.restored_at = 0;

    // Halt the autonomous agents. The gate every agent path actually reads
    // (`require_agents_enabled`, nave_execution's `validate_agent_signer` /
    // `execute_strategy_direct`, `jupiter_swap`) is `agent_set.agents_enabled`
    // — `dao_registry.agents_enabled` is only a mirror kept for indexers, so
    // BOTH must be flipped (mirrors `set_agents_enabled` / `nullify_agent` in
    // `governance.rs`). New automated strategy/deposit flow runs through the
    // agents, so disabling them halts it; nave_execution additionally
    // consults the lifecycle status for the non-agent deposit paths.
    let agent_set = &mut ctx.accounts.agent_set;
    agent_set.agents_enabled = false;
    let registry = &mut ctx.accounts.dao_registry;
    registry.agents_enabled = false;
    registry.updated_at = now;

    emit!(MoonlightRequested {
        dao: dao_key,
        request_proposal: ctx.accounts.request_proposal.key(),
        requested_by: lifecycle.initiated_by,
        requested_at: now,
    });
    Ok(())
}

/// Distribution wizard step 1: the proposal creator enters the recipient wallet,
/// moving the lifecycle to `DistributionPending`. A second binding
/// `MoonlightDistribution` proposal must then pass before funds move.
pub fn set_moonlight_distribution_handler(
    ctx: Context<SetMoonlightDistribution>,
    recipient: Pubkey,
) -> Result<()> {
    require_not_paused(&ctx.accounts.global_config)?;
    require!(recipient != Pubkey::default(), NaveError::MoonlightRecipientMismatch);

    let lifecycle = &mut ctx.accounts.dao_lifecycle;
    require!(
        lifecycle.status == MoonlightStatus::Requested as u8,
        NaveError::MoonlightInvalidStatus
    );
    // Only the proposal creator (recorded at request time) may drive this.
    require!(
        ctx.accounts.initiator.key() == lifecycle.initiated_by,
        NaveError::Unauthorized
    );

    lifecycle.recipient = recipient;
    lifecycle.status = MoonlightStatus::DistributionPending as u8;

    emit!(MoonlightDistributionSet {
        dao: ctx.accounts.dao_registry.key(),
        recipient,
        initiated_by: lifecycle.initiated_by,
    });
    Ok(())
}

/// Distribution wizard step 2 (execution): after the `MoonlightDistribution`
/// proposal passes, release the staked NAVE to the approved recipient and move
/// to `Distributing`. SOL/SPL/NFT treasury assets are distributed via the
/// existing governance Transfer instructions (one per asset, recipient-bound);
/// this handler owns the creation-stake release leg.
pub fn execute_moonlight_distribution_handler(
    ctx: Context<ExecuteMoonlightDistribution>,
) -> Result<()> {
    require_not_paused(&ctx.accounts.global_config)?;

    let dao_key = ctx.accounts.dao_registry.key();
    let prop = load_passed_proposal(
        &ctx.accounts.distribution_proposal.to_account_info(),
        &dao_key,
        gov_proposal_type::MOONLIGHT_DISTRIBUTION,
    )?;

    // The distribution proposal payload binds the approved recipient (first 32
    // payload bytes) so the on-chain payout cannot be redirected.
    require!(prop.payload_len as usize >= 32, NaveError::MoonlightProposalInvalid);
    let payload_recipient = Pubkey::new_from_array(prop.payload[0..32].try_into().unwrap());

    let lifecycle_status;
    let recipient;
    let initiated_by;
    {
        let lifecycle = &ctx.accounts.dao_lifecycle;
        lifecycle_status = lifecycle.status;
        recipient = lifecycle.recipient;
        initiated_by = lifecycle.initiated_by;
    }
    require!(
        lifecycle_status == MoonlightStatus::DistributionPending as u8
            || lifecycle_status == MoonlightStatus::Distributing as u8,
        NaveError::MoonlightInvalidStatus
    );
    require!(prop.proposer == initiated_by, NaveError::Unauthorized);
    require!(payload_recipient == recipient, NaveError::MoonlightRecipientMismatch);
    require!(
        ctx.accounts.recipient_nave_account.owner == recipient,
        NaveError::MoonlightRecipientMismatch
    );

    // Consume the distribution proposal immediately so it can never be
    // replayed (e.g. re-fed into this same handler after a future restore_dao
    // cycle). Idempotent on the nave_governance side if this handler is
    // itself called a second time (Distributing -> Distributing, matching
    // this handler's own documented idempotent re-entry).
    mark_moonlight_proposal_executed(
        &ctx.accounts.governance_program.to_account_info(),
        &ctx.accounts.instructions_sysvar.to_account_info(),
        &ctx.accounts.dao_registry.to_account_info(),
        &ctx.accounts.distribution_proposal.to_account_info(),
    )?;

    let now = Clock::get()?.unix_timestamp;

    // Release the staked NAVE from escrow → recipient (signed by the stake-lock
    // PDA), if still locked. Idempotent: a second call after release is a no-op
    // on the token leg but keeps the lifecycle advance available.
    let mut released_amount = 0u64;
    {
        let stake = &ctx.accounts.dao_stake_lock;
        if stake.status == StakeStatus::Locked as u8 {
            released_amount = ctx.accounts.stake_escrow.amount;
            require!(released_amount > 0, NaveError::StakeNotReleasable);

            let lock_bump = stake.bump;
            let signer_seeds: &[&[u8]] =
                &[DAO_STAKE_LOCK_SEED, dao_key.as_ref(), &[lock_bump]];
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.stake_escrow.to_account_info(),
                        to: ctx.accounts.recipient_nave_account.to_account_info(),
                        authority: ctx.accounts.dao_stake_lock.to_account_info(),
                    },
                    &[signer_seeds],
                ),
                released_amount,
            )?;

            let stake = &mut ctx.accounts.dao_stake_lock;
            stake.status = StakeStatus::Released as u8;
            stake.unlock_eligible = true;
            stake.locked_amount = 0;
            stake.released_at = now;

            emit!(DaoStakeReleased {
                dao: dao_key,
                recipient,
                amount: released_amount,
                released_at: now,
            });
        }
    }

    let lifecycle = &mut ctx.accounts.dao_lifecycle;
    lifecycle.status = MoonlightStatus::Distributing as u8;
    lifecycle.distribution_proposal = ctx.accounts.distribution_proposal.key();
    lifecycle.distributed_at = now;

    emit!(MoonlightDistributed {
        dao: dao_key,
        distribution_proposal: ctx.accounts.distribution_proposal.key(),
        recipient,
        stake_amount: released_amount,
        distributed_at: now,
    });
    Ok(())
}

/// Final phase: mark the DAO moonlighted (hidden from participants). Forces
/// privacy to Private as the on-chain hidden marker; the app/indexer hides
/// moonlighted DAOs from participant views. Founder or the distribution driver.
pub fn finalize_moonlight_handler(ctx: Context<FinalizeMoonlight>) -> Result<()> {
    require_not_paused(&ctx.accounts.global_config)?;

    let signer = ctx.accounts.authority.key();
    let (founder, lifecycle_status, initiated_by) = {
        let lifecycle = &ctx.accounts.dao_lifecycle;
        (ctx.accounts.dao_registry.founder, lifecycle.status, lifecycle.initiated_by)
    };
    require!(signer == founder || signer == initiated_by, NaveError::Unauthorized);
    require!(
        lifecycle_status == MoonlightStatus::Distributing as u8,
        NaveError::MoonlightInvalidStatus
    );

    let now = Clock::get()?.unix_timestamp;
    let recipient = ctx.accounts.dao_lifecycle.recipient;

    let lifecycle = &mut ctx.accounts.dao_lifecycle;
    lifecycle.status = MoonlightStatus::Moonlighted as u8;
    lifecycle.moonlighted_at = now;

    // Agents stay off: flip the real gate (`agent_set`) and the registry mirror.
    let agent_set = &mut ctx.accounts.agent_set;
    agent_set.agents_enabled = false;
    let registry = &mut ctx.accounts.dao_registry;
    // Hidden marker: moonlighted DAOs are flipped to Private and agents stay off.
    registry.privacy_mode = crate::constants::PrivacyMode::Private as u8;
    registry.agents_enabled = false;
    registry.updated_at = now;

    emit!(DaoMoonlighted {
        dao: registry.key(),
        recipient,
        moonlighted_at: now,
    });
    Ok(())
}

/// Restore a moonlighted DAO: the FOUNDER ONLY re-enters the DAO and restakes
/// the current `$99` of NAVE into the (now-empty) escrow, returning the DAO to
/// `Active`. Agents remain disabled until re-enabled through governance.
pub fn restore_dao_handler(
    ctx: Context<RestoreDao>,
    amount: u64,
    price_usd_micro: u64,
) -> Result<()> {
    require_not_paused(&ctx.accounts.global_config)?;
    require!(
        amount >= MIN_DAO_STAKE_NAVE_BASE_UNITS,
        NaveError::StakeAmountTooLow
    );

    require!(
        ctx.accounts.dao_lifecycle.status == MoonlightStatus::Moonlighted as u8,
        NaveError::DaoNotMoonlighted
    );

    // Pinned-mint enforcement (parity with stake_dao_creation).
    let pinned = ctx.accounts.global_config.nave_mint;
    if pinned != Pubkey::default() {
        require!(
            ctx.accounts.nave_mint.key() == pinned,
            NaveError::StakeMintMismatch
        );
    }
    require!(
        ctx.accounts.stake_escrow.key() == ctx.accounts.dao_stake_lock.escrow_token_account,
        NaveError::InvalidVaultTokenAccount
    );

    // Restake: founder funds the escrow again.
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
    ctx.accounts.stake_escrow.reload()?;
    require!(
        ctx.accounts.stake_escrow.amount >= amount,
        NaveError::StakeNotFullyFunded
    );

    let now = Clock::get()?.unix_timestamp;
    let dao_key = ctx.accounts.dao_registry.key();

    let stake = &mut ctx.accounts.dao_stake_lock;
    stake.status = StakeStatus::Locked as u8;
    stake.unlock_eligible = false;
    stake.locked_amount = amount;
    stake.price_usd_micro = price_usd_micro;
    stake.locked_at = now;
    stake.released_at = 0;

    let lifecycle = &mut ctx.accounts.dao_lifecycle;
    lifecycle.status = MoonlightStatus::Active as u8;
    lifecycle.recipient = Pubkey::default();
    lifecycle.request_proposal = Pubkey::default();
    lifecycle.distribution_proposal = Pubkey::default();
    lifecycle.initiated_by = Pubkey::default();
    lifecycle.restored_at = now;

    let registry = &mut ctx.accounts.dao_registry;
    registry.updated_at = now;

    emit!(DaoStakeLocked {
        dao: dao_key,
        founder: ctx.accounts.founder.key(),
        nave_mint: ctx.accounts.nave_mint.key(),
        escrow: ctx.accounts.stake_escrow.key(),
        amount,
        price_usd_micro,
        locked_at: now,
    });
    emit!(DaoRestored {
        dao: dao_key,
        founder: ctx.accounts.founder.key(),
        restaked_amount: amount,
        restored_at: now,
    });
    Ok(())
}

// ── Account contexts ─────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct RecordMoonlightRequest<'info> {
    #[account(mut)]
    pub founder: Signer<'info>,

    #[account(seeds = [GLOBAL_CONFIG_SEED], bump = global_config.bump)]
    pub global_config: Box<Account<'info, NaveGlobalConfig>>,

    #[account(
        mut,
        seeds = [DAO_REGISTRY_SEED, dao_registry.founder.as_ref(), &dao_registry.dao_id.to_le_bytes()],
        bump = dao_registry.bump,
        has_one = founder @ NaveError::Unauthorized
    )]
    pub dao_registry: Box<Account<'info, DaoRegistry>>,

    /// The DAO's agent set: `agents_enabled` here is the flag every agent gate
    /// reads, so the moonlight halt must flip it (not only the registry mirror).
    #[account(
        mut,
        seeds = [AGENT_SET_SEED, dao_registry.key().as_ref()],
        bump = agent_set.bump,
        constraint = agent_set.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch
    )]
    pub agent_set: Box<Account<'info, AgentSet>>,

    #[account(
        init_if_needed,
        payer = founder,
        space = DaoLifecycle::LEN,
        seeds = [DAO_LIFECYCLE_SEED, dao_registry.key().as_ref()],
        bump
    )]
    pub dao_lifecycle: Box<Account<'info, DaoLifecycle>>,

    /// CHECK: nave_governance-owned passed MoonlightRequest proposal (validated in handler).
    #[account(mut)]
    pub request_proposal: UncheckedAccount<'info>,

    /// CHECK: nave_governance program id; CPI target for `mark_moonlight_proposal_executed`.
    #[account(address = nave_governance_program::ID)]
    pub governance_program: UncheckedAccount<'info>,

    /// CHECK: instructions sysvar, forwarded to the `mark_moonlight_proposal_executed` CPI.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetMoonlightDistribution<'info> {
    pub initiator: Signer<'info>,

    #[account(seeds = [GLOBAL_CONFIG_SEED], bump = global_config.bump)]
    pub global_config: Box<Account<'info, NaveGlobalConfig>>,

    #[account(
        seeds = [DAO_REGISTRY_SEED, dao_registry.founder.as_ref(), &dao_registry.dao_id.to_le_bytes()],
        bump = dao_registry.bump
    )]
    pub dao_registry: Box<Account<'info, DaoRegistry>>,

    #[account(
        mut,
        seeds = [DAO_LIFECYCLE_SEED, dao_registry.key().as_ref()],
        bump = dao_lifecycle.bump,
        constraint = dao_lifecycle.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch
    )]
    pub dao_lifecycle: Box<Account<'info, DaoLifecycle>>,
}

#[derive(Accounts)]
pub struct ExecuteMoonlightDistribution<'info> {
    pub authority: Signer<'info>,

    #[account(seeds = [GLOBAL_CONFIG_SEED], bump = global_config.bump)]
    pub global_config: Box<Account<'info, NaveGlobalConfig>>,

    #[account(
        seeds = [DAO_REGISTRY_SEED, dao_registry.founder.as_ref(), &dao_registry.dao_id.to_le_bytes()],
        bump = dao_registry.bump
    )]
    pub dao_registry: Box<Account<'info, DaoRegistry>>,

    #[account(
        mut,
        seeds = [DAO_LIFECYCLE_SEED, dao_registry.key().as_ref()],
        bump = dao_lifecycle.bump,
        constraint = dao_lifecycle.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch
    )]
    pub dao_lifecycle: Box<Account<'info, DaoLifecycle>>,

    #[account(
        mut,
        seeds = [DAO_STAKE_LOCK_SEED, dao_registry.key().as_ref()],
        bump = dao_stake_lock.bump,
        constraint = dao_stake_lock.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch
    )]
    pub dao_stake_lock: Box<Account<'info, DaoStakeLock>>,

    #[account(
        mut,
        constraint = stake_escrow.key() == dao_stake_lock.escrow_token_account @ NaveError::InvalidVaultTokenAccount
    )]
    pub stake_escrow: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = recipient_nave_account.mint == dao_stake_lock.nave_mint @ NaveError::StakeMintMismatch
    )]
    pub recipient_nave_account: Box<Account<'info, TokenAccount>>,

    /// CHECK: nave_governance-owned passed MoonlightDistribution proposal (validated in handler).
    #[account(mut)]
    pub distribution_proposal: UncheckedAccount<'info>,

    /// CHECK: nave_governance program id; CPI target for `mark_moonlight_proposal_executed`.
    #[account(address = nave_governance_program::ID)]
    pub governance_program: UncheckedAccount<'info>,

    /// CHECK: instructions sysvar, forwarded to the `mark_moonlight_proposal_executed` CPI.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct FinalizeMoonlight<'info> {
    pub authority: Signer<'info>,

    #[account(seeds = [GLOBAL_CONFIG_SEED], bump = global_config.bump)]
    pub global_config: Box<Account<'info, NaveGlobalConfig>>,

    #[account(
        mut,
        seeds = [DAO_REGISTRY_SEED, dao_registry.founder.as_ref(), &dao_registry.dao_id.to_le_bytes()],
        bump = dao_registry.bump
    )]
    pub dao_registry: Box<Account<'info, DaoRegistry>>,

    /// Agents stay disabled on the moonlighted DAO: flip the real gate here.
    #[account(
        mut,
        seeds = [AGENT_SET_SEED, dao_registry.key().as_ref()],
        bump = agent_set.bump,
        constraint = agent_set.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch
    )]
    pub agent_set: Box<Account<'info, AgentSet>>,

    #[account(
        mut,
        seeds = [DAO_LIFECYCLE_SEED, dao_registry.key().as_ref()],
        bump = dao_lifecycle.bump,
        constraint = dao_lifecycle.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch
    )]
    pub dao_lifecycle: Box<Account<'info, DaoLifecycle>>,
}

#[derive(Accounts)]
pub struct RestoreDao<'info> {
    #[account(mut)]
    pub founder: Signer<'info>,

    #[account(seeds = [GLOBAL_CONFIG_SEED], bump = global_config.bump)]
    pub global_config: Box<Account<'info, NaveGlobalConfig>>,

    #[account(
        mut,
        seeds = [DAO_REGISTRY_SEED, dao_registry.founder.as_ref(), &dao_registry.dao_id.to_le_bytes()],
        bump = dao_registry.bump,
        has_one = founder @ NaveError::Unauthorized
    )]
    pub dao_registry: Box<Account<'info, DaoRegistry>>,

    #[account(
        mut,
        seeds = [DAO_LIFECYCLE_SEED, dao_registry.key().as_ref()],
        bump = dao_lifecycle.bump,
        constraint = dao_lifecycle.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch
    )]
    pub dao_lifecycle: Box<Account<'info, DaoLifecycle>>,

    #[account(
        mut,
        seeds = [DAO_STAKE_LOCK_SEED, dao_registry.key().as_ref()],
        bump = dao_stake_lock.bump,
        constraint = dao_stake_lock.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch
    )]
    pub dao_stake_lock: Box<Account<'info, DaoStakeLock>>,

    pub nave_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        constraint = founder_nave_account.mint == nave_mint.key() @ NaveError::StakeMintMismatch,
        constraint = founder_nave_account.owner == founder.key() @ NaveError::Unauthorized
    )]
    pub founder_nave_account: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [STAKE_ESCROW_SEED, dao_registry.key().as_ref()],
        bump,
        constraint = stake_escrow.mint == nave_mint.key() @ NaveError::StakeMintMismatch
    )]
    pub stake_escrow: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}
