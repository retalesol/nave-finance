//! CPI entrypoints for disbursing treasury funds after a passed
//! `ProposalType::Transfer` governance vote. Invoked exclusively from
//! `nave_governance::execute_treasury_transfer_*` (verified via the instructions
//! sysvar). Binds `sha256(recipient ‖ mint ‖ amount_le_u64)` to the proposal's
//! stored `payload_hash` (same preimage the app uses for `create_proposal`).
//!
//! Both transfer handlers invalidate `TreasuryVault.last_revalued_at` (set to
//! 0) after a successful outbound transfer so that `nav_fresh_enough` returns
//! false until `revalue_treasury` is called. This prevents agent deploy/strategy
//! flows from using a stale (inflated) NAV to exceed USD allocation caps in the
//! window between the transfer and the next revaluation.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::solana_program::system_instruction;
use anchor_spl::token::{Mint, Token, TokenAccount};
use sha2::{Digest, Sha256};

use crate::constants::{
    nave_governance_program, ASSET_CONFIG_SEED, ASSET_VAULT_SEED, DAO_REGISTRY_SEED,
    GLOBAL_CONFIG_SEED, NFT_VAULT_RECORD_SEED, NFT_VAULT_SEED, TREASURY_ASSET_SEED,
    TREASURY_VAULT_SEED, VAULT_AUTHORITY_SEED,
};
use crate::errors::NaveError;
use crate::events::GovernanceTransferExecuted;
use crate::state::{
    AssetConfig, DaoRegistry, GovernanceProposalLayout, NaveGlobalConfig, NftVaultRecord,
    TreasuryAsset, TreasuryVault, VaultAuthority,
};
use crate::utils::{require_dao_active, require_not_paused, transfer_escrow_to_account, verify_governance_caller};

/// `nave_governance::constants::ProposalType::Transfer`
const PROPOSAL_TYPE_TRANSFER: u8 = 8;
/// `nave_governance::constants::ProposalStatus::Passed`
const PROPOSAL_STATUS_PASSED: u8 = 1;

const TRANSFER_PAYLOAD_LEN: usize = 32 + 32 + 8;

fn hash_transfer_payload(slice: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(slice);
    hasher.finalize().into()
}

fn load_and_validate_proposal(
    proposal_ai: &AccountInfo,
    dao: &Pubkey,
) -> Result<GovernanceProposalLayout> {
    require!(
        *proposal_ai.owner == nave_governance_program::ID,
        NaveError::InvalidGovernanceProposal
    );
    let data = proposal_ai.try_borrow_data()?;
    let prop = GovernanceProposalLayout::try_deserialize_skip_discriminator(&data)?;
    require!(prop.dao == *dao, NaveError::DaoOwnershipMismatch);
    require!(
        prop.proposal_type == PROPOSAL_TYPE_TRANSFER,
        NaveError::TransferProposalPayloadInvalid
    );
    require!(
        prop.status == PROPOSAL_STATUS_PASSED,
        NaveError::TransferProposalPayloadInvalid
    );
    require!(prop.finalized_at > 0, NaveError::TransferProposalPayloadInvalid);
    Ok(prop)
}

fn parse_transfer_payload(prop: &GovernanceProposalLayout) -> Result<(Pubkey, Pubkey, u64)> {
    let plen = prop.payload_len as usize;
    require!(
        plen == TRANSFER_PAYLOAD_LEN,
        NaveError::TransferProposalPayloadInvalid
    );
    let slice = &prop.payload[..plen];
    let recipient = Pubkey::new_from_array(slice[0..32].try_into().unwrap());
    let mint = Pubkey::new_from_array(slice[32..64].try_into().unwrap());
    let amount = u64::from_le_bytes(slice[64..72].try_into().unwrap());
    require!(recipient != Pubkey::default(), NaveError::TransferProposalPayloadInvalid);
    require!(amount > 0, NaveError::TransferProposalPayloadInvalid);
    require!(
        hash_transfer_payload(slice) == prop.payload_hash,
        NaveError::GovernanceProposalPayloadMismatch
    );
    Ok((recipient, mint, amount))
}

pub fn execute_governance_transfer_native_sol_handler(
    ctx: Context<ExecuteGovernanceTransferNativeSol>,
) -> Result<()> {
    verify_governance_caller(
        &nave_governance_program::ID,
        &ctx.accounts.instructions_sysvar.to_account_info(),
    )?;
    require_not_paused(&ctx.accounts.global_config)?;
    require_dao_active(&ctx.accounts.dao_registry)?;
    require!(!ctx.accounts.dao_registry.frozen, NaveError::DaoFrozen);

    let prop = load_and_validate_proposal(
        &ctx.accounts.proposal.to_account_info(),
        &ctx.accounts.dao_registry.key(),
    )?;
    let (recipient, mint, amount) = parse_transfer_payload(&prop)?;
    require!(mint == Pubkey::default(), NaveError::TransferProposalPayloadInvalid);
    // SOL-C1: `recipient` above is decoded from the proposal's bound payload;
    // without also binding it to the actual `recipient` account being paid,
    // a malicious executor could pass a different (unapproved) recipient
    // account while still satisfying every other check (mint/amount only).
    require!(
        recipient == ctx.accounts.recipient.key(),
        NaveError::RecipientMismatch
    );

    let dao_key = ctx.accounts.dao_registry.key();
    let rent = Rent::get()?;
    let min_va = rent.minimum_balance(ctx.accounts.vault_authority.to_account_info().data_len());

    let va_ai = ctx.accounts.vault_authority.to_account_info();
    let recipient_ai = ctx.accounts.recipient.to_account_info();
    let va_lamports = va_ai.lamports();
    require!(
        va_lamports
            .checked_sub(amount)
            .ok_or(NaveError::InsufficientVaultBalance)?
            >= min_va,
        NaveError::InsufficientVaultBalance
    );

    let bump = [ctx.accounts.vault_authority.bump];
    let seeds: &[&[u8]] = &[VAULT_AUTHORITY_SEED, dao_key.as_ref(), &bump];
    invoke_signed(
        &system_instruction::transfer(&va_ai.key(), &recipient_ai.key(), amount),
        &[va_ai.clone(), recipient_ai.clone(), ctx.accounts.system_program.to_account_info()],
        &[seeds],
    )?;

    // Invalidate the NAV so deploy/strategy caps are re-checked against a fresh
    // revaluation rather than the now-stale (pre-transfer) figure.
    ctx.accounts.treasury_vault.last_revalued_at = 0;

    emit!(GovernanceTransferExecuted {
        dao: dao_key,
        proposal: ctx.accounts.proposal.key(),
        recipient,
        mint: Pubkey::default(),
        amount,
    });
    Ok(())
}

pub fn execute_governance_transfer_spl_handler(ctx: Context<ExecuteGovernanceTransferSpl>) -> Result<()> {
    verify_governance_caller(
        &nave_governance_program::ID,
        &ctx.accounts.instructions_sysvar.to_account_info(),
    )?;
    require_not_paused(&ctx.accounts.global_config)?;
    require_dao_active(&ctx.accounts.dao_registry)?;
    require!(!ctx.accounts.dao_registry.frozen, NaveError::DaoFrozen);

    let prop = load_and_validate_proposal(
        &ctx.accounts.proposal.to_account_info(),
        &ctx.accounts.dao_registry.key(),
    )?;
    let (recipient, mint_pk, amount) = parse_transfer_payload(&prop)?;
    require!(mint_pk != Pubkey::default(), NaveError::TransferProposalPayloadInvalid);
    require!(
        mint_pk == ctx.accounts.mint.key(),
        NaveError::MintMismatch
    );
    // SOL-C1: bind the payload-decoded recipient to the actual `recipient`
    // account, not just the derived `recipient_token` ATA's owner (see native
    // SOL handler above for the full rationale).
    require!(
        recipient == ctx.accounts.recipient.key(),
        NaveError::RecipientMismatch
    );

    require!(ctx.accounts.asset_config.enabled, NaveError::AssetNotEnabled);
    require!(
        ctx.accounts.recipient_token.mint == ctx.accounts.mint.key(),
        NaveError::MintMismatch
    );
    require!(
        ctx.accounts.recipient_token.owner == ctx.accounts.recipient.key(),
        NaveError::Unauthorized
    );

    require!(
        ctx.accounts.asset_vault.amount >= amount,
        NaveError::InsufficientVaultBalance
    );

    let dao_key = ctx.accounts.dao_registry.key();
    transfer_escrow_to_account(
        &ctx.accounts.vault_authority,
        &ctx.accounts.asset_vault,
        &ctx.accounts.recipient_token,
        &ctx.accounts.token_program,
        &dao_key,
        amount,
    )?;

    let treasury_asset = &mut ctx.accounts.treasury_asset;
    treasury_asset.deposited = treasury_asset.deposited.saturating_sub(amount);

    // Invalidate the NAV so deploy/strategy caps are re-checked against a fresh
    // revaluation rather than the now-stale (pre-transfer) figure. We do not
    // attempt to infer a USD delta from token amount here; that is Pyth's job
    // via `revalue_treasury`. Setting last_revalued_at = 0 makes nav_fresh_enough
    // return false, which hard-blocks any cap-constrained deploy/strategy until
    // the founder or agent calls revalue_treasury.
    ctx.accounts.treasury_vault.last_revalued_at = 0;

    emit!(GovernanceTransferExecuted {
        dao: dao_key,
        proposal: ctx.accounts.proposal.key(),
        recipient,
        mint: mint_pk,
        amount,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct ExecuteGovernanceTransferNativeSol<'info> {
    /// CHECK: instructions sysvar for CPI caller verification.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions_sysvar: AccountInfo<'info>,

    #[account(seeds = [GLOBAL_CONFIG_SEED], bump = global_config.bump)]
    pub global_config: Account<'info, NaveGlobalConfig>,

    #[account(
        seeds = [DAO_REGISTRY_SEED, dao_registry.founder.as_ref(), &dao_registry.dao_id.to_le_bytes()],
        bump = dao_registry.bump
    )]
    pub dao_registry: Account<'info, DaoRegistry>,

    /// CHECK: nave_governance-owned proposal account (validated in handler).
    #[account(mut)]
    pub proposal: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [VAULT_AUTHORITY_SEED, dao_registry.key().as_ref()],
        bump = vault_authority.bump,
        constraint = vault_authority.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch
    )]
    pub vault_authority: Account<'info, VaultAuthority>,

    /// Mutated to reset last_revalued_at after the outbound transfer so the
    /// next deploy/strategy enforces a fresh NAV.
    #[account(
        mut,
        seeds = [TREASURY_VAULT_SEED, dao_registry.key().as_ref()],
        bump = treasury_vault.bump,
        constraint = treasury_vault.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch
    )]
    pub treasury_vault: Account<'info, TreasuryVault>,

    /// CHECK: native SOL recipient system account.
    #[account(mut)]
    pub recipient: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ExecuteGovernanceTransferSpl<'info> {
    /// CHECK: instructions sysvar for CPI caller verification.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions_sysvar: AccountInfo<'info>,

    #[account(seeds = [GLOBAL_CONFIG_SEED], bump = global_config.bump)]
    pub global_config: Account<'info, NaveGlobalConfig>,

    #[account(
        seeds = [DAO_REGISTRY_SEED, dao_registry.founder.as_ref(), &dao_registry.dao_id.to_le_bytes()],
        bump = dao_registry.bump
    )]
    pub dao_registry: Account<'info, DaoRegistry>,

    /// CHECK: nave_governance-owned proposal account (validated in handler).
    #[account(mut)]
    pub proposal: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [VAULT_AUTHORITY_SEED, dao_registry.key().as_ref()],
        bump = vault_authority.bump,
        constraint = vault_authority.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch
    )]
    pub vault_authority: Account<'info, VaultAuthority>,

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

    /// Mutated to reset last_revalued_at after the outbound transfer so the
    /// next deploy/strategy enforces a fresh NAV.
    #[account(
        mut,
        seeds = [TREASURY_VAULT_SEED, dao_registry.key().as_ref()],
        bump = treasury_vault.bump,
        constraint = treasury_vault.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch
    )]
    pub treasury_vault: Account<'info, TreasuryVault>,

    #[account(
        mut,
        seeds = [ASSET_VAULT_SEED, dao_registry.key().as_ref(), mint.key().as_ref()],
        bump,
        constraint = asset_vault.key() == treasury_asset.token_account @ NaveError::InvalidVaultTokenAccount,
        constraint = asset_vault.owner == vault_authority.key() @ NaveError::Unauthorized
    )]
    pub asset_vault: Account<'info, TokenAccount>,

    /// CHECK: recipient wallet owner for the destination ATA.
    pub recipient: UncheckedAccount<'info>,

    #[account(
        mut,
        constraint = recipient_token.mint == mint.key() @ NaveError::MintMismatch,
        constraint = recipient_token.owner == recipient.key() @ NaveError::Unauthorized
    )]
    pub recipient_token: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// Disburse a treasury-held NFT after a passed Transfer proposal whose payload
/// binds `sha256(recipient ‖ nft_mint ‖ 1_le_u64)`. Mirrors the SPL handler but
/// moves exactly 1 unit out of the dedicated `nft_vault`, marks the
/// `NftVaultRecord` transferred (replay guard), and does NOT touch NAV (NFTs are
/// held at $0 valuation). cNFTs (Bubblegum) are a separate future path.
pub fn execute_governance_transfer_nft_handler(
    ctx: Context<ExecuteGovernanceTransferNft>,
) -> Result<()> {
    verify_governance_caller(
        &nave_governance_program::ID,
        &ctx.accounts.instructions_sysvar.to_account_info(),
    )?;
    require_not_paused(&ctx.accounts.global_config)?;
    require_dao_active(&ctx.accounts.dao_registry)?;
    require!(!ctx.accounts.dao_registry.frozen, NaveError::DaoFrozen);

    let prop = load_and_validate_proposal(
        &ctx.accounts.proposal.to_account_info(),
        &ctx.accounts.dao_registry.key(),
    )?;
    let (recipient, mint_pk, amount) = parse_transfer_payload(&prop)?;
    require!(mint_pk != Pubkey::default(), NaveError::TransferProposalPayloadInvalid);
    require!(mint_pk == ctx.accounts.mint.key(), NaveError::MintMismatch);
    // NFTs move exactly one unit; any other amount is a malformed NFT payload.
    require!(amount == 1, NaveError::TransferProposalPayloadInvalid);
    // SOL-C1: bind the payload-decoded recipient to the actual `recipient`
    // account (see native SOL handler for the full rationale).
    require!(
        recipient == ctx.accounts.recipient.key(),
        NaveError::RecipientMismatch
    );
    require!(!ctx.accounts.nft_record.transferred, NaveError::TransferProposalPayloadInvalid);
    require!(
        ctx.accounts.recipient_token.mint == ctx.accounts.mint.key(),
        NaveError::MintMismatch
    );
    require!(
        ctx.accounts.recipient_token.owner == ctx.accounts.recipient.key(),
        NaveError::Unauthorized
    );
    require!(ctx.accounts.nft_vault.amount >= 1, NaveError::InsufficientVaultBalance);

    let dao_key = ctx.accounts.dao_registry.key();
    transfer_escrow_to_account(
        &ctx.accounts.vault_authority,
        &ctx.accounts.nft_vault,
        &ctx.accounts.recipient_token,
        &ctx.accounts.token_program,
        &dao_key,
        1,
    )?;

    ctx.accounts.nft_record.transferred = true;

    emit!(GovernanceTransferExecuted {
        dao: dao_key,
        proposal: ctx.accounts.proposal.key(),
        recipient,
        mint: mint_pk,
        amount: 1,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct ExecuteGovernanceTransferNft<'info> {
    /// CHECK: instructions sysvar for CPI caller verification.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions_sysvar: AccountInfo<'info>,

    #[account(seeds = [GLOBAL_CONFIG_SEED], bump = global_config.bump)]
    pub global_config: Account<'info, NaveGlobalConfig>,

    #[account(
        seeds = [DAO_REGISTRY_SEED, dao_registry.founder.as_ref(), &dao_registry.dao_id.to_le_bytes()],
        bump = dao_registry.bump
    )]
    pub dao_registry: Account<'info, DaoRegistry>,

    /// CHECK: nave_governance-owned proposal account (validated in handler).
    #[account(mut)]
    pub proposal: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [VAULT_AUTHORITY_SEED, dao_registry.key().as_ref()],
        bump = vault_authority.bump,
        constraint = vault_authority.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch
    )]
    pub vault_authority: Account<'info, VaultAuthority>,

    pub mint: Account<'info, Mint>,

    #[account(
        mut,
        seeds = [NFT_VAULT_RECORD_SEED, dao_registry.key().as_ref(), mint.key().as_ref()],
        bump = nft_record.bump,
        constraint = nft_record.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch,
        constraint = nft_record.mint == mint.key() @ NaveError::MintMismatch
    )]
    pub nft_record: Account<'info, NftVaultRecord>,

    #[account(
        mut,
        seeds = [NFT_VAULT_SEED, dao_registry.key().as_ref(), mint.key().as_ref()],
        bump,
        constraint = nft_vault.key() == nft_record.token_account @ NaveError::InvalidVaultTokenAccount,
        constraint = nft_vault.owner == vault_authority.key() @ NaveError::Unauthorized
    )]
    pub nft_vault: Account<'info, TokenAccount>,

    /// CHECK: recipient wallet owner for the destination ATA.
    pub recipient: UncheckedAccount<'info>,

    #[account(
        mut,
        constraint = recipient_token.mint == mint.key() @ NaveError::MintMismatch,
        constraint = recipient_token.owner == recipient.key() @ NaveError::Unauthorized
    )]
    pub recipient_token: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}
