use anchor_lang::prelude::*;
use anchor_lang::solana_program::{program::invoke, system_instruction};
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::constants::{
    AssetKind, ASSET_CONFIG_SEED, ASSET_VAULT_SEED, DAO_REGISTRY_SEED, FEE_CONFIG_SEED,
    GLOBAL_CONFIG_SEED, MAX_TREASURY_ASSETS, NFT_VAULT_RECORD_SEED, NFT_VAULT_SEED,
    TREASURY_ASSET_SEED, TREASURY_VAULT_SEED, VAULT_AUTHORITY_SEED,
};
use crate::errors::NaveError;
use crate::state::{
    AssetConfig, DaoRegistry, FeeConfig, NaveGlobalConfig, NftVaultRecord, TreasuryAsset,
    TreasuryVault, VaultAuthority,
};

/// Register a treasury-eligible asset for a DAO. Creates the per-(dao, mint)
/// `AssetConfig` (valuation + routing metadata), `TreasuryAsset` (accounting),
/// and the `asset_vault` holding token account owned by the DAO
/// `vault_authority` PDA. Founder-gated. Distinct from `register_dao_token`,
/// which registers tokens the DAO *issues*.
pub fn register_asset_handler(
    ctx: Context<RegisterAsset>,
    pyth_feed_id: [u8; 32],
    is_stablecoin: bool,
    asset_kind: u8,
) -> Result<()> {
    require!(
        ctx.accounts.authority.key() == ctx.accounts.dao_registry.founder,
        NaveError::Unauthorized
    );
    let kind = AssetKind::from_u8(asset_kind).ok_or(NaveError::InvalidAssetKind)?;
    // Non-stablecoins must carry a non-zero Pyth feed id; stablecoins are pinned
    // to $1 on-chain so a feed is optional for them.
    if !is_stablecoin {
        require!(pyth_feed_id != [0u8; 32], NaveError::OracleFeedMismatch);
    }

    let dao_key = ctx.accounts.dao_registry.key();

    let cfg = &mut ctx.accounts.asset_config;
    cfg.bump = ctx.bumps.asset_config;
    cfg.dao = dao_key;
    cfg.mint = ctx.accounts.mint.key();
    cfg.decimals = ctx.accounts.mint.decimals;
    cfg.pyth_feed_id = pyth_feed_id;
    cfg.is_stablecoin = is_stablecoin;
    cfg.asset_kind = kind as u8;
    cfg.enabled = true;

    // Anchor the first annual management-fee period at registration time,
    // floored to the UTC-midnight boundary (see utils::fees).
    let now = Clock::get()?.unix_timestamp;

    let asset = &mut ctx.accounts.treasury_asset;
    asset.bump = ctx.bumps.treasury_asset;
    asset.dao = dao_key;
    asset.mint = ctx.accounts.mint.key();
    asset.token_account = ctx.accounts.asset_vault.key();
    asset.deposited = 0;
    asset.deployed_capital = 0;
    asset.last_valued_usd = 0;
    asset.last_valued_at = 0;
    asset.last_management_fee_at = crate::utils::floor_to_utc_midnight(now);

    let vault = &mut ctx.accounts.treasury_vault;
    require!(
        (vault.asset_count as usize) < MAX_TREASURY_ASSETS,
        NaveError::TreasuryAssetsFull
    );
    vault.asset_count = vault.asset_count.checked_add(1).ok_or(NaveError::MathOverflow)?;

    Ok(())
}

#[derive(Accounts)]
pub struct RegisterAsset<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(seeds = [GLOBAL_CONFIG_SEED], bump = global_config.bump)]
    pub global_config: Account<'info, NaveGlobalConfig>,

    #[account(
        seeds = [DAO_REGISTRY_SEED, dao_registry.founder.as_ref(), &dao_registry.dao_id.to_le_bytes()],
        bump = dao_registry.bump
    )]
    pub dao_registry: Account<'info, DaoRegistry>,

    pub mint: Account<'info, Mint>,

    #[account(
        seeds = [VAULT_AUTHORITY_SEED, dao_registry.key().as_ref()],
        bump = vault_authority.bump,
        constraint = vault_authority.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch
    )]
    pub vault_authority: Account<'info, VaultAuthority>,

    #[account(
        mut,
        seeds = [TREASURY_VAULT_SEED, dao_registry.key().as_ref()],
        bump = treasury_vault.bump,
        constraint = treasury_vault.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch
    )]
    pub treasury_vault: Account<'info, TreasuryVault>,

    #[account(
        init,
        payer = authority,
        space = AssetConfig::LEN,
        seeds = [ASSET_CONFIG_SEED, dao_registry.key().as_ref(), mint.key().as_ref()],
        bump
    )]
    pub asset_config: Account<'info, AssetConfig>,

    #[account(
        init,
        payer = authority,
        space = TreasuryAsset::LEN,
        seeds = [TREASURY_ASSET_SEED, dao_registry.key().as_ref(), mint.key().as_ref()],
        bump
    )]
    pub treasury_asset: Account<'info, TreasuryAsset>,

    #[account(
        init,
        payer = authority,
        seeds = [ASSET_VAULT_SEED, dao_registry.key().as_ref(), mint.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = vault_authority,
    )]
    pub asset_vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

/// Designate which registered stablecoin USD-denominated fees are paid in.
/// Founder-gated; the asset must already be registered and flagged stablecoin.
pub fn set_fee_asset_handler(ctx: Context<SetFeeAsset>) -> Result<()> {
    require!(
        ctx.accounts.authority.key() == ctx.accounts.dao_registry.founder,
        NaveError::Unauthorized
    );
    require!(
        ctx.accounts.asset_config.is_stablecoin,
        NaveError::InvalidFeeAsset
    );
    ctx.accounts.fee_config.fee_asset_mint = ctx.accounts.mint.key();
    Ok(())
}

#[derive(Accounts)]
pub struct SetFeeAsset<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [DAO_REGISTRY_SEED, dao_registry.founder.as_ref(), &dao_registry.dao_id.to_le_bytes()],
        bump = dao_registry.bump
    )]
    pub dao_registry: Account<'info, DaoRegistry>,

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
        seeds = [FEE_CONFIG_SEED, dao_registry.key().as_ref()],
        bump = fee_config.bump,
        constraint = fee_config.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch
    )]
    pub fee_config: Account<'info, FeeConfig>,
}

/// Deposit `amount` base units of a registered asset into its holding account.
/// USD NAV is recomputed by `revalue_treasury`; this only moves tokens and bumps
/// per-asset principal.
pub fn deposit_to_asset_handler(ctx: Context<DepositToAsset>, amount: u64) -> Result<()> {
    require!(amount > 0, NaveError::MathOverflow);
    require!(ctx.accounts.asset_config.enabled, NaveError::AssetNotEnabled);

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.depositor_token_account.to_account_info(),
                to: ctx.accounts.asset_vault.to_account_info(),
                authority: ctx.accounts.depositor.to_account_info(),
            },
        ),
        amount,
    )?;

    let asset = &mut ctx.accounts.treasury_asset;
    asset.deposited = asset.deposited.checked_add(amount).ok_or(NaveError::MathOverflow)?;

    Ok(())
}

/// Deposit `amount` lamports of native SOL into the DAO's `vault_authority` PDA
/// — the same account that custodies native SOL for governance transfers. This
/// only moves lamports; USD NAV is recomputed by `revalue_treasury`. The NAV
/// staleness is reset (`last_revalued_at = 0`) so any cap-constrained
/// deploy/strategy re-checks against a fresh revaluation rather than the now
/// out-of-date figure (parity with the governance-transfer NAV invalidation).
pub fn deposit_sol_handler(ctx: Context<DepositSol>, amount: u64) -> Result<()> {
    require!(amount > 0, NaveError::MathOverflow);

    // The depositor is a system-owned signer, so a plain System Program transfer
    // (no PDA signing) moves lamports into the program-owned vault authority.
    invoke(
        &system_instruction::transfer(
            &ctx.accounts.depositor.key(),
            &ctx.accounts.vault_authority.key(),
            amount,
        ),
        &[
            ctx.accounts.depositor.to_account_info(),
            ctx.accounts.vault_authority.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ],
    )?;

    ctx.accounts.treasury_vault.last_revalued_at = 0;

    Ok(())
}

#[derive(Accounts)]
pub struct DepositSol<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,

    #[account(
        seeds = [DAO_REGISTRY_SEED, dao_registry.founder.as_ref(), &dao_registry.dao_id.to_le_bytes()],
        bump = dao_registry.bump
    )]
    pub dao_registry: Account<'info, DaoRegistry>,

    #[account(
        mut,
        seeds = [VAULT_AUTHORITY_SEED, dao_registry.key().as_ref()],
        bump = vault_authority.bump,
        constraint = vault_authority.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch
    )]
    pub vault_authority: Account<'info, VaultAuthority>,

    /// Mutated to reset last_revalued_at after the inbound deposit so the next
    /// deploy/strategy enforces a fresh NAV.
    #[account(
        mut,
        seeds = [TREASURY_VAULT_SEED, dao_registry.key().as_ref()],
        bump = treasury_vault.bump,
        constraint = treasury_vault.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch
    )]
    pub treasury_vault: Account<'info, TreasuryVault>,

    pub system_program: Program<'info, System>,
}

/// Register an NFT (decimals-0, supply-1 SPL mint) for treasury custody. Creates
/// the `NftVaultRecord` and the vault-owned `nft_vault` holding token account.
/// Founder-gated. NFTs are held at $0 NAV (no Pyth pricing) and do not consume
/// the fungible asset cap; they leave only via `execute_governance_transfer_nft`.
pub fn register_nft_asset_handler(ctx: Context<RegisterNftAsset>) -> Result<()> {
    require!(
        ctx.accounts.authority.key() == ctx.accounts.dao_registry.founder,
        NaveError::Unauthorized
    );

    let record = &mut ctx.accounts.nft_record;
    record.bump = ctx.bumps.nft_record;
    record.dao = ctx.accounts.dao_registry.key();
    record.mint = ctx.accounts.mint.key();
    record.token_account = ctx.accounts.nft_vault.key();
    record.transferred = false;
    Ok(())
}

#[derive(Accounts)]
pub struct RegisterNftAsset<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [DAO_REGISTRY_SEED, dao_registry.founder.as_ref(), &dao_registry.dao_id.to_le_bytes()],
        bump = dao_registry.bump
    )]
    pub dao_registry: Account<'info, DaoRegistry>,

    pub mint: Account<'info, Mint>,

    #[account(
        seeds = [VAULT_AUTHORITY_SEED, dao_registry.key().as_ref()],
        bump = vault_authority.bump,
        constraint = vault_authority.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch
    )]
    pub vault_authority: Account<'info, VaultAuthority>,

    #[account(
        init,
        payer = authority,
        space = NftVaultRecord::LEN,
        seeds = [NFT_VAULT_RECORD_SEED, dao_registry.key().as_ref(), mint.key().as_ref()],
        bump
    )]
    pub nft_record: Account<'info, NftVaultRecord>,

    #[account(
        init,
        payer = authority,
        seeds = [NFT_VAULT_SEED, dao_registry.key().as_ref(), mint.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = vault_authority,
    )]
    pub nft_vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct DepositToAsset<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,

    #[account(
        seeds = [DAO_REGISTRY_SEED, dao_registry.founder.as_ref(), &dao_registry.dao_id.to_le_bytes()],
        bump = dao_registry.bump
    )]
    pub dao_registry: Account<'info, DaoRegistry>,

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
        seeds = [TREASURY_ASSET_SEED, dao_registry.key().as_ref(), mint.key().as_ref()],
        bump = treasury_asset.bump,
        constraint = treasury_asset.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch,
        constraint = treasury_asset.mint == mint.key() @ NaveError::MintMismatch
    )]
    pub treasury_asset: Account<'info, TreasuryAsset>,

    #[account(
        mut,
        constraint = asset_vault.key() == treasury_asset.token_account @ NaveError::InvalidVaultTokenAccount
    )]
    pub asset_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = depositor_token_account.mint == mint.key() @ NaveError::MintMismatch
    )]
    pub depositor_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}
