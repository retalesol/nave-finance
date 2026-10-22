import { useState, useEffect, useMemo } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { PageSkeleton } from '@/components/NaveSkeletons';
import NaveEmptyState from '@/components/NaveEmptyState';
import { staggerContainer, staggerChild } from '@/components/PageTransition';
import { UnderlineTabs } from '@/components/calm';
import CreateProposalModal from '@/components/governance/CreateProposalModal';
import ProposalCard from '@/components/governance/ProposalCard';
import { mapLiveProposalsToUi } from '@/components/governance/mapProposals';
import type { ProposalType } from '@/components/governance/types';
import { useDaoContext } from '@/hooks/useDaoContext';
import { useProposals } from '@/hooks/useProposals';
import { useDaoRegistry } from '@/hooks/useDaoRegistry';
import { useGuardianConfig } from '@/hooks/useGuardianConfig';
import { useDaoMembership } from '@/hooks/useDaoMembership';
import { useTokenRegistry } from '@/hooks/useTokenRegistry';

type FilterTab = 'all' | 'active' | 'passed' | 'rejected';

const FILTER_TABS: readonly { id: FilterTab; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'active', label: 'Active' },
  { id: 'passed', label: 'Passed' },
  { id: 'rejected', label: 'Rejected' },
];

export default function Governance() {
  const { daoAddress } = useDaoContext();
  const { proposalId: proposalIdParam } = useParams<{ proposalId?: string }>();
  const highlightProposalNumber = proposalIdParam
    ? Number.parseInt(proposalIdParam.replace(/^p/i, ''), 10)
    : null;
  const location = useLocation();
  const navigate = useNavigate();
  const { dao } = useDaoRegistry(daoAddress);
  const guardian = useGuardianConfig(daoAddress);
  const tokenRegistry = useTokenRegistry(daoAddress);
  const votingMint = tokenRegistry.tokens[0]?.mint ?? null;
  const votingTokenDecimals = tokenRegistry.tokens[0]?.decimals ?? 0;
  const proposalCount =
    typeof dao?.nextProposalIndex === 'number'
      ? dao.nextProposalIndex
      : (dao?.proposalCount ?? 0) + (dao?.archivedProposalCount ?? 0);
  const isTokenGov = dao?.governanceType === 'token';
  const liveProposals = useProposals(daoAddress, proposalCount);

  const allProposals = useMemo(() => {
    if (liveProposals.proposals.length > 0) {
      return mapLiveProposalsToUi(
        liveProposals.proposals,
        dao?.onChainData?.quorumBps ?? 0,
      );
    }
    return [];
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional daoAddress for treasury switch
  }, [liveProposals.proposals, daoAddress, dao?.onChainData?.quorumBps]);

  const [creating, setCreating] = useState(false);
  const [proposeInitial, setProposeInitial] =
    useState<{ title: string; description: string; payload: number[]; type?: ProposalType } | null>(null);
  const [filter, setFilter] = useState<FilterTab>('all');

  const { isMember, isFounder } = useDaoMembership();

  useEffect(() => {
    type HandoffState = {
      proposePolicy?: { title: string; description: string; payload: number[] };
      proposeTokenMint?: { title: string; description: string; payload: number[] };
      proposeSwitchVoting?: { title: string; description: string; payload: number[] };
      proposeAgentEnable?: { title: string; description: string; payload: number[] };
    };
    const state = location.state as HandoffState | null;
    const handoff =
      state?.proposePolicy
        ? { ...state.proposePolicy, type: 'policy' as ProposalType }
        : state?.proposeTokenMint
          ? { ...state.proposeTokenMint, type: 'token-mint' as ProposalType }
          : state?.proposeSwitchVoting
            ? { ...state.proposeSwitchVoting, type: 'switch-voting' as ProposalType }
            : state?.proposeAgentEnable
              ? { ...state.proposeAgentEnable, type: 'agent-enable' as ProposalType }
              : null;
    if (handoff) {
      setProposeInitial(handoff);
      setCreating(true);
      navigate(location.pathname, { replace: true, state: null });
    }
  }, [location.state, location.pathname, navigate]);

  const filtered = allProposals.filter((p) => filter === 'all' || p.status === filter);

  const active = allProposals.filter((p) => p.status === 'active').length;
  const passed = allProposals.filter((p) => p.status === 'passed').length;
  const rejected = allProposals.filter((p) => p.status === 'rejected').length;

  const votingSystemLabel = isTokenGov ? 'Token holders vote' : 'People vote';
  const quorumLabel = 'majority';

  if (liveProposals.loading && liveProposals.proposals.length === 0) {
    return <PageSkeleton variant="governance" />;
  }

  if (!daoAddress) {
    return (
      <div className="p-6 animate-fade-in">
        <NaveEmptyState
          icon="scroll"
          title="No Treasury Selected"
          description="Select a treasury to view and participate in governance proposals."
        />
      </div>
    );
  }

  return (
    <div
      className="animate-fade-in"
      data-onboarding-id="governance-root"
    >
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="nave-label" style={{ marginBottom: '10px' }}>Decisions</div>
          <h1
            style={{
              fontFamily: 'var(--font-display)',
              fontWeight: 400,
              fontSize: '34px',
              lineHeight: 1.1,
              letterSpacing: '-0.02em',
              margin: '0 0 8px',
              color: 'hsl(var(--foreground))',
            }}
          >
            Decide together, <em style={{ fontStyle: 'italic', color: 'hsl(var(--muted-foreground))' }}>then watch it happen.</em>
          </h1>
          <p style={{ color: 'hsl(var(--muted-foreground))', fontSize: '14.5px', margin: 0, maxWidth: '520px' }}>
            A simple majority decides, your agents carry it out, and the result is reported in the same place.
          </p>
        </div>

        <div className="flex items-center gap-3 pt-1 flex-wrap">
          <span
            className="nave-mono"
            style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))' }}
          >
            <b style={{ color: '#9A7414', fontWeight: 600 }}>{active}</b> active ·{' '}
            <b style={{ color: '#2F7D4F', fontWeight: 600 }}>{passed}</b> passed ·{' '}
            <b style={{ color: 'hsl(var(--foreground))', fontWeight: 600 }}>{rejected}</b> rejected
          </span>
          <button
            type="button"
            onClick={() => {
              setProposeInitial(null);
              setCreating(true);
            }}
            className="px-4 py-2 rounded-[9px] font-semibold transition-colors"
            style={{
              fontSize: '13px',
              backgroundColor: 'hsl(var(--foreground))',
              color: '#ffffff',
            }}
          >
            Start a decision
          </button>
        </div>
      </div>

      {/* 1-line Governance rules summary */}
      <div
        className="flex flex-wrap items-center justify-between gap-3"
        style={{
          marginTop: '24px',
          padding: '11px 0',
          borderTop: '1px solid hsl(var(--surface-2))',
          borderBottom: '1px solid hsl(var(--surface-2))',
          fontSize: '13px',
          color: 'hsl(var(--muted-foreground))',
        }}
      >
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span>
            Voting: <b style={{ color: 'hsl(var(--foreground))', fontWeight: 500 }}>{votingSystemLabel}</b>
          </span>
          <span>·</span>
          <span>
            Quorum: <b style={{ color: 'hsl(var(--foreground))', fontWeight: 500 }}>{quorumLabel}</b>
          </span>
        </div>
        <button
          type="button"
          onClick={() => navigate('/rules')}
          className="hover:underline underline-offset-4 flex-shrink-0"
          style={{ fontSize: '13px', fontWeight: 600, color: 'hsl(var(--foreground))' }}
        >
          View rules →
        </button>
      </div>

      {/* Filter tabs + Proposal list */}
      <div style={{ marginTop: '30px' }}>
        <UnderlineTabs
          tabs={FILTER_TABS}
          activeTab={filter}
          onChange={setFilter}
        />

        <motion.div
          variants={staggerContainer}
          initial="initial"
          animate="animate"
          key={filter}
        >
          {filtered.map((proposal) => (
            <motion.div key={proposal.id} variants={staggerChild}>
              <ProposalCard
                proposal={proposal}
                daoAddress={daoAddress}
                isTokenGov={isTokenGov}
                votingMint={votingMint}
                votingTokenDecimals={votingTokenDecimals}
                isFounder={isFounder}
                isMember={isMember}
                guardianCount={guardian.walletCount ?? 0}
                chainId={dao?.chainId ?? null}
                onChanged={liveProposals.refetch}
                highlight={
                  highlightProposalNumber != null &&
                  !Number.isNaN(highlightProposalNumber) &&
                  proposal.number === highlightProposalNumber
                }
              />
            </motion.div>
          ))}
          {filtered.length === 0 && (
            <motion.div
              variants={staggerChild}
              style={{
                padding: '36px 0',
                color: 'hsl(var(--muted-foreground))',
                fontSize: '13.5px',
              }}
            >
              No {filter === 'all' ? '' : filter} proposals yet.
            </motion.div>
          )}
        </motion.div>
      </div>

      <AnimatePresence>
        {creating && (
          <CreateProposalModal
            onClose={() => { setCreating(false); setProposeInitial(null); }}
            daoAddress={daoAddress}
            proposalCount={proposalCount}
            isTokenGov={isTokenGov}
            votingMint={votingMint}
            initial={proposeInitial}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
