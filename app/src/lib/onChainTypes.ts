// ─── On-chain account type definitions ──────────────────────────────────────
// These mirror the Anchor account structs from the 3 Nave programs.
// When IDLs are provided, these will be generated automatically. Until then
// they serve as the typed interface contract for the frontend.

// ═══════════════════════════════════════════════════════════════════════════════
// Shared enums
// ═══════════════════════════════════════════════════════════════════════════════

export enum PrivacyMode {
  Public = 0,
  Private = 1,
}

export enum AgentRole {
  Executive = 0,
  Financial = 1,
  Oversight = 2,
  Operational = 3,
}

export enum AgentStatus {
  Active = 0,
  Paused = 1,
  Revoked = 2,
  Rotating = 3,
}

// ═══════════════════════════════════════════════════════════════════════════════
// nave_core types
// ═══════════════════════════════════════════════════════════════════════════════

export interface NaveGlobalConfig {
  authority: string;            // base58 pubkey — protocol admin
  paused: boolean;
  formationFeeLamports: number;
  bump: number;
}

export type GovernanceType = 'wallet' | 'token';

export interface DaoRegistry {
  founder: string;               // base58 — founder wallet (used in PDA derivation)
  daoId: number;                 // u64 sequential index
  governanceType: GovernanceType;
  frozen: boolean;
  proposalCount: number;
  archivedProposalCount: number;
  /** Monotonic index for the next `create_proposal` PDA seed (may differ from proposalCount+archived if counters desync). */
  nextProposalIndex?: number;
  executionRequestCount: number;
  privacyMode: PrivacyMode;
  agentsEnabled: boolean;
  quorumBps: number;             // 1..10000
  createdAt: number;             // unix timestamp
  frozenAt: number;              // 0 if not frozen
  bump: number;
}

export interface AgentSlot {
  pubkey: string;        // base58 agent pubkey
  role: AgentRole;
  canSign: boolean;
  nullified: boolean;
  nullifiedAt: number;   // 0 if active
  actionsCount: number;
  lastActionAt: number;  // unix timestamp
  status: AgentStatus;   // Active | Paused | Revoked | Rotating
}

export interface AgentSet {
  dao: string;           // base58 DAO pubkey
  executive: AgentSlot;
  financial: AgentSlot;
  oversight: AgentSlot;
  operational: AgentSlot;
  agentsEnabled: boolean;
  reviewWindowSeconds: number;
  bump: number;
}

export interface GuardianConfig {
  dao: string;
  wallets: string[];     // max 10 base58 pubkeys
  threshold: number;     // max 7
  walletCount: number;
  bump: number;
}

export interface ProtocolEntry {
  protocolId: string;       // human-readable ID ("kamino", "jito", "marginfi")
  programId: string;        // base58 program ID of the adapter
  maxAllocationBps: number; // max % of vault this protocol can hold
  approved: boolean;
}

export interface TreasuryConstitution {
  dao: string;
  riskPreset: 'conservative' | 'moderate' | 'aggressive' | 'custom';
  maxSingleAllocationBps: number;
  maxTotalDeployedBps: number;       // global deployment cap (bps of NAV)
  rebalanceFrequencySeconds: number; // cadence between full rebalance cycles
  approvedProtocols: ProtocolEntry[]; // max 10
  protocolCount: number;
  minReservesBps: number;   // legacy alias for the liquidity floor (== minLiquidityBps)
  // ── Continuous treasury policy (constitution-driven autonomy) ──────────────
  minStablecoinReserveBps: number;  // stablecoin reserve floor (bps of NAV)
  minLiquidityBps: number;          // immediate-liquidity floor (bps of NAV)
  lastRebalanceAt: number;          // unix ts of last completed rebalance (0 = never)
  confidenceThreshold: number; // 0-100 — minimum Claude confidence for agent approval
  reviewWindowSecs: number; // agent-pipeline oversight review window (seconds)
  bump: number;
}

export interface TokenSlot {
  mint: string;             // base58 mint address (empty string if unused)
  name: string;
  symbol: string;
  decimals: number;
  supply: number;
  isMinted: boolean;        // false until the mint proposal passes
  isNaveManaged: boolean;   // true for Nave-minted, false for external monitoring
  mintAuthorityRevoked: boolean;
  freezeAuthorityRevoked: boolean;
  metadataAuthorityRevoked: boolean;
  canReceiveProposals: boolean;
  createdAt: number;
}

export interface TokenRegistry {
  dao: string;
  tokens: TokenSlot[];   // max 3
  tokenCount: number;
  bump: number;
}

export interface FeeConfig {
  dao: string;
  managementFeeBps: number;
  performanceFeeBps: number;
  frozenManagementFeeBps: number;
  frozenPerformanceFeeBps: number;
  feeRecipient: string;         // base58 — LEGACY fee collection address (unused by in-kind fee model)
  protocolRevenueWallet: string; // base58 — protocol revenue wallet (perf skim + annual mgmt fee destination)
  highWaterMark: number;        // highest vault value seen (for perf fee)
  totalFeesCollected: number;
  frozenSince: number;          // unix timestamp, 0 if never frozen
  frozenFeeExpiresAt: number;   // frozenSince + 5 years
  lastFeeCollectedAt: number;
  bump: number;
}

export interface StrategyPosition {
  dao: string;
  protocolId: string;       // e.g. "kamino", "jito", "marginfi"
  protocolProgram: string;  // base58 adapter program ID
  depositedAmount: number;  // in lamports or smallest unit
  receiptTokenMint: string; // base58 — receipt token (e.g. jitoSOL, kUSDC)
  receiptTokenAmount: number;
  currentValueUsd: number;
  lastUpdatedAt: number;
  bump: number;
}

export interface HolderAnnotation {
  dao: string;
  holder: string;       // base58 wallet
  annotation: string;   // max 256 chars
  status: 'pending' | 'approved' | 'denied';
  setBy: string;        // base58 — who set the annotation
  respondedAt: number;  // 0 if still pending
  bump: number;
}

export interface GuardianAction {
  dao: string;
  actionType: 0 | 1;      // 0 = freeze, 1 = unfreeze
  nonce: number;           // u64
  confirmations: string[]; // base58 pubkeys of guardians who confirmed
  confirmationCount: number;
  thresholdReached: boolean;
  executed: boolean;
  bump: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// nave_governance types
// ═══════════════════════════════════════════════════════════════════════════════

export enum ProposalType {
  Policy = 0,
  Strategy = 1,
  Permission = 2,
  Emergency = 3,
  General = 4,
  TokenMint = 5,
  TokenRevoke = 6,
  SwitchVotingSystem = 7,
  Transfer = 8,
  MoonlightRequest = 9,
  MoonlightDistribution = 10,
}

export enum ProposalStatus {
  Active = 0,
  Passed = 1,
  Failed = 2,
  Cancelled = 3,
  Executed = 4,
}

export enum VoteChoice {
  For = 0,
  Against = 1,
  Abstain = 2,
}

export enum VoteMethod {
  Wallet = 0,
  Escrow = 1,
}

export interface Proposal {
  dao: string;              // base58
  index: number;            // u64
  proposer: string;         // base58
  proposalType: ProposalType;
  title: string;
  description: string;
  payloadHash: string;      // 32-byte hash of the proposed action, hex-encoded
  votesFor: number;
  votesAgainst: number;
  votesAbstain: number;
  voterCount: number;
  status: ProposalStatus;
  voteTokenMint: string;    // base58 — which token determines vote weight
  snapshotSlot: number;
  snapshotSupply: number;
  quorumBps: number;        // copied from DAO at creation time
  threshold: number;        // for wallet-based: number of yes votes needed
  votingEnd: number;        // unix timestamp (created_at + voting_period_seconds)
  createdAt: number;
  executedAt: number;       // 0 if not executed
  archived: boolean;
  bump: number;
}

export interface VoteRecord {
  proposal: string;    // base58
  voter: string;       // base58
  choice: VoteChoice;
  weight: number;      // 1 for wallet-based, token amount for token-based
  method: VoteMethod;
  votedAt: number;
  bump: number;
}

export interface VoteEscrow {
  proposal: string;
  voter: string;
  tokenMint: string;
  amount: number;         // tokens locked
  choice: VoteChoice;
  released: boolean;
  lockedAt: number;
  releasedAt: number;     // 0 if still locked
  bump: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// nave_execution types
// ═══════════════════════════════════════════════════════════════════════════════

export enum ExecutionStatus {
  Pending = 0,
  ExecutiveApproved = 1,
  FinancialApproved = 2,
  OversightApproved = 3,
  InReview = 4,
  Executed = 5,
  Halted = 6,
  Expired = 7,
}

export interface ExecutionRequest {
  dao: string;                  // base58
  proposal: string;             // base58 — source proposal PDA
  protocolProgram: string;      // base58 — target adapter program
  amount: number;               // lamports or smallest unit
  status: ExecutionStatus;

  // Agent approvals
  executiveApprovedAt: number;
  financialApprovedAt: number;
  oversightApprovedAt: number;
  txPayloadHash: string;        // set by financial agent (hex-encoded 32 bytes)
  oversightPayloadHash: string; // must match txPayloadHash

  // Agent reasoning hashes (SHA-256 of Claude structured output)
  executiveReasoningHash: string;   // hex-encoded 32 bytes, set when executive approves
  financialReasoningHash: string;   // hex-encoded 32 bytes, set when financial approves
  oversightReasoningHash: string;   // hex-encoded 32 bytes, set when oversight approves

  // Operational review
  operationalHalt: boolean;
  operationalHaltReason: string;
  operationalHaltReasonHash: string; // hex-encoded 32 bytes, set when operational halts
  operationalCleared: boolean;
  reviewWindowEndsAt: number;   // oversight_approved_at + REVIEW_WINDOW_SECONDS

  // Execution
  executedAt: number;
  agentsBypassed: boolean;      // true if executed without agent pipeline
  protocolName: string;         // human-readable from constitution

  bump: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Instruction parameter types (match contract arg structs)
// ═══════════════════════════════════════════════════════════════════════════════

/** Matches the InitializeDaoParams struct used across all 3 DAO init instructions */
export interface InitializeDaoParams {
  name: string;
  guardianWallets: string[];      // 1..10 base58, unique
  guardianThreshold: number;      // 1..7, <= wallet count
  agentAuthorities: string[];     // exactly 4 base58 (Executive, Financial, Oversight, Operational)
  managementFeeBps: number;
  performanceFeeBps: number;
  frozenManagementFeeBps: number;
  frozenPerformanceFeeBps: number;
  privacyMode: PrivacyMode;
  feeRecipient: string;           // base58 — LEGACY (unused by in-kind fee model)
  protocolRevenueWallet: string;  // base58 — perf-fee skim + annual management fee destination
  quorumBps: number;              // 1..10000
}

/** Matches CreateProposalParams struct */
export interface CreateProposalParams {
  title: string;
  description: string;
  payload: Uint8Array;            // max 512 bytes; hashed on-chain
  proposalType: ProposalType;
  votingPeriodSeconds: number;    // must be > 0
}

/** Protocol input for update_constitution */
export interface ProtocolInput {
  protocolId: string;
  programId: string;              // base58 of adapter program
  maxAllocationBps: number;
  approved: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// On-chain event types (for indexing)
// ═══════════════════════════════════════════════════════════════════════════════

// nave_core events
export type NaveCoreEvent =
  | 'GlobalConfigInitialized'
  | 'GlobalConfigUpdated'
  | 'DaoInitialized'
  | 'ConstitutionUpdated'
  | 'GuardianConfigUpdated'
  | 'AgentSetUpdated'
  | 'AgentRotationScheduled'
  | 'AgentRotationApplied'
  | 'DaoEmergencyFrozen'
  | 'DaoEmergencyUnfrozen'
  | 'AgentsToggled'
  | 'AgentNullified'
  | 'AgentRestored'
  | 'AgentStatusChanged'
  | 'AgentKeyRotated'
  | 'VaultDeposited'
  | 'VaultWithdrawn'
  | 'ManagementFeeCollected'
  | 'PerformanceFeeCollected'
  | 'DaoPrivacyUpdated'
  | 'HolderAnnotationSet'
  | 'HolderAnnotationApproved'
  | 'HolderAnnotationDenied'
  | 'ProposalsArchived';

// nave_governance events
export type NaveGovernanceEvent =
  | 'ProposalCreated'
  | 'VoteCast'
  | 'VoteEscrowLocked'
  | 'VoteEscrowReleased'
  | 'ProposalFinalized'
  | 'ProposalCancelled'
  | 'DaoTokenMinted'
  | 'AdditionalTokensMinted'
  | 'TokenAuthorityRevoked'
  | 'TokenMetadataUpdated'
  | 'ExecutionRequestQueued';

// nave_execution events
export type NaveExecutionEvent =
  | 'ExecutionRequestCreated'
  | 'ExecutiveApprovedEvent'
  | 'FinancialApprovedEvent'
  | 'OversightApprovedEvent'
  | 'OperationalHaltEvent'
  | 'OperationalClearEvent'
  | 'AgentApprovalEvent'
  | 'StrategyExecutedEvent'
  | 'DirectStrategyExecutedEvent'
  | 'StrategyWithdrawnEvent';

// Adapter events
export type NaveAdapterEvent =
  | 'KaminoDepositEvent'
  | 'KaminoWithdrawEvent'
  | 'JitoDepositEvent'
  | 'JitoWithdrawEvent'
  | 'MarginfiDepositEvent'
  | 'MarginfiWithdrawEvent';

export type NaveEvent =
  | NaveCoreEvent
  | NaveGovernanceEvent
  | NaveExecutionEvent
  | NaveAdapterEvent;