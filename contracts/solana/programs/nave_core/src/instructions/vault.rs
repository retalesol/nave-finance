use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::constants::{
    ASSET_CONFIG_SEED, ASSET_VAULT_SEED, DAO_REGISTRY_SEED, FEE_CONFIG_SEED, GLOBAL_CONFIG_SEED,
    TREASURY_ASSET_SEED, TREASURY_VAULT_SEED, VAULT_AUTHORITY_SEED,
};
use crate::errors::NaveError;
use crate::events::VaultDeposited;
use crate::state::{
    AssetConfig, DaoRegistry, FeeConfig, NaveGlobalConfig, TreasuryAsset, TreasuryVault,
    VaultAuthority,
};
use crate::utils::{require_dao_active, require_not_paused, validate_dao_ownership, value_stable};
use anchor_spl::token::{self, Transfer};

pub fn deposit_to_vault_handler(ctx: Context<DepositToVault>, amount: u64) -> Result<()> {
    require_not_paused(&ctx.accounts.global_config)?;
    require_dao_active(&ctx.accounts.dao_registry)?;
    require!(amount > 0, NaveError::MathOverflow);

    validate_dao_ownership(
        &ctx.accounts.treasury_vault.dao,
        &ctx.accounts.dao_registry.key(),
    )?;

    // Legacy single-mint deposit path. `current_nav`/`total_deposited` are
    // micro-USD aggregates; this handler adds the deposit's USD value directly
    // (rather than relying on `revalue_treasury`). That is only sound for
    // USD-pegged stablecoins valued at exactly $1 — for any non-stable asset the
    // base-unit→micro-USD conversion needs a live Pyth price, and adding raw
    // base units (as this path historically did) corrupts NAV. We therefore
    // hard-block non-stablecoin deposits here; non-stable assets must use the
    // multi-asset `deposit_to_asset` + `revalue_treasury` flow.
    require!(
        ctx.accounts.asset_config.is_stablecoin,
        NaveError::NonStablecoinVaultDeposit
    );

    let cpi_accounts = Transfer {
        from: ctx.accounts.depositor_token_account.to_account_info(),
        to: ctx.accounts.vault_token_account.to_account_info(),
        authority: ctx.accounts.depositor.to_account_info(),
    };
    token::transfer(
        CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts),
        amount,
    )?;

    // Scale the deposited base units into micro-USD using the asset's decimals
    // ($1 peg), so e.g. an 8-decimal stablecoin is accounted correctly instead
    // of inflating NAV by 100x. For a 6-decimal stablecoin this equals `amount`,
    // preserving the historical behavior for the common case.
    let amount_usd = value_stable(amount, ctx.accounts.asset_config.decimals)?;

    let treasury_vault = &mut ctx.accounts.treasury_vault;
    treasury_vault.total_deposited = treasury_vault
        .total_deposited
        .checked_add(amount_usd)
        .ok_or(NaveError::MathOverflow)?;
    treasury_vault.current_nav = treasury_vault
        .current_nav
        .checked_add(amount_usd)
        .ok_or(NaveError::MathOverflow)?;
    if treasury_vault.high_water_mark == 0 {
        treasury_vault.high_water_mark = treasury_vault.current_nav;
    }

    emit!(VaultDeposited {
        dao: ctx.accounts.dao_registry.key(),
        depositor: ctx.accounts.depositor.key(),
        amount,
        new_balance: treasury_vault.current_nav,
    });

    Ok(())
}

pub fn withdraw_from_vault_handler(_ctx: Context<WithdrawFromVault>, _amount: u64) -> Result<()> {
    // Treasury withdrawals must flow through the nave_execution agent pipeline.
    Err(NaveError::ExecutionRequestRequired.into())
}

/// Management-fee instruction kept so older transactions still land.
///
/// The canonical rate is 0. This transfers nothing and does not advance
/// `last_management_fee_at` (moving that anchor would look like a fee was
/// taken). It clears stored management and performance bps to the canonical
/// 0 / 1500 pair, including the frozen rates. Account checks stay so a
/// mismatched mint or revenue wallet is still rejected.
pub fn collect_management_fee_handler(ctx: Context<CollectManagementFee>) -> Result<()> {
    require_not_paused(&ctx.accounts.global_config)?;

    validate_dao_ownership(
        &ctx.accounts.treasury_asset.dao,
        &ctx.accounts.dao_registry.key(),
    )?;
    validate_dao_ownership(
        &ctx.accounts.fee_config.dao,
        &ctx.accounts.dao_registry.key(),
    )?;
    // Destination must be a token account owned by the configured protocol
    // revenue wallet, for this asset's mint. Nothing is transferred.
    require!(
        ctx.accounts.revenue_token_account.owner == ctx.accounts.fee_config.protocol_revenue_wallet,
        NaveError::InvalidFeeRecipient
    );
    require!(
        ctx.accounts.revenue_token_account.mint == ctx.accounts.mint.key(),
        NaveError::MintMismatch
    );

    ctx.accounts.fee_config.sync_canonical_rates();
    Ok(())
}

#[derive(Accounts)]
pub struct DepositToVault<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,

    #[account(seeds = [GLOBAL_CONFIG_SEED], bump = global_config.bump)]
    pub global_config: Account<'info, NaveGlobalConfig>,

    #[account(
        seeds = [DAO_REGISTRY_SEED, dao_registry.founder.as_ref(), &dao_registry.dao_id.to_le_bytes()],
        bump = dao_registry.bump
    )]
    pub dao_registry: Account<'info, DaoRegistry>,

    #[account(
        mut,
        seeds = [TREASURY_VAULT_SEED, dao_registry.key().as_ref()],
        bump = treasury_vault.bump,
        constraint = treasury_vault.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch
    )]
    pub treasury_vault: Account<'info, TreasuryVault>,

    /// Mint of the deposited asset; keys the `asset_config` used to confirm the
    /// asset is a registered stablecoin and to scale base units to micro-USD.
    pub mint: Account<'info, Mint>,

    #[account(
        seeds = [ASSET_CONFIG_SEED, dao_registry.key().as_ref(), mint.key().as_ref()],
        bump = asset_config.bump,
        constraint = asset_config.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch,
        constraint = asset_config.mint == mint.key() @ NaveError::MintMismatch
    )]
    pub asset_config: Account<'info, AssetConfig>,

    #[account(
        mut,
        constraint = depositor_token_account.owner == depositor.key(),
        constraint = depositor_token_account.mint == mint.key() @ NaveError::MintMismatch
    )]
    pub depositor_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = vault_token_account.key() == treasury_vault.vault_token_account @ NaveError::Unauthorized,
        constraint = vault_token_account.mint == mint.key() @ NaveError::MintMismatch
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct WithdrawFromVault<'info> {
    pub authority: Signer<'info>,

    #[account(seeds = [GLOBAL_CONFIG_SEED], bump = global_config.bump)]
    pub global_config: Account<'info, NaveGlobalConfig>,

    #[account(
        seeds = [DAO_REGISTRY_SEED, dao_registry.founder.as_ref(), &dao_registry.dao_id.to_le_bytes()],
        bump = dao_registry.bump
    )]
    pub dao_registry: Account<'info, DaoRegistry>,

    #[account(
        mut,
        seeds = [TREASURY_VAULT_SEED, dao_registry.key().as_ref()],
        bump = treasury_vault.bump,
        constraint = treasury_vault.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch
    )]
    pub treasury_vault: Account<'info, TreasuryVault>,

    #[account(
        seeds = [VAULT_AUTHORITY_SEED, dao_registry.key().as_ref()],
        bump = vault_authority.bump,
        constraint = vault_authority.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch
    )]
    pub vault_authority: Account<'info, VaultAuthority>,

    #[account(
        mut,
        constraint = vault_token_account.key() == treasury_vault.vault_token_account @ NaveError::Unauthorized
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub recipient_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CollectManagementFee<'info> {
    pub fee_collector: Signer<'info>,

    #[account(seeds = [GLOBAL_CONFIG_SEED], bump = global_config.bump)]
    pub global_config: Account<'info, NaveGlobalConfig>,

    #[account(
        seeds = [DAO_REGISTRY_SEED, dao_registry.founder.as_ref(), &dao_registry.dao_id.to_le_bytes()],
        bump = dao_registry.bump
    )]
    pub dao_registry: Account<'info, DaoRegistry>,

    #[account(
        mut,
        seeds = [FEE_CONFIG_SEED, dao_registry.key().as_ref()],
        bump = fee_config.bump,
        constraint = fee_config.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch
    )]
    pub fee_config: Account<'info, FeeConfig>,

    #[account(
        seeds = [VAULT_AUTHORITY_SEED, dao_registry.key().as_ref()],
        bump = vault_authority.bump,
        constraint = vault_authority.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch
    )]
    pub vault_authority: Account<'info, VaultAuthority>,

    /// Mint of the registered treasury asset being charged; keys the per-asset
    /// accounts below.
    pub mint: Account<'info, Mint>,

    #[account(
        mut,
        seeds = [TREASURY_ASSET_SEED, dao_registry.key().as_ref(), mint.key().as_ref()],
        bump = treasury_asset.bump,
        constraint = treasury_asset.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch,
        constraint = treasury_asset.mint == mint.key() @ NaveError::MintMismatch
    )]
    pub treasury_asset: Account<'info, TreasuryAsset>,

    /// The asset's idle holding account (`asset_vault` PDA, vault_authority-owned)
    /// — the source the in-kind fee is paid from.
    #[account(
        mut,
        seeds = [ASSET_VAULT_SEED, dao_registry.key().as_ref(), mint.key().as_ref()],
        bump,
        constraint = asset_vault.key() == treasury_asset.token_account @ NaveError::InvalidVaultTokenAccount,
        constraint = asset_vault.owner == vault_authority.key() @ NaveError::Unauthorized
    )]
    pub asset_vault: Account<'info, TokenAccount>,

    /// Destination: protocol revenue wallet's token account for this mint.
    #[account(mut)]
    pub revenue_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}
