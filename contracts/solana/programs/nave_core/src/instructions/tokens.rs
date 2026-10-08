use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, MintTo, SetAuthority, Token, TokenAccount};

use crate::constants::{
    GovernanceType, DAO_REGISTRY_SEED, GLOBAL_CONFIG_SEED, MAX_TOKEN_NAME_LEN, MAX_TOKEN_REGISTRY,
    MAX_TOKEN_SYMBOL_LEN, PROTOCOL_FEE_VAULT_SEED, TOKEN_MINT_FEE_LAMPORTS, TREASURY_VAULT_SEED,
    TOKEN_REGISTRY_SEED, TOKEN_REVOKE_REWARD_LAMPORTS, VAULT_AUTHORITY_SEED,
};
use crate::errors::NaveError;
use crate::state::{
    DaoRegistry, NaveGlobalConfig, ProtocolFeeVault, TokenRegistry, TokenSlot, TreasuryVault,
    VaultAuthority,
};
use crate::constants::nave_governance_program;
use crate::utils::{copy_fixed_bytes, require_founder, require_not_paused, verify_governance_caller};

pub fn register_dao_token_handler(
    ctx: Context<RegisterDaoToken>,
    name: String,
    symbol: String,
    decimals: u8,
    charge_mint_fee: bool,
    initial_supply: u64,
) -> Result<()> {
    require_not_paused(&ctx.accounts.global_config)?;
    require_founder(&ctx.accounts.authority.key(), &ctx.accounts.dao_registry)?;
    require!(
        ctx.accounts.token_registry.token_count < MAX_TOKEN_REGISTRY as u8,
        NaveError::TokenRegistryFull
    );

    let mint_key = ctx.accounts.mint.key();
    if ctx.accounts.token_registry.find_token_index(&mint_key).is_some() {
        return err!(NaveError::DuplicateTokenMint);
    }

    // Charge the 0.5 SOL token-mint fee from the DAO treasury (vault_authority PDA)
    // into the program-owned protocol fee vault. Both are program-owned, so lamports
    // are moved by direct arithmetic rather than a system transfer.
    if charge_mint_fee {
        let vault_ai = ctx.accounts.vault_authority.to_account_info();
        let fee_vault_ai = ctx.accounts.protocol_fee_vault.to_account_info();
        let rent = Rent::get()?;
        let min_balance = rent.minimum_balance(vault_ai.data_len());
        require!(
            vault_ai.lamports()
                >= min_balance
                    .checked_add(TOKEN_MINT_FEE_LAMPORTS)
                    .ok_or(NaveError::MathOverflow)?,
            NaveError::InsufficientVaultBalance
        );
        **vault_ai.try_borrow_mut_lamports()? = vault_ai
            .lamports()
            .checked_sub(TOKEN_MINT_FEE_LAMPORTS)
            .ok_or(NaveError::MathOverflow)?;
        **fee_vault_ai.try_borrow_mut_lamports()? = fee_vault_ai
            .lamports()
            .checked_add(TOKEN_MINT_FEE_LAMPORTS)
            .ok_or(NaveError::MathOverflow)?;

        let fee_vault = &mut ctx.accounts.protocol_fee_vault;
        fee_vault.total_collected = fee_vault
            .total_collected
            .checked_add(TOKEN_MINT_FEE_LAMPORTS)
            .ok_or(NaveError::MathOverflow)?;

        emit!(crate::events::TokenMintFeeCollected {
            dao: ctx.accounts.dao_registry.key(),
            mint: mint_key,
            amount: TOKEN_MINT_FEE_LAMPORTS,
        });
    }

    let token_registry = &mut ctx.accounts.token_registry;
    let idx = token_registry.token_count as usize;
    let slot = &mut token_registry.tokens[idx];
    slot.mint = mint_key;
    slot.authority_revoked = false;
    slot.decimals = decimals;
    copy_token_text(slot, name.as_bytes(), symbol.as_bytes())?;
    token_registry.token_count = token_registry.token_count.saturating_add(1);

    // Token-governed DAOs: bind the voting mint at registration time so
    // indexers and privacy checks reading `dao_registry.voting_token` stay
    // consistent with governance proposals (which also require registry membership).
    {
        let dao = &mut ctx.accounts.dao_registry;
        if dao.governance_type == GovernanceType::Token as u8
            && dao.voting_token == Pubkey::default()
        {
            dao.voting_token = mint_key;
            dao.updated_at = Clock::get()?.unix_timestamp;
        }
    }

    // Optional creation-time mint into the treasury vault ATA (new-token path).
    if initial_supply > 0 {
        require!(
            ctx.accounts.destination.mint == mint_key,
            NaveError::MintMismatch
        );
        require!(
            ctx.accounts.destination.owner == ctx.accounts.vault_authority.key(),
            NaveError::Unauthorized
        );
        let dao = &ctx.accounts.dao_registry;
        let dao_founder = dao.founder;
        let dao_id_bytes = dao.dao_id.to_le_bytes();
        let dao_bump = dao.bump;
        let seeds: &[&[u8]] = &[
            DAO_REGISTRY_SEED,
            dao_founder.as_ref(),
            &dao_id_bytes,
            &[dao_bump],
        ];
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.destination.to_account_info(),
                    authority: ctx.accounts.dao_registry.to_account_info(),
                },
                &[seeds],
            ),
            initial_supply,
        )?;
    }

    emit!(crate::events::DaoTokenRegistered {
        dao: ctx.accounts.dao_registry.key(),
        mint: mint_key,
    });

    Ok(())
}

pub fn revoke_token_authority_handler(ctx: Context<RevokeTokenAuthority>) -> Result<()> {
    require_not_paused(&ctx.accounts.global_config)?;
    require_founder(&ctx.accounts.authority.key(), &ctx.accounts.dao_registry)?;

    let idx = ctx
        .accounts
        .token_registry
        .find_token_index(&ctx.accounts.mint.key())
        .ok_or(NaveError::TokenNotFound)?;

    {
        let token_registry = &mut ctx.accounts.token_registry;
        require!(
            !token_registry.tokens[idx].authority_revoked,
            NaveError::AuthorityAlreadyRevoked
        );
        token_registry.tokens[idx].authority_revoked = true;
    }

    let dao = &ctx.accounts.dao_registry;
    let dao_founder = dao.founder;
    let dao_id_bytes = dao.dao_id.to_le_bytes();
    let dao_bump = dao.bump;
    let seeds: &[&[u8]] = &[
        DAO_REGISTRY_SEED,
        dao_founder.as_ref(),
        &dao_id_bytes,
        &[dao_bump],
    ];

    // Revoke mint authority.
    token::set_authority(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            SetAuthority {
                current_authority: ctx.accounts.dao_registry.to_account_info(),
                account_or_mint: ctx.accounts.mint.to_account_info(),
            },
            &[seeds],
        ),
        anchor_spl::token::spl_token::instruction::AuthorityType::MintTokens,
        None,
    )?;

    // Revoke freeze authority if the mint still has one set to the DAO.
    if ctx.accounts.mint.freeze_authority.is_some() {
        token::set_authority(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                SetAuthority {
                    current_authority: ctx.accounts.dao_registry.to_account_info(),
                    account_or_mint: ctx.accounts.mint.to_account_info(),
                },
                &[seeds],
            ),
            anchor_spl::token::spl_token::instruction::AuthorityType::FreezeAccount,
            None,
        )?;
    }

    emit!(crate::events::TokenAuthorityRevoked {
        dao: ctx.accounts.dao_registry.key(),
        mint: ctx.accounts.mint.key(),
    });

    // Reward the DAO treasury with 0.2 SOL from the protocol fee vault for revoking.
    let fee_vault_ai = ctx.accounts.protocol_fee_vault.to_account_info();
    let vault_ai = ctx.accounts.vault_authority.to_account_info();
    let rent = Rent::get()?;
    let fee_vault_min = rent.minimum_balance(fee_vault_ai.data_len());
    if fee_vault_ai.lamports()
        >= fee_vault_min
            .checked_add(TOKEN_REVOKE_REWARD_LAMPORTS)
            .ok_or(NaveError::MathOverflow)?
    {
        **fee_vault_ai.try_borrow_mut_lamports()? = fee_vault_ai
            .lamports()
            .checked_sub(TOKEN_REVOKE_REWARD_LAMPORTS)
            .ok_or(NaveError::MathOverflow)?;
        **vault_ai.try_borrow_mut_lamports()? = vault_ai
            .lamports()
            .checked_add(TOKEN_REVOKE_REWARD_LAMPORTS)
            .ok_or(NaveError::MathOverflow)?;

        let fee_vault = &mut ctx.accounts.protocol_fee_vault;
        fee_vault.total_rewarded = fee_vault
            .total_rewarded
            .checked_add(TOKEN_REVOKE_REWARD_LAMPORTS)
            .ok_or(NaveError::MathOverflow)?;

        emit!(crate::events::TokenRevokeRewarded {
            dao: ctx.accounts.dao_registry.key(),
            mint: ctx.accounts.mint.key(),
            amount: TOKEN_REVOKE_REWARD_LAMPORTS,
        });
    }

    Ok(())
}

pub fn update_token_metadata_handler(
    ctx: Context<UpdateTokenMetadata>,
    name: String,
    symbol: String,
) -> Result<()> {
    require_not_paused(&ctx.accounts.global_config)?;
    require_founder(&ctx.accounts.authority.key(), &ctx.accounts.dao_registry)?;

    let idx = ctx
        .accounts
        .token_registry
        .find_token_index(&ctx.accounts.mint.key())
        .ok_or(NaveError::TokenNotFound)?;

    let slot = &mut ctx.accounts.token_registry.tokens[idx];
    copy_token_text(slot, name.as_bytes(), symbol.as_bytes())?;

    emit!(crate::events::TokenMetadataUpdated {
        dao: ctx.accounts.dao_registry.key(),
        mint: ctx.accounts.mint.key(),
    });

    Ok(())
}

fn copy_token_text(slot: &mut TokenSlot, name: &[u8], symbol: &[u8]) -> Result<()> {
    require!(
        !name.is_empty() && name.len() <= MAX_TOKEN_NAME_LEN,
        NaveError::InvalidNameLength
    );
    require!(
        !symbol.is_empty() && symbol.len() <= MAX_TOKEN_SYMBOL_LEN,
        NaveError::InvalidNameLength
    );
    let name_len = copy_fixed_bytes(&mut slot.name, name)?;
    slot.name_len = name_len as u8;
    let symbol_len = copy_fixed_bytes(&mut slot.symbol, symbol)?;
    slot.symbol_len = symbol_len as u8;
    Ok(())
}

#[derive(Accounts)]
pub struct RegisterDaoToken<'info> {
    pub authority: Signer<'info>,

    #[account(seeds = [GLOBAL_CONFIG_SEED], bump = global_config.bump)]
    pub global_config: Account<'info, NaveGlobalConfig>,

    #[account(
        mut,
        seeds = [DAO_REGISTRY_SEED, dao_registry.founder.as_ref(), &dao_registry.dao_id.to_le_bytes()],
        bump = dao_registry.bump,
    )]
    pub dao_registry: Account<'info, DaoRegistry>,

    #[account(
        mut,
        seeds = [TOKEN_REGISTRY_SEED, dao_registry.key().as_ref()],
        bump = token_registry.bump,
        constraint = token_registry.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch
    )]
    pub token_registry: Account<'info, TokenRegistry>,

    #[account(
        mut,
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

    /// Vault ATA receiving optional `initial_supply` (must match `mint`).
    #[account(mut)]
    pub destination: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [PROTOCOL_FEE_VAULT_SEED],
        bump = protocol_fee_vault.bump
    )]
    pub protocol_fee_vault: Account<'info, ProtocolFeeVault>,

    pub mint: Account<'info, Mint>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct RevokeTokenAuthority<'info> {
    pub authority: Signer<'info>,

    #[account(seeds = [GLOBAL_CONFIG_SEED], bump = global_config.bump)]
    pub global_config: Account<'info, NaveGlobalConfig>,

    #[account(
        seeds = [DAO_REGISTRY_SEED, dao_registry.founder.as_ref(), &dao_registry.dao_id.to_le_bytes()],
        bump = dao_registry.bump,
    )]
    pub dao_registry: Account<'info, DaoRegistry>,

    #[account(
        mut,
        seeds = [TOKEN_REGISTRY_SEED, dao_registry.key().as_ref()],
        bump = token_registry.bump,
        constraint = token_registry.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch
    )]
    pub token_registry: Account<'info, TokenRegistry>,

    #[account(
        mut,
        seeds = [VAULT_AUTHORITY_SEED, dao_registry.key().as_ref()],
        bump = vault_authority.bump,
        constraint = vault_authority.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch
    )]
    pub vault_authority: Account<'info, VaultAuthority>,

    #[account(
        mut,
        seeds = [PROTOCOL_FEE_VAULT_SEED],
        bump = protocol_fee_vault.bump
    )]
    pub protocol_fee_vault: Account<'info, ProtocolFeeVault>,

    #[account(mut)]
    pub mint: Account<'info, Mint>,

    pub token_program: Program<'info, Token>,
}

/// PDA-signed governance-token mint, CPI-only from
/// `nave_governance::mint_additional_tokens` (verified via the instructions
/// sysvar, mirroring `switch_voting_system`). The DAO-registry PDA is the mint
/// authority and belongs to THIS program, so `nave_governance` cannot
/// `invoke_signed` for it — its old in-program `mint_to` always failed with
/// "Provided seeds do not result in a valid address" (latent defect surfaced by
/// the SEC-M3 tests). All authorization (founder signature, passed TokenMint
/// proposal binding, genesis latch) is enforced by the `nave_governance` caller
/// before this CPI; this handler re-checks only the structural invariants it
/// can see (registered token, mint authority not revoked, destination mint).
pub fn mint_dao_token_handler(ctx: Context<MintDaoToken>, amount: u64) -> Result<()> {
    require_not_paused(&ctx.accounts.global_config)?;
    verify_governance_caller(
        &nave_governance_program::ID,
        &ctx.accounts.instructions_sysvar.to_account_info(),
    )?;

    let idx = ctx
        .accounts
        .token_registry
        .find_token_index(&ctx.accounts.mint.key())
        .ok_or(NaveError::MintMismatch)?;
    require!(
        !ctx.accounts.token_registry.tokens[idx].authority_revoked,
        NaveError::AuthorityAlreadyRevoked
    );

    let dao = &ctx.accounts.dao_registry;
    let dao_founder = dao.founder;
    let dao_id_bytes = dao.dao_id.to_le_bytes();
    let dao_bump = dao.bump;
    let seeds: &[&[u8]] = &[
        DAO_REGISTRY_SEED,
        dao_founder.as_ref(),
        &dao_id_bytes,
        &[dao_bump],
    ];
    token::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.destination.to_account_info(),
                authority: ctx.accounts.dao_registry.to_account_info(),
            },
            &[seeds],
        ),
        amount,
    )?;

    Ok(())
}

#[derive(Accounts)]
pub struct MintDaoToken<'info> {
    /// CHECK: instructions sysvar for CPI caller verification (CPI-only from
    /// `nave_governance::mint_additional_tokens`).
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions_sysvar: AccountInfo<'info>,

    #[account(seeds = [GLOBAL_CONFIG_SEED], bump = global_config.bump)]
    pub global_config: Account<'info, NaveGlobalConfig>,

    #[account(
        seeds = [DAO_REGISTRY_SEED, dao_registry.founder.as_ref(), &dao_registry.dao_id.to_le_bytes()],
        bump = dao_registry.bump,
    )]
    pub dao_registry: Account<'info, DaoRegistry>,

    #[account(
        seeds = [TOKEN_REGISTRY_SEED, dao_registry.key().as_ref()],
        bump = token_registry.bump,
        constraint = token_registry.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch
    )]
    pub token_registry: Account<'info, TokenRegistry>,

    #[account(mut)]
    pub mint: Account<'info, Mint>,

    #[account(mut, constraint = destination.mint == mint.key() @ NaveError::MintMismatch)]
    pub destination: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct UpdateTokenMetadata<'info> {
    pub authority: Signer<'info>,

    #[account(seeds = [GLOBAL_CONFIG_SEED], bump = global_config.bump)]
    pub global_config: Account<'info, NaveGlobalConfig>,

    #[account(
        seeds = [DAO_REGISTRY_SEED, dao_registry.founder.as_ref(), &dao_registry.dao_id.to_le_bytes()],
        bump = dao_registry.bump,
    )]
    pub dao_registry: Account<'info, DaoRegistry>,

    #[account(
        mut,
        seeds = [TOKEN_REGISTRY_SEED, dao_registry.key().as_ref()],
        bump = token_registry.bump,
        constraint = token_registry.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch
    )]
    pub token_registry: Account<'info, TokenRegistry>,

    pub mint: Account<'info, Mint>,
}
