import { useState, useMemo, useEffect, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { motion } from 'framer-motion';
import MetricCard from '../components/MetricCard';
import { PageSkeleton } from '../components/NaveSkeletons';
import NaveEmptyState from '../components/NaveEmptyState';
import ActivationHub from '../components/ActivationHub';
import { staggerContainer } from '../components/PageTransition';
import { Notice, UnderlineTabs } from '../components/calm';
import { useDaoContext } from '../hooks/useDaoContext';
import { useTreasuryData, type AssetInfo } from '../hooks/useTreasuryData';
import { useConstitution } from '../hooks/useConstitution';
import { blendedApy } from '../lib/positionYield';
import {
  axisWidth,
  buildBalanceSeries,
  formatAxisUsd,
  pickCategoryTicks,
  tickLabels,
  xTickCount,
  yDomain,
  type BalanceRange,
} from '../lib/balanceChart';
import { useIsMobile } from '../hooks/use-mobile';
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
  CartesianGrid,
} from 'recharts';

export {
  ReportsDrawer,
  ReportModal,
  ActivityFeed,
  AssetTable,
  AllocationDonut,
  AgentStatusPanel,
  YieldTooltip,
};

type OverviewTab = 'activity' | 'assets' | 'agents';
type ChartRange = BalanceRange;

const OVERVIEW_TABS: readonly { id: OverviewTab; label: string }[] = [
  { id: 'activity', label: 'Recent activity' },
  { id: 'assets', label: 'Assets' },
  { id: 'agents', label: 'Agents' },
];

const RANGE_META: Record<ChartRange, { hint: string }> = {
  '30D': { hint: '— last 30 days' },
  '90D': { hint: '— last 90 days' },
  '1Y': { hint: '— last 1 year' },
};

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
  const [chartRange, setChartRange] = useState<ChartRange>('90D');
  const isMobile = useIsMobile();
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
  const { constitution } = useConstitution(daoAddress);
  const agentStatus = useAgentStatus(daoAddress);
  const activityLog = useActivityLog(daoAddress);
  const monthlyReports = useMonthlyReports(daoAddress);
  const daoRegistry = useDaoRegistry(daoAddress);
  const tokenRegistry = useTokenRegistry(daoAddress);
  const daoChainId = daoRegistry.dao?.chainId ?? null;

  const networkLabel =
    daoChainId != null
      ? daoNetworkLabel(daoChainId, SOLANA_NETWORK)
      : isEvmAddress(daoAddress)
        ? 'EVM'
        : daoNetworkLabel(null, SOLANA_NETWORK);

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
    if (isMock) {
      return [
        { protocol: 'Kamino', label: 'Kamino', asset: 'USDC', allocated: 31_900, earned: 1_840, apy: 5.4 },
        { protocol: 'Jito', label: 'Jito', asset: 'SOL', allocated: 26_100, earned: 2_120, apy: 6.2 },
      ];
    }
    return [];
  }, [treasury.strategies, isMock]);

  const recentActivityCount = activityLog.activities.length;

  const latestMonthYield = useMemo(() => {
    if (monthlyReports.allMonths.length > 0) {
      return monthlyReports.allMonths[0].yieldEarned;
    }
    return 0;
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

  // Treasury value chart sliced by selected range (30D / 90D / 1Y).
  const treasuryChartData = useMemo(
    () => buildBalanceSeries(treasury.history, chartRange),
    [treasury.history, chartRange],
  );
  const chartScale = useMemo(() => {
    const domain = yDomain(treasuryChartData.map((point) => point.value));
    const scale = Math.max(Math.abs(domain[0]), Math.abs(domain[1]));
    const ticks = pickCategoryTicks(
      treasuryChartData,
      xTickCount(treasuryChartData.length, chartRange, isMobile),
    );
    return {
      domain,
      scale,
      ticks,
      labels: tickLabels(treasuryChartData, ticks),
      yWidth: axisWidth(domain),
    };
  }, [treasuryChartData, chartRange, isMobile]);

  const totalYield = liveStrategies.reduce((s, r) => s + r.earned, 0);
  const totalDeployed =
    liveStrategies.reduce((s, r) => s + r.allocated, 0) || (treasuryAssets.deployedUsd ?? 0);
  const blendedRate = blendedApy(liveStrategies.map((r) => ({ value: r.allocated, apy: r.apy })));
  const blendedAPY = blendedRate != null ? blendedRate.toFixed(1) : null;
  const yieldOutlook = blendedRate != null ? projectedYieldFromApy(totalDeployed, blendedRate) : null;

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

  const reserveFloorPct = useMemo(() => {
    const bps = constitution?.minStablecoinReserveBps ?? constitution?.minReservesBps ?? 3000;
    return Math.round(bps / 100);
  }, [constitution]);

  const reserveUsd = useMemo(() => {
    const liquid = Math.max(0, displayCurrentValue - totalDeployed);
    const target = Math.round(displayCurrentValue * (reserveFloorPct / 100));
    return Math.min(liquid, target > 0 ? target : liquid);
  }, [displayCurrentValue, totalDeployed, reserveFloorPct]);

  const reserveActualPct =
    displayCurrentValue > 0 ? Math.round((reserveUsd / displayCurrentValue) * 100) : reserveFloorPct;

  const availableUsd = Math.max(0, Math.round(displayCurrentValue - totalDeployed - reserveUsd));

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
        </div>

        <div className="flex items-center gap-1.5 flex-wrap pt-1">
          <button
            type="button"
            onClick={() => setReportsOpen(true)}
            data-onboarding-id="dashboard-reports-button"
            className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-[9px] border font-semibold transition-colors"
            style={{
              fontSize: '13px',
              backgroundColor: '#ffffff',
              borderColor: 'hsl(var(--border))',
              color: 'hsl(var(--foreground))',
            }}
          >
            Reports
          </button>
          <button
            type="button"
            onClick={() => setCreateTxOpen(true)}
            data-onboarding-id="dashboard-create-transaction-button"
            className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-[9px] font-semibold transition-colors"
            style={{
              fontSize: '13px',
              backgroundColor: 'hsl(var(--foreground))',
              color: '#ffffff',
              border: '1px solid hsl(var(--foreground))',
            }}
          >
            Propose a payment
          </button>
          <button
            type="button"
            onClick={() => setDepositFundsOpen(true)}
            data-onboarding-id="dashboard-deposit-button"
            className="sr-only"
          >
            Add funds
          </button>
        </div>
      </div>

      {/* Notices & ActivationHub */}
      <div style={{ marginTop: '26px' }} className="space-y-0" data-onboarding-id="dashboard-health-banner">
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
            {latestMonthYield > 0 ? (
              <>
                <b style={{ color: 'hsl(var(--success))', fontWeight: 600 }}>
                  +${latestMonthYield.toLocaleString()} earned
                </b>{' '}
                this month
              </>
            ) : totalYield > 0 ? (
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
            <span>Reserve healthy at {reserveActualPct}%</span>
          </div>
        </div>

        {/* Balance chart + 3 Plain-English Stats */}
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
                  {RANGE_META[chartRange].hint}
                </span>
              </h2>

              <div
                className="inline-flex items-center gap-0.5 rounded-[8px] border"
                style={{
                  padding: '2px',
                  backgroundColor: '#ffffff',
                  borderColor: 'hsl(var(--border))',
                }}
              >
                {(['30D', '90D', '1Y'] as const).map((r) => {
                  const active = chartRange === r;
                  return (
                    <button
                      key={r}
                      type="button"
                      onClick={() => setChartRange(r)}
                      className="transition-colors"
                      style={{
                        fontSize: '11.5px',
                        padding: '4px 9px',
                        borderRadius: '6px',
                        fontWeight: active ? 600 : 400,
                        backgroundColor: active ? 'hsl(var(--foreground))' : 'transparent',
                        color: active ? '#ffffff' : 'hsl(var(--faint))',
                        cursor: 'pointer',
                      }}
                    >
                      {r}
                    </button>
                  );
                })}
              </div>
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
                  <AreaChart data={treasuryChartData} margin={{ top: 8, right: 28, left: 0, bottom: 4 }}>
                    <defs>
                      <linearGradient id="tvGrad90" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#111827" stopOpacity={0.06} />
                        <stop offset="100%" stopColor="#111827" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#EFEAE0" vertical={false} />
                    <XAxis
                      dataKey="key"
                      ticks={chartScale.ticks}
                      tickFormatter={(key) => chartScale.labels.get(String(key)) ?? ''}
                      tick={{ fontSize: 10, fill: '#9CA3AF', fontFamily: 'var(--font-mono)' }}
                      axisLine={false}
                      tickLine={false}
                      interval={0}
                      minTickGap={28}
                      padding={{ left: 18, right: 18 }}
                    />
                    <YAxis
                      domain={chartScale.domain}
                      tickCount={4}
                      tick={{ fontSize: 10, fill: '#9CA3AF', fontFamily: 'var(--font-mono)' }}
                      axisLine={false}
                      tickLine={false}
                      tickFormatter={(value) => formatAxisUsd(Number(value), chartScale.scale)}
                      width={chartScale.yWidth}
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

          {/* 3 Plain-English Stats matching demo.html */}
          <motion.div
            className="grid grid-cols-1 sm:grid-cols-3 gap-5"
            style={{ marginTop: '22px' }}
            data-onboarding-id="dashboard-metrics"
            variants={staggerContainer}
            initial="initial"
            animate="animate"
          >
            <MetricCard
              label="Available"
              value={`$${availableUsd.toLocaleString()}`}
              sub="Free to spend without touching reserve."
            />
            <MetricCard
              label="Earning"
              value={`$${totalDeployed.toLocaleString()}${blendedAPY != null ? ` · ${blendedAPY}%/yr` : ''}`}
              sub={
                liveStrategies.length > 0
                  ? `In ${liveStrategies.length} approved ${liveStrategies.length === 1 ? 'place' : 'places'}${yieldOutlook ? `. ≈ $${Math.round(yieldOutlook.annual / 12).toLocaleString()} a month.` : '.'}`
                  : 'Across approved yield places.'
              }
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
              label="In reserve"
              value={`$${reserveUsd.toLocaleString()} · ${reserveActualPct}%`}
              sub={`Stable and untouched. Your floor is ${reserveFloorPct}%.`}
            />
          </motion.div>
        </section>
      </div>

      {/* Tabbed bottom section — Recent activity | Assets | Agents */}
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

        {/* Tab 2: Assets (clean horizontal barlines + link to /money) */}
        <div
          style={{ display: overviewTab === 'assets' ? 'block' : 'none' }}
          data-onboarding-id="dashboard-assets"
        >
          <div data-onboarding-id="dashboard-allocation-group">
            <AllocationDonut
              allocation={displayAllocation}
              onSelect={() => navigate('/money')}
            />
          </div>
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

        {/* Preserve onboarding anchor IDs in DOM without cluttering the UI */}
        <div className="sr-only" aria-hidden="true" data-onboarding-id="dashboard-yield-allocation">
          <div data-onboarding-id="dashboard-monthly-yield" />
          <div data-onboarding-id="dashboard-yield-by-asset" />
          <div data-onboarding-id="dashboard-strategies" />
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
          onDeposited={() => {
            treasury.refetch();
            treasuryAssets.refetch();
          }}
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
          onClose={() => {
            setCreateTxOpen(false);
            setInitialNftMint(null);
          }}
        />
      )}
    </div>
  );
}
