use anchor_lang::prelude::*;

use crate::constants::{
    AgentRole, AgentStatus, AGENT_COUNT, AGENT_ROTATION_DELAY_SECONDS, CONSTITUTION_SEED,
    DAO_REGISTRY_SEED, GLOBAL_CONFIG_SEED, GUARDIAN_ACTION_DISABLE_AGENTS, GUARDIAN_ACTION_FREEZE,
    GUARDIAN_ACTION_NULLIFY_AGENT, GUARDIAN_ACTION_ROTATE_AGENT_KEY, GUARDIAN_ACTION_SEED,
    GUARDIAN_ACTION_UNFREEZE, GUARDIAN_ACTION_UPDATE_AGENT_STATUS, GUARDIAN_CONFIG_SEED, AGENT_SET_SEED,
    MAX_CONSTITUTION_PROTOCOLS,
};
use crate::errors::NaveError;
use crate::events::{
    AgentKeyRotatedEvent, AgentNullified, AgentRestored, AgentRotationApplied,
    AgentRotationScheduled, AgentSetUpdated, AgentStatusChangedEvent, AgentsToggled,
    ConstitutionUpdated, DaoEmergencyFrozen, DaoEmergencyUnfrozen,
    MaxSingleSwapUpdated, MaxSlippageUpdated, PolicyParametersUpdated, ReviewWindowUpdated,
};
use crate::state::{
    AgentSet, DaoRegistry, GuardianAction, GuardianConfig, NaveGlobalConfig, PendingAgentRotation,
    ProtocolEntry, TreasuryConstitution,
};
use crate::utils::{require_dao_active, require_founder, require_guardian, require_not_paused, validate_dao_ownership};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ProtocolInput {
    pub protocol_id: String,
    pub program_id: Pubkey,
    pub max_allocation_bps: u16,
    pub approved: bool,
}

pub fn update_constitution_handler(
    ctx: Context<UpdateConstitution>,
    protocols: Vec<ProtocolInput>,
    confidence_threshold: Option<u8>,
    agent_threshold_usd: Option<u64>,
) -> Result<()> {
    require_not_paused(&ctx.accounts.global_config)?;
    require_dao_active(&ctx.accounts.dao_registry)?;
    require_founder(&ctx.accounts.authority.key(), &ctx.accounts.dao_registry)?;
    require!(
        !protocols.is_empty() && protocols.len() <= MAX_CONSTITUTION_PROTOCOLS,
        NaveError::TooManyProtocols
    );

    let constitution = &mut ctx.accounts.constitution;
    validate_dao_ownership(&constitution.dao, &ctx.accounts.dao_registry.key())?;

    let mut entries = [ProtocolEntry::default(); MAX_CONSTITUTION_PROTOCOLS];
    for (idx, input) in protocols.iter().enumerate() {
        require!(
            !input.protocol_id.is_empty()
                && input.protocol_id.len() <= crate::constants::MAX_PROTOCOL_ID_LEN,
            NaveError::InvalidProtocolIdLength
        );
        require!(input.max_allocation_bps <= 10_000, NaveError::InvalidBps);
        entries[idx].set_protocol_id(input.protocol_id.as_bytes())?;
        entries[idx].program_id = input.program_id;
        entries[idx].max_allocation_bps = input.max_allocation_bps;
        entries[idx].approved = input.approved;
    }

    constitution.protocol_count = protocols.len() as u8;
    constitution.protocols = entries;

    if let Some(threshold) = confidence_threshold {
        require!(
            threshold <= crate::constants::MAX_CONFIDENCE_THRESHOLD,
            NaveError::InvalidConfidenceThreshold
        );
        constitution.confidence_threshold = threshold;
    }

    if let Some(threshold_usd) = agent_threshold_usd {
        constitution.agent_threshold_usd = threshold_usd;
    }

    emit!(ConstitutionUpdated {
        dao: ctx.accounts.dao_registry.key(),
        protocol_count: constitution.protocol_count,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct UpdateConstitution<'info> {
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
        seeds = [CONSTITUTION_SEED, dao_registry.key().as_ref()],
        bump = constitution.bump,
        constraint = constitution.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch
    )]
    pub constitution: Account<'info, TreasuryConstitution>,
}

/// Set the per-DAO review window (seconds) enforced between Oversight approval
/// and `execute_strategy`. Founder-gated and bounds-checked; kept as a dedicated
/// instruction so the existing `update_constitution` ABI is unchanged.
pub fn set_review_window_handler(
    ctx: Context<SetReviewWindow>,
    review_window_secs: i64,
) -> Result<()> {
    require_not_paused(&ctx.accounts.global_config)?;
    require_dao_active(&ctx.accounts.dao_registry)?;
    require_founder(&ctx.accounts.authority.key(), &ctx.accounts.dao_registry)?;
    require!(
        review_window_secs >= crate::constants::MIN_REVIEW_WINDOW_SECONDS
            && review_window_secs <= crate::constants::MAX_REVIEW_WINDOW_SECONDS,
        NaveError::InvalidReviewWindow
    );

    let constitution = &mut ctx.accounts.constitution;
    validate_dao_ownership(&constitution.dao, &ctx.accounts.dao_registry.key())?;
    constitution.review_window_secs = review_window_secs;

    emit!(ReviewWindowUpdated {
        dao: ctx.accounts.dao_registry.key(),
        review_window_secs,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct SetReviewWindow<'info> {
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
        seeds = [CONSTITUTION_SEED, dao_registry.key().as_ref()],
        bump = constitution.bump,
        constraint = constitution.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch
    )]
    pub constitution: Account<'info, TreasuryConstitution>,
}

/// Set the per-DAO `jupiter_swap` slippage guardrail (bps), enforced against
/// the caller-supplied `expected_amount_out` in addition to the always-on
/// `min_amount_out` floor. Founder-gated; kept as a dedicated instruction
/// (mirroring `set_review_window`) so the existing `update_constitution` ABI
/// is unchanged. `0` disables the guardrail (default; existing DAOs are
/// unaffected until the founder opts in).
pub fn set_max_slippage_bps_handler(
    ctx: Context<SetMaxSlippageBps>,
    max_slippage_bps: u16,
) -> Result<()> {
    require_not_paused(&ctx.accounts.global_config)?;
    require_dao_active(&ctx.accounts.dao_registry)?;
    require_founder(&ctx.accounts.authority.key(), &ctx.accounts.dao_registry)?;
    require!(
        max_slippage_bps <= crate::constants::MAX_SLIPPAGE_BPS,
        NaveError::InvalidMaxSlippageBps
    );

    let constitution = &mut ctx.accounts.constitution;
    validate_dao_ownership(&constitution.dao, &ctx.accounts.dao_registry.key())?;
    constitution.max_slippage_bps = max_slippage_bps;

    emit!(MaxSlippageUpdated {
        dao: ctx.accounts.dao_registry.key(),
        max_slippage_bps,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct SetMaxSlippageBps<'info> {
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
        seeds = [CONSTITUTION_SEED, dao_registry.key().as_ref()],
        bump = constitution.bump,
        constraint = constitution.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch
    )]
    pub constitution: Account<'info, TreasuryConstitution>,
}

/// Set the per-DAO `jupiter_swap` single-call size guardrail (bps of the
/// pre-swap balance of the asset sold). Founder-gated; kept as a dedicated
/// instruction (mirroring `set_max_slippage_bps`) so the existing
/// `update_constitution` ABI is unchanged. `0` disables the cap (default;
/// existing DAOs are unaffected until the founder opts in). See the doc
/// comment on `TreasuryConstitution::max_single_swap_bps` for why this exists:
/// `jupiter_swap` is Operational-agent gated with no prior multi-agent-
/// approval step, unlike Kamino/Jito/MarginFi deposits which can only move
/// funds already escrowed via a governance-approved `execute_strategy`.
pub fn set_max_single_swap_bps_handler(
    ctx: Context<SetMaxSingleSwapBps>,
    max_single_swap_bps: u16,
) -> Result<()> {
    require_not_paused(&ctx.accounts.global_config)?;
    require_dao_active(&ctx.accounts.dao_registry)?;
    require_founder(&ctx.accounts.authority.key(), &ctx.accounts.dao_registry)?;
    require!(
        max_single_swap_bps <= crate::constants::MAX_SINGLE_SWAP_BPS,
        NaveError::InvalidMaxSingleSwapBps
    );

    let constitution = &mut ctx.accounts.constitution;
    validate_dao_ownership(&constitution.dao, &ctx.accounts.dao_registry.key())?;
    constitution.max_single_swap_bps = max_single_swap_bps;

    emit!(MaxSingleSwapUpdated {
        dao: ctx.accounts.dao_registry.key(),
        max_single_swap_bps,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct SetMaxSingleSwapBps<'info> {
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
        seeds = [CONSTITUTION_SEED, dao_registry.key().as_ref()],
        bump = constitution.bump,
        constraint = constitution.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch
    )]
    pub constitution: Account<'info, TreasuryConstitution>,
}

/// Set the per-DAO continuous treasury policy parameters: the stablecoin
/// reserve floor, global deployment cap, liquidity floor, and rebalance cadence.
/// Founder-gated and bounds-checked. Kept as a dedicated instruction (mirroring
/// `set_review_window`) so the existing `update_constitution` ABI is unchanged.
///
/// A `0` value for any of the bps floors/caps means "unset" and disables that
/// particular constraint; `rebalance_frequency_secs == 0` disables the cadence.
pub fn set_policy_parameters_handler(
    ctx: Context<SetPolicyParameters>,
    min_stablecoin_reserve_bps: u16,
    max_total_deployed_bps: u16,
    min_liquidity_bps: u16,
    rebalance_frequency_secs: i64,
) -> Result<()> {
    require_not_paused(&ctx.accounts.global_config)?;
    require_dao_active(&ctx.accounts.dao_registry)?;
    require_founder(&ctx.accounts.authority.key(), &ctx.accounts.dao_registry)?;

    require!(
        min_stablecoin_reserve_bps <= crate::constants::MAX_RESERVE_BPS,
        NaveError::InvalidPolicyParameters
    );
    require!(
        max_total_deployed_bps <= crate::constants::MAX_DEPLOYMENT_BPS,
        NaveError::InvalidPolicyParameters
    );
    require!(
        min_liquidity_bps <= crate::constants::MAX_LIQUIDITY_BPS,
        NaveError::InvalidPolicyParameters
    );
    require!(
        rebalance_frequency_secs == 0
            || (rebalance_frequency_secs >= crate::constants::MIN_REBALANCE_FREQUENCY_SECONDS
                && rebalance_frequency_secs <= crate::constants::MAX_REBALANCE_FREQUENCY_SECONDS),
        NaveError::InvalidPolicyParameters
    );
    // Coherence: when both the explicit deployment cap and the liquidity floor
    // are set, deploying up to the cap must not breach the liquidity floor, so
    // their sum cannot exceed 100%. (Reserve is a separate floor — per policy
    // stablecoin reserve may itself be deployed — so it is not summed here.)
    if max_total_deployed_bps > 0 && min_liquidity_bps > 0 {
        require!(
            (max_total_deployed_bps as u32) + (min_liquidity_bps as u32) <= 10_000,
            NaveError::InvalidPolicyParameters
        );
    }

    let constitution = &mut ctx.accounts.constitution;
    validate_dao_ownership(&constitution.dao, &ctx.accounts.dao_registry.key())?;
    constitution.min_stablecoin_reserve_bps = min_stablecoin_reserve_bps;
    constitution.max_total_deployed_bps = max_total_deployed_bps;
    constitution.min_liquidity_bps = min_liquidity_bps;
    constitution.rebalance_frequency_secs = rebalance_frequency_secs;

    emit!(PolicyParametersUpdated {
        dao: ctx.accounts.dao_registry.key(),
        min_stablecoin_reserve_bps,
        max_total_deployed_bps,
        min_liquidity_bps,
        rebalance_frequency_secs,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct SetPolicyParameters<'info> {
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
        seeds = [CONSTITUTION_SEED, dao_registry.key().as_ref()],
        bump = constitution.bump,
        constraint = constitution.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch
    )]
    pub constitution: Account<'info, TreasuryConstitution>,
}

pub fn update_agent_set_handler(
    ctx: Context<UpdateAgentSet>,
    agent_authorities: Vec<Pubkey>,
) -> Result<()> {
    require_not_paused(&ctx.accounts.global_config)?;
    require_dao_active(&ctx.accounts.dao_registry)?;
    require_founder(&ctx.accounts.authority.key(), &ctx.accounts.dao_registry)?;
    require!(
        agent_authorities.len() == crate::constants::AGENT_COUNT,
        NaveError::InvalidAgentRole
    );

    let agent_set = &mut ctx.accounts.agent_set;
    validate_dao_ownership(&agent_set.dao, &ctx.accounts.dao_registry.key())?;
    let effective_at = Clock::get()?
        .unix_timestamp
        .checked_add(AGENT_ROTATION_DELAY_SECONDS)
        .ok_or(NaveError::MathOverflow)?;

    for (idx, authority) in agent_authorities.iter().enumerate() {
        let slot = &agent_set.agents[idx];
        if slot.nullified {
            continue;
        }
        if slot.authority == *authority {
            agent_set.pending_rotations[idx] = PendingAgentRotation::default();
            continue;
        }
        agent_set.pending_rotations[idx] = PendingAgentRotation {
            pending_authority: *authority,
            effective_at,
        };
    }

    emit!(AgentRotationScheduled {
        dao: ctx.accounts.dao_registry.key(),
        effective_at,
    });

    Ok(())
}

pub fn apply_agent_rotation_handler(ctx: Context<ApplyAgentRotation>, role: u8) -> Result<()> {
    require_not_paused(&ctx.accounts.global_config)?;
    let agent_role = AgentRole::from_u8(role).ok_or(NaveError::InvalidAgentRole)?;
    require_founder(&ctx.accounts.authority.key(), &ctx.accounts.dao_registry)?;

    let agent_set = &mut ctx.accounts.agent_set;
    let idx = agent_role as usize;
    let pending = agent_set.pending_rotations[idx];
    require!(pending.pending_authority != Pubkey::default(), NaveError::NoPendingAgentRotation);
    require!(
        Clock::get()?.unix_timestamp >= pending.effective_at,
        NaveError::AgentRotationNotReady
    );

    let slot = &mut agent_set.agents[idx];
    require!(!slot.nullified, NaveError::AgentNullified);
    let new_authority = pending.pending_authority;
    slot.authority = new_authority;
    slot.active = true;
    agent_set.pending_rotations[idx] = PendingAgentRotation::default();

    emit!(AgentRotationApplied {
        dao: ctx.accounts.dao_registry.key(),
        role,
        new_authority,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct UpdateAgentSet<'info> {
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
        seeds = [AGENT_SET_SEED, dao_registry.key().as_ref()],
        bump = agent_set.bump,
        constraint = agent_set.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch
    )]
    pub agent_set: Account<'info, AgentSet>,
}

#[derive(Accounts)]
pub struct ApplyAgentRotation<'info> {
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
        seeds = [AGENT_SET_SEED, dao_registry.key().as_ref()],
        bump = agent_set.bump,
        constraint = agent_set.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch
    )]
    pub agent_set: Account<'info, AgentSet>,
}

pub fn emergency_freeze_handler(ctx: Context<EmergencyFreeze>, action_nonce: u64) -> Result<()> {
    require_not_paused(&ctx.accounts.global_config)?;
    let guardian_key = ctx.accounts.guardian.key();

    let guardian_action = &mut ctx.accounts.guardian_action;
    require!(!guardian_action.executed, NaveError::Unauthorized);
    if guardian_action.signature_count == 0 {
        // SOL-H1: only a LIVE guardian may OPEN an action, and doing so
        // snapshots the current guardian set + threshold. Every subsequent
        // signature is validated against that immutable snapshot (via
        // `guardian_index` below), never the live `guardian_config`, so a
        // founder can no longer neutralize an in-flight safety action by
        // swapping guardians mid-accumulation.
        require_guardian(&guardian_key, &ctx.accounts.guardian_config)?;
        guardian_action.bump = ctx.bumps.guardian_action;
        guardian_action.dao = ctx.accounts.dao_registry.key();
        guardian_action.action_type = GUARDIAN_ACTION_FREEZE;
        guardian_action.threshold = ctx.accounts.guardian_config.threshold;
        guardian_action.nonce = action_nonce;
        guardian_action.signed_mask = 0;
        guardian_action.signature_count = 0;
        guardian_action.executed = false;
        guardian_action.created_at = Clock::get()?.unix_timestamp;
        guardian_action.wallet_count = ctx.accounts.guardian_config.wallet_count;
        guardian_action.wallets = ctx.accounts.guardian_config.wallets;
    } else {
        require!(
            guardian_action.action_type == GUARDIAN_ACTION_FREEZE,
            NaveError::Unauthorized
        );
        require!(guardian_action.nonce == action_nonce, NaveError::Unauthorized);
    }

    let idx = guardian_action
        .guardian_index(&guardian_key)
        .ok_or(NaveError::GuardianNotFound)?;
    guardian_action.record_signature(idx)?;

    if guardian_action.signature_count >= guardian_action.threshold {
        let dao_registry = &mut ctx.accounts.dao_registry;
        dao_registry.frozen = true;
        dao_registry.updated_at = Clock::get()?.unix_timestamp;
        guardian_action.executed = true;

        emit!(DaoEmergencyFrozen {
            dao: dao_registry.key(),
            triggered_by: guardian_key,
        });
    }

    Ok(())
}

pub fn emergency_unfreeze_handler(ctx: Context<EmergencyUnfreeze>, action_nonce: u64) -> Result<()> {
    require_not_paused(&ctx.accounts.global_config)?;
    let guardian_key = ctx.accounts.guardian.key();

    let guardian_action = &mut ctx.accounts.guardian_action;
    require!(!guardian_action.executed, NaveError::Unauthorized);
    if guardian_action.signature_count == 0 {
        // SOL-H1: see emergency_freeze_handler — signer set is snapshotted at
        // open and enforced from the snapshot thereafter.
        require_guardian(&guardian_key, &ctx.accounts.guardian_config)?;
        guardian_action.bump = ctx.bumps.guardian_action;
        guardian_action.dao = ctx.accounts.dao_registry.key();
        guardian_action.action_type = GUARDIAN_ACTION_UNFREEZE;
        guardian_action.threshold = ctx.accounts.guardian_config.threshold;
        guardian_action.nonce = action_nonce;
        guardian_action.signed_mask = 0;
        guardian_action.signature_count = 0;
        guardian_action.executed = false;
        guardian_action.created_at = Clock::get()?.unix_timestamp;
        guardian_action.wallet_count = ctx.accounts.guardian_config.wallet_count;
        guardian_action.wallets = ctx.accounts.guardian_config.wallets;
    } else {
        require!(
            guardian_action.action_type == GUARDIAN_ACTION_UNFREEZE,
            NaveError::Unauthorized
        );
        require!(guardian_action.nonce == action_nonce, NaveError::Unauthorized);
    }

    let idx = guardian_action
        .guardian_index(&guardian_key)
        .ok_or(NaveError::GuardianNotFound)?;
    guardian_action.record_signature(idx)?;

    if guardian_action.signature_count >= guardian_action.threshold {
        let dao_registry = &mut ctx.accounts.dao_registry;
        dao_registry.frozen = false;
        dao_registry.updated_at = Clock::get()?.unix_timestamp;
        guardian_action.executed = true;

        emit!(DaoEmergencyUnfrozen {
            dao: dao_registry.key(),
            triggered_by: guardian_key,
        });
    }

    Ok(())
}

#[derive(Accounts)]
#[instruction(action_nonce: u64)]
pub struct EmergencyFreeze<'info> {
    #[account(mut)]
    pub guardian: Signer<'info>,

    #[account(seeds = [GLOBAL_CONFIG_SEED], bump = global_config.bump)]
    pub global_config: Account<'info, NaveGlobalConfig>,

    #[account(
        mut,
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
        init_if_needed,
        payer = guardian,
        space = GuardianAction::LEN,
        seeds = [
            GUARDIAN_ACTION_SEED,
            dao_registry.key().as_ref(),
            &[GUARDIAN_ACTION_FREEZE],
            &action_nonce.to_le_bytes(),
        ],
        bump
    )]
    pub guardian_action: Account<'info, GuardianAction>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(action_nonce: u64)]
pub struct EmergencyUnfreeze<'info> {
    #[account(mut)]
    pub guardian: Signer<'info>,

    #[account(seeds = [GLOBAL_CONFIG_SEED], bump = global_config.bump)]
    pub global_config: Account<'info, NaveGlobalConfig>,

    #[account(
        mut,
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
        init_if_needed,
        payer = guardian,
        space = GuardianAction::LEN,
        seeds = [
            GUARDIAN_ACTION_SEED,
            dao_registry.key().as_ref(),
            &[GUARDIAN_ACTION_UNFREEZE],
            &action_nonce.to_le_bytes(),
        ],
        bump
    )]
    pub guardian_action: Account<'info, GuardianAction>,

    pub system_program: Program<'info, System>,
}

pub fn toggle_agents_handler(ctx: Context<ToggleAgents>, enabled: bool) -> Result<()> {
    require_not_paused(&ctx.accounts.global_config)?;
    // Re-enabling the autonomous pipeline is an Executive operation. *Disabling*
    // (break-glass) is a unilateral kill-switch and must instead go through the
    // guardian M-of-N `guardian_disable_agents` path so no single key can halt
    // a DAO's agents. (NE-6)
    require!(enabled, NaveError::AgentsDisableRequiresGuardians);
    crate::utils::require_agent_authority(
        &ctx.accounts.authority.key(),
        &ctx.accounts.agent_set,
        AgentRole::Executive,
    )?;

    let agent_set = &mut ctx.accounts.agent_set;
    agent_set.agents_enabled = enabled;

    let dao_registry = &mut ctx.accounts.dao_registry;
    dao_registry.agents_enabled = enabled;
    dao_registry.updated_at = Clock::get()?.unix_timestamp;

    emit!(AgentsToggled {
        dao: dao_registry.key(),
        enabled,
    });

    Ok(())
}

/// Break-glass kill-switch: disable the autonomous agent pipeline once a guardian
/// M-of-N threshold of signatures has accumulated. Mirrors the freeze accumulation
/// model. Re-enabling stays an Executive op via `toggle_agents`.
pub fn guardian_disable_agents_handler(
    ctx: Context<GuardianDisableAgents>,
    action_nonce: u64,
) -> Result<()> {
    require_not_paused(&ctx.accounts.global_config)?;
    let guardian_key = ctx.accounts.guardian.key();

    let guardian_action = &mut ctx.accounts.guardian_action;
    require!(!guardian_action.executed, NaveError::Unauthorized);
    if guardian_action.signature_count == 0 {
        // SOL-H1: see emergency_freeze_handler — signer set snapshotted at open.
        require_guardian(&guardian_key, &ctx.accounts.guardian_config)?;
        guardian_action.bump = ctx.bumps.guardian_action;
        guardian_action.dao = ctx.accounts.dao_registry.key();
        guardian_action.action_type = GUARDIAN_ACTION_DISABLE_AGENTS;
        guardian_action.threshold = ctx.accounts.guardian_config.threshold;
        guardian_action.nonce = action_nonce;
        guardian_action.signed_mask = 0;
        guardian_action.signature_count = 0;
        guardian_action.executed = false;
        guardian_action.created_at = Clock::get()?.unix_timestamp;
        guardian_action.wallet_count = ctx.accounts.guardian_config.wallet_count;
        guardian_action.wallets = ctx.accounts.guardian_config.wallets;
    } else {
        require!(
            guardian_action.action_type == GUARDIAN_ACTION_DISABLE_AGENTS,
            NaveError::Unauthorized
        );
        require!(guardian_action.nonce == action_nonce, NaveError::Unauthorized);
    }

    let idx = guardian_action
        .guardian_index(&guardian_key)
        .ok_or(NaveError::GuardianNotFound)?;
    guardian_action.record_signature(idx)?;

    if guardian_action.signature_count >= guardian_action.threshold {
        let agent_set = &mut ctx.accounts.agent_set;
        agent_set.agents_enabled = false;

        let dao_registry = &mut ctx.accounts.dao_registry;
        dao_registry.agents_enabled = false;
        dao_registry.updated_at = Clock::get()?.unix_timestamp;
        guardian_action.executed = true;

        emit!(AgentsToggled {
            dao: dao_registry.key(),
            enabled: false,
        });
    }

    Ok(())
}

/// Instant single-actor pause for the autonomous agent pipeline. Unlike the
/// guardian M-of-N `guardian_disable_agents` break-glass, this lets EITHER the
/// founder OR any single guardian halt the agents immediately (no threshold,
/// no accumulation window). Disconnecting a DAO from the agents is intentionally
/// low-friction; resuming them is the high-friction path (governance proposal +
/// executive `toggle_agents`). Scoped per-DAO — never affects other DAOs.
pub fn emergency_pause_agents_handler(ctx: Context<EmergencyPauseAgents>) -> Result<()> {
    require_not_paused(&ctx.accounts.global_config)?;
    let signer = ctx.accounts.authority.key();
    let is_founder = signer == ctx.accounts.dao_registry.founder;
    let is_guardian = ctx.accounts.guardian_config.is_guardian(&signer);
    require!(is_founder || is_guardian, NaveError::Unauthorized);

    let agent_set = &mut ctx.accounts.agent_set;
    agent_set.agents_enabled = false;

    let dao_registry = &mut ctx.accounts.dao_registry;
    dao_registry.agents_enabled = false;
    dao_registry.updated_at = Clock::get()?.unix_timestamp;

    emit!(AgentsToggled {
        dao: dao_registry.key(),
        enabled: false,
    });

    Ok(())
}

#[derive(Accounts)]
#[instruction(action_nonce: u64)]
pub struct GuardianDisableAgents<'info> {
    #[account(mut)]
    pub guardian: Signer<'info>,

    #[account(seeds = [GLOBAL_CONFIG_SEED], bump = global_config.bump)]
    pub global_config: Account<'info, NaveGlobalConfig>,

    #[account(
        mut,
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
        init_if_needed,
        payer = guardian,
        space = GuardianAction::LEN,
        seeds = [
            GUARDIAN_ACTION_SEED,
            dao_registry.key().as_ref(),
            &[GUARDIAN_ACTION_DISABLE_AGENTS],
            &action_nonce.to_le_bytes(),
        ],
        bump
    )]
    pub guardian_action: Account<'info, GuardianAction>,

    #[account(
        mut,
        seeds = [AGENT_SET_SEED, dao_registry.key().as_ref()],
        bump = agent_set.bump,
        constraint = agent_set.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch
    )]
    pub agent_set: Account<'info, AgentSet>,

    pub system_program: Program<'info, System>,
}

/// Founder-callable garbage-collection for `GuardianAction` PDAs: closes a
/// finished or abandoned action and refunds its rent to the founder. An action
/// may be closed when it has already EXECUTED (rent is just being reclaimed) or
/// when it is UNEXECUTED but older than `GUARDIAN_ACTION_STALE_SECS` (a stale,
/// never-completed accumulation). The staleness gate is what keeps this from
/// becoming a guardian-bypass: the founder cannot cancel a *fresh* in-flight
/// guardian action (e.g. an emergency freeze that is still gathering the M-of-N
/// signatures), so the guardian kill-switches retain their fail-closed power.
pub fn cancel_guardian_action_handler(ctx: Context<CancelGuardianAction>) -> Result<()> {
    require_not_paused(&ctx.accounts.global_config)?;
    require_founder(&ctx.accounts.authority.key(), &ctx.accounts.dao_registry)?;

    let ga = &ctx.accounts.guardian_action;
    require!(
        ga.dao == ctx.accounts.dao_registry.key(),
        NaveError::DaoOwnershipMismatch
    );

    if !ga.executed {
        let now = Clock::get()?.unix_timestamp;
        let stale_at = ga
            .created_at
            .checked_add(crate::constants::GUARDIAN_ACTION_STALE_SECS)
            .ok_or(NaveError::MathOverflow)?;
        require!(now >= stale_at, NaveError::GuardianActionNotStale);
    }

    emit!(crate::events::GuardianActionCancelled {
        dao: ga.dao,
        guardian_action: ga.key(),
        action_type: ga.action_type,
        nonce: ga.nonce,
        executed: ga.executed,
        cancelled_by: ctx.accounts.authority.key(),
    });

    // Account is closed (rent refunded to `authority`) via the `close`
    // constraint on the accounts struct.
    Ok(())
}

#[derive(Accounts)]
pub struct CancelGuardianAction<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(seeds = [GLOBAL_CONFIG_SEED], bump = global_config.bump)]
    pub global_config: Account<'info, NaveGlobalConfig>,

    #[account(
        seeds = [DAO_REGISTRY_SEED, dao_registry.founder.as_ref(), &dao_registry.dao_id.to_le_bytes()],
        bump = dao_registry.bump
    )]
    pub dao_registry: Account<'info, DaoRegistry>,

    /// The guardian action PDA being closed. Passed by address; its `dao` field
    /// is verified against `dao_registry` in the handler so a founder can only
    /// close their own DAO's actions. Rent is refunded to `authority`.
    #[account(
        mut,
        close = authority,
        constraint = guardian_action.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch
    )]
    pub guardian_action: Account<'info, GuardianAction>,
}

#[derive(Accounts)]
pub struct ToggleAgents<'info> {
    pub authority: Signer<'info>,

    #[account(seeds = [GLOBAL_CONFIG_SEED], bump = global_config.bump)]
    pub global_config: Account<'info, NaveGlobalConfig>,

    #[account(
        mut,
        seeds = [DAO_REGISTRY_SEED, dao_registry.founder.as_ref(), &dao_registry.dao_id.to_le_bytes()],
        bump = dao_registry.bump
    )]
    pub dao_registry: Account<'info, DaoRegistry>,

    #[account(
        mut,
        seeds = [AGENT_SET_SEED, dao_registry.key().as_ref()],
        bump = agent_set.bump,
        constraint = agent_set.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch
    )]
    pub agent_set: Account<'info, AgentSet>,
}

#[derive(Accounts)]
pub struct EmergencyPauseAgents<'info> {
    pub authority: Signer<'info>,

    #[account(seeds = [GLOBAL_CONFIG_SEED], bump = global_config.bump)]
    pub global_config: Account<'info, NaveGlobalConfig>,

    #[account(
        mut,
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
        seeds = [AGENT_SET_SEED, dao_registry.key().as_ref()],
        bump = agent_set.bump,
        constraint = agent_set.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch
    )]
    pub agent_set: Account<'info, AgentSet>,
}

/// SOL-H2: Nullify (permanently retire) an agent slot and freeze the DAO.
///
/// Previously this required only the Executive agent's OWN signature yet
/// unconditionally set `dao_registry.frozen = true`. A compromised Executive
/// could therefore self-create the `frozen` condition and combine it with
/// `nave_execution::execute_strategy_direct` (whose break-glass path is
/// unlocked by `frozen`) to skip the mandatory review window on an
/// already-approved request. Nullification is now a guardian M-of-N action
/// (mirroring `guardian_disable_agents` / `emergency_freeze`), so the freeze it
/// produces always originates from the guardian quorum, never a single agent
/// key. Restoring an agent (`restore_agent`) remains an Executive recovery op
/// because it does NOT touch the freeze flag.
pub fn nullify_agent_handler(
    ctx: Context<NullifyAgent>,
    role: u8,
    action_nonce: u64,
) -> Result<()> {
    require_not_paused(&ctx.accounts.global_config)?;
    let agent_role = AgentRole::from_u8(role).ok_or(NaveError::InvalidAgentRole)?;
    let guardian_key = ctx.accounts.guardian.key();

    let guardian_action = &mut ctx.accounts.guardian_action;
    require!(!guardian_action.executed, NaveError::Unauthorized);
    if guardian_action.signature_count == 0 {
        // SOL-H1: only a live guardian may open the action; the guardian set is
        // snapshotted here and enforced from the snapshot for every subsequent
        // signature.
        require_guardian(&guardian_key, &ctx.accounts.guardian_config)?;
        guardian_action.bump = ctx.bumps.guardian_action;
        guardian_action.dao = ctx.accounts.dao_registry.key();
        guardian_action.action_type = GUARDIAN_ACTION_NULLIFY_AGENT;
        guardian_action.threshold = ctx.accounts.guardian_config.threshold;
        guardian_action.nonce = action_nonce;
        guardian_action.signed_mask = 0;
        guardian_action.signature_count = 0;
        guardian_action.executed = false;
        guardian_action.created_at = Clock::get()?.unix_timestamp;
        guardian_action.wallet_count = ctx.accounts.guardian_config.wallet_count;
        guardian_action.wallets = ctx.accounts.guardian_config.wallets;
    } else {
        require!(
            guardian_action.action_type == GUARDIAN_ACTION_NULLIFY_AGENT,
            NaveError::Unauthorized
        );
        require!(guardian_action.nonce == action_nonce, NaveError::Unauthorized);
    }

    let idx = guardian_action
        .guardian_index(&guardian_key)
        .ok_or(NaveError::GuardianNotFound)?;
    guardian_action.record_signature(idx)?;

    if guardian_action.signature_count >= guardian_action.threshold {
        let agent_set = &mut ctx.accounts.agent_set;
        let slot = agent_set.get_agent_mut(agent_role);
        require!(!slot.nullified, NaveError::AgentAlreadyNullified);
        slot.nullified = true;
        slot.active = false;
        let nullified_authority = slot.authority;

        let dao_registry = &mut ctx.accounts.dao_registry;
        dao_registry.frozen = true;
        dao_registry.updated_at = Clock::get()?.unix_timestamp;
        guardian_action.executed = true;

        emit!(AgentNullified {
            dao: dao_registry.key(),
            role,
            agent: nullified_authority,
        });
    }

    Ok(())
}

pub fn restore_agent_handler(ctx: Context<RestoreAgent>, role: u8) -> Result<()> {
    require_not_paused(&ctx.accounts.global_config)?;
    let agent_role = AgentRole::from_u8(role).ok_or(NaveError::InvalidAgentRole)?;
    crate::utils::require_agent_authority(
        &ctx.accounts.authority.key(),
        &ctx.accounts.agent_set,
        AgentRole::Executive,
    )?;

    let agent_set = &mut ctx.accounts.agent_set;
    let slot = agent_set.get_agent_mut(agent_role);
    require!(slot.nullified, NaveError::Unauthorized);
    slot.nullified = false;
    slot.active = true;
    let restored_authority = slot.authority;

    // Restoring an agent does NOT automatically lift a DAO freeze. The freeze
    // flag is set by both `nullify_agent` (executive path) and guardian
    // `emergency_freeze` (M-of-N path). Auto-unfreezing here would allow an
    // executive to bypass an active guardian freeze by cycling nullify→restore
    // on an agent slot. All unfreezes must go through guardian M-of-N
    // `emergency_unfreeze` so the guardian quorum retains sole authority over
    // the freeze state.

    emit!(AgentRestored {
        dao: ctx.accounts.dao_registry.key(),
        role,
        agent: restored_authority,
    });

    Ok(())
}

#[derive(Accounts)]
#[instruction(role: u8, action_nonce: u64)]
pub struct NullifyAgent<'info> {
    #[account(mut)]
    pub guardian: Signer<'info>,

    #[account(seeds = [GLOBAL_CONFIG_SEED], bump = global_config.bump)]
    pub global_config: Account<'info, NaveGlobalConfig>,

    #[account(
        mut,
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
        init_if_needed,
        payer = guardian,
        space = GuardianAction::LEN,
        seeds = [
            GUARDIAN_ACTION_SEED,
            dao_registry.key().as_ref(),
            &[GUARDIAN_ACTION_NULLIFY_AGENT],
            &[role],
            &action_nonce.to_le_bytes(),
        ],
        bump
    )]
    pub guardian_action: Account<'info, GuardianAction>,

    #[account(
        mut,
        seeds = [AGENT_SET_SEED, dao_registry.key().as_ref()],
        bump = agent_set.bump,
        constraint = agent_set.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch
    )]
    pub agent_set: Account<'info, AgentSet>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RestoreAgent<'info> {
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
        seeds = [AGENT_SET_SEED, dao_registry.key().as_ref()],
        bump = agent_set.bump,
        constraint = agent_set.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch
    )]
    pub agent_set: Account<'info, AgentSet>,
}

pub fn update_agent_status_handler(
    ctx: Context<UpdateAgentStatus>,
    agent_slot: u8,
    new_status: u8,
    action_nonce: u64,
) -> Result<()> {
    require_not_paused(&ctx.accounts.global_config)?;
    require!((agent_slot as usize) < AGENT_COUNT, NaveError::InvalidAgentSlot);
    require!(
        AgentStatus::from_u8(new_status).is_some(),
        NaveError::InvalidAgentStatus
    );

    let guardian_key = ctx.accounts.guardian.key();

    let guardian_action = &mut ctx.accounts.guardian_action;
    require!(!guardian_action.executed, NaveError::Unauthorized);
    if guardian_action.signature_count == 0 {
        // SOL-H1: see emergency_freeze_handler — signer set snapshotted at open.
        require_guardian(&guardian_key, &ctx.accounts.guardian_config)?;
        guardian_action.bump = ctx.bumps.guardian_action;
        guardian_action.dao = ctx.accounts.dao_registry.key();
        guardian_action.action_type = GUARDIAN_ACTION_UPDATE_AGENT_STATUS;
        guardian_action.threshold = ctx.accounts.guardian_config.threshold;
        guardian_action.nonce = action_nonce;
        guardian_action.signed_mask = 0;
        guardian_action.signature_count = 0;
        guardian_action.executed = false;
        guardian_action.created_at = Clock::get()?.unix_timestamp;
        guardian_action.wallet_count = ctx.accounts.guardian_config.wallet_count;
        guardian_action.wallets = ctx.accounts.guardian_config.wallets;
    } else {
        require!(
            guardian_action.action_type == GUARDIAN_ACTION_UPDATE_AGENT_STATUS,
            NaveError::Unauthorized
        );
        require!(guardian_action.nonce == action_nonce, NaveError::Unauthorized);
    }

    let idx = guardian_action
        .guardian_index(&guardian_key)
        .ok_or(NaveError::GuardianNotFound)?;
    guardian_action.record_signature(idx)?;

    if guardian_action.signature_count >= guardian_action.threshold {
        let slot_idx = agent_slot as usize;
        let agent_set = &mut ctx.accounts.agent_set;
        let old_status = agent_set.agents[slot_idx].status;
        agent_set.agents[slot_idx].status = new_status;
        guardian_action.executed = true;

        emit!(AgentStatusChangedEvent {
            dao: ctx.accounts.dao_registry.key(),
            agent_slot,
            old_status,
            new_status,
            timestamp: Clock::get()?.unix_timestamp,
        });
    }

    Ok(())
}

pub fn rotate_agent_key_handler(
    ctx: Context<RotateAgentKey>,
    agent_slot: u8,
    new_pubkey: Pubkey,
    action_nonce: u64,
) -> Result<()> {
    require_not_paused(&ctx.accounts.global_config)?;
    require!((agent_slot as usize) < AGENT_COUNT, NaveError::InvalidAgentSlot);
    require!(new_pubkey != Pubkey::default(), NaveError::Unauthorized);

    let guardian_key = ctx.accounts.guardian.key();

    let guardian_action = &mut ctx.accounts.guardian_action;
    require!(!guardian_action.executed, NaveError::Unauthorized);
    if guardian_action.signature_count == 0 {
        // SOL-H1: see emergency_freeze_handler — signer set snapshotted at open.
        require_guardian(&guardian_key, &ctx.accounts.guardian_config)?;
        guardian_action.bump = ctx.bumps.guardian_action;
        guardian_action.dao = ctx.accounts.dao_registry.key();
        guardian_action.action_type = GUARDIAN_ACTION_ROTATE_AGENT_KEY;
        guardian_action.threshold = ctx.accounts.guardian_config.threshold;
        guardian_action.nonce = action_nonce;
        guardian_action.signed_mask = 0;
        guardian_action.signature_count = 0;
        guardian_action.executed = false;
        guardian_action.created_at = Clock::get()?.unix_timestamp;
        guardian_action.wallet_count = ctx.accounts.guardian_config.wallet_count;
        guardian_action.wallets = ctx.accounts.guardian_config.wallets;
    } else {
        require!(
            guardian_action.action_type == GUARDIAN_ACTION_ROTATE_AGENT_KEY,
            NaveError::Unauthorized
        );
        require!(guardian_action.nonce == action_nonce, NaveError::Unauthorized);
    }

    let idx = guardian_action
        .guardian_index(&guardian_key)
        .ok_or(NaveError::GuardianNotFound)?;
    guardian_action.record_signature(idx)?;

    if guardian_action.signature_count >= guardian_action.threshold {
        let slot_idx = agent_slot as usize;
        let agent_set = &mut ctx.accounts.agent_set;
        require!(!agent_set.agents[slot_idx].nullified, NaveError::AgentNullified);

        let old_pubkey = agent_set.agents[slot_idx].authority;
        // Mark rotating, swap key, then return to active atomically.
        agent_set.agents[slot_idx].status = AgentStatus::Rotating as u8;
        agent_set.agents[slot_idx].authority = new_pubkey;
        agent_set.agents[slot_idx].active = true;
        agent_set.agents[slot_idx].status = AgentStatus::Active as u8;
        agent_set.pending_rotations[slot_idx] = PendingAgentRotation::default();
        guardian_action.executed = true;

        emit!(AgentKeyRotatedEvent {
            dao: ctx.accounts.dao_registry.key(),
            agent_slot,
            old_pubkey,
            new_pubkey,
            timestamp: Clock::get()?.unix_timestamp,
        });
    }

    Ok(())
}

#[derive(Accounts)]
#[instruction(agent_slot: u8, new_status: u8, action_nonce: u64)]
pub struct UpdateAgentStatus<'info> {
    #[account(mut)]
    pub guardian: Signer<'info>,

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
        init_if_needed,
        payer = guardian,
        space = GuardianAction::LEN,
        seeds = [
            GUARDIAN_ACTION_SEED,
            dao_registry.key().as_ref(),
            &[GUARDIAN_ACTION_UPDATE_AGENT_STATUS],
            &[agent_slot],
            &[new_status],
            &action_nonce.to_le_bytes(),
        ],
        bump
    )]
    pub guardian_action: Account<'info, GuardianAction>,

    #[account(
        mut,
        seeds = [AGENT_SET_SEED, dao_registry.key().as_ref()],
        bump = agent_set.bump,
        constraint = agent_set.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch
    )]
    pub agent_set: Account<'info, AgentSet>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(agent_slot: u8, new_pubkey: Pubkey, action_nonce: u64)]
pub struct RotateAgentKey<'info> {
    #[account(mut)]
    pub guardian: Signer<'info>,

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
        init_if_needed,
        payer = guardian,
        space = GuardianAction::LEN,
        seeds = [
            GUARDIAN_ACTION_SEED,
            dao_registry.key().as_ref(),
            &[GUARDIAN_ACTION_ROTATE_AGENT_KEY],
            &[agent_slot],
            new_pubkey.as_ref(),
            &action_nonce.to_le_bytes(),
        ],
        bump
    )]
    pub guardian_action: Account<'info, GuardianAction>,

    #[account(
        mut,
        seeds = [AGENT_SET_SEED, dao_registry.key().as_ref()],
        bump = agent_set.bump,
        constraint = agent_set.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch
    )]
    pub agent_set: Account<'info, AgentSet>,

    pub system_program: Program<'info, System>,
}
