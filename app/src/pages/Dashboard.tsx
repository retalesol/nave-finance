import { useState, useMemo, useEffect, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { motion } from 'framer-motion';
import Fi from '../components/Fi';
import MetricCard from '../components/MetricCard';
import { PageSkeleton } from '../components/NaveSkeletons';
import NaveEmptyState from '../components/NaveEmptyState';
import ActivationHub from '../components/ActivationHub';
import { staggerContainer } from '../components/PageTransition';
import { Notice, UnderlineTabs } from '../components/calm';
import { useDaoContext } from '../hooks/useDaoContext';
import { useTreasuryData, type AssetInfo } from '../hooks/useTreasuryData';
import { blendedApy } from '../lib/positionYield';
import { useTreasuryAssets } from '../hooks/useTreasuryAssets';
import { useTreasuryNfts } from '../hooks/useTreasuryNfts';
import { useAgentStatus } from '../hooks/useAgentStatus';
import { useTreasuryBalance } from '../hooks/useTreasuryBalance';
import { useActivityLog } from '../hooks/useActivityLog';
import { useMonthlyReports } from '../hooks/useMonthlyReports';
import { useDaoRegistry } from '../hooks/useDaoRegistry';
import { useTokenRegistry } from '../hooks/useTokenRegistry';
import { SOLANA_NETWORK } from '../lib/programConfig';
import { formatProjectedUsd, projectedYieldFromApy } from '../lib/projectedYield';
import { daoNetworkLabel, isEvmAddress } from '../lib/chain/types';
import { isMockDaoAddress } from '../lib/mockData';
import {
  DepositFundsModal,
  CreateTransactionModal,
} from '../components/TreasuryActions';
import { DepositAddressPanel } from '../components/DepositFlow';
import { useCharterCheck } from '../hooks/useCharterCheck';
import { isActionHash } from '../../supabase/functions/_shared/genlayerCharter.ts';
import CharterCheckStatus from '../components/governance/CharterCheckStatus';
import { TreasuryTooltip, YieldTooltip } from '../components/dashboard/ChartTooltips';
import ReportsDrawer, { ReportModal } from '../components/dashboard/ReportsDrawer';
import ActivityFeed from '../components/dashboard/ActivityFeed';
import AssetTable from '../components/dashboard/AssetTable';
import AllocationDonut from '../components/dashboard/AllocationDonut';
import AgentStatusPanel from '../components/dashboard/AgentStatusPanel';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
  CartesianGrid,
  BarChart,
  Bar,
} from 'recharts';

export { ReportsDrawer, ReportModal, ActivityFeed, AssetTable, AllocationDonut, AgentStatusPanel };

type OverviewTab = 'activity' | 'assets' | 'agents' | 'yield';

const OVERVIEW_TABS: readonly { id: OverviewTab; label: string }[] = [
  { id: 'activity', label: 'Recent activity' },
  { id: 'assets', label: 'Assets' },
  { id: 'agents', label: 'Agents' },
  { id: 'yield', label: 'Yield & strategies' },
];

/* ── Page ───────────────────────────────────────────────── */
export default function Dashboard() {
  const navigate = useNavigate();
  const location = useLocation();
  const activationRef = useRef<HTMLDivElement>(null);
  const { daoAddress } = useDaoContext();
  const [reportsOpen, setReportsOpen] = useState(false);
  const [depositFundsOpen, setDepositFundsOpen] = useState(false);
  const [createTxOpen, setCreateTxOpen] = useState(false);
  const [initialNftMint, setInitialNftMint] = useState<string | null>(null);
  const [overviewTab, setOverviewTab] = useState<OverviewTab>('activity');
  const isMock = isMockDaoAddress(daoAddress);

  useEffect(() => {
    const state = location.state as {
      openCreateTx?: boolean;
      openDeposit?: boolean;
      openReports?: boolean;
      nftTransfer?: { mint: string };
      startOnboarding?: boolean;
      treasuryAddress?: string;
    } | null;
    if (state?.openDeposit) {
      setDepositFundsOpen(true);
      navigate(location.pathname, { replace: true, state: {} });
    }
    if (state?.openReports) {
      setReportsOpen(true);
      navigate(location.pathname, { replace: true, state: {} });
    }
    if (state?.openCreateTx) {
      setCreateTxOpen(true);
      setInitialNftMint(state.nftTransfer?.mint ?? null);
      navigate(location.pathname, { replace: true, state: {} });
    }
    if (state?.startOnboarding) {
      window.requestAnimationFrame(() => {
        activationRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      navigate(location.pathname, {
        replace: true,
        state: state.treasuryAddress ? { treasuryAddress: state.treasuryAddress } : {},
      });
    }
  }, [location, navigate]);

  // ─── Live data hooks (return empty/default when daoAddress is null) ────
  const treasury = useTreasuryData(daoAddress);
  const treasuryAssets = useTreasuryAssets(daoAddress);
  const treasuryNfts = useTreasuryNfts(daoAddress);
  const agentStatus = useAgentStatus(daoAddress);
  const activityLog = useActivityLog(daoAddress);
  const monthlyReports = useMonthlyReports(daoAddress);
  const daoRegistry = useDaoRegistry(daoAddress);
  const tokenRegistry = useTokenRegistry(daoAddress);
  const daoChainId = daoRegistry.dao?.chainId ?? null;
  const charterActionHash = agentStatus.actionLogs.find((log) => isActionHash(log.payloadHash))?.payloadHash;
  const charter = useCharterCheck(daoAddress, daoChainId, charterActionHash);
  // Label from dao_registry.chain_id so a Base or Robinhood treasury is not
  // called "Solana Devnet" when the connected wallet is on another chain.
  const networkLabel = daoChainId != null
    ? daoNetworkLabel(daoChainId, SOLANA_NETWORK)
    : isEvmAddress(daoAddress)
      ? 'EVM'
      : daoNetworkLabel(null, SOLANA_NETWORK);
  /** Registered governance token mint (token-governed treasuries only). */
  const votingMint = tokenRegistry.tokens[0]?.mint ?? null;

  const treasuryBalance = useTreasuryBalance(daoAddress);
  const liveStrategies = useMemo(() => {
    if (treasury.strategies.length > 0) {
      return treasury.strategies.map((s) => ({
        protocol: s.protocol,
        label: s.name,
        asset: s.protocol,
        allocated: s.currentValueUsd,
        earned: s.earnedUsd,
        apy: s.apy,
      }));
    }
    return [];
  }, [treasury.strategies]);

  // Agent efficiency — live; '—' when there is nothing to measure yet.
  const agentEfficiency = useMemo(() => {
    if (agentStatus.agents.length > 0) {
      const activeCount = agentStatus.agents.filter((a) => a.active).length;
      return `${((activeCount / agentStatus.agents.length) * 100).toFixed(1)}%`;
    }
    return '—';
  }, [agentStatus.agents]);

  const recentActivityCount = activityLog.activities.length;

  const latestMonthYield = useMemo(() => {
    if (monthlyReports.allMonths.length > 0) {
      return monthlyReports.allMonths[0].yieldEarned;
    }
    return 0;
  }, [monthlyReports.allMonths]);

  // Real month-over-month yield trend from live monthly reports. `undefined`
  // (no badge) until there are at least two months with a non-zero prior month
  // — never a hardcoded figure.
  const yieldTrend = useMemo(() => {
    const m = monthlyReports.allMonths;
    if (m.length >= 2 && m[1].yieldEarned > 0) {
      const pct = ((m[0].yieldEarned - m[1].yieldEarned) / m[1].yieldEarned) * 100;
      return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
    }
    return undefined;
  }, [monthlyReports.allMonths]);

  // 7-day treasury trend from live history; blank for a fresh DAO.
  const treasuryTrend = useMemo(() => {
    const h = treasury.history;
    if (h.length >= 2) {
      const latest = h[h.length - 1].totalValueUsd;
      const weekAgo = h.length >= 7 ? h[h.length - 7].totalValueUsd : h[0].totalValueUsd;
      if (weekAgo > 0) {
        const pct = ((latest - weekAgo) / weekAgo) * 100;
        return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
      }
    }
    return undefined;
  }, [treasury.history]);

  // 90-day treasury value chart from live snapshots.
  const treasuryChartData = useMemo(() => {
    if (treasury.history.length > 0) {
      return treasury.history.map((s) => ({
        date: new Date(s.snapshotAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        value: s.totalValueUsd,
      }));
    }
    return [];
  }, [treasury.history]);

  const chartMonthlyYield = useMemo(() => {
    if (monthlyReports.allMonths.length > 0) {
      return monthlyReports.allMonths
        .slice(0, 6)
        .reverse()
        .map((m) => ({ month: m.month, value: m.yieldEarned }));
    }
    return [];
  }, [monthlyReports.allMonths]);

  const chartYieldByAsset = useMemo(() => {
    if (treasury.strategies.length > 0) {
      const byAsset: Record<string, number> = {};
      treasury.strategies.forEach((s) => {
        const key = s.protocol;
        byAsset[key] = (byAsset[key] || 0) + s.earnedUsd;
      });
      const colors = ['hsl(var(--brass))', 'hsl(var(--foreground))', '#8FAE94'];
      return Object.entries(byAsset).map(([asset, earned], i) => ({
        asset,
        earned: Math.round(earned),
        color: colors[i % colors.length],
      }));
    }
    return [];
  }, [treasury.strategies]);

  const totalYield    = liveStrategies.reduce((s, r) => s + r.earned, 0);
  const totalDeployed = liveStrategies.reduce((s, r) => s + r.allocated, 0);
  const blendedRate   = blendedApy(liveStrategies.map((r) => ({ value: r.allocated, apy: r.apy })));
  const blendedAPY    = blendedRate != null ? blendedRate.toFixed(2) : null;
  const yieldOutlook  = blendedRate != null ? projectedYieldFromApy(totalDeployed, blendedRate) : null;

  // ─── Multi-asset treasury (preferred over legacy SOL/USDC snapshots) ────
  const hasOnchainAssets = !isMock && treasuryAssets.assets.length > 0;

  const displayAssets: AssetInfo[] = useMemo(() => {
    if (!hasOnchainAssets) return treasury.assets;
    return treasuryAssets.assets.map((a) => ({
      name: a.name,
      symbol: a.symbol,
      balance: a.uiBalance,
      valueUsd: a.valueUsd,
      allocation: a.allocationPct,
    }));
  }, [hasOnchainAssets, treasuryAssets.assets, treasury.assets]);

  const displayAssetsValue = useMemo(
    () => displayAssets.reduce((sum, asset) => sum + asset.valueUsd, 0),
    [displayAssets],
  );

  const displayCurrentValue =
    displayAssetsValue > 0
      ? displayAssetsValue
      : treasuryAssets.onchainNavUsd != null
        ? treasuryAssets.onchainNavUsd
        : treasury.currentValue;

  const displayAllocation = useMemo(() => {
    if (!hasOnchainAssets) return treasury.allocation;
    const palette = ['hsl(var(--brass))', 'hsl(var(--foreground))', '#8FAE94', '#D6CFBE', '#9A7414', '#6B7280'];
    return treasuryAssets.assets
      .filter((a) => a.allocationPct > 0)
      .map((a, i) => ({ name: a.symbol, value: a.allocationPct, color: palette[i % palette.length] }));
  }, [hasOnchainAssets, treasuryAssets.assets, treasury.allocation]);

  const isEmptyTreasury =
    !isMock &&
    treasuryBalance.resolved &&
    !treasuryBalance.hasBalance;

  // ─── Loading skeleton ─────────────────────────────────────────────
  const isLoading = treasury.loading || daoRegistry.loading || agentStatus.loading;
  if (isLoading && treasury.history.length === 0 && agentStatus.agents.length === 0) {
    return <PageSkeleton variant="dashboard" />;
  }

  // ─── Empty state (no DAO selected) ───────────────────────────────
  if (!daoAddress) {
    return (
      <div className="p-6 animate-fade-in">
        <NaveEmptyState
          icon="landmark"
          title="No Treasury Selected"
          description="Select or create a treasury to view your dashboard. You can create a new DAO from the lobby or join an existing one with a treasury address."
          action={{ label: 'Go to Lobby', icon: 'arrow-right', onClick: () => navigate('/treasuries') }}
        />
      </div>
    );
  }

  const isFrozen = Boolean(daoRegistry.dao?.frozen);
  const agentsPaused = !isFrozen && agentStatus.onChainData !== null && !agentStatus.agentsEnabled;

  return (
    <div className="animate-fade-in" data-onboarding-id="dashboard-root">
      {/* Header — matches #view-overview in demo.html */}
      <div
        className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 flex-wrap"
        data-onboarding-id="dashboard-header"
      >
        <div>
          <div className="nave-label" style={{ marginBottom: '10px' }}>
            {daoRegistry.dao?.name ?? 'Treasury'} · {networkLabel}
          </div>
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
            {isFrozen ? (
              <>
                Treasury is{' '}
                <em style={{ fontStyle: 'italic', color: 'hsl(var(--muted-foreground))' }}>frozen.</em>
              </>
            ) : isEmptyTreasury ? (
              <>
                Ready for your{' '}
                <em style={{ fontStyle: 'italic', color: 'hsl(var(--muted-foreground))' }}>first deposit.</em>
              </>
            ) : agentsPaused ? (
              <>
                Agents are{' '}
                <em style={{ fontStyle: 'italic', color: 'hsl(var(--muted-foreground))' }}>paused.</em>
              </>
            ) : (
              <>
                Everything is{' '}
                <em style={{ fontStyle: 'italic', color: 'hsl(var(--muted-foreground))' }}>in order.</em>
              </>
            )}
          </h1>
          <p
            style={{
              fontSize: '14.5px',
              color: 'hsl(var(--muted-foreground))',
              margin: 0,
              maxWidth: '520px',
              lineHeight: 1.55,
            }}
          >
            {isFrozen
              ? 'All agent operations, strategy executions, and withdrawals are halted. Contact a guardian to unfreeze.'
              : isEmptyTreasury
                ? 'Send tokens or deposit from your wallet to activate balance tracking, yield strategies, and agent guardrails.'
                : agentsPaused
                  ? 'Autonomous agent execution is paused. Balances remain safe and governance stays active.'
                  : latestMonthYield > 0
                    ? `Your agents earned $${latestMonthYield.toLocaleString()} this month and followed every rule.${recentActivityCount > 0 ? ` ${recentActivityCount} recent actions logged.` : ''}`
                    : `Treasury within constitutional bounds. ${recentActivityCount > 0 ? `${recentActivityCount} recent actions logged.` : 'Your agents are watching inside your rules.'}`}
          </p>
          {charter.status && (
            <div className="mt-3">
              <CharterCheckStatus
                status={charter.status}
                summary={charter.summary}
                txId={charter.txId}
                asking={charter.asking}
                askError={charter.askError}
                onAskAnother={charter.canAsk ? (evidence) => { void charter.askAnother(evidence); } : undefined}
              />
            </div>
          )}
        </div>

        <div className="flex items-center gap-1.5 flex-wrap pt-1">
          <button
            type="button"
            onClick={() => setDepositFundsOpen(true)}
            data-onboarding-id="dashboard-deposit-button"
            className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-[9px] font-semibold transition-colors"
            style={{
              fontSize: '13px',
              backgroundColor: 'hsl(var(--foreground))',
              color: '#ffffff',
              border: '1px solid hsl(var(--foreground))',
            }}
          >
            Add funds
          </button>
          <button
            type="button"
            onClick={() => setCreateTxOpen(true)}
            data-onboarding-id="dashboard-create-transaction-button"
            style={{
              fontSize: '13px',
              fontWeight: 600,
              borderRadius: '9px',
              padding: '8px 14px',
              border: '1px solid hsl(var(--border))',
              backgroundColor: '#ffffff',
              color: 'hsl(var(--foreground))',
              display: isEmptyTreasury ? 'none' : 'inline-flex',
              alignItems: 'center',
              gap: '7px',
            }}
          >
            <span className="hidden sm:inline">Propose transfer</span>
            <span className="sm:hidden">Propose</span>
          </button>
          <button
            type="button"
            onClick={() => setReportsOpen(true)}
            data-onboarding-id="dashboard-reports-button"
            style={{
              fontSize: '13px',
              fontWeight: 600,
              borderRadius: '9px',
              padding: '8px 14px',
              border: '1px solid hsl(var(--border))',
              backgroundColor: '#ffffff',
              color: 'hsl(var(--foreground))',
              display: isEmptyTreasury ? 'none' : 'inline-flex',
              alignItems: 'center',
              gap: '7px',
            }}
          >
            Reports
          </button>
        </div>
      </div>

      {/* Notices & ActivationHub */}
      <div style={{ marginTop: '26px' }} className="space-y-0">
        <div ref={activationRef}>
          <ActivationHub
            onOpenDeposit={() => setDepositFundsOpen(true)}
            onSignerComplete={() => daoRegistry.refetch()}
          />
        </div>

        {(treasury.error || agentStatus.error) && (
          <Notice tone="red">
            <strong style={{ fontWeight: 600 }}>Some dashboard data failed to load</strong>{' '}
            <span style={{ color: 'hsl(var(--muted-foreground))' }}>
              — {treasury.error ? `Treasury: ${treasury.error}. ` : ''}
              {agentStatus.error ? `Agents: ${agentStatus.error}.` : ''}
            </span>
          </Notice>
        )}

        {isFrozen && (
          <Notice
            tone="red"
            actionLabel="Manage in Settings →"
            onAction={() => navigate('/settings')}
          >
            <strong style={{ fontWeight: 600 }}>Treasury is emergency frozen</strong>{' '}
            <span style={{ color: 'hsl(var(--muted-foreground))' }}>
              — No money can move. Monitoring continues.
            </span>
          </Notice>
        )}

        <div
          data-onboarding-id="dashboard-health-banner"
          style={{ display: !isFrozen && !isEmptyTreasury ? 'block' : 'none' }}
        >
          <Notice
            tone="brass"
            actionLabel="View activity →"
            onAction={() => setOverviewTab('activity')}
          >
            <strong style={{ fontWeight: 600 }}>Treasury within constitutional bounds</strong>{' '}
            <span style={{ color: 'hsl(var(--muted-foreground))' }}>
              — {recentActivityCount > 0 ? `${recentActivityCount} recent actions logged` : 'No activity recorded yet'}
            </span>
          </Notice>
        </div>
      </div>

      {isEmptyTreasury && daoAddress && (
        <div style={{ marginTop: '28px' }}>
          <DepositAddressPanel
            daoAddress={daoAddress}
            daoName={daoRegistry.dao?.name}
            vaultMint={votingMint}
          />
        </div>
      )}

      {/* Balance Hero + Chart + Stats */}
      <div style={{ display: isEmptyTreasury ? 'none' : 'block' }}>
        <div style={{ padding: '38px 0 8px' }}>
          <div className="nave-label">Total balance</div>
          <div
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: '56px',
              lineHeight: 1,
              letterSpacing: '-0.03em',
              margin: '10px 0 10px',
              color: 'hsl(var(--foreground))',
            }}
          >
            ${displayCurrentValue.toLocaleString()}
          </div>
          <div style={{ fontSize: '13.5px', color: 'hsl(var(--muted-foreground))' }}>
            {totalYield > 0 ? (
              <>
                <b style={{ color: 'hsl(var(--success))', fontWeight: 600 }}>
                  +${totalYield.toLocaleString()} earned
                </b>{' '}
                across strategies
              </>
            ) : treasuryTrend ? (
              <>
                <b style={{ color: 'hsl(var(--success))', fontWeight: 600 }}>{treasuryTrend}</b> over the last 7 days
              </>
            ) : (
              <span>{displayAssetsValue > 0 ? 'Live holdings' : 'No history yet'}</span>
            )}
            {' · '}
            <span>
              {totalDeployed > 0
                ? `$${totalDeployed.toLocaleString()} earning`
                : 'Ready to deploy inside constitutional caps'}
            </span>
          </div>
        </div>

        {/* Balance chart + borderless Stats */}
        <section
          style={{
            padding: '30px 0',
            borderTop: '1px solid hsl(var(--surface-2))',
            marginTop: '22px',
          }}
        >
          <div data-onboarding-id="dashboard-value-chart">
            <div
              className="flex items-center justify-between gap-3 flex-wrap"
              style={{ marginBottom: '18px' }}
            >
              <h2
                style={{
                  fontFamily: 'var(--font-body)',
                  fontSize: '14px',
                  fontWeight: 600,
                  margin: 0,
                  color: 'hsl(var(--foreground))',
                }}
              >
                Balance{' '}
                <span style={{ fontSize: '12.5px', color: 'hsl(var(--faint))', fontWeight: 400 }}>
                  — last 90 days
                </span>
              </h2>
              {treasuryTrend && (
                <div className="flex items-center gap-1.5">
                  <span
                    className="flex items-center gap-1"
                    style={{ fontSize: '12.5px', fontWeight: 600, color: 'hsl(var(--success))' }}
                  >
                    {treasuryTrend}
                  </span>
                  <span
                    style={{
                      fontSize: '11.5px',
                      color: 'hsl(var(--faint))',
                      fontFamily: 'var(--font-mono)',
                    }}
                  >
                    7D
                  </span>
                </div>
              )}
            </div>

            {treasuryChartData.length === 0 ? (
              <div
                style={{
                  padding: '28px 0',
                  fontSize: '13px',
                  color: 'hsl(var(--muted-foreground))',
                }}
              >
                No treasury history yet. A chart appears once the treasury holds assets and snapshots are recorded.
              </div>
            ) : (
              <div>
                <ResponsiveContainer width="100%" height={175}>
                  <AreaChart data={treasuryChartData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="tvGrad90" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#111827" stopOpacity={0.06} />
                        <stop offset="100%" stopColor="#111827" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#EFEAE0" vertical={false} />
                    <XAxis
                      dataKey="date"
                      tick={{ fontSize: 10, fill: '#9CA3AF', fontFamily: 'var(--font-mono)' }}
                      axisLine={false}
                      tickLine={false}
                      interval={1}
                    />
                    <YAxis
                      tick={{ fontSize: 10, fill: '#9CA3AF', fontFamily: 'var(--font-mono)' }}
                      axisLine={false}
                      tickLine={false}
                      tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`}
                      width={44}
                    />
                    <Tooltip content={<TreasuryTooltip />} />
                    <Area
                      type="monotone"
                      dataKey="value"
                      stroke="#111827"
                      strokeWidth={2}
                      fill="url(#tvGrad90)"
                      dot={false}
                      activeDot={{ r: 3.5, fill: '#B9974F', strokeWidth: 0 }}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>

          {/* Borderless Stat row */}
          <motion.div
            className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5"
            style={{ marginTop: '22px' }}
            data-onboarding-id="dashboard-metrics"
            variants={staggerContainer}
            initial="initial"
            animate="animate"
          >
            <MetricCard
              label="Total Treasury Value"
              value={`$${displayCurrentValue.toLocaleString()}`}
              trend={treasuryTrend}
              sub={treasuryTrend ? '7-day' : displayAssetsValue > 0 ? 'Live holdings' : 'No history yet'}
              up={!!treasuryTrend}
            />
            <MetricCard
              label="Total Yield Earned"
              value={`$${totalYield.toLocaleString()}`}
              trend={yieldTrend}
              sub={latestMonthYield > 0 ? `$${latestMonthYield.toLocaleString()} this month` : 'Across all strategies'}
              up={!!yieldTrend && !yieldTrend.startsWith('-')}
            />
            <MetricCard
              label="Blended APY"
              value={blendedAPY != null ? `${blendedAPY}%` : '—'}
              sub={blendedAPY != null ? 'Hover for projected yield' : 'Needs a day of position marks'}
              tooltip={
                yieldOutlook ? (
                  <div className="space-y-1.5">
                    <div className="nave-label" style={{ fontSize: '10px' }}>
                      Projected yield
                    </div>
                    {([
                      ['Daily', yieldOutlook.daily],
                      ['Weekly', yieldOutlook.weekly],
                      ['Annual', yieldOutlook.annual],
                    ] as const).map(([label, amount]) => (
                      <div key={label} className="flex items-center justify-between gap-6">
                        <span style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))' }}>
                          {label}
                        </span>
                        <span
                          className="nave-mono"
                          style={{
                            fontSize: '12.5px',
                            fontWeight: 600,
                            color: 'hsl(var(--foreground))',
                          }}
                        >
                          {formatProjectedUsd(amount)}
                        </span>
                      </div>
                    ))}
                    <div
                      style={{
                        fontSize: '11px',
                        color: 'hsl(var(--muted-foreground))',
                        lineHeight: 1.4,
                      }}
                    >
                      From {blendedAPY}% on ${totalDeployed.toLocaleString()} deployed
                    </div>
                  </div>
                ) : undefined
              }
            />
            <MetricCard
              label="Agent Efficiency"
              value={agentEfficiency}
              sub="Policy compliance rate"
              up={agentEfficiency !== '—'}
            />
          </motion.div>
        </section>
      </div>

      {/* Tabbed bottom section — Recent activity | Assets | Agents | Yield & strategies */}
      <section
        style={{
          padding: '30px 0',
          borderTop: '1px solid hsl(var(--surface-2))',
          marginTop: '30px',
        }}
      >
        <UnderlineTabs
          tabs={OVERVIEW_TABS}
          activeTab={overviewTab}
          onChange={setOverviewTab}
        />

        {/* Tab 1: Recent activity */}
        <div
          style={{ display: overviewTab === 'activity' ? 'block' : 'none' }}
          data-onboarding-id="dashboard-activity"
        >
          <ActivityFeed
            activities={activityLog.activities}
            onViewAll={() => navigate('/settings')}
          />
        </div>

        {/* Tab 2: Assets + Allocation */}
        <div style={{ display: overviewTab === 'assets' ? 'block' : 'none' }}>
          <div data-onboarding-id="dashboard-allocation-group" style={{ marginBottom: '20px' }}>
            <AllocationDonut allocation={displayAllocation} />
          </div>
          <div data-onboarding-id="dashboard-assets">
            <AssetTable
              assets={displayAssets}
              onRefresh={() => {
                treasuryAssets.refetch();
                treasury.refetch();
              }}
              refreshing={treasuryAssets.loading}
            />
          </div>
          {hasOnchainAssets && displayAssets.some((asset) => asset.balance > 0 && asset.valueUsd === 0) && (
            <p
              style={{
                fontSize: '12px',
                color: 'hsl(var(--muted-foreground))',
                lineHeight: 1.55,
                marginTop: '10px',
              }}
            >
              Some balances do not have a market price yet. Refresh reads holdings directly and does not send a transaction.
            </p>
          )}
          <div style={{ paddingTop: '14px' }}>
            <button
              type="button"
              onClick={() => navigate('/money')}
              className="hover:underline underline-offset-4 bg-transparent border-0 cursor-pointer"
              style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))' }}
            >
              See all money & assets →
            </button>
          </div>
        </div>

        {/* Tab 3: Agents */}
        <div
          style={{ display: overviewTab === 'agents' ? 'block' : 'none' }}
          data-onboarding-id="dashboard-agent-activity"
        >
          <AgentStatusPanel
            navigate={navigate}
            daoAddress={daoAddress}
            agentStatus={agentStatus}
            frozen={daoRegistry.dao?.frozen ?? false}
          />
        </div>

        {/* Tab 4: Yield & strategies */}
        <div
          style={{ display: overviewTab === 'yield' ? 'block' : 'none' }}
          className="space-y-8"
        >
          <div
            className="grid grid-cols-1 md:grid-cols-2 gap-6"
            data-onboarding-id="dashboard-yield-allocation"
          >
            {/* Monthly yield bars */}
            <div data-onboarding-id="dashboard-monthly-yield" style={{ paddingTop: '8px' }}>
              <div style={{ marginBottom: '12px' }}>
                <span style={{ fontSize: '14px', fontWeight: 600, color: 'hsl(var(--foreground))' }}>
                  Monthly Yield
                </span>{' '}
                <span style={{ fontSize: '12.5px', color: 'hsl(var(--faint))' }}>
                  — USD earned per month
                </span>
              </div>
              {chartMonthlyYield.length === 0 ? (
                <p style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))' }}>
                  No yield recorded yet.
                </p>
              ) : (
                <ResponsiveContainer width="100%" height={160}>
                  <BarChart
                    data={chartMonthlyYield}
                    margin={{ top: 4, right: 4, left: 0, bottom: 0 }}
                    barCategoryGap="30%"
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#EFEAE0" vertical={false} />
                    <XAxis
                      dataKey="month"
                      tick={{ fontSize: 10, fill: '#9CA3AF', fontFamily: 'var(--font-mono)' }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <YAxis
                      tick={{ fontSize: 10, fill: '#9CA3AF', fontFamily: 'var(--font-mono)' }}
                      axisLine={false}
                      tickLine={false}
                      tickFormatter={(v) => `${v}`}
                      width={40}
                    />
                    <Tooltip content={<YieldTooltip />} />
                    <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                      {chartMonthlyYield.map((_, index) => (
                        <Cell
                          key={`cell-${index}`}
                          fill={index === chartMonthlyYield.length - 1 ? '#111827' : '#D6CFBE'}
                        />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>

            {/* Yield by asset */}
            <div data-onboarding-id="dashboard-yield-by-asset" style={{ paddingTop: '8px' }}>
              <div style={{ marginBottom: '12px' }}>
                <span style={{ fontSize: '14px', fontWeight: 600, color: 'hsl(var(--foreground))' }}>
                  Yield by Asset
                </span>{' '}
                <span style={{ fontSize: '12.5px', color: 'hsl(var(--faint))' }}>
                  — all-time earnings
                </span>
              </div>
              {chartYieldByAsset.length === 0 ? (
                <p style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))' }}>
                  No asset earnings recorded yet.
                </p>
              ) : (
                <div>
                  {chartYieldByAsset.map((a) => {
                    const pct = totalYield > 0 ? Math.round((a.earned / totalYield) * 100) : 0;
                    return (
                      <div
                        key={a.asset}
                        style={{
                          display: 'grid',
                          gridTemplateColumns: '100px 1fr 80px',
                          gap: '12px',
                          alignItems: 'center',
                          padding: '10px 0',
                          borderBottom: '1px solid hsl(var(--surface-2))',
                          fontSize: '13px',
                        }}
                      >
                        <span className="nave-mono truncate" style={{ color: 'hsl(var(--foreground))' }}>
                          {a.asset}
                        </span>
                        <span
                          style={{
                            height: '5px',
                            backgroundColor: 'hsl(var(--surface-2))',
                            borderRadius: '99px',
                            overflow: 'hidden',
                            display: 'block',
                          }}
                        >
                          <i
                            style={{
                              display: 'block',
                              height: '100%',
                              width: `${pct}%`,
                              backgroundColor: a.color,
                              borderRadius: '99px',
                            }}
                          />
                        </span>
                        <span
                          className="nave-mono"
                          style={{
                            textAlign: 'right',
                            fontSize: '12px',
                            color: 'hsl(var(--foreground))',
                            fontWeight: 500,
                          }}
                        >
                          ${a.earned.toLocaleString()}
                        </span>
                      </div>
                    );
                  })}
                  <div
                    className="flex items-center justify-between pt-3"
                    style={{ fontSize: '13px' }}
                  >
                    <span style={{ color: 'hsl(var(--muted-foreground))' }}>Total earned</span>
                    <span
                      className="nave-mono"
                      style={{ fontWeight: 600, color: 'hsl(var(--foreground))' }}
                    >
                      ${totalYield.toLocaleString()}
                    </span>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Strategy performance table */}
          <div
            data-onboarding-id="dashboard-strategies"
            style={{
              paddingTop: '20px',
              borderTop: '1px solid hsl(var(--surface-2))',
            }}
          >
            <div
              className="flex items-center justify-between gap-3 flex-wrap"
              style={{ marginBottom: '14px' }}
            >
              <span style={{ fontSize: '14px', fontWeight: 600, color: 'hsl(var(--foreground))' }}>
                Strategy Performance
              </span>
              <span
                className="nave-mono"
                style={{ fontSize: '12px', color: 'hsl(var(--faint))' }}
              >
                {liveStrategies.length} active {liveStrategies.length === 1 ? 'strategy' : 'strategies'}
              </span>
            </div>

            {liveStrategies.length === 0 ? (
              <p style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))' }}>
                No active strategies. Yield strategies appear here once the treasury deploys capital.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      {(['Protocol', 'Asset', 'Allocated', 'APY', 'Earned'] as const).map((h, i) => (
                        <th
                          key={h}
                          style={{
                            fontSize: '11px',
                            fontWeight: 500,
                            letterSpacing: '0.06em',
                            textTransform: 'uppercase',
                            color: 'hsl(var(--faint))',
                            textAlign: i >= 2 ? 'right' : 'left',
                            fontFamily: i >= 2 ? 'var(--font-mono)' : 'var(--font-body)',
                            padding: i === 4 ? '8px 0' : '8px 10px 8px 0',
                            borderBottom: '1px solid hsl(var(--border))',
                          }}
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {liveStrategies.map((s, idx) => {
                      const isLast = idx === liveStrategies.length - 1;
                      const cellBorder = isLast ? 'none' : '1px solid hsl(var(--surface-2))';
                      return (
                        <tr key={s.protocol}>
                          <td
                            style={{
                              fontSize: '13.5px',
                              fontWeight: 600,
                              padding: '12px 10px 12px 0',
                              borderBottom: cellBorder,
                              color: 'hsl(var(--foreground))',
                            }}
                          >
                            {s.protocol}
                          </td>
                          <td
                            className="nave-mono"
                            style={{
                              fontSize: '13px',
                              padding: '12px 10px 12px 0',
                              borderBottom: cellBorder,
                              color: 'hsl(var(--muted-foreground))',
                            }}
                          >
                            {s.asset}
                          </td>
                          <td
                            className="nave-mono"
                            style={{
                              fontSize: '12.5px',
                              textAlign: 'right',
                              padding: '12px 10px 12px 0',
                              borderBottom: cellBorder,
                              color: 'hsl(var(--foreground))',
                            }}
                          >
                            ${s.allocated.toLocaleString()}
                          </td>
                          <td
                            className="nave-mono"
                            style={{
                              fontSize: '12.5px',
                              textAlign: 'right',
                              padding: '12px 10px 12px 0',
                              borderBottom: cellBorder,
                              color: 'hsl(var(--success))',
                            }}
                          >
                            {s.apy != null ? `${s.apy.toFixed(2)}%/yr` : '—'}
                          </td>
                          <td
                            className="nave-mono"
                            style={{
                              fontSize: '12.5px',
                              fontWeight: 600,
                              textAlign: 'right',
                              padding: '12px 0',
                              borderBottom: cellBorder,
                              color: 'hsl(var(--foreground))',
                            }}
                          >
                            ${s.earned.toLocaleString()}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr style={{ borderTop: '1px solid hsl(var(--border))' }}>
                      <td
                        colSpan={4}
                        style={{
                          padding: '12px 10px 12px 0',
                          fontSize: '12.5px',
                          color: 'hsl(var(--muted-foreground))',
                        }}
                      >
                        Total earned
                      </td>
                      <td
                        className="nave-mono"
                        style={{
                          padding: '12px 0',
                          textAlign: 'right',
                          fontSize: '13.5px',
                          fontWeight: 600,
                          color: 'hsl(var(--foreground))',
                        }}
                      >
                        ${totalYield.toLocaleString()}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Reports Drawer */}
      <ReportsDrawer open={reportsOpen} onClose={() => setReportsOpen(false)} reports={monthlyReports.reports} />

      {/* Treasury actions */}
      {depositFundsOpen && daoAddress && (
        <DepositFundsModal
          daoAddress={daoAddress}
          daoName={daoRegistry.dao?.name}
          vaultMint={votingMint}
          registeredAssets={treasuryAssets.assets}
          initialTab="address"
          onClose={() => setDepositFundsOpen(false)}
          onDeposited={() => { treasury.refetch(); treasuryAssets.refetch(); }}
        />
      )}
      {createTxOpen && daoAddress && (
        <CreateTransactionModal
          daoAddress={daoAddress}
          proposalCount={
            typeof daoRegistry.dao?.nextProposalIndex === 'number'
              ? daoRegistry.dao.nextProposalIndex
              : (daoRegistry.dao?.proposalCount ?? 0) + (daoRegistry.dao?.archivedProposalCount ?? 0)
          }
          governanceType={daoRegistry.dao?.governanceType ?? 'wallet'}
          votingMint={votingMint}
          assets={treasuryAssets.assets}
          nfts={treasuryNfts.nfts}
          initialNftMint={initialNftMint}
          onClose={() => { setCreateTxOpen(false); setInitialNftMint(null); }}
        />
      )}
    </div>
  );
}
