use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::solana_program::system_instruction;
use anchor_spl::token::{
    close_account, sync_native, transfer as spl_transfer, CloseAccount, Mint, SyncNative, Token,
    TokenAccount, Transfer as SplTransfer,
};

use crate::constants::{
    spl_stake_pool_program, wsol_mint, AgentRole, AGENT_SET_SEED, DAO_REGISTRY_SEED,
    GLOBAL_CONFIG_SEED, SOL_FUNDING_SEED, SPL_STAKE_POOL_DEPOSIT_SOL_TAG,
    SPL_STAKE_POOL_WITHDRAW_SOL_TAG, STRATEGY_ESCROW_SEED, STRATEGY_POSITION_SEED,
    VAULT_AUTHORITY_SEED,
};
use crate::errors::NaveError;
use crate::state::{AgentSet, DaoRegistry, NaveGlobalConfig, StrategyPosition, VaultAuthority};
use crate::utils::{require_agent_authority, require_agents_enabled, require_dao_active, require_not_paused};

/// jito protocol id this module operates on.
const JITO_PROTOCOL_ID: &[u8] = b"jito";
/// Temporary wSOL unwrap account seed.
const JITO_TMP_WSOL_SEED: &[u8] = b"jito_tmp_wsol";

// ── jito_deposit ─────────────────────────────────────────────────────────────
// Operational-agent-gated. Unwraps `amount` wSOL from the per-(dao, jito, wSOL)
// escrow into the DAO's native SOL funding PDA, then `DepositSol` into the
// configured SPL stake pool, receiving pool tokens (e.g. JitoSOL) into the
// vault-owned position token account.

pub fn jito_deposit_handler(ctx: Context<JitoDeposit>, amount: u64) -> Result<()> {
    require_not_paused(&ctx.accounts.global_config)?;
    require_dao_active(&ctx.accounts.dao_registry)?;
    require_agent_authority(
        &ctx.accounts.authority.key(),
        &ctx.accounts.agent_set,
        AgentRole::Operational,
    )?;
    require_agents_enabled(&ctx.accounts.agent_set)?;

    let sp = &ctx.accounts.strategy_position;
    require!(sp.protocol_id_slice() == JITO_PROTOCOL_ID, NaveError::ProtocolNotApproved);
    require!(sp.mint == ctx.accounts.mint.key(), NaveError::MintMismatch);
    require!(
        sp.ext_market != Pubkey::default() && sp.ext_reserve != Pubkey::default(),
        NaveError::PositionTargetsUnset
    );
    require!(sp.ext_market == ctx.accounts.stake_pool.key(), NaveError::ExternalTargetMismatch);
    require!(sp.ext_reserve == ctx.accounts.reserve_stake.key(), NaveError::ExternalTargetMismatch);
    require!(
        sp.position_token_account == ctx.accounts.position_token_account.key(),
        NaveError::InvalidPositionTokenAccount
    );
    require!(
        ctx.accounts.position_token_account.owner == ctx.accounts.vault_authority.key(),
        NaveError::InvalidPositionTokenAccount
    );
    require!(
        ctx.accounts.stake_pool_program.key() == spl_stake_pool_program::ID,
        NaveError::InvalidExternalProgram
    );
    require!(
        ctx.accounts.strategy_escrow.amount >= amount,
        NaveError::InsufficientEscrowBalance
    );
    // With `init_if_needed`, a stranded temp account from a previously failed
    // deposit may be reused. Anchor already verifies its mint + authority match
    // the PDA constraints; we additionally require it to be empty so a leftover
    // balance can never be silently swept into this deposit's unwrap/close.
    require!(
        ctx.accounts.temp_wsol.amount == 0,
        NaveError::TempAccountNotEmpty
    );

    let dao_key = ctx.accounts.dao_registry.key();
    let va_bump = [ctx.accounts.vault_authority.bump];
    let va_seeds: &[&[u8]] = &[VAULT_AUTHORITY_SEED, dao_key.as_ref(), &va_bump];
    let va_signer: &[&[&[u8]]] = &[va_seeds];

    // 1. Move `amount` wSOL escrow -> temp wSOL account (vault_authority signs).
    spl_transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            SplTransfer {
                from: ctx.accounts.strategy_escrow.to_account_info(),
                to: ctx.accounts.temp_wsol.to_account_info(),
                authority: ctx.accounts.vault_authority.to_account_info(),
            },
            va_signer,
        ),
        amount,
    )?;

    // 2. Close temp wSOL -> native lamports land in the SOL funding PDA. This
    //    unwraps `amount` (plus the temp account's rent, which stays in the
    //    DAO-owned funding PDA and is reused on subsequent deposits).
    close_account(CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        CloseAccount {
            account: ctx.accounts.temp_wsol.to_account_info(),
            destination: ctx.accounts.sol_funding.to_account_info(),
            authority: ctx.accounts.vault_authority.to_account_info(),
        },
        va_signer,
    ))?;

    // 3. DepositSol from the funding PDA into the stake pool; pool tokens to the
    //    vault-owned position account. The funding PDA is the lamport source +
    //    signer.
    let sf_bump = [ctx.bumps.sol_funding];
    let sf_seeds: &[&[u8]] = &[SOL_FUNDING_SEED, dao_key.as_ref(), &sf_bump];
    let sf_signer: &[&[&[u8]]] = &[sf_seeds];

    let mut data = vec![SPL_STAKE_POOL_DEPOSIT_SOL_TAG];
    data.extend_from_slice(&amount.to_le_bytes());
    let ix = Instruction {
        program_id: spl_stake_pool_program::ID,
        accounts: vec![
            AccountMeta::new(ctx.accounts.stake_pool.key(), false),
            AccountMeta::new_readonly(ctx.accounts.stake_pool_withdraw_authority.key(), false),
            AccountMeta::new(ctx.accounts.reserve_stake.key(), false),
            AccountMeta::new(ctx.accounts.sol_funding.key(), true),
            AccountMeta::new(ctx.accounts.position_token_account.key(), false),
            AccountMeta::new(ctx.accounts.manager_fee_account.key(), false),
            AccountMeta::new(ctx.accounts.position_token_account.key(), false),
            AccountMeta::new(ctx.accounts.pool_mint.key(), false),
            AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
            AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),
        ],
        data,
    };
    invoke_signed(
        &ix,
        &[
            ctx.accounts.stake_pool.to_account_info(),
            ctx.accounts.stake_pool_withdraw_authority.to_account_info(),
            ctx.accounts.reserve_stake.to_account_info(),
            ctx.accounts.sol_funding.to_account_info(),
            ctx.accounts.position_token_account.to_account_info(),
            ctx.accounts.manager_fee_account.to_account_info(),
            ctx.accounts.pool_mint.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
            ctx.accounts.stake_pool_program.to_account_info(),
        ],
        sf_signer,
    )?;
    Ok(())
}

// ── jito_withdraw ────────────────────────────────────────────────────────────
// Operational-agent-gated. `WithdrawSol` burns `pool_tokens` from the vault-
// owned position account, sending native lamports into the funding PDA, then
// re-wraps them into the wSOL escrow (system transfer + sync_native).

pub fn jito_withdraw_handler(ctx: Context<JitoWithdraw>, pool_tokens: u64) -> Result<()> {
    require_not_paused(&ctx.accounts.global_config)?;
    require_dao_active(&ctx.accounts.dao_registry)?;
    require_agent_authority(
        &ctx.accounts.authority.key(),
        &ctx.accounts.agent_set,
        AgentRole::Operational,
    )?;
    require_agents_enabled(&ctx.accounts.agent_set)?;

    let sp = &ctx.accounts.strategy_position;
    require!(sp.protocol_id_slice() == JITO_PROTOCOL_ID, NaveError::ProtocolNotApproved);
    require!(sp.mint == ctx.accounts.mint.key(), NaveError::MintMismatch);
    require!(sp.ext_market == ctx.accounts.stake_pool.key(), NaveError::ExternalTargetMismatch);
    require!(sp.ext_reserve == ctx.accounts.reserve_stake.key(), NaveError::ExternalTargetMismatch);
    require!(
        sp.position_token_account == ctx.accounts.position_token_account.key(),
        NaveError::InvalidPositionTokenAccount
    );
    require!(
        ctx.accounts.stake_pool_program.key() == spl_stake_pool_program::ID,
        NaveError::InvalidExternalProgram
    );
    require!(
        ctx.accounts.position_token_account.amount >= pool_tokens,
        NaveError::InsufficientReceiptBalance
    );

    let dao_key = ctx.accounts.dao_registry.key();
    let va_bump = [ctx.accounts.vault_authority.bump];
    let va_seeds: &[&[u8]] = &[VAULT_AUTHORITY_SEED, dao_key.as_ref(), &va_bump];
    let va_signer: &[&[&[u8]]] = &[va_seeds];

    // Snapshot funding PDA lamports so we re-wrap exactly the amount the stake
    // pool credits (pool-token value minus withdraw fee), not any pre-existing
    // dust.
    let funding_before = ctx.accounts.sol_funding.lamports();

    // 1. WithdrawSol: burn pool tokens, lamports -> funding PDA. The pool-token
    //    transfer authority is the vault_authority PDA.
    let mut data = vec![SPL_STAKE_POOL_WITHDRAW_SOL_TAG];
    data.extend_from_slice(&pool_tokens.to_le_bytes());
    let ix = Instruction {
        program_id: spl_stake_pool_program::ID,
        accounts: vec![
            AccountMeta::new(ctx.accounts.stake_pool.key(), false),
            AccountMeta::new_readonly(ctx.accounts.stake_pool_withdraw_authority.key(), false),
            AccountMeta::new_readonly(ctx.accounts.vault_authority.key(), true),
            AccountMeta::new(ctx.accounts.position_token_account.key(), false),
            AccountMeta::new(ctx.accounts.reserve_stake.key(), false),
            AccountMeta::new(ctx.accounts.sol_funding.key(), false),
            AccountMeta::new(ctx.accounts.manager_fee_account.key(), false),
            AccountMeta::new(ctx.accounts.pool_mint.key(), false),
            AccountMeta::new_readonly(ctx.accounts.clock.key(), false),
            AccountMeta::new_readonly(ctx.accounts.stake_history.key(), false),
            AccountMeta::new_readonly(ctx.accounts.stake_program.key(), false),
            AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),
        ],
        data,
    };
    invoke_signed(
        &ix,
        &[
            ctx.accounts.stake_pool.to_account_info(),
            ctx.accounts.stake_pool_withdraw_authority.to_account_info(),
            ctx.accounts.vault_authority.to_account_info(),
            ctx.accounts.position_token_account.to_account_info(),
            ctx.accounts.reserve_stake.to_account_info(),
            ctx.accounts.sol_funding.to_account_info(),
            ctx.accounts.manager_fee_account.to_account_info(),
            ctx.accounts.pool_mint.to_account_info(),
            ctx.accounts.clock.to_account_info(),
            ctx.accounts.stake_history.to_account_info(),
            ctx.accounts.stake_program.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
        ],
        va_signer,
    )?;

    // 2. Re-wrap: move the lamports the stake pool just credited (delta over the
    //    pre-withdraw balance) from the funding PDA into the wSOL escrow (system
    //    transfer signed by the funding PDA), then sync_native so the escrow's
    //    wSOL balance reflects the redeemed liquidity.
    let funding_after = ctx.accounts.sol_funding.lamports();
    let rewrap = funding_after
        .checked_sub(funding_before)
        .ok_or(NaveError::MathOverflow)?;
    require!(rewrap > 0, NaveError::InsufficientReceiptBalance);

    let sf_bump = [ctx.bumps.sol_funding];
    let sf_seeds: &[&[u8]] = &[SOL_FUNDING_SEED, dao_key.as_ref(), &sf_bump];
    let sf_signer: &[&[&[u8]]] = &[sf_seeds];
    let transfer_ix = system_instruction::transfer(
        &ctx.accounts.sol_funding.key(),
        &ctx.accounts.strategy_escrow.key(),
        rewrap,
    );
    invoke_signed(
        &transfer_ix,
        &[
            ctx.accounts.sol_funding.to_account_info(),
            ctx.accounts.strategy_escrow.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ],
        sf_signer,
    )?;
    sync_native(CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        SyncNative {
            account: ctx.accounts.strategy_escrow.to_account_info(),
        },
    ))?;
    Ok(())
}

#[derive(Accounts)]
pub struct JitoDeposit<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(seeds = [GLOBAL_CONFIG_SEED], bump = global_config.bump)]
    pub global_config: Account<'info, NaveGlobalConfig>,

    #[account(
        seeds = [DAO_REGISTRY_SEED, dao_registry.founder.as_ref(), &dao_registry.dao_id.to_le_bytes()],
        bump = dao_registry.bump
    )]
    pub dao_registry: Account<'info, DaoRegistry>,

    #[account(
        seeds = [AGENT_SET_SEED, dao_registry.key().as_ref()],
        bump = agent_set.bump,
        constraint = agent_set.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch
    )]
    pub agent_set: Account<'info, AgentSet>,

    #[account(constraint = mint.key() == wsol_mint::ID @ NaveError::MintMismatch)]
    pub mint: Account<'info, Mint>,

    #[account(
        seeds = [VAULT_AUTHORITY_SEED, dao_registry.key().as_ref()],
        bump = vault_authority.bump,
        constraint = vault_authority.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch
    )]
    pub vault_authority: Account<'info, VaultAuthority>,

    #[account(
        seeds = [STRATEGY_POSITION_SEED, dao_registry.key().as_ref(), JITO_PROTOCOL_ID, mint.key().as_ref()],
        bump = strategy_position.bump,
        constraint = strategy_position.dao == dao_registry.key() @ NaveError::Unauthorized
    )]
    pub strategy_position: Account<'info, StrategyPosition>,

    #[account(
        mut,
        seeds = [STRATEGY_ESCROW_SEED, dao_registry.key().as_ref(), JITO_PROTOCOL_ID, mint.key().as_ref()],
        bump,
        constraint = strategy_escrow.owner == vault_authority.key() @ NaveError::Unauthorized
    )]
    pub strategy_escrow: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub position_token_account: Box<Account<'info, TokenAccount>>,

    /// Native SOL funding PDA: system-owned, signs `DepositSol`.
    #[account(
        mut,
        seeds = [SOL_FUNDING_SEED, dao_registry.key().as_ref()],
        bump
    )]
    pub sol_funding: SystemAccount<'info>,

    /// Ephemeral wSOL account used purely to unwrap escrow wSOL into the funding
    /// PDA; created here and closed within the same instruction. Uses
    /// `init_if_needed` (rather than `init`) so a prior deposit that failed
    /// AFTER creating this PDA but BEFORE closing it cannot permanently brick
    /// jito deposits by leaving a stranded account at this address. The handler
    /// additionally asserts the (re)used account is empty before depositing.
    #[account(
        init_if_needed,
        payer = authority,
        token::mint = mint,
        token::authority = vault_authority,
        seeds = [JITO_TMP_WSOL_SEED, dao_registry.key().as_ref(), mint.key().as_ref()],
        bump
    )]
    pub temp_wsol: Box<Account<'info, TokenAccount>>,

    /// CHECK: verified against `spl_stake_pool_program::ID`.
    pub stake_pool_program: UncheckedAccount<'info>,
    /// CHECK: bound to `strategy_position.ext_market`.
    #[account(mut)]
    pub stake_pool: UncheckedAccount<'info>,
    /// CHECK: stake pool withdraw authority PDA; validated by the stake pool.
    pub stake_pool_withdraw_authority: UncheckedAccount<'info>,
    /// CHECK: bound to `strategy_position.ext_reserve`.
    #[account(mut)]
    pub reserve_stake: UncheckedAccount<'info>,
    /// CHECK: manager fee pool-token account; validated by the stake pool.
    #[account(mut)]
    pub manager_fee_account: UncheckedAccount<'info>,
    /// CHECK: pool token mint; must match the position account's mint.
    #[account(mut, constraint = pool_mint.key() == position_token_account.mint @ NaveError::MintMismatch)]
    pub pool_mint: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct JitoWithdraw<'info> {
    pub authority: Signer<'info>,

    #[account(seeds = [GLOBAL_CONFIG_SEED], bump = global_config.bump)]
    pub global_config: Account<'info, NaveGlobalConfig>,

    #[account(
        seeds = [DAO_REGISTRY_SEED, dao_registry.founder.as_ref(), &dao_registry.dao_id.to_le_bytes()],
        bump = dao_registry.bump
    )]
    pub dao_registry: Account<'info, DaoRegistry>,

    #[account(
        seeds = [AGENT_SET_SEED, dao_registry.key().as_ref()],
        bump = agent_set.bump,
        constraint = agent_set.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch
    )]
    pub agent_set: Account<'info, AgentSet>,

    #[account(constraint = mint.key() == wsol_mint::ID @ NaveError::MintMismatch)]
    pub mint: Account<'info, Mint>,

    #[account(
        seeds = [VAULT_AUTHORITY_SEED, dao_registry.key().as_ref()],
        bump = vault_authority.bump,
        constraint = vault_authority.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch
    )]
    pub vault_authority: Account<'info, VaultAuthority>,

    #[account(
        seeds = [STRATEGY_POSITION_SEED, dao_registry.key().as_ref(), JITO_PROTOCOL_ID, mint.key().as_ref()],
        bump = strategy_position.bump,
        constraint = strategy_position.dao == dao_registry.key() @ NaveError::Unauthorized
    )]
    pub strategy_position: Account<'info, StrategyPosition>,

    #[account(
        mut,
        seeds = [STRATEGY_ESCROW_SEED, dao_registry.key().as_ref(), JITO_PROTOCOL_ID, mint.key().as_ref()],
        bump,
        constraint = strategy_escrow.owner == vault_authority.key() @ NaveError::Unauthorized
    )]
    pub strategy_escrow: Account<'info, TokenAccount>,

    #[account(mut)]
    pub position_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [SOL_FUNDING_SEED, dao_registry.key().as_ref()],
        bump
    )]
    pub sol_funding: SystemAccount<'info>,

    /// CHECK: verified against `spl_stake_pool_program::ID`.
    pub stake_pool_program: UncheckedAccount<'info>,
    /// CHECK: bound to `strategy_position.ext_market`.
    #[account(mut)]
    pub stake_pool: UncheckedAccount<'info>,
    /// CHECK: stake pool withdraw authority PDA.
    pub stake_pool_withdraw_authority: UncheckedAccount<'info>,
    /// CHECK: bound to `strategy_position.ext_reserve`.
    #[account(mut)]
    pub reserve_stake: UncheckedAccount<'info>,
    /// CHECK: manager fee pool-token account.
    #[account(mut)]
    pub manager_fee_account: UncheckedAccount<'info>,
    /// CHECK: pool token mint; must match the position account's mint.
    #[account(mut, constraint = pool_mint.key() == position_token_account.mint @ NaveError::MintMismatch)]
    pub pool_mint: UncheckedAccount<'info>,

    pub clock: Sysvar<'info, Clock>,
    /// CHECK: stake history sysvar.
    #[account(address = anchor_lang::solana_program::sysvar::stake_history::ID)]
    pub stake_history: UncheckedAccount<'info>,
    /// CHECK: native Stake program.
    #[account(address = crate::constants::stake_program::ID)]
    pub stake_program: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}
