import { useRef, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useAccount, useDisconnect } from 'wagmi';
import Fi from './Fi';
import { NaveMenu, NaveMenuItem } from './NaveMenu';
import ChainIcon from './ChainIcon';
import ConnectNetworkButton from './ConnectNetworkButton';
import { useChain } from '../hooks/useChain';
import { WALLET_CHAINS, type ChainFamily } from '../lib/chain/types';
import { activeEvmChainId, chainDisplayLabel } from '../lib/programConfig';
import { ensureWalletOnChain } from '../lib/evm/ensureWalletChain';

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
  /**
   * Dashboard account menu. Homepage omits this and keeps the chain list.
   * Network opens a side menu; settings, copy, and disconnect stay in the menu.
   */
  account?: {
    role: string;
    rights: string;
    onSettings: () => void;
  };
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
  account,
}: WalletNetworkMenuProps = {}) {
  const { publicKey, disconnect: disconnectSolana } = useWallet();
  const { address: evmAddress, isConnected: evmConnected, chainId: connectedChainId } = useAccount();
  const { disconnect: disconnectEvm } = useDisconnect();
  const { target, chainFamily, setChainFamily } = useChain();
  const offeredChains = chains.length > 0 ? chains : WALLET_CHAINS;

  const isEvm = target.kind === 'evm';
  const activeAddress = isEvm ? (evmAddress ?? '') : (publicKey?.toBase58() ?? '');
  const isConnected = isEvm ? evmConnected : !!publicKey;

  const [open, setOpen] = useState(false);
  const [networksOpen, setNetworksOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

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
          await ensureWalletOnChain(chainId);
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
        className="flex items-center gap-1.5 px-3.5 py-2 rounded-[9px] font-semibold transition-all"
        style={{
          backgroundColor: '#111827',
          color: '#ffffff',
          fontSize: '13px',
        }}
      />
    );
  }

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 rounded-full border transition-colors"
        style={{
          padding: '6px 11px',
          fontSize: '12.5px',
          fontWeight: 500,
          color: 'hsl(var(--muted-foreground))',
          backgroundColor: '#ffffff',
          borderColor: open ? 'hsl(var(--border-strong))' : 'hsl(var(--border))',
          fontFamily: 'var(--font-mono)',
        }}
        onMouseEnter={e => (e.currentTarget.style.borderColor = 'hsl(var(--border-strong))')}
        onMouseLeave={e => (e.currentTarget.style.borderColor = open ? 'hsl(var(--border-strong))' : 'hsl(var(--border))')}
      >
        <span
          className="rounded-full flex-shrink-0"
          style={{ width: '6px', height: '6px', backgroundColor: 'hsl(var(--success))' }}
        />
        <ChainIcon family={chainFamily} size={13} />
        <span style={{ color: 'hsl(var(--foreground))' }}>{shortenAddress(activeAddress)}</span>
        <span style={{ fontSize: '10px', color: 'hsl(var(--faint))' }}>⌄</span>
      </button>

      <NaveMenu
        open={open}
        onClose={() => {
          setNetworksOpen(false);
          setOpen(false);
        }}
        anchorRef={menuRef}
        align="right"
        minWidth={account ? 260 : 220}
        overflowVisible={!!account}
      >
        {account ? (
          <>
            <div style={{ padding: '8px 10px 6px', display: 'grid', gap: 6 }}>
              <div className="flex items-center justify-between gap-3" style={{ fontSize: 13 }}>
                <span style={{ color: '#6B7280' }}>Role</span>
                <span style={{ fontWeight: 600, color: '#111827' }}>{account.role}</span>
              </div>
              <div className="flex items-start justify-between gap-3" style={{ fontSize: 13 }}>
                <span style={{ color: '#6B7280', flexShrink: 0 }}>Rights</span>
                <span style={{ fontWeight: 500, color: '#111827', textAlign: 'right' }}>{account.rights}</span>
              </div>
            </div>
            <div
              style={{ position: 'relative' }}
              onMouseEnter={() => setNetworksOpen(true)}
              onMouseLeave={() => setNetworksOpen(false)}
            >
              <button
                type="button"
                className="nave-menu-item"
                aria-expanded={networksOpen}
                onFocus={() => setNetworksOpen(true)}
              >
                <span>Network</span>
                <span className="inline-flex items-center gap-1.5" style={{ color: '#111827', fontWeight: 500 }}>
                  <ChainIcon family={chainFamily} size={14} />
                  {chainDisplayLabel(chainFamily)}
                  <span aria-hidden style={{ color: '#9CA3AF' }}>‹</span>
                </span>
              </button>
              {networksOpen && (
                <div style={{ position: 'absolute', top: -4, right: '100%', paddingRight: 8 }}>
                  <div
                    role="menu"
                    style={{
                      minWidth: 200,
                      padding: 4,
                      background: '#ffffff',
                      border: '1px solid #E7E2D6',
                      borderRadius: 12,
                      boxShadow: '0 10px 28px -12px rgba(17, 24, 39, 0.28)',
                    }}
                  >
                    {offeredChains.map((family) => (
                      <button
                        key={family}
                        type="button"
                        role="menuitem"
                        className="nave-menu-item"
                        data-selected={family === chainFamily ? 'true' : 'false'}
                        onClick={() => void handleNetworkSelect(family)}
                      >
                        <span className="nave-menu-item-label inline-flex items-center gap-2">
                          <ChainIcon family={family} size={14} />
                          {chainDisplayLabel(family)}
                        </span>
                        {family === chainFamily ? <span className="nave-menu-check" aria-hidden>✓</span> : null}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <div style={{ height: 1, margin: '4px 8px', background: '#EFEAE0' }} />
            <NaveMenuItem onClick={() => { setOpen(false); account.onSettings(); }}>
              Settings
            </NaveMenuItem>
            <NaveMenuItem onClick={handleCopy}>
              {copied ? 'Copied' : 'Copy address'}
            </NaveMenuItem>
            <NaveMenuItem onClick={handleDisconnect}>
              <span style={{ color: '#B42318' }}>Disconnect</span>
            </NaveMenuItem>
          </>
        ) : (
          <>
            {offeredChains.map((family) => (
              <NaveMenuItem
                key={family}
                selected={family === chainFamily}
                onClick={() => void handleNetworkSelect(family)}
              >
                <span className="inline-flex items-center gap-2">
                  <ChainIcon family={family} size={14} />
                  {chainDisplayLabel(family)}
                </span>
              </NaveMenuItem>
            ))}
            <NaveMenuItem onClick={handleCopy}>
              {copied ? 'Copied' : 'Copy address'}
            </NaveMenuItem>
            <NaveMenuItem onClick={handleDisconnect}>
              Disconnect
            </NaveMenuItem>
          </>
        )}
      </NaveMenu>
    </div>
  );
}
