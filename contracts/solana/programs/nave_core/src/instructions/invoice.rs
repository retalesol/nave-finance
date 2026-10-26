//! Per-invoice payment addresses.
//!
//! The vault PDA is `["invoice_vault", dao_registry, invoice_id]`. It is
//! program-owned, so the books product stores no hot key. Native SOL is paid
//! to the PDA. SPL is paid to the PDA's associated token account for that mint.
//!
//! `settle_invoice` / `settle_invoice_spl` are permissionless. They move the
//! full balance into the existing treasury custody and then call the same
//! credit helpers as `deposit_sol` / `deposit_to_asset`.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::constants::{
    ASSET_CONFIG_SEED, DAO_REGISTRY_SEED, INVOICE_VAULT_SEED, TREASURY_ASSET_SEED,
    TREASURY_VAULT_SEED, VAULT_AUTHORITY_SEED,
};
use crate::errors::NaveError;
use crate::events::InvoiceSettled;
use crate::instructions::assets::{credit_asset_deposit, credit_native_sol_deposit};
use crate::state::{
    AssetConfig, DaoRegistry, InvoiceVault, TreasuryAsset, TreasuryVault, VaultAuthority,
};

/// Native SOL has no mint on the invoice event. Same sentinel as a native
/// governance transfer (`Pubkey::default()`).
pub(crate) fn native_asset_id() -> Pubkey {
    Pubkey::default()
}

/// Lamports that can leave the invoice vault without dropping it below rent.
///
/// Returns `(invoice_after, vault_after, amount)`. `amount == 0` leaves both
/// balances unchanged so a second settle is a no-op.
pub(crate) fn settled_lamports(
    invoice_balance: u64,
    vault_balance: u64,
    rent_exempt_minimum: u64,
) -> Result<(u64, u64, u64)> {
    let amount = invoice_balance.saturating_sub(rent_exempt_minimum);
    if amount == 0 {
        return Ok((invoice_balance, vault_balance, 0));
    }
    let invoice_after = invoice_balance
        .checked_sub(amount)
        .ok_or(NaveError::MathOverflow)?;
    let vault_after = vault_balance
        .checked_add(amount)
        .ok_or(NaveError::MathOverflow)?;
    Ok((invoice_after, vault_after, amount))
}

/// `payer` is recorded only when that account signed this instruction.
/// Passing this program's id means the original payer is not available.
pub(crate) fn resolve_payer(
    payer: &Pubkey,
    is_signer: bool,
    program_id: &Pubkey,
) -> Result<Pubkey> {
    if payer == program_id {
        return Ok(Pubkey::default());
    }
    require!(is_signer, NaveError::Unauthorized);
    Ok(*payer)
}

pub fn init_invoice_vault_handler(
    ctx: Context<InitInvoiceVault>,
    invoice_id: [u8; 32],
) -> Result<()> {
    let vault = &mut ctx.accounts.invoice_vault;
    vault.bump = ctx.bumps.invoice_vault;
    vault.dao = ctx.accounts.dao_registry.key();
    vault.invoice_id = invoice_id;
    Ok(())
}

pub fn init_invoice_token_account_handler(
    _ctx: Context<InitInvoiceTokenAccount>,
    _invoice_id: [u8; 32],
) -> Result<()> {
    Ok(())
}

pub fn settle_invoice_handler(ctx: Context<SettleInvoice>, invoice_id: [u8; 32]) -> Result<()> {
    let payer = resolve_payer(
        &ctx.accounts.payer.key(),
        ctx.accounts.payer.is_signer,
        &crate::ID,
    )?;
    let dao = ctx.accounts.dao_registry.key();

    let invoice_ai = ctx.accounts.invoice_vault.to_account_info();
    let vault_ai = ctx.accounts.vault_authority.to_account_info();
    let rent_exempt = Rent::get()?.minimum_balance(invoice_ai.data_len());
    let (invoice_after, vault_after, amount) =
        settled_lamports(invoice_ai.lamports(), vault_ai.lamports(), rent_exempt)?;
    if amount == 0 {
        return Ok(());
    }

    // Both accounts are program-owned. A system transfer from the invoice
    // vault fails at runtime; move lamports directly, then apply the same NAV
    // credit `deposit_sol` writes after its system transfer.
    **invoice_ai.try_borrow_mut_lamports()? = invoice_after;
    **vault_ai.try_borrow_mut_lamports()? = vault_after;
    credit_native_sol_deposit(&mut ctx.accounts.treasury_vault);

    emit!(InvoiceSettled {
        dao,
        invoice_id,
        asset: native_asset_id(),
        amount,
        payer,
    });
    Ok(())
}

pub fn settle_invoice_spl_handler(
    ctx: Context<SettleInvoiceSpl>,
    invoice_id: [u8; 32],
) -> Result<()> {
    let payer = resolve_payer(
        &ctx.accounts.payer.key(),
        ctx.accounts.payer.is_signer,
        &crate::ID,
    )?;
    let amount = ctx.accounts.invoice_token_account.amount;
    if amount == 0 {
        return Ok(());
    }
    require!(
        ctx.accounts.asset_config.enabled,
        NaveError::AssetNotEnabled
    );
    require!(
        ctx.accounts.invoice_token_account.key() != ctx.accounts.asset_vault.key(),
        NaveError::InvalidVaultTokenAccount
    );

    let dao_key = ctx.accounts.dao_registry.key();
    let stored_invoice_id = ctx.accounts.invoice_vault.invoice_id;
    let bump = ctx.accounts.invoice_vault.bump;
    let mint = ctx.accounts.mint.key();
    let bump_seed = [bump];
    let seeds = &[
        INVOICE_VAULT_SEED,
        dao_key.as_ref(),
        stored_invoice_id.as_ref(),
        &bump_seed[..],
    ];
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.invoice_token_account.to_account_info(),
                to: ctx.accounts.asset_vault.to_account_info(),
                authority: ctx.accounts.invoice_vault.to_account_info(),
            },
            &[&seeds[..]],
        ),
        amount,
    )?;

    credit_asset_deposit(&mut ctx.accounts.treasury_asset, amount)?;

    emit!(InvoiceSettled {
        dao: dao_key,
        invoice_id,
        asset: mint,
        amount,
        payer,
    });
    Ok(())
}

#[derive(Accounts)]
#[instruction(invoice_id: [u8; 32])]
pub struct InitInvoiceVault<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        seeds = [DAO_REGISTRY_SEED, dao_registry.founder.as_ref(), &dao_registry.dao_id.to_le_bytes()],
        bump = dao_registry.bump
    )]
    pub dao_registry: Account<'info, DaoRegistry>,

    #[account(
        init,
        payer = payer,
        space = InvoiceVault::LEN,
        seeds = [INVOICE_VAULT_SEED, dao_registry.key().as_ref(), invoice_id.as_ref()],
        bump
    )]
    pub invoice_vault: Account<'info, InvoiceVault>,

    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
#[instruction(invoice_id: [u8; 32])]
pub struct InitInvoiceTokenAccount<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        seeds = [DAO_REGISTRY_SEED, dao_registry.founder.as_ref(), &dao_registry.dao_id.to_le_bytes()],
        bump = dao_registry.bump
    )]
    pub dao_registry: Account<'info, DaoRegistry>,

    #[account(
        seeds = [INVOICE_VAULT_SEED, dao_registry.key().as_ref(), invoice_id.as_ref()],
        bump = invoice_vault.bump,
        constraint = invoice_vault.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch,
        constraint = invoice_vault.invoice_id == invoice_id @ NaveError::InvoiceVaultMismatch
    )]
    pub invoice_vault: Account<'info, InvoiceVault>,

    pub mint: Account<'info, Mint>,

    #[account(
        seeds = [ASSET_CONFIG_SEED, dao_registry.key().as_ref(), mint.key().as_ref()],
        bump = asset_config.bump,
        constraint = asset_config.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch,
        constraint = asset_config.mint == mint.key() @ NaveError::MintMismatch,
        constraint = asset_config.enabled @ NaveError::AssetNotEnabled
    )]
    pub asset_config: Account<'info, AssetConfig>,

    #[account(
        init,
        payer = payer,
        associated_token::mint = mint,
        associated_token::authority = invoice_vault,
        associated_token::token_program = token_program
    )]
    pub invoice_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(invoice_id: [u8; 32])]
pub struct SettleInvoice<'info> {
    #[account(
        seeds = [DAO_REGISTRY_SEED, dao_registry.founder.as_ref(), &dao_registry.dao_id.to_le_bytes()],
        bump = dao_registry.bump
    )]
    pub dao_registry: Account<'info, DaoRegistry>,

    #[account(
        mut,
        seeds = [INVOICE_VAULT_SEED, dao_registry.key().as_ref(), invoice_id.as_ref()],
        bump = invoice_vault.bump,
        constraint = invoice_vault.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch,
        constraint = invoice_vault.invoice_id == invoice_id @ NaveError::InvoiceVaultMismatch
    )]
    pub invoice_vault: Account<'info, InvoiceVault>,

    #[account(
        mut,
        seeds = [VAULT_AUTHORITY_SEED, dao_registry.key().as_ref()],
        bump = vault_authority.bump,
        constraint = vault_authority.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch
    )]
    pub vault_authority: Account<'info, VaultAuthority>,

    /// Same account `deposit_sol` mutates to clear `last_revalued_at`.
    #[account(
        mut,
        seeds = [TREASURY_VAULT_SEED, dao_registry.key().as_ref()],
        bump = treasury_vault.bump,
        constraint = treasury_vault.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch
    )]
    pub treasury_vault: Account<'info, TreasuryVault>,

    /// CHECK: the original payer when they co-sign this settle. Pass this
    /// program's id when the payer is not in the transaction. Any other
    /// non-signer is rejected.
    pub payer: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(invoice_id: [u8; 32])]
pub struct SettleInvoiceSpl<'info> {
    #[account(
        seeds = [DAO_REGISTRY_SEED, dao_registry.founder.as_ref(), &dao_registry.dao_id.to_le_bytes()],
        bump = dao_registry.bump
    )]
    pub dao_registry: Account<'info, DaoRegistry>,

    #[account(
        seeds = [INVOICE_VAULT_SEED, dao_registry.key().as_ref(), invoice_id.as_ref()],
        bump = invoice_vault.bump,
        constraint = invoice_vault.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch,
        constraint = invoice_vault.invoice_id == invoice_id @ NaveError::InvoiceVaultMismatch
    )]
    pub invoice_vault: Account<'info, InvoiceVault>,

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
        associated_token::mint = mint,
        associated_token::authority = invoice_vault,
        associated_token::token_program = token_program
    )]
    pub invoice_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,

    /// CHECK: the original payer when they co-sign this settle. Pass this
    /// program's id when the payer is not in the transaction. Any other
    /// non-signer is rejected.
    pub payer: UncheckedAccount<'info>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::INVOICE_VAULT_SEED;
    use crate::instructions::assets::{credit_asset_deposit, credit_native_sol_deposit};
    use crate::state::{InvoiceVault, TreasuryAsset, TreasuryVault};

    fn vault_with_nav_stamp() -> TreasuryVault {
        TreasuryVault {
            bump: 1,
            dao: Pubkey::new_unique(),
            vault_token_account: Pubkey::new_unique(),
            total_deposited: 50,
            total_withdrawn: 0,
            current_nav: 50,
            high_water_mark: 50,
            last_management_fee_at: 0,
            last_performance_fee_at: 0,
            deployed_capital: 0,
            asset_count: 1,
            last_revalued_at: 1_700_000_000,
        }
    }

    fn asset_with_principal(deposited: u64) -> TreasuryAsset {
        TreasuryAsset {
            bump: 1,
            dao: Pubkey::new_unique(),
            mint: Pubkey::new_unique(),
            token_account: Pubkey::new_unique(),
            deposited,
            deployed_capital: 0,
            last_valued_usd: 0,
            last_valued_at: 0,
            last_management_fee_at: 0,
        }
    }

    #[test]
    fn invoice_vault_len_matches_its_fields() {
        assert_eq!(InvoiceVault::LEN, 8 + 1 + 32 + 32);
        assert_eq!(INVOICE_VAULT_SEED, b"invoice_vault");
    }

    #[test]
    fn invoice_vault_pda_is_invoice_vault_dao_and_invoice_id() {
        let dao = Pubkey::new_unique();
        let other_dao = Pubkey::new_unique();
        let invoice_a = [1u8; 32];
        let invoice_b = [2u8; 32];
        let (a, bump_a) = Pubkey::find_program_address(
            &[INVOICE_VAULT_SEED, dao.as_ref(), invoice_a.as_ref()],
            &crate::ID,
        );
        let (a_again, bump_again) =
            Pubkey::find_program_address(&[b"invoice_vault", dao.as_ref(), &invoice_a], &crate::ID);
        let (b, _) = Pubkey::find_program_address(
            &[INVOICE_VAULT_SEED, dao.as_ref(), invoice_b.as_ref()],
            &crate::ID,
        );
        let (c, _) = Pubkey::find_program_address(
            &[INVOICE_VAULT_SEED, other_dao.as_ref(), invoice_a.as_ref()],
            &crate::ID,
        );
        assert_eq!(a, a_again);
        assert_eq!(bump_a, bump_again);
        assert_ne!(a, b);
        assert_ne!(a, c);
        assert_ne!(a, dao);
    }

    #[test]
    fn native_sol_asset_identifier_is_the_default_pubkey() {
        assert_eq!(native_asset_id(), Pubkey::default());
    }

    #[test]
    fn sol_settle_moves_only_lamports_above_rent_onto_the_vault() {
        let (invoice, vault, amount) = settled_lamports(1_500, 10_000, 890).unwrap();
        assert_eq!(amount, 610);
        assert_eq!(invoice, 890);
        assert_eq!(vault, 10_610);
    }

    #[test]
    fn sol_settle_at_or_below_rent_is_a_noop() {
        let (invoice, vault, amount) = settled_lamports(890, 10, 890).unwrap();
        assert_eq!((invoice, vault, amount), (890, 10, 0));
        let (invoice, vault, amount) = settled_lamports(100, 10, 890).unwrap();
        assert_eq!((invoice, vault, amount), (100, 10, 0));
    }

    #[test]
    fn sol_settle_rejects_a_vault_balance_overflow() {
        assert!(settled_lamports(1_000, u64::MAX, 0).is_err());
    }

    #[test]
    fn native_sol_credit_only_resets_nav_staleness() {
        let mut vault = vault_with_nav_stamp();
        credit_native_sol_deposit(&mut vault);
        assert_eq!(vault.last_revalued_at, 0);
        assert_eq!(vault.current_nav, 50);
        assert_eq!(vault.total_deposited, 50);
    }

    #[test]
    fn spl_credit_increments_the_deposited_counter() {
        let mut asset = asset_with_principal(10);
        credit_asset_deposit(&mut asset, 5).unwrap();
        assert_eq!(asset.deposited, 15);
        assert!(credit_asset_deposit(&mut asset, 0).is_err());
        asset.deposited = u64::MAX;
        assert!(credit_asset_deposit(&mut asset, 1).is_err());
    }

    #[test]
    fn payer_is_recorded_only_when_they_sign() {
        let program_id = crate::ID;
        let wallet = Pubkey::new_unique();
        assert_eq!(
            resolve_payer(&program_id, false, &program_id).unwrap(),
            Pubkey::default()
        );
        assert_eq!(resolve_payer(&wallet, true, &program_id).unwrap(), wallet);
        assert!(resolve_payer(&wallet, false, &program_id).is_err());
        assert!(resolve_payer(&Pubkey::default(), false, &program_id).is_err());
    }
}
