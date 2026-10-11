use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::solana_program::sysvar::instructions::ID as SYSVAR_INSTRUCTIONS_ID;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::constants::{
    kamino_lending_program, AgentRole, AGENT_SET_SEED, DAO_REGISTRY_SEED, GLOBAL_CONFIG_SEED,
    POSITION_TOKEN_SEED, STRATEGY_ESCROW_SEED, STRATEGY_POSITION_SEED, VAULT_AUTHORITY_SEED,
};
use crate::errors::NaveError;
use crate::state::{
    AgentSet, DaoRegistry, NaveGlobalConfig, StrategyPosition, VaultAuthority,
};
use crate::utils::{require_agent_authority, require_agents_enabled, require_dao_active, require_not_paused};

/// klend protocol id this module operates on.
const KAMINO_PROTOCOL_ID: &[u8] = b"kamino";

// klend Anchor instruction discriminators (`sha256("global:<name>")[..8]`).
const DISC_REFRESH_RESERVE: [u8; 8] = [2, 218, 138, 235, 79, 201, 25, 102];
const DISC_DEPOSIT_RESERVE_LIQUIDITY: [u8; 8] = [169, 201, 30, 126, 6, 205, 102, 68];
const DISC_REDEEM_RESERVE_COLLATERAL: [u8; 8] = [234, 117, 181, 125, 185, 142, 220, 29];

// ── configure_position_targets ───────────────────────────────────────────────
// Founder-gated: binds the approved Kamino market + reserve to a strategy
// position and provisions the vault-owned receipt-token (cToken) account. This
// is what makes the agent-triggered CPIs safe: the agent can only ever deploy
// escrowed funds into THIS reserve and receive cTokens into THIS vault-owned
// account.

pub fn configure_position_targets_handler(
    ctx: Context<ConfigurePositionTargets>,
    _protocol_id: String,
    ext_market: Pubkey,
    ext_reserve: Pubkey,
) -> Result<()> {
    require!(
        ctx.accounts.authority.key() == ctx.accounts.dao_registry.founder,
        NaveError::Unauthorized
    );
    require!(
        ext_market != Pubkey::default() && ext_reserve != Pubkey::default(),
        NaveError::ExternalTargetMismatch
    );

    let sp = &mut ctx.accounts.strategy_position;
    sp.ext_market = ext_market;
    sp.ext_reserve = ext_reserve;
    sp.position_token_account = ctx.accounts.position_token_account.key();
    Ok(())
}

#[derive(Accounts)]
#[instruction(protocol_id: String)]
pub struct ConfigurePositionTargets<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(seeds = [GLOBAL_CONFIG_SEED], bump = global_config.bump)]
    pub global_config: Account<'info, NaveGlobalConfig>,

    #[account(
        seeds = [DAO_REGISTRY_SEED, dao_registry.founder.as_ref(), &dao_registry.dao_id.to_le_bytes()],
        bump = dao_registry.bump
    )]
    pub dao_registry: Account<'info, DaoRegistry>,

    /// Asset mint the position deploys (= reserve liquidity mint).
    pub mint: Account<'info, Mint>,

    /// Reserve cToken (collateral) mint that the receipt account will hold.
    pub collateral_mint: Account<'info, Mint>,

    #[account(
        seeds = [VAULT_AUTHORITY_SEED, dao_registry.key().as_ref()],
        bump = vault_authority.bump,
        constraint = vault_authority.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch
    )]
    pub vault_authority: Account<'info, VaultAuthority>,

    #[account(
        mut,
        seeds = [STRATEGY_POSITION_SEED, dao_registry.key().as_ref(), protocol_id.as_bytes(), mint.key().as_ref()],
        bump = strategy_position.bump,
        constraint = strategy_position.dao == dao_registry.key() @ NaveError::Unauthorized,
        constraint = strategy_position.mint == mint.key() @ NaveError::MintMismatch
    )]
    pub strategy_position: Account<'info, StrategyPosition>,

    /// Vault-owned receipt-token account holding cTokens for this position.
    #[account(
        init_if_needed,
        payer = authority,
        token::mint = collateral_mint,
        token::authority = vault_authority,
        seeds = [POSITION_TOKEN_SEED, dao_registry.key().as_ref(), protocol_id.as_bytes(), mint.key().as_ref()],
        bump
    )]
    pub position_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

// ── kamino_deposit ───────────────────────────────────────────────────────────
// Operational-agent-gated. Refreshes the reserve, then deposits `amount` base
// units of the asset from the per-(dao, kamino, mint) escrow into the Kamino
// reserve, receiving cTokens into the vault-owned position token account. The
// vault_authority PDA signs both the source-liquidity debit and as the deposit
// `owner`.

pub fn kamino_deposit_handler<'info>(
    ctx: Context<'_, '_, '_, 'info, KaminoDeposit<'info>>,
    amount: u64,
) -> Result<()> {
    require_not_paused(&ctx.accounts.global_config)?;
    require_dao_active(&ctx.accounts.dao_registry)?;
    require_agent_authority(
        &ctx.accounts.authority.key(),
        &ctx.accounts.agent_set,
        AgentRole::Operational,
    )?;
    require_agents_enabled(&ctx.accounts.agent_set)?;

    let sp = &ctx.accounts.strategy_position;
    require!(sp.protocol_id_slice() == KAMINO_PROTOCOL_ID, NaveError::ProtocolNotApproved);
    require!(sp.mint == ctx.accounts.mint.key(), NaveError::MintMismatch);
    require!(
        sp.ext_market != Pubkey::default() && sp.ext_reserve != Pubkey::default(),
        NaveError::PositionTargetsUnset
    );
    require!(
        sp.ext_market == ctx.accounts.lending_market.key(),
        NaveError::ExternalTargetMismatch
    );
    require!(sp.ext_reserve == ctx.accounts.reserve.key(), NaveError::ExternalTargetMismatch);
    require!(
        sp.position_token_account == ctx.accounts.position_token_account.key(),
        NaveError::InvalidPositionTokenAccount
    );
    require!(
        ctx.accounts.position_token_account.owner == ctx.accounts.vault_authority.key(),
        NaveError::InvalidPositionTokenAccount
    );
    require!(
        ctx.accounts.klend_program.key() == kamino_lending_program::ID,
        NaveError::InvalidExternalProgram
    );
    require!(
        ctx.accounts.strategy_escrow.amount >= amount,
        NaveError::InsufficientEscrowBalance
    );

    let dao_key = ctx.accounts.dao_registry.key();
    let bump = [ctx.accounts.vault_authority.bump];
    let seeds: &[&[u8]] = &[VAULT_AUTHORITY_SEED, dao_key.as_ref(), &bump];
    let signer: &[&[&[u8]]] = &[seeds];

    invoke_refresh_reserve(&ctx, signer)?;

    // deposit_reserve_liquidity
    let mut data = DISC_DEPOSIT_RESERVE_LIQUIDITY.to_vec();
    data.extend_from_slice(&amount.to_le_bytes());
    let ix = Instruction {
        program_id: kamino_lending_program::ID,
        accounts: vec![
            AccountMeta::new_readonly(ctx.accounts.vault_authority.key(), true),
            AccountMeta::new(ctx.accounts.reserve.key(), false),
            AccountMeta::new_readonly(ctx.accounts.lending_market.key(), false),
            AccountMeta::new_readonly(ctx.accounts.lending_market_authority.key(), false),
            AccountMeta::new_readonly(ctx.accounts.mint.key(), false),
            AccountMeta::new(ctx.accounts.reserve_liquidity_supply.key(), false),
            AccountMeta::new(ctx.accounts.reserve_collateral_mint.key(), false),
            AccountMeta::new(ctx.accounts.strategy_escrow.key(), false),
            AccountMeta::new(ctx.accounts.position_token_account.key(), false),
            AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),
            AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),
            AccountMeta::new_readonly(SYSVAR_INSTRUCTIONS_ID, false),
        ],
        data,
    };
    invoke_signed(
        &ix,
        &[
            ctx.accounts.vault_authority.to_account_info(),
            ctx.accounts.reserve.to_account_info(),
            ctx.accounts.lending_market.to_account_info(),
            ctx.accounts.lending_market_authority.to_account_info(),
            ctx.accounts.mint.to_account_info(),
            ctx.accounts.reserve_liquidity_supply.to_account_info(),
            ctx.accounts.reserve_collateral_mint.to_account_info(),
            ctx.accounts.strategy_escrow.to_account_info(),
            ctx.accounts.position_token_account.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
            ctx.accounts.instructions_sysvar.to_account_info(),
        ],
        signer,
    )?;
    Ok(())
}

// ── kamino_withdraw ──────────────────────────────────────────────────────────
// Operational-agent-gated. Refreshes the reserve, then redeems
// `collateral_amount` cTokens from the vault-owned position token account back
// into the per-(dao, kamino, mint) escrow as the underlying liquidity.

pub fn kamino_withdraw_handler<'info>(
    ctx: Context<'_, '_, '_, 'info, KaminoWithdraw<'info>>,
    collateral_amount: u64,
) -> Result<()> {
    require_not_paused(&ctx.accounts.global_config)?;
    require_dao_active(&ctx.accounts.dao_registry)?;
    require_agent_authority(
        &ctx.accounts.authority.key(),
        &ctx.accounts.agent_set,
        AgentRole::Operational,
    )?;
    require_agents_enabled(&ctx.accounts.agent_set)?;

    let sp = &ctx.accounts.strategy_position;
    require!(sp.protocol_id_slice() == KAMINO_PROTOCOL_ID, NaveError::ProtocolNotApproved);
    require!(sp.mint == ctx.accounts.mint.key(), NaveError::MintMismatch);
    require!(
        sp.ext_market == ctx.accounts.lending_market.key(),
        NaveError::ExternalTargetMismatch
    );
    require!(sp.ext_reserve == ctx.accounts.reserve.key(), NaveError::ExternalTargetMismatch);
    require!(
        sp.position_token_account == ctx.accounts.position_token_account.key(),
        NaveError::InvalidPositionTokenAccount
    );
    require!(
        ctx.accounts.klend_program.key() == kamino_lending_program::ID,
        NaveError::InvalidExternalProgram
    );
    require!(
        ctx.accounts.position_token_account.amount >= collateral_amount,
        NaveError::InsufficientReceiptBalance
    );

    let dao_key = ctx.accounts.dao_registry.key();
    let bump = [ctx.accounts.vault_authority.bump];
    let seeds: &[&[u8]] = &[VAULT_AUTHORITY_SEED, dao_key.as_ref(), &bump];
    let signer: &[&[&[u8]]] = &[seeds];

    invoke_refresh_reserve_w(&ctx, signer)?;

    // redeem_reserve_collateral
    let mut data = DISC_REDEEM_RESERVE_COLLATERAL.to_vec();
    data.extend_from_slice(&collateral_amount.to_le_bytes());
    let ix = Instruction {
        program_id: kamino_lending_program::ID,
        accounts: vec![
            AccountMeta::new_readonly(ctx.accounts.vault_authority.key(), true),
            AccountMeta::new_readonly(ctx.accounts.lending_market.key(), false),
            AccountMeta::new(ctx.accounts.reserve.key(), false),
            AccountMeta::new_readonly(ctx.accounts.lending_market_authority.key(), false),
            AccountMeta::new_readonly(ctx.accounts.mint.key(), false),
            AccountMeta::new(ctx.accounts.reserve_collateral_mint.key(), false),
            AccountMeta::new(ctx.accounts.reserve_liquidity_supply.key(), false),
            AccountMeta::new(ctx.accounts.position_token_account.key(), false),
            AccountMeta::new(ctx.accounts.strategy_escrow.key(), false),
            AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),
            AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),
            AccountMeta::new_readonly(SYSVAR_INSTRUCTIONS_ID, false),
        ],
        data,
    };
    invoke_signed(
        &ix,
        &[
            ctx.accounts.vault_authority.to_account_info(),
            ctx.accounts.lending_market.to_account_info(),
            ctx.accounts.reserve.to_account_info(),
            ctx.accounts.lending_market_authority.to_account_info(),
            ctx.accounts.mint.to_account_info(),
            ctx.accounts.reserve_collateral_mint.to_account_info(),
            ctx.accounts.reserve_liquidity_supply.to_account_info(),
            ctx.accounts.position_token_account.to_account_info(),
            ctx.accounts.strategy_escrow.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
            ctx.accounts.instructions_sysvar.to_account_info(),
        ],
        signer,
    )?;
    Ok(())
}

/// Build + invoke `refresh_reserve`. The 4 Kamino oracle slots
/// (pyth / switchboard price / switchboard twap / scope) are passed as the
/// instruction's `remaining_accounts`, in that order, using the klend program id
/// as the placeholder for any unused slot.
fn invoke_refresh_reserve<'info>(
    ctx: &Context<'_, '_, '_, 'info, KaminoDeposit<'info>>,
    signer: &[&[&[u8]]],
) -> Result<()> {
    let data = DISC_REFRESH_RESERVE.to_vec();
    let mut metas = vec![
        AccountMeta::new(ctx.accounts.reserve.key(), false),
        AccountMeta::new_readonly(ctx.accounts.lending_market.key(), false),
    ];
    let mut infos = vec![
        ctx.accounts.reserve.to_account_info(),
        ctx.accounts.lending_market.to_account_info(),
    ];
    for oracle in ctx.remaining_accounts.iter() {
        metas.push(AccountMeta::new_readonly(oracle.key(), false));
        infos.push(oracle.clone());
    }
    let ix = Instruction {
        program_id: kamino_lending_program::ID,
        accounts: metas,
        data,
    };
    invoke_signed(&ix, &infos, signer)?;
    Ok(())
}

fn invoke_refresh_reserve_w<'info>(
    ctx: &Context<'_, '_, '_, 'info, KaminoWithdraw<'info>>,
    signer: &[&[&[u8]]],
) -> Result<()> {
    let data = DISC_REFRESH_RESERVE.to_vec();
    let mut metas = vec![
        AccountMeta::new(ctx.accounts.reserve.key(), false),
        AccountMeta::new_readonly(ctx.accounts.lending_market.key(), false),
    ];
    let mut infos = vec![
        ctx.accounts.reserve.to_account_info(),
        ctx.accounts.lending_market.to_account_info(),
    ];
    for oracle in ctx.remaining_accounts.iter() {
        metas.push(AccountMeta::new_readonly(oracle.key(), false));
        infos.push(oracle.clone());
    }
    let ix = Instruction {
        program_id: kamino_lending_program::ID,
        accounts: metas,
        data,
    };
    invoke_signed(&ix, &infos, signer)?;
    Ok(())
}

#[derive(Accounts)]
pub struct KaminoDeposit<'info> {
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

    pub mint: Account<'info, Mint>,

    #[account(
        seeds = [VAULT_AUTHORITY_SEED, dao_registry.key().as_ref()],
        bump = vault_authority.bump,
        constraint = vault_authority.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch
    )]
    pub vault_authority: Account<'info, VaultAuthority>,

    #[account(
        seeds = [STRATEGY_POSITION_SEED, dao_registry.key().as_ref(), KAMINO_PROTOCOL_ID, mint.key().as_ref()],
        bump = strategy_position.bump,
        constraint = strategy_position.dao == dao_registry.key() @ NaveError::Unauthorized
    )]
    pub strategy_position: Account<'info, StrategyPosition>,

    #[account(
        mut,
        seeds = [STRATEGY_ESCROW_SEED, dao_registry.key().as_ref(), KAMINO_PROTOCOL_ID, mint.key().as_ref()],
        bump,
        constraint = strategy_escrow.owner == vault_authority.key() @ NaveError::Unauthorized
    )]
    pub strategy_escrow: Account<'info, TokenAccount>,

    #[account(mut)]
    pub position_token_account: Account<'info, TokenAccount>,

    /// CHECK: verified against `kamino_lending_program::ID` in the handler.
    pub klend_program: UncheckedAccount<'info>,
    /// CHECK: bound to `strategy_position.ext_reserve`; klend validates internally.
    #[account(mut)]
    pub reserve: UncheckedAccount<'info>,
    /// CHECK: bound to `strategy_position.ext_market`.
    pub lending_market: UncheckedAccount<'info>,
    /// CHECK: klend lending market authority PDA; validated by klend.
    pub lending_market_authority: UncheckedAccount<'info>,
    /// CHECK: reserve liquidity supply vault; validated by klend.
    #[account(mut)]
    pub reserve_liquidity_supply: UncheckedAccount<'info>,
    /// CHECK: reserve collateral (cToken) mint; validated by klend.
    #[account(mut)]
    pub reserve_collateral_mint: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,

    /// CHECK: instructions sysvar.
    #[account(address = SYSVAR_INSTRUCTIONS_ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct KaminoWithdraw<'info> {
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

    pub mint: Account<'info, Mint>,

    #[account(
        seeds = [VAULT_AUTHORITY_SEED, dao_registry.key().as_ref()],
        bump = vault_authority.bump,
        constraint = vault_authority.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch
    )]
    pub vault_authority: Account<'info, VaultAuthority>,

    #[account(
        seeds = [STRATEGY_POSITION_SEED, dao_registry.key().as_ref(), KAMINO_PROTOCOL_ID, mint.key().as_ref()],
        bump = strategy_position.bump,
        constraint = strategy_position.dao == dao_registry.key() @ NaveError::Unauthorized
    )]
    pub strategy_position: Account<'info, StrategyPosition>,

    #[account(
        mut,
        seeds = [STRATEGY_ESCROW_SEED, dao_registry.key().as_ref(), KAMINO_PROTOCOL_ID, mint.key().as_ref()],
        bump,
        constraint = strategy_escrow.owner == vault_authority.key() @ NaveError::Unauthorized
    )]
    pub strategy_escrow: Account<'info, TokenAccount>,

    #[account(mut)]
    pub position_token_account: Account<'info, TokenAccount>,

    /// CHECK: verified against `kamino_lending_program::ID` in the handler.
    pub klend_program: UncheckedAccount<'info>,
    /// CHECK: bound to `strategy_position.ext_reserve`.
    #[account(mut)]
    pub reserve: UncheckedAccount<'info>,
    /// CHECK: bound to `strategy_position.ext_market`.
    pub lending_market: UncheckedAccount<'info>,
    /// CHECK: klend lending market authority PDA.
    pub lending_market_authority: UncheckedAccount<'info>,
    /// CHECK: reserve liquidity supply vault.
    #[account(mut)]
    pub reserve_liquidity_supply: UncheckedAccount<'info>,
    /// CHECK: reserve collateral (cToken) mint.
    #[account(mut)]
    pub reserve_collateral_mint: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,

    /// CHECK: instructions sysvar.
    #[account(address = SYSVAR_INSTRUCTIONS_ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,
}
