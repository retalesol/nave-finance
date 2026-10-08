use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};

use nave_core::{
    state::{DaoRegistry, StrategyPosition, TreasuryVault, VaultAuthority},
    utils::verify_execution_authority,
};

#[error_code]
pub enum AdapterError {
    #[msg("Unauthorized caller")]
    UnauthorizedCaller,
    #[msg("Protocol not approved")]
    ProtocolNotApproved,
    #[msg("Invalid amount")]
    InvalidAmount,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Insufficient balance")]
    InsufficientBalance,
    #[msg("Invalid vault token account")]
    InvalidVaultAccount,
    #[msg("Invalid strategy escrow account")]
    InvalidEscrowAccount,
}

pub fn handle_strategy_deposit<'info>(
    execution_authority: &AccountInfo<'info>,
    dao_registry: &Account<'info, DaoRegistry>,
    vault_authority: &Account<'info, VaultAuthority>,
    treasury_vault: &mut Account<'info, TreasuryVault>,
    vault_token_account: &Account<'info, TokenAccount>,
    strategy_escrow: &Account<'info, TokenAccount>,
    _strategy_position: &mut Account<'info, StrategyPosition>,
    token_program: &Program<'info, Token>,
    execution_program_id: &Pubkey,
    _protocol_id: &[u8],
    amount: u64,
    instructions_sysvar: Option<&AccountInfo<'info>>,
) -> Result<()> {
    verify_execution_authority(
        execution_authority,
        &dao_registry.key(),
        execution_program_id,
        instructions_sysvar,
    )?;
    require!(amount > 0, AdapterError::InvalidAmount);
    let _ = treasury_vault;

    // Multi-asset: caps + USD liquidity floors are enforced authoritatively in
    // nave_execution against the live Pyth-valued NAV. Here we only confirm the
    // per-asset holding account actually holds enough base units to deploy.
    require!(
        vault_token_account.amount >= amount,
        AdapterError::InsufficientBalance
    );
    require!(
        strategy_escrow.owner == vault_authority.key(),
        AdapterError::InvalidEscrowAccount
    );
    require!(
        strategy_escrow.mint == vault_token_account.mint,
        AdapterError::InvalidEscrowAccount
    );
    // The escrow is a dedicated per-protocol PDA token account; it must never be
    // the vault ATA itself, otherwise the transfer would be a self-move no-op
    // and capital would never actually leave the vault. (AD-1/AD-2)
    require!(
        strategy_escrow.key() != vault_token_account.key(),
        AdapterError::InvalidEscrowAccount
    );

    // The actual vault -> escrow SPL transfer is performed by nave_core in
    // record_strategy_deposit, which can sign for the vault_authority PDA. This
    // adapter only validates the deposit; a program cannot sign for another
    // program's PDA, so the escrow movement must live in nave_core.
    let _ = token_program;

    Ok(())
}

pub fn handle_strategy_withdraw<'info>(
    execution_authority: &AccountInfo<'info>,
    dao_registry: &Account<'info, DaoRegistry>,
    vault_authority: &Account<'info, VaultAuthority>,
    _treasury_vault: &mut Account<'info, TreasuryVault>,
    vault_token_account: &Account<'info, TokenAccount>,
    strategy_escrow: &Account<'info, TokenAccount>,
    strategy_position: &mut Account<'info, StrategyPosition>,
    token_program: &Program<'info, Token>,
    execution_program_id: &Pubkey,
    amount: u64,
    instructions_sysvar: Option<&AccountInfo<'info>>,
) -> Result<()> {
    verify_execution_authority(
        execution_authority,
        &dao_registry.key(),
        execution_program_id,
        instructions_sysvar,
    )?;
    require!(amount > 0, AdapterError::InvalidAmount);
    require!(
        strategy_position.dao == dao_registry.key(),
        AdapterError::UnauthorizedCaller
    );
    // Withdraw-side validations symmetric with deposit (AD-9/AD-10): the escrow
    // must be a distinct vault_authority-owned account of the same mint as the
    // per-asset holding account (which the caller binds to treasury_asset).
    let _ = _treasury_vault;
    require!(
        strategy_escrow.owner == vault_authority.key(),
        AdapterError::InvalidEscrowAccount
    );
    require!(
        strategy_escrow.mint == vault_token_account.mint,
        AdapterError::InvalidEscrowAccount
    );
    require!(
        strategy_escrow.key() != vault_token_account.key(),
        AdapterError::InvalidEscrowAccount
    );
    require!(
        strategy_escrow.amount >= amount,
        AdapterError::InsufficientBalance
    );

    // The escrow -> vault SPL transfer is performed by nave_core in
    // record_strategy_withdrawal (vault_authority PDA signer). Adapter validates only.
    let _ = token_program;

    Ok(())
}
