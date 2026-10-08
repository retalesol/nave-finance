use anchor_lang::prelude::*;

#[event]
pub struct GlobalConfigInitialized {
    pub authority: Pubkey,
    pub treasury: Pubkey,
    pub formation_fee_lamports: u64,
}

#[event]
pub struct GlobalConfigUpdated {
    pub authority: Pubkey,
    pub paused: bool,
    pub formation_fee_lamports: u64,
}

#[event]
pub struct DaoInitialized {
    pub dao: Pubkey,
    pub dao_id: u64,
    pub founder: Pubkey,
    pub name_len: u8,
}

#[event]
pub struct ConstitutionUpdated {
    pub dao: Pubkey,
    pub protocol_count: u8,
}

#[event]
pub struct ReviewWindowUpdated {
    pub dao: Pubkey,
    pub review_window_secs: i64,
}

#[event]
pub struct PolicyParametersUpdated {
    pub dao: Pubkey,
    pub min_stablecoin_reserve_bps: u16,
    pub max_total_deployed_bps: u16,
    pub min_liquidity_bps: u16,
    pub rebalance_frequency_secs: i64,
}

#[event]
pub struct MaxSlippageUpdated {
    pub dao: Pubkey,
    pub max_slippage_bps: u16,
}

#[event]
pub struct MaxSingleSwapUpdated {
    pub dao: Pubkey,
    pub max_single_swap_bps: u16,
}

#[event]
pub struct GuardianConfigUpdated {
    pub dao: Pubkey,
    pub threshold: u8,
    pub wallet_count: u8,
}

#[event]
pub struct GuardiansBootstrapped {
    pub dao: Pubkey,
    pub threshold: u8,
    pub wallet_count: u8,
}

#[event]
pub struct AgentSetUpdated {
    pub dao: Pubkey,
}

#[event]
pub struct AgentRotationScheduled {
    pub dao: Pubkey,
    pub effective_at: i64,
}

#[event]
pub struct AgentRotationApplied {
    pub dao: Pubkey,
    pub role: u8,
    pub new_authority: Pubkey,
}

#[event]
pub struct DaoEmergencyFrozen {
    pub dao: Pubkey,
    pub triggered_by: Pubkey,
}

#[event]
pub struct DaoEmergencyUnfrozen {
    pub dao: Pubkey,
    pub triggered_by: Pubkey,
}

#[event]
pub struct AgentsToggled {
    pub dao: Pubkey,
    pub enabled: bool,
}

#[event]
pub struct GuardianActionCancelled {
    pub dao: Pubkey,
    pub guardian_action: Pubkey,
    pub action_type: u8,
    pub nonce: u64,
    pub executed: bool,
    pub cancelled_by: Pubkey,
}

#[event]
pub struct AgentNullified {
    pub dao: Pubkey,
    pub role: u8,
    pub agent: Pubkey,
}

#[event]
pub struct AgentRestored {
    pub dao: Pubkey,
    pub role: u8,
    pub agent: Pubkey,
}

#[event]
pub struct AgentStatusChangedEvent {
    pub dao: Pubkey,
    pub agent_slot: u8,
    pub old_status: u8,
    pub new_status: u8,
    pub timestamp: i64,
}

#[event]
pub struct AgentKeyRotatedEvent {
    pub dao: Pubkey,
    pub agent_slot: u8,
    pub old_pubkey: Pubkey,
    pub new_pubkey: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct VaultDeposited {
    pub dao: Pubkey,
    pub depositor: Pubkey,
    pub amount: u64,
    pub new_balance: u64,
}

#[event]
pub struct VaultWithdrawn {
    pub dao: Pubkey,
    pub recipient: Pubkey,
    pub amount: u64,
    pub new_balance: u64,
}

#[event]
pub struct ManagementFeeCollected {
    pub dao: Pubkey,
    /// Asset mint the in-kind management fee was charged on.
    pub mint: Pubkey,
    /// Fee paid, in the asset's base units (`fee_bps` of the idle balance).
    pub amount: u64,
    /// Idle treasury balance the fee was assessed against.
    pub balance: u64,
    /// New midnight-aligned accounting anchor for this asset.
    pub new_anchor: i64,
    pub frozen_rate_applied: bool,
}

/// Emitted on every strategy withdrawal that realizes yield: `fee` base units of
/// the withdrawn `mint` were skimmed from the realized `gain` to the protocol
/// revenue wallet before the remainder credited the treasury.
#[event]
pub struct PerformanceFeeSkimmed {
    pub dao: Pubkey,
    /// Withdrawn asset mint (the skim is in this asset).
    pub mint: Pubkey,
    /// Total base units withdrawn from the strategy position.
    pub withdrawn: u64,
    /// Realized-yield portion of the withdrawal (base units).
    pub gain: u64,
    /// Performance fee skimmed from the gain (base units).
    pub fee: u64,
}

#[event]
pub struct DaoPrivacyUpdated {
    pub dao: Pubkey,
    pub privacy_mode: u8,
}

#[event]
pub struct HolderAnnotationSet {
    pub dao: Pubkey,
    pub holder: Pubkey,
    pub annotation_len: u16,
}

#[event]
pub struct HolderAnnotationApproved {
    pub dao: Pubkey,
    pub holder: Pubkey,
}

#[event]
pub struct HolderAnnotationDenied {
    pub dao: Pubkey,
    pub holder: Pubkey,
}

#[event]
pub struct ProposalsArchived {
    pub dao: Pubkey,
    pub archived_count: u64,
    pub remaining_proposal_count: u64,
}

#[event]
pub struct DaoTokenRegistered {
    pub dao: Pubkey,
    pub mint: Pubkey,
}

#[event]
pub struct TokenAuthorityRevoked {
    pub dao: Pubkey,
    pub mint: Pubkey,
}

#[event]
pub struct TokenMetadataUpdated {
    pub dao: Pubkey,
    pub mint: Pubkey,
}

#[event]
pub struct ProposalCountRecorded {
    pub dao: Pubkey,
    pub proposal_count: u64,
}

/// Emitted when the DAO's one-time founder bootstrap latch is consumed (via the
/// nave_execution CPI). Lets off-chain indexers detect that the zero-review
/// -window bootstrap path has been used for this DAO.
#[event]
pub struct DaoBootstrapUsed {
    pub dao: Pubkey,
    pub founder: Pubkey,
}

#[event]
pub struct VotingSystemSwitched {
    pub dao: Pubkey,
    pub governance_type: u8,
    pub voting_token: Pubkey,
}

#[event]
pub struct TokenMintFeeCollected {
    pub dao: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
}

#[event]
pub struct TokenRevokeRewarded {
    pub dao: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
}

/// Emitted on a successful operational-agent direct Jupiter swap. `amount_in` /
/// `amount_out` are the ACTUAL base-unit deltas observed on the vault token
/// accounts (not the requested figures). A `revalue_treasury` should follow to
/// reprice NAV, since the swap mutates per-asset accounting without recomputing
/// the portfolio aggregate.
#[event]
pub struct JupiterSwapEvent {
    pub dao: Pubkey,
    pub mint_in: Pubkey,
    pub mint_out: Pubkey,
    pub amount_in: u64,
    pub amount_out: u64,
    pub timestamp: i64,
}

#[event]
pub struct GovernanceTransferExecuted {
    pub dao: Pubkey,
    pub proposal: Pubkey,
    pub recipient: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
}

#[event]
pub struct NaveMintUpdated {
    pub authority: Pubkey,
    pub nave_mint: Pubkey,
}

// ── DAO creation stake (Phase 3) ─────────────────────────────────────────────

/// Emitted when a founder locks (or re-locks, on restore) the recoverable NAVE
/// creation stake into escrow. Indexers use this to display the recoverable
/// stake separately from protocol fees (there is none at formation).
#[event]
pub struct DaoStakeLocked {
    pub dao: Pubkey,
    pub founder: Pubkey,
    pub nave_mint: Pubkey,
    pub escrow: Pubkey,
    pub amount: u64,
    pub price_usd_micro: u64,
    pub locked_at: i64,
}

/// Emitted when the staked NAVE is released out of escrow to a recipient (the
/// approved moonlight recipient) or back to the founder on wind-down.
#[event]
pub struct DaoStakeReleased {
    pub dao: Pubkey,
    pub recipient: Pubkey,
    pub amount: u64,
    pub released_at: i64,
}

// ── DAO moonlighting lifecycle (Phase 5) ─────────────────────────────────────

#[event]
pub struct MoonlightRequested {
    pub dao: Pubkey,
    pub request_proposal: Pubkey,
    pub requested_by: Pubkey,
    pub requested_at: i64,
}

#[event]
pub struct MoonlightDistributionSet {
    pub dao: Pubkey,
    pub recipient: Pubkey,
    pub initiated_by: Pubkey,
}

#[event]
pub struct MoonlightDistributed {
    pub dao: Pubkey,
    pub distribution_proposal: Pubkey,
    pub recipient: Pubkey,
    pub stake_amount: u64,
    pub distributed_at: i64,
}

#[event]
pub struct DaoMoonlighted {
    pub dao: Pubkey,
    pub recipient: Pubkey,
    pub moonlighted_at: i64,
}

#[event]
pub struct DaoRestored {
    pub dao: Pubkey,
    pub founder: Pubkey,
    pub restaked_amount: u64,
    pub restored_at: i64,
}
