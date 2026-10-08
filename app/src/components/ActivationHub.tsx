import { useMemo, useState } from 'react';
import { PublicKey } from '@solana/web3.js';
import { useWallet } from '@solana/wallet-adapter-react';
import { useAccount } from 'wagmi';
import { isAddress } from 'viem';
import Fi from './Fi';
import { useDaoContext } from '../hooks/useDaoContext';
import { useDaoRegistry } from '../hooks/useDaoRegistry';
import { useTreasuryBalance } from '../hooks/useTreasuryBalance';
import { useGuardianConfig } from '../hooks/useGuardianConfig';
import { useDaoMembership } from '../hooks/useDaoMembership';
import { useSendTransaction } from '../hooks/useSendTransaction';
import { useChain } from '../hooks/useChain';
import { buildUpdateGuardianConfig } from '../lib/transactionBuilders';
import { buildUpdateGuardianConfigEvm } from '../lib/evm/writers';
import { defaultGuardianThreshold } from '../lib/programConfig';
import { isEvmAddress } from '../lib/chain/types';
import { isMockDaoAddress } from '../lib/mockData';

const DISMISS_KEY = 'nave_activation_checklist_dismissed';

interface ActivationHubProps {
  onOpenDeposit?: () => void;
  onSignerComplete?: () => void;
}

function SignerSetupPanel({ daoAddress, onComplete }: { daoAddress: string; onComplete: () => void }) {
  const { publicKey } = useWallet();
  const { address: evmAddress } = useAccount();
  const { chainKind, evmChainId } = useChain();
  const tx = useSendTransaction();
  const connectedWallet = chainKind === 'evm' ? (evmAddress ?? '') : (publicKey?.toBase58() ?? '');
  const [trustedWallets, setTrustedWallets] = useState<string[]>([]);
  const [input, setInput] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [thresholdOverride, setThresholdOverride] = useState<number | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const signers = useMemo(() => {
    const extras = trustedWallets.filter((w) =>
      connectedWallet ? w.toLowerCase() !== connectedWallet.toLowerCase() : true,
    );
    return connectedWallet ? [connectedWallet, ...extras] : extras;
  }, [connectedWallet, trustedWallets]);

  const threshold = thresholdOverride ?? defaultGuardianThreshold(signers.length);

  function addTrustedWallet() {
    const addr = input.trim();
    if (!addr || signers.length >= 3) return;
    const isEvm = chainKind === 'evm';
    if (signers.some((s) => (isEvm ? s.toLowerCase() === addr.toLowerCase() : s === addr))) return;
    if (isEvm) {
      if (!isAddress(addr) && !isEvmAddress(addr)) {
        setSubmitError('That does not look like a valid wallet address.');
        return;
      }
    } else {
      try {
        new PublicKey(addr);
      } catch {
        setSubmitError('That does not look like a valid wallet address.');
        return;
      }
    }
    setSubmitError(null);
    setTrustedWallets((prev) => [...prev, addr]);
    setInput('');
    setThresholdOverride(null);
  }

  function removeTrustedWallet(addr: string) {
    setTrustedWallets((prev) => prev.filter((s) => s !== addr));
    setThresholdOverride(null);
  }

  async function handleConfirm() {
    if (signers.length < 1) {
      setSubmitError('Connect your wallet to finish setup.');
      return;
    }
    if (threshold < 1 || threshold > signers.length) {
      setSubmitError('Choose how many approvals are required.');
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      if (chainKind === 'evm') {
        if (!evmChainId) {
          setSubmitError('Select Ethereum, Base, or Robinhood first.');
          return;
        }
        const outcome = await tx.sendEvm(
          buildUpdateGuardianConfigEvm(evmChainId, daoAddress, signers, threshold),
          { successLabel: 'Trusted wallets saved' },
        );
        if (outcome.status === 'success' || outcome.status === 'mock') {
          setConfirmed(true);
          setTimeout(onComplete, 1200);
        } else {
          setSubmitError(outcome.error || 'Could not save trusted wallets.');
        }
        return;
      }
      if (!publicKey) {
        setSubmitError('Connect your wallet to finish setup.');
        return;
      }
      const daoPubkey = new PublicKey(daoAddress);
      const guardianPubkeys = signers.map((s) => new PublicKey(s));
      const result = await buildUpdateGuardianConfig(daoPubkey, publicKey, guardianPubkeys, threshold);
      const outcome = await tx.send(result, { successLabel: 'Trusted wallets saved' });
      if (outcome.status === 'success' || outcome.status === 'mock') {
        setConfirmed(true);
        setTimeout(onComplete, 1200);
      } else {
        setSubmitError(outcome.error || 'Could not save trusted wallets.');
      }
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Could not save trusted wallets.');
    } finally {
      setSubmitting(false);
    }
  }

  const canConfirm = signers.length >= 1 && threshold >= 1 && threshold <= signers.length && !submitting;

  if (confirmed) {
    return (
      <div className="px-5 py-8 text-center">
        <Fi icon="circle-check" style={{ fontSize: '28px', color: 'hsl(var(--accent))', marginBottom: '12px', display: 'block' }} />
        <h3 className="text-display" style={{ fontSize: '18px', color: 'hsl(var(--foreground))', marginBottom: '4px' }}>
          Trusted wallets saved
        </h3>
        <p style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))' }}>
          Emergency actions now need {threshold} of {signers.length} approvals.
        </p>
      </div>
    );
  }

  return (
    <div className="px-5 py-4 space-y-5">
      <p style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.55 }}>
        Your connected wallet is already a trusted signer. Add another person only if you want shared emergency approval — otherwise confirm and continue.
      </p>

      {connectedWallet && (
        <div
          className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg"
          style={{ backgroundColor: 'hsl(var(--surface-1))', border: '1px solid hsl(var(--border))' }}
        >
          <Fi icon="shield-check" style={{ fontSize: '13px', color: 'hsl(var(--accent))', flexShrink: 0 }} />
          <div className="min-w-0">
            <div style={{ fontSize: '12px', fontWeight: 600, color: 'hsl(var(--foreground))' }}>You</div>
            <div className="nave-mono truncate" style={{ fontSize: '11.5px', color: 'hsl(var(--muted-foreground))' }}>
              {connectedWallet.slice(0, 6)}…{connectedWallet.slice(-4)}
            </div>
          </div>
        </div>
      )}

      {trustedWallets.length < 2 && (
        <div>
          <label className="nave-label" style={{ fontSize: '12px', fontWeight: '500', marginBottom: '6px', display: 'block' }}>
            Add a trusted wallet <span style={{ color: 'hsl(var(--muted-foreground))', fontWeight: 400 }}>(optional)</span>
          </label>
          <div className="flex gap-2">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Paste their wallet address…"
              className="flex-1 px-3 py-2.5 rounded-lg border outline-none transition-colors"
              style={{
                fontSize: '12.5px',
                fontFamily: 'var(--font-mono)',
                backgroundColor: 'hsl(var(--surface-0))',
                borderColor: 'hsl(var(--border))',
                color: 'hsl(var(--foreground))',
              }}
              onKeyDown={(e) => e.key === 'Enter' && addTrustedWallet()}
            />
            <button
              onClick={addTrustedWallet}
              className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg font-medium transition-all flex-shrink-0"
              style={{ fontSize: '12.5px', backgroundColor: 'hsl(var(--primary))', color: 'hsl(var(--primary-foreground))' }}
            >
              <Fi icon="plus" style={{ fontSize: '11px' }} />
              Add
            </button>
          </div>
        </div>
      )}

      {trustedWallets.length > 0 && (
        <div className="space-y-1.5">
          {trustedWallets.map((s) => (
            <div
              key={s}
              className="flex items-center justify-between px-3 py-2.5 rounded-lg"
              style={{ backgroundColor: 'hsl(var(--surface-1))', border: '1px solid hsl(var(--border))' }}
            >
              <span className="nave-mono truncate" style={{ fontSize: '12px', color: 'hsl(var(--foreground))' }}>{s}</span>
              <button onClick={() => removeTrustedWallet(s)} className="p-1 rounded transition-colors flex-shrink-0" style={{ color: 'hsl(var(--muted-foreground))' }}>
                <Fi icon="xmark" style={{ fontSize: '12px' }} />
              </button>
            </div>
          ))}
        </div>
      )}

      <button
        type="button"
        onClick={() => setShowAdvanced((v) => !v)}
        className="flex items-center gap-1.5"
        style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))' }}
      >
        <Fi icon={showAdvanced ? 'chevron-up' : 'chevron-down'} style={{ fontSize: '10px' }} />
        Advanced — approval count
      </button>
      {showAdvanced && (
        <div>
          <p style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))', marginBottom: '8px', lineHeight: 1.5 }}>
            How many of these wallets must approve an emergency freeze. Nave picks a safe default ({threshold} of {signers.length}).
          </p>
          <div className="flex gap-2">
            {Array.from({ length: Math.max(1, signers.length) }, (_, i) => i + 1).map((n) => {
              const sel = threshold === n;
              return (
                <button
                  key={n}
                  onClick={() => setThresholdOverride(n)}
                  className="flex-1 py-2.5 rounded-lg border text-center transition-all"
                  style={{
                    fontSize: '13px',
                    fontWeight: sel ? '600' : '400',
                    backgroundColor: sel ? 'hsl(var(--primary))' : 'hsl(var(--surface-0))',
                    borderColor: sel ? 'hsl(var(--primary))' : 'hsl(var(--border))',
                    color: sel ? 'white' : 'hsl(var(--foreground))',
                  }}
                >
                  {n} of {signers.length}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {submitError && (
        <p style={{ fontSize: '12px', color: 'hsl(var(--destructive))' }}>{submitError}</p>
      )}

      <button
        onClick={() => void handleConfirm()}
        disabled={!canConfirm}
        className="w-full flex items-center justify-center gap-2 py-3 rounded-xl font-medium transition-all"
        style={{
          fontSize: '14px',
          backgroundColor: canConfirm ? 'hsl(var(--primary))' : 'hsl(var(--muted))',
          color: canConfirm ? 'hsl(var(--primary-foreground))' : 'hsl(var(--muted-foreground))',
          cursor: canConfirm ? 'pointer' : 'not-allowed',
        }}
      >
        <Fi icon="shield-check" style={{ fontSize: '13px' }} />
        {submitting ? 'Saving…' : 'Confirm and continue'}
      </button>
    </div>
  );
}

/** Single prioritized activation surface — replaces stacked banners + ActivationChecklist. */
export default function ActivationHub({ onOpenDeposit, onSignerComplete }: ActivationHubProps) {
  const { daoAddress } = useDaoContext();
  const { loading: daoLoading } = useDaoRegistry(daoAddress);
  const treasuryBalance = useTreasuryBalance(daoAddress);
  const guardianConfig = useGuardianConfig(daoAddress);
  const { isFounder } = useDaoMembership();
  const isMock = isMockDaoAddress(daoAddress);

  const dismissKey = daoAddress ? `${DISMISS_KEY}_${daoAddress}` : DISMISS_KEY;
  const [dismissed, setDismissed] = useState(
    () => typeof localStorage !== 'undefined' && localStorage.getItem(dismissKey) === '1',
  );

  const needsSignerSetup =
    !isMock &&
    isFounder &&
    !guardianConfig.loading &&
    guardianConfig.walletCount === 0;

  const funded = treasuryBalance.resolved && treasuryBalance.hasBalance;
  const loading = daoLoading || treasuryBalance.loading || guardianConfig.loading;

  if (!daoAddress || isMock || dismissed) return null;
  if (!needsSignerSetup && !loading && !funded && !treasuryBalance.resolved) return null;

  function dismiss() {
    if (typeof localStorage !== 'undefined') localStorage.setItem(dismissKey, '1');
    setDismissed(true);
  }

  const watching = !needsSignerSetup && funded;
  const funding = !needsSignerSetup && treasuryBalance.resolved && !funded;

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
            {needsSignerSetup
              ? 'Add a trusted wallet'
              : loading
                ? 'Treasury'
                : watching
                  ? 'Agents are watching'
                  : 'Fund your treasury'}
          </div>
          <p style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))', marginTop: '2px', lineHeight: 1.5 }}>
            {loading
              ? 'Checking on-chain status…'
              : needsSignerSetup
                ? 'Your wallet is already included. Confirm to continue, or add one more person.'
                : watching
                  ? 'Agents are watching. They record drift and do not move capital until a check passes.'
                  : 'Next step: fund the treasury. After that, agents are watching.'}
          </p>
        </div>
        {!needsSignerSetup && (
          <button
            type="button"
            onClick={dismiss}
            className="p-1 rounded transition-colors flex-shrink-0"
            title="Dismiss"
            style={{ color: 'hsl(var(--muted-foreground))' }}
          >
            <Fi icon="xmark" style={{ fontSize: '13px' }} />
          </button>
        )}
      </div>

      {needsSignerSetup && daoAddress ? (
        <SignerSetupPanel daoAddress={daoAddress} onComplete={() => onSignerComplete?.()} />
      ) : funding ? (
        <div className="px-5 py-4">
          <button
            type="button"
            onClick={onOpenDeposit}
            disabled={!onOpenDeposit}
            className="w-full flex items-center justify-center gap-2 py-3 rounded-xl font-medium transition-all"
            style={{
              fontSize: '14px',
              backgroundColor: 'hsl(var(--primary))',
              color: 'hsl(var(--primary-foreground))',
              opacity: onOpenDeposit ? 1 : 0.6,
            }}
          >
            <Fi icon="arrow-down-to-bracket" style={{ fontSize: '13px' }} />
            Add funds
          </button>
        </div>
      ) : null}
    </div>
  );
}
