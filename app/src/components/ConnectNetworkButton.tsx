import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { useConnectModal } from '@rainbow-me/rainbowkit';
import Fi from './Fi';
import ChainIcon from './ChainIcon';
import { useChain } from '../hooks/useChain';
import {
  WALLET_CHAINS,
  type ChainFamily,
} from '../lib/chain/types';
import { chainDisplayLabel } from '../lib/programConfig';

function walletHintFor(family: ChainFamily): string {
  return family === 'solana' ? 'Phantom, Solflare…' : 'MetaMask, WalletConnect…';
}

interface ConnectNetworkButtonProps {
  /** Button label when the menu is closed. */
  label?: string;
  className?: string;
  style?: CSSProperties;
  /** Optional leading icon inside the trigger. */
  icon?: ReactNode;
  /** Align the dropdown to the trigger's start or end edge. */
  menuAlign?: 'left' | 'right';
  /** Full-width trigger (bridge/stake form CTAs). */
  fullWidth?: boolean;
  /** Networks offered in the picker. Defaults to all Bridge/Stake chains. */
  chains?: readonly ChainFamily[];
}

/**
 * Connect CTA that always asks for a network first, then opens the matching
 * wallet modal (Solana adapter vs RainbowKit). Use this anywhere a user might
 * need MetaMask/EVM — never open the Solana modal as the only path.
 */
export default function ConnectNetworkButton({
  label = 'Connect Wallet',
  className = '',
  style,
  icon,
  menuAlign = 'right',
  fullWidth = false,
  chains = WALLET_CHAINS,
}: ConnectNetworkButtonProps) {
  const { setVisible } = useWalletModal();
  const { openConnectModal } = useConnectModal();
  const { setChainFamily } = useChain();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const offeredChains = chains.length > 0 ? chains : WALLET_CHAINS;

  useEffect(() => {
    function handleOutside(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, [open]);

  function handleConnectOnNetwork(family: ChainFamily) {
    setOpen(false);
    setChainFamily(family);
    // Close any leftover Solana modal before opening RainbowKit.
    setVisible(false);
    // Defer so chain context + modal providers settle before open.
    window.setTimeout(() => {
      if (family === 'solana') {
        setVisible(true);
        return;
      }
      if (openConnectModal) {
        openConnectModal();
        return;
      }
      console.error(
        '[wallet] RainbowKit connect modal unavailable — check WalletConnect project id / WagmiProvider.',
      );
    }, 50);
  }

  return (
    <div
      className={`relative ${fullWidth ? 'w-full' : ''}`}
      ref={rootRef}
      style={fullWidth ? { width: '100%' } : undefined}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={className}
        style={style}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        {icon}
        <span>{label}</span>
        <Fi icon="angle-down" style={{ fontSize: '10px', opacity: 0.9 }} />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute top-full mt-1.5 w-56 rounded-lg border z-50 overflow-hidden"
          style={{
            [menuAlign === 'left' ? 'left' : 'right']: 0,
            backgroundColor: 'hsl(var(--card))',
            borderColor: 'hsl(var(--border))',
            boxShadow: 'var(--shadow-lg)',
            width: fullWidth ? '100%' : undefined,
            minWidth: fullWidth ? undefined : 224,
          }}
        >
          <div
            className="px-3 py-2 border-b"
            style={{
              borderColor: 'hsl(var(--border))',
              fontSize: '10px',
              fontWeight: 600,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              color: 'hsl(var(--muted-foreground))',
            }}
          >
            Select network
          </div>
          {offeredChains.map((family) => (
            <button
              key={family}
              type="button"
              role="menuitem"
              onClick={() => handleConnectOnNetwork(family)}
              className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left transition-colors"
              style={{ fontSize: '13px', color: 'hsl(var(--foreground))' }}
              onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'hsl(var(--surface-1))')}
              onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = '')}
            >
              <ChainIcon family={family} size={18} />
              <span className="flex flex-col min-w-0">
                <span style={{ fontWeight: 500 }}>{chainDisplayLabel(family)}</span>
                <span style={{ fontSize: '11px', color: 'hsl(var(--muted-foreground))' }}>
                  {walletHintFor(family)}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
