import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Fi from './Fi';
import { useDaoContext } from '../hooks/useDaoContext';
import { useDaoRegistry } from '../hooks/useDaoRegistry';
import { useTreasuryBalance } from '../hooks/useTreasuryBalance';
import { useConstitution } from '../hooks/useConstitution';
import { useAgentStatus } from '../hooks/useAgentStatus';
import { isMockDaoAddress } from '../lib/mockData';

const DISMISS_KEY = 'nave_activation_checklist_dismissed';

interface Milestone {
  id: string;
  label: string;
  description: string;
  done: boolean;
  actionLabel?: string;
  onAction?: () => void;
}

interface ActivationChecklistProps {
  onOpenDeposit?: () => void;
}

/**
 * On-chain activation checklist replacing the 18-step tooltip tour.
 * Milestones: select treasury → fund → ratify constitution → enable agents.
 */
export default function ActivationChecklist({ onOpenDeposit }: ActivationChecklistProps) {
  const navigate = useNavigate();
  const { daoAddress } = useDaoContext();
  const { dao, loading: daoLoading } = useDaoRegistry(daoAddress);
  const treasuryBalance = useTreasuryBalance(daoAddress);
  const { constitution, loading: constitutionLoading } = useConstitution(daoAddress);
  const agentStatus = useAgentStatus(daoAddress);
  const isMock = isMockDaoAddress(daoAddress);

  const dismissKey = daoAddress ? `${DISMISS_KEY}_${daoAddress}` : DISMISS_KEY;
  const [dismissed, setDismissed] = useState(
    () => typeof localStorage !== 'undefined' && localStorage.getItem(dismissKey) === '1',
  );

  const proposalCount =
    (dao?.proposalCount ?? 0) + (dao?.archivedProposalCount ?? 0);

  const milestones: Milestone[] = useMemo(() => {
    const treasurySelected = !!daoAddress;
    const funded = treasuryBalance.resolved && treasuryBalance.hasBalance;
    const ratified =
      proposalCount > 0 ||
      (constitution !== null && (constitution.approvedProtocols.length > 0 || constitution.protocolCount > 0));
    const agentsOn = agentStatus.agentsEnabled;

    return [
      {
        id: 'select',
        label: 'Select treasury',
        description: treasurySelected
          ? (dao?.name ? `Active: ${dao.name}` : 'Treasury selected')
          : 'Choose a treasury from the lobby',
        done: treasurySelected,
        actionLabel: treasurySelected ? undefined : 'Open lobby',
        onAction: treasurySelected ? undefined : () => navigate('/treasuries'),
      },
      {
        id: 'fund',
        label: 'Fund treasury',
        description: funded
          ? 'Treasury holds assets on-chain'
          : 'Send assets to your treasury deposit address',
        done: funded,
        actionLabel: funded ? undefined : 'Add funds',
        onAction: funded ? undefined : onOpenDeposit,
      },
      {
        id: 'ratify',
        label: 'Ratify rules',
        description: ratified
          ? 'Treasury rules are on-chain'
          : 'Define rules and pass a governance vote',
        done: ratified,
        actionLabel: ratified ? undefined : 'Open rules',
        onAction: ratified ? undefined : () => navigate('/rules'),
      },
      {
        id: 'agents',
        label: 'Enable agents',
        description: agentsOn
          ? 'Autonomous agents are active'
          : 'Complete setup so agents can operate under your rules',
        done: agentsOn,
        actionLabel: agentsOn ? undefined : 'View agents',
        onAction: agentsOn ? undefined : () => navigate('/agents'),
      },
    ];
  }, [
    daoAddress,
    dao?.name,
    treasuryBalance.resolved,
    treasuryBalance.hasBalance,
    proposalCount,
    constitution,
    agentStatus.agentsEnabled,
    navigate,
    onOpenDeposit,
  ]);

  const completedCount = milestones.filter(m => m.done).length;
  const allDone = completedCount === milestones.length;
  const loading = daoLoading || treasuryBalance.loading || constitutionLoading || agentStatus.loading;

  if (!daoAddress || isMock || dismissed || allDone) return null;

  function dismiss() {
    if (typeof localStorage !== 'undefined') localStorage.setItem(dismissKey, '1');
    setDismissed(true);
  }

  const nextMilestone = milestones.find(m => !m.done);

  return (
    <div
      className="nave-card overflow-hidden"
      data-onboarding-id="activation-checklist"
      style={{ borderColor: 'hsl(var(--border))' }}
    >
      <div
        className="flex items-start justify-between gap-3 px-5 py-4 border-b"
        style={{ borderColor: 'hsl(var(--border))', backgroundColor: 'hsl(var(--surface-1))' }}
      >
        <div>
          <div className="text-display font-semibold" style={{ fontSize: '14px', color: 'hsl(var(--foreground))' }}>
            Activate your treasury
          </div>
          <p style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))', marginTop: '2px', lineHeight: 1.5 }}>
            {loading
              ? 'Checking on-chain status…'
              : nextMilestone
                ? `Next: ${nextMilestone.label.toLowerCase()}`
                : `${completedCount} of ${milestones.length} complete`}
          </p>
        </div>
        <button
          type="button"
          onClick={dismiss}
          className="p-1 rounded transition-colors flex-shrink-0"
          title="Dismiss checklist"
          style={{ color: 'hsl(var(--muted-foreground))' }}
          onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'hsl(var(--surface-2))')}
          onMouseLeave={e => (e.currentTarget.style.backgroundColor = '')}
        >
          <Fi icon="xmark" style={{ fontSize: '13px' }} />
        </button>
      </div>

      <div className="px-5 py-4 space-y-2">
        {milestones.map((m, idx) => (
          <div
            key={m.id}
            className="flex items-center gap-3 px-3 py-2.5 rounded-lg"
            style={{
              backgroundColor: m.done ? 'hsl(var(--surface-1))' : 'transparent',
              border: m.done ? '1px solid hsl(var(--border))' : '1px solid transparent',
            }}
          >
            <div
              className="w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0"
              style={{
                backgroundColor: m.done ? 'hsl(var(--success))' : 'hsl(var(--surface-2))',
                color: m.done ? 'white' : 'hsl(var(--muted-foreground))',
                fontSize: '11px',
                fontWeight: 600,
              }}
            >
              {m.done ? <Fi icon="check" style={{ fontSize: '10px' }} /> : idx + 1}
            </div>
            <div className="flex-1 min-w-0">
              <div style={{ fontSize: '13px', fontWeight: m.done ? 500 : 600, color: 'hsl(var(--foreground))' }}>
                {m.label}
              </div>
              <div style={{ fontSize: '11.5px', color: 'hsl(var(--muted-foreground))', marginTop: '1px' }}>
                {m.description}
              </div>
            </div>
            {!m.done && m.actionLabel && m.onAction && (
              <button
                type="button"
                onClick={m.onAction}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-md font-medium flex-shrink-0 transition-colors"
                style={{
                  fontSize: '11.5px',
                  backgroundColor: 'hsl(var(--primary))',
                  color: 'hsl(var(--primary-foreground))',
                }}
              >
                {m.actionLabel}
                <Fi icon="arrow-right" style={{ fontSize: '9px' }} />
              </button>
            )}
          </div>
        ))}
      </div>

      <div className="px-5 pb-4">
        <div className="h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: 'hsl(var(--border))' }}>
          <div
            className="h-full rounded-full transition-all"
            style={{
              width: `${(completedCount / milestones.length) * 100}%`,
              backgroundColor: 'hsl(var(--primary))',
            }}
          />
        </div>
      </div>
    </div>
  );
}
