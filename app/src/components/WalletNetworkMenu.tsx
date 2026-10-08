import { useEffect, useRef, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useAccount, useDisconnect, useSwitchChain } from 'wagmi';
import Fi from './Fi';
import ChainIcon from './ChainIcon';
import ConnectNetworkButton from './ConnectNetworkButton';
import { useChain } from '../hooks/useChain';
import { WALLET_CHAINS, isEvmChainId, type ChainFamily } from '../lib/chain/types';
import { activeEvmChainId, chainDisplayLabel } from '../lib/programConfig';

function shortenAddress(addr: string) {
  return addr.slice(0, 4) + '\u2026' + addr.slice(-4);
}

interface WalletNetworkMenuProps {
  /**
   * Optional override for network selection. When provided, the menu delegates
   * the whole network switch to this callback INSTEAD of its default
   * (setChainFamily + wallet chain switch) — used by pages that need extra
   * side effects on switch (e.g. NaveLayout confirms, clears the active DAO,
   * then must itself call setChainFamily + switchChainAsync). The menu still
   * closes itself after invoking it.
   */
  onNetworkSelect?: (family: ChainFamily) => void;
  /**
   * Networks offered in the picker. Homepage / lobby / DAO app pass Base+RH;
   * Bridge & Stake keep the full WALLET_CHAINS default.
   */
  chains?: readonly ChainFamily[];
}

/**
 * Shared header control: network icon + wallet pill with copy/disconnect, or a
 * Connect Wallet button that opens a network picker first, then the matching
 * wallet modal (Solana adapter vs RainbowKit). Used across Bridge/Stake,
 * Homepage, Treasuries, Dashboard, and DAO headers.
 */
export default function WalletNetworkMenu({
  onNetworkSelect,
  chains = WALLET_CHAINS,
}: WalletNetworkMenuProps = {}) {
  const { publicKey, disconnect: disconnectSolana } = useWallet();
  const { address: evmAddress, isConnected: evmConnected, chainId: connectedChainId } = useAccount();
  const { disconnect: disconnectEvm } = useDisconnect();
  const { switchChainAsync } = useSwitchChain();
  const { target, chainFamily, setChainFamily } = useChain();
  const offeredChains = chains.length > 0 ? chains : WALLET_CHAINS;

  const isEvm = target.kind === 'evm';
  const activeAddress = isEvm ? (evmAddress ?? '') : (publicKey?.toBase58() ?? '');
  const isConnected = isEvm ? evmConnected : !!publicKey;

  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, [open]);

  function handleCopy() {
    if (!activeAddress) return;
    navigator.clipboard.writeText(activeAddress);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  function handleDisconnect() {
    if (isEvm) {
      disconnectEvm();
    } else {
      disconnectSolana();
    }
    setOpen(false);
  }

  async function handleNetworkSelect(family: ChainFamily) {
    if (family === chainFamily) {
      setOpen(false);
      return;
    }
    if (onNetworkSelect) {
      onNetworkSelect(family);
      setOpen(false);
      return;
    }
    setChainFamily(family);
    if (family !== 'solana' && evmConnected) {
      const chainId = activeEvmChainId(family);
      if (connectedChainId !== chainId) {
        try {
          await switchChainAsync?.({ chainId });
        } catch {
          // Wallet rejected or cannot switch — chain family still updates for UI routing.
        }
      }
    }
    setOpen(false);
  }

  if (!isConnected || !activeAddress) {
    return (
      <ConnectNetworkButton
        label="Connect Wallet"
        chains={offeredChains}
        icon={<Fi icon="circle-user" style={{ fontSize: '13px' }} />}
        className="flex items-center gap-1.5 px-4 py-1.5 rounded-md font-medium transition-all"
        style={{
          backgroundColor: 'hsl(var(--primary))',
          color: 'hsl(var(--primary-foreground))',
          fontSize: '13px',
        }}
      />
    );
  }

  const networkLabel = isEvm && connectedChainId && isEvmChainId(connectedChainId)
    ? chainDisplayLabel(target.family)
    : chainDisplayLabel(chainFamily);

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-md border transition-colors"
        style={{
          fontSize: '12.5px',
          fontWeight: 500,
          color: 'hsl(var(--foreground))',
          backgroundColor: 'hsl(var(--surface-1))',
          borderColor: 'hsl(var(--border))',
          fontFamily: 'var(--font-mono)',
        }}
      >
        <ChainIcon family={chainFamily} size={14} />
        <span
          className="w-1.5 h-1.5 rounded-full flex-shrink-0"
          style={{ backgroundColor: 'hsl(var(--success))' }}
        />
        {shortenAddress(activeAddress)}
        <Fi icon="angle-down" style={{ fontSize: '10px' }} />
      </button>

      {open && (
        <div
          className="absolute right-0 top-full mt-1.5 w-52 rounded-lg border z-50 overflow-hidden"
          style={{
            backgroundColor: 'hsl(var(--card))',
            borderColor: 'hsl(var(--border))',
            boxShadow: 'var(--shadow-lg)',
          }}
        >
          <div
            className="px-3 py-2 border-b"
            style={{ borderColor: 'hsl(var(--border))' }}
          >
            <div style={{ fontSize: '10px', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'hsl(var(--muted-foreground))' }}>
              Network
            </div>
            <div className="flex items-center gap-2 mt-2">
              {offeredChains.map((family) => {
                const active = family === chainFamily;
                return (
                  <button
                    key={family}
                    type="button"
                    title={chainDisplayLabel(family)}
                    onClick={() => void handleNetworkSelect(family)}
                    className="flex items-center justify-center rounded-md border transition-colors"
                    style={{
                      width: 32,
                      height: 32,
                      borderColor: active ? 'hsl(var(--primary))' : 'hsl(var(--border))',
                      backgroundColor: active ? 'hsl(var(--surface-1))' : 'transparent',
                    }}
                  >
                    <ChainIcon family={family} size={16} />
                  </button>
                );
              })}
            </div>
            <div style={{ fontSize: '11px', color: 'hsl(var(--muted-foreground))', marginTop: 6 }}>
              {networkLabel}
            </div>
          </div>

          <button
            onClick={handleCopy}
            className="w-full flex items-center gap-2 px-3 py-2.5 text-left transition-colors"
            style={{ fontSize: '12.5px', color: 'hsl(var(--foreground))' }}
            onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'hsl(var(--surface-1))')}
            onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = '')}
          >
            <Fi icon={copied ? 'check' : 'copy'} style={{ fontSize: '12px' }} />
            {copied ? 'Copied' : 'Copy Address'}
          </button>
          <button
            onClick={handleDisconnect}
            className="w-full flex items-center gap-2 px-3 py-2.5 text-left transition-colors"
            style={{ fontSize: '12.5px', color: 'hsl(var(--destructive))' }}
            onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'hsl(var(--surface-1))')}
            onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = '')}
          >
            <Fi icon="right-from-bracket" style={{ fontSize: '12px' }} />
            Disconnect
          </button>
        </div>
      )}
    </div>
  );
}
