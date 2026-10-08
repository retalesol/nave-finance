import { useState, useMemo, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useLocation } from 'react-router-dom';
import { motion } from 'framer-motion';
import Fi from '../components/Fi';
import MetricCard from '../components/MetricCard';
import { PageSkeleton } from '../components/NaveSkeletons';
import NaveEmptyState from '../components/NaveEmptyState';
import ActivationHub from '../components/ActivationHub';
import { staggerContainer } from '../components/PageTransition';
import { useDaoContext } from '../hooks/useDaoContext';
import { useTreasuryData, type AssetInfo } from '../hooks/useTreasuryData';
import { useTreasuryAssets } from '../hooks/useTreasuryAssets';
import { useTreasuryNfts } from '../hooks/useTreasuryNfts';
import { useAgentStatus } from '../hooks/useAgentStatus';
import { useTreasuryBalance } from '../hooks/useTreasuryBalance';
import { useActivityLog, type ActivityEntry } from '../hooks/useActivityLog';
import { useMonthlyReports, type YearlyReportGroup, type MonthlyReport } from '../hooks/useMonthlyReports';
import { useDaoRegistry } from '../hooks/useDaoRegistry';
import { useTokenRegistry } from '../hooks/useTokenRegistry';
import { useChain } from '../hooks/useChain';
import { SOLANA_NETWORK } from '../lib/programConfig';
import { daoNetworkLabel, isEvmAddress } from '../lib/chain/types';
import { isMockDaoAddress } from '../lib/mockData';
import {
  DepositFundsModal,
  CreateTransactionModal,
} from '../components/TreasuryActions';
import { DepositAddressPanel } from '../components/DepositFlow';
import { useAgentHealth, timeAgo } from '../hooks/useAgentHealth';
import { computeAgentStatus, summarizeAgentStatuses } from '../lib/agentStatus';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
  PieChart,
  Pie,
  CartesianGrid,
  BarChart,
  Bar,
} from 'recharts';

/* ── Fallback data constants ────────────────────────────────
   These are used by sub-components (ActivityFeed, AssetTable, etc.)
   that live outside the main Dashboard() function and can't access
   hook data directly. In the main page component, `useMemo` blocks
   derive live data from hooks and fall back to these when empty.
   In mock mode the hooks themselves return rich demo data so the
   useMemo blocks pick that up automatically. ────────────────────── */


const AGENT_ROLE_META: Record<string, { icon: string; label: string }> = {
  executive:   { icon: 'crown',          label: 'Executive Agent'  },
  financial:   { icon: 'money-bill-wave', label: 'Financial Agent' },
  oversight:   { icon: 'eye',            label: 'Oversight Agent'  },
  operational: { icon: 'gear',           label: 'Operational Agent' },
};

const AGENT_ROLES_ORDER = ['executive', 'financial', 'oversight', 'operational'] as const;


/* ── Status dot colours ───────────────────────────────────── */
const STATUS_DOT: Record<string, string> = {
  success: 'hsl(var(--success))',
  warning: 'hsl(var(--warning))',
  info:    'hsl(var(--muted-foreground))',
};

/* ── Tooltip components ─────────────────────────────────── */
function TreasuryTooltip({ active, payload, label }: {
  active?: boolean;
  payload?: { value: number; name: string }[];
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div
      className="rounded-xl border px-3 py-2.5"
      style={{ backgroundColor: 'hsl(var(--card))', borderColor: 'hsl(var(--border))', boxShadow: 'var(--shadow-lg)' }}
    >
      <div style={{ fontSize: '11px', color: 'hsl(var(--muted-foreground))', fontFamily: 'var(--font-mono)', marginBottom: '6px' }}>
        {label}
      </div>
      {payload.map(p => (
        <div key={p.name} className="flex items-center gap-2" style={{ fontSize: '12.5px', color: 'hsl(var(--foreground))', fontFamily: 'var(--font-mono)' }}>
          <span style={{ fontWeight: '600' }}>
            {p.name === 'value' ? '$' + p.value.toLocaleString() : '+$' + p.value}
          </span>
          <span style={{ color: 'hsl(var(--muted-foreground))', fontSize: '11px' }}>
            {p.name === 'value' ? 'treasury' : 'yield'}
          </span>
        </div>
      ))}
    </div>
  );
}

function YieldTooltip({ active, payload, label }: {
  active?: boolean;
  payload?: { value: number }[];
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div
      className="rounded-xl border px-3 py-2"
      style={{ backgroundColor: 'hsl(var(--card))', borderColor: 'hsl(var(--border))', boxShadow: 'var(--shadow-md)' }}
    >
      <div style={{ fontSize: '11px', color: 'hsl(var(--muted-foreground))', fontFamily: 'var(--font-mono)' }}>{label}</div>
      <div style={{ fontSize: '13px', fontWeight: '600', fontFamily: 'var(--font-mono)', color: 'hsl(var(--foreground))' }}>
        +${payload[0].value}
      </div>
    </div>
  );
}

/* ── Report Modal (bank-statement style) ────────────────── */
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function ReportModal({ report, onClose }: { report: MonthlyReport; onClose: () => void }) {
  const year = report.year;
  const monthName = MONTH_NAMES[report.month - 1] ?? `Month ${report.month}`;
  const netGain = report.capitalEnd - report.capitalStart;

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto p-4 pt-[5vh]"
      style={{ backgroundColor: 'rgba(0,0,0,0.45)' }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="relative w-full max-w-2xl rounded-2xl border mb-8"
        style={{
          backgroundColor: 'hsl(var(--background))',
          borderColor: 'hsl(var(--border))',
          boxShadow: 'var(--shadow-lg)',
        }}
      >
        {/* Statement header — utility bill style */}
        <div
          className="px-4 sm:px-8 pt-6 sm:pt-8 pb-5 sm:pb-6 border-b"
          style={{ borderColor: 'hsl(var(--border))', backgroundColor: 'hsl(var(--surface-0))' }}
        >
          <div className="flex items-start justify-between">
            <div>
              <div className="text-display font-semibold" style={{ fontSize: '22px', letterSpacing: '-0.02em', color: 'hsl(var(--foreground))' }}>
                Treasury Statement
              </div>
              <div className="nave-mono" style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))', marginTop: '4px' }}>
                {monthName} {year}
              </div>
            </div>
            <button
              onClick={onClose}
              className="p-2 rounded-lg transition-colors"
              style={{ color: 'hsl(var(--muted-foreground))' }}
              onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'hsl(var(--surface-1))')}
              onMouseLeave={e => (e.currentTarget.style.backgroundColor = '')}
            >
              <Fi icon="xmark" style={{ fontSize: '16px' }} />
            </button>
          </div>

          {/* Capital summary — big ruled row */}
          <div
            className="mt-6 grid grid-cols-1 sm:grid-cols-3 gap-0 border rounded-xl overflow-hidden"
            style={{ borderColor: 'hsl(var(--border))' }}
          >
            {[
              { label: 'Opening Balance', value: `$${report.capitalStart.toLocaleString()}`, neutral: true },
              { label: 'Yield Earned', value: `+$${report.yieldEarned.toLocaleString()}`, positive: true },
              { label: 'Closing Balance', value: `$${report.capitalEnd.toLocaleString()}`, bold: true },
            ].map((col, idx) => (
              <div
                key={col.label}
                className="px-4 py-4 text-center"
                style={{
                  borderRight: idx < 2 ? '1px solid hsl(var(--border))' : 'none',
                  borderBottom: idx < 2 ? '1px solid hsl(var(--border))' : 'none',
                  backgroundColor: col.bold ? 'hsl(var(--surface-1))' : 'transparent',
                }}
              >
                <div style={{ fontSize: '10px', fontFamily: 'var(--font-mono)', color: 'hsl(var(--muted-foreground))', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: '6px' }}>
                  {col.label}
                </div>
                <div
                  className="nave-mono"
                  style={{
                    fontSize: '18px',
                    fontWeight: col.bold ? '700' : '600',
                    color: col.positive ? 'hsl(var(--success))' : 'hsl(var(--foreground))',
                  }}
                >
                  {col.value}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="px-4 sm:px-8 py-5 sm:py-6 space-y-6 sm:space-y-7">
          {/* Net gain banner */}
          <div
            className="flex items-center justify-between px-5 py-3.5 rounded-xl"
            style={{ backgroundColor: 'hsl(var(--surface-1))', border: '1px solid hsl(var(--border))' }}
          >
            <div className="flex items-center gap-2">
              <Fi icon="arrow-trend-up" style={{ fontSize: '13px', color: 'hsl(var(--success))' }} />
              <span style={{ fontSize: '13.5px', color: 'hsl(var(--foreground))' }}>Net treasury gain this period</span>
            </div>
            <span className="nave-mono font-bold" style={{ fontSize: '15px', color: 'hsl(var(--success))' }}>
              +${netGain.toLocaleString()}
            </span>
          </div>

          {/* Period activity summary (counts) */}
          <Section title="Period Activity" icon="list-check" count={report.agentActionsCount + report.walletActionsCount + report.proposalsCount}>
            <div className="grid grid-cols-3 border rounded-xl overflow-hidden" style={{ borderColor: 'hsl(var(--border))' }}>
              {[
                { label: 'Agent Actions', value: report.agentActionsCount, icon: 'robot' },
                { label: 'Wallet Actions', value: report.walletActionsCount, icon: 'lock-keyhole' },
                { label: 'Proposals', value: report.proposalsCount, icon: 'vote-yea' },
              ].map((c, idx) => (
                <div
                  key={c.label}
                  className="px-3 py-4 text-center"
                  style={{ borderRight: idx < 2 ? '1px solid hsl(var(--border))' : 'none' }}
                >
                  <Fi icon={c.icon} style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))', display: 'block', marginBottom: '6px' }} />
                  <div className="nave-mono" style={{ fontSize: '18px', fontWeight: 700, color: 'hsl(var(--foreground))' }}>{c.value}</div>
                  <div style={{ fontSize: '10.5px', color: 'hsl(var(--muted-foreground))', marginTop: '2px' }}>{c.label}</div>
                </div>
              ))}
            </div>
          </Section>

          {/* Fees collected */}
          <Section title="Fees Collected" icon="receipt" count={1}>
            <StatementTable
              headers={['Metric', 'Value']}
              rows={[
                [
                  <span key="m" style={{ fontSize: '13px', color: 'hsl(var(--foreground))' }}>Protocol fees this period</span>,
                  <span key="v" className="nave-mono" style={{ fontSize: '12.5px', color: 'hsl(var(--foreground))' }}>${report.feesCollected.toLocaleString()}</span>,
                ],
                [
                  <span key="m2" style={{ fontSize: '13px', color: 'hsl(var(--foreground))' }}>Period return</span>,
                  <span key="v2" className="nave-mono" style={{ fontSize: '12.5px', color: report.returnPct >= 0 ? 'hsl(var(--success))' : 'hsl(var(--destructive))' }}>{report.returnPct >= 0 ? '+' : ''}{report.returnPct.toFixed(2)}%</span>,
                ],
              ]}
            />
          </Section>

          {/* Footer rule — like a bank statement */}
          <div
            className="border-t pt-5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3"
            style={{ borderColor: 'hsl(var(--border))' }}
          >
            <span style={{ fontSize: '11.5px', color: 'hsl(var(--muted-foreground))' }}>
              Generated by Nave · {monthName} {year}
            </span>
            <button
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border transition-colors flex-shrink-0"
              style={{ fontSize: '12px', borderColor: 'hsl(var(--border))', color: 'hsl(var(--muted-foreground))' }}
              onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'hsl(var(--surface-1))')}
              onMouseLeave={e => (e.currentTarget.style.backgroundColor = '')}
            >
              <Fi icon="download" style={{ fontSize: '11px' }} />
              Export
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* ── Statement helpers ─────────────────────────────────── */
function Section({ title, icon, count, children }: { title: string; icon: string; count: number; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <Fi icon={icon} style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))' }} />
        <span className="text-display font-semibold" style={{ fontSize: '13.5px', color: 'hsl(var(--foreground))' }}>{title}</span>
        <span
          className="px-1.5 py-0.5 rounded nave-mono"
          style={{ fontSize: '10px', backgroundColor: 'hsl(var(--surface-1))', color: 'hsl(var(--muted-foreground))', border: '1px solid hsl(var(--border))' }}
        >
          {count}
        </span>
      </div>
      {children}
    </div>
  );
}

function StatementTable({ headers, rows }: { headers: string[]; rows: React.ReactNode[][] }) {
  return (
    <div className="border rounded-xl overflow-x-auto" style={{ borderColor: 'hsl(var(--border))' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '400px' }}>
        <thead>
          <tr style={{ borderBottom: '1px solid hsl(var(--border))', backgroundColor: 'hsl(var(--surface-1))' }}>
            {headers.map(h => (
              <th
                key={h}
                className="text-left px-4 py-2"
                style={{ fontSize: '9.5px', fontFamily: 'var(--font-mono)', color: 'hsl(var(--muted-foreground))', fontWeight: '500', letterSpacing: '0.08em', textTransform: 'uppercase' }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, idx) => (
            <tr
              key={idx}
              style={{ borderBottom: idx < rows.length - 1 ? '1px solid hsl(var(--border))' : 'none' }}
            >
              {row.map((cell, ci) => (
                <td key={ci} className="px-4 py-3">{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ── Reports Drawer (live) ──────────────────────────────────── */
function ReportsDrawer({ open, onClose, reports }: { open: boolean; onClose: () => void; reports: YearlyReportGroup[] }) {
  const [openYears, setOpenYears] = useState<number[]>([]);
  const [activeReport, setActiveReport] = useState<MonthlyReport | null>(null);

  function toggleYear(y: number) {
    setOpenYears(prev => prev.includes(y) ? prev.filter(x => x !== y) : [...prev, y]);
  }

  return createPortal(
    <>
      {/* Backdrop */}
      {open && (
        <div
          className="fixed inset-0 z-40"
          style={{ backgroundColor: 'rgba(0,0,0,0.25)' }}
          onClick={onClose}
        />
      )}

      {/* Drawer */}
      <div
        className="fixed top-0 right-0 bottom-0 z-50 flex flex-col border-l w-full sm:w-[340px]"
        style={{
          backgroundColor: 'hsl(var(--surface-0))',
          borderColor: 'hsl(var(--border))',
          boxShadow: 'var(--shadow-lg)',
          transform: open ? 'translateX(0)' : 'translateX(100%)',
          transition: 'transform 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
        }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-5 py-4 border-b flex-shrink-0"
          style={{ borderColor: 'hsl(var(--border))' }}
        >
          <div className="flex items-center gap-2">
            <Fi icon="newspaper" style={{ fontSize: '15px', color: 'hsl(var(--foreground))' }} />
            <span className="text-display font-semibold" style={{ fontSize: '16px', color: 'hsl(var(--foreground))' }}>
              Reports
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg transition-colors"
            style={{ color: 'hsl(var(--muted-foreground))' }}
            onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'hsl(var(--surface-1))')}
            onMouseLeave={e => (e.currentTarget.style.backgroundColor = '')}
          >
            <Fi icon="xmark" style={{ fontSize: '15px' }} />
          </button>
        </div>

        <p style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))', padding: '12px 20px 8px', lineHeight: 1.5 }}>
          Monthly treasury statements. Click a month to view the full report.
        </p>

        {/* Year / Month list */}
        <div className="flex-1 overflow-y-auto px-3 pb-4">
          {reports.length === 0 && (
            <div className="flex flex-col items-center justify-center text-center px-4 py-16">
              <Fi icon="newspaper" style={{ fontSize: '22px', color: 'hsl(var(--muted-foreground))', marginBottom: '10px' }} />
              <p style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.5 }}>
                No reports yet. Monthly statements are generated automatically as the treasury operates.
              </p>
            </div>
          )}
          {reports.map(({ year, months }) => {
            const expanded = openYears.includes(year) || openYears.length === 0;
            return (
              <div key={year} className="mb-1">
                {/* Year row */}
                <button
                  onClick={() => toggleYear(year)}
                  className="w-full flex items-center justify-between px-3 py-2.5 rounded-lg transition-colors"
                  style={{ color: 'hsl(var(--foreground))' }}
                  onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'hsl(var(--surface-1))')}
                  onMouseLeave={e => (e.currentTarget.style.backgroundColor = '')}
                >
                  <span className="text-display font-semibold" style={{ fontSize: '14px' }}>{year}</span>
                  <div className="flex items-center gap-2">
                    <span className="nave-mono" style={{ fontSize: '11px', color: 'hsl(var(--muted-foreground))' }}>
                      {months.length} report{months.length !== 1 ? 's' : ''}
                    </span>
                    <Fi
                      icon={expanded ? 'chevron-up' : 'chevron-down'}
                      style={{ fontSize: '11px', color: 'hsl(var(--muted-foreground))' }}
                    />
                  </div>
                </button>

                {/* Month rows */}
                {expanded && (
                  <div className="ml-2 space-y-0.5 mb-2">
                    {months.map(m => (
                      <button
                        key={m.month}
                        onClick={() => setActiveReport(m)}
                        className="w-full flex items-center justify-between px-3 py-3 rounded-lg text-left transition-all"
                        style={{
                          backgroundColor: 'transparent',
                          border: '1px solid transparent',
                        }}
                        onMouseEnter={e => {
                          e.currentTarget.style.backgroundColor = 'hsl(var(--surface-1))';
                          e.currentTarget.style.borderColor = 'hsl(var(--border))';
                        }}
                        onMouseLeave={e => {
                          e.currentTarget.style.backgroundColor = 'transparent';
                          e.currentTarget.style.borderColor = 'transparent';
                        }}
                      >
                        <div className="flex items-center gap-3">
                          <div
                            className="w-7 h-7 rounded-md flex items-center justify-center flex-shrink-0"
                            style={{ backgroundColor: 'hsl(var(--surface-1))', border: '1px solid hsl(var(--border))' }}
                          >
                            <span
                              className="text-display"
                              style={{ fontSize: '12px', fontWeight: '700', color: 'hsl(var(--foreground))' }}
                            >
                              {(MONTH_NAMES[m.month - 1] ?? '?').charAt(0)}
                            </span>
                          </div>
                          <div>
                            <div style={{ fontSize: '13.5px', color: 'hsl(var(--foreground))' }}>{MONTH_NAMES[m.month - 1] ?? `Month ${m.month}`}</div>
                            <div className="nave-mono" style={{ fontSize: '11px', color: 'hsl(var(--muted-foreground))' }}>
                              +${m.yieldEarned.toLocaleString()} yield
                            </div>
                          </div>
                        </div>
                        <Fi icon="chevron-right" style={{ fontSize: '11px', color: 'hsl(var(--muted-foreground))' }} />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Report modal */}
      {activeReport && (
        <ReportModal
          report={activeReport}
          onClose={() => setActiveReport(null)}
        />
      )}
    </>,
    document.body,
  );
}

/* ── Activity feed (live) ──────────────────────────────────── */
function ActivityFeed({ activities, onViewAll }: { activities: ActivityEntry[]; onViewAll?: () => void }) {
  return (
    <div className="nave-card">
      <div className="flex items-center justify-between px-5 py-4 border-b" style={{ borderColor: 'hsl(var(--border))' }}>
        <span style={{ fontSize: '14px', fontWeight: '500', color: 'hsl(var(--foreground))' }}>Recent Activity</span>
        <button
          onClick={onViewAll}
          disabled={!onViewAll}
          style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))', cursor: onViewAll ? 'pointer' : 'default' }}
        >
          View all
        </button>
      </div>
      {activities.length === 0 ? (
        <div className="px-5 py-10 text-center">
          <Fi icon="clock-rotate-left" style={{ fontSize: '20px', color: 'hsl(var(--muted-foreground))', display: 'block', marginBottom: '8px' }} />
          <p style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))' }}>No activity yet. Treasury actions and proposals will appear here.</p>
        </div>
      ) : (
        <div className="divide-y" style={{ borderColor: 'hsl(var(--border))' }}>
          {activities.slice(0, 8).map(item => {
            const status = item.agentRole ? 'success' : 'info';
            return (
              <div key={item.id} className="flex items-start gap-3 px-5 py-3.5">
                <div
                  className="w-1.5 h-1.5 rounded-full mt-2 flex-shrink-0"
                  style={{ backgroundColor: STATUS_DOT[status] }}
                />
                <div className="flex-1 min-w-0">
                  <p style={{ fontSize: '13px', color: 'hsl(var(--foreground))', lineHeight: 1.5 }}>{item.description}</p>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span style={{ fontSize: '11px', color: 'hsl(var(--muted-foreground))', fontFamily: 'var(--font-mono)' }}>
                      {item.agentRole || item.eventType}
                    </span>
                    <span style={{ fontSize: '11px', color: 'hsl(var(--muted-foreground))', fontFamily: 'var(--font-mono)' }}>
                      {item.blockTime ? new Date(item.blockTime).toLocaleString() : new Date(item.createdAt).toLocaleString()}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ── Asset table (live) ─────────────────────────────────────── */
function AssetTable({ assets, onRefresh, refreshing }: { assets: AssetInfo[]; onRefresh?: () => void; refreshing?: boolean }) {
  return (
    <div className="nave-card overflow-hidden">
      <div className="flex items-center justify-between px-5 py-4 border-b" style={{ borderColor: 'hsl(var(--border))' }}>
        <span style={{ fontSize: '14px', fontWeight: '500', color: 'hsl(var(--foreground))' }}>Treasury Assets</span>
        <button
          onClick={onRefresh}
          disabled={!onRefresh || refreshing}
          className="flex items-center gap-1.5"
          style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))', cursor: onRefresh && !refreshing ? 'pointer' : 'default' }}
        >
          <Fi icon="arrows-rotate" style={{ fontSize: '11px' }} className={refreshing ? 'animate-spin' : ''} />
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      {assets.length === 0 ? (
        <div className="px-5 py-10 text-center">
          <Fi icon="wallet" style={{ fontSize: '20px', color: 'hsl(var(--muted-foreground))', display: 'block', marginBottom: '8px' }} />
          <p style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))' }}>
            No assets yet. Use Receive Funds to deposit SOL or tokens into the treasury.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid hsl(var(--border))' }}>
                {['Asset', 'Balance', 'Value', 'Allocation'].map(h => (
                  <th
                    key={h}
                    className="text-left px-5 py-2.5"
                    style={{ fontSize: '10px', fontFamily: 'var(--font-mono)', color: 'hsl(var(--muted-foreground))', fontWeight: '500', letterSpacing: '0.06em', textTransform: 'uppercase' }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {assets.map((a, idx) => (
                <tr
                  key={a.symbol}
                  style={{ borderBottom: idx < assets.length - 1 ? '1px solid hsl(var(--border))' : 'none' }}
                  onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'hsl(var(--surface-1))')}
                  onMouseLeave={e => (e.currentTarget.style.backgroundColor = '')}
                >
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-2.5">
                      <div
                        className="w-7 h-7 rounded-full flex items-center justify-center"
                        style={{ backgroundColor: 'hsl(var(--surface-1))', border: '1px solid hsl(var(--border))', fontSize: '10px', fontFamily: 'var(--font-mono)', fontWeight: '600' }}
                      >
                        {a.symbol.slice(0, 2)}
                      </div>
                      <div>
                        <div style={{ fontSize: '13.5px', fontWeight: '500', color: 'hsl(var(--foreground))' }}>{a.symbol}</div>
                        <div style={{ fontSize: '11px', color: 'hsl(var(--muted-foreground))' }}>{a.name}</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-5 py-3.5 nave-mono" style={{ fontSize: '13px', color: 'hsl(var(--foreground))' }}>{a.balance.toLocaleString()}</td>
                  <td className="px-5 py-3.5 nave-mono font-medium" style={{ fontSize: '13px', color: 'hsl(var(--foreground))' }}>${a.valueUsd.toLocaleString()}</td>
                  <td className="px-5 py-3.5 nave-mono" style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))' }}>{a.allocation.toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ── Allocation donut (live) ───────────────────────────────── */
function AllocationDonut({ allocation }: { allocation: Array<{ name: string; value: number; color: string }> }) {
  if (allocation.length === 0) {
    return (
      <div className="nave-card p-5">
        <div className="nave-label mb-4">Allocation</div>
        <div className="flex flex-col items-center justify-center py-6 text-center">
          <Fi icon="chart-pie" style={{ fontSize: '20px', color: 'hsl(var(--muted-foreground))', marginBottom: '8px' }} />
          <p style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))' }}>No allocation yet</p>
        </div>
      </div>
    );
  }
  const ALLOC_DATA = allocation;
  return (
    <div className="nave-card p-5">
      <div className="nave-label mb-4">Allocation</div>
      <div className="flex items-center gap-4">
        <ResponsiveContainer width={100} height={100}>
          <PieChart>
            <Pie data={ALLOC_DATA} dataKey="value" cx="50%" cy="50%" innerRadius={28} outerRadius={46} strokeWidth={2} stroke="hsl(var(--surface-0))">
              {ALLOC_DATA.map((entry, index) => (
                <Cell key={`cell-${index}`} fill={entry.color} />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        <div className="space-y-1.5 flex-1">
          {ALLOC_DATA.map(d => (
            <div key={d.name} className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: d.color }} />
                <span style={{ fontSize: '12px', color: 'hsl(var(--foreground))' }}>{d.name}</span>
              </div>
              <span className="nave-mono" style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))' }}>{d.value}%</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ── Agent status panel (live health) ──────────────────── */
function AgentStatusPanel({
  navigate,
  daoAddress,
  agentStatus,
  frozen,
}: {
  navigate: (p: string) => void;
  daoAddress: string | null;
  agentStatus: ReturnType<typeof useAgentStatus>;
  frozen: boolean;
}) {
  const health = useAgentHealth(daoAddress);
  const hasOnChain = agentStatus.onChainData !== null;

  // Compute a single accurate status per role from on-chain enablement + health,
  // always rendering all four roles (even when there is no activity yet).
  const rows = AGENT_ROLES_ORDER.map(role => {
    const onChainAgent = agentStatus.agents.find(a => a.role === role) ?? null;
    const healthEntry = health.agents.find(a => a.role === role) ?? null;
    const status = computeAgentStatus({
      agentsEnabled: agentStatus.agentsEnabled,
      frozen,
      hasOnChain,
      onChain: onChainAgent
        ? { active: onChainAgent.active, nullified: onChainAgent.nullified, status: onChainAgent.status }
        : null,
      health: healthEntry,
    });
    return { role, healthEntry, status };
  });

  const summary = summarizeAgentStatuses(rows.map(r => r.status));
  const operational = summary.level === 'active';
  const critical = summary.level === 'frozen' || summary.level === 'revoked';
  const statusIcon = critical
    ? 'triangle-exclamation'
    : operational
      ? 'lock-keyhole'
      : 'circle-info';

  return (
    <div className="nave-card p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <span style={{ fontSize: '14px', fontWeight: '500', color: 'hsl(var(--foreground))' }}>Agent Status</span>
          {operational ? (
            <span
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full"
              style={{ fontSize: '9px', fontFamily: 'var(--font-mono)', backgroundColor: 'hsl(var(--success-muted))', color: 'hsl(152 50% 28%)', letterSpacing: '0.04em' }}
            >
              <span className="w-1 h-1 rounded-full" style={{ backgroundColor: 'hsl(var(--success))' }} />
              LIVE
            </span>
          ) : (
            <span
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full"
              style={{ fontSize: '9px', fontFamily: 'var(--font-mono)', backgroundColor: critical ? 'hsl(var(--destructive-muted))' : 'hsl(var(--warning-muted))', color: summary.color, letterSpacing: '0.04em' }}
            >
              <span className="w-1 h-1 rounded-full" style={{ backgroundColor: summary.color }} />
              {summary.level === 'frozen' ? 'FROZEN' : summary.level === 'paused' ? 'PAUSED' : summary.level === 'unknown' ? 'NO DATA' : 'ATTENTION'}
            </span>
          )}
        </div>
        <button
          onClick={() => navigate('/agent')}
          aria-label="View agent details"
          className="p-1 rounded-lg border transition-all"
          style={{ borderColor: 'hsl(var(--border))', color: 'hsl(var(--muted-foreground))' }}
          onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'hsl(var(--surface-1))')}
          onMouseLeave={e => (e.currentTarget.style.backgroundColor = '')}
        >
          <Fi icon="arrow-up-right" style={{ fontSize: '12px' }} />
        </button>
      </div>
      <div className="space-y-2.5">
        {rows.map(({ role, healthEntry, status }) => {
          const meta = AGENT_ROLE_META[role] || { icon: 'robot', label: role };
          return (
            <div key={role} className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div
                  className="w-6 h-6 rounded-md flex items-center justify-center"
                  style={{ backgroundColor: status.enabled ? 'hsl(var(--primary))' : 'hsl(var(--surface-2))' }}
                >
                  <Fi icon={meta.icon} style={{ fontSize: '11px', color: status.enabled ? 'white' : 'hsl(var(--muted-foreground))' }} />
                </div>
                <span style={{ fontSize: '13px', color: 'hsl(var(--foreground))' }}>{meta.label}</span>
              </div>
              <div className="flex items-center gap-2">
                {healthEntry?.last_confidence != null && (
                  <span style={{ fontSize: '10px', fontFamily: 'var(--font-mono)', color: 'hsl(var(--muted-foreground))' }}>
                    {healthEntry.last_confidence}%
                  </span>
                )}
                <span style={{ fontSize: '11px', fontFamily: 'var(--font-mono)', color: 'hsl(var(--muted-foreground))' }}>
                  {timeAgo(healthEntry?.last_action_at ?? null)}
                </span>
                <span style={{ fontSize: '10px', fontFamily: 'var(--font-mono)', color: status.color, letterSpacing: '0.03em' }}>
                  {status.label}
                </span>
                <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: status.color }} />
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-4 pt-3 border-t flex items-center gap-2" style={{ borderColor: 'hsl(var(--border))' }}>
        <Fi icon={statusIcon} style={{ fontSize: '11px', color: summary.color }} />
        <span style={{ fontSize: '12px', color: summary.color }}>{summary.label}</span>
      </div>
      {health.error && (
        <div className="mt-2 flex items-start gap-1.5" style={{ fontSize: '11px', color: 'hsl(var(--destructive))' }}>
          <Fi icon="triangle-exclamation" style={{ fontSize: '10px', marginTop: '2px' }} />
          <span>Agent health unavailable — {health.error}</span>
        </div>
      )}
    </div>
  );
}

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
  const isMock = isMockDaoAddress(daoAddress);

  useEffect(() => {
    const state = location.state as {
      openCreateTx?: boolean;
      openDeposit?: boolean;
      nftTransfer?: { mint: string };
      startOnboarding?: boolean;
      treasuryAddress?: string;
    } | null;
    if (state?.openDeposit) {
      setDepositFundsOpen(true);
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
  const { chainKind } = useChain();
  // Label from dao_registry.chain_id so a Base or Robinhood treasury is not
  // called "Solana Devnet" when the connected wallet is on another chain.
  const daoChainId = daoRegistry.dao?.chainId ?? null;
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
      return treasury.strategies.map(s => ({
        protocol: s.protocol,
        label: s.name,
        asset: s.protocol,
        allocated: s.currentValueUsd,
        earned: s.currentValueUsd * (s.apy / 100 / 12), // rough monthly estimate
        apy: s.apy,
      }));
    }
    return [];
  }, [treasury.strategies]);

  // Agent efficiency — live; '—' when there is nothing to measure yet.
  const agentEfficiency = useMemo(() => {
    if (agentStatus.agents.length > 0) {
      const activeCount = agentStatus.agents.filter(a => a.active).length;
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

  // 24h treasury trend from live history snapshots.
  const treasuryTrend24h = useMemo(() => {
    const h = treasury.history;
    if (h.length < 2) return undefined;
    const latest = h[h.length - 1];
    const latestTs = new Date(latest.snapshotAt).getTime();
    let baseline = h[0];
    for (let i = h.length - 2; i >= 0; i--) {
      const ts = new Date(h[i].snapshotAt).getTime();
      if (latestTs - ts >= 20 * 60 * 60 * 1000) {
        baseline = h[i];
        break;
      }
    }
    if (baseline.totalValueUsd > 0) {
      const pct = ((latest.totalValueUsd - baseline.totalValueUsd) / baseline.totalValueUsd) * 100;
      return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
    }
    return undefined;
  }, [treasury.history]);

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
      return treasury.history.map(s => ({
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
        .map(m => ({ month: m.month, value: m.yieldEarned }));
    }
    return [];
  }, [monthlyReports.allMonths]);

  const chartYieldByAsset = useMemo(() => {
    if (treasury.strategies.length > 0) {
      const byAsset: Record<string, number> = {};
      treasury.strategies.forEach(s => {
        const key = s.protocol;
        byAsset[key] = (byAsset[key] || 0) + s.currentValueUsd * (s.apy / 100 / 12);
      });
      const colors = ['hsl(var(--foreground))', 'hsl(var(--muted-foreground))', 'hsl(var(--border-strong))'];
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
  const blendedAPY    = totalDeployed > 0 ? ((totalYield / totalDeployed) * 100).toFixed(2) : '0.00';

  // ─── Multi-asset on-chain treasury (preferred over legacy SOL/USDC) ────
  // When the DAO has registered assets, the on-chain AssetConfig/TreasuryAsset
  // accounts + revalued USD NAV are authoritative for the asset table, total
  // value and allocation donut. Fall back to the legacy snapshot view otherwise.
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
    chainKind === 'evm' && treasuryAssets.onchainNavUsd != null
      ? treasuryAssets.onchainNavUsd
      : chainKind === 'evm' && displayAssetsValue > 0
        ? displayAssetsValue
      : hasOnchainAssets && treasuryAssets.onchainNavUsd != null
        ? treasuryAssets.onchainNavUsd
        : treasury.currentValue;

  const displayAllocation = useMemo(() => {
    if (!hasOnchainAssets) return treasury.allocation;
    const palette = ['#6366f1', '#22c55e', '#f59e0b', '#ef4444', '#06b6d4', '#a855f7'];
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

  return (
    <div className="px-4 sm:px-6 py-5 sm:py-6 space-y-5 sm:space-y-6 animate-fade-in" data-onboarding-id="dashboard-root">
      <div ref={activationRef}>
        <ActivationHub
          onOpenDeposit={() => setDepositFundsOpen(true)}
          onSignerComplete={() => daoRegistry.refetch()}
        />
      </div>

      {/* Data fetch errors — surfaced instead of being swallowed in the console */}
      {(treasury.error || agentStatus.error) && (
        <div
          className="flex items-start gap-2.5 px-4 py-3 rounded-xl border"
          style={{ backgroundColor: 'hsl(var(--destructive-muted))', borderColor: 'hsl(0 72% 80%)' }}
        >
          <Fi icon="triangle-exclamation" style={{ fontSize: '13px', color: 'hsl(var(--destructive))', flexShrink: 0, marginTop: '2px' }} />
          <div style={{ fontSize: '12.5px', color: 'hsl(0 60% 35%)', lineHeight: 1.5 }}>
            <strong>Some dashboard data failed to load.</strong>{' '}
            {treasury.error && <span>Treasury: {treasury.error}. </span>}
            {agentStatus.error && <span>Agents: {agentStatus.error}.</span>}
          </div>
        </div>
      )}

      {/* Top action bar */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3" data-onboarding-id="dashboard-header">
        <div>
          <h1
            className="text-display font-semibold"
            style={{ fontSize: '22px', letterSpacing: '-0.02em', color: 'hsl(var(--foreground))' }}
          >
            Treasury Overview
          </h1>
          <p style={{ fontSize: '13.5px', color: 'hsl(var(--muted-foreground))', marginTop: '2px' }}>
            {daoRegistry.dao?.name ?? 'Treasury'} · {networkLabel}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {!isEmptyTreasury && (
          <button
            onClick={() => setReportsOpen(true)}
            data-onboarding-id="dashboard-reports-button"
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg border transition-colors"
            style={{ fontSize: '13px', borderColor: 'hsl(var(--border))', color: 'hsl(var(--foreground))' }}
            onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'hsl(var(--surface-1))')}
            onMouseLeave={e => (e.currentTarget.style.backgroundColor = '')}
          >
            <Fi icon="newspaper" style={{ fontSize: '11px' }} />
            Reports
          </button>
          )}
        </div>
      </div>

      {/* Treasury hero — balance first */}
      <div
        className="nave-card overflow-hidden"
        data-onboarding-id="dashboard-hero"
        style={{ borderColor: 'hsl(var(--border))' }}
      >
        <div className="px-5 py-6 sm:py-8 flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
          <div>
            <div className="nave-label" style={{ fontSize: '11px', marginBottom: '6px' }}>Total balance</div>
            <div
              className="text-display font-bold nave-mono"
              style={{ fontSize: 'clamp(28px, 5vw, 40px)', letterSpacing: '-0.02em', color: 'hsl(var(--foreground))' }}
            >
              ${displayCurrentValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </div>
            <div className="flex flex-wrap items-center gap-3 mt-2" style={{ fontSize: '12.5px' }}>
              {treasuryTrend24h && (
                <span
                  className="flex items-center gap-1"
                  style={{ color: treasuryTrend24h.startsWith('-') ? 'hsl(var(--destructive))' : 'hsl(var(--success))' }}
                >
                  <Fi icon={treasuryTrend24h.startsWith('-') ? 'arrow-trend-down' : 'arrow-trend-up'} style={{ fontSize: '11px' }} />
                  {treasuryTrend24h}
                  <span style={{ color: 'hsl(var(--muted-foreground))' }}>24h</span>
                </span>
              )}
              {treasuryTrend && (
                <span
                  className="flex items-center gap-1"
                  style={{ color: treasuryTrend.startsWith('-') ? 'hsl(var(--destructive))' : 'hsl(var(--success))' }}
                >
                  <Fi icon={treasuryTrend.startsWith('-') ? 'arrow-trend-down' : 'arrow-trend-up'} style={{ fontSize: '11px' }} />
                  {treasuryTrend}
                  <span style={{ color: 'hsl(var(--muted-foreground))' }}>7d</span>
                </span>
              )}
              {!treasuryTrend24h && !treasuryTrend && (
                <span style={{ color: 'hsl(var(--muted-foreground))' }}>
                  {isEmptyTreasury ? 'Add funds to start tracking trends' : hasOnchainAssets ? 'On-chain USD NAV' : 'No history yet'}
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              type="button"
              onClick={() => setDepositFundsOpen(true)}
              data-onboarding-id="dashboard-deposit-button"
              className="flex items-center justify-center gap-2 px-5 py-3 rounded-xl font-medium transition-all"
              style={{ fontSize: '14px', backgroundColor: 'hsl(var(--primary))', color: 'hsl(var(--primary-foreground))' }}
            >
              <Fi icon="arrow-down-to-bracket" style={{ fontSize: '13px' }} />
              Add funds
            </button>
            {!isEmptyTreasury && (
            <button
              type="button"
              onClick={() => setCreateTxOpen(true)}
              data-onboarding-id="dashboard-create-transaction-button"
              className="flex items-center justify-center gap-2 px-5 py-3 rounded-xl border font-medium transition-colors"
              style={{ fontSize: '14px', borderColor: 'hsl(var(--border))', color: 'hsl(var(--foreground))' }}
              onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'hsl(var(--surface-1))')}
              onMouseLeave={e => (e.currentTarget.style.backgroundColor = '')}
            >
              <Fi icon="paper-plane" style={{ fontSize: '13px' }} />
              <span className="hidden sm:inline">Propose transfer</span>
              <span className="sm:hidden">Propose</span>
            </button>
            )}
          </div>
        </div>
      </div>

      {/* Emergency freeze banner */}
      {daoRegistry.dao?.frozen && (
        <div
          className="flex items-center gap-3 px-4 py-3.5 rounded-xl border"
          style={{
            backgroundColor: 'hsl(var(--destructive-muted))',
            borderColor: 'hsl(0 72% 80%)',
          }}
        >
          <div
            className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
            style={{ backgroundColor: 'hsl(var(--destructive))' }}
          >
            <Fi icon="shield-halved" style={{ fontSize: '14px', color: 'white' }} />
          </div>
          <div className="flex-1 min-w-0">
            <div style={{ fontSize: '13.5px', fontWeight: '600', color: 'hsl(0 60% 35%)' }}>
              Treasury is Emergency Frozen
            </div>
            <div style={{ fontSize: '12px', color: 'hsl(0 40% 45%)', marginTop: '1px' }}>
              All agent operations, strategy executions, and withdrawals are halted. Contact a guardian to unfreeze.
            </div>
          </div>
          <div
            className="hidden sm:flex items-center gap-1 px-2 py-1 rounded-md flex-shrink-0"
            style={{ backgroundColor: 'hsl(0 60% 92%)', fontSize: '10px', fontFamily: 'var(--font-mono)', color: 'hsl(0 60% 40%)', letterSpacing: '0.04em' }}
          >
            <Fi icon="lock" style={{ fontSize: '8px' }} />
            FROZEN
          </div>
        </div>
      )}

      {/* Health alert — omit false-positive "within bounds" when treasury is empty */}
      {!daoRegistry.dao?.frozen && !isEmptyTreasury && (
        <div
          className="flex items-center gap-2.5 px-4 py-3 rounded-xl border"
          data-onboarding-id="dashboard-health-banner"
          style={{ backgroundColor: 'hsl(var(--surface-1))', borderColor: 'hsl(var(--border))' }}
        >
          <Fi icon="check" style={{ fontSize: '13px', color: 'hsl(var(--success))', flexShrink: 0 }} />
          <span style={{ fontSize: '13px', color: 'hsl(var(--foreground))' }}>
            Treasury within constitutional bounds. {recentActivityCount > 0 ? `${recentActivityCount} recent actions logged.` : 'No activity recorded yet.'}
          </span>
        </div>
      )}

      {isEmptyTreasury && daoAddress && (
        <DepositAddressPanel
          daoAddress={daoAddress}
          daoName={daoRegistry.dao?.name}
          vaultMint={votingMint}
        />
      )}

      {/* KPI row — defer detail metrics until funded */}
      {!isEmptyTreasury && (
      <motion.div
        className="grid grid-cols-1 xs:grid-cols-2 lg:grid-cols-4 gap-3"
        data-onboarding-id="dashboard-metrics"
        variants={staggerContainer}
        initial="initial"
        animate="animate"
      >
        <MetricCard label="Total Treasury Value"  value={`$${displayCurrentValue.toLocaleString()}`} trend={treasuryTrend} sub={treasuryTrend ? '7-day' : (hasOnchainAssets ? 'On-chain USD NAV' : 'No history yet')} up={!!treasuryTrend} />
        <MetricCard label="Total Yield Earned"    value={`$${totalYield.toLocaleString()}`} trend={yieldTrend}  sub={latestMonthYield > 0 ? `$${latestMonthYield.toLocaleString()} this month` : 'Across all strategies'} up={!!yieldTrend && !yieldTrend.startsWith('-')} />
        <MetricCard label="Blended APY"           value={`${blendedAPY}%`}                 sub="Weighted average"                           />
        <MetricCard label="Agent Efficiency"      value={agentEfficiency}                    sub="Policy compliance rate"             up={agentEfficiency !== '—'} />
      </motion.div>
      )}

      {/* 90-day treasury value chart (full width) — hidden until funded */}
      {!isEmptyTreasury && (
      <>
      <div className="nave-card overflow-hidden" data-onboarding-id="dashboard-value-chart">
        <div
          className="flex items-center justify-between px-5 py-4 border-b"
          style={{ borderColor: 'hsl(var(--border))' }}
        >
          <div>
            <span className="text-display font-semibold" style={{ fontSize: '14px' }}>Treasury Value</span>
            <div style={{ fontSize: '11.5px', color: 'hsl(var(--muted-foreground))', marginTop: '2px' }}>90-day history</div>
          </div>
          {treasuryTrend && (
            <div className="flex items-center gap-1.5">
              <span className="flex items-center gap-1" style={{ fontSize: '13px', color: 'hsl(var(--success))' }}>
                <Fi icon="arrow-trend-up" style={{ fontSize: '12px' }} />
                {treasuryTrend}
              </span>
              <span style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))', fontFamily: 'var(--font-mono)' }}>7d</span>
            </div>
          )}
        </div>
        {treasuryChartData.length === 0 ? (
          <div className="px-5 py-16 text-center">
            <Fi icon="chart-area" style={{ fontSize: '22px', color: 'hsl(var(--muted-foreground))', display: 'block', marginBottom: '10px' }} />
            <p style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))' }}>
              No treasury history yet. A chart appears once the treasury holds assets and snapshots are recorded.
            </p>
          </div>
        ) : (
        <div className="p-5 pt-4">
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={treasuryChartData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="tvGrad90" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="hsl(0, 0%, 15%)" stopOpacity={0.1} />
                  <stop offset="100%" stopColor="hsl(0, 0%, 15%)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(0, 0%, 90%)" vertical={false} />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 10, fill: 'hsl(0, 0%, 55%)', fontFamily: 'var(--font-mono)' }}
                axisLine={false} tickLine={false} interval={1}
              />
              <YAxis
                tick={{ fontSize: 10, fill: 'hsl(0, 0%, 55%)', fontFamily: 'var(--font-mono)' }}
                axisLine={false} tickLine={false}
                tickFormatter={v => `$${(v / 1000).toFixed(0)}k`}
                width={44}
              />
              <Tooltip content={<TreasuryTooltip />} />
              <Area
                type="monotone" dataKey="value"
                stroke="hsl(0, 0%, 15%)" strokeWidth={2}
                fill="url(#tvGrad90)" dot={false}
                activeDot={{ r: 4, fill: 'hsl(0, 0%, 15%)', strokeWidth: 0 }}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
        )}
      </div>

      {/* Monthly yield + Allocation donut */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4" data-onboarding-id="dashboard-yield-allocation">
        {/* Monthly yield bars */}
        <div className="nave-card overflow-hidden" data-onboarding-id="dashboard-monthly-yield">
          <div className="px-5 py-4 border-b" style={{ borderColor: 'hsl(var(--border))' }}>
            <span className="text-display font-semibold" style={{ fontSize: '14px' }}>Monthly Yield</span>
            <div style={{ fontSize: '11.5px', color: 'hsl(var(--muted-foreground))', marginTop: '2px' }}>USD earned per month</div>
          </div>
          {chartMonthlyYield.length === 0 ? (
            <div className="px-5 py-12 text-center">
              <Fi icon="chart-column" style={{ fontSize: '20px', color: 'hsl(var(--muted-foreground))', display: 'block', marginBottom: '8px' }} />
              <p style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))' }}>No yield recorded yet.</p>
            </div>
          ) : (
          <div className="p-5 pt-4">
            <ResponsiveContainer width="100%" height={160}>
              <BarChart data={chartMonthlyYield} margin={{ top: 4, right: 4, left: 0, bottom: 0 }} barCategoryGap="30%">
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(0, 0%, 90%)" vertical={false} />
                <XAxis dataKey="month" tick={{ fontSize: 10, fill: 'hsl(0, 0%, 55%)', fontFamily: 'var(--font-mono)' }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 10, fill: 'hsl(0, 0%, 55%)', fontFamily: 'var(--font-mono)' }} axisLine={false} tickLine={false} tickFormatter={v => `${v}`} width={40} />
                <Tooltip content={<YieldTooltip />} />
                <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                  {chartMonthlyYield.map((_, index) => (
                    <Cell
                      key={`cell-${index}`}
                      fill={index === chartMonthlyYield.length - 1 ? 'hsl(0, 0%, 12%)' : 'hsl(0, 0%, 88%)'}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          )}
        </div>

        {/* Yield by asset + allocation */}
        <div className="space-y-4" data-onboarding-id="dashboard-allocation-group">
          <AllocationDonut allocation={displayAllocation} />
          {/* Yield by asset */}
          <div className="nave-card overflow-hidden" data-onboarding-id="dashboard-yield-by-asset">
            <div className="px-5 py-4 border-b" style={{ borderColor: 'hsl(var(--border))' }}>
              <span className="text-display font-semibold" style={{ fontSize: '14px' }}>Yield by Asset</span>
              <div style={{ fontSize: '11.5px', color: 'hsl(var(--muted-foreground))', marginTop: '2px' }}>All-time earnings per token</div>
            </div>
            <div className="p-5 space-y-4">
              {chartYieldByAsset.map(a => {
                const pct = totalYield > 0 ? Math.round((a.earned / totalYield) * 100) : 0;
                return (
                  <div key={a.asset}>
                    <div className="flex items-center justify-between mb-1.5">
                      <div className="flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full" style={{ backgroundColor: a.color }} />
                        <span className="nave-mono" style={{ fontSize: '12.5px', color: 'hsl(var(--foreground))' }}>{a.asset}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="nave-mono" style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))' }}>{pct}%</span>
                        <span className="nave-mono font-semibold" style={{ fontSize: '12.5px', color: 'hsl(var(--foreground))' }}>${a.earned.toLocaleString()}</span>
                      </div>
                    </div>
                    <div className="h-2 rounded-full overflow-hidden" style={{ backgroundColor: 'hsl(var(--border))' }}>
                      <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: a.color }} />
                    </div>
                  </div>
                );
              })}
              <div className="flex items-center justify-between pt-3 border-t" style={{ borderColor: 'hsl(var(--border))' }}>
                <span style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))', fontFamily: 'var(--font-mono)' }}>Total</span>
                <span className="nave-mono font-semibold" style={{ fontSize: '13.5px', color: 'hsl(var(--foreground))' }}>${totalYield.toLocaleString()}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
      </>
      )}

      {/* Agent status + Activity */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4" data-onboarding-id="dashboard-agent-activity">
        <AgentStatusPanel
          navigate={navigate}
          daoAddress={daoAddress}
          agentStatus={agentStatus}
          frozen={daoRegistry.dao?.frozen ?? false}
        />
        <div className="md:col-span-2" data-onboarding-id="dashboard-activity">
          <ActivityFeed activities={activityLog.activities} onViewAll={() => navigate('/settings')} />
        </div>
      </div>

      {/* Asset table */}
      <div data-onboarding-id="dashboard-assets">
        <AssetTable assets={displayAssets} onRefresh={treasuryAssets.refetch} refreshing={treasuryAssets.loading} />
      </div>
      {hasOnchainAssets && (
        <p style={{ fontSize: '11.5px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.55, paddingLeft: '2px' }}>
          Dollar amounts update after the treasury is priced. Token balances are already live.
        </p>
      )}

      {/* Strategy performance table */}
      {!isEmptyTreasury && (
      <div className="nave-card overflow-hidden" data-onboarding-id="dashboard-strategies">
        <div
          className="flex items-center justify-between px-5 py-4 border-b"
          style={{ borderColor: 'hsl(var(--border))' }}
        >
          <span className="text-display font-semibold" style={{ fontSize: '14px' }}>Strategy Performance</span>
          <span style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))', fontFamily: 'var(--font-mono)' }}>
            {liveStrategies.length} active strategies
          </span>
        </div>
        {liveStrategies.length === 0 ? (
          <div className="px-5 py-12 text-center">
            <Fi icon="layer-group" style={{ fontSize: '20px', color: 'hsl(var(--muted-foreground))', display: 'block', marginBottom: '8px' }} />
            <p style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))' }}>
              No active strategies. Yield strategies appear here once the treasury deploys capital.
            </p>
          </div>
        ) : (
        <div className="overflow-x-auto">
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid hsl(var(--border))' }}>
                {['Protocol', 'Asset', 'Allocated', 'APY', 'Earned'].map(h => (
                  <th
                    key={h}
                    className="text-left px-5 py-2.5"
                    style={{ fontSize: '10px', fontFamily: 'var(--font-mono)', color: 'hsl(var(--muted-foreground))', fontWeight: '500', letterSpacing: '0.08em', textTransform: 'uppercase' }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {liveStrategies.map((s, idx) => (
                <tr
                  key={s.protocol}
                  style={{ borderBottom: idx < liveStrategies.length - 1 ? '1px solid hsl(var(--border))' : 'none' }}
                  onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'hsl(var(--surface-1))')}
                  onMouseLeave={e => (e.currentTarget.style.backgroundColor = '')}
                >
                  <td className="px-5 py-3.5">
                    <span className="text-display font-medium" style={{ fontSize: '13.5px', color: 'hsl(var(--foreground))' }}>{s.protocol}</span>
                  </td>
                  <td className="px-5 py-3.5">
                    <span className="nave-mono" style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))' }}>{s.asset}</span>
                  </td>
                  <td className="px-5 py-3.5">
                    <span className="nave-mono font-medium" style={{ fontSize: '13px', color: 'hsl(var(--foreground))' }}>${s.allocated.toLocaleString()}</span>
                  </td>
                  <td className="px-5 py-3.5">
                    <span className="flex items-center gap-1" style={{ fontSize: '13px', color: 'hsl(var(--success))' }}>
                      <Fi icon="arrow-trend-up" style={{ fontSize: '11px' }} />
                      {s.apy}%
                    </span>
                  </td>
                  <td className="px-5 py-3.5">
                    <span className="nave-mono font-semibold" style={{ fontSize: '13px', color: 'hsl(var(--foreground))' }}>${s.earned.toLocaleString()}</span>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ borderTop: '1px solid hsl(var(--border))' }}>
                <td colSpan={4} className="px-5 py-3" style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))', fontFamily: 'var(--font-mono)' }}>
                  Total earned
                </td>
                <td className="px-5 py-3" style={{ fontSize: '14px', fontWeight: '600', fontFamily: 'var(--font-mono)', color: 'hsl(var(--foreground))' }}>
                  ${totalYield.toLocaleString()}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
        )}
      </div>
      )}

      {!isEmptyTreasury && (
      <div
        className="nave-card p-5"
        data-onboarding-id="dashboard-projected-yield"
        style={{ backgroundColor: 'hsl(var(--surface-1))' }}
      >
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="flex items-center gap-3">
            <div
              className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
              style={{ backgroundColor: 'hsl(var(--primary))' }}
            >
              <Fi icon="bolt" style={{ fontSize: '16px', color: 'white' }} />
            </div>
            <div>
              <div className="text-display font-semibold" style={{ fontSize: '14px', color: 'hsl(var(--foreground))' }}>
                Projected Annual Yield
              </div>
              <div style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))', marginTop: '2px' }}>
                Based on current {blendedAPY}% blended APY across ${totalDeployed.toLocaleString()} deployed
              </div>
            </div>
          </div>
          <div className="flex items-center justify-between sm:justify-end gap-6 sm:gap-8 flex-shrink-0">
            {[
              { label: 'Monthly', value: `${Math.round(totalDeployed * (parseFloat(blendedAPY) / 100) / 12).toLocaleString()}` },
              { label: 'Weekly',  value: `${Math.round(totalDeployed * (parseFloat(blendedAPY) / 100) / 52).toLocaleString()}` },
              { label: 'Annual',  value: `${Math.round(totalDeployed * (parseFloat(blendedAPY) / 100)).toLocaleString()}` },
            ].map(p => (
              <div key={p.label} className="text-left sm:text-right">
                <div className="nave-label" style={{ fontSize: '9.5px', marginBottom: '3px' }}>{p.label}</div>
                <div className="nave-mono font-bold" style={{ fontSize: '16px', color: 'hsl(var(--foreground))' }}>{p.value}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
      )}

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
          onDeposited={treasury.refetch}
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