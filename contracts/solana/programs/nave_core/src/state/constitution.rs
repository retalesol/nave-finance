use anchor_lang::prelude::*;

use crate::constants::{MAX_CONSTITUTION_PROTOCOLS, MAX_PROTOCOL_ID_LEN};

/// Approved protocol entry within a DAO constitution.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, Debug)]
pub struct ProtocolEntry {
    /// Fixed-size protocol identifier bytes.
    pub protocol_id: [u8; MAX_PROTOCOL_ID_LEN],
    /// Active protocol id length.
    pub protocol_id_len: u8,
    /// Target program id for CPI.
    pub program_id: Pubkey,
    /// Maximum allocation in basis points.
    pub max_allocation_bps: u16,
    /// Whether the protocol is approved.
    pub approved: bool,
}

impl ProtocolEntry {
    pub fn protocol_id_slice(&self) -> &[u8] {
        &self.protocol_id[..self.protocol_id_len as usize]
    }

    pub fn set_protocol_id(&mut self, id: &[u8]) -> Result<()> {
        require!(
            !id.is_empty() && id.len() <= MAX_PROTOCOL_ID_LEN,
            crate::errors::NaveError::InvalidProtocolIdLength
        );
        self.protocol_id = [0u8; MAX_PROTOCOL_ID_LEN];
        self.protocol_id[..id.len()].copy_from_slice(id);
        self.protocol_id_len = id.len() as u8;
        Ok(())
    }
}

/// Treasury constitution defining approved DeFi protocols.
#[account]
pub struct TreasuryConstitution {
    /// PDA bump seed.
    pub bump: u8,
    /// Owning DAO registry key.
    pub dao: Pubkey,
    /// Active protocol count.
    pub protocol_count: u8,
    /// Fixed-size protocol entries.
    pub protocols: [ProtocolEntry; MAX_CONSTITUTION_PROTOCOLS],
    /// Minimum Claude reasoning confidence (0-100) an agent must report
    /// before the off-chain agent service will proceed with signing.
    pub confidence_threshold: u8,
    /// Mandatory on-chain review window (seconds) between Oversight approval
    /// (InReview) and `execute_strategy`. Governance-controlled per DAO so the
    /// human-oversight delay can be tuned (production default 24h); snapshotted
    /// onto each ExecutionRequest at creation so it cannot change mid-flight.
    pub review_window_secs: i64,
    /// Continuous treasury policy: minimum portfolio share (bps) that must be
    /// held as stablecoin reserve at all times. `0` means unset (legacy
    /// accounts) and disables the floor. Enforced off-chain by the deterministic
    /// guardrails because the single-mint vault accounting cannot prove
    /// multi-asset composition on-chain yet (multi-asset treasury milestone).
    /// Appended at the end of the layout to preserve existing byte offsets.
    pub min_stablecoin_reserve_bps: u16,
    /// Continuous treasury policy: maximum portfolio share (bps) that may be
    /// deployed across all approved strategies combined. `0` means unset and
    /// disables the explicit global cap (per-protocol caps still apply).
    /// Enforced on-chain at request creation and execution against vault NAV.
    pub max_total_deployed_bps: u16,
    /// Continuous treasury policy: minimum portfolio share (bps) that must
    /// remain immediately liquid (not deployed). `0` means unset and disables
    /// the floor. Enforced on-chain against vault NAV.
    pub min_liquidity_bps: u16,
    /// Continuous treasury policy: rebalance cadence in seconds — how often the
    /// agents exit positions, realize profit, and re-establish allocations.
    /// `0` means unset (no cadence). Used by the off-chain policy loop to gate
    /// rebalance-due eligibility.
    pub rebalance_frequency_secs: i64,
    /// Unix timestamp of the last completed rebalance cycle. Maintained by the
    /// agent pipeline; combined with `rebalance_frequency_secs` to determine
    /// when the next rebalance is due. `0` until the first rebalance.
    pub last_rebalance_at: i64,
    /// Minimum treasury NAV in micro-USD (USD_SCALE=1e6) required before agents
    /// may deploy/swap. Compared against treasury_vault.current_nav. 0 disables
    /// the gate.
    pub agent_threshold_usd: u64,
    /// Maximum allowed slippage (bps) for `jupiter_swap`, enforced against the
    /// caller-supplied `expected_amount_out` in addition to the actual
    /// `min_amount_out` floor already checked against realized output. `0`
    /// means unset and disables this additional guardrail (the swap still
    /// enforces the caller-supplied `min_amount_out`, unchanged). Founder-set
    /// via `set_max_slippage_bps`. Appended at the end to preserve existing
    /// byte offsets.
    pub max_slippage_bps: u16,
    /// Maximum single `jupiter_swap` call size, in bps of the pre-swap balance
    /// of the asset being sold (`mint_in`). `jupiter_swap` is Operational-agent
    /// gated with no prior multi-agent-approval/review-window step (unlike
    /// deposits into Kamino/Jito/MarginFi, which can only move funds already
    /// escrowed via a governance-approved `execute_strategy`) — this is the
    /// on-chain backstop bounding how much of a single asset one Operational
    /// agent signature can move in one call. `0` means unset and disables the
    /// cap (existing DAOs are unaffected until the founder opts in via
    /// `set_max_single_swap_bps`). Appended at the end to preserve existing
    /// byte offsets.
    pub max_single_swap_bps: u16,
}

impl TreasuryConstitution {
    pub const LEN: usize = 8
        + 1
        + 32
        + 1
        + (MAX_CONSTITUTION_PROTOCOLS
            * (MAX_PROTOCOL_ID_LEN + 1 + 32 + 2 + 1))
        + 1
        + 8
        // Continuous policy fields (appended): reserve(2) + deployed(2)
        // + liquidity(2) + rebalance_frequency(8) + last_rebalance_at(8)
        // + agent_threshold_usd(8) + max_slippage_bps(2)
        // + max_single_swap_bps(2).
        + 2
        + 2
        + 2
        + 8
        + 8
        + 8
        + 2
        + 2;

    /// On-chain enforceable deployment ceiling in bps (0..=10000): the smaller
    /// of the explicit global deployment cap and the ceiling implied by the
    /// liquidity floor (at most `10000 - min_liquidity_bps` may be deployed).
    /// When `max_total_deployed_bps` is unset (0) only the liquidity-implied
    /// ceiling constrains deployment.
    pub fn effective_max_deployed_bps(&self) -> u16 {
        let liquidity_ceiling = 10_000u16.saturating_sub(self.min_liquidity_bps);
        match self.max_total_deployed_bps {
            0 => liquidity_ceiling,
            cap => cap.min(liquidity_ceiling),
        }
    }

    /// Whether a rebalance is due as of `now`. Returns false when the cadence
    /// is unset so the off-chain loop never force-rebalances an unconfigured DAO.
    pub fn rebalance_due(&self, now: i64) -> bool {
        if self.rebalance_frequency_secs <= 0 {
            return false;
        }
        now.saturating_sub(self.last_rebalance_at) >= self.rebalance_frequency_secs
    }

    pub fn find_protocol_index(&self, protocol_id: &[u8]) -> Option<usize> {
        self.protocols[..self.protocol_count as usize]
            .iter()
            .position(|entry| entry.approved && entry.protocol_id_slice() == protocol_id)
    }

    pub fn is_protocol_approved(&self, program_id: &Pubkey) -> bool {
        self.protocols[..self.protocol_count as usize]
            .iter()
            .any(|entry| entry.approved && entry.program_id == *program_id)
    }
}
