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

  // Auto-close once a connection actually succeeds — otherwise stay open so
  // any error (wallet not installed, rejected connection, popup blocked,
  // timeout, ...) reported via `walletErrorStore` is visible to the user
  // instead of the modal silently disappearing.
  useEffect(() => {
    if (visible && connected) {
      clearError();
      setVisible(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, connected]);

  if (!visible) return null;

  // Separate detected vs other wallets. Hide MetaMask from the Solana modal —
  // Wallet Standard can surface it, but MetaMask Solana often throws
  // WalletAccountError when the Solana account isn't set up; EVM MetaMask is
  // connected via RainbowKit when the network switcher is on ethereum/base/robinhood.
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
      // Selecting an adapter that isn't installed never triggers a connect
      // attempt (and therefore never emits an `error` event) — surface this
      // directly instead of silently closing the modal.
      setError(`${walletName} isn't installed. Install it from the wallet's website, then refresh this page and try again.`);
      return;
    }
    // Leave the modal open — the wallet-adapter's auto-connect flow now takes
    // over; success closes the modal above, failure surfaces via `onError` in
    // App.tsx into the shared error store below.
    select(walletName);
  }

  return (
    /* Backdrop */
    <div
      ref={overlayRef}
      onClick={e => { if (e.target === overlayRef.current) closeModal(); }}
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
      {/* Modal card */}
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
        {/* ── Header row ─────────────────────────────────── */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '20px 20px 0 22px',
          }}
        >
          {/* "Nave Connection" — same font as logo */}
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
            Nave Connection
          </span>

          {/* Close button with fa-xmark */}
          <button
            onClick={() => closeModal()}
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
            onMouseEnter={e => {
              (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'hsl(var(--surface-2))';
              (e.currentTarget as HTMLButtonElement).style.color = 'hsl(var(--foreground))';
            }}
            onMouseLeave={e => {
              (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'hsl(var(--surface-1))';
              (e.currentTarget as HTMLButtonElement).style.color = 'hsl(var(--muted-foreground))';
            }}
          >
            <Fi icon="xmark" style={{ fontSize: '13px' }} />
          </button>
        </div>

        {/* ── Subtitle ───────────────────────────────────── */}
        <p
          style={{
            margin: '10px 22px 20px 22px',
            fontSize: '13px',
            color: 'hsl(var(--muted-foreground))',
            lineHeight: 1.55,
          }}
        >
          Connect your Solana wallet (Phantom, Solflare, etc.) to continue.
        </p>

        {/* ── Connection error ──────────────────────────────
             Wallet-not-installed, rejected-connection, and other adapter
             failures surface here instead of failing silently. */}
        {error && (
          <div
            role="alert"
            style={{
              margin: '0 22px 16px 22px',
              padding: '10px 12px',
              borderRadius: 'var(--radius)',
              border: '1px solid hsl(var(--destructive) / 0.35)',
              backgroundColor: 'hsl(var(--destructive) / 0.08)',
              color: 'hsl(var(--destructive))',
              fontSize: '12.5px',
              lineHeight: 1.5,
            }}
          >
            {error}
          </div>
        )}

        {/* ── Divider ────────────────────────────────────── */}
        <div style={{ height: '1px', backgroundColor: 'hsl(var(--border))', margin: '0 0 16px 0' }} />

        {/* ── Wallet list ────────────────────────────────── */}
        <div style={{ padding: '0 14px 16px 14px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {(detected.length > 0 ? detected : others.length > 0 ? others : wallets.filter((w) => isSolanaCompatible(w.adapter.name))).map(({ adapter }) => (
            <button
              key={adapter.name}
              onClick={() => handleSelect(adapter.name)}
              disabled={connecting}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                width: '100%',
                padding: '10px 14px',
                borderRadius: 'var(--radius)',
                border: '1px solid hsl(var(--border))',
                backgroundColor: 'hsl(var(--surface-1))',
                color: 'hsl(var(--foreground))',
                fontFamily: 'var(--font-body)',
                fontSize: '13.5px',
                fontWeight: 500,
                cursor: connecting ? 'wait' : 'pointer',
                textAlign: 'left',
                transition: 'border-color 120ms ease, background-color 120ms ease',
              }}
              onMouseEnter={e => {
                (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'hsl(var(--surface-2))';
                (e.currentTarget as HTMLButtonElement).style.borderColor = 'hsl(var(--border-strong))';
              }}
              onMouseLeave={e => {
                (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'hsl(var(--surface-1))';
                (e.currentTarget as HTMLButtonElement).style.borderColor = 'hsl(var(--border))';
              }}
            >
              {adapter.icon && (
                <img
                  src={adapter.icon}
                  alt={adapter.name}
                  style={{ width: '26px', height: '26px', borderRadius: '6px', flexShrink: 0 }}
                />
              )}
              <span style={{ flex: 1 }}>{adapter.name}</span>
              {(adapter.readyState === 'Installed' || adapter.readyState === 'Loadable') && (
                <span
                  style={{
                    fontSize: '11px',
                    color: 'hsl(var(--muted-foreground))',
                    fontWeight: 400,
                  }}
                >
                  Detected
                </span>
              )}
            </button>
          ))}

          {/* Show remaining wallets if there are detected ones */}
          {detected.length > 0 && others.length > 0 && (
            <>
              <div
                style={{
                  margin: '6px 0 2px',
                  fontSize: '11px',
                  color: 'hsl(var(--muted-foreground))',
                  fontWeight: 500,
                  letterSpacing: '0.04em',
                  textTransform: 'uppercase',
                  paddingLeft: '2px',
                }}
              >
                More options
              </div>
              {others.map(({ adapter }) => (
                <button
                  key={adapter.name}
                  onClick={() => handleSelect(adapter.name)}
                  disabled={connecting}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '12px',
                    width: '100%',
                    padding: '9px 14px',
                    borderRadius: 'var(--radius)',
                    border: '1px solid hsl(var(--border))',
                    backgroundColor: 'transparent',
                    color: 'hsl(var(--foreground))',
                    fontFamily: 'var(--font-body)',
                    fontSize: '13px',
                    fontWeight: 400,
                    cursor: connecting ? 'wait' : 'pointer',
                    textAlign: 'left',
                    transition: 'border-color 120ms ease, background-color 120ms ease',
                  }}
                  onMouseEnter={e => {
                    (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'hsl(var(--surface-1))';
                    (e.currentTarget as HTMLButtonElement).style.borderColor = 'hsl(var(--border-strong))';
                  }}
                  onMouseLeave={e => {
                    (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent';
                    (e.currentTarget as HTMLButtonElement).style.borderColor = 'hsl(var(--border))';
                  }}
                >
                  {adapter.icon && (
                    <img
                      src={adapter.icon}
                      alt={adapter.name}
                      style={{ width: '22px', height: '22px', borderRadius: '5px', flexShrink: 0 }}
                    />
                  )}
                  <span style={{ flex: 1 }}>{adapter.name}</span>
                </button>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
