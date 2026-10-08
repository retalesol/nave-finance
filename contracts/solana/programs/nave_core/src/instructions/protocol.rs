use anchor_lang::prelude::*;
use sha2::{Digest, Sha256};

use crate::constants::{
    gov_proposal_type, nave_governance_program, GovernanceType, DAO_REGISTRY_SEED,
    GLOBAL_CONFIG_SEED, GUARDIAN_CONFIG_SEED, MAX_GUARDIAN_THRESHOLD, MAX_GUARDIAN_WALLETS,
    PROTOCOL_FEE_VAULT_SEED, TOKEN_REGISTRY_SEED,
};
use crate::errors::NaveError;
use crate::state::{
    DaoRegistry, GovernanceProposalLayout, GuardianConfig, NaveGlobalConfig, ProtocolFeeVault,
    TokenRegistry,
};
use crate::utils::{require_dao_active, require_not_paused, verify_governance_caller};

/// One-time creation of the program-owned protocol fee vault PDA.
pub fn initialize_protocol_fee_vault_handler(
    ctx: Context<InitializeProtocolFeeVault>,
) -> Result<()> {
    require!(
        ctx.accounts.authority.key() == ctx.accounts.global_config.authority,
        NaveError::Unauthorized
    );

    let vault = &mut ctx.accounts.protocol_fee_vault;
    vault.bump = ctx.bumps.protocol_fee_vault;
    vault.total_collected = 0;
    vault.total_rewarded = 0;

    Ok(())
}

#[derive(Accounts)]
pub struct InitializeProtocolFeeVault<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(seeds = [GLOBAL_CONFIG_SEED], bump = global_config.bump)]
    pub global_config: Account<'info, NaveGlobalConfig>,

    #[account(
        init,
        payer = authority,
        space = ProtocolFeeVault::LEN,
        seeds = [PROTOCOL_FEE_VAULT_SEED],
        bump
    )]
    pub protocol_fee_vault: Account<'info, ProtocolFeeVault>,

    pub system_program: Program<'info, System>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct SwitchVotingSystemParams {
    /// Target governance model (0 = Wallet, 1 = Token).
    pub governance_type: u8,
    /// Voting token mint when switching to token governance (ignored for wallet).
    pub voting_token: Pubkey,
    /// New guardian wallets when switching to wallet governance (ignored for token).
    pub guardian_wallets: Vec<Pubkey>,
    /// New guardian threshold when switching to wallet governance.
    pub guardian_threshold: u8,
}

/// Wire encoding of `SwitchVotingSystemParams` bound to a proposal's
/// `payload_hash` (SOL-C2): `governance_type(1) ‖ voting_token(32) ‖
/// guardian_threshold(1) ‖ guardian_wallet_count(1) ‖ guardian_wallets(10×32,
/// zero-padded beyond count)`. Fixed length so a single `payload_len` check
/// bounds the whole decode. This is the preimage the app must build when
/// calling `nave_governance::create_proposal` for a `SwitchVotingSystem`
/// (type 7) proposal.
const SWITCH_VOTING_PAYLOAD_LEN: usize = 1 + 32 + 1 + 1 + (MAX_GUARDIAN_WALLETS * 32);

fn hash_switch_voting_payload(slice: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(slice);
    hasher.finalize().into()
}

/// Load a `nave_governance`-owned proposal account and verify it is a Passed,
/// finalized `SwitchVotingSystem` proposal bound to `dao`.
fn load_and_validate_switch_voting_proposal(
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
        prop.proposal_type == gov_proposal_type::SWITCH_VOTING_SYSTEM,
        NaveError::SwitchVotingSystemProposalInvalid
    );
    require!(
        prop.status == gov_proposal_type::STATUS_PASSED,
        NaveError::SwitchVotingSystemProposalInvalid
    );
    require!(prop.finalized_at > 0, NaveError::SwitchVotingSystemProposalInvalid);
    Ok(prop)
}

/// Decode + hash-verify the target governance configuration bound to a
/// validated `SwitchVotingSystem` proposal's payload.
fn parse_switch_voting_payload(prop: &GovernanceProposalLayout) -> Result<SwitchVotingSystemParams> {
    let plen = prop.payload_len as usize;
    require!(
        plen == SWITCH_VOTING_PAYLOAD_LEN,
        NaveError::SwitchVotingSystemProposalInvalid
    );
    let slice = &prop.payload[..plen];
    require!(
        hash_switch_voting_payload(slice) == prop.payload_hash,
        NaveError::SwitchVotingSystemPayloadMismatch
    );

    let governance_type = slice[0];
    let voting_token = Pubkey::new_from_array(slice[1..33].try_into().unwrap());
    let guardian_threshold = slice[33];
    let guardian_wallet_count = slice[34] as usize;
    require!(
        guardian_wallet_count <= MAX_GUARDIAN_WALLETS,
        NaveError::SwitchVotingSystemProposalInvalid
    );
    const WALLETS_START: usize = 35;
    let mut guardian_wallets = Vec::with_capacity(guardian_wallet_count);
    for i in 0..guardian_wallet_count {
        let start = WALLETS_START + i * 32;
        guardian_wallets.push(Pubkey::new_from_array(
            slice[start..start + 32].try_into().unwrap(),
        ));
    }

    Ok(SwitchVotingSystemParams {
        governance_type,
        voting_token,
        guardian_wallets,
        guardian_threshold,
    })
}

/// Switch the DAO between authorized-wallet and token-weighted voting.
///
/// SOL-C2: CPI-only from `nave_governance::execute_switch_voting_system`,
/// which is itself only callable against a `Passed`, finalized
/// `SwitchVotingSystem` proposal (70% quorum, see
/// `nave_governance::constants::SWITCH_VOTING_QUORUM_BPS`). The target
/// governance configuration is decoded straight from that proposal's bound
/// payload (see `parse_switch_voting_payload`) rather than trusted from a
/// caller-supplied argument, so this can no longer be invoked directly by
/// the founder (or anyone else) without a real ratified vote. Mirrors
/// `governance_transfer.rs`'s `load_and_validate_proposal` /
/// `parse_transfer_payload` pattern.
pub fn switch_voting_system_handler(ctx: Context<SwitchVotingSystem>) -> Result<()> {
    require_not_paused(&ctx.accounts.global_config)?;
    verify_governance_caller(
        &nave_governance_program::ID,
        &ctx.accounts.instructions_sysvar.to_account_info(),
    )?;
    require_dao_active(&ctx.accounts.dao_registry)?;

    let prop = load_and_validate_switch_voting_proposal(
        &ctx.accounts.proposal.to_account_info(),
        &ctx.accounts.dao_registry.key(),
    )?;
    let params = parse_switch_voting_payload(&prop)?;

    let gov_type = GovernanceType::from_u8(params.governance_type)
        .ok_or(NaveError::InvalidGovernanceType)?;

    match gov_type {
        GovernanceType::Token => {
            require!(
                ctx.accounts
                    .token_registry
                    .find_token_index(&params.voting_token)
                    .is_some(),
                NaveError::VotingTokenNotRegistered
            );
            let dao = &mut ctx.accounts.dao_registry;
            dao.governance_type = GovernanceType::Token as u8;
            dao.voting_token = params.voting_token;
            dao.updated_at = Clock::get()?.unix_timestamp;
        }
        GovernanceType::Wallet => {
            require!(
                !params.guardian_wallets.is_empty()
                    && params.guardian_wallets.len() <= MAX_GUARDIAN_WALLETS,
                NaveError::TooManyGuardianWallets
            );
            require!(
                params.guardian_threshold > 0
                    && params.guardian_threshold <= MAX_GUARDIAN_THRESHOLD
                    && (params.guardian_threshold as usize) <= params.guardian_wallets.len(),
                NaveError::InvalidGuardianThreshold
            );
            let unique = {
                let mut seen = params.guardian_wallets.clone();
                seen.sort();
                seen.dedup();
                seen.len() == params.guardian_wallets.len()
            };
            require!(unique, NaveError::DuplicateGuardianWallet);

            let guardian_config = &mut ctx.accounts.guardian_config;
            guardian_config.threshold = params.guardian_threshold;
            guardian_config.wallet_count = params.guardian_wallets.len() as u8;
            guardian_config.wallets = [Pubkey::default(); MAX_GUARDIAN_WALLETS];
            for (idx, wallet) in params.guardian_wallets.iter().enumerate() {
                guardian_config.wallets[idx] = *wallet;
            }
            // Governance-applied guardian set counts as bootstrap complete.
            if !guardian_config.bootstrapped {
                guardian_config.bootstrapped = true;
                emit!(crate::events::GuardiansBootstrapped {
                    dao: ctx.accounts.dao_registry.key(),
                    threshold: params.guardian_threshold,
                    wallet_count: params.guardian_wallets.len() as u8,
                });
            }

            let dao = &mut ctx.accounts.dao_registry;
            dao.governance_type = GovernanceType::Wallet as u8;
            dao.voting_token = Pubkey::default();
            dao.updated_at = Clock::get()?.unix_timestamp;

            emit!(crate::events::GuardianConfigUpdated {
                dao: ctx.accounts.dao_registry.key(),
                threshold: params.guardian_threshold,
                wallet_count: params.guardian_wallets.len() as u8,
            });
        }
    }

    emit!(crate::events::VotingSystemSwitched {
        dao: ctx.accounts.dao_registry.key(),
        governance_type: params.governance_type,
        voting_token: ctx.accounts.dao_registry.voting_token,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct SwitchVotingSystem<'info> {
    /// CHECK: instructions sysvar for CPI caller verification (SOL-C2: this
    /// instruction is CPI-only from `nave_governance`).
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions_sysvar: AccountInfo<'info>,

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
        seeds = [GUARDIAN_CONFIG_SEED, dao_registry.key().as_ref()],
        bump = guardian_config.bump,
        constraint = guardian_config.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch
    )]
    pub guardian_config: Account<'info, GuardianConfig>,

    #[account(
        seeds = [TOKEN_REGISTRY_SEED, dao_registry.key().as_ref()],
        bump = token_registry.bump,
        constraint = token_registry.dao == dao_registry.key() @ NaveError::DaoOwnershipMismatch
    )]
    pub token_registry: Account<'info, TokenRegistry>,

    /// CHECK: nave_governance-owned proposal account (validated in handler
    /// against `dao_registry`, proposal type, status, and payload hash).
    #[account(mut)]
    pub proposal: UncheckedAccount<'info>,
}
