use anchor_lang::prelude::*;

use crate::errors::NaveError;
use crate::state::{AgentSet, DaoRegistry, NaveGlobalConfig};

pub fn require_not_paused(global_config: &NaveGlobalConfig) -> Result<()> {
    require!(!global_config.paused, NaveError::GlobalPaused);
    Ok(())
}

pub fn require_dao_active(dao_registry: &DaoRegistry) -> Result<()> {
    require!(!dao_registry.frozen, NaveError::DaoFrozen);
    Ok(())
}

pub fn require_agents_enabled(agent_set: &AgentSet) -> Result<()> {
    require!(agent_set.agents_enabled, NaveError::AgentsDisabled);
    Ok(())
}

pub fn validate_dao_ownership(account_dao: &Pubkey, dao_registry: &Pubkey) -> Result<()> {
    require!(
        account_dao == dao_registry,
        NaveError::DaoOwnershipMismatch
    );
    Ok(())
}

pub fn validate_bump(stored_bump: u8, expected_bump: u8) -> Result<()> {
    require!(stored_bump == expected_bump, NaveError::InvalidBump);
    Ok(())
}

pub fn require_founder(signer: &Pubkey, dao_registry: &DaoRegistry) -> Result<()> {
    require!(signer == &dao_registry.founder, NaveError::Unauthorized);
    Ok(())
}

pub fn require_guardian(signer: &Pubkey, guardian_config: &crate::state::GuardianConfig) -> Result<()> {
    require!(guardian_config.is_guardian(signer), NaveError::GuardianNotFound);
    Ok(())
}

pub fn require_agent_authority(
    signer: &Pubkey,
    agent_set: &AgentSet,
    role: crate::constants::AgentRole,
) -> Result<()> {
    let slot = agent_set.get_agent(role);
    require!(slot.is_operational(), NaveError::AgentNullified);
    require!(signer == &slot.authority, NaveError::Unauthorized);
    Ok(())
}

pub fn copy_fixed_bytes<const N: usize>(dest: &mut [u8; N], src: &[u8]) -> Result<usize> {
    require!(!src.is_empty() && src.len() <= N, NaveError::InvalidNameLength);
    dest.fill(0);
    dest[..src.len()].copy_from_slice(src);
    Ok(src.len())
}
