mod adapter_common;

use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use nave_core::{
    constants::{nave_execution_program, DAO_REGISTRY_SEED, STRATEGY_POSITION_SEED, TREASURY_VAULT_SEED, VAULT_AUTHORITY_SEED},
    state::{DaoRegistry, StrategyPosition, TreasuryVault, VaultAuthority},
    ID as NAVE_CORE_ID,
};

use adapter_common::{handle_strategy_deposit, handle_strategy_withdraw, AdapterError};

declare_id!("Gavh8GezswR14BYC851r6vevk267iWDfBkC3Fo49b1q7");

pub const MARGINFI_PROTOCOL_ID: &[u8] = b"marginfi";

#[event]
pub struct MarginfiDepositEvent {
    pub dao: Pubkey,
    pub amount: u64,
}

#[event]
pub struct MarginfiWithdrawEvent {
    pub dao: Pubkey,
    pub amount: u64,
}

#[program]
pub mod nave_marginfi_adapter {
    use super::*;

    pub fn deposit_to_marginfi(ctx: Context<DepositToMarginfi>, amount: u64) -> Result<()> {
        let dao_key = ctx.accounts.dao_registry.key();
        handle_strategy_deposit(
            &ctx.accounts.execution_authority,
            &ctx.accounts.dao_registry,
            &ctx.accounts.vault_authority,
            &mut ctx.accounts.treasury_vault,
            &ctx.accounts.vault_token_account,
            &ctx.accounts.strategy_escrow,
            &mut ctx.accounts.strategy_position,
            &ctx.accounts.token_program,
            &nave_execution_program::ID,
            MARGINFI_PROTOCOL_ID,
            amount,
            Some(&ctx.accounts.instructions.to_account_info()),
        )?;
        emit!(MarginfiDepositEvent { dao: dao_key, amount });
        Ok(())
    }

    pub fn withdraw_from_marginfi(ctx: Context<WithdrawFromMarginfi>, amount: u64) -> Result<()> {
        let dao_key = ctx.accounts.dao_registry.key();
        handle_strategy_withdraw(
            &ctx.accounts.execution_authority,
            &ctx.accounts.dao_registry,
            &ctx.accounts.vault_authority,
            &mut ctx.accounts.treasury_vault,
            &ctx.accounts.vault_token_account,
            &ctx.accounts.strategy_escrow,
            &mut ctx.accounts.strategy_position,
            &ctx.accounts.token_program,
            &nave_execution_program::ID,
            amount,
            Some(&ctx.accounts.instructions.to_account_info()),
        )?;
        emit!(MarginfiWithdrawEvent { dao: dao_key, amount });
        Ok(())
    }
}

#[derive(Accounts)]
pub struct DepositToMarginfi<'info> {
    /// CHECK: Verified as nave_execution execution_authority PDA signer.
    pub execution_authority: AccountInfo<'info>,

    #[account(
        seeds = [DAO_REGISTRY_SEED, dao_registry.founder.as_ref(), &dao_registry.dao_id.to_le_bytes()],
        bump = dao_registry.bump,
        seeds::program = NAVE_CORE_ID,
    )]
    pub dao_registry: Box<Account<'info, DaoRegistry>>,

    #[account(
        seeds = [VAULT_AUTHORITY_SEED, dao_registry.key().as_ref()],
        bump = vault_authority.bump,
        seeds::program = NAVE_CORE_ID,
    )]
    pub vault_authority: Box<Account<'info, VaultAuthority>>,

    #[account(
        mut,
        seeds = [TREASURY_VAULT_SEED, dao_registry.key().as_ref()],
        bump = treasury_vault.bump,
        seeds::program = NAVE_CORE_ID,
        constraint = treasury_vault.dao == dao_registry.key() @ AdapterError::UnauthorizedCaller
    )]
    pub treasury_vault: Box<Account<'info, TreasuryVault>>,

    #[account(
        mut,
        constraint = vault_token_account.mint == mint.key() @ AdapterError::InvalidVaultAccount
    )]
    pub vault_token_account: Box<Account<'info, TokenAccount>>,

    /// Asset mint deployed; keys the per-(protocol, mint) escrow + position.
    pub mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        seeds = [nave_core::constants::STRATEGY_ESCROW_SEED, dao_registry.key().as_ref(), MARGINFI_PROTOCOL_ID, mint.key().as_ref()],
        bump,
        seeds::program = NAVE_CORE_ID,
    )]
    pub strategy_escrow: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [STRATEGY_POSITION_SEED, dao_registry.key().as_ref(), MARGINFI_PROTOCOL_ID, mint.key().as_ref()],
        bump = strategy_position.bump,
        seeds::program = NAVE_CORE_ID,
    )]
    pub strategy_position: Box<Account<'info, StrategyPosition>>,

    /// CHECK: Optional payer when invoked directly; unused during execution CPI.
    pub payer: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,

    /// CHECK: Instructions sysvar for CPI caller verification.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct WithdrawFromMarginfi<'info> {
    /// CHECK: Verified as nave_execution execution_authority PDA signer.
    pub execution_authority: AccountInfo<'info>,

    #[account(
        seeds = [DAO_REGISTRY_SEED, dao_registry.founder.as_ref(), &dao_registry.dao_id.to_le_bytes()],
        bump = dao_registry.bump,
        seeds::program = NAVE_CORE_ID,
    )]
    pub dao_registry: Box<Account<'info, DaoRegistry>>,

    #[account(
        seeds = [VAULT_AUTHORITY_SEED, dao_registry.key().as_ref()],
        bump = vault_authority.bump,
        seeds::program = NAVE_CORE_ID,
    )]
    pub vault_authority: Box<Account<'info, VaultAuthority>>,

    #[account(
        mut,
        seeds = [TREASURY_VAULT_SEED, dao_registry.key().as_ref()],
        bump = treasury_vault.bump,
        seeds::program = NAVE_CORE_ID,
        constraint = treasury_vault.dao == dao_registry.key() @ AdapterError::UnauthorizedCaller
    )]
    pub treasury_vault: Box<Account<'info, TreasuryVault>>,

    #[account(
        mut,
        constraint = vault_token_account.mint == mint.key() @ AdapterError::InvalidVaultAccount
    )]
    pub vault_token_account: Box<Account<'info, TokenAccount>>,

    /// Asset mint withdrawn; keys the per-(protocol, mint) escrow + position.
    pub mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        seeds = [nave_core::constants::STRATEGY_ESCROW_SEED, dao_registry.key().as_ref(), MARGINFI_PROTOCOL_ID, mint.key().as_ref()],
        bump,
        seeds::program = NAVE_CORE_ID,
    )]
    pub strategy_escrow: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [STRATEGY_POSITION_SEED, dao_registry.key().as_ref(), MARGINFI_PROTOCOL_ID, mint.key().as_ref()],
        bump = strategy_position.bump,
        seeds::program = NAVE_CORE_ID,
    )]
    pub strategy_position: Box<Account<'info, StrategyPosition>>,

    pub token_program: Program<'info, Token>,

    /// CHECK: Instructions sysvar for CPI caller verification.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions: AccountInfo<'info>,
}
