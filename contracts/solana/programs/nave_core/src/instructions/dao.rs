use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{Mint, TokenAccount};

use crate::constants::{
    AgentRole, GovernanceType, PrivacyMode, AGENT_COUNT, AGENT_SET_SEED, CONSTITUTION_SEED,
    DAO_REGISTRY_SEED, DEFAULT_QUORUM_BPS, FEE_CONFIG_SEED, FORMATION_FEE_LAMPORTS,
    GLOBAL_CONFIG_SEED, GUARDIAN_CONFIG_SEED, MAX_GUARDIAN_THRESHOLD, MAX_GUARDIAN_WALLETS,
    TOKEN_REGISTRY_SEED, TREASURY_VAULT_SEED, VAULT_AUTHORITY_SEED,
};
use crate::errors::NaveError;
use crate::events::DaoInitialized;
use crate::state::{
    AgentSet, AgentSlot, DaoRegistry, FeeConfig, GuardianConfig, NaveGlobalConfig, TokenRegistry,
    TreasuryConstitution, TreasuryVault, VaultAuthority,
};
use crate::utils::{require_not_paused};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitializeDaoParams {
    pub name: String,
    pub guardian_wallets: Vec<Pubkey>,
    pub guardian_threshold: u8,
    pub agent_authorities: Vec<Pubkey>,
    pub management_fee_bps: u16,
    pub performance_fee_bps: u16,
    pub frozen_management_fee_bps: u16,
    pub frozen_performance_fee_bps: u16,
    pub privacy_mode: u8,
    pub fee_recipient: Pubkey,
    /// Protocol revenue wallet (owner account) receiving both the performance
    /// skim and the annual management fee. Required (non-default).
    pub protocol_revenue_wallet: Pubkey,
    pub quorum_bps: u16,
    /// Governance model selected at creation (0 = Wallet, 1 = Token).
    pub governance_type: u8,
}

pub fn initialize_dao_handler(ctx: Context<InitializeDao>, params: InitializeDaoParams) -> Result<()> {
    require_not_paused(&ctx.accounts.global_config)?;

    require!(
        !params.name.is_empty() && params.name.len() <= crate::constants::MAX_DAO_NAME_LEN,
        NaveError::InvalidNameLength
    );
    require!(
        !params.guardian_wallets.is_empty()
            && params.guardian_wallets.len() <= MAX_GUARDIAN_WALLETS,
        NaveError::TooManyGuardianWallets
    );
    require!(
        params.guardian_threshold > 0
            && params.guardian_threshold <= MAX_GUARDIAN_THRESHOLD
            && params.guardian_threshold as usize <= params.guardian_wallets.len(),
        NaveError::InvalidGuardianThreshold
    );
    require!(
        params.agent_authorities.len() == AGENT_COUNT,
        NaveError::InvalidAgentRole
    );
    FeeConfig::validate_bps(params.management_fee_bps, params.performance_fee_bps)?;
    FeeConfig::validate_bps(
        params.frozen_management_fee_bps,
        params.frozen_performance_fee_bps,
    )?;
    require!(
        PrivacyMode::from_u8(params.privacy_mode).is_some(),
        NaveError::InvalidPrivacyMode
    );
    require!(params.fee_recipient != Pubkey::default(), NaveError::InvalidFeeRecipient);
    require!(
        params.protocol_revenue_wallet != Pubkey::default(),
        NaveError::InvalidFeeRecipient
    );
    require!(
        params.quorum_bps > 0 && params.quorum_bps <= 10_000,
        NaveError::InvalidBps
    );
    require!(
        GovernanceType::from_u8(params.governance_type).is_some(),
        NaveError::InvalidGovernanceType
    );

    let unique_guardians = {
        let mut seen = params.guardian_wallets.clone();
        seen.sort();
        seen.dedup();
        seen.len() == params.guardian_wallets.len()
    };
    require!(unique_guardians, NaveError::DuplicateGuardianWallet);
    crate::utils::require_agent_params_distinct(
        &params.agent_authorities,
        &ctx.accounts.founder.key(),
        &params.guardian_wallets,
    )?;

    let global_config = &mut ctx.accounts.global_config;
    let dao_id = global_config.dao_count;
    global_config.dao_count = global_config
        .dao_count
        .checked_add(1)
        .ok_or(NaveError::MathOverflow)?;

    // Formation is now FEE-FREE: the protocol takes no profit at creation. The
    // old SOL formation fee has been replaced by a recoverable `$99`-of-NAVE
    // stake locked via `stake_dao_creation` immediately after this 3-step
    // creation flow (see `DaoStakeLock`). No SOL is moved here. The
    // `protocol_treasury` account is retained in the context only for account-
    // list / IDL stability with existing clients; it is not debited or credited.
    let _ = FORMATION_FEE_LAMPORTS; // retained constant (now 0); see constants.rs
    let _ = &ctx.accounts.protocol_treasury;

    let now = Clock::get()?.unix_timestamp;

    let dao_registry = &mut ctx.accounts.dao_registry;
    dao_registry.bump = ctx.bumps.dao_registry;
    dao_registry.dao_id = dao_id;
    dao_registry.founder = ctx.accounts.founder.key();
    dao_registry.set_name(params.name.as_bytes())?;
    dao_registry.privacy_mode = params.privacy_mode;
    dao_registry.frozen = false;
    dao_registry.agents_enabled = false;
    dao_registry.proposal_count = 0;
    dao_registry.archived_proposals = 0;
    dao_registry.next_proposal_index = 0;
    dao_registry.created_at = now;
    dao_registry.updated_at = now;
    dao_registry.quorum_bps = params.quorum_bps.max(DEFAULT_QUORUM_BPS);
    dao_registry.governance_type = params.governance_type;
    dao_registry.voting_token = Pubkey::default();
    // One-time founder bootstrap latch starts unused; flipped on the first
    // bootstrap execution request (see `record_bootstrap_usage`).
    dao_registry.bootstrap_used = false;

    let vault_authority = &mut ctx.accounts.vault_authority;
    vault_authority.bump = ctx.bumps.vault_authority;
    vault_authority.dao = dao_registry.key();

    let treasury_vault = &mut ctx.accounts.treasury_vault;
    treasury_vault.bump = ctx.bumps.treasury_vault;
    treasury_vault.dao = dao_registry.key();
    treasury_vault.vault_token_account = Pubkey::default();
    treasury_vault.total_deposited = 0;
    treasury_vault.total_withdrawn = 0;
    treasury_vault.current_nav = 0;
    treasury_vault.high_water_mark = 0;
    treasury_vault.last_management_fee_at = now;
    treasury_vault.last_performance_fee_at = now;
    treasury_vault.deployed_capital = 0;
    treasury_vault.asset_count = 0;
    treasury_vault.last_revalued_at = 0;

    emit!(DaoInitialized {
        dao: dao_registry.key(),
        dao_id,
        founder: dao_registry.founder,
        name_len: dao_registry.name_len,
    });

    Ok(())
}

pub fn initialize_dao_extensions_handler(
    ctx: Context<InitializeDaoExtensions>,
    params: InitializeDaoParams,
) -> Result<()> {
    require_not_paused(&ctx.accounts.global_config)?;
    require!(
        params.agent_authorities.len() == AGENT_COUNT,
        NaveError::InvalidAgentRole
    );
    crate::utils::require_agent_params_distinct(
        &params.agent_authorities,
        &ctx.accounts.dao_registry.founder,
        &params.guardian_wallets,
    )?;

    let agent_set = &mut ctx.accounts.agent_set;
    agent_set.bump = ctx.bumps.agent_set;
    agent_set.dao = ctx.accounts.dao_registry.key();
    agent_set.agents_enabled = false;
    agent_set.pending_rotations = [Default::default(); AGENT_COUNT];
    for (idx, role) in [
        AgentRole::Executive,
        AgentRole::Financial,
        AgentRole::Oversight,
        AgentRole::Operational,
    ]
    .iter()
    .enumerate()
    {
        agent_set.agents[idx] = AgentSlot {
            role: *role as u8,
            authority: params.agent_authorities[idx],
            active: true,
            nullified: false,
            status: crate::constants::AgentStatus::Active as u8,
        };
    }

    let fee_config = &mut ctx.accounts.fee_config;
    fee_config.bump = ctx.bumps.fee_config;
    fee_config.dao = ctx.accounts.dao_registry.key();
    fee_config.management_fee_bps = params.management_fee_bps;
    fee_config.performance_fee_bps = params.performance_fee_bps;
    fee_config.frozen_management_fee_bps = params.frozen_management_fee_bps;
    fee_config.frozen_performance_fee_bps = params.frozen_performance_fee_bps;
    fee_config.fee_recipient = params.fee_recipient;
    fee_config.fee_asset_mint = Pubkey::default();
    fee_config.protocol_revenue_wallet = params.protocol_revenue_wallet;

    let treasury_vault = &mut ctx.accounts.treasury_vault;
    treasury_vault.vault_token_account = ctx.accounts.vault_token_account.key();

    Ok(())
}

pub fn initialize_dao_governance_handler(
    ctx: Context<InitializeDaoGovernance>,
    params: InitializeDaoParams,
) -> Result<()> {
    require_not_paused(&ctx.accounts.global_config)?;
    crate::utils::require_guardians_not_agents(&params.guardian_wallets, &ctx.accounts.agent_set)?;

    let guardian_config = &mut ctx.accounts.guardian_config;
    guardian_config.bump = ctx.bumps.guardian_config;
    guardian_config.dao = ctx.accounts.dao_registry.key();
    guardian_config.threshold = params.guardian_threshold;
    guardian_config.wallet_count = params.guardian_wallets.len() as u8;
    guardian_config.wallets = [Pubkey::default(); MAX_GUARDIAN_WALLETS];
    for (idx, wallet) in params.guardian_wallets.iter().enumerate() {
        guardian_config.wallets[idx] = *wallet;
    }
    // ActivationHub one-shot remains available after creation; flipped on the
    // first founder `update_guardian_config` or Permission proposal execute.
    guardian_config.bootstrapped = false;

    let constitution = &mut ctx.accounts.constitution;
    constitution.bump = ctx.bumps.constitution;
    constitution.dao = ctx.accounts.dao_registry.key();
    constitution.protocol_count = 0;
    constitution.protocols = [Default::default(); crate::constants::MAX_CONSTITUTION_PROTOCOLS];
    constitution.confidence_threshold = crate::constants::DEFAULT_CONFIDENCE_THRESHOLD;
    constitution.review_window_secs = crate::constants::DEFAULT_REVIEW_WINDOW_SECONDS;
    // Seed continuous treasury policy with safe defaults (35% reserve / 50%
    // max deployed / 20% liquidity / 30-day rebalance cadence). Governance can
    // retune these via `set_policy_parameters`.
    constitution.min_stablecoin_reserve_bps =
        crate::constants::DEFAULT_MIN_STABLECOIN_RESERVE_BPS;
    constitution.max_total_deployed_bps = crate::constants::DEFAULT_MAX_TOTAL_DEPLOYED_BPS;
    constitution.min_liquidity_bps = crate::constants::DEFAULT_MIN_LIQUIDITY_BPS;
    constitution.rebalance_frequency_secs =
        crate::constants::DEFAULT_REBALANCE_FREQUENCY_SECONDS;
    constitution.last_rebalance_at = 0;
    // $100 default agent operating threshold (micro-USD).
    constitution.agent_threshold_usd = 100_000_000;
    // SOL-C3: seed non-zero `jupiter_swap` guardrails by default so a newly
    // created DAO is protected from the moment it exists, rather than only
    // after the founder remembers to opt in via `set_max_slippage_bps` /
    // `set_max_single_swap_bps` (both remain available to retune later).
    constitution.max_slippage_bps = crate::constants::DEFAULT_MAX_SLIPPAGE_BPS;
    constitution.max_single_swap_bps = crate::constants::DEFAULT_MAX_SINGLE_SWAP_BPS;

    let token_registry = &mut ctx.accounts.token_registry;
    token_registry.bump = ctx.bumps.token_registry;
    token_registry.dao = ctx.accounts.dao_registry.key();
    token_registry.token_count = 0;
    token_registry.tokens = [Default::default(); crate::constants::MAX_TOKEN_REGISTRY];

    Ok(())
}

#[derive(Accounts)]
#[instruction(params: InitializeDaoParams)]
pub struct InitializeDao<'info> {
    #[account(mut)]
    pub founder: Signer<'info>,

    #[account(
        mut,
        seeds = [GLOBAL_CONFIG_SEED],
        bump = global_config.bump
    )]
    pub global_config: Box<Account<'info, NaveGlobalConfig>>,

    /// CHECK: Protocol treasury receiving formation fee.
    #[account(
        mut,
        address = global_config.treasury @ NaveError::Unauthorized
    )]
    pub protocol_treasury: UncheckedAccount<'info>,

    #[account(
        init,
        payer = founder,
        space = DaoRegistry::LEN,
        seeds = [DAO_REGISTRY_SEED, founder.key().as_ref(), &global_config.dao_count.to_le_bytes()],
        bump
    )]
    pub dao_registry: Box<Account<'info, DaoRegistry>>,

    #[account(
        init,
        payer = founder,
        space = VaultAuthority::LEN,
        seeds = [VAULT_AUTHORITY_SEED, dao_registry.key().as_ref()],
        bump
    )]
    pub vault_authority: Box<Account<'info, VaultAuthority>>,

    #[account(
        init,
        payer = founder,
        space = TreasuryVault::LEN,
        seeds = [TREASURY_VAULT_SEED, dao_registry.key().as_ref()],
        bump
    )]
    pub treasury_vault: Box<Account<'info, TreasuryVault>>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(params: InitializeDaoParams)]
pub struct InitializeDaoExtensions<'info> {
    #[account(mut)]
    pub founder: Signer<'info>,

    #[account(seeds = [GLOBAL_CONFIG_SEED], bump = global_config.bump)]
    pub global_config: Box<Account<'info, NaveGlobalConfig>>,

    #[account(
        mut,
        seeds = [DAO_REGISTRY_SEED, dao_registry.founder.as_ref(), &dao_registry.dao_id.to_le_bytes()],
        bump = dao_registry.bump,
        has_one = founder @ NaveError::Unauthorized
    )]
    pub dao_registry: Box<Account<'info, DaoRegistry>>,

    #[account(
        mut,
        seeds = [TREASURY_VAULT_SEED, dao_registry.key().as_ref()],
        bump = treasury_vault.bump
    )]
    pub treasury_vault: Box<Account<'info, TreasuryVault>>,

    #[account(
        seeds = [VAULT_AUTHORITY_SEED, dao_registry.key().as_ref()],
        bump = vault_authority.bump
    )]
    pub vault_authority: Box<Account<'info, VaultAuthority>>,

    #[account(
        init_if_needed,
        payer = founder,
        associated_token::mint = vault_mint,
        associated_token::authority = vault_authority,
    )]
    pub vault_token_account: Box<Account<'info, TokenAccount>>,

    pub vault_mint: Box<Account<'info, Mint>>,

    #[account(
        init,
        payer = founder,
        space = AgentSet::LEN,
        seeds = [AGENT_SET_SEED, dao_registry.key().as_ref()],
        bump
    )]
    pub agent_set: Box<Account<'info, AgentSet>>,

    #[account(
        init,
        payer = founder,
        space = FeeConfig::LEN,
        seeds = [FEE_CONFIG_SEED, dao_registry.key().as_ref()],
        bump
    )]
    pub fee_config: Box<Account<'info, FeeConfig>>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, anchor_spl::token::Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

#[derive(Accounts)]
#[instruction(params: InitializeDaoParams)]
pub struct InitializeDaoGovernance<'info> {
    #[account(mut)]
    pub founder: Signer<'info>,

    #[account(seeds = [GLOBAL_CONFIG_SEED], bump = global_config.bump)]
    pub global_config: Box<Account<'info, NaveGlobalConfig>>,

    #[account(
        seeds = [DAO_REGISTRY_SEED, dao_registry.founder.as_ref(), &dao_registry.dao_id.to_le_bytes()],
        bump = dao_registry.bump,
        has_one = founder @ NaveError::Unauthorized
    )]
    pub dao_registry: Box<Account<'info, DaoRegistry>>,

    #[account(
        init,
        payer = founder,
        space = GuardianConfig::LEN,
        seeds = [GUARDIAN_CONFIG_SEED, dao_registry.key().as_ref()],
        bump
    )]
    pub guardian_config: Box<Account<'info, GuardianConfig>>,

    #[account(
        init,
        payer = founder,
        space = TreasuryConstitution::LEN,
        seeds = [CONSTITUTION_SEED, dao_registry.key().as_ref()],
        bump
    )]
    pub constitution: Box<Account<'info, TreasuryConstitution>>,

    #[account(
        init,
        payer = founder,
        space = TokenRegistry::LEN,
        seeds = [TOKEN_REGISTRY_SEED, dao_registry.key().as_ref()],
        bump
    )]
    pub token_registry: Box<Account<'info, TokenRegistry>>,

    #[account(
        seeds = [AGENT_SET_SEED, dao_registry.key().as_ref()],
        bump = agent_set.bump,
        constraint = agent_set.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch
    )]
    pub agent_set: Box<Account<'info, AgentSet>>,

    pub system_program: Program<'info, System>,
}

pub fn set_dao_privacy_handler(ctx: Context<SetDaoPrivacy>, privacy_mode: u8) -> Result<()> {
    require_not_paused(&ctx.accounts.global_config)?;
    require!(
        PrivacyMode::from_u8(privacy_mode).is_some(),
        NaveError::InvalidPrivacyMode
    );
    crate::utils::require_founder(&ctx.accounts.founder.key(), &ctx.accounts.dao_registry)?;

    let dao_registry = &mut ctx.accounts.dao_registry;
    dao_registry.privacy_mode = privacy_mode;
    dao_registry.updated_at = Clock::get()?.unix_timestamp;

    emit!(crate::events::DaoPrivacyUpdated {
        dao: dao_registry.key(),
        privacy_mode,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct SetDaoPrivacy<'info> {
    pub founder: Signer<'info>,

    #[account(seeds = [GLOBAL_CONFIG_SEED], bump = global_config.bump)]
    pub global_config: Account<'info, NaveGlobalConfig>,

    #[account(
        mut,
        seeds = [DAO_REGISTRY_SEED, dao_registry.founder.as_ref(), &dao_registry.dao_id.to_le_bytes()],
        bump = dao_registry.bump,
        has_one = founder @ NaveError::Unauthorized
    )]
    pub dao_registry: Account<'info, DaoRegistry>,
}

pub fn archive_proposals_handler(ctx: Context<ArchiveProposals>, count: u64) -> Result<()> {
    require_not_paused(&ctx.accounts.global_config)?;
    require!(count > 0, NaveError::InvalidArchiveCount);
    crate::utils::require_founder(&ctx.accounts.authority.key(), &ctx.accounts.dao_registry)?;

    let dao_registry = &mut ctx.accounts.dao_registry;
    dao_registry.proposal_count = dao_registry
        .proposal_count
        .checked_sub(count)
        .ok_or(NaveError::ProposalCountUnderflow)?;
    dao_registry.archived_proposals = dao_registry
        .archived_proposals
        .checked_add(count)
        .ok_or(NaveError::MathOverflow)?;
    dao_registry.updated_at = Clock::get()?.unix_timestamp;

    emit!(crate::events::ProposalsArchived {
        dao: dao_registry.key(),
        archived_count: count,
        remaining_proposal_count: dao_registry.proposal_count,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct ArchiveProposals<'info> {
    pub authority: Signer<'info>,

    #[account(seeds = [GLOBAL_CONFIG_SEED], bump = global_config.bump)]
    pub global_config: Account<'info, NaveGlobalConfig>,

    #[account(
        mut,
        seeds = [DAO_REGISTRY_SEED, dao_registry.founder.as_ref(), &dao_registry.dao_id.to_le_bytes()],
        bump = dao_registry.bump
    )]
    pub dao_registry: Account<'info, DaoRegistry>,
}

pub fn record_proposal_creation_handler(ctx: Context<RecordProposalCreation>) -> Result<()> {
    // CPI-only guard: verify the current top-level instruction is nave_governance,
    // not a direct external call. Without this, any account can pass
    // nave_governance_program::ID as `governance_program` (just an address check)
    // and inflate `proposal_count`, DoS-ing the DAO's governance.
    crate::utils::verify_governance_caller(
        &crate::constants::nave_governance_program::ID,
        &ctx.accounts.instructions,
    )?;

    let dao_registry = &mut ctx.accounts.dao_registry;
    // Active count: enforced against MAX_PROPOSALS_PER_DAO, decremented on archive.
    dao_registry.proposal_count = dao_registry
        .proposal_count
        .checked_add(1)
        .ok_or(NaveError::MathOverflow)?;
    // Monotonic index used for the proposal PDA seed; never decremented so an
    // archived slot's index can never collide with a freshly created proposal.
    dao_registry.next_proposal_index = dao_registry
        .next_proposal_index
        .checked_add(1)
        .ok_or(NaveError::MathOverflow)?;
    dao_registry.updated_at = Clock::get()?.unix_timestamp;

    emit!(crate::events::ProposalCountRecorded {
        dao: dao_registry.key(),
        proposal_count: dao_registry.proposal_count,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct RecordProposalCreation<'info> {
    #[account(
        mut,
        seeds = [DAO_REGISTRY_SEED, dao_registry.founder.as_ref(), &dao_registry.dao_id.to_le_bytes()],
        bump = dao_registry.bump,
    )]
    pub dao_registry: Account<'info, DaoRegistry>,

    /// CHECK: Must be the governance program invoking via CPI.
    #[account(
        address = crate::constants::nave_governance_program::ID @ NaveError::Unauthorized
    )]
    pub governance_program: AccountInfo<'info>,

    /// CHECK: Instructions sysvar for CPI caller verification (governance program must be
    /// the top-level instruction caller — verified in the handler via `verify_governance_caller`).
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID @ NaveError::Unauthorized)]
    pub instructions: AccountInfo<'info>,
}

/// Consume the DAO's one-time founder bootstrap latch. CPI-only from
/// `nave_execution` (mirrors the `record_proposal_creation` cross-program
/// pattern): the execution program calls this while building the first
/// bootstrap execution request so the zero-review-window path can be taken
/// exactly once. Requires the signing founder to match `dao_registry.founder`
/// and that the latch has not already been used. `DaoRegistry` lives in
/// nave_core, so only nave_core may mutate the flag — hence this CPI.
pub fn record_bootstrap_usage_handler(ctx: Context<RecordBootstrapUsage>) -> Result<()> {
    // SEC-M4: enforce that this is genuinely a CPI from nave_execution. The
    // `execution_program` address constraint below only proves an account
    // equals nave_execution's id — it does NOT prove nave_execution is the
    // caller, so a founder could previously invoke this directly (top-level)
    // and flip `bootstrap_used` outside the execution pipeline. Verify the
    // top-level instruction belongs to nave_execution via the instructions
    // sysvar (mirrors record_proposal_creation's governance-caller check).
    crate::utils::verify_execution_caller(
        &crate::constants::nave_execution_program::ID,
        &ctx.accounts.instructions,
    )?;

    let dao_registry = &mut ctx.accounts.dao_registry;
    require!(!dao_registry.bootstrap_used, NaveError::BootstrapAlreadyUsed);
    dao_registry.bootstrap_used = true;
    dao_registry.updated_at = Clock::get()?.unix_timestamp;

    emit!(crate::events::DaoBootstrapUsed {
        dao: dao_registry.key(),
        founder: dao_registry.founder,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct RecordBootstrapUsage<'info> {
    /// The DAO founder. Must sign (the signature propagates from the founder's
    /// `create_execution_request` call through the nave_execution CPI) and must
    /// match the registry founder.
    pub founder: Signer<'info>,

    #[account(
        mut,
        seeds = [DAO_REGISTRY_SEED, dao_registry.founder.as_ref(), &dao_registry.dao_id.to_le_bytes()],
        bump = dao_registry.bump,
        has_one = founder @ NaveError::Unauthorized,
    )]
    pub dao_registry: Account<'info, DaoRegistry>,

    /// CHECK: Must be the execution program invoking via CPI.
    #[account(
        address = crate::constants::nave_execution_program::ID @ NaveError::Unauthorized
    )]
    pub execution_program: AccountInfo<'info>,

    /// CHECK: instructions sysvar — SEC-M4 top-level-caller verification that
    /// this instruction is executing as a CPI from nave_execution.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions: AccountInfo<'info>,
}
