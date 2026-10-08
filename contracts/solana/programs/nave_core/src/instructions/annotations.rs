use anchor_lang::prelude::*;

use crate::constants::{
    AnnotationStatus, DAO_REGISTRY_SEED, GLOBAL_CONFIG_SEED, GUARDIAN_CONFIG_SEED,
    HOLDER_ANNOTATION_SEED, MAX_ANNOTATION_LEN,
};
use crate::errors::NaveError;
use crate::events::{
    HolderAnnotationApproved, HolderAnnotationDenied, HolderAnnotationSet,
};
use crate::state::{DaoRegistry, GuardianConfig, HolderAnnotation, NaveGlobalConfig};
use crate::utils::{require_founder, require_guardian, require_not_paused, validate_dao_ownership};

pub fn set_holder_annotation_handler(
    ctx: Context<SetHolderAnnotation>,
    annotation: String,
) -> Result<()> {
    require_not_paused(&ctx.accounts.global_config)?;
    require!(
        !annotation.is_empty() && annotation.len() <= MAX_ANNOTATION_LEN,
        NaveError::InvalidAnnotationLength
    );

    let holder_annotation = &mut ctx.accounts.holder_annotation;
    holder_annotation.bump = ctx.bumps.holder_annotation;
    holder_annotation.dao = ctx.accounts.dao_registry.key();
    holder_annotation.holder = ctx.accounts.holder.key();
    holder_annotation.status = AnnotationStatus::Pending as u8;
    holder_annotation.set_annotation(annotation.as_bytes())?;
    holder_annotation.submitted_at = Clock::get()?.unix_timestamp;
    holder_annotation.reviewed_at = 0;

    emit!(HolderAnnotationSet {
        dao: ctx.accounts.dao_registry.key(),
        holder: holder_annotation.holder,
        annotation_len: holder_annotation.annotation_len,
    });

    Ok(())
}

pub fn approve_holder_annotation_handler(ctx: Context<ReviewHolderAnnotation>) -> Result<()> {
    require_not_paused(&ctx.accounts.global_config)?;
    require_founder_or_guardian(
        &ctx.accounts.reviewer.key(),
        &ctx.accounts.dao_registry,
        &ctx.accounts.guardian_config,
    )?;

    let holder_annotation = &mut ctx.accounts.holder_annotation;
    validate_dao_ownership(&holder_annotation.dao, &ctx.accounts.dao_registry.key())?;
    require!(
        holder_annotation.status == AnnotationStatus::Pending as u8,
        NaveError::AnnotationNotPending
    );

    holder_annotation.status = AnnotationStatus::Approved as u8;
    holder_annotation.reviewed_at = Clock::get()?.unix_timestamp;

    emit!(HolderAnnotationApproved {
        dao: ctx.accounts.dao_registry.key(),
        holder: holder_annotation.holder,
    });

    Ok(())
}

pub fn deny_holder_annotation_handler(ctx: Context<ReviewHolderAnnotation>) -> Result<()> {
    require_not_paused(&ctx.accounts.global_config)?;
    require_founder_or_guardian(
        &ctx.accounts.reviewer.key(),
        &ctx.accounts.dao_registry,
        &ctx.accounts.guardian_config,
    )?;

    let holder_annotation = &mut ctx.accounts.holder_annotation;
    validate_dao_ownership(&holder_annotation.dao, &ctx.accounts.dao_registry.key())?;
    require!(
        holder_annotation.status == AnnotationStatus::Pending as u8,
        NaveError::AnnotationNotPending
    );

    holder_annotation.status = AnnotationStatus::Denied as u8;
    holder_annotation.reviewed_at = Clock::get()?.unix_timestamp;

    emit!(HolderAnnotationDenied {
        dao: ctx.accounts.dao_registry.key(),
        holder: holder_annotation.holder,
    });

    Ok(())
}

fn require_founder_or_guardian(
    signer: &Pubkey,
    dao_registry: &DaoRegistry,
    guardian_config: &GuardianConfig,
) -> Result<()> {
    if signer == &dao_registry.founder {
        return Ok(());
    }
    require_guardian(signer, guardian_config)?;
    Ok(())
}

#[derive(Accounts)]
pub struct SetHolderAnnotation<'info> {
    #[account(mut)]
    pub holder: Signer<'info>,

    #[account(seeds = [GLOBAL_CONFIG_SEED], bump = global_config.bump)]
    pub global_config: Account<'info, NaveGlobalConfig>,

    #[account(
        seeds = [DAO_REGISTRY_SEED, dao_registry.founder.as_ref(), &dao_registry.dao_id.to_le_bytes()],
        bump = dao_registry.bump
    )]
    pub dao_registry: Account<'info, DaoRegistry>,

    #[account(
        init,
        payer = holder,
        space = HolderAnnotation::LEN,
        seeds = [HOLDER_ANNOTATION_SEED, dao_registry.key().as_ref(), holder.key().as_ref()],
        bump
    )]
    pub holder_annotation: Account<'info, HolderAnnotation>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ReviewHolderAnnotation<'info> {
    pub reviewer: Signer<'info>,

    #[account(seeds = [GLOBAL_CONFIG_SEED], bump = global_config.bump)]
    pub global_config: Account<'info, NaveGlobalConfig>,

    #[account(
        seeds = [DAO_REGISTRY_SEED, dao_registry.founder.as_ref(), &dao_registry.dao_id.to_le_bytes()],
        bump = dao_registry.bump
    )]
    pub dao_registry: Account<'info, DaoRegistry>,

    #[account(
        seeds = [GUARDIAN_CONFIG_SEED, dao_registry.key().as_ref()],
        bump = guardian_config.bump,
        constraint = guardian_config.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch
    )]
    pub guardian_config: Account<'info, GuardianConfig>,

    #[account(
        mut,
        seeds = [HOLDER_ANNOTATION_SEED, dao_registry.key().as_ref(), holder_annotation.holder.as_ref()],
        bump = holder_annotation.bump,
        constraint = holder_annotation.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch
    )]
    pub holder_annotation: Account<'info, HolderAnnotation>,
}
