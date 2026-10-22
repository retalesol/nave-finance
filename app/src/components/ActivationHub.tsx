import { useNavigate } from 'react-router-dom';
import { Notice } from './calm';
import { useDaoContext } from '../hooks/useDaoContext';
import { useDaoRegistry } from '../hooks/useDaoRegistry';
import { useTreasuryBalance } from '../hooks/useTreasuryBalance';
import { useProposals } from '../hooks/useProposals';
import { isMockDaoAddress } from '../lib/mockData';

export interface ActivationHubProps {
  onOpenDeposit?: () => void;
  onSignerComplete?: () => void;
}

/** Single prioritized notice strip — active decision awaiting a vote, or empty treasury prompt. */
export default function ActivationHub({ onOpenDeposit }: ActivationHubProps) {
  const navigate = useNavigate();
  const { daoAddress } = useDaoContext();
  const { dao } = useDaoRegistry(daoAddress);
  const treasuryBalance = useTreasuryBalance(daoAddress);
  const isMock = isMockDaoAddress(daoAddress);

  const proposalCount =
    typeof dao?.nextProposalIndex === 'number'
      ? dao.nextProposalIndex
      : (dao?.proposalCount ?? 0) + (dao?.archivedProposalCount ?? 0);

  const { activeProposals } = useProposals(daoAddress, proposalCount);

  if (!daoAddress) return null;

  const isEmptyTreasury = !isMock && treasuryBalance.resolved && !treasuryBalance.hasBalance;

  if (activeProposals.length > 0) {
    const first = activeProposals[0];
    const countLabel =
      activeProposals.length === 1
        ? '1 decision awaiting your vote'
        : `${activeProposals.length} decisions awaiting your vote`;

    return (
      <div data-onboarding-id="activation-checklist">
        <Notice
          tone="brass"
          actionLabel="Vote →"
          onAction={() => navigate('/decisions')}
        >
          <strong style={{ fontWeight: 600 }}>{countLabel}</strong>{' '}
          <span style={{ color: 'hsl(var(--muted-foreground))' }}>
            — {first.title}
          </span>
        </Notice>
      </div>
    );
  }

  if (isEmptyTreasury) {
    return (
      <div data-onboarding-id="activation-checklist">
        <Notice
          tone="brass"
          actionLabel="Add your first funds →"
          onAction={onOpenDeposit}
        >
          <strong style={{ fontWeight: 600 }}>Ready for your first deposit</strong>{' '}
          <span style={{ color: 'hsl(var(--muted-foreground))' }}>
            — Deposit so your agents have something to work with.
          </span>
        </Notice>
      </div>
    );
  }

  return null;
}
