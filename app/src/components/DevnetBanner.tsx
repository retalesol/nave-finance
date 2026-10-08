import { useState } from 'react';
import { toast } from '../hooks/use-toast';
import Fi from './Fi';
import { useChain } from '../hooks/useChain';
import type { ChainFamily } from '../lib/chain/types';
import { EVM_RPC_URLS } from '../lib/programConfig';

type EthProvider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};

function getProvider(): EthProvider | null {
  return (window as unknown as { ethereum?: EthProvider }).ethereum ?? null;
}

/**
 * Add or switch to an EVM chain — same pattern Chainlist uses:
 * 1. eth_requestAccounts → wakes MetaMask if locked
 * 2. wallet_switchEthereumChain → instant if chain already known
 * 3. wallet_addEthereumChain on 4902 → prompts user to add the chain
 */
async function addOrSwitchChain(chainId: string, addParams: {
  chainName: string;
  rpcUrls: string[];
  blockExplorerUrls: string[];
  nativeCurrency: { name: string; symbol: string; decimals: number };
}) {
  const provider = getProvider();
  if (!provider) {
    toast({
      variant: 'destructive',
      title: 'No EVM wallet',
      description: 'Install MetaMask (or another EVM wallet), then try again.',
    });
    return;
  }

  // Wake MetaMask / request account access so the popup surfaces
  try {
    await provider.request({ method: 'eth_requestAccounts' });
  } catch {
    // User denied account access — abort; don't switch chain without consent
    return;
  }

  // Switch if already added, or add if not
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] });
  } catch (switchErr: unknown) {
    const code = (switchErr as { code?: number })?.code;
    if (code === 4902 || code === -32603) {
      try {
        await provider.request({
          method: 'wallet_addEthereumChain',
          params: [{ chainId, ...addParams }],
        });
      } catch (addErr: unknown) {
        const addCode = (addErr as { code?: number })?.code;
        if (addCode !== 4001) { // 4001 = user rejected, not an error
          console.error('[DevnetBanner] wallet_addEthereumChain failed:', addErr);
        }
      }
    } else if ((switchErr as { code?: number })?.code !== 4001) {
      console.error('[DevnetBanner] wallet_switchEthereumChain failed:', switchErr);
    }
  }
}

const NETWORKS: { label: string; family: ChainFamily; action: () => Promise<void> | void; tooltip: string }[] = [
  {
    label: 'Solana (Devnet)',
    family: 'solana',
    action: () => { window.open('https://help.phantom.com/hc/en-us/articles/5997313271699-Turn-on-devnet-or-testnet-mode-in-Phantom', '_blank'); },
    tooltip: 'How to enable Devnet in Phantom wallet',
  },
  {
    label: 'Ethereum (Sepolia)',
    family: 'ethereum',
    action: () => addOrSwitchChain('0xaa36a7', {
      chainName: 'Ethereum Sepolia',
      rpcUrls: [EVM_RPC_URLS[11155111] ?? 'https://ethereum-sepolia-rpc.publicnode.com'],
      blockExplorerUrls: ['https://sepolia.etherscan.io'],
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    }),
    tooltip: 'Add / switch to Ethereum Sepolia in your EVM wallet',
  },
  {
    label: 'Base (Mainnet)',
    family: 'base',
    action: () => addOrSwitchChain('0x2105', {
      chainName: 'Base',
      rpcUrls: [EVM_RPC_URLS[8453] ?? 'https://mainnet.base.org'],
      blockExplorerUrls: ['https://basescan.org'],
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    }),
    tooltip: 'Add / switch to Base mainnet in your EVM wallet',
  },
  {
    label: 'Robinhood (Mainnet)',
    family: 'robinhood',
    // 4663 = 0x1237 — Robinhood Chain mainnet (Arbitrum Nitro L2, bridge/stake only).
    action: () => addOrSwitchChain('0x1237', {
      chainName: 'Robinhood Chain',
      rpcUrls: [EVM_RPC_URLS[4663] ?? 'https://rpc.mainnet.chain.robinhood.com'],
      blockExplorerUrls: ['https://explorer.mainnet.chain.robinhood.com'],
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    }),
    tooltip: 'Add / switch to Robinhood Chain mainnet in your EVM wallet',
  },
];

const LINKS = [
  { label: 'Sepolia ETH (PoW Faucet)', url: 'https://sepolia-faucet.pk910.de/' },
  { label: 'Bridge ETH to Base', url: 'https://bridge.base.org/' },
  { label: 'Solana Devnet Faucets', url: 'https://solana.com/developers/guides/getstarted/solana-token-airdrop-and-faucets' },
];

const PERSIST_KEY = 'nave_network_banner_hidden_v4';

export default function DevnetBanner() {
  const { setChainFamily, chainFamily } = useChain();
  const [permanentlyHidden] = useState(
    () => typeof localStorage !== 'undefined' && localStorage.getItem(PERSIST_KEY) === '1',
  );
  const [sessionHidden, setSessionHidden] = useState(false);
  const [loadingKey, setLoadingKey] = useState<string | null>(null);

  if (permanentlyHidden || sessionHidden) return null;

  function hideForever() {
    if (typeof localStorage !== 'undefined') localStorage.setItem(PERSIST_KEY, '1');
    setSessionHidden(true);
  }

  async function handleNetwork(label: string, family: ChainFamily, action: () => Promise<void> | void) {
    setLoadingKey(label);
    setChainFamily(family);
    try {
      await action();
    } finally {
      setLoadingKey(null);
    }
  }

  return (
    <div
      style={{
        backgroundColor: '#fef3c7',
        borderBottom: '1px solid #fcd34d',
        padding: '8px 16px',
        lineHeight: 1,
      }}
    >
      <div className="max-w-6xl mx-auto" style={{ fontSize: '12px' }}>

        {/* Row 1: Badge + label + dismiss controls (always on same line) */}
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 flex-shrink-0" style={{ color: '#92400e', fontWeight: 500 }}>
            <span style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.06em', backgroundColor: '#d97706', color: 'white', padding: '2px 5px', borderRadius: '3px' }}>
              MIXED NETWORKS
            </span>
            <span className="hidden xs:inline">Solana Devnet · Ethereum Sepolia · Base &amp; Robinhood Mainnet —</span>
            <span className="xs:hidden">Mixed nets —</span>
          </span>
          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              type="button"
              onClick={hideForever}
              className="flex-shrink-0 transition-colors"
              style={{ fontSize: '10.5px', color: '#b45309', whiteSpace: 'nowrap', textDecoration: 'underline', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
              onMouseEnter={e => (e.currentTarget.style.color = '#78350f')}
              onMouseLeave={e => (e.currentTarget.style.color = '#b45309')}
            >
              Don't show again
            </button>
            <button
              type="button"
              onClick={() => setSessionHidden(true)}
              className="flex-shrink-0 transition-colors"
              title="Close (shows again on next visit)"
              style={{ color: '#b45309', background: 'none', border: 'none', cursor: 'pointer', padding: '2px', lineHeight: 1 }}
              onMouseEnter={e => (e.currentTarget.style.color = '#78350f')}
              onMouseLeave={e => (e.currentTarget.style.color = '#b45309')}
            >
              <Fi icon="xmark" style={{ fontSize: '12px' }} />
            </button>
          </div>
        </div>

        {/* Row 2: Network buttons */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 mt-1.5">
          {NETWORKS.map(({ label, family, action, tooltip }) => {
            const loading = loadingKey === label;
            const active = chainFamily === family;
            return (
              <button
                key={label}
                type="button"
                disabled={loading || active}
                onClick={() => handleNetwork(label, family, action)}
                title={tooltip}
                className="flex items-center gap-1 flex-shrink-0 transition-colors"
                style={{ fontSize: '11.5px', fontWeight: 500, color: '#78350f', border: '1px solid #fbbf24', backgroundColor: active || loading ? '#fde68a' : '#fffbeb', padding: '3px 7px', borderRadius: '5px', cursor: loading ? 'wait' : active ? 'default' : 'pointer', opacity: loading ? 0.8 : 1 }}
                onMouseEnter={e => { if (!loading) { e.currentTarget.style.backgroundColor = '#fef3c7'; e.currentTarget.style.borderColor = '#d97706'; } }}
                onMouseLeave={e => { if (!loading) { e.currentTarget.style.backgroundColor = '#fffbeb'; e.currentTarget.style.borderColor = '#fbbf24'; } }}
              >
                <Fi icon={loading ? 'circle-notch' : 'plus'} style={{ fontSize: '9px', color: '#d97706' }} className={loading ? 'animate-spin' : ''} />
                {label}
              </button>
            );
          })}
        </div>

        {/* Row 3: Resource links — hidden on mobile to keep the banner compact */}
        <div className="hidden sm:flex flex-wrap items-center gap-x-3 mt-1.5">
          <span style={{ color: '#fbbf24' }}>·</span>
          {LINKS.map(({ label, url }) => (
            <a
              key={url}
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 flex-shrink-0 no-underline transition-colors"
              style={{ color: '#b45309', fontSize: '11.5px' }}
              onMouseEnter={e => (e.currentTarget.style.color = '#78350f')}
              onMouseLeave={e => (e.currentTarget.style.color = '#b45309')}
            >
              <Fi icon="arrow-up-right-from-square" style={{ fontSize: '9px' }} />
              {label}
            </a>
          ))}
        </div>

      </div>
    </div>
  );
}
