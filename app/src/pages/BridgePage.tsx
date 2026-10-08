import { useState, useEffect, useMemo, lazy, Suspense } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useWallet } from '@solana/wallet-adapter-react';
import { useAccount } from 'wagmi';
import { formatUnits } from 'viem';
import { useBridgeStats, type BridgeHistoryRow } from '../hooks/useBridgeStats';
import { BridgeProvider, useBridge, type BridgeAttempt } from '../hooks/useBridge';
import { isConfirmationWaitError } from '../lib/bridge/confirmations';
import { evmTarget, type EvmChainId } from '../lib/chain/types';
import {
  ACTIVITY_EVENT,
  activityStatusLabel,
  isActivityInFlight,
  mergeActivity,
  readLocalActivity,
  type ActivityEntry,
} from '../lib/staking/activityFeed';
import WalletNetworkMenu from '../components/WalletNetworkMenu';
import {
  EVM_DEPLOYMENT_MODE,
  NAVE_BRIDGE_FEE_BPS,
  NAVE_DECIMALS,
  SOLANA_NETWORK,
} from '../lib/programConfig';
import Fi from '../components/Fi';
import { Button } from '../components/ui/button';
import { Skeleton } from '../components/ui/skeleton';
import BridgeFaucetBanner from '../components/BridgeFaucetBanner';
import StakeBox from '../components/StakeBox';
import BridgeContractAddresses from '../components/BridgeContractAddresses';
import Bridge from './Bridge';

// The three.js/postprocessing wave background is ~1MB and purely decorative —
// lazy-load it off the critical path so the page shell (nav, form) renders
// before the WebGL bundle finishes downloading/parsing.
const Dither = lazy(() => import('../components/Dither'));

function usePrefersReducedMotion() {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setPrefersReducedMotion(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setPrefersReducedMotion(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return prefersReducedMotion;
}

/* ── Formatting helpers ───────────────────────────────────────── */

function formatNave(raw: bigint): string {
  const s = formatUnits(raw, NAVE_DECIMALS);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

/** Compact display for stat tiles (e.g. 12,480.5). */
function formatNaveCompact(raw: bigint): string {
  const n = Number(formatUnits(raw, NAVE_DECIMALS));
  if (!Number.isFinite(n)) return formatNave(raw);
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/** Percent display for a chain's staking APY — em-dash when the drip is inactive. */
function formatApy(apy: number | null): string {
  if (apy === null || !Number.isFinite(apy)) return '—';
  if (apy > 0 && apy < 0.01) return '<0.01%';
  return `${apy.toFixed(2)}%`;
}

/** USD display for the volume tile (compact above $10k, cents below). */
function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 10_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function shortHash(value: string): string {
  return value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-6)}` : value;
}

/** Friendly label for a bridge_transfers chain string ('solana' | 'ethereum' | 'base' | 'robinhood' | 'sepolia' | …). */
function chainLabel(chain: string): string {
  const s = chain.trim().toLowerCase();
  if (s === 'solana') return 'Solana';
  const testnet = EVM_DEPLOYMENT_MODE !== 'mainnet';
  if (s.includes('robinhood')) return testnet ? 'Robinhood Testnet' : 'Robinhood Chain';
  if (s.includes('base')) return testnet ? 'Base Sepolia' : 'Base';
  return testnet ? 'Sepolia' : 'Ethereum';
}

/** Explorer URL for a tx hash on a bridge_transfers chain string. */
function explorerTx(chain: string, tx: string): string {
  const s = chain.trim().toLowerCase();
  if (s === 'solana') {
    const cluster = SOLANA_NETWORK === 'mainnet' ? '' : '?cluster=devnet';
    return `https://solscan.io/tx/${tx}${cluster}`;
  }
  const testnet = EVM_DEPLOYMENT_MODE !== 'mainnet';
  if (s.includes('robinhood')) {
    // Blockscout uses the same /tx/<hash> path shape as Etherscan.
    return `${testnet ? 'https://explorer.testnet.chain.robinhood.com' : 'https://robinhoodchain.blockscout.com'}/tx/${tx}`;
  }
  if (s.includes('base')) {
    return `${testnet ? 'https://sepolia.basescan.org' : 'https://basescan.org'}/tx/${tx}`;
  }
  return `${testnet ? 'https://sepolia.etherscan.io' : 'https://etherscan.io'}/tx/${tx}`;
}

function statusStyle(status: string): { bg: string; fg: string; border: string } {
  if (status === 'completed') {
    return { bg: 'hsl(var(--success-muted))', fg: 'hsl(152 50% 28%)', border: 'hsl(152 40% 84%)' };
  }
  if (status === 'failed') {
    return { bg: 'hsl(var(--destructive-muted))', fg: 'hsl(var(--destructive))', border: 'hsl(0 60% 88%)' };
  }
  return { bg: 'hsl(var(--surface-1))', fg: 'hsl(var(--muted-foreground))', border: 'hsl(var(--border))' };
}

/* ── Nav bar ──────────────────────────────────────────────────── */

function BridgeNavBar({ returnTo }: { returnTo?: string }) {
  const navigate = useNavigate();

  return (
    <>
      <header
        className="fixed top-0 inset-x-0 z-50 flex items-center justify-between px-4 sm:px-6 md:px-10"
        style={{
          height: '56px',
          backgroundColor: 'hsla(0, 0%, 100%, 0.92)',
          backdropFilter: 'blur(12px)',
          borderBottom: '1px solid hsl(var(--border))',
        }}
      >
        <button
          onClick={() => navigate('/')}
          className="text-display transition-opacity hover:opacity-70"
          style={{ fontSize: '22px', color: 'hsl(var(--foreground))', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
        >
          Nave
        </button>

        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate(returnTo || '/')}
            className="flex items-center gap-1.5 transition-colors"
            style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
          >
            <Fi icon="arrow-left" style={{ fontSize: '11px' }} />
            {returnTo === '/create-dao' ? 'Back to create' : 'Home'}
          </button>
          <WalletNetworkMenu />
        </div>
      </header>
    </>
  );
}

/* ── Stat tile ────────────────────────────────────────────────── */

function StatTile({
  label,
  value,
  suffix,
  icon,
  breakdown,
  breakdownNote,
  loading = false,
}: {
  label: string;
  value: string;
  suffix?: string;
  icon: string;
  /** Optional per-source rows revealed on hover/focus (e.g. Solana vs EVM staked). */
  breakdown?: { label: string; value: string }[];
  /** Optional explanatory footnote rendered under the breakdown rows. */
  breakdownNote?: string;
  /** True while the first load is in flight — renders a skeleton instead of the value. */
  loading?: boolean;
}) {
  const hasBreakdown = !!breakdown && breakdown.length > 0;
  return (
    <div
      // Tiles with a breakdown are focusable so the disclosure also opens via
      // keyboard (group-focus-within) — hover-only would exclude keyboard and
      // most touch users.
      tabIndex={hasBreakdown ? 0 : undefined}
      className={`group relative rounded-xl border p-4 sm:p-5${hasBreakdown ? ' cursor-help' : ''}`}
      style={{ backgroundColor: 'hsla(0, 0%, 100%, 0.86)', borderColor: 'hsl(var(--border))', backdropFilter: 'blur(4px)' }}
    >
      <div className="flex items-center justify-between">
        <span className="nave-label">{label}</span>
        <Fi icon={hasBreakdown ? 'circle-info' : icon} style={{ fontSize: 11, color: 'hsl(var(--muted-foreground))' }} />
      </div>
      {loading ? (
        <Skeleton className="h-[29px] w-20" style={{ marginTop: 8 }} aria-hidden />
      ) : (
        <div className="flex items-baseline gap-1.5" style={{ marginTop: 8 }}>
          <span className="text-display" style={{ fontSize: 26, lineHeight: 1.1, color: 'hsl(var(--foreground))' }}>
            {value}
          </span>
          {suffix && (
            <span style={{ fontSize: 11.5, color: 'hsl(var(--muted-foreground))', fontFamily: 'var(--font-mono)' }}>
              {suffix}
            </span>
          )}
        </div>
      )}

      {hasBreakdown && (
        <div
          className="absolute left-3 right-3 top-full z-30 mt-1 rounded-lg border p-3 opacity-0 invisible translate-y-1 transition-all duration-150 group-hover:opacity-100 group-hover:visible group-hover:translate-y-0 group-focus-within:opacity-100 group-focus-within:visible group-focus-within:translate-y-0"
          style={{ backgroundColor: 'hsl(var(--surface-0))', borderColor: 'hsl(var(--border-strong))', boxShadow: 'var(--shadow-lg)' }}
        >
          {breakdown.map((row) => (
            <div key={row.label} className="flex items-center justify-between" style={{ padding: '2px 0' }}>
              <span style={{ fontSize: 11.5, color: 'hsl(var(--muted-foreground))' }}>{row.label}</span>
              <span style={{ fontSize: 11.5, fontFamily: 'var(--font-mono)', color: 'hsl(var(--foreground))' }}>{row.value}</span>
            </div>
          ))}
          {breakdownNote && (
            <p
              className="mt-1.5 pt-1.5 border-t"
              style={{ fontSize: 10.5, color: 'hsl(var(--muted-foreground))', lineHeight: 1.5, borderColor: 'hsl(var(--border))' }}
            >
              {breakdownNote}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Transfer history ─────────────────────────────────────────── */

function HistoryRow({ row }: { row: BridgeHistoryRow }) {
  const s = statusStyle(row.status);
  const net = row.netRaw ?? row.amountRaw;
  const date = new Date(row.createdAt);
  return (
    <div
      className="grid items-center gap-x-3 gap-y-1 py-3 border-b last:border-b-0 grid-cols-2 sm:grid-cols-[1fr_auto_auto_auto_auto]"
      style={{ borderColor: 'hsl(var(--border))' }}
    >
      {/* Route */}
      <div className="flex items-center gap-1.5 min-w-0">
        <span style={{ fontSize: 12.5, color: 'hsl(var(--foreground))', fontWeight: 500 }}>
          {chainLabel(row.sourceChain)}
        </span>
        <Fi icon="arrow-right" style={{ fontSize: 9, color: 'hsl(var(--muted-foreground))' }} />
        <span style={{ fontSize: 12.5, color: 'hsl(var(--foreground))', fontWeight: 500 }}>
          {chainLabel(row.destChain)}
        </span>
      </div>

      {/* Amount */}
      <div className="text-right sm:text-left" style={{ fontSize: 12.5, fontFamily: 'var(--font-mono)', color: 'hsl(var(--foreground))' }}>
        {formatNave(net)} NAVE
      </div>

      {/* Txs */}
      <div className="flex items-center gap-2.5 col-span-2 sm:col-span-1">
        <a
          href={explorerTx(row.sourceChain, row.sourceTx)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 hover:opacity-70 transition-opacity"
          style={{ fontSize: 11.5, fontFamily: 'var(--font-mono)', color: 'hsl(var(--muted-foreground))' }}
          title={`Source: ${row.sourceTx}`}
        >
          {shortHash(row.sourceTx)}
          <Fi icon="arrow-up-right-from-square" style={{ fontSize: 8.5 }} />
        </a>
        {row.destTx && (
          <a
            href={explorerTx(row.destChain, row.destTx)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 hover:opacity-70 transition-opacity"
            style={{ fontSize: 11.5, fontFamily: 'var(--font-mono)', color: 'hsl(var(--muted-foreground))' }}
            title={`Destination: ${row.destTx}`}
          >
            {shortHash(row.destTx)}
            <Fi icon="arrow-up-right-from-square" style={{ fontSize: 8.5 }} />
          </a>
        )}
      </div>

      {/* Status */}
      <div>
        <span
          className="inline-flex items-center px-2 py-0.5 rounded-full"
          style={{ fontSize: 10.5, fontWeight: 500, backgroundColor: s.bg, color: s.fg, border: `1px solid ${s.border}` }}
        >
          {row.status}
        </span>
      </div>

      {/* Date */}
      <div style={{ fontSize: 11, color: 'hsl(var(--muted-foreground))', fontFamily: 'var(--font-mono)' }}>
        {date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}{' '}
        {date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
      </div>
    </div>
  );
}

/** Route (source/dest chain strings) for the in-flight attempt, derived from
 *  its direction + EVM endpoint so it reads with the same labels/links as DB
 *  history rows. */
function attemptChains(attempt: BridgeAttempt): { sourceChain: string; destChain: string } {
  const evmFamily = evmTarget(attempt.evmChainId).family; // 'ethereum' | 'base'
  return attempt.direction === 'solana_to_evm'
    ? { sourceChain: 'solana', destChain: evmFamily }
    : { sourceChain: evmFamily, destChain: 'solana' };
}

/** Live status label for the in-flight attempt's pill. */
function liveStatusLabel(attempt: BridgeAttempt): string {
  const r = attempt.response;
  if (r.status === 'confirming') {
    if (r.confirmationsRequired != null && r.confirmationsCurrent != null) {
      return r.confirmationsRequired === 1
        ? 'Finalizing…'
        : `Confirming ${Math.min(r.confirmationsCurrent, r.confirmationsRequired)}/${r.confirmationsRequired}`;
    }
    return 'Confirming…';
  }
  if (r.status === 'pending') return 'Finalizing…';
  if (r.status === 'completed') return 'completed';
  if (r.status === 'failed') return 'failed';
  return r.status;
}

/**
 * The in-flight (or just-completed, pre-DB-refresh) transfer, rendered as the
 * top row of "Your transfers". Shares the grid layout with HistoryRow but adds
 * a spinner + confirmation counter while non-terminal, and an inline retry
 * button on a genuine relay failure.
 */
function LiveTransferRow({
  attempt,
  onRetry,
  retrying,
}: {
  attempt: BridgeAttempt;
  onRetry: () => void;
  retrying: boolean;
}) {
  const { sourceChain, destChain } = attemptChains(attempt);
  const r = attempt.response;
  const inProgress = r.status === 'confirming' || r.status === 'pending';
  const label = liveStatusLabel(attempt);
  const s = statusStyle(r.status);
  const showRetry = r.status === 'failed' && !isConfirmationWaitError(r.error);

  return (
    <div
      className="grid items-center gap-x-3 gap-y-1 py-3 border-b last:border-b-0 grid-cols-2 sm:grid-cols-[1fr_auto_auto_auto_auto]"
      style={{ borderColor: 'hsl(var(--border))' }}
      role="status"
      aria-live="polite"
    >
      {/* Route */}
      <div className="flex items-center gap-1.5 min-w-0">
        <span style={{ fontSize: 12.5, color: 'hsl(var(--foreground))', fontWeight: 500 }}>
          {chainLabel(sourceChain)}
        </span>
        <Fi icon="arrow-right" style={{ fontSize: 9, color: 'hsl(var(--muted-foreground))' }} />
        <span style={{ fontSize: 12.5, color: 'hsl(var(--foreground))', fontWeight: 500 }}>
          {chainLabel(destChain)}
        </span>
      </div>

      {/* Amount */}
      <div className="text-right sm:text-left" style={{ fontSize: 12.5, fontFamily: 'var(--font-mono)', color: 'hsl(var(--foreground))' }}>
        {formatNave(BigInt(attempt.amountRaw))} NAVE
      </div>

      {/* Txs */}
      <div className="flex items-center gap-2.5 col-span-2 sm:col-span-1">
        <a
          href={explorerTx(sourceChain, attempt.sourceTx)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 hover:opacity-70 transition-opacity"
          style={{ fontSize: 11.5, fontFamily: 'var(--font-mono)', color: 'hsl(var(--muted-foreground))' }}
          title={`Source: ${attempt.sourceTx}`}
        >
          {shortHash(attempt.sourceTx)}
          <Fi icon="arrow-up-right-from-square" style={{ fontSize: 8.5 }} />
        </a>
        {r.destTxHash && (
          <a
            href={explorerTx(destChain, r.destTxHash)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 hover:opacity-70 transition-opacity"
            style={{ fontSize: 11.5, fontFamily: 'var(--font-mono)', color: 'hsl(var(--muted-foreground))' }}
            title={`Destination: ${r.destTxHash}`}
          >
            {shortHash(r.destTxHash)}
            <Fi icon="arrow-up-right-from-square" style={{ fontSize: 8.5 }} />
          </a>
        )}
      </div>

      {/* Status */}
      <div className="flex items-center gap-1.5">
        {inProgress && (
          <Fi icon="spinner" className="animate-spin" style={{ fontSize: 10, color: 'hsl(var(--muted-foreground))' }} />
        )}
        <span
          className="inline-flex items-center px-2 py-0.5 rounded-full"
          style={{ fontSize: 10.5, fontWeight: 500, backgroundColor: s.bg, color: s.fg, border: `1px solid ${s.border}` }}
        >
          {label}
        </span>
        {showRetry && (
          <Button
            size="sm"
            variant="outline"
            onClick={onRetry}
            disabled={retrying}
            style={{ height: 22, padding: '0 8px', fontSize: 10.5 }}
          >
            {retrying ? 'Retrying…' : 'Retry'}
          </Button>
        )}
      </div>

      {/* Date */}
      <div style={{ fontSize: 11, color: 'hsl(var(--muted-foreground))', fontFamily: 'var(--font-mono)' }}>
        Now
      </div>
    </div>
  );
}

/**
 * One stake / unstake / claim row in "Your Transactions". Shares the grid
 * layout with HistoryRow. Claims read as a Solana → chain delivery and walk
 * through the relayer's live phases (submitted → wrapping → delivering →
 * completed) with a spinner while in flight.
 */
function ActivityRow({ entry }: { entry: ActivityEntry }) {
  const chainName = chainLabel(entry.chainFamily);
  const inFlight = isActivityInFlight(entry);
  const label = activityStatusLabel(entry, chainName);
  const s = statusStyle(inFlight ? 'pending' : entry.status);
  const date = new Date(entry.createdAt);
  const kindLabel = entry.kind === 'claim' ? 'Claim' : entry.kind === 'stake' ? 'Stake' : 'Unstake';

  return (
    <div
      className="grid items-center gap-x-3 gap-y-1 py-3 border-b last:border-b-0 grid-cols-2 sm:grid-cols-[1fr_auto_auto_auto_auto]"
      style={{ borderColor: 'hsl(var(--border))' }}
      role={inFlight ? 'status' : undefined}
      aria-live={inFlight ? 'polite' : undefined}
    >
      {/* What + where */}
      <div className="flex items-center gap-1.5 min-w-0">
        <span
          className="inline-flex items-center px-1.5 py-px rounded"
          style={{
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: '0.02em',
            backgroundColor: 'hsl(var(--surface-1))',
            color: 'hsl(var(--muted-foreground))',
            border: '1px solid hsl(var(--border))',
          }}
        >
          {kindLabel}
        </span>
        {entry.kind === 'claim' && entry.chainFamily !== 'solana' ? (
          <>
            <span style={{ fontSize: 12.5, color: 'hsl(var(--foreground))', fontWeight: 500 }}>Solana</span>
            <Fi icon="arrow-right" style={{ fontSize: 9, color: 'hsl(var(--muted-foreground))' }} />
            <span style={{ fontSize: 12.5, color: 'hsl(var(--foreground))', fontWeight: 500 }}>{chainName}</span>
          </>
        ) : (
          <span style={{ fontSize: 12.5, color: 'hsl(var(--foreground))', fontWeight: 500 }}>{chainName}</span>
        )}
      </div>

      {/* Amount */}
      <div className="text-right sm:text-left" style={{ fontSize: 12.5, fontFamily: 'var(--font-mono)', color: 'hsl(var(--foreground))' }}>
        {entry.amountRaw != null ? `${formatNave(BigInt(entry.amountRaw))} ${entry.chainFamily === 'solana' ? 'NAVE' : 'wNAVE'}` : '—'}
      </div>

      {/* Txs — the Solana wrap first (claims), then the chain-side tx */}
      <div className="flex items-center gap-2.5 col-span-2 sm:col-span-1">
        {entry.wrapTx && (
          <a
            href={explorerTx('solana', entry.wrapTx)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 hover:opacity-70 transition-opacity"
            style={{ fontSize: 11.5, fontFamily: 'var(--font-mono)', color: 'hsl(var(--muted-foreground))' }}
            title={`Solana wrap: ${entry.wrapTx}`}
          >
            {shortHash(entry.wrapTx)}
            <Fi icon="arrow-up-right-from-square" style={{ fontSize: 8.5 }} />
          </a>
        )}
        {entry.tx && (
          <a
            href={explorerTx(entry.chainFamily, entry.tx)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 hover:opacity-70 transition-opacity"
            style={{ fontSize: 11.5, fontFamily: 'var(--font-mono)', color: 'hsl(var(--muted-foreground))' }}
            title={entry.kind === 'claim' ? `Delivery: ${entry.tx}` : `Tx: ${entry.tx}`}
          >
            {shortHash(entry.tx)}
            <Fi icon="arrow-up-right-from-square" style={{ fontSize: 8.5 }} />
          </a>
        )}
        {!entry.wrapTx && !entry.tx && (
          <span style={{ fontSize: 11.5, fontFamily: 'var(--font-mono)', color: 'hsl(var(--muted-foreground))' }}>—</span>
        )}
      </div>

      {/* Status */}
      <div className="flex items-center gap-1.5">
        {inFlight && (
          <Fi icon="spinner" className="animate-spin" style={{ fontSize: 10, color: 'hsl(var(--muted-foreground))' }} />
        )}
        <span
          className="inline-flex items-center px-2 py-0.5 rounded-full"
          style={{ fontSize: 10.5, fontWeight: 500, backgroundColor: s.bg, color: s.fg, border: `1px solid ${s.border}` }}
          title={entry.error}
        >
          {label}
        </span>
      </div>

      {/* Date */}
      <div style={{ fontSize: 11, color: 'hsl(var(--muted-foreground))', fontFamily: 'var(--font-mono)' }}>
        {date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}{' '}
        {date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
      </div>
    </div>
  );
}

type FeedItem =
  | { type: 'bridge'; createdAt: string; row: BridgeHistoryRow }
  | { type: 'activity'; createdAt: string; entry: ActivityEntry };

/**
 * "Your Transactions" list: bridges, stakes, unstakes, and claims for the
 * connected wallet(s), merged newest-first. The in-flight bridge attempt sits
 * on top until the relayer confirms it; in-flight claims stream their live
 * phase (submitted → wrapping → delivering) via the local activity store,
 * which useStaking updates while the relayer works.
 */
function TransactionsFeed({
  history,
  activity,
  loading,
  anyWalletConnected,
  bothWallets,
}: {
  history: BridgeHistoryRow[];
  activity: ActivityEntry[];
  loading: boolean;
  anyWalletConnected: boolean;
  bothWallets: boolean;
}) {
  const { lastAttempt, retryRelay, isBridging } = useBridge();
  const { publicKey } = useWallet();
  const { address: evmAddress } = useAccount();

  // Local entries (Solana actions, in-flight claims) refresh on every
  // activity-store write so claim phases stream in real time.
  const [localVersion, setLocalVersion] = useState(0);
  useEffect(() => {
    const bump = () => setLocalVersion((v) => v + 1);
    window.addEventListener(ACTIVITY_EVENT, bump);
    window.addEventListener('storage', bump);
    return () => {
      window.removeEventListener(ACTIVITY_EVENT, bump);
      window.removeEventListener('storage', bump);
    };
  }, []);
  const merged = useMemo(() => {
    void localVersion; // re-read local storage on every store write
    return mergeActivity(readLocalActivity([publicKey?.toBase58(), evmAddress]), activity);
  }, [publicKey, evmAddress, activity, localVersion]);

  // Surface the live bridge attempt unless the DB history already carries the
  // same source tx (in which case the authoritative DB row is shown instead).
  const dbHasAttempt =
    !!lastAttempt && history.some((row) => row.sourceTx === lastAttempt.sourceTx);
  const liveAttempt = lastAttempt && !dbHasAttempt ? lastAttempt : null;

  const items: FeedItem[] = useMemo(
    () =>
      [
        ...history.map((row): FeedItem => ({ type: 'bridge', createdAt: row.createdAt, row })),
        ...merged.map((entry): FeedItem => ({ type: 'activity', createdAt: entry.createdAt, entry })),
      ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [history, merged],
  );
  const hasAnyRows = !!liveAttempt || items.length > 0;

  return (
    <div className="mt-8">
      <div
        className="rounded-xl border p-5"
        style={{ backgroundColor: 'hsla(0, 0%, 100%, 0.92)', borderColor: 'hsl(var(--border))', backdropFilter: 'blur(4px)' }}
      >
        <div className="flex items-center justify-between mb-1">
          <span className="text-display font-semibold" style={{ fontSize: 16, color: 'hsl(var(--foreground))' }}>
            Your Transactions
          </span>
          <Fi icon="clock-rotate-left" style={{ fontSize: 12, color: 'hsl(var(--muted-foreground))' }} />
        </div>
        <p style={{ fontSize: 11.5, color: 'hsl(var(--muted-foreground))', lineHeight: 1.5, marginBottom: 8 }}>
          Bridges, stakes, unstakes, and reward claims for your connected wallet{bothWallets ? 's' : ''}.
        </p>

        {!anyWalletConnected ? (
          <div className="py-8 text-center">
            <Fi icon="wallet" style={{ fontSize: 18, color: 'hsl(var(--border-strong))' }} />
            <p style={{ fontSize: 12.5, color: 'hsl(var(--muted-foreground))', marginTop: 8 }}>
              Connect a wallet to see your transactions.
            </p>
          </div>
        ) : loading && !hasAnyRows ? (
          // First load in flight — show skeleton rows instead of flashing
          // the empty state before data arrives.
          <div className="space-y-3 py-2" aria-hidden>
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </div>
        ) : !hasAnyRows ? (
          <div className="py-8 text-center">
            <Fi icon="water" style={{ fontSize: 18, color: 'hsl(var(--border-strong))' }} />
            <p style={{ fontSize: 12.5, color: 'hsl(var(--muted-foreground))', marginTop: 8 }}>
              No transactions yet — your bridge and staking activity will appear here.
            </p>
          </div>
        ) : (
          <div>
            {liveAttempt && (
              <LiveTransferRow
                attempt={liveAttempt}
                onRetry={() => void retryRelay()}
                retrying={isBridging}
              />
            )}
            {items.map((item) =>
              item.type === 'bridge' ? (
                <HistoryRow key={`b-${item.row.id}`} row={item.row} />
              ) : (
                <ActivityRow key={`a-${item.entry.id}`} entry={item.entry} />
              ),
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Page ─────────────────────────────────────────────────────── */

export default function BridgePage() {
  const location = useLocation();
  const returnTo = (location.state as { returnTo?: string } | null)?.returnTo === '/create-dao'
    ? '/create-dao'
    : undefined;
  const prefersReducedMotion = usePrefersReducedMotion();
  const {
    stats,
    pool,
    evmStakedRaw,
    evmStakedByChain,
    wrappedOutstandingRaw,
    wrappedByChain,
    rewardReserveRaw,
    naveUsdPrice,
    apy,
    history,
    activity,
    loading,
  } = useBridgeStats();
  const { publicKey } = useWallet();
  const { address: evmAddress } = useAccount();
  const anyWalletConnected = !!publicKey || !!evmAddress;

  // Combined staked total across ALL FOUR chains (Solana central pool + each
  // EVM mirror), with a per-chain hover breakdown on the "Total staked" tile.
  const solStakedRaw = pool?.totalStaked ?? null;
  const totalStakedRaw =
    solStakedRaw === null && evmStakedRaw === null
      ? null
      : (solStakedRaw ?? 0n) + (evmStakedRaw ?? 0n);
  const stakedBreakdown = [
    { label: 'Solana', value: `${solStakedRaw === null ? '—' : formatNaveCompact(solStakedRaw)} NAVE` },
    ...Object.entries(evmStakedByChain).map(([id, raw]) => ({
      label: chainLabel(evmTarget(Number(id) as EvmChainId).family),
      value: `${raw === undefined ? '—' : formatNaveCompact(raw)} wNAVE`,
    })),
    { label: 'APY', value: formatApy(apy) },
  ];

  // "Total bridged" = wNAVE actively OUTSTANDING on other chains (per-chain
  // ERC-20 totalSupply, i.e. mints − burns) — not cumulative turnover.
  const bridgedBreakdown = Object.entries(wrappedByChain).map(([id, raw]) => ({
    label: chainLabel(evmTarget(Number(id) as EvmChainId).family),
    value: `${raw === undefined ? '—' : formatNaveCompact(raw)} wNAVE`,
  }));

  // "Total Volume" = cumulative bridged NAVE over all history × spot price.
  const volumeNave = stats ? Number(formatUnits(stats.totalBridgedRaw, NAVE_DECIMALS)) : null;
  const volumeUsd = volumeNave !== null && naveUsdPrice !== null ? volumeNave * naveUsdPrice : null;
  const volumeBreakdown = [
    { label: 'Bridged all-time', value: `${stats ? formatNaveCompact(stats.totalBridgedRaw) : '—'} NAVE` },
    { label: 'Transfers', value: stats ? stats.transferCount.toLocaleString() : '—' },
    { label: 'NAVE price', value: naveUsdPrice !== null ? `$${naveUsdPrice.toLocaleString(undefined, { maximumFractionDigits: 6 })}` : '—' },
  ];

  // Reward pool = Solana reward vault + the relayer's claim reserve (the
  // account EVM claims pay out of), so claims on ANY chain shrink the tile.
  const rewardPoolRaw =
    pool === null && rewardReserveRaw === null
      ? null
      : (pool?.rewardBalance ?? 0n) + (rewardReserveRaw ?? 0n);
  const rewardBreakdown = [
    { label: 'Solana reward vault', value: `${pool ? formatNaveCompact(pool.rewardBalance) : '—'} NAVE` },
    { label: 'EVM claim reserve', value: `${rewardReserveRaw !== null ? formatNaveCompact(rewardReserveRaw) : '—'} NAVE` },
  ];
  // A SINGLE protocol-wide APY: the central Solana reward pool's annual emission
  // divided by the TOTAL NAVE staked across all three chains (the TVL). It is
  // identical on every chain — EVM staking is just a weighted claim on the one
  // Solana reward pool, so there is deliberately no per-chain APY variance.
  const stakedBreakdownNote =
    'APY is protocol-wide: the central Solana reward pool\u2019s annual emission over the total NAVE staked across Solana, Ethereum, Base, and Robinhood. It is the same on every chain.';

  return (
    <BridgeProvider>
    <div className="relative min-h-screen overflow-x-hidden" style={{ backgroundColor: 'hsl(var(--background))' }}>
      <BridgeNavBar returnTo={returnTo} />

      {/* Dither sea — the waves live BENEATH the bridge: pinned to the bottom
          of the viewport and fading out toward the horizon, so the content
          above reads as the deck crossing over water. */}
      <div
        className="fixed inset-x-0 bottom-0 z-0 pointer-events-none"
        style={{
          height: '46vh',
          opacity: 0.5,
          mixBlendMode: 'multiply',
          WebkitMaskImage: 'linear-gradient(to bottom, transparent 0%, black 45%, black 100%)',
          maskImage: 'linear-gradient(to bottom, transparent 0%, black 45%, black 100%)',
        }}
        aria-hidden
      >
        <Suspense fallback={null}>
          <Dither
            waveColor={[0.82, 0.81, 0.79]}
            colorNum={5}
            pixelSize={2}
            waveAmplitude={0.34}
            waveFrequency={2.4}
            waveSpeed={0.055}
            disableAnimation={prefersReducedMotion}
            enableMouseInteraction={false}
            mouseRadius={0.25}
          />
        </Suspense>
      </div>

      {/* Faucet banner — in normal flow below the fixed 56px header so it can
          never overlap the hero (its height varies / wraps on mobile). */}
      <div className="relative z-20" style={{ paddingTop: '56px' }}>
        <BridgeFaucetBanner />
      </div>

      {/* Content */}
      <div className="relative z-10 mx-auto w-full max-w-5xl px-4 sm:px-6" style={{ paddingTop: '32px', paddingBottom: '96px' }}>
        {/* Hero */}
        <div className="text-center mb-8 sm:mb-10">
          <h1 className="text-display" style={{ fontSize: 'clamp(30px, 5vw, 40px)', color: 'hsl(var(--foreground))' }}>
            Bridge <em className="text-serif">&amp;</em> Stake
          </h1>
          <p
            className="mx-auto"
            style={{ fontSize: 13.5, color: 'hsl(var(--muted-foreground))', marginTop: 8, lineHeight: 1.65, maxWidth: 520 }}
          >
            Move NAVE between Solana and Ethereum / Base in a single signature — a{' '}
            <strong style={{ color: 'hsl(var(--foreground))' }}>{(NAVE_BRIDGE_FEE_BPS / 100).toFixed(2)}%</strong>{' '}
            fee is added on top of every transfer, and stakers earn a share of every fee.
          </p>
        </div>

        {/* Stats strip */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-8">
          <StatTile
            label="Total bridged"
            value={wrappedOutstandingRaw !== null ? formatNaveCompact(wrappedOutstandingRaw) : '0'}
            suffix="wNAVE"
            icon="right-left"
            breakdown={bridgedBreakdown.length > 0 ? bridgedBreakdown : undefined}
            breakdownNote="NAVE actively living on other chains right now: each chain's wNAVE supply (all mints minus all burns). Bridging back to Solana burns wNAVE and reduces this."
            loading={loading && wrappedOutstandingRaw === null}
          />
          <StatTile
            label="Total Volume"
            value={
              volumeUsd !== null
                ? formatUsd(volumeUsd)
                : stats
                  ? formatNaveCompact(stats.totalBridgedRaw)
                  : '0'
            }
            suffix={volumeUsd !== null ? 'USD' : 'NAVE'}
            icon="arrows-turn-right"
            breakdown={volumeBreakdown}
            breakdownNote="All-time bridge turnover (every completed transfer's net amount) valued at the current NAVE price from CoinGecko."
            loading={loading && !stats}
          />
          <StatTile
            label="Total staked"
            value={totalStakedRaw !== null ? formatNaveCompact(totalStakedRaw) : '0'}
            suffix="NAVE"
            icon="layer-group"
            breakdown={stakedBreakdown}
            breakdownNote={stakedBreakdownNote}
            loading={loading && totalStakedRaw === null}
          />
          <StatTile
            label="Reward pool"
            value={rewardPoolRaw !== null ? formatNaveCompact(rewardPoolRaw) : '0'}
            suffix="NAVE"
            icon="coins"
            breakdown={rewardBreakdown}
            breakdownNote="Undistributed rewards on Solana: the staking reward vault plus the claim reserve that funds EVM reward claims. Claiming on any chain draws this down."
            loading={loading && rewardPoolRaw === null}
          />
        </div>

        {/* Bridge + Stake — right column stretches so CA card sits on the
            same bottom edge as the bridge card. */}
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-5 items-stretch">
          <div className="lg:col-span-3 flex flex-col">
            <Bridge />
          </div>
          <div className="lg:col-span-2 flex flex-col gap-5 min-h-0">
            <StakeBox pool={pool} apy={apy} />
            <div className="mt-auto">
              <BridgeContractAddresses />
            </div>
          </div>
        </div>

        {/* Your Transactions — bridges, stakes, unstakes, and claims; the
            in-flight bridge attempt and any in-flight claim surface live. */}
        <TransactionsFeed
          history={history}
          activity={activity}
          loading={loading}
          anyWalletConnected={anyWalletConnected}
          bothWallets={!!publicKey && !!evmAddress}
        />
      </div>
    </div>
    </BridgeProvider>
  );
}
