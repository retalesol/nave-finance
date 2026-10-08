use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::constants::{
    nave_execution_program, AgentRole, AGENT_SET_SEED, DAO_REGISTRY_SEED, FEE_CONFIG_SEED,
    GLOBAL_CONFIG_SEED, MAX_POSITION_MARK_STEP_BPS, MAX_PROTOCOL_ID_LEN, POSITION_MARK_COOLDOWN_SECS,
    STRATEGY_ESCROW_SEED, STRATEGY_POSITION_SEED, TREASURY_ASSET_SEED, TREASURY_VAULT_SEED,
    VAULT_AUTHORITY_SEED,
};
use crate::errors::NaveError;
use crate::events::PerformanceFeeSkimmed;
use crate::state::{
    AgentSet, DaoRegistry, FeeConfig, NaveGlobalConfig, StrategyPosition, TreasuryAsset,
    TreasuryVault, VaultAuthority,
};
use crate::utils::{
    calculate_performance_skim, record_strategy_deposit, record_strategy_withdrawal,
    transfer_escrow_to_account, transfer_escrow_to_vault, transfer_vault_to_escrow,
    verify_execution_authority,
};

pub fn init_strategy_position_handler(
    ctx: Context<InitStrategyPosition>,
    protocol_id: String,
) -> Result<()> {
    require!(
        !protocol_id.is_empty() && protocol_id.len() <= MAX_PROTOCOL_ID_LEN,
        NaveError::InvalidProtocolIdLength
    );

    // Only the DAO founder may initialize strategy positions. Without this gate
    // any account could permissionlessly create position PDAs for a DAO.
    require!(
        ctx.accounts.authority.key() == ctx.accounts.dao_registry.founder,
        NaveError::Unauthorized
    );

    let sp = &mut ctx.accounts.strategy_position;
    sp.bump = ctx.bumps.strategy_position;
    sp.dao = ctx.accounts.dao_registry.key();
    sp.mint = ctx.accounts.mint.key();
    sp.position_token_account = Pubkey::default();
    sp.ext_market = Pubkey::default();
    sp.ext_reserve = Pubkey::default();
    sp.protocol_id = [0u8; MAX_PROTOCOL_ID_LEN];
    sp.protocol_id[..protocol_id.len()].copy_from_slice(protocol_id.as_bytes());
    sp.protocol_id_len = protocol_id.len() as u8;
    sp.deposited_amount = 0;
    sp.current_value = 0;
    sp.last_updated = 0;
    Ok(())
}

#[derive(Accounts)]
#[instruction(protocol_id: String)]
pub struct InitStrategyPosition<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(seeds = [GLOBAL_CONFIG_SEED], bump = global_config.bump)]
    pub global_config: Account<'info, NaveGlobalConfig>,

    #[account(
        seeds = [DAO_REGISTRY_SEED, dao_registry.founder.as_ref(), &dao_registry.dao_id.to_le_bytes()],
        bump = dao_registry.bump
    )]
    pub dao_registry: Account<'info, DaoRegistry>,

    /// Asset mint this position deploys; part of the position PDA seeds.
    pub mint: Account<'info, Mint>,

    #[account(
        init,
        payer = authority,
        space = StrategyPosition::LEN,
        seeds = [STRATEGY_POSITION_SEED, dao_registry.key().as_ref(), protocol_id.as_bytes(), mint.key().as_ref()],
        bump
    )]
    pub strategy_position: Account<'info, StrategyPosition>,

    pub system_program: Program<'info, System>,
}

/// Provision the per-protocol strategy escrow: a token account owned by the DAO
/// `vault_authority` PDA at seeds [STRATEGY_ESCROW_SEED, dao, protocol_id]. This
/// is a *distinct* account from the vault token ATA, so capital deployed by the
/// agent pipeline physically leaves the vault and lands in an isolated, per-
/// protocol escrow that can be reconciled and unwound independently.
pub fn init_strategy_escrow_handler(
    ctx: Context<InitStrategyEscrow>,
    protocol_id: String,
) -> Result<()> {
    require!(
        !protocol_id.is_empty() && protocol_id.len() <= MAX_PROTOCOL_ID_LEN,
        NaveError::InvalidProtocolIdLength
    );
    // Only the DAO founder may provision escrow vaults; otherwise any account
    // could pre-create escrow PDAs with attacker-chosen rent payers.
    require!(
        ctx.accounts.authority.key() == ctx.accounts.dao_registry.founder,
        NaveError::Unauthorized
    );
    Ok(())
}

#[derive(Accounts)]
#[instruction(protocol_id: String)]
pub struct InitStrategyEscrow<'info> {
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
        seeds = [VAULT_AUTHORITY_SEED, dao_registry.key().as_ref()],
        bump = vault_authority.bump,
        constraint = vault_authority.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch
    )]
    pub vault_authority: Account<'info, VaultAuthority>,

    /// Registered treasury asset whose mint this escrow holds.
    #[account(
        seeds = [TREASURY_ASSET_SEED, dao_registry.key().as_ref(), mint.key().as_ref()],
        bump = treasury_asset.bump,
        constraint = treasury_asset.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch,
        constraint = treasury_asset.mint == mint.key() @ NaveError::MintMismatch
    )]
    pub treasury_asset: Account<'info, TreasuryAsset>,

    pub mint: Account<'info, Mint>,

    #[account(
        init,
        payer = authority,
        seeds = [STRATEGY_ESCROW_SEED, dao_registry.key().as_ref(), protocol_id.as_bytes(), mint.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = vault_authority,
    )]
    pub strategy_escrow: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn record_strategy_deposit_handler(
    ctx: Context<RecordStrategyDeposit>,
    protocol_id: String,
    amount: u64,
    amount_usd: u64,
) -> Result<()> {
    require!(
        !protocol_id.is_empty() && protocol_id.len() <= MAX_PROTOCOL_ID_LEN,
        NaveError::InvalidProtocolIdLength
    );
    verify_execution_authority(
        &ctx.accounts.execution_authority,
        &ctx.accounts.dao_registry.key(),
        &nave_execution_program::ID,
        Some(&ctx.accounts.instructions),
    )?;
    // Move the SPL capital asset_vault(mint) -> per-(protocol,mint) escrow. This
    // MUST run inside nave_core: the holding-account authority is the
    // nave_core-owned vault_authority PDA, so only nave_core can sign for it.
    transfer_vault_to_escrow(
        &ctx.accounts.vault_authority,
        &ctx.accounts.vault_token_account,
        &ctx.accounts.strategy_escrow,
        &ctx.accounts.token_program,
        &ctx.accounts.dao_registry.key(),
        amount,
    )?;
    record_strategy_deposit(
        &mut *ctx.accounts.treasury_vault,
        &mut *ctx.accounts.treasury_asset,
        &mut *ctx.accounts.strategy_position,
        protocol_id.as_bytes(),
        amount,
        amount_usd,
        Clock::get()?.unix_timestamp,
    )
}

pub fn record_strategy_withdrawal_handler(
    ctx: Context<RecordStrategyWithdrawal>,
    amount: u64,
    amount_usd: u64,
    _protocol_id: String,
) -> Result<()> {
    verify_execution_authority(
        &ctx.accounts.execution_authority,
        &ctx.accounts.dao_registry.key(),
        &nave_execution_program::ID,
        Some(&ctx.accounts.instructions),
    )?;

    let dao_key = ctx.accounts.dao_registry.key();

    // ── Performance-fee skim (8.5% of realized yield, before treasury credit) ──
    // Compute the realized-yield portion of this withdrawal from the position's
    // PRE-withdrawal mark, and skim `performance_fee_bps` of it. Principal is
    // never taxed; only the proportional gain. The skim is in the withdrawn
    // asset and is moved straight from the strategy escrow to the protocol
    // revenue wallet, so it never lands in the treasury balance.
    let perf_fee_bps = ctx.accounts.fee_config.performance_fee_bps;
    let (gain, perf_fee) = calculate_performance_skim(
        amount,
        ctx.accounts.strategy_position.deposited_amount,
        ctx.accounts.strategy_position.current_value,
        perf_fee_bps,
    )?;

    if perf_fee > 0 {
        transfer_escrow_to_account(
            &ctx.accounts.vault_authority,
            &ctx.accounts.strategy_escrow,
            &ctx.accounts.revenue_token_account,
            &ctx.accounts.token_program,
            &dao_key,
            perf_fee,
        )?;
    }

    // The remaining 91.5% of yield plus 100% of principal credits the treasury
    // vault, symmetric to deposit: escrow -> asset_vault(mint), signed by the
    // nave_core-owned vault_authority PDA.
    let to_treasury = amount
        .checked_sub(perf_fee)
        .ok_or(NaveError::MathOverflow)?;
    if to_treasury > 0 {
        transfer_escrow_to_vault(
            &ctx.accounts.vault_authority,
            &ctx.accounts.strategy_escrow,
            &ctx.accounts.vault_token_account,
            &ctx.accounts.token_program,
            &dao_key,
            to_treasury,
        )?;
    }

    // Accounting reduces the position/per-asset/USD counters by the FULL `amount`
    // that left the strategy (skim included): the skimmed yield is no longer
    // deployed, and is conservatively excluded from treasury NAV (it physically
    // left to the revenue wallet, so the next revalue prices the smaller idle
    // balance).
    record_strategy_withdrawal(
        &mut *ctx.accounts.treasury_vault,
        &mut *ctx.accounts.treasury_asset,
        &mut *ctx.accounts.strategy_position,
        amount,
        amount_usd,
        Clock::get()?.unix_timestamp,
    )?;

    if perf_fee > 0 {
        emit!(PerformanceFeeSkimmed {
            dao: dao_key,
            mint: ctx.accounts.mint.key(),
            withdrawn: amount,
            gain,
            fee: perf_fee,
        });
    }

    Ok(())
}

pub fn update_strategy_position_value_handler(
    ctx: Context<UpdateStrategyPositionValue>,
    protocol_id: String,
    new_value: u64,
) -> Result<()> {
    require!(
        !protocol_id.is_empty() && protocol_id.len() <= MAX_PROTOCOL_ID_LEN,
        NaveError::InvalidProtocolIdLength
    );
    require!(
        ctx.accounts.strategy_position.dao == ctx.accounts.dao_registry.key(),
        NaveError::Unauthorized
    );

    let signer = ctx.accounts.authority.key();
    let founder_ok = signer == ctx.accounts.dao_registry.founder;
    let operational = ctx.accounts.agent_set.get_agent(AgentRole::Operational);
    let operational_ok = signer == operational.authority && operational.is_operational();
    require!(founder_ok || operational_ok, NaveError::Unauthorized);

    let position = &mut ctx.accounts.strategy_position;
    let now = Clock::get()?.unix_timestamp;

    // Rate-limit manual marks: `current_value` is live input to the
    // per-protocol allocation cap (deposit path), the anti-drain withdrawal
    // floor, the realized-yield withdrawal cap, and the performance-fee
    // gain/principal split (see MAX_POSITION_MARK_STEP_BPS doc-comment) — it
    // is never reconciled by `revalue_treasury`, so an unbounded single call
    // could understate it to bypass the allocation cap or overstate it to
    // inflate the withdrawal/fee ceiling. Require a cooldown between marks so
    // the bounded step below also bounds total drift per unit time.
    if position.last_updated > 0 {
        require!(
            now.saturating_sub(position.last_updated) >= POSITION_MARK_COOLDOWN_SECS,
            NaveError::PositionMarkCooldownActive
        );
    }

    // Bound the step relative to the pre-update mark (or `deposited_amount` if
    // never marked) so one call can only move the value within
    // [base * (1 - step), base * (1 + step)].
    let base = if position.current_value > 0 {
        position.current_value
    } else {
        position.deposited_amount
    };
    // A position with neither a prior mark nor any deposited principal has no
    // base to bound against; a mark there would be arbitrary (it used to be
    // accepted unbounded). Require a real deposit to establish the base first.
    require!(base > 0, NaveError::PositionMarkNoBase);
    require!(
        crate::utils::position_mark_within_step(base, new_value, MAX_POSITION_MARK_STEP_BPS),
        NaveError::PositionMarkStepExceeded
    );

    // Mark the position's current value in the asset's base units. Portfolio USD
    // NAV is no longer derived from this single mark; `revalue_treasury` reprices
    // every asset + position via Pyth. This remains an off-chain hook to record a
    // receipt-token mark for a specific position between revalue ticks, now
    // bounded (step + cooldown) so it can't be used to game the caps above.
    position.current_value = new_value;
    position.last_updated = now;

    Ok(())
}

#[derive(Accounts)]
#[instruction(protocol_id: String)]
pub struct RecordStrategyDeposit<'info> {
    /// CHECK: Verified as nave_execution execution_authority PDA.
    pub execution_authority: AccountInfo<'info>,

    #[account(
        seeds = [DAO_REGISTRY_SEED, dao_registry.founder.as_ref(), &dao_registry.dao_id.to_le_bytes()],
        bump = dao_registry.bump
    )]
    pub dao_registry: Account<'info, DaoRegistry>,

    /// Asset mint funding this deployment; keys the per-asset accounts below.
    pub mint: Account<'info, Mint>,

    #[account(
        mut,
        seeds = [TREASURY_VAULT_SEED, dao_registry.key().as_ref()],
        bump = treasury_vault.bump,
        constraint = treasury_vault.dao == dao_registry.key() @ NaveError::Unauthorized
    )]
    pub treasury_vault: Account<'info, TreasuryVault>,

    #[account(
        mut,
        seeds = [TREASURY_ASSET_SEED, dao_registry.key().as_ref(), mint.key().as_ref()],
        bump = treasury_asset.bump,
        constraint = treasury_asset.dao == dao_registry.key() @ NaveError::Unauthorized,
        constraint = treasury_asset.mint == mint.key() @ NaveError::MintMismatch
    )]
    pub treasury_asset: Account<'info, TreasuryAsset>,

    #[account(
        mut,
        seeds = [STRATEGY_POSITION_SEED, dao_registry.key().as_ref(), protocol_id.as_bytes(), mint.key().as_ref()],
        bump = strategy_position.bump,
        constraint = strategy_position.dao == dao_registry.key() @ NaveError::Unauthorized,
        constraint = strategy_position.mint == mint.key() @ NaveError::MintMismatch
    )]
    pub strategy_position: Account<'info, StrategyPosition>,

    #[account(
        seeds = [VAULT_AUTHORITY_SEED, dao_registry.key().as_ref()],
        bump = vault_authority.bump,
        constraint = vault_authority.dao == dao_registry.key() @ NaveError::Unauthorized
    )]
    pub vault_authority: Account<'info, VaultAuthority>,

    #[account(
        mut,
        constraint = vault_token_account.key() == treasury_asset.token_account @ NaveError::InvalidVaultTokenAccount
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [STRATEGY_ESCROW_SEED, dao_registry.key().as_ref(), protocol_id.as_bytes(), mint.key().as_ref()],
        bump,
        constraint = strategy_escrow.owner == vault_authority.key() @ NaveError::Unauthorized
    )]
    pub strategy_escrow: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,

    /// CHECK: Instructions sysvar for CPI caller verification.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions: AccountInfo<'info>,
}

#[derive(Accounts)]
#[instruction(amount: u64, amount_usd: u64, protocol_id: String)]
pub struct RecordStrategyWithdrawal<'info> {
    /// CHECK: Verified as nave_execution execution_authority PDA.
    pub execution_authority: AccountInfo<'info>,

    #[account(
        seeds = [DAO_REGISTRY_SEED, dao_registry.founder.as_ref(), &dao_registry.dao_id.to_le_bytes()],
        bump = dao_registry.bump
    )]
    pub dao_registry: Account<'info, DaoRegistry>,

    /// Asset mint being unwound; keys the per-asset accounts below.
    pub mint: Account<'info, Mint>,

    #[account(
        mut,
        seeds = [TREASURY_VAULT_SEED, dao_registry.key().as_ref()],
        bump = treasury_vault.bump,
        constraint = treasury_vault.dao == dao_registry.key() @ NaveError::Unauthorized
    )]
    pub treasury_vault: Account<'info, TreasuryVault>,

    #[account(
        mut,
        seeds = [TREASURY_ASSET_SEED, dao_registry.key().as_ref(), mint.key().as_ref()],
        bump = treasury_asset.bump,
        constraint = treasury_asset.dao == dao_registry.key() @ NaveError::Unauthorized,
        constraint = treasury_asset.mint == mint.key() @ NaveError::MintMismatch
    )]
    pub treasury_asset: Account<'info, TreasuryAsset>,

    #[account(
        mut,
        seeds = [STRATEGY_POSITION_SEED, dao_registry.key().as_ref(), protocol_id.as_bytes(), mint.key().as_ref()],
        bump = strategy_position.bump,
        constraint = strategy_position.dao == dao_registry.key() @ NaveError::Unauthorized,
        constraint = strategy_position.mint == mint.key() @ NaveError::MintMismatch
    )]
    pub strategy_position: Account<'info, StrategyPosition>,

    #[account(
        seeds = [VAULT_AUTHORITY_SEED, dao_registry.key().as_ref()],
        bump = vault_authority.bump,
        constraint = vault_authority.dao == dao_registry.key() @ NaveError::Unauthorized
    )]
    pub vault_authority: Account<'info, VaultAuthority>,

    #[account(
        mut,
        constraint = vault_token_account.key() == treasury_asset.token_account @ NaveError::InvalidVaultTokenAccount
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [STRATEGY_ESCROW_SEED, dao_registry.key().as_ref(), protocol_id.as_bytes(), mint.key().as_ref()],
        bump,
        constraint = strategy_escrow.owner == vault_authority.key() @ NaveError::Unauthorized
    )]
    pub strategy_escrow: Account<'info, TokenAccount>,

    /// Fee configuration — supplies `performance_fee_bps` and the
    /// `protocol_revenue_wallet` skim destination.
    #[account(
        seeds = [FEE_CONFIG_SEED, dao_registry.key().as_ref()],
        bump = fee_config.bump,
        constraint = fee_config.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch
    )]
    pub fee_config: Account<'info, FeeConfig>,

    /// Destination for the performance-fee skim: a token account owned by the
    /// configured protocol revenue wallet, for the withdrawn mint.
    #[account(
        mut,
        constraint = revenue_token_account.owner == fee_config.protocol_revenue_wallet @ NaveError::InvalidFeeRecipient,
        constraint = revenue_token_account.mint == mint.key() @ NaveError::MintMismatch
    )]
    pub revenue_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,

    /// CHECK: Instructions sysvar for CPI caller verification.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions: AccountInfo<'info>,
}

#[derive(Accounts)]
#[instruction(protocol_id: String)]
pub struct UpdateStrategyPositionValue<'info> {
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
        constraint = agent_set.dao == dao_registry.key() @ NaveError::Unauthorized
    )]
    pub agent_set: Account<'info, AgentSet>,

    /// Asset mint of the position being marked; keys the position PDA.
    pub mint: Account<'info, Mint>,

    #[account(
        mut,
        seeds = [STRATEGY_POSITION_SEED, dao_registry.key().as_ref(), protocol_id.as_bytes(), mint.key().as_ref()],
        bump = strategy_position.bump,
        constraint = strategy_position.dao == dao_registry.key() @ NaveError::Unauthorized,
        constraint = strategy_position.mint == mint.key() @ NaveError::MintMismatch
    )]
    pub strategy_position: Account<'info, StrategyPosition>,
}
