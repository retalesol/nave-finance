import { PublicKey } from '@solana/web3.js';
import type { ProposalPipelineStage } from '@/components/governance/ProposalStatusStepper';
import { AGENT_ENABLE_PROPOSAL_TITLE, SWITCH_VOTING_QUORUM_PCT } from '@/lib/programConfig';

/* ── Types ──────────────────────────────────────────────── */
export type ProposalStatus = 'active' | 'passed' | 'rejected' | 'pending' | 'executed';
export type ProposalType = 'policy' | 'strategy' | 'permission' | 'emergency' | 'general' | 'transfer' | 'token-mint' | 'token-revoke' | 'switch-voting' | 'agent-enable' | 'moonlight-request' | 'moonlight-distribution';

export interface Proposal {
  id: string;
  number: number;
  title: string;
  description: string;
  type: ProposalType;
  status: ProposalStatus;
  author: string;
  created: string;
  deadline: string;
  votesFor: number;
  votesAgainst: number;
  totalVotes: number;
  /**
   * On-chain yes-vote threshold (legacy / display); do not use for quorum progress —
   * that follows `votesQuorumBps` + eligible voters like `finalize_proposal` on-chain.
   */
  quorum: number;
  /** Effective quorum bps for this proposal type (matches nave_governance ProposalType::quorum_bps). */
  votesQuorumBps: number;
  /** Raw nave_governance ProposalType enum value from the proposal account. */
  chainProposalType: number;
  /** Unix timestamp (seconds) when the voting window closes. Used to gate finalize. */
  votingEndTimestamp: number;
  /** Total eligible votes (token supply snapshot or guardian count). */
  eligibleTotal: number;
  myVote?: 'for' | 'against' | 'abstain' | null;
  summary?: string;
  /** On-chain payload hash. Charter status is this action, not the treasury's latest review. */
  actionHash: string;
}

/** Transfer payloads use 32 zero bytes for native SOL (vault lamports), not WSOL. */
export const SOLANA_NATIVE_TRANSFER_MINT_PLACEHOLDER = new PublicKey(new Uint8Array(32));

/**
 * Returns true when a proposal is mathematically undefeatable before its deadline.
 * Condition: quorum is already reached AND the FOR lead exceeds all remaining
 * possible votes — no combination of future votes can produce a different outcome.
 *
 * Example: 3 guardians total, 2 voted FOR, 1 hasn't voted.
 *   lead = 2 - 0 = 2 > remaining = 1 → undefeatable.
 *
 * guardianCount is passed in by the Governance page for wallet-gov DAOs (where
 * snapshotSupply = 0 because there is no token supply). It is used as a fallback
 * eligibleTotal when p.eligibleTotal = 0.
 *
 * Mirrors `finalize_proposal` in nave_governance: participation quorum from
 * quorum_bps × eligible, then early finalize when lead > remaining non-voters.
 */
export function eligibleVoterTotal(p: Proposal, guardianCount: number): number {
  return p.eligibleTotal > 0 ? p.eligibleTotal : guardianCount;
}

/** Solana floors quorum. EVM rounds up and never treats quorum as already met. */
export type QuorumRounding = 'floor' | 'ceil';

export function requiredParticipationVotes(
  p: Proposal,
  guardianCount: number,
  rounding: QuorumRounding = 'floor',
): number {
  const eligible = eligibleVoterTotal(p, guardianCount);
  if (eligible <= 0 || p.votesQuorumBps <= 0) return rounding === 'ceil' ? 1 : 0;
  const scaled = (eligible * p.votesQuorumBps) / 10_000;
  const req = rounding === 'ceil' ? Math.ceil(scaled) : Math.floor(scaled);
  return rounding === 'ceil' ? Math.max(1, req) : req;
}

export function hasParticipationQuorum(
  p: Proposal,
  guardianCount: number,
  rounding: QuorumRounding = 'floor',
): boolean {
  const req = requiredParticipationVotes(p, guardianCount, rounding);
  const cast = p.votesFor + p.votesAgainst;
  if (!Number.isFinite(cast)) return false;
  // Solana floor division can yield 0 required votes, and the program then treats
  // quorum as already met. EVM always requires at least one vote.
  if (req <= 0) return true;
  return cast >= req;
}

export function isUndefeatable(
  p: Proposal,
  guardianCount = 0,
  rounding: QuorumRounding = 'floor',
): boolean {
  if (p.status !== 'active') return false;
  const eligible = eligibleVoterTotal(p, guardianCount);
  if (eligible <= 0) return false;
  if (!hasParticipationQuorum(p, guardianCount, rounding)) return false;
  const totalVotes = p.votesFor + p.votesAgainst;
  const remaining = eligible - totalVotes;
  const lead = p.votesFor - p.votesAgainst;
  return lead > remaining;
}

/** True when the voting window has closed (status still 'active' pending finalize call). */
export function votingWindowClosed(p: Proposal): boolean {
  return p.votingEndTimestamp > 0 && Date.now() / 1000 >= p.votingEndTimestamp;
}

export interface FinalizeOptions {
  /**
   * EVM `NaveGovernor.finalizeProposal` no longer reverts with QuorumNotMet
   * after the window closes — it settles the proposal as `Failed` (voters then
   * release their escrow). Solana `finalize_proposal` still requires quorum.
   */
  allowMissedQuorum?: boolean;
  /** EVM rounds the participation requirement up. Solana floors it. */
  quorumRounding?: QuorumRounding;
}

/**
 * True when finalize_proposal can be submitted on-chain.
 * Supports two paths:
 *   1. Normal: voting window has closed (voting_end <= now).
 *   2. Early: quorum is met AND the FOR lead exceeds all remaining possible votes
 *      (isUndefeatable). guardianCount is needed for wallet-governance eligible total.
 */
export function canFinalize(p: Proposal, guardianCount?: number, opts?: FinalizeOptions): boolean {
  if (p.status !== 'active') return false;
  const gc = guardianCount ?? 0;
  if (votingWindowClosed(p)) {
    // Solana: on-chain finalize still requires participation quorum (QuorumNotMet otherwise).
    // EVM: finalize always settles (missed quorum ⇒ status Failed).
    return opts?.allowMissedQuorum ? true : hasParticipationQuorum(p, gc, opts?.quorumRounding);
  }
  return isUndefeatable(p, gc, opts?.quorumRounding);
}

export function getPipelineStage(p: Proposal, guardianCount: number, opts?: FinalizeOptions): ProposalPipelineStage {
  if (p.status === 'executed' || p.status === 'rejected') return 'complete';
  if (p.status === 'passed') return 'execute';
  if (p.status === 'active') {
    return canFinalize(p, guardianCount, opts) ? 'finalize' : 'vote';
  }
  return 'complete';
}

export const TYPE_META: Record<ProposalType, { label: string; icon: string; color: string; bg: string; border: string }> = {
  policy: {
    label: 'Policy Change',
    icon: 'sliders',
    color: 'hsl(var(--foreground))',
    bg: 'hsl(var(--surface-1))',
    border: 'hsl(var(--border))',
  },
  strategy: {
    label: 'Strategy Approval',
    icon: 'chart-line-up',
    color: 'hsl(var(--foreground))',
    bg: 'hsl(var(--surface-1))',
    border: 'hsl(var(--border))',
  },
  permission: {
    label: 'Permission Update',
    icon: 'user-shield',
    color: 'hsl(214 80% 48%)',
    bg: 'hsl(214 100% 97%)',
    border: 'hsl(214 80% 80%)',
  },
  emergency: {
    label: 'Emergency',
    icon: 'triangle-exclamation',
    color: 'hsl(var(--destructive))',
    bg: 'hsl(var(--destructive-muted))',
    border: 'hsl(0 72% 80%)',
  },
  general: {
    label: 'General',
    icon: 'file-lines',
    color: 'hsl(var(--muted-foreground))',
    bg: 'hsl(var(--surface-1))',
    border: 'hsl(var(--border))',
  },
  transfer: {
    label: 'Fund Transfer',
    icon: 'paper-plane',
    color: 'hsl(214 80% 48%)',
    bg: 'hsl(214 100% 97%)',
    border: 'hsl(214 80% 80%)',
  },
  'token-mint': {
    label: 'Token Mint',
    icon: 'coins',
    color: 'hsl(38 80% 42%)',
    bg: 'hsl(38 100% 97%)',
    border: 'hsl(38 92% 75%)',
  },
  'token-revoke': {
    label: 'Token Revoke',
    icon: 'ban',
    color: 'hsl(var(--destructive))',
    bg: 'hsl(var(--destructive-muted))',
    border: 'hsl(0 72% 80%)',
  },
  'switch-voting': {
    label: 'Voting System Change',
    icon: 'arrows-rotate',
    color: 'hsl(271 80% 48%)',
    bg: 'hsl(271 100% 97%)',
    border: 'hsl(271 80% 80%)',
  },
  'agent-enable': {
    label: 'Enable Agents',
    icon: 'play',
    color: 'hsl(152 50% 32%)',
    bg: 'hsl(var(--success-muted))',
    border: 'hsl(152 40% 70%)',
  },
  'moonlight-request': {
    label: 'Moonlight Request',
    icon: 'moon',
    color: 'hsl(271 80% 48%)',
    bg: 'hsl(271 100% 97%)',
    border: 'hsl(271 80% 80%)',
  },
  'moonlight-distribution': {
    label: 'Moonlight Distribution',
    icon: 'moon',
    color: 'hsl(271 80% 48%)',
    bg: 'hsl(271 100% 97%)',
    border: 'hsl(271 80% 80%)',
  },
};

export const STATUS_META: Record<ProposalStatus, { label: string; color: string; bg: string; border: string; icon: string }> = {
  active: {
    label: 'Active',
    color: 'hsl(var(--foreground))',
    bg: 'hsl(var(--surface-1))',
    border: 'hsl(var(--border))',
    icon: 'clock',
  },
  passed: {
    label: 'Passed',
    color: 'hsl(var(--success))',
    bg: 'hsl(var(--success-muted))',
    border: 'hsl(0 0% 85%)',
    icon: 'check',
  },
  rejected: {
    // On-chain `Failed` (voted down OR missed quorum at finalize).
    label: 'Failed',
    color: 'hsl(var(--destructive))',
    bg: 'hsl(var(--destructive-muted))',
    border: 'hsl(0 72% 80%)',
    icon: 'xmark',
  },
  pending: {
    label: 'Pending',
    color: 'hsl(var(--muted-foreground))',
    bg: 'hsl(var(--surface-2))',
    border: 'hsl(var(--border))',
    icon: 'clock',
  },
  executed: {
    label: 'Executed',
    color: 'hsl(214 80% 48%)',
    bg: 'hsl(214 100% 97%)',
    border: 'hsl(214 80% 80%)',
    icon: 'bolt',
  },
};

/* ── Helpers ─────────────────────────────────────────────── */
export function fmtVotes(n: number) {
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return n.toString();
}

export function getProposalDescription(type: ProposalType): string {
  switch (type) {
    case 'strategy':
      return 'This proposal seeks approval to modify treasury deployment strategy. Upon passing, the autonomous agents will adjust their allocation parameters within the approved protocol whitelist accordingly.';
    case 'policy':
      return 'This proposal updates the treasury\'s constitutional policy parameters. All four autonomous agents will operate within the new constraints once the vote passes and the constitution is ratified on-chain.';
    case 'token-mint':
      return 'This proposal requests minting additional governance tokens into the treasury vault. Upon passing and ratification by the founder, the specified token amount is minted on-chain.';
    case 'token-revoke':
      return 'This proposal permanently revokes all mint and freeze authorities for the governance token. This action is irreversible. The protocol returns a SOL deposit to the treasury vault upon ratification.';
    case 'switch-voting':
      return `This proposal changes the DAO's governance model. Switching the voting system requires a ${SWITCH_VOTING_QUORUM_PCT}% quorum. Upon passing and ratification, the on-chain governance mode is updated immediately.`;
    case 'permission':
      return 'This proposal modifies the treasury\'s guardian wallet permissions or multisig configuration. Changes take effect after the vote passes and the on-chain permission set is updated.';
    case 'emergency':
      return 'Emergency governance proposal. If passed, immediate action will be taken to protect treasury assets and halt or modify agent operations as specified. Requires multisig confirmation to resume normal operations.';
    case 'transfer':
      return 'This proposal authorises moving idle treasury funds (native SOL or any token the treasury holds) to a recipient you specified in the payload. After the vote passes and the proposal is finalized, any member can submit the on-chain execute transfer transaction; autonomous agents are not required for this path.';
    case 'agent-enable':
      return 'This proposal requests resuming the four autonomous agents for this treasury. Once it passes, the founder executes the on-chain enable so the Executive, Financial, Operational, and Oversight agents reconnect and begin checking this DAO for necessary actions.';
    case 'moonlight-request':
      return 'This proposal requests winding the DAO down (moonlighting). If it passes and is recorded by the founder, the autonomous agents are halted and the proposal creator unlocks the distribution wizard.';
    case 'moonlight-distribution':
      return 'This proposal binds the moonlight distribution recipient. If it passes, the distribution driver can execute the release of the staked NAVE and distribute remaining treasury assets to the approved recipient.';
    case 'general':
    default:
      return 'General governance proposal subject to a standard community vote. It will take effect once quorum is reached and the majority votes in favour.';
  }
}

/* ── Create Proposal Modal ───────────────────────────────── */
export interface NewProposal {
  title: string;
  description: string;
  type: ProposalType;
  votingPeriod: string;
}

export const PROPOSAL_TEMPLATES: {
  id: string;
  label: string;
  icon: string;
  type: ProposalType;
  title: string;
  votingPeriod: string;
}[] = [
  {
    id: 'rules',
    label: 'Update rules',
    icon: 'sliders',
    type: 'policy',
    title: 'Update treasury constitution',
    votingPeriod: '7',
  },
  {
    id: 'transfer',
    label: 'Transfer funds',
    icon: 'paper-plane',
    type: 'transfer',
    title: 'Propose treasury transfer',
    votingPeriod: '3',
  },
  {
    id: 'strategy',
    label: 'Deploy strategy',
    icon: 'chart-line-up',
    type: 'strategy',
    title: 'Approve yield strategy',
    votingPeriod: '3',
  },
  {
    id: 'agents',
    label: 'Enable agents',
    icon: 'users',
    type: 'agent-enable',
    title: AGENT_ENABLE_PROPOSAL_TITLE,
    votingPeriod: '7',
  },
  {
    id: 'general',
    label: 'General vote',
    icon: 'file-lines',
    type: 'general',
    title: 'General governance proposal',
    votingPeriod: '7',
  },
];