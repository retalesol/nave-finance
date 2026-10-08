import { existsSync, readFileSync } from 'node:fs';
import { type Abi, type AbiEvent, parseAbi } from 'viem';

// ─── Nave EVM event ABI + canonical normalization ────────────────────────────
//
// The shared index-events pipeline routes on the CANONICAL event names emitted
// by the Solana programs (e.g. "VaultDeposited", "ExecutiveApprovedEvent"). To
// feed the same pipeline, this worker decodes EVM logs and re-labels each event
// to its canonical name + extracts the dao/actor/agent_role the pipeline needs.
//
// IMPORTANT — how the DAO (treasury) address is resolved per event:
//   The EVM contracts are per-DAO clones. They do NOT carry a `dao` arg in their
//   events; the DAO identity comes from WHICH contract emitted the log:
//     • NaveTreasury events  → dao = the EMITTER address (the treasury IS the dao)
//     • NaveDAOFactory.DaoCreated → dao = the `treasury` ARG
//     • NaveGovernor / NaveExecution events → dao = treasury(), read once from
//       the emitter and cached (the governor/execution emitter ≠ the treasury)
//   `daoSource` below tells the worker which resolution strategy to use.
//
// These signatures are reconciled against the REAL Solidity events (see
// contracts/evm/src/*.sol). Point NAVE_EVM_ABI_PATH at the synced
// ABI JSON to track future changes without editing this file.

const DEFAULT_EVENT_SIGNATURES = [
  // ── NaveDAOFactory (emitter = factory; dao = treasury arg) ──
  'event DaoCreated(uint256 indexed daoId, address indexed founder, address treasury, address governor, address execution)',
  // ── NaveTreasury (emitter = dao) ──
  'event DaoInitialized(uint256 indexed daoId, address founder, string name)',
  'event DaoPrivacyUpdated(uint8 privacyMode)',
  'event ConstitutionUpdated(uint8 protocolCount)',
  'event PolicyParametersUpdated(uint16 reserveBps, uint16 deployedBps, uint16 liquidityBps, int64 rebalanceFreq)',
  'event GuardianConfigUpdated(uint8 threshold, uint8 walletCount)',
  'event AgentRotationScheduled(uint256 effectiveAt)',
  'event AgentRotationApplied(uint8 role, address newAuthority)',
  'event VaultDeposited(address depositor, address mint, uint256 amount, uint256 newNav)',
  'event ManagementFeeCollected(address mint, uint256 amount, uint256 balance, uint256 newAnchor, bool frozenRate)',
  'event PerformanceFeeSkimmed(address mint, uint256 gain, uint256 fee)',
  'event StrategyDeposited(address adapter, address mint, uint256 amount, uint256 amountUsd)',
  'event StrategyWithdrawn(address adapter, address mint, uint256 amount, uint256 amountUsd)',
  'event TransferExecuted(address mint, address recipient, uint256 amount)',
  'event TreasuryRevalued(uint256 nav, uint256 deployed)',
  'event AgentsToggled(bool enabled)',
  'event AgentNullified(uint8 role, address agent)',
  'event AgentRestored(uint8 role, address agent)',
  'event AgentStatusChanged(uint8 slot, uint8 oldStatus, uint8 newStatus)',
  'event AgentKeyRotated(uint8 slot, address oldKey, address newKey)',
  'event DaoEmergencyFrozen(address triggeredBy)',
  'event DaoEmergencyUnfrozen(address triggeredBy)',
  'event DaoTokenRegistered(address mint)',
  'event TokenAuthorityRevoked(address mint)',
  'event TokenMetadataUpdated(address mint)',
  'event AssetRegistered(address mint, uint8 assetKind, bool isStablecoin)',
  // ── NaveGovernor (emitter = governor clone; dao = treasury()) ──
  'event ProposalCreated(uint64 indexed index, uint8 proposalType, uint256 snapshotSupply, bytes32 payloadHash)',
  'event VoteCast(uint64 indexed index, address voter, uint8 choice, uint8 method, uint256 weight)',
  'event VoteEscrowLocked(uint64 indexed index, address voter, uint256 amount)',
  'event VoteEscrowReleased(uint64 indexed index, address voter, uint256 amount)',
  'event ProposalFinalized(uint64 indexed index, uint8 status, uint256 votesFor, uint256 votesAgainst)',
  'event ProposalCancelled(uint64 indexed index)',
  'event ExecutionRequestQueued(uint64 indexed index, bytes32 payloadHash)',
  'event AdditionalTokensMinted(address mint, uint256 amount)',
  // ── NaveExecution (emitter = execution clone; dao = treasury()) ──
  'event ExecutionRequestCreated(uint64 indexed index, uint8 kind, address adapter, address asset, uint256 amount)',
  'event ExecutiveApproved(uint64 indexed index, address approver)',
  'event FinancialApproved(uint64 indexed index, address approver, bytes32 txPayloadHash)',
  'event OversightApproved(uint64 indexed index, address approver, uint256 reviewEnd)',
  'event OperationalHalt(uint64 indexed index, bytes32 reasonHash)',
  'event OperationalClear(uint64 indexed index)',
  'event ExecutionExpired(uint64 indexed index)',
  'event StrategyExecuted(uint64 indexed index, uint256 amount)',
  'event DirectStrategyExecuted(uint64 indexed index, uint256 amount)',
  // ── WrappedNave cross-chain bridge token (emitter = the wrapped token) ──
  // The trusted-relayer bridge mints WrappedNave on a Solana→EVM lock and burns
  // it on an EVM→Solana release. dao = emitter (the wrapped token address), so
  // these are attributed to the token contract; add the per-chain wrapped NAVE
  // address via NAVE_EVM_WATCH_ADDRESSES_<id> to scope the scan.
  'event BridgeMint(address indexed to, uint256 amount)',
  'event BridgeBurn(address indexed from, uint256 amount)',
] as const;

/** How the DAO (treasury) address is derived for a given event. */
export type DaoSource = 'emitter' | 'arg' | 'treasuryGetter';

export interface CanonicalMeta {
  /** Canonical event_type the index-events pipeline routes on. */
  canonical: string;
  /** How to resolve the DAO/treasury address for this event. */
  daoSource: DaoSource;
  /** Arg key holding the treasury address (only when daoSource === 'arg'). */
  daoArg?: string;
  /** Ordered candidate arg keys for the human/agent actor. */
  actorArgs: string[];
  /** Static agent role for agent-pipeline events (else undefined). */
  agentRole?: 'executive' | 'financial' | 'oversight' | 'operational';
}

// Keyed by the EVM (Solidity) event name → canonical routing metadata.
// NOTE: TransferExecuted / StrategyWithdrawn are intentionally taken from the
// NaveTreasury variants (dao = emitter). The NaveExecution variants of those
// names are omitted to avoid a name collision in this map.
export const EVENT_META: Record<string, CanonicalMeta> = {
  // Factory
  DaoCreated: { canonical: 'DaoInitialized', daoSource: 'arg', daoArg: 'treasury', actorArgs: ['founder'] },
  // Treasury (emitter = dao)
  DaoInitialized: { canonical: 'DaoInitialized', daoSource: 'emitter', actorArgs: ['founder'] },
  DaoPrivacyUpdated: { canonical: 'DaoPrivacyUpdated', daoSource: 'emitter', actorArgs: [] },
  ConstitutionUpdated: { canonical: 'ConstitutionUpdated', daoSource: 'emitter', actorArgs: [] },
  PolicyParametersUpdated: { canonical: 'PolicyParametersUpdated', daoSource: 'emitter', actorArgs: [] },
  GuardianConfigUpdated: { canonical: 'GuardianConfigUpdated', daoSource: 'emitter', actorArgs: [] },
  AgentRotationScheduled: { canonical: 'AgentRotationScheduled', daoSource: 'emitter', actorArgs: [] },
  AgentRotationApplied: { canonical: 'AgentRotationApplied', daoSource: 'emitter', actorArgs: ['newAuthority'] },
  VaultDeposited: { canonical: 'VaultDeposited', daoSource: 'emitter', actorArgs: ['depositor'] },
  ManagementFeeCollected: { canonical: 'ManagementFeeCollected', daoSource: 'emitter', actorArgs: [] },
  PerformanceFeeSkimmed: { canonical: 'PerformanceFeeCollected', daoSource: 'emitter', actorArgs: [] },
  StrategyDeposited: { canonical: 'StrategyExecutedEvent', daoSource: 'emitter', actorArgs: ['adapter'] },
  StrategyWithdrawn: { canonical: 'StrategyWithdrawnEvent', daoSource: 'emitter', actorArgs: ['adapter'] },
  TransferExecuted: { canonical: 'TransferExecuted', daoSource: 'emitter', actorArgs: ['recipient'] },
  TreasuryRevalued: { canonical: 'TreasuryRevalued', daoSource: 'emitter', actorArgs: [] },
  AgentsToggled: { canonical: 'AgentStatusChangedEvent', daoSource: 'emitter', actorArgs: [] },
  AgentNullified: { canonical: 'AgentStatusChangedEvent', daoSource: 'emitter', actorArgs: ['agent'] },
  AgentRestored: { canonical: 'AgentStatusChangedEvent', daoSource: 'emitter', actorArgs: ['agent'] },
  AgentStatusChanged: { canonical: 'AgentStatusChanged', daoSource: 'emitter', actorArgs: [] },
  AgentKeyRotated: { canonical: 'AgentRotationApplied', daoSource: 'emitter', actorArgs: ['newKey'] },
  DaoEmergencyFrozen: { canonical: 'DaoEmergencyFrozen', daoSource: 'emitter', actorArgs: ['triggeredBy'] },
  DaoEmergencyUnfrozen: { canonical: 'DaoEmergencyUnfrozen', daoSource: 'emitter', actorArgs: ['triggeredBy'] },
  DaoTokenRegistered: { canonical: 'DaoTokenRegistered', daoSource: 'emitter', actorArgs: [] },
  TokenAuthorityRevoked: { canonical: 'TokenAuthorityRevoked', daoSource: 'emitter', actorArgs: [] },
  TokenMetadataUpdated: { canonical: 'TokenMetadataUpdated', daoSource: 'emitter', actorArgs: [] },
  AssetRegistered: { canonical: 'AssetRegistered', daoSource: 'emitter', actorArgs: [] },
  // Governor (emitter = governor clone → resolve treasury())
  ProposalCreated: { canonical: 'ProposalCreated', daoSource: 'treasuryGetter', actorArgs: [] },
  VoteCast: { canonical: 'VoteCast', daoSource: 'treasuryGetter', actorArgs: ['voter'] },
  VoteEscrowLocked: { canonical: 'VoteEscrowLocked', daoSource: 'treasuryGetter', actorArgs: ['voter'] },
  VoteEscrowReleased: { canonical: 'VoteEscrowReleased', daoSource: 'treasuryGetter', actorArgs: ['voter'] },
  ProposalFinalized: { canonical: 'ProposalFinalized', daoSource: 'treasuryGetter', actorArgs: [] },
  ProposalCancelled: { canonical: 'ProposalCancelled', daoSource: 'treasuryGetter', actorArgs: [] },
  ExecutionRequestQueued: { canonical: 'ExecutionRequestQueued', daoSource: 'treasuryGetter', actorArgs: [] },
  AdditionalTokensMinted: { canonical: 'AdditionalTokensMinted', daoSource: 'treasuryGetter', actorArgs: [] },
  // Execution (emitter = execution clone → resolve treasury())
  ExecutionRequestCreated: { canonical: 'ExecutionRequestCreated', daoSource: 'treasuryGetter', actorArgs: ['adapter'] },
  ExecutiveApproved: { canonical: 'ExecutiveApprovedEvent', daoSource: 'treasuryGetter', actorArgs: ['approver'], agentRole: 'executive' },
  FinancialApproved: { canonical: 'FinancialApprovedEvent', daoSource: 'treasuryGetter', actorArgs: ['approver'], agentRole: 'financial' },
  OversightApproved: { canonical: 'OversightApprovedEvent', daoSource: 'treasuryGetter', actorArgs: ['approver'], agentRole: 'oversight' },
  OperationalHalt: { canonical: 'OperationalHaltEvent', daoSource: 'treasuryGetter', actorArgs: [], agentRole: 'operational' },
  OperationalClear: { canonical: 'OperationalClearEvent', daoSource: 'treasuryGetter', actorArgs: [], agentRole: 'operational' },
  ExecutionExpired: { canonical: 'ExecutionExpired', daoSource: 'treasuryGetter', actorArgs: [] },
  StrategyExecuted: { canonical: 'StrategyExecutedEvent', daoSource: 'treasuryGetter', actorArgs: [] },
  DirectStrategyExecuted: { canonical: 'DirectStrategyExecutedEvent', daoSource: 'treasuryGetter', actorArgs: [] },
  // WrappedNave bridge token (emitter = wrapped token; actor = the user the
  // wrapped tokens were minted to / burned from). The `amount` is preserved in
  // raw_data alongside `to`/`from`.
  BridgeMint: { canonical: 'bridge_mint', daoSource: 'emitter', actorArgs: ['to'] },
  BridgeBurn: { canonical: 'bridge_burn', daoSource: 'emitter', actorArgs: ['from'] },
};

/** Minimal ABI for resolving treasury() on governor/execution clones. */
export const TREASURY_GETTER_ABI = [
  { type: 'function', name: 'treasury', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const;

/**
 * Resolve the event ABI. Prefers a synced ABI JSON file (NAVE_EVM_ABI_PATH) so
 * the worker tracks the real contract events once finalized; otherwise uses the
 * built-in defaults above. Only `event` ABI items are kept. When pointing at a
 * synced ABI, concatenate the Treasury/Governor/Execution/Factory ABIs (or pass
 * a directory of them) so all event topics are present.
 */
export function loadEventAbi(): AbiEvent[] {
  const path = process.env.NAVE_EVM_ABI_PATH;
  if (path && existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      const items = (Array.isArray(parsed) ? parsed : parsed.abi) as Abi;
      const events = dedupeEvents(items.filter((i) => (i as { type?: string }).type === 'event') as AbiEvent[]);
      if (events.length > 0) return events;
      console.warn(`[evm-indexer] NAVE_EVM_ABI_PATH had no event items; using defaults`);
    } catch (e) {
      console.warn(`[evm-indexer] failed to parse NAVE_EVM_ABI_PATH (${path}); using defaults:`, e);
    }
  }
  return (parseAbi([...DEFAULT_EVENT_SIGNATURES]) as Abi).filter(
    (i) => (i as { type?: string }).type === 'event',
  ) as AbiEvent[];
}

/**
 * Drop event items whose NAME is not in EVENT_META, and keep only the first
 * signature seen per name. This prevents same-name collisions (e.g. the two
 * distinct TransferExecuted / StrategyWithdrawn signatures across Treasury and
 * Execution) from producing ambiguous decodes when a synced ABI is supplied.
 */
function dedupeEvents(events: AbiEvent[]): AbiEvent[] {
  const seen = new Set<string>();
  const out: AbiEvent[] = [];
  for (const ev of events) {
    const name = ev.name;
    if (!name || !EVENT_META[name] || seen.has(name)) continue;
    seen.add(name);
    out.push(ev);
  }
  return out;
}
