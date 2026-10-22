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
      <div
        className="py-5 text-center"
        style={{ borderBottom: '1px solid hsl(var(--surface-2))' }}
      >
        <div
          className="mx-auto mb-3 grid place-items-center rounded-full"
          style={{
            width: '40px',
            height: '40px',
            border: '1px solid #BFE0CC',
            backgroundColor: '#F2F9F4',
            color: 'hsl(var(--success))',
          }}
        >
          <Fi icon="check" style={{ fontSize: '15px' }} />
        </div>
        <h3
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: '20px',
            fontWeight: 400,
            color: 'hsl(var(--foreground))',
            marginBottom: '4px',
          }}
        >
          Trusted wallets saved
        </h3>
        <p style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))' }}>
          Emergency actions now need {threshold} of {signers.length} approvals.
        </p>
      </div>
    );
  }

  return (
    <div
      className="py-4 space-y-4"
      style={{ borderBottom: '1px solid hsl(var(--surface-2))' }}
    >
      <p style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.55, margin: 0 }}>
        Your connected wallet is already a trusted signer. Add another person only if you want shared emergency approval — otherwise confirm and continue.
      </p>

      {connectedWallet && (
        <div
          className="flex items-center justify-between gap-2.5 px-3.5 py-2.5 rounded-[10px]"
          style={{ backgroundColor: '#ffffff', border: '1px solid hsl(var(--border))' }}
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <span
              style={{
                width: '7px',
                height: '7px',
                borderRadius: '50%',
                backgroundColor: 'hsl(var(--success))',
                flexShrink: 0,
              }}
            />
            <span style={{ fontSize: '13px', fontWeight: 500, color: 'hsl(var(--foreground))' }}>You (connected)</span>
          </div>
          <span className="nave-mono truncate" style={{ fontSize: '11.5px', color: 'hsl(var(--muted-foreground))' }}>
            {connectedWallet.slice(0, 6)}…{connectedWallet.slice(-4)}
          </span>
        </div>
      )}

      {trustedWallets.length < 2 && (
        <div>
          <label
            style={{
              fontSize: '12.5px',
              fontWeight: 600,
              color: 'hsl(var(--foreground))',
              marginBottom: '6px',
              display: 'block',
            }}
          >
            Add a trusted wallet <span style={{ color: 'hsl(var(--muted-foreground))', fontWeight: 400 }}>(optional)</span>
          </label>
          <div className="flex gap-2">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Paste their wallet address…"
              className="flex-1 px-3 py-2 rounded-[10px] border outline-none transition-colors"
              style={{
                fontSize: '13px',
                fontFamily: 'var(--font-mono)',
                backgroundColor: '#ffffff',
                borderColor: 'hsl(var(--border))',
                color: 'hsl(var(--foreground))',
              }}
              onKeyDown={(e) => e.key === 'Enter' && addTrustedWallet()}
            />
            <button
              type="button"
              onClick={addTrustedWallet}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-[9px] border font-semibold transition-colors flex-shrink-0"
              style={{
                fontSize: '12.5px',
                backgroundColor: '#ffffff',
                borderColor: 'hsl(var(--border))',
                color: 'hsl(var(--foreground))',
              }}
            >
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
              className="flex items-center justify-between px-3.5 py-2 rounded-[10px]"
              style={{ backgroundColor: '#ffffff', border: '1px solid hsl(var(--border))' }}
            >
              <span className="nave-mono truncate" style={{ fontSize: '12px', color: 'hsl(var(--foreground))' }}>{s}</span>
              <button
                type="button"
                onClick={() => removeTrustedWallet(s)}
                className="p-1 rounded transition-colors flex-shrink-0"
                style={{ color: 'hsl(var(--muted-foreground))' }}
              >
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
        style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))' }}
      >
        <Fi icon={showAdvanced ? 'chevron-up' : 'chevron-down'} style={{ fontSize: '10px' }} />
        Advanced — approval count ({threshold} of {signers.length})
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
                  type="button"
                  key={n}
                  onClick={() => setThresholdOverride(n)}
                  className="px-3.5 py-1.5 rounded-full border text-center transition-all"
                  style={{
                    fontSize: '12.5px',
                    fontWeight: sel ? 600 : 400,
                    backgroundColor: sel ? 'hsl(var(--foreground))' : '#ffffff',
                    borderColor: sel ? 'hsl(var(--foreground))' : 'hsl(var(--border))',
                    color: sel ? '#ffffff' : 'hsl(var(--foreground))',
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

      <div className="flex items-center justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={() => void handleConfirm()}
          disabled={!canConfirm}
          className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-[9px] font-semibold transition-all"
          style={{
            fontSize: '13px',
            backgroundColor: 'hsl(var(--foreground))',
            color: '#ffffff',
            opacity: canConfirm ? 1 : 0.45,
            cursor: canConfirm ? 'pointer' : 'not-allowed',
          }}
        >
          {submitting ? 'Saving…' : 'Confirm and continue'}
        </button>
      </div>
    </div>
  );
}

/** Single prioritized activation surface — calm hairline Notice strip. */
export default function ActivationHub({ onOpenDeposit, onSignerComplete }: ActivationHubProps) {
  const { daoAddress } = useDaoContext();
  const { loading: daoLoading } = useDaoRegistry(daoAddress);
  const treasuryBalance = useTreasuryBalance(daoAddress);
  const guardianConfig = useGuardianConfig(daoAddress);
  const { isFounder } = useDaoMembership();
  const isMock = isMockDaoAddress(daoAddress);
  const [signerExpanded, setSignerExpanded] = useState(false);

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
    <div data-onboarding-id="activation-checklist">
      <div
        className="flex items-center gap-2.5 flex-wrap"
        style={{
          padding: '11px 0',
          borderTop: '1px solid hsl(var(--surface-2))',
          borderBottom: '1px solid hsl(var(--surface-2))',
          fontSize: '13.5px',
          color: 'hsl(var(--foreground))',
        }}
      >
        <span
          style={{
            width: '7px',
            height: '7px',
            borderRadius: '50%',
            backgroundColor: watching ? 'hsl(var(--success))' : 'hsl(var(--brass))',
            flexShrink: 0,
          }}
        />
        <div className="flex-1 min-w-0">
          <strong style={{ fontWeight: 600 }}>
            {needsSignerSetup
              ? 'Add a trusted wallet'
              : loading
                ? 'Treasury'
                : watching
                  ? 'Agents are watching'
                  : 'Fund your treasury'}
          </strong>{' '}
          <span style={{ color: 'hsl(var(--muted-foreground))' }}>
            —{' '}
            {loading
              ? 'Checking on-chain status…'
              : needsSignerSetup
                ? 'Your wallet is already included. Confirm to continue, or add one more person.'
                : watching
                  ? 'They record drift and do not move capital until a check passes.'
                  : 'Next step: fund the treasury. After that, agents are watching.'}
          </span>
        </div>

        <div className="ml-auto flex items-center gap-3 flex-shrink-0">
          {needsSignerSetup && (
            <button
              type="button"
              onClick={() => setSignerExpanded((v) => !v)}
              className="hover:underline underline-offset-4 bg-transparent border-0 cursor-pointer"
              style={{
                color: 'hsl(var(--foreground))',
                fontWeight: 600,
                fontSize: '13px',
                whiteSpace: 'nowrap',
              }}
            >
              {signerExpanded ? 'Hide' : 'Configure →'}
            </button>
          )}
          {funding && onOpenDeposit && (
            <button
              type="button"
              onClick={onOpenDeposit}
              className="hover:underline underline-offset-4 bg-transparent border-0 cursor-pointer"
              style={{
                color: 'hsl(var(--foreground))',
                fontWeight: 600,
                fontSize: '13px',
                whiteSpace: 'nowrap',
              }}
            >
              Add funds →
            </button>
          )}
          {!needsSignerSetup && (
            <button
              type="button"
              onClick={dismiss}
              className="p-1 rounded transition-colors flex-shrink-0"
              title="Dismiss"
              style={{ color: 'hsl(var(--muted-foreground))' }}
            >
              <Fi icon="xmark" style={{ fontSize: '12px' }} />
            </button>
          )}
        </div>
      </div>

      {needsSignerSetup && signerExpanded && daoAddress && (
        <SignerSetupPanel daoAddress={daoAddress} onComplete={() => onSignerComplete?.()} />
      )}
    </div>
  );
}
