import { useState, useEffect, useMemo } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useAccount } from 'wagmi';
import { formatUnits } from 'viem';
import { useBridgeStats, type BridgeHistoryRow } from '../hooks/useBridgeStats';
import { BridgeProvider, useBridge, type BridgeAttempt } from '../hooks/useBridge';
import { isConfirmationWaitError } from '../lib/bridge/confirmations';
import { evmTarget } from '../lib/chain/types';
import {
  ACTIVITY_EVENT,
  activityStatusLabel,
  isActivityInFlight,
  mergeActivity,
  readLocalActivity,
  type ActivityEntry,
} from '../lib/staking/activityFeed';
import {
  EVM_DEPLOYMENT_MODE,
  NAVE_DECIMALS,
  SOLANA_NETWORK,
} from '../lib/programConfig';
import Fi from '../components/Fi';
import { Section } from '../components/calm';
import { RowSkeleton } from '../components/NaveSkeletons';
import StakeBox from '../components/StakeBox';
import BridgeContractAddresses from '../components/BridgeContractAddresses';
import Bridge from './Bridge';

/* ── Formatting helpers ───────────────────────────────────────── */

function formatNave(raw: bigint): string {
  const s = formatUnits(raw, NAVE_DECIMALS);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

function shortHash(value: string): string {
  return value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
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
    return `${testnet ? 'https://explorer.testnet.chain.robinhood.com' : 'https://robinhoodchain.blockscout.com'}/tx/${tx}`;
  }
  if (s.includes('base')) {
    return `${testnet ? 'https://sepolia.basescan.org' : 'https://basescan.org'}/tx/${tx}`;
  }
  return `${testnet ? 'https://sepolia.etherscan.io' : 'https://etherscan.io'}/tx/${tx}`;
}

function statusDotColor(status: string): string {
  if (status === 'completed') return 'hsl(var(--success))';
  if (status === 'failed') return 'hsl(var(--destructive))';
  return 'hsl(var(--brass))';
}

/* ── Transfer history hairline rows ───────────────────────────── */

function HistoryRow({ row }: { row: BridgeHistoryRow }) {
  const net = row.netRaw ?? row.amountRaw;
  const date = new Date(row.createdAt);
  const dotColor = statusDotColor(row.status);

  return (
    <div
      className="flex items-start gap-3 py-3.5"
      style={{ borderBottom: '1px solid hsl(var(--surface-2))' }}
    >
      <span
        style={{
          width: '7px',
          height: '7px',
          borderRadius: '50%',
          backgroundColor: dotColor,
          marginTop: '7px',
          flexShrink: 0,
        }}
      />
      <div className="flex-1 min-w-0">
        <div
          className="flex items-center gap-2 flex-wrap"
          style={{ fontSize: '14px', fontWeight: 500, color: 'hsl(var(--foreground))' }}
        >
          <span>
            {chainLabel(row.sourceChain)} → {chainLabel(row.destChain)}
          </span>
          <span className="nave-mono" style={{ fontSize: '13px', fontWeight: 600 }}>
            · {formatNave(net)} NAVE
          </span>
        </div>
        <div
          className="flex items-center gap-3 flex-wrap mt-1"
          style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))' }}
        >
          <a
            href={explorerTx(row.sourceChain, row.sourceTx)}
            target="_blank"
            rel="noopener noreferrer"
            className="nave-mono hover:underline underline-offset-4"
            style={{ color: 'hsl(var(--muted-foreground))' }}
            title={`Source: ${row.sourceTx}`}
          >
            {shortHash(row.sourceTx)} ↗
          </a>
          {row.destTx && (
            <a
              href={explorerTx(row.destChain, row.destTx)}
              target="_blank"
              rel="noopener noreferrer"
              className="nave-mono hover:underline underline-offset-4"
              style={{ color: 'hsl(var(--muted-foreground))' }}
              title={`Destination: ${row.destTx}`}
            >
              {shortHash(row.destTx)} ↗
            </a>
          )}
        </div>
      </div>

      <div className="flex items-center gap-3 ml-auto flex-shrink-0 pt-0.5">
        <span
          style={{
            fontSize: '12px',
            fontWeight: 600,
            color:
              row.status === 'completed'
                ? 'hsl(var(--success))'
                : row.status === 'failed'
                  ? 'hsl(var(--destructive))'
                  : 'hsl(var(--muted-foreground))',
          }}
        >
          {row.status === 'completed' ? 'Completed ✓' : row.status}
        </span>
        <span className="nave-mono" style={{ fontSize: '12px', color: 'hsl(var(--faint))' }}>
          {date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
        </span>
      </div>
    </div>
  );
}

function attemptChains(attempt: BridgeAttempt): { sourceChain: string; destChain: string } {
  const evmFamily = evmTarget(attempt.evmChainId).family;
  return attempt.direction === 'solana_to_evm'
    ? { sourceChain: 'solana', destChain: evmFamily }
    : { sourceChain: evmFamily, destChain: 'solana' };
}

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
  if (r.status === 'completed') return 'Completed ✓';
  if (r.status === 'failed') return 'Failed';
  return r.status;
}

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
  const label = liveStatusLabel(attempt);
  const dotColor = statusDotColor(r.status);
  const showRetry = r.status === 'failed' && !isConfirmationWaitError(r.error);

  return (
    <div
      className="flex items-start gap-3 py-3.5"
      style={{ borderBottom: '1px solid hsl(var(--surface-2))' }}
      role="status"
      aria-live="polite"
    >
      <span
        style={{
          width: '7px',
          height: '7px',
          borderRadius: '50%',
          backgroundColor: dotColor,
          marginTop: '7px',
          flexShrink: 0,
        }}
      />
      <div className="flex-1 min-w-0">
        <div
          className="flex items-center gap-2 flex-wrap"
          style={{ fontSize: '14px', fontWeight: 500, color: 'hsl(var(--foreground))' }}
        >
          <span>
            {chainLabel(sourceChain)} → {chainLabel(destChain)}
          </span>
          <span className="nave-mono" style={{ fontSize: '13px', fontWeight: 600 }}>
            · {formatNave(BigInt(attempt.amountRaw))} NAVE
          </span>
        </div>
        <div
          className="flex items-center gap-3 flex-wrap mt-1"
          style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))' }}
        >
          <a
            href={explorerTx(sourceChain, attempt.sourceTx)}
            target="_blank"
            rel="noopener noreferrer"
            className="nave-mono hover:underline underline-offset-4"
            style={{ color: 'hsl(var(--muted-foreground))' }}
          >
            {shortHash(attempt.sourceTx)} ↗
          </a>
          {r.destTxHash && (
            <a
              href={explorerTx(destChain, r.destTxHash)}
              target="_blank"
              rel="noopener noreferrer"
              className="nave-mono hover:underline underline-offset-4"
              style={{ color: 'hsl(var(--muted-foreground))' }}
            >
              {shortHash(r.destTxHash)} ↗
            </a>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2.5 ml-auto flex-shrink-0 pt-0.5">
        <span style={{ fontSize: '12px', fontWeight: 600, color: dotColor }}>{label}</span>
        {showRetry && (
          <button
            type="button"
            onClick={onRetry}
            disabled={retrying}
            className="px-2.5 py-1 rounded-[7px] border font-semibold"
            style={{
              fontSize: '11.5px',
              backgroundColor: '#ffffff',
              borderColor: 'hsl(var(--border))',
              color: 'hsl(var(--foreground))',
            }}
          >
            {retrying ? 'Retrying…' : 'Retry'}
          </button>
        )}
        <span className="nave-mono" style={{ fontSize: '12px', color: 'hsl(var(--faint))' }}>
          Now
        </span>
      </div>
    </div>
  );
}

function ActivityRow({ entry }: { entry: ActivityEntry }) {
  const chainName = chainLabel(entry.chainFamily);
  const inFlight = isActivityInFlight(entry);
  const label = activityStatusLabel(entry, chainName);
  const dotColor = statusDotColor(inFlight ? 'pending' : entry.status);
  const date = new Date(entry.createdAt);
  const kindLabel = entry.kind === 'claim' ? 'Claimed rewards' : entry.kind === 'stake' ? 'Staked' : 'Unstaked';
  const amountText =
    entry.amountRaw != null
      ? `${formatNave(BigInt(entry.amountRaw))} ${entry.chainFamily === 'solana' ? 'NAVE' : 'wNAVE'}`
      : '';

  return (
    <div
      className="flex items-start gap-3 py-3.5"
      style={{ borderBottom: '1px solid hsl(var(--surface-2))' }}
      role={inFlight ? 'status' : undefined}
      aria-live={inFlight ? 'polite' : undefined}
    >
      <span
        style={{
          width: '7px',
          height: '7px',
          borderRadius: '50%',
          backgroundColor: dotColor,
          marginTop: '7px',
          flexShrink: 0,
        }}
      />
      <div className="flex-1 min-w-0">
        <div
          className="flex items-center gap-2 flex-wrap"
          style={{ fontSize: '14px', fontWeight: 500, color: 'hsl(var(--foreground))' }}
        >
          <span>
            {kindLabel} on {chainName}
          </span>
          {amountText && (
            <span className="nave-mono" style={{ fontSize: '13px', fontWeight: 600 }}>
              · {amountText}
            </span>
          )}
        </div>
        {(entry.wrapTx || entry.tx) && (
          <div
            className="flex items-center gap-3 flex-wrap mt-1"
            style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))' }}
          >
            {entry.wrapTx && (
              <a
                href={explorerTx('solana', entry.wrapTx)}
                target="_blank"
                rel="noopener noreferrer"
                className="nave-mono hover:underline underline-offset-4"
                style={{ color: 'hsl(var(--muted-foreground))' }}
              >
                {shortHash(entry.wrapTx)} ↗
              </a>
            )}
            {entry.tx && (
              <a
                href={explorerTx(entry.chainFamily, entry.tx)}
                target="_blank"
                rel="noopener noreferrer"
                className="nave-mono hover:underline underline-offset-4"
                style={{ color: 'hsl(var(--muted-foreground))' }}
              >
                {shortHash(entry.tx)} ↗
              </a>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center gap-2.5 ml-auto flex-shrink-0 pt-0.5">
        {inFlight && (
          <Fi icon="spinner" className="animate-spin" style={{ fontSize: 10, color: 'hsl(var(--muted-foreground))' }} />
        )}
        <span
          style={{
            fontSize: '12px',
            fontWeight: 600,
            color:
              !inFlight && entry.status === 'completed'
                ? 'hsl(var(--success))'
                : entry.status === 'failed'
                  ? 'hsl(var(--destructive))'
                  : 'hsl(var(--muted-foreground))',
          }}
          title={entry.error}
        >
          {!inFlight && entry.status === 'completed' ? 'Completed ✓' : label}
        </span>
        <span className="nave-mono" style={{ fontSize: '12px', color: 'hsl(var(--faint))' }}>
          {date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
        </span>
      </div>
    </div>
  );
}

function TransactionsFeed({
  mode,
  history,
  activity,
  loading,
}: {
  mode: 'bridge' | 'stake';
  history: BridgeHistoryRow[];
  activity: ActivityEntry[];
  loading: boolean;
}) {
  const { lastAttempt, retryRelay, isBridging } = useBridge();
  const { publicKey } = useWallet();
  const { address: evmAddress } = useAccount();

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
    void localVersion;
    return mergeActivity(readLocalActivity([publicKey?.toBase58(), evmAddress]), activity);
  }, [publicKey, evmAddress, activity, localVersion]);

  const dbHasAttempt =
    !!lastAttempt && history.some((row) => row.sourceTx === lastAttempt.sourceTx);
  const liveAttempt = mode === 'bridge' && lastAttempt && !dbHasAttempt ? lastAttempt : null;

  const sortedBridge = useMemo(
    () => [...history].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [history],
  );
  const sortedActivity = useMemo(
    () => [...merged].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [merged],
  );

  const hasRows = mode === 'bridge' ? Boolean(liveAttempt || sortedBridge.length > 0) : sortedActivity.length > 0;

  return (
    <Section
      title={mode === 'bridge' ? 'Recent transfers' : 'Staking activity'}
      hint={mode === 'bridge' ? 'Cross-network bridge transfers' : 'Stakes, unstakes & reward claims'}
      className="max-w-[620px]"
    >
      {loading && !hasRows ? (
        <div className="space-y-1">
          <RowSkeleton cols={3} />
          <RowSkeleton cols={3} />
        </div>
      ) : !hasRows ? (
        <p style={{ fontSize: '13.5px', color: 'hsl(var(--muted-foreground))', margin: 0 }}>
          {mode === 'bridge'
            ? 'No bridge transfers yet. Transfers you initiate will appear here.'
            : 'No staking activity yet. Stakes, unstakes, and reward claims will appear here.'}
        </p>
      ) : (
        <div style={{ borderTop: '1px solid hsl(var(--surface-2))' }}>
          {mode === 'bridge' ? (
            <>
              {liveAttempt && (
                <LiveTransferRow
                  attempt={liveAttempt}
                  onRetry={() => void retryRelay()}
                  retrying={isBridging}
                />
              )}
              {sortedBridge.map((row) => (
                <HistoryRow key={`b-${row.id}`} row={row} />
              ))}
            </>
          ) : (
            sortedActivity.map((entry) => <ActivityRow key={`a-${entry.id}`} entry={entry} />)
          )}
        </div>
      )}
    </Section>
  );
}

/* ── Page ─────────────────────────────────────────────────────── */

export default function BridgePage({ mode = 'bridge' }: { mode?: 'bridge' | 'stake' }) {
  const {
    pool,
    apy,
    history,
    activity,
    loading,
  } = useBridgeStats();

  const isStake = mode === 'stake';

  return (
    <BridgeProvider>
      <div className="animate-fade-in" data-onboarding-id={isStake ? 'stake-root' : 'bridge-root'}>
        {/* Header */}
        <div>
          <div className="nave-label" style={{ marginBottom: '10px' }}>
            {isStake ? 'Stake' : 'Bridge'}
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
            {isStake ? (
              <>
                Put your tokens <em style={{ fontStyle: 'italic', color: 'hsl(var(--muted-foreground))' }}>to work.</em>
              </>
            ) : (
              <>
                Move money in,{' '}
                <em style={{ fontStyle: 'italic', color: 'hsl(var(--muted-foreground))' }}>across networks.</em>
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
            {isStake
              ? 'Stake NAVE to earn protocol rewards. Unstake or claim any time.'
              : 'Bring assets from another network into your treasury. Quotes update as you type.'}
          </p>
        </div>

        {/* Main hairline section */}
        <div data-onboarding-id={isStake ? 'stake-form' : 'bridge-form'}>
        <Section className="max-w-[620px]">
          {isStake ? <StakeBox pool={pool} apy={apy} /> : <Bridge />}
        </Section>
        </div>

        {/* Recent transfers / Staking activity */}
        <TransactionsFeed
          mode={mode}
          history={history}
          activity={activity}
          loading={loading}
        />

        {/* Quiet Contract addresses disclosure */}
        {!isStake && (
          <details
            className="max-w-[620px]"
            style={{
              marginTop: '30px',
              borderTop: '1px solid hsl(var(--border))',
              paddingTop: '18px',
            }}
          >
            <summary
              style={{
                fontSize: '13px',
                fontWeight: 500,
                color: 'hsl(var(--muted-foreground))',
                cursor: 'pointer',
                userSelect: 'none',
              }}
            >
              Contract addresses
            </summary>
            <div className="pt-4">
              <BridgeContractAddresses />
            </div>
          </details>
        )}
      </div>
    </BridgeProvider>
  );
}
