import { useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { PublicKey } from '@solana/web3.js';
import { useWallet } from '@solana/wallet-adapter-react';
import Fi from '../Fi';
import { Section } from '../calm';
import { useSendTransaction } from '../../hooks/useSendTransaction';
import { useChain } from '../../hooks/useChain';
import { isEvmAddress } from '../../lib/chain/types';
import { buildUpdateGuardianConfigEvm } from '../../lib/evm/writers';
import { buildUpdateGuardianConfig } from '../../lib/transactionBuilders';
import { isMockDaoAddress } from '../../lib/mockData';

export interface Signer {
  id: string;
  address: string;
  label: string;
  added: string;
}

export const INITIAL_SIGNERS: Signer[] = [
  { id: 's1', address: '7xKp…3mBf', label: 'Lead Contributor', added: '45 days ago' },
  { id: 's2', address: '9aRz…8vWq', label: 'Core Team', added: '45 days ago' },
  { id: 's3', address: '4sLm…1nPr', label: 'Community Council', added: '30 days ago' },
];

export function MultisigThresholdAdvanced({
  signersCount,
  threshold,
  setThreshold,
  evmEditsLocked,
}: {
  signersCount: number;
  threshold: number;
  setThreshold: (n: number) => void;
  evmEditsLocked: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mb-4">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 mb-2 hover:underline underline-offset-4"
        style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))' }}
      >
        <Fi icon={open ? 'chevron-up' : 'chevron-down'} style={{ fontSize: '10px' }} />
        Advanced — require {threshold} of {signersCount} approvals
      </button>
      {open && (
        <>
          <div className="flex items-center gap-2 flex-wrap">
            {Array.from({ length: Math.max(1, signersCount) }, (_, i) => i + 1).map((n) => (
              <button
                key={n}
                onClick={() => { if (!evmEditsLocked) setThreshold(n); }}
                disabled={evmEditsLocked}
                className="px-3.5 py-1.5 rounded-full border transition-all"
                style={{
                  fontSize: '13px',
                  fontWeight: threshold === n ? 600 : 400,
                  backgroundColor: threshold === n ? 'hsl(var(--foreground))' : '#ffffff',
                  borderColor: threshold === n ? 'hsl(var(--foreground))' : 'hsl(var(--border))',
                  color: threshold === n ? '#ffffff' : 'hsl(var(--foreground))',
                  opacity: evmEditsLocked ? 0.7 : 1,
                  cursor: evmEditsLocked ? 'not-allowed' : 'pointer',
                }}
              >
                {n} of {signersCount}
              </button>
            ))}
          </div>
          <p style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))', marginTop: '8px', lineHeight: 1.5 }}>
            How many trusted wallets must approve an emergency freeze.
          </p>
        </>
      )}
    </div>
  );
}

export default function MultisigSection({
  initialSigners,
  initialThreshold,
  daoAddress,
  guardiansBootstrapped = false,
  first = false,
}: {
  initialSigners: Signer[];
  initialThreshold: number;
  daoAddress: string | null;
  /** EVM: after bootstrap, founder may not call updateGuardianConfig — use Permission proposals. */
  guardiansBootstrapped?: boolean;
  first?: boolean;
}) {
  const navigate = useNavigate();
  const { publicKey } = useWallet();
  const { chainKind, evmChainId } = useChain();
  const tx = useSendTransaction();
  const [signers, setSigners] = useState<Signer[]>(initialSigners);
  const [threshold, setThreshold] = useState(initialThreshold);
  const [newAddress, setNewAddress] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [adding, setAdding] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [guardianSaved, setGuardianSaved] = useState(false);
  const [guardianError, setGuardianError] = useState<string | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const evmEditsLocked = chainKind === 'evm' && guardiansBootstrapped;

  /** Push the current signer list + threshold on-chain via buildUpdateGuardianConfig (EVM bootstrap only). */
  async function saveGuardianConfig() {
    setGuardianError(null);

    // Demo DAOs have no chain to write to — show the saved affordance only there.
    if (isMockDaoAddress(daoAddress)) {
      setGuardianSaved(true);
      savedTimer.current = setTimeout(() => setGuardianSaved(false), 2500);
      return;
    }
    if (!daoAddress) {
      setGuardianError('Select a treasury before updating guardians.');
      return;
    }
    // ── EVM: NaveTreasury.updateGuardianConfig (founder one-shot bootstrap only) ──
    if (chainKind === 'evm') {
      if (guardiansBootstrapped) {
        setGuardianError(
          'Guardians are already bootstrapped. Further changes require a passed Permission proposal (Governance → Create Proposal → Permission Update).',
        );
        return;
      }
      if (!evmChainId) {
        setGuardianError('Select an Ethereum, Base, or Robinhood network.');
        return;
      }
      const evmWallets = signers.map((s) => s.address.trim());
      const evmInvalid = signers.filter((s) => !isEvmAddress(s.address));
      if (evmInvalid.length > 0) {
        setGuardianError(
          `Invalid guardian address: ${evmInvalid.map((s) => s.label || s.address).join(', ')}`,
        );
        return;
      }
      if (evmWallets.length === 0) {
        setGuardianError('Add at least one guardian wallet before saving.');
        return;
      }
      if (threshold < 1 || threshold > evmWallets.length) {
        setGuardianError(`Threshold must be between 1 and ${evmWallets.length}.`);
        return;
      }
      const evmResult = await tx.sendEvm(
        buildUpdateGuardianConfigEvm(evmChainId, daoAddress, evmWallets, threshold),
        { successLabel: 'Guardian config saved', quietMock: true },
      );
      if (evmResult.status === 'success' || evmResult.status === 'mock') {
        setGuardianSaved(true);
        savedTimer.current = setTimeout(() => setGuardianSaved(false), 3000);
      } else if (evmResult.status === 'error') {
        setGuardianError(evmResult.error);
      }
      return;
    }
    if (!publicKey) {
      setGuardianError('Connect your wallet to update guardians.');
      return;
    }

    const daoPubkey = new PublicKey(daoAddress);

    // Validate EVERY signer address up front. Never silently drop an unparseable
    // address or fall back to a connected-wallet-only (1-of-1) config — that would
    // quietly weaken the multisig.
    const invalid = signers.filter((s) => {
      try {
        new PublicKey(s.address);
        return false;
      } catch {
        return true;
      }
    });
    if (invalid.length > 0) {
      setGuardianError(
        `Invalid guardian address: ${invalid.map((s) => s.label || s.address).join(', ')}`,
      );
      return;
    }

    const wallets = signers.map((s) => new PublicKey(s.address));
    if (wallets.length === 0) {
      setGuardianError('Add at least one guardian wallet before saving.');
      return;
    }
    if (threshold < 1 || threshold > wallets.length) {
      setGuardianError(`Threshold must be between 1 and ${wallets.length}.`);
      return;
    }

    const result = await tx.send(
      await buildUpdateGuardianConfig(daoPubkey, publicKey, wallets, threshold),
      {
        successLabel: 'Guardian config saved',
        quietMock: true,
      },
    );

    if (result.status === 'mock') {
      setGuardianSaved(true);
      savedTimer.current = setTimeout(() => setGuardianSaved(false), 2500);
      return;
    }

    if (result.status === 'success') {
      setGuardianSaved(true);
      savedTimer.current = setTimeout(() => setGuardianSaved(false), 3000);
    } else if (result.status === 'error') {
      setGuardianError(result.error);
    }
  }

  function addSigner() {
    if (!newAddress.trim()) return;
    const id = `s${Date.now()}`;
    setSigners(s => [
      ...s,
      {
        id,
        address: newAddress.trim(),
        label: newLabel.trim() || 'Trusted wallet',
        added: 'just now',
      },
    ]);
    setNewAddress('');
    setNewLabel('');
    setAdding(false);
  }

  function removeSigner(id: string) {
    setSigners(s => s.filter(signer => signer.id !== id));
  }

  function handleCopy(addr: string) {
    navigator.clipboard.writeText(addr);
    setCopied(addr);
    setTimeout(() => setCopied(null), 1500);
  }

  return (
    <Section
      first={first}
      title="Members & guardians"
      hint={signers.length === 0 ? 'Add people who can help freeze the treasury' : `${threshold} of ${signers.length} needed for emergency actions`}
      action={
        evmEditsLocked ? (
          <button
            type="button"
            onClick={() => navigate('/decisions')}
            className="hover:underline underline-offset-4"
            style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))' }}
          >
            + Propose member change
          </button>
        ) : !adding ? (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="hover:underline underline-offset-4"
            style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))' }}
          >
            + Invite / Add member
          </button>
        ) : undefined
      }
    >
      {/* Threshold — Advanced */}
      <MultisigThresholdAdvanced
        signersCount={signers.length}
        threshold={threshold}
        setThreshold={setThreshold}
        evmEditsLocked={evmEditsLocked}
      />

      {/* Signers list */}
      <div>
        {signers.map((signer, idx) => (
          <div
            key={signer.id}
            className="flex items-start gap-3 py-3.5"
            style={{
              borderBottom: '1px solid hsl(var(--surface-2))',
              borderTop: idx === 0 ? '1px solid hsl(var(--surface-2))' : 'none',
            }}
          >
            <span
              className="flex items-center justify-center flex-shrink-0"
              style={{
                width: '28px',
                height: '28px',
                borderRadius: '50%',
                backgroundColor: idx === 0 ? 'hsl(var(--brass))' : 'hsl(var(--background))',
                border: idx === 0 ? 'none' : '1px solid hsl(var(--border))',
                color: idx === 0 ? '#ffffff' : 'hsl(var(--foreground))',
                fontSize: '9.5px',
                fontWeight: 700,
                fontFamily: 'var(--font-mono)',
                marginTop: '2px',
              }}
            >
              {signer.label.slice(0, 2).toUpperCase()}
            </span>
            <div className="flex-1 min-w-0">
              <div
                style={{
                  fontSize: '14px',
                  fontWeight: 500,
                  color: 'hsl(var(--foreground))',
                  lineHeight: 1.4,
                }}
              >
                {signer.label}
              </div>
              <div
                className="flex items-center gap-2 flex-wrap"
                title={signer.address}
                style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))', marginTop: '2px' }}
              >
                <span className="nave-mono" style={{ fontSize: '12px' }}>
                  {signer.address.length > 16
                    ? `${signer.address.slice(0, 6)}…${signer.address.slice(-6)}`
                    : signer.address}
                </span>
                <span>·</span>
                <span>{idx === 0 ? 'Founder · can freeze, propose, vote' : 'Guardian · can freeze and vote'}</span>
              </div>
            </div>
            <div className="flex items-center gap-3 ml-auto flex-shrink-0 pt-0.5">
              <button
                type="button"
                onClick={() => handleCopy(signer.address)}
                className="hover:underline underline-offset-4"
                style={{ fontSize: '12.5px', color: copied === signer.address ? 'hsl(var(--success))' : 'hsl(var(--muted-foreground))' }}
              >
                {copied === signer.address ? 'Copied' : 'Copy'}
              </button>
              <button
                type="button"
                onClick={() => (evmEditsLocked ? navigate('/decisions') : removeSigner(signer.id))}
                className="hover:underline underline-offset-4"
                style={{
                  fontSize: '12.5px',
                  color: 'hsl(var(--muted-foreground))',
                }}
              >
                Remove…
              </button>
            </div>
          </div>
        ))}
      </div>

      <p style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))', marginTop: '10px', marginBottom: 0 }}>
        Removing a guardian takes a decision. Removing a member takes effect immediately and is recorded.
      </p>

      {/* Add signer */}
      {!evmEditsLocked && adding && (
        <div
          className="py-4 mt-2 space-y-3"
          style={{ borderBottom: '1px solid hsl(var(--surface-2))' }}
        >
          <div className="nave-label">Add trusted wallet</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <input
              type="text"
              value={newAddress}
              onChange={e => setNewAddress(e.target.value)}
              placeholder="Wallet address…"
              className="px-3 py-2.5 rounded-[10px] border outline-none"
              style={{
                fontSize: '13.5px',
                fontFamily: 'var(--font-mono)',
                backgroundColor: '#ffffff',
                borderColor: 'hsl(var(--border))',
                color: 'hsl(var(--foreground))',
              }}
              onFocus={e => (e.currentTarget.style.borderColor = 'hsl(var(--ring))')}
              onBlur={e => (e.currentTarget.style.borderColor = 'hsl(var(--border))')}
            />
            <input
              type="text"
              value={newLabel}
              onChange={e => setNewLabel(e.target.value)}
              placeholder="Label (optional)"
              className="px-3 py-2.5 rounded-[10px] border outline-none"
              style={{
                fontSize: '13.5px',
                backgroundColor: '#ffffff',
                borderColor: 'hsl(var(--border))',
                color: 'hsl(var(--foreground))',
                fontFamily: 'var(--font-body)',
              }}
              onFocus={e => (e.currentTarget.style.borderColor = 'hsl(var(--ring))')}
              onBlur={e => (e.currentTarget.style.borderColor = 'hsl(var(--border))')}
            />
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={addSigner}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-[9px] font-semibold"
              style={{
                fontSize: '13px',
                backgroundColor: 'hsl(var(--foreground))',
                color: '#ffffff',
              }}
            >
              Add wallet
            </button>
            <button
              type="button"
              onClick={() => setAdding(false)}
              className="px-3 py-2 rounded-[9px]"
              style={{
                fontSize: '13px',
                color: 'hsl(var(--muted-foreground))',
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Save guardian config button — EVM bootstrap only after first save */}
      <div className="mt-4 space-y-2">
        {guardianError && (
          <div
            className="flex items-center gap-2 py-2"
            style={{ color: 'hsl(var(--destructive))', fontSize: '12.5px' }}
          >
            <Fi icon="circle-xmark" style={{ fontSize: '13px' }} />
            <span className="flex-1">{guardianError}</span>
            <button onClick={() => setGuardianError(null)} style={{ fontSize: '11.5px', textDecoration: 'underline' }}>dismiss</button>
          </div>
        )}
        {!evmEditsLocked && (
          <div className="flex items-center gap-3 pt-1">
            <button
              onClick={saveGuardianConfig}
              disabled={tx.status === 'signing' || tx.status === 'confirming'}
              className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-[9px] font-semibold transition-all"
              style={{
                fontSize: '13px',
                backgroundColor: 'hsl(var(--foreground))',
                color: '#ffffff',
                opacity: (tx.status === 'signing' || tx.status === 'confirming') ? 0.6 : 1,
              }}
            >
              {(tx.status === 'signing' || tx.status === 'confirming') && (
                <Fi icon="arrows-rotate" style={{ fontSize: '12px' }} className="animate-spin" />
              )}
              {tx.status === 'signing'
                ? 'Signing…'
                : tx.status === 'confirming'
                  ? 'Confirming…'
                  : chainKind === 'evm'
                    ? 'Bootstrap Guardian Config'
                    : 'Save Guardian Config'}
            </button>
            {guardianSaved && (
              <span style={{ fontSize: '13px', color: 'hsl(var(--success))', fontWeight: 500 }}>
                Saved ✓
              </span>
            )}
          </div>
        )}
      </div>
    </Section>
  );
}
