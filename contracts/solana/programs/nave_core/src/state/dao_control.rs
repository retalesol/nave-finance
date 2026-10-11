use anchor_lang::prelude::*;

use crate::constants::AGENT_COUNT;

pub const GUARDIAN_CHANGE_NONE: u8 = 0;
pub const GUARDIAN_CHANGE_ROTATE_KEY: u8 = 1;
pub const GUARDIAN_CHANGE_SET_STATUS: u8 = 2;

/// A guardian-quorum agent change waiting out `GUARDIAN_AGENT_CHANGE_DELAY_SECS`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, Debug)]
pub struct PendingGuardianAgentChange {
    /// `GUARDIAN_CHANGE_*`.
    pub kind: u8,
    /// New authority for `ROTATE_KEY`.
    pub new_authority: Pubkey,
    /// New status for `SET_STATUS`.
    pub new_status: u8,
    pub effective_at: i64,
}

/// Per-DAO agent-safety state. Companion PDA to `DaoRegistry`/`AgentSet`
/// (seeds `["dao_control", dao]`), created lazily so existing account layouts
/// stay frozen across the program upgrade. A missing account reads as default.
#[account]
#[derive(Default)]
pub struct DaoControl {
    pub bump: u8,
    pub dao: Pubkey,
    /// Set by a guardian-quorum `guardian_disable_agents`; cleared only by
    /// `guardian_enable_agents`. While set, `toggle_agents(true)` reverts.
    pub guardian_locked: bool,
    /// Queued review-window reduction (0 = none).
    pub pending_review_window_secs: i64,
    pub review_window_effective_at: i64,
    pub pending_agent_changes: [PendingGuardianAgentChange; AGENT_COUNT],
    pub reserved: [u64; 8],
}

impl DaoControl {
    pub const LEN: usize = 8 + 1 + 32 + 1 + 8 + 8 + (AGENT_COUNT * (1 + 32 + 1 + 8)) + 64;

    /// Decode a seeds-pinned, possibly uninitialized `DaoControl` account.
    pub fn load(info: &AccountInfo) -> Result<Option<DaoControl>> {
        if info.data_is_empty() {
            return Ok(None);
        }
        require!(info.owner == &crate::ID, crate::errors::NaveError::Unauthorized);
        let data = info.try_borrow_data()?;
        Ok(Some(DaoControl::try_deserialize(&mut &data[..])?))
    }

    pub fn is_guardian_locked(info: &AccountInfo) -> Result<bool> {
        Ok(Self::load(info)?.map(|c| c.guardian_locked).unwrap_or(false))
    }
}
