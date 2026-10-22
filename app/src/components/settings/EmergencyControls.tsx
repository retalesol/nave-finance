import { useState, useEffect, useRef } from 'react';
import { PublicKey } from '@solana/web3.js';
import { useWallet } from '@solana/wallet-adapter-react';
import { useAccount, useSignMessage } from 'wagmi';
import Fi from '../Fi';
import { toast } from '../../hooks/use-toast';
import { Section, Notice } from '../calm';
import NaveModal from '../NaveModal';
import { useSendTransaction } from '../../hooks/useSendTransaction';
import { useChain } from '../../hooks/useChain';
import { isTreasuryOpsFamily } from '../../lib/chain/types';
import {
  buildEmergencyFreezeEvm,
  buildEmergencyUnfreezeEvm,
  defaultGuardianActionDeadline,
} from '../../lib/evm/writers';
import {
  buildEmergencyFreeze,
  buildEmergencyUnfreeze,
} from '../../lib/transactionBuilders';
import { resolveOpenGuardianActionNonce } from '../../lib/onChainFetcher';
import { collectEvmGuardianFreezeSigs } from '../../lib/edgeFunctionClient';

/**
 * Coordinated, deterministic guardian-action nonce.
 *
 * Guardian M-of-N signatures only accumulate on the SAME GuardianAction PDA,
 * which is derived from (dao, action_type, nonce). A per-guardian Date.now() (or a
 * per-session counter) gives every guardian a DIFFERENT nonce → a different PDA →
 * the threshold can never be reached. We bucket time into a shared coordination
 * window so every guardian acting within the same window derives the same nonce and
 * converges on one GuardianAction.
 *
 * LIMITATION (flagged): this is a best-effort client-only scheme. If a window
 * boundary falls mid-coordination, guardians can split across two PDAs. Fully
 * correct convergence needs a backend/contract-provided shared action id (e.g. a
 * pending-action registry the client can read), which is out of scope here.
 */
const GUARDIAN_ACTION_WINDOW_MS = 60 * 60 * 1000; // 1-hour coordination window
function coordinatedActionNonce(): number {
  return Math.floor(Date.now() / GUARDIAN_ACTION_WINDOW_MS);
}

/**
 * Resolve the nonce a guardian should sign for a Solana emergency action.
 *
 * First we read the chain for an already-open GuardianAction of this
 * (dao, actionType) and reuse its nonce so all guardians converge on the SAME
 * PDA and the M-of-N threshold can actually accumulate. Only if none exists do
 * we mint a fresh deterministic (time-bucketed) nonce for the first signer.
 * actionType: 0 = freeze, 1 = unfreeze.
 *
 * Retries the on-chain check a couple of times before concluding no open
 * action exists — a guardian who just submitted moments ago may not be
 * queryable yet (RPC/indexing lag), which would otherwise cause a second
 * guardian to wrongly mint a fresh nonce instead of reusing the first one.
 * This narrows, but does not eliminate, the documented window-boundary race;
 * when it does fall through to a fresh nonce, the caller is told so they can
 * coordinate manually rather than silently risking a split action.
 */
export async function resolveGuardianNonce(
  daoPubkey: PublicKey,
  actionType: number,
): Promise<{ nonce: number; isNewAction: boolean }> {
  let existing: number | null = null;
  for (let attempt = 0; attempt < 3 && existing == null; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1200));
    existing = await resolveOpenGuardianActionNonce(daoPubkey, actionType);
  }
  if (existing != null) return { nonce: existing, isNewAction: false };
  return { nonce: coordinatedActionNonce(), isNewAction: true };
}

export default function EmergencyControls({ daoAddress, initialFrozen = false }: { daoAddress: string | null; initialFrozen?: boolean }) {
  const { publicKey } = useWallet();
  const { address: evmAddress } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { chainKind, evmChainId, chainFamily } = useChain();
  const tx = useSendTransaction();
  const [frozen, setFrozen] = useState(initialFrozen);
  const [confirming, setConfirming] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [freezeError, setFreezeError] = useState<string | null>(null);
  const [evmBusy, setEvmBusy] = useState(false);
  const confirmedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Reflect the authoritative on-chain frozen state when it loads/changes.
  useEffect(() => {
    setFrozen(initialFrozen);
  }, [initialFrozen]);

  async function submitEvmFreeze(wantFreeze: boolean) {
    if (!daoAddress || !evmChainId || !evmAddress) {
      setFreezeError('Connect your EVM founder wallet on Ethereum or Base.');
      return;
    }
    if (!isTreasuryOpsFamily(chainFamily)) {
      setFreezeError('Select an Ethereum, Base, or Robinhood network.');
      return;
    }
    setEvmBusy(true);
    setFreezeError(null);
    try {
      const deadline = defaultGuardianActionDeadline();
      const nonce = BigInt(Math.floor(Date.now() / 1000));
      const { data, error } = await collectEvmGuardianFreezeSigs(
        daoAddress,
        evmAddress,
        (m) => signMessageAsync({ message: m }),
        wantFreeze,
        evmChainId,
        chainFamily,
        { nonce, deadline },
      );
      if (error || !data?.signatures?.length) {
        setFreezeError(error || 'No guardian signatures collected.');
        return;
      }
      const built = wantFreeze
        ? buildEmergencyFreezeEvm(evmChainId, daoAddress, BigInt(data.nonce), BigInt(data.deadline), data.signatures)
        : buildEmergencyUnfreezeEvm(evmChainId, daoAddress, BigInt(data.nonce), BigInt(data.deadline), data.signatures);
      if (!built.request) {
        setFreezeError(built.error || 'Failed to build freeze transaction.');
        return;
      }
      const result = await tx.sendEvm(built, {
        successLabel: wantFreeze ? 'Emergency freeze activated' : 'Treasury unfrozen',
        quietMock: true,
      });
      if (result.status === 'success' || result.status === 'mock') {
        setFrozen(wantFreeze);
        setConfirmed(wantFreeze);
        if (wantFreeze) confirmedTimer.current = setTimeout(() => setConfirmed(false), 3000);
      } else if (result.status === 'error') {
        setFreezeError(result.error);
      }
    } catch (err) {
      setFreezeError(err instanceof Error ? err.message : 'EVM freeze failed.');
    } finally {
      setEvmBusy(false);
    }
  }

  async function requestFreeze() {
    setFreezeError(null);
    if (chainKind === 'evm') {
      if (frozen) {
        await submitEvmFreeze(false);
        return;
      }
      setConfirming(true);
      return;
    }
    if (frozen) {
      // Unfreeze
      if (!publicKey || !daoAddress) {
        setFrozen(false);
        setConfirmed(false);
        return;
      }
      const daoPubkey = new PublicKey(daoAddress);
      const { nonce, isNewAction } = await resolveGuardianNonce(daoPubkey, 1);
      if (isNewAction) {
        toast({
          title: 'Starting a new emergency action',
          description:
            'No in-progress unfreeze action was found on-chain. If another guardian is acting at the same time, coordinate directly so your signatures land on the same action.',
        });
      }
      const result = await tx.send(await buildEmergencyUnfreeze(daoPubkey, publicKey, nonce), {
        successLabel: 'Treasury unfrozen',
        quietMock: true,
      });
      if (result.status === 'mock') {
        setFrozen(false);
        setConfirmed(false);
      } else if (result.status === 'success') {
        setFrozen(false);
        setConfirmed(false);
      } else if (result.status === 'error') {
        setFreezeError(result.error);
      }
      return;
    }
    setConfirming(true);
  }

  async function confirmFreeze() {
    setConfirming(false);
    setFreezeError(null);

    if (chainKind === 'evm') {
      await submitEvmFreeze(true);
      return;
    }

    if (!publicKey || !daoAddress) {
      // Mock fallback
      setFrozen(true);
      setConfirmed(true);
      confirmedTimer.current = setTimeout(() => setConfirmed(false), 3000);
      return;
    }

    const daoPubkey = new PublicKey(daoAddress);
    const { nonce, isNewAction } = await resolveGuardianNonce(daoPubkey, 0);
    if (isNewAction) {
      toast({
        title: 'Starting a new emergency action',
        description:
          'No in-progress freeze action was found on-chain. If another guardian is acting at the same time, coordinate directly so your signatures land on the same action.',
      });
    }
    const result = await tx.send(await buildEmergencyFreeze(daoPubkey, publicKey, nonce), {
      successLabel: 'Emergency freeze activated',
      quietMock: true,
    });

    if (result.status === 'mock') {
      setFrozen(true);
      setConfirmed(true);
      confirmedTimer.current = setTimeout(() => setConfirmed(false), 3000);
    } else if (result.status === 'success') {
      setFrozen(true);
      setConfirmed(true);
      confirmedTimer.current = setTimeout(() => setConfirmed(false), 3000);
    } else if (result.status === 'error') {
      setFreezeError(result.error);
    }
  }

  return (
    <Section title="Safety">
      <div className="space-y-4">
        {/* Emergency freeze (.danger-zone) */}
        <div
          className="danger-zone rounded-[12px] border"
          style={{
            backgroundColor: '#FFF9F8',
            borderColor: '#F2C7C2',
            padding: '14px',
          }}
        >
          <h3
            style={{
              margin: 0,
              fontFamily: 'var(--font-body)',
              fontSize: '14px',
              fontWeight: 600,
              color: frozen ? '#B42318' : 'hsl(var(--foreground))',
            }}
          >
            {frozen ? 'Treasury frozen' : 'Emergency freeze'}
          </h3>
          <p
            style={{
              margin: '5px 0 12px',
              fontSize: '13px',
              lineHeight: 1.6,
              color: frozen ? '#B42318' : 'hsl(var(--muted-foreground))',
            }}
          >
            {frozen
              ? 'All agent operations are halted. Multisig required to resume.'
              : chainKind === 'evm'
                ? 'Halts all money movement instantly. Collects custodied guardian EIP-712 signatures, then freezes in one transaction.'
                : 'Halts all money movement instantly. Monitoring continues. Restarting requires a community vote.'}
          </p>
          <button
            type="button"
            onClick={requestFreeze}
            disabled={evmBusy}
            className="inline-flex items-center gap-1.5 rounded-[9px] border font-semibold transition-all"
            style={{
              padding: '8px 14px',
              fontSize: '13px',
              backgroundColor: frozen ? 'hsl(var(--foreground))' : '#ffffff',
              borderColor: frozen ? 'hsl(var(--foreground))' : '#E5A49E',
              color: frozen ? '#ffffff' : '#B42318',
              opacity: evmBusy ? 0.6 : 1,
            }}
          >
            {evmBusy ? 'Signing…' : frozen ? 'Unfreeze treasury…' : 'Freeze treasury…'}
          </button>
        </div>

        {/* Confirm modal */}
        {confirming && (
          <ConfirmFreezeModal onConfirm={confirmFreeze} onCancel={() => setConfirming(false)} />
        )}

        {confirmed && (
          <Notice tone="red">
            <span style={{ fontSize: '13px', color: 'hsl(var(--destructive))' }}>
              Treasury freeze confirmed. Agent has been halted.
            </span>
          </Notice>
        )}

        {freezeError && (
          <div
            className="flex items-center gap-2 py-2"
            style={{ color: 'hsl(var(--destructive))', fontSize: '12.5px' }}
          >
            <Fi icon="circle-xmark" style={{ fontSize: '13px' }} />
            <span className="flex-1">{freezeError}</span>
            <button onClick={() => setFreezeError(null)} style={{ fontSize: '11.5px', textDecoration: 'underline' }}>dismiss</button>
          </div>
        )}

        {(tx.status === 'signing' || tx.status === 'confirming') && (
          <Notice tone="muted">
            <span style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))' }}>
              {tx.status === 'signing' ? 'Waiting for wallet signature…' : 'Confirming transaction…'}
            </span>
          </Notice>
        )}
      </div>
    </Section>
  );
}

/* ── Confirm Freeze Modal ─────────────────────────────── */
export function ConfirmFreezeModal({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  return (
    <NaveModal
      open={true}
      onClose={onCancel}
      title="Confirm Emergency Freeze"
      subtitle="Immediately pause all agent operations"
      maxWidth={440}
    >
      <div style={{ padding: '18px 22px 22px' }}>
        <p style={{ fontSize: '13.5px', lineHeight: 1.6, color: 'hsl(var(--muted-foreground))', margin: '0 0 18px' }}>
          This will immediately pause all agent operations. The treasury will remain
          intact but no new transactions will be executed until the multisig
          threshold approves resumption.
        </p>
        <div
          className="flex items-center justify-end gap-2 pt-4"
          style={{ borderTop: '1px solid hsl(var(--surface-2))' }}
        >
          <button
            type="button"
            onClick={onCancel}
            className="px-3.5 py-2 rounded-[9px] border font-semibold"
            style={{ fontSize: '13px', backgroundColor: '#ffffff', borderColor: 'hsl(var(--border))', color: 'hsl(var(--foreground))' }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-[9px] font-semibold"
            style={{ fontSize: '13px', backgroundColor: 'hsl(var(--destructive))', color: '#ffffff' }}
          >
            <Fi icon="lock" style={{ fontSize: '12px' }} />
            Confirm Freeze
          </button>
        </div>
      </div>
    </NaveModal>
  );
}
