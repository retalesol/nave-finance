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
    require!(account_dao == dao_registry, NaveError::DaoOwnershipMismatch);
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

pub fn require_guardian(
    signer: &Pubkey,
    guardian_config: &crate::state::GuardianConfig,
) -> Result<()> {
    require!(
        guardian_config.is_guardian(signer),
        NaveError::GuardianNotFound
    );
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

/// Agent keys must be nonzero, pairwise distinct, and never the founder or a
/// guardian, so one compromised key can't act in two lanes. Nullified slots
/// are skipped (their key is retired).
pub fn require_agent_keys_distinct(
    keys: &[Pubkey; crate::constants::AGENT_COUNT],
    skip: &[bool; crate::constants::AGENT_COUNT],
    founder: &Pubkey,
    guardian_config: &crate::state::GuardianConfig,
) -> Result<()> {
    for i in 0..keys.len() {
        if skip[i] {
            continue;
        }
        let k = &keys[i];
        require!(*k != Pubkey::default(), NaveError::AgentKeyConflict);
        require!(k != founder, NaveError::AgentKeyConflict);
        require!(!guardian_config.is_guardian(k), NaveError::AgentKeyConflict);
        for j in (i + 1)..keys.len() {
            if !skip[j] {
                require!(*k != keys[j], NaveError::AgentKeyConflict);
            }
        }
    }
    Ok(())
}

/// A guardian wallet may never also be a live agent key.
pub fn require_guardians_not_agents(wallets: &[Pubkey], agent_set: &AgentSet) -> Result<()> {
    for a in agent_set.agents.iter().filter(|a| !a.nullified) {
        require!(!wallets.contains(&a.authority), NaveError::AgentKeyConflict);
    }
    Ok(())
}

/// Creation-time check over raw params (no accounts exist yet).
pub fn require_agent_params_distinct(
    agents: &[Pubkey],
    founder: &Pubkey,
    guardian_wallets: &[Pubkey],
) -> Result<()> {
    for (i, k) in agents.iter().enumerate() {
        require!(*k != Pubkey::default(), NaveError::AgentKeyConflict);
        require!(k != founder, NaveError::AgentKeyConflict);
        require!(!guardian_wallets.contains(k), NaveError::AgentKeyConflict);
        require!(!agents[i + 1..].contains(k), NaveError::AgentKeyConflict);
    }
    Ok(())
}

/// Current agent keys with `slot` replaced by `new_key`.
pub fn agent_keys_with(
    agent_set: &AgentSet,
    slot: usize,
    new_key: Pubkey,
) -> (
    [Pubkey; crate::constants::AGENT_COUNT],
    [bool; crate::constants::AGENT_COUNT],
) {
    let mut keys = [Pubkey::default(); crate::constants::AGENT_COUNT];
    let mut skip = [false; crate::constants::AGENT_COUNT];
    for (i, a) in agent_set.agents.iter().enumerate() {
        keys[i] = a.authority;
        skip[i] = a.nullified;
    }
    keys[slot] = new_key;
    (keys, skip)
}

pub fn copy_fixed_bytes<const N: usize>(dest: &mut [u8; N], src: &[u8]) -> Result<usize> {
    require!(
        !src.is_empty() && src.len() <= N,
        NaveError::InvalidNameLength
    );
    dest.fill(0);
    dest[..src.len()].copy_from_slice(src);
    Ok(src.len())
}
