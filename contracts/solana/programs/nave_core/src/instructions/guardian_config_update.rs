//! Guardian config update paths:
//! 1. Founder one-shot ActivationHub bootstrap (`update_guardian_config`)
//! 2. CPI-only apply from a passed `ProposalType::Permission` vote
//!    (`apply_guardian_config_from_governance`)
//! 3. Permissionless layout resize for pre-bootstrapped-flag accounts
//!
//! Permission payload wire format (bound to `payload_hash` via sha256):
//! `threshold(1) ‖ wallet_count(1) ‖ wallets(MAX_GUARDIAN_WALLETS × 32, zero-padded)`.

use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};
use sha2::{Digest, Sha256};

use crate::constants::{
    gov_proposal_type, nave_governance_program, DAO_REGISTRY_SEED, GLOBAL_CONFIG_SEED,
    GUARDIAN_CONFIG_SEED, MAX_GUARDIAN_THRESHOLD, MAX_GUARDIAN_WALLETS, PERMISSION_PAYLOAD_LEN,
};
use crate::errors::NaveError;
use crate::events::{GuardianConfigUpdated, GuardiansBootstrapped};
use crate::state::{
    DaoRegistry, GovernanceProposalLayout, GuardianConfig, GUARDIAN_CONFIG_LEGACY_LEN,
    NaveGlobalConfig,
};
use crate::utils::{
    require_dao_active, require_founder, require_not_paused, validate_dao_ownership,
    verify_governance_caller,
};

fn hash_permission_payload(slice: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(slice);
    hasher.finalize().into()
}

fn validate_guardian_set(wallets: &[Pubkey], threshold: u8) -> Result<()> {
    require!(
        !wallets.is_empty() && wallets.len() <= MAX_GUARDIAN_WALLETS,
        NaveError::TooManyGuardianWallets
    );
    require!(
        threshold > 0
            && threshold <= MAX_GUARDIAN_THRESHOLD
            && (threshold as usize) <= wallets.len(),
        NaveError::InvalidGuardianThreshold
    );
    let mut sorted = wallets.to_vec();
    sorted.sort();
    sorted.dedup();
    require!(sorted.len() == wallets.len(), NaveError::DuplicateGuardianWallet);
    Ok(())
}

fn apply_wallets(guardian_config: &mut GuardianConfig, wallets: &[Pubkey], threshold: u8) {
    guardian_config.threshold = threshold;
    guardian_config.wallet_count = wallets.len() as u8;
    guardian_config.wallets = [Pubkey::default(); MAX_GUARDIAN_WALLETS];
    for (idx, wallet) in wallets.iter().enumerate() {
        guardian_config.wallets[idx] = *wallet;
    }
}

/// Boxed + `inline(never)`: the ~1.3 KB proposal layout must not be returned
/// by value into the handler's frame, which already sits close to the 4 KB
/// SBF stack limit (it overflowed by 128 bytes once `token_mint` was appended
/// to the layout).
#[inline(never)]
fn load_and_validate_permission_proposal(
    proposal_ai: &AccountInfo,
    dao: &Pubkey,
) -> Result<Box<GovernanceProposalLayout>> {
    require!(
        *proposal_ai.owner == nave_governance_program::ID,
        NaveError::InvalidGovernanceProposal
    );
    let data = proposal_ai.try_borrow_data()?;
    let prop = GovernanceProposalLayout::try_deserialize_skip_discriminator(&data)?;
    require!(prop.dao == *dao, NaveError::DaoOwnershipMismatch);
    require!(
        prop.proposal_type == gov_proposal_type::PERMISSION,
        NaveError::PermissionProposalInvalid
    );
    require!(
        prop.status == gov_proposal_type::STATUS_PASSED,
        NaveError::PermissionProposalInvalid
    );
    require!(prop.finalized_at > 0, NaveError::PermissionProposalInvalid);
    Ok(Box::new(prop))
}

fn parse_permission_payload(prop: &GovernanceProposalLayout) -> Result<(Vec<Pubkey>, u8)> {
    let plen = prop.payload_len as usize;
    require!(
        plen == PERMISSION_PAYLOAD_LEN,
        NaveError::PermissionProposalInvalid
    );
    let slice = &prop.payload[..plen];
    require!(
        hash_permission_payload(slice) == prop.payload_hash,
        NaveError::PermissionPayloadMismatch
    );

    let threshold = slice[0];
    let wallet_count = slice[1] as usize;
    require!(
        wallet_count > 0 && wallet_count <= MAX_GUARDIAN_WALLETS,
        NaveError::PermissionProposalInvalid
    );
    const WALLETS_START: usize = 2;
    let mut wallets = Vec::with_capacity(wallet_count);
    for i in 0..wallet_count {
        let start = WALLETS_START + i * 32;
        wallets.push(Pubkey::new_from_array(
            slice[start..start + 32].try_into().unwrap(),
        ));
    }
    // Trailing wallet slots must be zero-padded.
    for i in wallet_count..MAX_GUARDIAN_WALLETS {
        let start = WALLETS_START + i * 32;
        let pad = Pubkey::new_from_array(slice[start..start + 32].try_into().unwrap());
        require!(pad == Pubkey::default(), NaveError::PermissionProposalInvalid);
    }

    validate_guardian_set(&wallets, threshold)?;
    Ok((wallets, threshold))
}

/// Founder one-shot ActivationHub bootstrap. After `bootstrapped` is true,
/// further changes require a passed Permission proposal via
/// `apply_guardian_config_from_governance`.
pub fn update_guardian_config_handler(
    ctx: Context<UpdateGuardianConfig>,
    wallets: Vec<Pubkey>,
    threshold: u8,
) -> Result<()> {
    require_not_paused(&ctx.accounts.global_config)?;
    require_dao_active(&ctx.accounts.dao_registry)?;
    require_founder(&ctx.accounts.authority.key(), &ctx.accounts.dao_registry)?;
    validate_guardian_set(&wallets, threshold)?;

    let guardian_config = &mut ctx.accounts.guardian_config;
    validate_dao_ownership(&guardian_config.dao, &ctx.accounts.dao_registry.key())?;
    require!(
        !guardian_config.bootstrapped,
        NaveError::GuardiansAlreadyBootstrapped
    );

    apply_wallets(guardian_config, &wallets, threshold);
    guardian_config.bootstrapped = true;

    let dao = ctx.accounts.dao_registry.key();
    emit!(GuardiansBootstrapped {
        dao,
        threshold,
        wallet_count: guardian_config.wallet_count,
    });
    emit!(GuardianConfigUpdated {
        dao,
        threshold,
        wallet_count: guardian_config.wallet_count,
    });

    Ok(())
}

/// CPI-only from `nave_governance::execute_permission_proposal`. Decodes the
/// target guardian set from the Passed+finalized Permission proposal payload
/// (hash-bound), applies it, and latches `bootstrapped` if not already set.
pub fn apply_guardian_config_from_governance_handler(
    ctx: Context<ApplyGuardianConfigFromGovernance>,
) -> Result<()> {
    require_not_paused(&ctx.accounts.global_config)?;
    verify_governance_caller(
        &nave_governance_program::ID,
        &ctx.accounts.instructions_sysvar.to_account_info(),
    )?;
    require_dao_active(&ctx.accounts.dao_registry)?;

    let prop = load_and_validate_permission_proposal(
        &ctx.accounts.proposal.to_account_info(),
        &ctx.accounts.dao_registry.key(),
    )?;
    let (wallets, threshold) = parse_permission_payload(&prop)?;

    let guardian_config = &mut ctx.accounts.guardian_config;
    validate_dao_ownership(&guardian_config.dao, &ctx.accounts.dao_registry.key())?;
    apply_wallets(guardian_config, &wallets, threshold);

    let dao = ctx.accounts.dao_registry.key();
    if !guardian_config.bootstrapped {
        guardian_config.bootstrapped = true;
        emit!(GuardiansBootstrapped {
            dao,
            threshold,
            wallet_count: guardian_config.wallet_count,
        });
    }
    emit!(GuardianConfigUpdated {
        dao,
        threshold,
        wallet_count: guardian_config.wallet_count,
    });

    Ok(())
}

/// Permissionless layout migration: extend a pre-`bootstrapped` GuardianConfig
/// account by one byte (default `false`). Required once per DAO after the
/// program upgrade that introduced the latch; subsequent Account loads need
/// `GuardianConfig::LEN`.
pub fn resize_guardian_config_handler(ctx: Context<ResizeGuardianConfig>) -> Result<()> {
    let ai = ctx.accounts.guardian_config.to_account_info();
    require!(
        *ai.owner == crate::ID,
        NaveError::DaoOwnershipMismatch
    );
    let current = ai.data_len();
    require!(
        current == GUARDIAN_CONFIG_LEGACY_LEN || current == GuardianConfig::LEN,
        NaveError::GuardianConfigLayoutInvalid
    );
    if current == GuardianConfig::LEN {
        return Ok(());
    }

    // Confirm legacy body belongs to this DAO (dao pubkey sits at offset 8+1).
    {
        let data = ai.try_borrow_data()?;
        require!(
            data.len() >= 8 + 1 + 32,
            NaveError::GuardianConfigLayoutInvalid
        );
        let dao_bytes: [u8; 32] = data[9..41].try_into().unwrap();
        require!(
            Pubkey::new_from_array(dao_bytes) == ctx.accounts.dao_registry.key(),
            NaveError::DaoOwnershipMismatch
        );
    }

    let rent = Rent::get()?;
    let new_min = rent.minimum_balance(GuardianConfig::LEN);
    let lamports = ai.lamports();
    if lamports < new_min {
        let top_up = new_min.saturating_sub(lamports);
        transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.payer.to_account_info(),
                    to: ai.clone(),
                },
            ),
            top_up,
        )?;
    }

    ai.resize(GuardianConfig::LEN)?;
    // Explicitly zero the new trailing latch byte (bootstrapped = false).
    {
        let mut data = ai.try_borrow_mut_data()?;
        if let Some(b) = data.last_mut() {
            *b = 0;
        }
    }
    Ok(())
}

#[derive(Accounts)]
pub struct UpdateGuardianConfig<'info> {
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
        seeds = [GUARDIAN_CONFIG_SEED, dao_registry.key().as_ref()],
        bump = guardian_config.bump,
        constraint = guardian_config.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch
    )]
    pub guardian_config: Account<'info, GuardianConfig>,
}

#[derive(Accounts)]
pub struct ApplyGuardianConfigFromGovernance<'info> {
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

    #[account(
        mut,
        seeds = [GUARDIAN_CONFIG_SEED, dao_registry.key().as_ref()],
        bump = guardian_config.bump,
        constraint = guardian_config.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch
    )]
    pub guardian_config: Account<'info, GuardianConfig>,

    /// CHECK: nave_governance-owned proposal (validated in handler).
    #[account(mut)]
    pub proposal: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct ResizeGuardianConfig<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        seeds = [DAO_REGISTRY_SEED, dao_registry.founder.as_ref(), &dao_registry.dao_id.to_le_bytes()],
        bump = dao_registry.bump
    )]
    pub dao_registry: Account<'info, DaoRegistry>,

    /// CHECK: PDA verified by seeds; body may be legacy-sized until resized.
    #[account(
        mut,
        seeds = [GUARDIAN_CONFIG_SEED, dao_registry.key().as_ref()],
        bump,
    )]
    pub guardian_config: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}
