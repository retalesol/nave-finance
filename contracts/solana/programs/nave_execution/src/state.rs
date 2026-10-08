use anchor_lang::prelude::*;

use crate::constants::{ExecutionStatus, MAX_TX_PAYLOAD_HASH_LEN};

#[account]
pub struct ExecutionRequest {
    pub bump: u8,
    pub dao: Pubkey,
    pub request_index: u64,
    pub proposal: Pubkey,
    pub protocol_program: Pubkey,
    /// Asset mint this request deploys. Bound into the payload hash so the
    /// governance-approved proposal commits to (program, amount, mint).
    pub mint: Pubkey,
    pub status: u8,
    pub tx_payload_hash: [u8; MAX_TX_PAYLOAD_HASH_LEN],
    pub amount: u64,
    pub review_end: i64,
    pub created_at: i64,
    pub updated_at: i64,
    pub executed_at: i64,
    /// SHA-256 hash of the Executive agent's Claude reasoning JSON.
    pub executive_reasoning_hash: [u8; 32],
    /// SHA-256 hash of the Financial agent's Claude reasoning JSON.
    pub financial_reasoning_hash: [u8; 32],
    /// SHA-256 hash of the Oversight agent's Claude reasoning JSON.
    pub oversight_reasoning_hash: [u8; 32],
    /// SHA-256 hash of the Operational agent's halt reasoning JSON.
    pub operational_halt_reason_hash: [u8; 32],
    /// Cumulative amount already withdrawn from the strategy for this request.
    /// Caps repeatable withdrawals at `amount` so a fully-unwound position cannot
    /// be drained again. Appended at the end of the layout to preserve the byte
    /// offsets consumed by off-chain decoders. (NE-8)
    pub withdrawn_amount: u64,
    /// Review window (seconds) snapshotted from the DAO constitution at request
    /// creation. Applied at the Oversight `InReview` transition to compute
    /// `review_end`. Snapshotting here freezes the human-oversight delay for the
    /// life of the request so a later constitution change cannot shorten it.
    /// Appended at the end of the layout to preserve existing byte offsets.
    /// For a bootstrap request this is snapshotted as `0`; the immediate
    /// (zero-delay) review window is driven by `bootstrap` below so the legacy
    /// `review_window == 0 -> 24h default` fallback is not triggered.
    pub review_window: i64,
    /// One-time founder bootstrap marker. When `true`, the Oversight transition
    /// uses a zero review window (immediate execution) instead of the
    /// snapshotted/legacy window. Set only by `create_execution_request` with
    /// `bootstrap = true`, which is founder-gated and consumes the DAO's
    /// one-time `dao_registry.bootstrap_used` latch via a nave_core CPI.
    /// Appended at the end of the layout to preserve existing byte offsets.
    pub bootstrap: bool,
}

impl ExecutionRequest {
    pub const LEN: usize =
        8 + 1 + 32 + 8 + 32 + 32 + 32 + 1 + 32 + 8 + 8 + 8 + 8 + 8 + 32 + 32 + 32 + 32 + 8 + 8 + 1;

    pub fn status_enum(&self) -> Result<ExecutionStatus> {
        ExecutionStatus::from_u8(self.status).ok_or(crate::errors::ExecutionError::InvalidExecutionStatus.into())
    }
}
