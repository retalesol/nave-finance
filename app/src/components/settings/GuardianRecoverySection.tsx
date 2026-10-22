import { useState, useEffect, useCallback } from 'react';
import { Section, Notice } from '../calm';
import { useSendTransaction } from '../../hooks/useSendTransaction';
import { useChain } from '../../hooks/useChain';
import { isEvmAddress } from '../../lib/chain/types';
import {
  buildQueueGuardianRecoveryEvm,
  buildExecuteGuardianRecoveryEvm,
  buildCancelGuardianRecoveryEvm,
} from '../../lib/evm/writers';
import { fetchGuardianRecoveryPendingEvm } from '../../lib/evm/readers';

export default function GuardianRecoverySection({
  daoAddress,
  frozen,
}: {
  daoAddress: string | null;
  frozen: boolean;
}) {
  const { evmChainId } = useChain();
  const tx = useSendTransaction();
  const [walletsText, setWalletsText] = useState('');
  const [threshold, setThreshold] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{
    executableAt: bigint;
    pendingThreshold: number;
    pendingWalletCount: number;
  } | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!daoAddress || !evmChainId) {
      setPending(null);
      return;
    }
    const row = await fetchGuardianRecoveryPendingEvm(evmChainId, daoAddress);
    setPending(row && row.executableAt > 0n ? row : null);
  }, [daoAddress, evmChainId]);

  useEffect(() => {
    void refresh();
  }, [refresh, frozen]);

  if (!frozen || !daoAddress || !evmChainId) return null;

  function parseWallets(): string[] | null {
    const lines = walletsText
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (lines.length === 0) {
      setError('Enter at least one replacement guardian address.');
      return null;
    }
    const bad = lines.filter((a) => !isEvmAddress(a));
    if (bad.length) {
      setError(`Invalid address: ${bad[0]}`);
      return null;
    }
    if (threshold < 1 || threshold > lines.length) {
      setError(`Threshold must be between 1 and ${lines.length}.`);
      return null;
    }
    return lines;
  }

  async function run(action: 'queue' | 'execute' | 'cancel') {
    if (!daoAddress || !evmChainId) return;
    setError(null);
    setLoading(true);
    try {
      let built;
      if (action === 'queue') {
        const wallets = parseWallets();
        if (!wallets) return;
        built = buildQueueGuardianRecoveryEvm(evmChainId, daoAddress, wallets, threshold);
      } else if (action === 'execute') {
        built = buildExecuteGuardianRecoveryEvm(evmChainId, daoAddress);
      } else {
        built = buildCancelGuardianRecoveryEvm(evmChainId, daoAddress);
      }
      const outcome = await tx.sendEvm(built, {
        successLabel:
          action === 'queue'
            ? 'Guardian recovery queued'
            : action === 'execute'
              ? 'Guardian recovery executed'
              : 'Guardian recovery cancelled',
        quietMock: true,
      });
      if (outcome.status === 'error') setError(outcome.error);
      else await refresh();
    } finally {
      setLoading(false);
    }
  }

  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const canExecute = pending != null && pending.executableAt > 0n && pending.executableAt <= nowSec;

  return (
    <Section
      title="Guardian recovery"
      hint="Frozen escape hatch — queue a replacement set with timelock"
    >
      <p style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.55, marginBottom: '14px' }}>
        While frozen, the founder can queue a new guardian set. After the timelock, execute to replace
        guardians (DAO stays frozen until the new set unfreezes). Honest guardians can veto via M-of-N.
      </p>
      {pending && (
        <Notice tone="brass" className="mb-3">
          <span style={{ fontSize: '13px' }}>
            Pending recovery: {pending.pendingWalletCount} wallet(s), threshold {pending.pendingThreshold}.{' '}
            Executable at unix {pending.executableAt.toString()}
            {canExecute ? ' — ready now.' : ' — waiting on timelock.'}
          </span>
        </Notice>
      )}
      <div className="mb-3">
        <label className="block mb-1.5" style={{ fontSize: '12.5px', fontWeight: 600 }}>
          Replacement guardian addresses
        </label>
        <textarea
          value={walletsText}
          onChange={(e) => setWalletsText(e.target.value)}
          placeholder="Replacement guardian addresses (one per line)…"
          rows={3}
          className="w-full px-3 py-2.5 rounded-[10px] border outline-none"
          style={{
            fontSize: '13px',
            fontFamily: 'var(--font-mono)',
            backgroundColor: '#ffffff',
            borderColor: 'hsl(var(--border))',
            color: 'hsl(var(--foreground))',
          }}
        />
      </div>
      <div className="flex items-center gap-3 mb-4">
        <label style={{ fontSize: '12.5px', fontWeight: 600 }}>Threshold</label>
        <input
          type="number"
          min={1}
          value={threshold}
          onChange={(e) => setThreshold(Math.max(1, Number(e.target.value) || 1))}
          className="w-20 px-2.5 py-1.5 rounded-[10px] border outline-none"
          style={{
            fontSize: '13px',
            fontFamily: 'var(--font-mono)',
            backgroundColor: '#ffffff',
            borderColor: 'hsl(var(--border))',
            color: 'hsl(var(--foreground))',
          }}
        />
      </div>
      {error && (
        <div className="mb-3" style={{ fontSize: '12.5px', color: 'hsl(var(--destructive))' }}>{error}</div>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={loading}
          onClick={() => void run('queue')}
          className="px-3.5 py-2 rounded-[9px] font-semibold"
          style={{ fontSize: '13px', backgroundColor: 'hsl(var(--foreground))', color: '#ffffff', opacity: loading ? 0.6 : 1 }}
        >
          Queue recovery
        </button>
        <button
          type="button"
          disabled={loading || !canExecute}
          onClick={() => void run('execute')}
          className="px-3.5 py-2 rounded-[9px] font-semibold border"
          style={{ fontSize: '13px', backgroundColor: '#ffffff', borderColor: 'hsl(var(--border))', color: 'hsl(var(--foreground))', opacity: loading || !canExecute ? 0.5 : 1 }}
        >
          Execute recovery
        </button>
        <button
          type="button"
          disabled={loading || !pending}
          onClick={() => void run('cancel')}
          className="px-3 py-2 rounded-[9px] font-medium"
          style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))', opacity: loading || !pending ? 0.5 : 1 }}
        >
          Cancel
        </button>
      </div>
    </Section>
  );
}
