import { useMemo } from 'react';
import { useActivityLog } from './useActivityLog';
import { useProposals } from './useProposals';
import { useTreasuryBalance } from './useTreasuryBalance';
import { useDaoRegistry } from './useDaoRegistry';
import { ProposalStatus } from '../lib/onChainTypes';

export type NotificationKind = 'vote' | 'proposal' | 'deposit' | 'activity';

export interface NotificationItem {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  time: string;
  timestamp: number;
  href?: string;
  unread: boolean;
}

const SEEN_KEY = 'nave_notifications_seen';

function loadSeenIds(daoAddress: string | null): Set<string> {
  if (!daoAddress) return new Set();
  try {
    const raw = localStorage.getItem(`${SEEN_KEY}::${daoAddress}`);
    if (!raw) return new Set();
    return new Set(JSON.parse(raw) as string[]);
  } catch {
    return new Set();
  }
}

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function mapProposalStatus(status: ProposalStatus): string | null {
  switch (status) {
    case ProposalStatus.Passed:
      return 'passed';
    case ProposalStatus.Failed:
      return 'rejected';
    case ProposalStatus.Executed:
      return 'executed';
    case ProposalStatus.Cancelled:
      return 'cancelled';
    default:
      return null;
  }
}

export function markNotificationsSeen(daoAddress: string | null, ids: string[]): void {
  if (!daoAddress || ids.length === 0) return;
  const existing = loadSeenIds(daoAddress);
  ids.forEach((id) => existing.add(id));
  try {
    localStorage.setItem(`${SEEN_KEY}::${daoAddress}`, JSON.stringify([...existing]));
  } catch {
    /* ignore */
  }
}

export function useNotifications(daoAddress: string | null) {
  const { dao } = useDaoRegistry(daoAddress);
  const proposalCount = dao?.proposalCount ?? 0;
  const { activities, loading: activityLoading } = useActivityLog(daoAddress);
  const { proposals, activeProposals, loading: proposalsLoading } = useProposals(daoAddress, proposalCount);
  const treasuryBalance = useTreasuryBalance(daoAddress);

  const notifications = useMemo(() => {
    if (!daoAddress) return [];

    const seen = loadSeenIds(daoAddress);
    const items: NotificationItem[] = [];
    const now = Date.now();

    for (const p of activeProposals) {
      items.push({
        id: `vote-${p.index}`,
        kind: 'vote',
        title: `Vote open: ${p.title}`,
        body: `Proposal #${p.index} is awaiting your vote.`,
        time: formatRelativeTime(p.createdAt * 1000 || now),
        timestamp: p.createdAt * 1000 || now,
        href: '/governance',
        unread: !seen.has(`vote-${p.index}`),
      });
    }

    for (const p of proposals) {
      const status = mapProposalStatus(p.status);
      if (!status) continue;
      const ts = (p.executedAt || p.votingEnd || p.createdAt) * 1000 || now;
      const label =
        status === 'passed'
          ? 'Proposal passed'
          : status === 'rejected'
            ? 'Proposal rejected'
            : status === 'cancelled'
              ? 'Proposal cancelled'
              : 'Proposal executed';
      items.push({
        id: `proposal-${p.index}-${status}`,
        kind: 'proposal',
        title: `${label}: ${p.title}`,
        body: `Proposal #${p.index} is now ${status}.`,
        time: formatRelativeTime(ts),
        timestamp: ts,
        href: '/governance',
        unread: !seen.has(`proposal-${p.index}-${status}`),
      });
    }

    if (treasuryBalance.resolved && treasuryBalance.hasBalance && !seen.has(`deposit-${daoAddress}`)) {
      items.push({
        id: `deposit-${daoAddress}`,
        kind: 'deposit',
        title: 'Treasury funded',
        body: 'Funds were detected in your treasury vault.',
        time: 'Just now',
        timestamp: now,
        href: '/dashboard',
        unread: true,
      });
    }

    for (const a of activities.slice(0, 8)) {
      const ts = a.blockTime
        ? new Date(a.blockTime).getTime()
        : new Date(a.createdAt).getTime();
      items.push({
        id: `activity-${a.id}`,
        kind: 'activity',
        title: a.agentRole ? `${a.agentRole} activity` : 'Treasury activity',
        body: a.description,
        time: formatRelativeTime(ts),
        timestamp: ts,
        href: '/agent',
        unread: !seen.has(`activity-${a.id}`),
      });
    }

    items.sort((a, b) => b.timestamp - a.timestamp);
    return items.slice(0, 20);
  }, [
    daoAddress,
    activeProposals,
    proposals,
    activities,
    treasuryBalance.resolved,
    treasuryBalance.hasBalance,
  ]);

  const unreadCount = notifications.filter((n) => n.unread).length;
  const loading = activityLoading || proposalsLoading;

  return {
    notifications,
    unreadCount,
    loading,
    markAllSeen: () => markNotificationsSeen(daoAddress, notifications.map((n) => n.id)),
  };
}
