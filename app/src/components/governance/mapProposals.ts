import type { ProposalInfo } from '@/hooks/useProposals';
import { AGENT_ENABLE_PROPOSAL_TITLE } from '@/lib/programConfig';
import {
  ProposalStatus as OnChainProposalStatus,
  ProposalType as OnChainProposalType,
} from '@/lib/onChainTypes';
import type { Proposal, ProposalStatus, ProposalType } from './types';

export function mapLiveProposalsToUi(
  proposals: ProposalInfo[],
  daoQuorumBps: number,
): Proposal[] {
  const statusMap: Record<number, ProposalStatus> = {
    [OnChainProposalStatus.Active]: 'active',
    [OnChainProposalStatus.Passed]: 'passed',
    [OnChainProposalStatus.Failed]: 'rejected',
    [OnChainProposalStatus.Cancelled]: 'pending',
    [OnChainProposalStatus.Executed]: 'executed',
  };
  const typeMap: Record<number, ProposalType> = {
    [OnChainProposalType.Policy]: 'policy',
    [OnChainProposalType.Strategy]: 'strategy',
    [OnChainProposalType.Permission]: 'permission',
    [OnChainProposalType.Emergency]: 'emergency',
    [OnChainProposalType.General]: 'general',
    [OnChainProposalType.Transfer]: 'transfer',
    [OnChainProposalType.TokenMint]: 'token-mint',
    [OnChainProposalType.TokenRevoke]: 'token-revoke',
    [OnChainProposalType.SwitchVotingSystem]: 'switch-voting',
    [OnChainProposalType.MoonlightRequest]: 'moonlight-request',
    [OnChainProposalType.MoonlightDistribution]: 'moonlight-distribution',
  };

  // Mirrors nave_governance ProposalType::quorum_bps: transfers and both
  // moonlight types must clear a 2,500 bps minimum floor regardless of a
  // (possibly very low) DAO-configured quorum.
  const MIN_QUORUM_FLOOR_BPS = 2500;
  const effectiveQuorumBps = (p: ProposalInfo): number => {
    if (p.proposalType === OnChainProposalType.TokenMint) return 2500;
    if (p.proposalType === OnChainProposalType.SwitchVotingSystem) return 7000;
    const base = p.quorumBps > 0 ? p.quorumBps : daoQuorumBps;
    if (
      p.proposalType === OnChainProposalType.Transfer ||
      p.proposalType === OnChainProposalType.MoonlightRequest ||
      p.proposalType === OnChainProposalType.MoonlightDistribution
    ) {
      return Math.max(base, MIN_QUORUM_FLOOR_BPS);
    }
    return base;
  };
  return proposals.map((p: ProposalInfo) => ({
    id: `p${p.index}`,
    number: p.index,
    title: p.title,
    description: p.description,
    type: p.title.startsWith(AGENT_ENABLE_PROPOSAL_TITLE)
      ? ('agent-enable' as ProposalType)
      : typeMap[p.proposalType] || 'general',
    status: statusMap[p.status] || 'pending',
    author: p.proposer.slice(0, 4) + '\u2026' + p.proposer.slice(-4),
    created: new Date(p.createdAt * 1000).toLocaleDateString(),
    deadline: p.votingEnd > Date.now() / 1000
      ? `${Math.ceil((p.votingEnd - Date.now() / 1000) / 86400)}d remaining`
      : 'Ended',
    votesFor: Number.isFinite(p.votesFor) ? p.votesFor : 0,
    votesAgainst: Number.isFinite(p.votesAgainst) ? p.votesAgainst : 0,
    totalVotes: Math.max(0, (Number(p.votesFor) || 0) + (Number(p.votesAgainst) || 0)),
    quorum: p.threshold,
    chainProposalType: p.proposalType,
    votesQuorumBps: effectiveQuorumBps(p),
    votingEndTimestamp: p.votingEnd,
    eligibleTotal: p.snapshotSupply || 0,
    myVote: null,
  }));
}
