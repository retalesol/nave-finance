import { useEffect, useRef } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { WalletReadyState } from '@solana/wallet-adapter-base';
import Fi from './Fi';
import { useWalletConnectionError } from '../hooks/useWalletConnectionError';

/**
 * Fully custom wallet connection modal that replaces the default
 * @solana/wallet-adapter-react-ui modal entirely.
 *
 * Mount once inside WalletModalProvider in App.tsx.
 * Reads `visible` / `setVisible` from the modal context so every
 * existing `setVisible(true)` call in the app continues to work.
 */
export default function NaveWalletModal() {
  const { visible, setVisible } = useWalletModal();
  const { wallets, select, connecting, connected } = useWallet();
  const { error, setError, clearError } = useWalletConnectionError();
  const overlayRef = useRef<HTMLDivElement>(null);

  function closeModal() {
    clearError();
    setVisible(false);
  }

  // Close on Escape key
  useEffect(() => {
    if (!visible) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') closeModal();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, setVisible]);

  // Prevent body scroll while open
  useEffect(() => {
    document.body.style.overflow = visible ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [visible]);

  // Auto-close once a connection actually succeeds
  useEffect(() => {
    if (visible && connected) {
      clearError();
      setVisible(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, connected]);

  if (!visible) return null;

  const SOLANA_WALLET_BLOCKLIST = new Set(['metamask', 'meta mask']);
  const isSolanaCompatible = (name: string) => !SOLANA_WALLET_BLOCKLIST.has(name.trim().toLowerCase());
  const detected = wallets.filter(
    (w) =>
      isSolanaCompatible(w.adapter.name) &&
      (w.readyState === 'Installed' || w.readyState === 'Loadable'),
  );
  const others = wallets.filter(
    (w) =>
      isSolanaCompatible(w.adapter.name) &&
      w.readyState !== 'Installed' &&
      w.readyState !== 'Loadable',
  );

  function handleSelect(walletName: Parameters<typeof select>[0]) {
    clearError();
    const target = wallets.find((w) => w.adapter.name === walletName);
    if (target && target.readyState !== WalletReadyState.Installed && target.readyState !== WalletReadyState.Loadable) {
      setError(`${walletName} isn't installed. Install it from the wallet's website, then refresh this page and try again.`);
      return;
    }
    select(walletName);
  }

  const primaryList =
    detected.length > 0
      ? detected
      : others.length > 0
      ? others
      : wallets.filter((w) => isSolanaCompatible(w.adapter.name));

  return (
    /* Backdrop */
    <div
      ref={overlayRef}
      onClick={e => { if (e.target === overlayRef.current) closeModal(); }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        backgroundColor: 'rgba(17, 24, 39, 0.48)',
        backdropFilter: 'blur(3px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '16px',
      }}
    >
      {/* Modal card */}
      <div
        style={{
          position: 'relative',
          width: '100%',
          maxWidth: '420px',
          backgroundColor: '#ffffff',
          border: '1px solid hsl(var(--border))',
          borderRadius: '18px',
          boxShadow: '0 24px 70px -12px rgba(17, 24, 39, 0.35)',
          overflow: 'hidden',
          fontFamily: 'var(--font-body)',
          animation: 'nave-modal-in 220ms cubic-bezier(0.16, 1, 0.3, 1) both',
        }}
      >
        {/* ── Header row ─────────────────────────────────── */}
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: '14px',
            padding: '20px 22px 0',
          }}
        >
          <div>
            <span
              style={{
                fontFamily: 'var(--font-display)',
                fontSize: '23px',
                fontWeight: 400,
                color: 'hsl(var(--foreground))',
                letterSpacing: '-0.02em',
                lineHeight: 1.15,
                display: 'block',
              }}
            >
              Nave Connection
            </span>
            <p
              style={{
                margin: '4px 0 0',
                fontSize: '13px',
                color: 'hsl(var(--muted-foreground))',
                lineHeight: 1.5,
              }}
            >
              Connect your Solana wallet (Phantom, Solflare, etc.) to continue.
            </p>
          </div>

          <button
            onClick={() => closeModal()}
            aria-label="Close"
            style={{
              width: '32px',
              height: '32px',
              borderRadius: '50%',
              border: '1px solid hsl(var(--surface-2))',
              backgroundColor: 'hsl(var(--background))',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              color: 'hsl(var(--muted-foreground))',
              transition: 'border-color 120ms ease, color 120ms ease',
              flexShrink: 0,
            }}
            onMouseEnter={e => {
              (e.currentTarget as HTMLButtonElement).style.borderColor = 'hsl(var(--border))';
              (e.currentTarget as HTMLButtonElement).style.color = 'hsl(var(--foreground))';
            }}
            onMouseLeave={e => {
              (e.currentTarget as HTMLButtonElement).style.borderColor = 'hsl(var(--surface-2))';
              (e.currentTarget as HTMLButtonElement).style.color = 'hsl(var(--muted-foreground))';
            }}
          >
            <Fi icon="xmark" style={{ fontSize: '14px' }} />
          </button>
        </div>

        {/* ── Body ───────────────────────────────────────── */}
        <div style={{ padding: '18px 22px 22px' }}>
          {error && (
            <div
              role="alert"
              style={{
                marginBottom: '14px',
                padding: '10px 12px',
                borderRadius: '10px',
                border: '1px solid hsl(var(--destructive) / 0.35)',
                backgroundColor: 'hsl(var(--destructive-muted))',
                color: 'hsl(var(--destructive))',
                fontSize: '12.5px',
                lineHeight: 1.5,
              }}
            >
              {error}
            </div>
          )}

          {/* ── Wallet list (hairline rows) ──────────────── */}
          <div style={{ borderTop: '1px solid hsl(var(--surface-2))' }}>
            {primaryList.map(({ adapter }, idx) => (
              <button
                key={adapter.name}
                onClick={() => handleSelect(adapter.name)}
                disabled={connecting}
                className="group"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '12px',
                  width: '100%',
                  padding: '12px 4px',
                  borderBottom:
                    idx < primaryList.length - 1 || (detected.length > 0 && others.length > 0)
                      ? '1px solid hsl(var(--surface-2))'
                      : 'none',
                  backgroundColor: 'transparent',
                  color: 'hsl(var(--foreground))',
                  fontFamily: 'var(--font-body)',
                  fontSize: '14px',
                  fontWeight: 500,
                  cursor: connecting ? 'wait' : 'pointer',
                  textAlign: 'left',
                  transition: 'color 120ms ease',
                }}
              >
                {adapter.icon && (
                  <img
                    src={adapter.icon}
                    alt={adapter.name}
                    style={{ width: '24px', height: '24px', borderRadius: '6px', flexShrink: 0 }}
                  />
                )}
                <span className="group-hover:text-brass transition-colors" style={{ flex: 1 }}>
                  {adapter.name}
                </span>
                {(adapter.readyState === 'Installed' || adapter.readyState === 'Loadable') && (
                  <span
                    style={{
                      fontSize: '12px',
                      color: 'hsl(var(--success))',
                      fontWeight: 600,
                    }}
                  >
                    Detected
                  </span>
                )}
              </button>
            ))}

            {detected.length > 0 && others.length > 0 && (
              <>
                <div
                  className="nave-label"
                  style={{
                    margin: '14px 0 6px',
                    paddingLeft: '4px',
                  }}
                >
                  More options
                </div>
                {others.map(({ adapter }, idx) => (
                  <button
                    key={adapter.name}
                    onClick={() => handleSelect(adapter.name)}
                    disabled={connecting}
                    className="group"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '12px',
                      width: '100%',
                      padding: '11px 4px',
                      borderBottom: idx < others.length - 1 ? '1px solid hsl(var(--surface-2))' : 'none',
                      backgroundColor: 'transparent',
                      color: 'hsl(var(--foreground))',
                      fontFamily: 'var(--font-body)',
                      fontSize: '13.5px',
                      fontWeight: 400,
                      cursor: connecting ? 'wait' : 'pointer',
                      textAlign: 'left',
                    }}
                  >
                    {adapter.icon && (
                      <img
                        src={adapter.icon}
                        alt={adapter.name}
                        style={{ width: '22px', height: '22px', borderRadius: '5px', flexShrink: 0 }}
                      />
                    )}
                    <span className="group-hover:text-brass transition-colors" style={{ flex: 1 }}>
                      {adapter.name}
                    </span>
                  </button>
                ))}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
