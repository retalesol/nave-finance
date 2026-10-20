import { useState, useEffect, useMemo } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import Fi from '@/components/Fi';
import { PageSkeleton } from '@/components/NaveSkeletons';
import NaveEmptyState from '@/components/NaveEmptyState';
import { staggerContainer, staggerChild } from '@/components/PageTransition';
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
import {
  TOKEN_MINT_QUORUM_PCT,
  SWITCH_VOTING_QUORUM_PCT,
} from '@/lib/programConfig';

type FilterTab = 'all' | 'active' | 'passed' | 'rejected';

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

  // Chain-aware: useDaoMembership resolves the active chain's wallet (wagmi
  // address for EVM DAOs, Solana publicKey otherwise) and compares EVM
  // addresses case-insensitively.
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

  const filtered = allProposals.filter(p => filter === 'all' || p.status === filter);

  const active = allProposals.filter(p => p.status === 'active').length;
  const passed = allProposals.filter(p => p.status === 'passed').length;
  const rejected = allProposals.filter(p => p.status === 'rejected').length;

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
      className="flex-1 overflow-y-auto"
      data-onboarding-id="governance-root"
      style={{ backgroundColor: 'hsl(var(--background))' }}
    >
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-5 sm:py-6 space-y-5 sm:space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
          <div>
            <h1
              className="text-display font-semibold"
              style={{ fontSize: '22px', letterSpacing: '-0.02em', color: 'hsl(var(--foreground))' }}
            >
              Governance
            </h1>
            <p style={{ fontSize: '13.5px', color: 'hsl(var(--muted-foreground))', marginTop: '4px' }}>
              Vote on treasury proposals. Create rules changes from the Rules page, token mints from Tokens, and agent resumes from Automation.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2 sm:gap-3">
          {[
            { label: 'Active',   value: active,   color: 'hsl(var(--accent))' },
            { label: 'Passed',   value: passed,   color: 'hsl(var(--foreground))' },
            { label: 'Rejected', value: rejected, color: 'hsl(var(--muted-foreground))' },
          ].map(s => (
            <div key={s.label} className="nave-card p-4 text-center">
              <div className="text-display font-semibold" style={{ fontSize: '24px', color: s.color }}>
                {s.value}
              </div>
              <div className="nave-label" style={{ fontSize: '10px', marginTop: '3px' }}>
                {s.label}
              </div>
            </div>
          ))}
        </div>

        <div
          className="nave-card p-5"
          style={{ backgroundColor: 'hsl(var(--surface-1))' }}
        >
          <div className="flex items-center gap-2 mb-3">
            <Fi icon="users" style={{ fontSize: '14px', color: 'hsl(var(--muted-foreground))' }} />
            <span className="text-display font-semibold" style={{ fontSize: '13.5px' }}>Governance Rules</span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            {[
              {
                label: 'Voting System',
                value: isTokenGov ? 'Token-weighted' : 'Authorized wallets',
              },
              {
                label: 'Standard Quorum',
                value: isTokenGov
                  ? 'Token majority'
                  : guardian.threshold > 0
                    ? `${guardian.threshold}-of-${guardian.walletCount}`
                    : 'Guardian majority',
              },
              { label: 'Token Mint Quorum',   value: `${TOKEN_MINT_QUORUM_PCT}%` },
              { label: 'Switch Voting Quorum', value: `${SWITCH_VOTING_QUORUM_PCT}%` },
            ].map(r => (
              <div key={r.label}>
                <div className="nave-label" style={{ fontSize: '10px' }}>{r.label}</div>
                <div className="nave-mono mt-1" style={{ fontSize: '13px', color: 'hsl(var(--foreground))' }}>
                  {r.value}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div
          className="flex items-center gap-1 p-1 rounded-xl border overflow-x-auto"
          style={{
            backgroundColor: 'hsl(var(--surface-1))',
            borderColor: 'hsl(var(--border))',
            width: 'fit-content',
            maxWidth: '100%',
          }}
        >
          {(['all', 'active', 'passed', 'rejected'] as FilterTab[]).map(tab => (
            <button
              key={tab}
              onClick={() => setFilter(tab)}
              className="px-3 py-1.5 rounded-lg capitalize transition-all"
              style={{
                fontSize: '12.5px',
                fontWeight: filter === tab ? '500' : '400',
                backgroundColor: filter === tab ? 'hsl(var(--surface-0))' : 'transparent',
                color: filter === tab ? 'hsl(var(--foreground))' : 'hsl(var(--muted-foreground))',
                boxShadow: filter === tab ? 'var(--shadow-xs)' : 'none',
                border: filter === tab ? '1px solid hsl(var(--border))' : '1px solid transparent',
              }}
            >
              {tab}
            </button>
          ))}
        </div>

        <motion.div
          className="space-y-3"
          variants={staggerContainer}
          initial="initial"
          animate="animate"
          key={filter}
        >
          {filtered.map(proposal => (
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
              className="nave-card p-10 text-center"
              style={{ color: 'hsl(var(--muted-foreground))', fontSize: '13.5px' }}
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
