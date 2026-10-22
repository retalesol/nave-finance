import { useState, useEffect } from 'react';
import { PublicKey } from '@solana/web3.js';
import { useWallet } from '@solana/wallet-adapter-react';
import Fi from '../Fi';
import { Section, Notice } from '../calm';
import { useSendTransaction } from '../../hooks/useSendTransaction';
import { useChain } from '../../hooks/useChain';
import { buildSetReviewWindowEvm } from '../../lib/evm/writers';
import { fetchPendingReviewWindowEvm, type PendingReviewWindowEvm } from '../../lib/evm/readers';
import { buildSetReviewWindow } from '../../lib/transactionBuilders';
import { useConstitution } from '../../hooks/useConstitution';
import {
  MAX_REVIEW_WINDOW_SECONDS,
  SOLANA_NETWORK,
  EVM_DEPLOYMENT_MODE,
} from '../../lib/programConfig';
import {
  actionDelayContextFrom,
  defaultReviewWindowFallback,
  reviewWindowMinSeconds,
  reviewWindowPresets,
} from '../../lib/actionDelays';
import { isMockDaoAddress } from '../../lib/mockData';

const REVIEW_WINDOW_MAX_SECS = MAX_REVIEW_WINDOW_SECONDS;

export function ReviewWindowCustomHours({
  target,
  setTarget,
  minSecs,
  maxSecs,
}: {
  target: number;
  setTarget: (secs: number) => void;
  minSecs: number;
  maxSecs: number;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 mb-2 hover:underline underline-offset-4"
        style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))' }}
      >
        <Fi icon={open ? 'chevron-up' : 'chevron-down'} style={{ fontSize: '10px' }} />
        Advanced — custom hours
      </button>
      {open && (
        <input
          type="number"
          min={minSecs / 3600}
          max={maxSecs / 3600}
          step="0.25"
          value={Number((target / 3600).toFixed(2))}
          onChange={(e) => {
            const hours = parseFloat(e.target.value);
            if (!Number.isNaN(hours)) setTarget(Math.round(hours * 3600));
          }}
          className="w-full max-w-[200px] px-3 py-2.5 rounded-[10px] border outline-none"
          style={{
            fontSize: '13.5px',
            backgroundColor: '#ffffff',
            borderColor: 'hsl(var(--border))',
            color: 'hsl(var(--foreground))',
          }}
        />
      )}
    </div>
  );
}

export function formatDuration(secs: number): string {
  if (secs % 86400 === 0) return `${secs / 86400} day${secs / 86400 === 1 ? '' : 's'}`;
  if (secs % 3600 === 0) return `${secs / 3600} hour${secs / 3600 === 1 ? '' : 's'}`;
  if (secs % 60 === 0) return `${secs / 60} min`;
  return `${secs}s`;
}

export default function ReviewWindowSection({ daoAddress }: { daoAddress: string | null }) {
  const { publicKey } = useWallet();
  const { chainKind, evmChainId } = useChain();
  const tx = useSendTransaction();
  const { constitution, refetch } = useConstitution(daoAddress);
  const delayCtx = actionDelayContextFrom({
    chainKind,
    evmChainId,
    solanaNetwork: SOLANA_NETWORK,
    evmDeploymentMode: EVM_DEPLOYMENT_MODE,
  });
  const reviewPresets = reviewWindowPresets(delayCtx);
  const current = constitution?.reviewWindowSecs ?? defaultReviewWindowFallback(delayCtx);
  const [target, setTarget] = useState<number>(current);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pendingEvm, setPendingEvm] = useState<PendingReviewWindowEvm | null>(null);
  const REVIEW_WINDOW_MIN_SECS = reviewWindowMinSeconds(chainKind, delayCtx);

  useEffect(() => {
    setTarget(current);
  }, [current]);

  // EVM: reductions are queued until the current window elapses — surface the
  // pending value so the founder isn't confused by an unchanged getter.
  useEffect(() => {
    let cancelled = false;
    if (chainKind !== 'evm' || !evmChainId || !daoAddress || isMockDaoAddress(daoAddress)) {
      setPendingEvm(null);
      return;
    }
    fetchPendingReviewWindowEvm(evmChainId, daoAddress)
      .then((p) => { if (!cancelled) setPendingEvm(p); })
      .catch(() => { if (!cancelled) setPendingEvm(null); });
    return () => { cancelled = true; };
  }, [chainKind, evmChainId, daoAddress, current, done]);

  async function handleSave() {
    setError(null);
    setDone(false);
    if (target < REVIEW_WINDOW_MIN_SECS || target > REVIEW_WINDOW_MAX_SECS) {
      setError(`Review window must be between ${formatDuration(REVIEW_WINDOW_MIN_SECS)} and ${formatDuration(REVIEW_WINDOW_MAX_SECS)}.`);
      return;
    }
    // ── EVM: NaveTreasury.setReviewWindow(int64 secs) (founder-gated) ──
    if (chainKind === 'evm') {
      if (!daoAddress) { setError('Select a treasury before updating the review window.'); return; }
      if (!evmChainId) { setError('Select an Ethereum or Base network.'); return; }
      const evmResult = await tx.sendEvm(
        buildSetReviewWindowEvm(evmChainId, daoAddress, target),
        { successLabel: 'Review window updated', quietMock: true },
      );
      if (evmResult.status === 'success' || evmResult.status === 'mock') {
        setDone(true);
        refetch();
      } else if (evmResult.status === 'error') {
        setError(evmResult.error);
      }
      return;
    }
    if (!publicKey || !daoAddress) {
      setError('Connect your wallet to update the review window.');
      return;
    }

    try {
      const result = await tx.send(
        await buildSetReviewWindow(new PublicKey(daoAddress), publicKey, target),
        { successLabel: 'Review window updated', quietMock: true },
      );
      if (result.status === 'success' || result.status === 'mock') {
        setDone(true);
        refetch();
      } else if (result.status === 'error') {
        setError(result.error);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update review window.');
    }
  }

  const busy = tx.status === 'signing' || tx.status === 'confirming';

  return (
    <Section
      title="Oversight review window"
      hint={`Currently ${formatDuration(current)} before approved strategies execute`}
    >
      <div className="space-y-4">
        <p style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.55, margin: 0 }}>
          After agents approve a strategy, this pause lets your trusted wallets stop it before it runs.
          {chainKind === 'evm' && ' Shortening the pause takes effect only after the current window ends.'}
        </p>

        {pendingEvm && (
          <Notice tone="brass">
            <span style={{ fontSize: '13px' }}>
              Pending change: the review window will become <strong>{formatDuration(pendingEvm.secs)}</strong>
              {pendingEvm.effectiveAt > 0 && ` on ${new Date(pendingEvm.effectiveAt * 1000).toLocaleString()}`}.
              Until then, {formatDuration(current)} still applies.
            </span>
          </Notice>
        )}

        <div>
          <div className="nave-label mb-2">Set window to</div>
          <div className="flex flex-wrap gap-2">
            {reviewPresets.map(p => {
              const sel = target === p.secs;
              return (
                <button
                  key={p.secs}
                  type="button"
                  onClick={() => setTarget(p.secs)}
                  className="px-3.5 py-2 rounded-full border transition-all"
                  style={{
                    fontSize: '13px',
                    fontWeight: sel ? 600 : 400,
                    backgroundColor: sel ? 'hsl(var(--foreground))' : '#ffffff',
                    borderColor: sel ? 'hsl(var(--foreground))' : 'hsl(var(--border))',
                    color: sel ? '#ffffff' : 'hsl(var(--foreground))',
                  }}
                >
                  {p.label}
                </button>
              );
            })}
          </div>
        </div>

        <ReviewWindowCustomHours
          target={target}
          setTarget={setTarget}
          minSecs={REVIEW_WINDOW_MIN_SECS}
          maxSecs={REVIEW_WINDOW_MAX_SECS}
        />

        {error && (
          <div
            className="flex items-center gap-2 py-1"
            style={{ color: 'hsl(var(--destructive))', fontSize: '12.5px' }}
          >
            <Fi icon="circle-xmark" style={{ fontSize: '13px' }} />
            <span className="flex-1">{error}</span>
            <button onClick={() => setError(null)} style={{ fontSize: '11.5px', textDecoration: 'underline' }}>dismiss</button>
          </div>
        )}

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleSave}
            disabled={busy || target === current}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-[9px] font-semibold transition-all"
            style={{
              fontSize: '13px',
              backgroundColor: 'hsl(var(--foreground))',
              color: '#ffffff',
              opacity: busy || target === current ? 0.45 : 1,
              cursor: busy || target === current ? 'not-allowed' : 'pointer',
            }}
          >
            {busy ? 'Submitting…' : target === current ? 'No change' : `Set to ${formatDuration(target)}`}
          </button>
          {done && (
            <span style={{ fontSize: '13px', color: 'hsl(var(--success))', fontWeight: 500 }}>
              Updated ✓
            </span>
          )}
        </div>
      </div>
    </Section>
  );
}
