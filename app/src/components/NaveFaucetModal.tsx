import { useEffect, useRef, useState, type ReactNode } from 'react';
import { PublicKey } from '@solana/web3.js';
import Fi from './Fi';
import { toast } from '../hooks/use-toast';
import { submitFaucetClaim, submitSolFaucetClaim } from '../lib/faucet';
import { SOLANA_NETWORK } from '../lib/programConfig';

function solanaExplorerTx(sig: string): string {
  const cluster = SOLANA_NETWORK === 'mainnet' ? '' : '?cluster=devnet';
  return `https://solscan.io/tx/${sig}${cluster}`;
}

function isValidSolanaAddress(value: string): boolean {
  try {
    // eslint-disable-next-line no-new
    new PublicKey(value.trim());
    return true;
  } catch {
    return false;
  }
}

export type FaucetVariant = 'nave' | 'sol';

const FAUCET_COPY: Record<
  FaucetVariant,
  {
    title: string;
    subtitle: ReactNode;
    successMessage: string;
    toastTitle: string;
    toastDescription: string;
    claimLabel: string;
    claim: (address: string) => ReturnType<typeof submitFaucetClaim>;
  }
> = {
  nave: {
    title: 'NAVE Faucet',
    subtitle: (
      <>
        Enter a Solana devnet address to receive <strong>0.1 NAVE</strong>. The address must already hold at
        least 0.01 devnet SOL. Limited to one claim per address every 24 hours.
      </>
    ),
    successMessage: '0.1 NAVE sent to your address. It may take a few seconds to confirm on-chain.',
    toastTitle: 'NAVE sent',
    toastDescription: '0.1 NAVE is on its way to your devnet wallet.',
    claimLabel: 'Claim 0.1 NAVE',
    claim: submitFaucetClaim,
  },
  sol: {
    title: 'SOL Faucet',
    subtitle: (
      <>
        Enter a Solana devnet address to receive <strong>0.05 devnet SOL</strong> for transaction fees.
        Limited to one claim per address every 24 hours.
      </>
    ),
    successMessage: '0.05 devnet SOL sent to your address. It may take a few seconds to confirm on-chain.',
    toastTitle: 'SOL sent',
    toastDescription: '0.05 devnet SOL is on its way to your wallet.',
    claimLabel: 'Claim 0.05 SOL',
    claim: submitSolFaucetClaim,
  },
};

interface NaveFaucetModalProps {
  open: boolean;
  onClose: () => void;
  /** Which asset this modal claims — defaults to the original NAVE faucet. */
  variant?: FaucetVariant;
}

/**
 * Devnet faucet modal (NAVE or SOL variant) — styled to match NaveWalletModal
 * so it feels like a native part of the connect/claim flow rather than a
 * bolted-on dialog. Standalone (no wallet connection required): the user just
 * types the Solana address that should receive the claim.
 */
export default function NaveFaucetModal({ open, onClose, variant = 'nave' }: NaveFaucetModalProps) {
  const copy = FAUCET_COPY[variant];
  const [address, setAddress] = useState('');
  const [claiming, setClaiming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  useEffect(() => {
    document.body.style.overflow = open ? 'hidden' : '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [open]);

  // Reset transient state whenever the modal is reopened.
  useEffect(() => {
    if (open) {
      setError(null);
      setSignature(null);
    }
  }, [open]);

  if (!open) return null;

  const trimmed = address.trim();
  const addressValid = trimmed.length > 0 && isValidSolanaAddress(trimmed);

  async function handleClaim() {
    if (!addressValid || claiming) return;
    setError(null);
    setClaiming(true);
    try {
      const result = await copy.claim(trimmed);
      if (!result.success) {
        setError(result.error || 'Faucet claim failed.');
        toast({ variant: 'destructive', title: 'Claim failed', description: result.error || 'Faucet claim failed.' });
        return;
      }
      setSignature(result.signature ?? null);
      toast({ title: copy.toastTitle, description: copy.toastDescription });
    } finally {
      setClaiming(false);
    }
  }

  return (
    <div
      ref={overlayRef}
      onClick={(e) => {
        if (e.target === overlayRef.current) onClose();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        backgroundColor: 'rgba(0, 0, 0, 0.45)',
        backdropFilter: 'blur(5px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '16px',
      }}
    >
      <div
        style={{
          position: 'relative',
          width: '100%',
          maxWidth: '380px',
          backgroundColor: 'hsl(var(--surface-0))',
          border: '1px solid hsl(var(--border))',
          borderRadius: 'var(--radius-xl)',
          boxShadow: 'var(--shadow-xl)',
          overflow: 'hidden',
          fontFamily: 'var(--font-body)',
          animation: 'nave-modal-in 220ms cubic-bezier(0.16, 1, 0.3, 1) both',
        }}
      >
        {/* Header row */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '20px 20px 0 22px',
          }}
        >
          <span
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: '20px',
              fontWeight: 400,
              color: 'hsl(var(--foreground))',
              letterSpacing: '-0.01em',
              lineHeight: 1,
            }}
          >
            {copy.title}
          </span>

          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              width: '28px',
              height: '28px',
              borderRadius: '50%',
              border: '1px solid hsl(var(--border))',
              backgroundColor: 'hsl(var(--surface-1))',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              color: 'hsl(var(--muted-foreground))',
              transition: 'background-color 120ms ease, color 120ms ease',
              flexShrink: 0,
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'hsl(var(--surface-2))';
              (e.currentTarget as HTMLButtonElement).style.color = 'hsl(var(--foreground))';
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'hsl(var(--surface-1))';
              (e.currentTarget as HTMLButtonElement).style.color = 'hsl(var(--muted-foreground))';
            }}
          >
            <Fi icon="xmark" style={{ fontSize: '13px' }} />
          </button>
        </div>

        {/* Subtitle */}
        <p
          style={{
            margin: '10px 22px 20px 22px',
            fontSize: '13px',
            color: 'hsl(var(--muted-foreground))',
            lineHeight: 1.55,
          }}
        >
          {copy.subtitle}
        </p>

        <div style={{ height: '1px', backgroundColor: 'hsl(var(--border))', margin: '0 0 16px 0' }} />

        {/* Body */}
        <div style={{ padding: '0 22px 22px 22px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {signature ? (
            <>
              <div
                className="flex items-start gap-2.5 p-3 rounded-lg"
                style={{ backgroundColor: 'hsl(var(--accent-muted))', border: '1px solid hsl(var(--border-strong))' }}
              >
                <Fi icon="circle-check" style={{ fontSize: '13px', color: 'hsl(var(--accent))', flexShrink: 0, marginTop: '2px' }} />
                <div style={{ fontSize: '12.5px', color: 'hsl(var(--accent-muted-foreground))', lineHeight: 1.55 }}>
                  {copy.successMessage}
                </div>
              </div>
              <a
                href={solanaExplorerTx(signature)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 justify-center"
                style={{
                  fontSize: '12.5px',
                  color: 'hsl(var(--primary))',
                  fontFamily: 'var(--font-mono)',
                  padding: '8px 0',
                }}
              >
                View transaction
                <Fi icon="arrow-up-right-from-square" style={{ fontSize: '10px' }} />
              </a>
              <button
                onClick={() => {
                  setSignature(null);
                  setAddress('');
                }}
                style={{
                  width: '100%',
                  padding: '10px 14px',
                  borderRadius: 'var(--radius)',
                  border: '1px solid hsl(var(--border))',
                  backgroundColor: 'hsl(var(--surface-1))',
                  color: 'hsl(var(--foreground))',
                  fontFamily: 'var(--font-body)',
                  fontSize: '13px',
                  fontWeight: 500,
                  cursor: 'pointer',
                }}
              >
                Claim to another address
              </button>
            </>
          ) : (
            <>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <label
                  htmlFor="nave-faucet-address"
                  style={{ fontSize: '12px', fontWeight: 500, color: 'hsl(var(--foreground))' }}
                >
                  Solana devnet address
                </label>
                <input
                  id="nave-faucet-address"
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  placeholder="Enter a Solana address…"
                  className="w-full px-3 py-2.5 rounded-lg border outline-none"
                  style={{
                    fontSize: '13px',
                    fontFamily: 'var(--font-mono)',
                    backgroundColor: 'hsl(var(--surface-1))',
                    borderColor: 'hsl(var(--border))',
                    color: 'hsl(var(--foreground))',
                  }}
                />
                {trimmed.length > 0 && !addressValid && (
                  <p style={{ fontSize: '12px', color: 'hsl(var(--destructive))' }}>
                    Enter a valid Solana address.
                  </p>
                )}
              </div>

              {error && (
                <div
                  className="flex items-start gap-2.5 p-3 rounded-lg"
                  style={{ backgroundColor: 'hsl(var(--destructive-muted))', border: '1px solid hsl(0 72% 80%)' }}
                >
                  <Fi icon="circle-xmark" style={{ fontSize: '13px', color: 'hsl(var(--destructive))', flexShrink: 0, marginTop: '2px' }} />
                  <span style={{ fontSize: '12.5px', color: 'hsl(var(--destructive))', lineHeight: 1.5 }}>{error}</span>
                </div>
              )}

              <button
                onClick={() => void handleClaim()}
                disabled={!addressValid || claiming}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '8px',
                  width: '100%',
                  padding: '11px 14px',
                  borderRadius: 'var(--radius)',
                  border: 'none',
                  backgroundColor: !addressValid || claiming ? 'hsl(var(--muted))' : 'hsl(var(--primary))',
                  color: !addressValid || claiming ? 'hsl(var(--muted-foreground))' : 'hsl(var(--primary-foreground))',
                  fontFamily: 'var(--font-body)',
                  fontSize: '13.5px',
                  fontWeight: 600,
                  cursor: !addressValid || claiming ? 'not-allowed' : 'pointer',
                }}
              >
                <Fi icon={claiming ? 'spinner' : 'droplet'} className={claiming ? 'animate-spin' : ''} style={{ fontSize: '12px' }} />
                {claiming ? 'Sending…' : copy.claimLabel}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
