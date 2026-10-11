use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::constants::{
    jupiter_lending_program, kamino_lending_program, nave_execution_program,
    spl_stake_pool_program, AgentRole, AGENT_SET_SEED, DAO_REGISTRY_SEED,
    DEFAULT_PERFORMANCE_FEE_BPS, FEE_CONFIG_SEED, GLOBAL_CONFIG_SEED, MAX_PROTOCOL_ID_LEN,
    STRATEGY_ESCROW_SEED, STRATEGY_POSITION_SEED, TREASURY_ASSET_SEED, TREASURY_VAULT_SEED,
    VAULT_AUTHORITY_SEED,
};
use crate::errors::NaveError;
use crate::events::{PerformanceFeeSkimmed, PositionMarked};
use crate::state::{
    AgentSet, DaoRegistry, FeeConfig, NaveGlobalConfig, StrategyPosition, TreasuryAsset,
    TreasuryVault, VaultAuthority,
};
use crate::utils::{
    calculate_performance_skim, capped_mark, jupiter_ftoken_value, kamino_collateral_value,
    record_strategy_deposit, record_strategy_withdrawal, require_not_paused,
    stake_pool_token_value, transfer_escrow_to_account, transfer_escrow_to_vault,
    transfer_vault_to_escrow, verify_execution_authority,
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

    // ── Performance-fee skim (15% of realized yield, before treasury credit) ──
    // Always 1500 bps, including when the treasury is frozen or `FeeConfig`
    // still stores an older rate. Principal is never taxed; only the
    // proportional gain. The skim is in the withdrawn asset and is moved
    // straight from the strategy escrow to the protocol revenue wallet.
    let (gain, perf_fee) = calculate_performance_skim(
        amount,
        ctx.accounts.strategy_position.deposited_amount,
        ctx.accounts.strategy_position.current_value,
        DEFAULT_PERFORMANCE_FEE_BPS,
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

    // The remaining 85% of yield plus 100% of principal credits the treasury
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

    // Lazy correction: an older treasury that still stores 65/850 (or any
    // other pair) becomes 0/1500, normal and frozen, on this withdrawal.
    ctx.accounts.fee_config.sync_canonical_rates();

    Ok(())
}

/// Mark a position from on-chain state: escrowed principal plus the venue
/// receipt tokens valued at the venue's own exchange rate. The caller only
/// chooses WHEN to mark, never the value; upward moves are drift-capped.
pub fn update_strategy_position_value_handler(
    ctx: Context<UpdateStrategyPositionValue>,
    protocol_id: String,
) -> Result<()> {
    require_not_paused(&ctx.accounts.global_config)?;
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
    let operational_ok = signer == operational.authority
        && operational.is_operational()
        && ctx.accounts.agent_set.agents_enabled;
    require!(founder_ok || operational_ok, NaveError::Unauthorized);

    let observed = observe_position_value(&ctx, protocol_id.as_bytes())?;
    let now = Clock::get()?.unix_timestamp;
    let position = &mut ctx.accounts.strategy_position;
    let applied = capped_mark(
        position.current_value,
        position.deposited_amount,
        position.last_updated,
        now,
        observed,
    )?;
    position.current_value = applied;
    position.last_updated = now;

    emit!(PositionMarked {
        dao: position.dao,
        mint: position.mint,
        observed,
        applied,
    });
    Ok(())
}

fn receipt_token(
    info: &AccountInfo,
    expected_key: Option<&Pubkey>,
    owner: &Pubkey,
    mint: &Pubkey,
) -> Result<u64> {
    if let Some(k) = expected_key {
        require!(info.key() == *k, NaveError::PositionMarkSourceMismatch);
    }
    require!(
        info.owner == &anchor_spl::token::ID,
        NaveError::PositionMarkSourceMismatch
    );
    let data = info.try_borrow_data()?;
    let acct = TokenAccount::try_deserialize(&mut &data[..])
        .map_err(|_| error!(NaveError::PositionMarkSourceMismatch))?;
    require!(
        acct.owner == *owner && acct.mint == *mint,
        NaveError::PositionMarkSourceMismatch
    );
    Ok(acct.amount)
}

fn observe_position_value(
    ctx: &Context<UpdateStrategyPositionValue>,
    protocol_id: &[u8],
) -> Result<u64> {
    let sp = &ctx.accounts.strategy_position;
    let vault_authority = ctx.accounts.vault_authority.key();
    let venue = &ctx.accounts.venue_state;
    let receipt = &ctx.accounts.receipt_token_account;
    let escrowed = ctx.accounts.strategy_escrow.amount;

    // Venue deposits require a bound venue, so an unbound position holds
    // nothing outside its escrow.
    let unbound = sp.ext_market == Pubkey::default() && sp.ext_reserve == Pubkey::default();
    let in_venue = if unbound {
        0
    } else {
        match protocol_id {
            b"kamino" => {
                require!(
                    venue.key() == sp.ext_reserve && venue.owner == &kamino_lending_program::ID,
                    NaveError::PositionMarkSourceMismatch
                );
                let data = receipt.try_borrow_data()?;
                let collateral_mint = TokenAccount::try_deserialize(&mut &data[..])
                    .map_err(|_| error!(NaveError::PositionMarkSourceMismatch))?
                    .mint;
                drop(data);
                let c = receipt_token(
                    receipt,
                    Some(&sp.position_token_account),
                    &vault_authority,
                    &collateral_mint,
                )?;
                kamino_collateral_value(&venue.try_borrow_data()?, &sp.mint, &collateral_mint, c)?
            }
            b"jupiter" => {
                require!(
                    venue.key() == sp.ext_market && venue.owner == &jupiter_lending_program::ID,
                    NaveError::PositionMarkSourceMismatch
                );
                let lending = venue.try_borrow_data()?;
                let (_, f_token_mint) = jupiter_ftoken_value(&lending, &sp.mint, 0)?;
                let ata = anchor_spl::associated_token::get_associated_token_address(
                    &vault_authority,
                    &f_token_mint,
                );
                let f = receipt_token(receipt, Some(&ata), &vault_authority, &f_token_mint)?;
                jupiter_ftoken_value(&lending, &sp.mint, f)?.0
            }
            b"jito" => {
                require!(
                    venue.key() == sp.ext_market && venue.owner == &spl_stake_pool_program::ID,
                    NaveError::PositionMarkSourceMismatch
                );
                let data = receipt.try_borrow_data()?;
                let pool_mint = TokenAccount::try_deserialize(&mut &data[..])
                    .map_err(|_| error!(NaveError::PositionMarkSourceMismatch))?
                    .mint;
                drop(data);
                let t = receipt_token(
                    receipt,
                    Some(&sp.position_token_account),
                    &vault_authority,
                    &pool_mint,
                )?;
                stake_pool_token_value(&venue.try_borrow_data()?, &pool_mint, t)?
            }
            _ => return err!(NaveError::PositionMarkSourceMismatch),
        }
    };
    escrowed
        .checked_add(in_venue)
        .ok_or_else(|| error!(NaveError::MathOverflow))
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

    /// Fee configuration. The skim rate is the canonical 1500 bps, not the
    /// stored value; this account is writable so a stale rate is corrected.
    /// `protocol_revenue_wallet` is the skim destination.
    #[account(
        mut,
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

    #[account(
        seeds = [VAULT_AUTHORITY_SEED, dao_registry.key().as_ref()],
        bump = vault_authority.bump,
        constraint = vault_authority.dao == dao_registry.key() @ NaveError::Unauthorized
    )]
    pub vault_authority: Account<'info, VaultAuthority>,

    /// Escrowed principal not yet supplied to the venue.
    #[account(
        seeds = [STRATEGY_ESCROW_SEED, dao_registry.key().as_ref(), protocol_id.as_bytes(), mint.key().as_ref()],
        bump,
        constraint = strategy_escrow.owner == vault_authority.key() @ NaveError::Unauthorized
    )]
    pub strategy_escrow: Account<'info, TokenAccount>,

    /// CHECK: venue state (klend reserve / Jupiter lending / SPL stake pool);
    /// key, owner and embedded mints are verified in the handler.
    pub venue_state: UncheckedAccount<'info>,

    /// CHECK: vault-owned receipt token account; key, owner and mint verified
    /// in the handler.
    pub receipt_token_account: UncheckedAccount<'info>,
}
