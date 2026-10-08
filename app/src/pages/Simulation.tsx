import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import Fi from '@/components/Fi';
import MetricCard from '@/components/MetricCard';
import { PageSkeleton } from '@/components/NaveSkeletons';
import { staggerContainer } from '@/components/PageTransition';
import { fetchSimulationData } from '@/lib/edgeFunctionClient';
import type {
  SimulationDataResponse,
  SimulationPortfolio,
  SimulationRegime,
} from '@/lib/simulation/types';

const PLAYBACK_MS = 100;
const START_CAPITAL = 1_000_000;

const REGIME_COLOR: Record<string, string> = {
  bull: 'hsl(var(--success))',
  bear: 'hsl(var(--destructive))',
  crisis: 'hsl(var(--destructive))',
  sideways: 'hsl(var(--muted-foreground))',
  mixed: 'hsl(var(--warning))',
};

const VENUE_LABEL: Record<string, string> = {
  kamino: 'Kamino',
  marginfi: 'MarginFi',
  jupiter: 'Jupiter Lend',
  jito: 'Jito LST',
  aave: 'Aave V3',
  compound: 'Compound V3',
  'robinhood-bridge': 'Robinhood→Eth',
  cash: 'Cash floor',
};

function formatUsd(n: number, compact = false): string {
  if (!Number.isFinite(n)) return '—';
  if (compact && Math.abs(n) >= 1_000_000) {
    return `$${(n / 1_000_000).toFixed(2)}M`;
  }
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(n);
}

function formatPct(n: number, digits = 1): string {
  if (!Number.isFinite(n)) return '—';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(digits)}%`;
}

function regimeBadge(label: SimulationRegime | string) {
  const color = REGIME_COLOR[label] ?? 'hsl(var(--muted-foreground))';
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5"
      style={{
        fontSize: '11px',
        fontFamily: 'var(--font-mono)',
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
        color,
        backgroundColor: 'hsl(var(--surface-1))',
        border: '1px solid hsl(var(--border))',
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: 999,
          backgroundColor: color,
        }}
      />
      {label}
    </span>
  );
}

function SimulationTopBar() {
  return (
    <header
      className="fixed top-0 inset-x-0 z-40"
      style={{
        height: '56px',
        borderBottom: '1px solid hsl(var(--border))',
        backgroundColor: 'hsla(0, 0%, 100%, 0.9)',
        backdropFilter: 'blur(10px)',
      }}
    >
      <div className="mx-auto h-full w-full max-w-[1200px] px-4 sm:px-6 lg:px-8 flex items-center justify-between">
        <Link
          to="/"
          className="text-display"
          style={{
            fontSize: '26px',
            color: 'hsl(var(--foreground))',
            letterSpacing: '-0.01em',
            textDecoration: 'none',
          }}
        >
          Nave
        </Link>
        <span className="nave-label" style={{ fontSize: '11px' }}>
          portfolio simulation
        </span>
      </div>
    </header>
  );
}

function FanTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: { value: number; name: string; color?: string }[];
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  const rows = payload
    .filter((p) => p.name === 'selected' || p.name === 'median')
    .slice(0, 4);
  return (
    <div
      className="rounded-xl border px-3 py-2.5"
      style={{
        backgroundColor: 'hsl(var(--card))',
        borderColor: 'hsl(var(--border))',
        boxShadow: 'var(--shadow-lg)',
      }}
    >
      <div
        style={{
          fontSize: '11px',
          color: 'hsl(var(--muted-foreground))',
          fontFamily: 'var(--font-mono)',
          marginBottom: 6,
        }}
      >
        Month {label}
      </div>
      {rows.map((p) => (
        <div
          key={p.name}
          style={{
            fontSize: '12.5px',
            fontFamily: 'var(--font-mono)',
            color: 'hsl(var(--foreground))',
          }}
        >
          {p.name === 'selected' ? 'Selected' : 'Median'}: {formatUsd(p.value, true)}
        </div>
      ))}
    </div>
  );
}

export default function Simulation() {
  const [data, setData] = useState<SimulationDataResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [playMonth, setPlayMonth] = useState(0);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const { data: res, error: err } = await fetchSimulationData();
      if (cancelled) return;
      if (err || !res) {
        setError(err ?? 'Failed to load simulation');
        setLoading(false);
        return;
      }
      setData(res);
      setSelectedIndex(0);
      setPlayMonth(0);
      setError(null);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const portfolios = data?.portfolios ?? [];
  const summary = data?.batch.summary;
  const selected: SimulationPortfolio | undefined = portfolios[selectedIndex];

  useEffect(() => {
    if (!playing || !selected) return;
    timerRef.current = window.setInterval(() => {
      setPlayMonth((m) => {
        const max = Math.max(0, (selected.series?.length ?? 1) - 1);
        if (m >= max) {
          setPlaying(false);
          return max;
        }
        return m + 1;
      });
    }, PLAYBACK_MS);
    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current);
    };
  }, [playing, selected]);

  const fanChartData = useMemo(() => {
    if (!portfolios.length) return [];
    const horizon = portfolios[0]?.series?.length ?? 60;
    const rows: Record<string, number | string>[] = [];
    for (let m = 0; m < horizon; m++) {
      const navs = portfolios.map((p) => p.series[m]?.nav ?? p.startNavUsd);
      navs.sort((a, b) => a - b);
      const mid = navs[Math.floor(navs.length / 2)] ?? START_CAPITAL;
      const p10 = navs[Math.floor(navs.length * 0.1)] ?? mid;
      const p90 = navs[Math.floor(navs.length * 0.9)] ?? mid;
      const selectedNav = portfolios[selectedIndex]?.series[m]?.nav ?? mid;
      rows.push({
        month: m,
        p10,
        p90,
        median: mid,
        selected: selectedNav,
        band: p90 - p10,
      });
    }
    return rows;
  }, [portfolios, selectedIndex]);

  const protocolBars = useMemo(() => {
    if (!selected) return [];
    return Object.entries(selected.protocolPnl)
      .map(([id, pnl]) => ({
        id,
        label: VENUE_LABEL[id] ?? id,
        pnl,
      }))
      .sort((a, b) => b.pnl - a.pnl);
  }, [selected]);

  const playbackPoint = selected?.series[playMonth];
  const regimeStrip = useMemo(() => {
    if (!selected?.series) return [];
    return selected.series.map((s) => ({
      month: s.month,
      regime: s.regime,
      nav: s.nav,
    }));
  }, [selected]);

  const onSelectRun = useCallback((idx: number) => {
    setSelectedIndex(idx);
    setPlayMonth(0);
    setPlaying(false);
  }, []);

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', backgroundColor: 'hsl(var(--background))' }}>
        <SimulationTopBar />
        <div className="mx-auto w-full max-w-[1200px] px-4 sm:px-6 lg:px-8" style={{ paddingTop: 112 }}>
          <PageSkeleton />
        </div>
      </div>
    );
  }

  if (error || !data || !summary || !selected) {
    return (
      <div style={{ minHeight: '100vh', backgroundColor: 'hsl(var(--background))' }}>
        <SimulationTopBar />
        <div className="mx-auto w-full max-w-[1200px] px-4 sm:px-6 lg:px-8" style={{ paddingTop: 112 }}>
          <p style={{ color: 'hsl(var(--destructive))', fontFamily: 'var(--font-body)' }}>
            {error ?? 'No simulation data available.'}
          </p>
        </div>
      </div>
    );
  }

  const survivalPct = Math.round(summary.survivalRate * 100);

  return (
    <div style={{ minHeight: '100vh', backgroundColor: 'hsl(var(--background))' }}>
      <SimulationTopBar />

      <motion.main
        className="mx-auto w-full max-w-[1200px] px-4 sm:px-6 lg:px-8"
        style={{ paddingTop: 112, paddingBottom: 80 }}
        variants={staggerContainer}
        initial="initial"
        animate="animate"
      >
        <section style={{ marginBottom: 36 }}>
          <p className="nave-label" style={{ marginBottom: 10 }}>
            50 × $1M · 5 years · 50/50 Solana & EVM
          </p>
          <h1
            className="text-display"
            style={{
              fontSize: 'clamp(34px, 6vw, 56px)',
              lineHeight: 1.05,
              letterSpacing: '-0.02em',
              color: 'hsl(var(--foreground))',
              marginBottom: 12,
            }}
          >
            Nave treasury simulation
          </h1>
          <p
            style={{
              maxWidth: 720,
              fontFamily: 'var(--font-display)',
              fontStyle: 'italic',
              fontSize: 'clamp(18px, 2.5vw, 24px)',
              lineHeight: 1.3,
              color: 'hsl(var(--muted-foreground))',
              marginBottom: 14,
            }}
          >
            Automated allocation across Kamino, MarginFi, Jito, Jupiter Lend, Aave, Compound,
            and Robinhood→Ethereum — tested through staggered bull and bear windows.
          </p>
          <p
            style={{
              fontSize: 12,
              color: 'hsl(var(--muted-foreground))',
              fontFamily: 'var(--font-body)',
              maxWidth: 720,
            }}
          >
            Simulated outcomes using Nave policy rules and protocol APY baselines. Not live
            performance or a promise of returns. Generated{' '}
            {new Date(data.batch.createdAt).toLocaleString()}.
          </p>
        </section>

        <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3 mb-8">
          <MetricCard
            label="Median end NAV"
            value={formatUsd(summary.medianEndNav, true)}
            sub={`from ${formatUsd(START_CAPITAL, true)}`}
            trend={formatPct(((summary.medianEndNav - START_CAPITAL) / START_CAPITAL) * 100)}
            up={summary.medianEndNav >= START_CAPITAL}
            icon="star-half"
          />
          <MetricCard
            label="Best / worst"
            value={formatUsd(summary.bestEndNav, true)}
            sub={`worst ${formatUsd(summary.worstEndNav, true)}`}
            icon="trophy"
          />
          <MetricCard
            label="Survival ≥ $1M"
            value={`${survivalPct}%`}
            sub={`${portfolios.filter((p) => p.endNavUsd >= START_CAPITAL).length} of ${portfolios.length}`}
            up={survivalPct >= 80}
            icon="shield"
          />
          <MetricCard
            label="Avg max drawdown"
            value={`${summary.avgMaxDrawdownPct.toFixed(1)}%`}
            sub={`median CAGR ${formatPct(summary.medianCagrPct)}`}
            icon="gauge"
          />
          <MetricCard
            label="Bull windows"
            value={formatPct(summary.bullCohort.medianReturnPct)}
            sub={`${summary.bullCohort.count} runs · ${formatUsd(summary.bullCohort.medianEndNav, true)}`}
            up
            icon="fire"
          />
          <MetricCard
            label="Bear windows"
            value={formatPct(summary.bearCohort.medianReturnPct)}
            sub={`${summary.bearCohort.count} runs · ${formatUsd(summary.bearCohort.medianEndNav, true)}`}
            up={summary.bearCohort.medianReturnPct >= 0}
            icon="snowflake"
          />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-5 gap-4 mb-8">
          <div className="nave-card p-5 lg:col-span-3">
            <div className="flex items-center justify-between mb-3">
              <div>
                <div className="nave-label mb-1">Equity curves</div>
                <div
                  style={{
                    fontSize: 14,
                    fontFamily: 'var(--font-body)',
                    color: 'hsl(var(--foreground))',
                  }}
                >
                  50 staggered 5-year paths · band = p10–p90
                </div>
              </div>
            </div>
            <div style={{ width: '100%', height: 280 }}>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={fanChartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="simBand" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="hsl(var(--foreground))" stopOpacity={0.12} />
                      <stop offset="100%" stopColor="hsl(var(--foreground))" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" vertical={false} />
                  <XAxis
                    dataKey="month"
                    tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    tickFormatter={(v) => `$${(v / 1e6).toFixed(1)}M`}
                    tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
                    tickLine={false}
                    axisLine={false}
                    width={52}
                  />
                  <Tooltip content={<FanTooltip />} />
                  <Area
                    type="monotone"
                    dataKey="p90"
                    stroke="none"
                    fill="url(#simBand)"
                    isAnimationActive={false}
                  />
                  <Area
                    type="monotone"
                    dataKey="p10"
                    stroke="none"
                    fill="hsl(var(--background))"
                    isAnimationActive={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="median"
                    stroke="hsl(var(--muted-foreground))"
                    strokeWidth={1.5}
                    dot={false}
                    isAnimationActive={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="selected"
                    stroke="hsl(var(--foreground))"
                    strokeWidth={2.25}
                    dot={false}
                    isAnimationActive={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="nave-card p-5 lg:col-span-2">
            <div className="nave-label mb-1">Selected run</div>
            <div className="flex items-center justify-between gap-2 mb-3">
              <div
                className="text-display"
                style={{ fontSize: 22, color: 'hsl(var(--foreground))' }}
              >
                #{selected.runIndex + 1}
              </div>
              {regimeBadge(selected.regimeLabel)}
            </div>
            <div
              style={{
                fontSize: 12,
                fontFamily: 'var(--font-mono)',
                color: 'hsl(var(--muted-foreground))',
                marginBottom: 12,
              }}
            >
              {selected.windowStart} → {selected.windowEnd}
            </div>
            <div className="grid grid-cols-2 gap-3 mb-4">
              <div>
                <div className="nave-label">End NAV</div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 16 }}>
                  {formatUsd(selected.endNavUsd)}
                </div>
              </div>
              <div>
                <div className="nave-label">CAGR</div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 16 }}>
                  {formatPct(selected.cagrPct)}
                </div>
              </div>
              <div>
                <div className="nave-label">Max DD</div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 16 }}>
                  {selected.maxDrawdownPct.toFixed(1)}%
                </div>
              </div>
              <div>
                <div className="nave-label">Sol / EVM</div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 16 }}>
                  {Math.round(selected.chainSplit.solana * 100)}/
                  {Math.round(selected.chainSplit.evm * 100)}
                </div>
              </div>
            </div>

            <div className="nave-label mb-2">Sped-up playback</div>
            <div className="flex items-center gap-2 mb-2">
              <button
                type="button"
                onClick={() => {
                  if (playMonth >= (selected.series.length - 1)) setPlayMonth(0);
                  setPlaying((p) => !p);
                }}
                className="rounded-lg px-3 py-1.5"
                style={{
                  fontSize: 12,
                  fontFamily: 'var(--font-body)',
                  backgroundColor: 'hsl(var(--foreground))',
                  color: 'hsl(var(--background))',
                  border: 'none',
                  cursor: 'pointer',
                }}
              >
                <Fi icon={playing ? 'pause' : 'play'} style={{ marginRight: 6 }} />
                {playing ? 'Pause' : 'Play'}
              </button>
              <span style={{ fontSize: 12, fontFamily: 'var(--font-mono)', color: 'hsl(var(--muted-foreground))' }}>
                {playbackPoint?.t ?? '—'} · {formatUsd(playbackPoint?.nav ?? 0, true)}
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={Math.max(0, selected.series.length - 1)}
              value={playMonth}
              onChange={(e) => {
                setPlaying(false);
                setPlayMonth(Number(e.target.value));
              }}
              className="w-full"
            />
            <div className="flex flex-wrap gap-1 mt-3" style={{ minHeight: 28 }}>
              {regimeStrip.map((s) => (
                <div
                  key={s.month}
                  title={`M${s.month}: ${s.regime}`}
                  style={{
                    width: 4,
                    height: s.month === playMonth ? 18 : 12,
                    backgroundColor: REGIME_COLOR[s.regime],
                    opacity: s.month <= playMonth ? 1 : 0.35,
                    borderRadius: 1,
                  }}
                />
              ))}
            </div>
            <div
              className="mt-2"
              style={{ fontSize: 11, color: 'hsl(var(--muted-foreground))', fontFamily: 'var(--font-mono)' }}
            >
              Regime strip · green bull · red bear/crisis · gray sideways
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-8">
          <div className="nave-card p-5">
            <div className="nave-label mb-1">Protocol contribution</div>
            <div
              style={{
                fontSize: 13,
                color: 'hsl(var(--muted-foreground))',
                marginBottom: 12,
                fontFamily: 'var(--font-body)',
              }}
            >
              Simulated PnL by venue for run #{selected.runIndex + 1}
            </div>
            <div style={{ width: '100%', height: 240 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={protocolBars} layout="vertical" margin={{ left: 8, right: 12 }}>
                  <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" horizontal={false} />
                  <XAxis
                    type="number"
                    tickFormatter={(v) => formatUsd(v, true)}
                    tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    type="category"
                    dataKey="label"
                    width={100}
                    tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <Tooltip
                    formatter={(v: number) => formatUsd(v)}
                    contentStyle={{
                      background: 'hsl(var(--card))',
                      border: '1px solid hsl(var(--border))',
                      borderRadius: 12,
                      fontFamily: 'var(--font-mono)',
                      fontSize: 12,
                    }}
                  />
                  <Bar dataKey="pnl" radius={[0, 4, 4, 0]}>
                    {protocolBars.map((row) => (
                      <Cell
                        key={row.id}
                        fill={
                          row.pnl >= 0
                            ? 'hsl(var(--foreground))'
                            : 'hsl(var(--destructive))'
                        }
                        fillOpacity={0.75}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="nave-card p-5">
            <div className="nave-label mb-1">Playback NAV</div>
            <div
              style={{
                fontSize: 13,
                color: 'hsl(var(--muted-foreground))',
                marginBottom: 12,
              }}
            >
              Solana vs EVM sleeves through the selected window
            </div>
            <div style={{ width: '100%', height: 240 }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart
                  data={selected.series.slice(0, playMonth + 1)}
                  margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
                >
                  <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" vertical={false} />
                  <XAxis
                    dataKey="month"
                    tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    tickFormatter={(v) => `$${(v / 1e6).toFixed(1)}M`}
                    tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
                    axisLine={false}
                    tickLine={false}
                    width={52}
                  />
                  <Tooltip
                    formatter={(v: number, name: string) => [formatUsd(v), name]}
                    contentStyle={{
                      background: 'hsl(var(--card))',
                      border: '1px solid hsl(var(--border))',
                      borderRadius: 12,
                      fontFamily: 'var(--font-mono)',
                      fontSize: 12,
                    }}
                  />
                  <Line type="monotone" dataKey="nav" name="Total" stroke="hsl(var(--foreground))" strokeWidth={2} dot={false} isAnimationActive={false} />
                  <Line type="monotone" dataKey="solNav" name="Solana" stroke="hsl(var(--muted-foreground))" strokeWidth={1.5} strokeDasharray="4 3" dot={false} isAnimationActive={false} />
                  <Line type="monotone" dataKey="evmNav" name="EVM" stroke="hsl(var(--success))" strokeWidth={1.5} strokeDasharray="4 3" dot={false} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>

        <div className="nave-card p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <div className="nave-label mb-1">All 50 portfolios</div>
              <div style={{ fontSize: 13, color: 'hsl(var(--muted-foreground))' }}>
                Different market start/end points · click a row to focus
              </div>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full" style={{ borderCollapse: 'collapse', minWidth: 720 }}>
              <thead>
                <tr
                  style={{
                    textAlign: 'left',
                    fontSize: 11,
                    color: 'hsl(var(--muted-foreground))',
                    fontFamily: 'var(--font-mono)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.04em',
                  }}
                >
                  <th className="py-2 pr-3">Run</th>
                  <th className="py-2 pr-3">Window</th>
                  <th className="py-2 pr-3">Regime</th>
                  <th className="py-2 pr-3">End NAV</th>
                  <th className="py-2 pr-3">Return</th>
                  <th className="py-2 pr-3">CAGR</th>
                  <th className="py-2">Max DD</th>
                </tr>
              </thead>
              <tbody>
                {portfolios.map((p) => {
                  const active = p.runIndex === selectedIndex;
                  return (
                    <tr
                      key={p.id}
                      onClick={() => onSelectRun(p.runIndex)}
                      style={{
                        cursor: 'pointer',
                        backgroundColor: active ? 'hsl(var(--surface-1))' : 'transparent',
                        borderTop: '1px solid hsl(var(--border))',
                        fontFamily: 'var(--font-mono)',
                        fontSize: 12.5,
                        color: 'hsl(var(--foreground))',
                      }}
                    >
                      <td className="py-2.5 pr-3">#{p.runIndex + 1}</td>
                      <td className="py-2.5 pr-3" style={{ color: 'hsl(var(--muted-foreground))' }}>
                        {p.windowStart.slice(0, 7)} → {p.windowEnd.slice(0, 7)}
                      </td>
                      <td className="py-2.5 pr-3">{regimeBadge(p.regimeLabel)}</td>
                      <td className="py-2.5 pr-3">{formatUsd(p.endNavUsd)}</td>
                      <td
                        className="py-2.5 pr-3"
                        style={{
                          color:
                            p.totalReturnPct >= 0
                              ? 'hsl(var(--success))'
                              : 'hsl(var(--destructive))',
                        }}
                      >
                        {formatPct(p.totalReturnPct)}
                      </td>
                      <td className="py-2.5 pr-3">{formatPct(p.cagrPct)}</td>
                      <td className="py-2.5">{p.maxDrawdownPct.toFixed(1)}%</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </motion.main>
    </div>
  );
}
