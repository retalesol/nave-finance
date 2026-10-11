// ─── Mock Data — "Nave Treasury" Demo Mode ──────────────────────────────────
// Provides realistic demo data for every hook so the full product can be
// explored without a live on-chain treasury.
//
// The MOCK_DAO_ADDRESS MUST be a valid Solana base58 public key (no `0`, `O`,
// `I`, `l`). The previous human-readable sentinel used `0` and caused
// `new PublicKey()` to throw anywhere mock mode was not guarded first.
// This key is a deterministic Keypair.fromSeed (not a real on-chain DAO).
// All hooks check isMockDaoAddress() and return mock data instead of RPC/DB.

import {
  ProposalStatus,
  ProposalType,
  ExecutionStatus,
  AgentStatus,
} from './onChainTypes';
import type {
  AgentSet,
  GuardianConfig,
  TreasuryConstitution,
  TokenRegistry,
  DaoRegistry,
} from './onChainTypes';
import type { TreasurySnapshot, StrategyInfo, AssetInfo } from '../hooks/useTreasuryData';
import type { AgentStatusInfo, AgentActionLog } from '../hooks/useAgentStatus';
import type { ActivityEntry } from '../hooks/useActivityLog';
import type { ProposalInfo } from '../hooks/useProposals';
import type { ExecutionInfo } from '../hooks/useExecutionPipeline';
import type { ConstitutionData } from '../hooks/useConstitution';
import type { GuardianInfo } from '../hooks/useGuardianConfig';
import type { TokenInfo } from '../hooks/useTokenRegistry';
import type { MonthlyReport, YearlyReportGroup } from '../hooks/useMonthlyReports';
import type { DaoData } from '../hooks/useDaoRegistry';

// ═══════════════════════════════════════════════════════════════════════════════
// Sentinel address
// ═══════════════════════════════════════════════════════════════════════════════

/** Client-only demo sentinel (valid pubkey; not used as a live DAO on-chain). */
export const MOCK_DAO_ADDRESS = 'BXq9CTas4DpibqUMCSbMHD5Q3rrNTx3JXekqC4GrKKHb';

/** Legacy invalid-base58 sentinel — still treated as mock for old bookmarks. */
const LEGACY_MOCK_DAO_ADDRESS = 'NaveDem0TreasuryM0ckAddress111111111111111';

/**
 * Lobby / marketing CTAs that navigate to {@link MOCK_DAO_ADDRESS}.
 * Off in production builds so public beta never opens the bundled mock dashboard.
 * Set `VITE_DEMO_TREASURY_NAV=true` on a preview host, or use `vite dev` (DEV).
 */
export const DEMO_TREASURY_NAV_ENABLED: boolean =
  import.meta.env.DEV || import.meta.env.VITE_DEMO_TREASURY_NAV === 'true';

/** Returns true when the given address is the mock sentinel, or when the global
 *  VITE_USE_MOCKS demo flag is enabled. */
export function isMockDaoAddress(address: string | null | undefined): boolean {
  if (import.meta.env.VITE_USE_MOCKS === 'true') return true;
  if (!address) return false;
  return address === MOCK_DAO_ADDRESS || address === LEGACY_MOCK_DAO_ADDRESS;
}

/** Map legacy demo sentinel → current valid-pubkey sentinel (for route/storage). */
export function normalizeMockDaoAddress(address: string | null | undefined): string | null {
  if (!address) return null;
  if (address === LEGACY_MOCK_DAO_ADDRESS) return MOCK_DAO_ADDRESS;
  return address;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════════

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

function unixDaysAgo(n: number): number {
  return Math.floor(Date.now() / 1000) - n * 86400;
}

const FAKE_WALLET_A = '7xKpR2qFbN9wL5uJmD1vA3eTf8cYhZs4kG6pQ3mBf1X';
const FAKE_WALLET_B = '9aRzP4tKdM2wX7vHnJ5bC8yEf1gQs6uL3iO8vWqNr2D';
const FAKE_WALLET_C = '4sLmW8nPrK3xJ6tYuA9bV2dCf5gHe7iR1qO0zN1nPrK';
const FAKE_AGENT_EXEC = 'ExecAgnt111111111111111111111111111111111111';
const FAKE_AGENT_FIN  = 'FinAgnt1111111111111111111111111111111111111';
const FAKE_AGENT_OVER = 'OvrAgnt1111111111111111111111111111111111111';
const FAKE_AGENT_OPS  = 'OpsAgnt1111111111111111111111111111111111111';
const FAKE_MINT       = 'NaveGov111111111111111111111111111111111111';

// ═══════════════════════════════════════════════════════════════════════════════
// Treasury data (useTreasuryData)
// ═══════════════════════════════════════════════════════════════════════════════

function generateTreasuryHistory(): TreasurySnapshot[] {
  const snapshots: TreasurySnapshot[] = [];
  let value = 112_000;
  for (let i = 90; i >= 0; i--) {
    // Organic-looking growth with minor dips
    const delta = (Math.random() - 0.35) * 800;
    value = Math.max(95_000, value + delta);
    snapshots.push({
      totalValueUsd: Math.round(value),
      solBalance: +(value * 0.42 / 175).toFixed(2),  // ~42% in SOL at ~$175
      usdcBalance: +(value * 0.38).toFixed(2),        // ~38% in USDC
      strategyPositions: [],
      tokenBalances: [],
      snapshotAt: daysAgo(i),
    });
  }
  // Ensure final value is close to our target
  const last = snapshots[snapshots.length - 1];
  last.totalValueUsd = 138_950;
  last.solBalance = 336.4;
  last.usdcBalance = 52_800;
  return snapshots;
}

export const MOCK_TREASURY_HISTORY: TreasurySnapshot[] = generateTreasuryHistory();

export const MOCK_STRATEGIES: StrategyInfo[] = [];

export const MOCK_ASSETS: AssetInfo[] = [
  { name: 'Solana',   symbol: 'SOL',  balance: 336.4,  valueUsd: 58_870, allocation: 52.7 },
  { name: 'USD Coin', symbol: 'USDC', balance: 52_800, valueUsd: 52_800, allocation: 47.3 },
];

export const MOCK_ALLOCATION = [
  { name: 'SOL',  value: 52.7, color: 'hsl(var(--foreground))' },
  { name: 'USDC', value: 47.3, color: 'hsl(var(--muted-foreground))' },
];

// ═══════════════════════════════════════════════════════════════════════════════
// Agent status (useAgentStatus)
// ═══════════════════════════════════════════════════════════════════════════════

export const MOCK_AGENTS: AgentStatusInfo[] = [
  {
    role: 'executive',
    pubkey: FAKE_AGENT_EXEC,
    active: true,
    nullified: false,
    canSign: true,
    status: AgentStatus.Active,
    actionsCount: 47,
    lastActionAt: unixDaysAgo(0),
  },
  {
    role: 'financial',
    pubkey: FAKE_AGENT_FIN,
    active: true,
    nullified: false,
    canSign: true,
    status: AgentStatus.Active,
    actionsCount: 128,
    lastActionAt: unixDaysAgo(0),
  },
  {
    role: 'oversight',
    pubkey: FAKE_AGENT_OVER,
    active: true,
    nullified: false,
    canSign: true,
    status: AgentStatus.Active,
    actionsCount: 112,
    lastActionAt: unixDaysAgo(0),
  },
  {
    role: 'operational',
    pubkey: FAKE_AGENT_OPS,
    active: true,
    nullified: false,
    canSign: false,
    status: AgentStatus.Active,
    actionsCount: 284,
    lastActionAt: unixDaysAgo(0),
  },
];

export const MOCK_AGENT_SET: AgentSet = {
  dao: MOCK_DAO_ADDRESS,
  executive: { pubkey: FAKE_AGENT_EXEC, role: 0, canSign: true, nullified: false, nullifiedAt: 0, actionsCount: 47, lastActionAt: unixDaysAgo(0), status: AgentStatus.Active },
  financial:  { pubkey: FAKE_AGENT_FIN,  role: 1, canSign: true, nullified: false, nullifiedAt: 0, actionsCount: 128, lastActionAt: unixDaysAgo(0), status: AgentStatus.Active },
  oversight:  { pubkey: FAKE_AGENT_OVER, role: 2, canSign: true, nullified: false, nullifiedAt: 0, actionsCount: 112, lastActionAt: unixDaysAgo(0), status: AgentStatus.Active },
  operational:{ pubkey: FAKE_AGENT_OPS,  role: 3, canSign: false, nullified: false, nullifiedAt: 0, actionsCount: 284, lastActionAt: unixDaysAgo(0), status: AgentStatus.Active },
  agentsEnabled: true,
  reviewWindowSeconds: 172800,
  bump: 255,
};

export const MOCK_ACTION_LOGS: AgentActionLog[] = [
  { id: 'al-1', agentRole: 'financial',   actionType: 'deposit',       reasoning: 'Deploying idle stablecoin to approved lending protocol for yield optimization. Current balance exceeds constitutional minimum reserves by 12%. Selected protocol offers highest available approved yield.', status: 'completed', createdAt: daysAgo(0), completedAt: daysAgo(0), confidenceScore: 92, riskFlags: [], decision: 'approve', claudeModel: 'claude-sonnet-4-5-20250514', constitutionCheck: { max_single_allocation_ok: true, max_total_deployed_ok: true, min_reserves_ok: true, protocol_allocation_cap_ok: true, details: 'Protocol allocation at 22% (cap: 30%). Total deployed at 65% (max: 75%). Reserves at 38% (min: 35%).' }, payloadHash: 'a1b2c3d4e5f6', executionRequestAddress: 'ExReq1111111111111111111111111111111111111', errorMessage: '', retryCount: 0 },
  { id: 'al-2', agentRole: 'oversight',   actionType: 'validation',    reasoning: 'Independent constitutional compliance review passed. Verified Financial Agent payload hash matches expected transaction. Executive alignment confirmed. All BPS parameters within bounds.', status: 'completed', createdAt: daysAgo(0), completedAt: daysAgo(0), confidenceScore: 95, riskFlags: [], decision: 'approve', claudeModel: 'claude-sonnet-4-5-20250514', constitutionCheck: { executive_alignment_confirmed: true, financial_viability_confirmed: true, payload_hash_match: true, all_constitutional_params_ok: true, details: 'Cross-verified all parameters. No discrepancies found.' }, payloadHash: 'a1b2c3d4e5f6', executionRequestAddress: 'ExReq1111111111111111111111111111111111111', errorMessage: '', retryCount: 0 },
  { id: 'al-3', agentRole: 'operational', actionType: 'monitoring',    reasoning: 'Policy compliance check passed — all positions within constitutional limits. No suspicious activity detected. Market conditions stable.', status: 'completed', createdAt: daysAgo(0), completedAt: daysAgo(0), confidenceScore: 88, riskFlags: [], decision: 'continue', claudeModel: 'claude-sonnet-4-5-20250514', constitutionCheck: {}, payloadHash: '', executionRequestAddress: 'ExReq1111111111111111111111111111111111111', errorMessage: '', retryCount: 0 },
  { id: 'al-4', agentRole: 'financial',   actionType: 'stake',         reasoning: 'Deployed SOL to liquid staking strategy within constitutional cap. Liquid staking receipt tokens provide SOL-equivalent exit liquidity.', status: 'completed', createdAt: daysAgo(0), completedAt: daysAgo(0), confidenceScore: 89, riskFlags: [], decision: 'approve', claudeModel: 'claude-sonnet-4-5-20250514', constitutionCheck: { max_single_allocation_ok: true, max_total_deployed_ok: true, min_reserves_ok: true, protocol_allocation_cap_ok: true, details: 'Liquid staking allocation at 28% (cap: 35%).' }, payloadHash: 'f6e5d4c3b2a1', executionRequestAddress: 'ExReq2222222222222222222222222222222222222', errorMessage: '', retryCount: 0 },
  { id: 'al-5', agentRole: 'executive',   actionType: 'rebalance',     reasoning: 'Initiated rebalance to meet governance-mandated allocation targets. Proposal #6 passed with 82% approval rate, well above quorum. Constitutional alignment confirmed — rebalance targets are within approved protocol caps.', status: 'completed', createdAt: daysAgo(0), completedAt: daysAgo(0), confidenceScore: 94, riskFlags: [], decision: 'approve', claudeModel: 'claude-sonnet-4-5-20250514', constitutionCheck: { risk_preset_compliant: true, approved_protocol: true, within_allocation_limit: true, reserves_maintained: true, details: 'Proposal #6 approved via governance. Rebalance targets within approved protocol allocation caps.' }, payloadHash: '', executionRequestAddress: 'ExReq3333333333333333333333333333333333333', errorMessage: '', retryCount: 0 },
  { id: 'al-6', agentRole: 'operational', actionType: 'alert',         reasoning: 'Stablecoin reserve approaching floor — 2% above constitutional minimum of 35%. Recommending the Financial Agent pause further stablecoin deployments until reserves rebuild above 40%.', status: 'completed', createdAt: daysAgo(1), completedAt: daysAgo(1), confidenceScore: 76, riskFlags: ['reserves_near_minimum', 'recommend_pause_deployment'], decision: 'request_review', claudeModel: 'claude-sonnet-4-5-20250514', constitutionCheck: {}, payloadHash: '', executionRequestAddress: '', errorMessage: '', retryCount: 0 },
  { id: 'al-7', agentRole: 'financial',   actionType: 'harvest',       reasoning: 'Harvested yield strategy rewards and compounded back into vault. No constitutional parameters affected as this is yield compounding, not new capital deployment.', status: 'completed', createdAt: daysAgo(2), completedAt: daysAgo(2), confidenceScore: 97, riskFlags: [], decision: 'approve', claudeModel: 'claude-sonnet-4-5-20250514', constitutionCheck: { max_single_allocation_ok: true, max_total_deployed_ok: true, min_reserves_ok: true, protocol_allocation_cap_ok: true, details: 'Yield compounding — no new allocation required.' }, payloadHash: 'c3d4e5f6a1b2', executionRequestAddress: 'ExReq5555555555555555555555555555555555555', errorMessage: '', retryCount: 0 },
];

// ═══════════════════════════════════════════════════════════════════════════════
// Activity log (useActivityLog)
// ═══════════════════════════════════════════════════════════════════════════════

export const MOCK_ACTIVITIES: ActivityEntry[] = [
  { id: 'act-1',  eventType: 'agent_deposit',    description: 'Financial Agent deployed capital to approved yield strategy',    actor: FAKE_AGENT_FIN,  agentRole: 'financial',   txSignature: '5xKp3m…abc', slot: 298401200, blockTime: daysAgo(0), createdAt: daysAgo(0), rawData: {} },
  { id: 'act-2',  eventType: 'agent_validation',  description: 'Operational Agent validated: transaction within policy bounds',    actor: FAKE_AGENT_OVER, agentRole: 'oversight',   txSignature: '5xKp3m…abd', slot: 298401201, blockTime: daysAgo(0), createdAt: daysAgo(0), rawData: {} },
  { id: 'act-3',  eventType: 'agent_alert',       description: 'Oversight Agent flagged: stablecoin reserve approaching floor', actor: FAKE_AGENT_OPS,  agentRole: 'operational', txSignature: '',            slot: null,      blockTime: daysAgo(0), createdAt: daysAgo(0), rawData: {} },
  { id: 'act-4',  eventType: 'agent_stake',       description: 'Financial Agent deployed SOL to liquid staking strategy',        actor: FAKE_AGENT_FIN,  agentRole: 'financial',   txSignature: '9aRz8v…efg', slot: 298398100, blockTime: daysAgo(0), createdAt: daysAgo(0), rawData: {} },
  { id: 'act-5',  eventType: 'agent_rebalance',   description: 'Executive Agent initiated rebalance based on governance mandate', actor: FAKE_AGENT_EXEC, agentRole: 'executive', txSignature: '4sLm1n…hij', slot: 298395000, blockTime: daysAgo(0), createdAt: daysAgo(0), rawData: {} },
  { id: 'act-6',  eventType: 'agent_compliance',  description: 'Oversight Agent: policy compliance check passed',              actor: FAKE_AGENT_OPS,  agentRole: 'operational', txSignature: '',            slot: null,      blockTime: daysAgo(0), createdAt: daysAgo(0), rawData: {} },
  { id: 'act-7',  eventType: 'proposal_created',  description: 'Proposal #6 created: Increase minimum stablecoin reserve to 45%', actor: FAKE_WALLET_A, agentRole: null, txSignature: '7xKp3m…klm', slot: 298380000, blockTime: daysAgo(2), createdAt: daysAgo(2), rawData: {} },
  { id: 'act-8',  eventType: 'proposal_voted',    description: 'Vote cast on Proposal #6: Increase minimum stablecoin reserve', actor: FAKE_WALLET_B, agentRole: null, txSignature: '2hYn5c…nop', slot: 298360000, blockTime: daysAgo(4), createdAt: daysAgo(4), rawData: {} },
  { id: 'act-9',  eventType: 'guardian_update',    description: 'Threshold changed from 2-of-3 to 2-of-4',                      actor: FAKE_WALLET_A, agentRole: null, txSignature: '8dVc2x…qrs', slot: 298200000, blockTime: daysAgo(10), createdAt: daysAgo(10), rawData: {} },
  { id: 'act-10', eventType: 'dao_created',        description: 'Treasury vault initialized',                                    actor: FAKE_WALLET_A, agentRole: null, txSignature: '7xKp3m…tuv', slot: 297000000, blockTime: daysAgo(45), createdAt: daysAgo(45), rawData: {} },
];

// ═══════════════════════════════════════════════════════════════════════════════
// Proposals (useProposals)
// ═══════════════════════════════════════════════════════════════════════════════

const now = Math.floor(Date.now() / 1000);

export const MOCK_PROPOSALS: ProposalInfo[] = [
  {
    index: 6,
    proposer: FAKE_WALLET_B,
    proposalType: ProposalType.Policy,
    title: 'Increase minimum stablecoin reserve to 45%',
    description: 'Amid increased market volatility, this proposal raises the minimum stablecoin floor from 35% to 45%. The agent will be required to rebalance to meet this threshold within 48 hours of passage.',
    votesFor: 22100,
    votesAgainst: 18400,
    voterCount: 88,
    status: ProposalStatus.Active,
    voteTokenMint: FAKE_MINT,
    snapshotSlot: 298300000,
    snapshotSupply: 1_000_000,
    quorumBps: 2000,
    threshold: 20000,
    votingEnd: now + 1 * 86400,
    createdAt: unixDaysAgo(4),
    executedAt: 0,
    payloadHash: 'b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3',
    archived: false,
    pda: 'Prop6PDA111111111111111111111111111111111111',
  },
  {
    index: 5,
    proposer: FAKE_WALLET_A,
    proposalType: ProposalType.Permission,
    title: 'Add 3 community council members to multisig',
    description: 'Expand the guardian multisig from 3 to 6 members by adding three elected community council wallets. Threshold would increase from 2-of-3 to 3-of-6.',
    votesFor: 31200,
    votesAgainst: 4800,
    voterCount: 65,
    status: ProposalStatus.Passed,
    voteTokenMint: FAKE_MINT,
    snapshotSlot: 298100000,
    snapshotSupply: 1_000_000,
    quorumBps: 2000,
    threshold: 20000,
    votingEnd: unixDaysAgo(5),
    createdAt: unixDaysAgo(12),
    executedAt: unixDaysAgo(5),
    payloadHash: 'c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
    archived: false,
    pda: 'Prop5PDA111111111111111111111111111111111111',
  },
  {
    index: 4,
    proposer: FAKE_WALLET_B,
    proposalType: ProposalType.Strategy,
    title: 'Allocate 20% of treasury to liquid staking strategy',
    description: 'Deploy up to 20% of treasury SOL into an approved liquid staking strategy to earn validator rewards while maintaining liquidity via liquid staking receipts.',
    votesFor: 28900,
    votesAgainst: 6200,
    voterCount: 71,
    status: ProposalStatus.Executed,
    voteTokenMint: FAKE_MINT,
    snapshotSlot: 297800000,
    snapshotSupply: 1_000_000,
    quorumBps: 2000,
    threshold: 20000,
    votingEnd: unixDaysAgo(20),
    createdAt: unixDaysAgo(27),
    executedAt: unixDaysAgo(20),
    payloadHash: 'd4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5',
    archived: false,
    pda: 'Prop4PDA111111111111111111111111111111111111',
  },
  {
    index: 3,
    proposer: FAKE_WALLET_C,
    proposalType: ProposalType.Policy,
    title: 'Set rebalance frequency to weekly',
    description: 'Change the autonomous rebalance cadence from daily to weekly to reduce gas costs and minimize slippage on small adjustments.',
    votesFor: 19500,
    votesAgainst: 12400,
    voterCount: 54,
    status: ProposalStatus.Passed,
    voteTokenMint: FAKE_MINT,
    snapshotSlot: 297600000,
    snapshotSupply: 1_000_000,
    quorumBps: 2000,
    threshold: 20000,
    votingEnd: unixDaysAgo(28),
    createdAt: unixDaysAgo(35),
    executedAt: unixDaysAgo(28),
    payloadHash: 'e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6',
    archived: false,
    pda: 'Prop3PDA111111111111111111111111111111111111',
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
// Execution pipeline (useExecutionPipeline)
// ═══════════════════════════════════════════════════════════════════════════════

export const MOCK_EXECUTIONS: ExecutionInfo[] = [
  {
    proposal: 'Prop5PDA111111111111111111111111111111111111',
    protocolProgram: '11111111111111111111111111111111',
    status: ExecutionStatus.InReview,
    executiveApprovedAt: unixDaysAgo(1),
    financialApprovedAt: unixDaysAgo(1),
    oversightApprovedAt: unixDaysAgo(0),
    txPayloadHash: 'aabb11223344',
    operationalHalt: false,
    operationalHaltReason: '',
    operationalCleared: false,
    reviewWindowEndsAt: now + 36 * 3600,
    executedAt: 0,
    agentsBypassed: false,
    amount: 5_000_000_000,
    protocolName: 'guardian_update',
    timeRemainingSeconds: 36 * 3600,
  },
  {
    proposal: 'Prop4PDA111111111111111111111111111111111111',
    protocolProgram: '11111111111111111111111111111111',
    status: ExecutionStatus.Executed,
    executiveApprovedAt: unixDaysAgo(21),
    financialApprovedAt: unixDaysAgo(21),
    oversightApprovedAt: unixDaysAgo(21),
    txPayloadHash: 'ccdd55667788',
    operationalHalt: false,
    operationalHaltReason: '',
    operationalCleared: true,
    reviewWindowEndsAt: unixDaysAgo(19),
    executedAt: unixDaysAgo(20),
    agentsBypassed: false,
    amount: 28_400_000_000,
    protocolName: 'Jito',
    timeRemainingSeconds: 0,
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
// Constitution (useConstitution)
// ═══════════════════════════════════════════════════════════════════════════════

export const MOCK_CONSTITUTION: ConstitutionData = {
  riskPreset: 'moderate',
  maxSingleAllocationBps: 3000,  // 30%
  maxTotalDeployedBps: 6500,     // 65%
  rebalanceFrequencySeconds: 604800,  // weekly
  approvedProtocols: [
    { protocolId: 'kamino',   programId: '11111111111111111111111111111111', maxAllocationBps: 2500, approved: true },
    { protocolId: 'jito',     programId: '11111111111111111111111111111111', maxAllocationBps: 2800, approved: true },
    { protocolId: 'marginfi', programId: '11111111111111111111111111111111', maxAllocationBps: 2000, approved: true },
    { protocolId: 'jupiter',  programId: '11111111111111111111111111111111', maxAllocationBps: 1500, approved: false },
  ],
  protocolCount: 4,
  minReservesBps: 3500,  // 35%
  minLiquidityBps: 2000, // 20% immediate-liquidity floor
  reviewWindowSecs: 86400,  // 24h
};

export const MOCK_CONSTITUTION_ON_CHAIN: TreasuryConstitution = {
  dao: MOCK_DAO_ADDRESS,
  riskPreset: 'moderate',
  maxSingleAllocationBps: 3000,
  maxTotalDeployedBps: 6500,
  rebalanceFrequencySeconds: 604800,
  approvedProtocols: MOCK_CONSTITUTION.approvedProtocols,
  protocolCount: 3,
  minReservesBps: 2000,
  minStablecoinReserveBps: 3500,  // 35%
  minLiquidityBps: 2000,          // 20%
  lastRebalanceAt: 0,
  confidenceThreshold: 70,
  reviewWindowSecs: 86400,
  bump: 255,
};

// ═══════════════════════════════════════════════════════════════════════════════
// Guardian config (useGuardianConfig)
// ═══════════════════════════════════════════════════════════════════════════════

export const MOCK_GUARDIANS: GuardianInfo[] = [
  { wallet: FAKE_WALLET_A, label: 'Lead Contributor', isOnChain: true },
  { wallet: FAKE_WALLET_B, label: 'Core Team',        isOnChain: true },
  { wallet: FAKE_WALLET_C, label: 'Community Council', isOnChain: true },
];

export const MOCK_GUARDIAN_CONFIG: GuardianConfig = {
  dao: MOCK_DAO_ADDRESS,
  wallets: [FAKE_WALLET_A, FAKE_WALLET_B, FAKE_WALLET_C],
  threshold: 2,
  walletCount: 3,
  bump: 255,
};

// ═══════════════════════════════════════════════════════════════════════════════
// Token registry (useTokenRegistry)
// ═══════════════════════════════════════════════════════════════════════════════

export const MOCK_TOKENS: TokenInfo[] = [
  {
    slotIndex: 0,
    mint: FAKE_MINT,
    name: 'Nave Governance',
    symbol: 'NAVE',
    decimals: 6,
    supply: 1_000_000,
    isMinted: true,
    isNaveManaged: true,
    mintAuthorityRevoked: false,
    freezeAuthorityRevoked: true,
    metadataAuthorityRevoked: false,
    canReceiveProposals: true,
    createdAt: unixDaysAgo(45),
  },
];

export const MOCK_TOKEN_REGISTRY: TokenRegistry = {
  dao: MOCK_DAO_ADDRESS,
  tokens: [
    {
      mint: FAKE_MINT,
      name: 'Nave Governance',
      symbol: 'NAVE',
      decimals: 6,
      supply: 1_000_000,
      isMinted: true,
      isNaveManaged: true,
      mintAuthorityRevoked: false,
      freezeAuthorityRevoked: true,
      metadataAuthorityRevoked: false,
      canReceiveProposals: true,
      createdAt: unixDaysAgo(45),
    },
  ],
  tokenCount: 1,
  bump: 255,
};

// ═══════════════════════════════════════════════════════════════════════════════
// Monthly reports (useMonthlyReports)
// ═══════════════════════════════════════════════════════════════════════════════

const MOCK_MONTHLY_REPORTS_RAW: MonthlyReport[] = [
  { year: 2025, month: 5,  capitalStart: 132_400, capitalEnd: 138_950, yieldEarned: 812,  feesCollected: 85,  agentActionsCount: 94,  walletActionsCount: 8,  proposalsCount: 2, summary: {}, returnPct: 4.95 },
  { year: 2025, month: 4,  capitalStart: 125_800, capitalEnd: 132_400, yieldEarned: 740,  feesCollected: 78,  agentActionsCount: 87,  walletActionsCount: 5,  proposalsCount: 1, summary: {}, returnPct: 5.25 },
  { year: 2025, month: 3,  capitalStart: 118_200, capitalEnd: 125_800, yieldEarned: 680,  feesCollected: 71,  agentActionsCount: 76,  walletActionsCount: 4,  proposalsCount: 2, summary: {}, returnPct: 6.43 },
  { year: 2025, month: 2,  capitalStart: 112_000, capitalEnd: 118_200, yieldEarned: 582,  feesCollected: 62,  agentActionsCount: 65,  walletActionsCount: 6,  proposalsCount: 1, summary: {}, returnPct: 5.54 },
  { year: 2025, month: 1,  capitalStart: 100_000, capitalEnd: 112_000, yieldEarned: 0,    feesCollected: 0,   agentActionsCount: 12,  walletActionsCount: 15, proposalsCount: 0, summary: {}, returnPct: 12.0 },
];

function buildYearlyGroups(months: MonthlyReport[]): YearlyReportGroup[] {
  const yearMap = new Map<number, MonthlyReport[]>();
  for (const m of months) {
    if (!yearMap.has(m.year)) yearMap.set(m.year, []);
    yearMap.get(m.year)!.push(m);
  }
  return Array.from(yearMap.entries())
    .map(([year, months]) => ({
      year,
      months: months.sort((a, b) => a.month - b.month),
      totalYield: months.reduce((s, m) => s + m.yieldEarned, 0),
      totalFees: months.reduce((s, m) => s + m.feesCollected, 0),
    }))
    .sort((a, b) => b.year - a.year);
}

export const MOCK_MONTHLY_REPORTS = MOCK_MONTHLY_REPORTS_RAW;
export const MOCK_YEARLY_REPORTS: YearlyReportGroup[] = buildYearlyGroups(MOCK_MONTHLY_REPORTS_RAW);

// ═══════════════════════════════════════════════════════════════════════════════
// DAO registry (useDaoRegistry)
// ═══════════════════════════════════════════════════════════════════════════════

export const MOCK_DAO_REGISTRY: DaoRegistry = {
  founder: FAKE_WALLET_A,
  daoId: 0,
  governanceType: 'token',
  frozen: false,
  proposalCount: 7,
  archivedProposalCount: 0,
  executionRequestCount: 2,
  privacyMode: 0,
  agentsEnabled: true,
  quorumBps: 2000,
  createdAt: unixDaysAgo(45),
  frozenAt: 0,
  bump: 255,
};

export const MOCK_DAO_DATA: DaoData = {
  name: 'Nave Test DAO',
  slug: 'nave',
  description: 'A demonstration treasury showcasing the full Nave protocol — autonomous agents, constitutional governance, and multi-strategy yield optimization on Solana.',
  logoUrl: '',
  governanceType: 'token',
  privacyEnabled: false,
  creatorWallet: FAKE_WALLET_A,
  socialTwitter: 'NaveProtocol',
  socialDiscord: 'nave-protocol',
  socialWebsite: 'https://nave.finance',
  createdAt: daysAgo(45),
  daoOnchainAddress: MOCK_DAO_ADDRESS,
  chainId: null,
  frozen: false,
  proposalCount: 7,
  archivedProposalCount: 0,
  executionRequestCount: 2,
  agentsEnabled: true,
  onChainData: MOCK_DAO_REGISTRY,
};

// ═══════════════════════════════════════════════════════════════════════════════
// Dashboard-specific display constants
// These are consumed directly by the Dashboard page's hardcoded sub-components.
// ═══════════════════════════════════════════════════════════════════════════════

export const MOCK_DASHBOARD_STRATEGIES: StrategyInfo[] = [];

export const MOCK_DASHBOARD_ASSETS = [
  { symbol: 'SOL',  name: 'Solana',   balance: '336.4',  value: '$58,870', change: '+2.4%', up: true, protocol: null },
  { symbol: 'USDC', name: 'USD Coin', balance: '52,800', value: '$52,800', change: '+0.0%', up: true, protocol: null },
];

export const MOCK_DASHBOARD_ALLOC = [
  { name: 'SOL',  value: 53, color: 'hsl(var(--foreground))' },
  { name: 'USDC', value: 47, color: 'hsl(var(--muted-foreground))' },
];

export const MOCK_DASHBOARD_AGENT_STATUS = [
  { icon: 'crown',           label: 'Executive',   status: 'active' as const, lastAction: '4m ago' },
  { icon: 'money-bill-wave', label: 'Financial',   status: 'active' as const, lastAction: '2m ago' },
  { icon: 'eye',             label: 'Operational', status: 'active' as const, lastAction: '2m ago' },
  { icon: 'gear',            label: 'Oversight',   status: 'active' as const, lastAction: '1m ago' },
];

export const MOCK_DASHBOARD_RECENT_ACTIVITY = [
  { id: 1, desc: 'Financial Agent deployed capital to approved yield strategy',       agent: 'Financial',   time: '2m ago',  status: 'success' },
  { id: 2, desc: 'Operational Agent validated: transaction within policy bounds',       agent: 'Operational', time: '2m ago',  status: 'success' },
  { id: 3, desc: 'Oversight Agent flagged: stablecoin reserve approaching floor',     agent: 'Oversight',   time: '14m ago', status: 'warning' },
  { id: 4, desc: 'Financial Agent deployed SOL to liquid staking strategy',           agent: 'Financial',   time: '45m ago', status: 'success' },
  { id: 5, desc: 'Executive Agent initiated rebalance based on governance mandate',   agent: 'Executive',   time: '1h ago',  status: 'success' },
  { id: 6, desc: 'Oversight Agent: policy compliance check passed',                   agent: 'Oversight',   time: '2h ago',  status: 'success' },
];

export const MOCK_DASHBOARD_YIELD_BY_ASSET: { asset: string; earned: number; color: string }[] = [];

function generateMonthlyYield() {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May'];
  return months.map((m, i) => ({
    month: m,
    yield: [0, 582, 680, 740, 812][i],
  }));
}

export const MOCK_DASHBOARD_MONTHLY_YIELD = generateMonthlyYield();

function generateTreasuryChart() {
  const history = MOCK_TREASURY_HISTORY;
  // Sample every ~7 days for the chart display
  const sampled: { date: string; value: number }[] = [];
  for (let i = 0; i < history.length; i += 7) {
    const snap = history[Math.min(i, history.length - 1)];
    const d = new Date(snap.snapshotAt);
    sampled.push({
      date: `${d.toLocaleString('default', { month: 'short' })} ${d.getDate()}`,
      value: snap.totalValueUsd,
    });
  }
  // Always include the latest
  const last = history[history.length - 1];
  const lastD = new Date(last.snapshotAt);
  const lastEntry = {
    date: `${lastD.toLocaleString('default', { month: 'short' })} ${lastD.getDate()}`,
    value: last.totalValueUsd,
  };
  if (sampled[sampled.length - 1]?.date !== lastEntry.date) {
    sampled.push(lastEntry);
  }
  return sampled;
}

export const MOCK_DASHBOARD_TREASURY_HISTORY = generateTreasuryChart();

export const MOCK_DASHBOARD_REPORT_YEARS = [
  {
    year: 2025,
    months: [
      {
        idx: 1,
        month: 'January',
        capitalBefore: 100_000,
        capitalAfter: 112_000,
        yieldEarned: 0,
        agentActions: [] as { agent: string; action: string; amount?: string }[],
        walletActions: [
          { wallet: '7xKp…3mBf', action: 'Treasury initialized — 100,000 USDC deposited', amount: '$100,000' },
        ],
        proposals: [] as { id: string; title: string; vote: string; result: string }[],
      },
      {
        idx: 2,
        month: 'February',
        capitalBefore: 112_000,
        capitalAfter: 118_200,
        yieldEarned: 582,
        agentActions: [
          { agent: 'Financial', action: 'Deployed SOL to liquid staking strategy', amount: '$20,400' },
          { agent: 'Financial', action: 'Deployed USDC to lending protocol', amount: '$15,000' },
          { agent: 'Operational', action: 'Validated all transactions', amount: undefined },
        ],
        walletActions: [
          { wallet: '9aRz…8vWq', action: 'Added 12,000 USDC to treasury', amount: '$12,000' },
        ],
        proposals: [
          { id: '#3', title: 'Set rebalance frequency to weekly', vote: 'For', result: 'Passed' },
        ],
      },
      {
        idx: 3,
        month: 'March',
        capitalBefore: 118_200,
        capitalAfter: 125_800,
        yieldEarned: 680,
        agentActions: [
          { agent: 'Financial', action: 'Compounded yield strategy rewards', amount: '$340' },
          { agent: 'Financial', action: 'Rebalanced SOL/USDC allocation', amount: undefined },
          { agent: 'Executive', action: 'Initiated governance-mandated rebalance', amount: undefined },
        ],
        walletActions: [],
        proposals: [
          { id: '#4', title: 'Allocate 20% to liquid staking strategy', vote: 'For', result: 'Passed' },
          { id: '#5', title: 'Add 3 community council members', vote: 'For', result: 'Passed' },
        ],
      },
      {
        idx: 4,
        month: 'April',
        capitalBefore: 125_800,
        capitalAfter: 132_400,
        yieldEarned: 740,
        agentActions: [
          { agent: 'Financial', action: 'Deployed USDC to lending strategy', amount: '$5,000' },
          { agent: 'Financial', action: 'Harvested liquid staking rewards', amount: '$410' },
          { agent: 'Oversight', action: 'Flagged approaching stablecoin floor', amount: undefined },
        ],
        walletActions: [],
        proposals: [
          { id: '#6', title: 'Increase stablecoin reserve to 45%', vote: 'For', result: 'Pending' },
        ],
      },
      {
        idx: 5,
        month: 'May',
        capitalBefore: 132_400,
        capitalAfter: 138_950,
        yieldEarned: 812,
        agentActions: [
          { agent: 'Financial', action: 'Deployed USDC to lending strategy', amount: '$5,000' },
          { agent: 'Financial', action: 'Deployed SOL to liquid staking strategy', amount: '$8,750' },
          { agent: 'Operational', action: 'Validated 12 transactions', amount: undefined },
          { agent: 'Oversight', action: 'Policy compliance: 94 checks passed', amount: undefined },
        ],
        walletActions: [
          { wallet: '7xKp…3mBf', action: 'Deposited 2,000 USDC', amount: '$2,000' },
        ],
        proposals: [
          { id: '#6', title: 'Increase stablecoin reserve to 45%', vote: 'For', result: 'Active' },
        ],
      },
    ],
  },
];