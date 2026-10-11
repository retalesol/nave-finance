use anchor_lang::prelude::*;

pub const EXECUTION_REQUEST_SEED: &[u8] = b"execution_request";

pub const MAX_TX_PAYLOAD_HASH_LEN: usize = 32;
pub const REVIEW_WINDOW_SECONDS: i64 = nave_core::constants::DEFAULT_REVIEW_WINDOW_SECONDS;

/// Maximum age (seconds) of the treasury NAV (`TreasuryVault.last_revalued_at`)
/// accepted when deploying capital into a strategy. The USD-denominated
/// allocation / deployment-cap / liquidity-floor / reserve checks are only
/// meaningful against a fresh NAV; a deploy whose NAV snapshot is older than
/// this (or has never been computed) is hard-blocked with `StaleNav` so a
/// caller must run `revalue_treasury` first. 15 minutes.
pub const NAV_MAX_STALENESS_SECS: i64 = 900;

#[repr(u8)]
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum ExecutionStatus {
    Pending = 0,
    ExecutiveApproved = 1,
    FinancialApproved = 2,
    OversightApproved = 3,
    InReview = 4,
    Executed = 5,
    Halted = 6,
    Expired = 7,
}

impl ExecutionStatus {
    pub fn from_u8(value: u8) -> Option<Self> {
        match value {
            0 => Some(Self::Pending),
            1 => Some(Self::ExecutiveApproved),
            2 => Some(Self::FinancialApproved),
            3 => Some(Self::OversightApproved),
            4 => Some(Self::InReview),
            5 => Some(Self::Executed),
            6 => Some(Self::Halted),
            7 => Some(Self::Expired),
            _ => None,
        }
    }
}
