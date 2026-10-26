use anchor_lang::prelude::*;

use crate::constants::{AgentRole, AgentStatus, AGENT_COUNT};

/// Pending agent authority rotation awaiting timelock.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, Debug)]
pub struct PendingAgentRotation {
    /// Proposed new authority pubkey.
    pub pending_authority: Pubkey,
    /// Unix timestamp when rotation becomes effective.
    pub effective_at: i64,
}

/// Individual agent slot within a DAO agent set.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, Debug)]
pub struct AgentSlot {
    /// Agent role discriminator.
    pub role: u8,
    /// Agent authority pubkey.
    pub authority: Pubkey,
    /// Whether the agent is active.
    pub active: bool,
    /// Whether the agent has been nullified.
    pub nullified: bool,
    /// Operational status (0=Active, 1=Paused, 2=Revoked, 3=Rotating).
    pub status: u8,
}

impl AgentSlot {
    /// Whether the agent's status is Active.
    pub fn is_status_active(&self) -> bool {
        self.status == AgentStatus::Active as u8
    }

    pub fn is_operational(&self) -> bool {
        self.active
            && !self.nullified
            && self.is_status_active()
            && self.authority != Pubkey::default()
    }
}

/// Fixed four-role agent set for a DAO.
#[account]
pub struct AgentSet {
    /// PDA bump seed.
    pub bump: u8,
    /// Owning DAO registry key.
    pub dao: Pubkey,
    /// Exactly four agent roles.
    pub agents: [AgentSlot; AGENT_COUNT],
    /// Global agent enable flag.
    pub agents_enabled: bool,
    /// Pending rotations per agent role.
    pub pending_rotations: [PendingAgentRotation; AGENT_COUNT],
}

impl AgentSet {
    pub const LEN: usize =
        8 + 1 + 32 + (AGENT_COUNT * (1 + 32 + 1 + 1 + 1)) + 1 + (AGENT_COUNT * (32 + 8));

    pub fn get_agent(&self, role: AgentRole) -> &AgentSlot {
        &self.agents[role as usize]
    }

    pub fn get_agent_mut(&mut self, role: AgentRole) -> &mut AgentSlot {
        &mut self.agents[role as usize]
    }
}
