import { useState } from 'react';
import { toast } from '../hooks/use-toast';
import Fi from './Fi';
import { useChain } from '../hooks/useChain';
import type { ChainFamily } from '../lib/chain/types';
import { EVM_DEPLOYMENT_MODE } from '../lib/programConfig';
import { ARC_TESTNET_RPC_URL } from '../lib/evm/arcRpc';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';

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

type NetworkChip = { label: string; family: ChainFamily; action: () => Promise<void> | void; tooltip: string };

const SOLANA_DEVNET: NetworkChip = {
  label: 'Solana (Devnet)',
  family: 'solana',
  action: () => { window.open('https://help.phantom.com/hc/en-us/articles/5997313271699-Turn-on-devnet-or-testnet-mode-in-Phantom', '_blank'); },
  tooltip: 'How to enable Devnet in Phantom wallet',
};

const ETHEREUM_SEPOLIA: NetworkChip = {
  label: 'Ethereum (Sepolia)',
  family: 'ethereum',
  action: () => addOrSwitchChain('0xaa36a7', {
    chainName: 'Ethereum Sepolia',
    rpcUrls: ['https://ethereum-sepolia-rpc.publicnode.com'],
    blockExplorerUrls: ['https://sepolia.etherscan.io'],
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  }),
  tooltip: 'Add / switch to Ethereum Sepolia in your EVM wallet',
};

const BASE_MAINNET: NetworkChip = {
  label: 'Base (Mainnet)',
  family: 'base',
  action: () => addOrSwitchChain('0x2105', {
    chainName: 'Base',
    rpcUrls: ['https://mainnet.base.org'],
    blockExplorerUrls: ['https://basescan.org'],
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  }),
  tooltip: 'Add / switch to Base mainnet in your EVM wallet',
};

const BASE_SEPOLIA: NetworkChip = {
  label: 'Base (Base Sepolia)',
  family: 'base',
  action: () => addOrSwitchChain('0x14a34', {
    chainName: 'Base Sepolia',
    rpcUrls: ['https://sepolia.base.org'],
    blockExplorerUrls: ['https://sepolia.basescan.org'],
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  }),
  tooltip: 'Add / switch to Base Sepolia in your EVM wallet',
};

const ROBINHOOD_MAINNET: NetworkChip = {
  label: 'Robinhood (Mainnet)',
  family: 'robinhood',
  // 4663 = 0x1237 — Robinhood Chain mainnet (Arbitrum Nitro L2).
  action: () => addOrSwitchChain('0x1237', {
    chainName: 'Robinhood Chain',
    rpcUrls: ['https://rpc.mainnet.chain.robinhood.com'],
    blockExplorerUrls: ['https://explorer.mainnet.chain.robinhood.com'],
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  }),
  tooltip: 'Add / switch to Robinhood Chain mainnet in your EVM wallet',
};

const ROBINHOOD_TESTNET: NetworkChip = {
  label: 'Robinhood (Testnet)',
  family: 'robinhood',
  // 46630 = 0xb626.
  action: () => addOrSwitchChain('0xb626', {
    chainName: 'Robinhood Chain Testnet',
    rpcUrls: ['https://rpc.testnet.chain.robinhood.com'],
    blockExplorerUrls: ['https://explorer.testnet.chain.robinhood.com'],
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  }),
  tooltip: 'Add / switch to Robinhood Chain Testnet in your EVM wallet',
};

const ARC_TESTNET: NetworkChip = {
  label: 'Arc (Testnet)',
  family: 'arc',
  // 5042002 = 0x4cef52. Native gas is 18-decimal USDC, not ETH.
  action: () => addOrSwitchChain('0x4cef52', {
    chainName: 'Arc Testnet',
    rpcUrls: [ARC_TESTNET_RPC_URL],
    blockExplorerUrls: ['https://explorer.testnet.arc.io'],
    nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  }),
  tooltip: 'Add / switch to Arc Testnet. Gas is native USDC (18 decimals), not ETH.',
};

const NETWORKS: NetworkChip[] = EVM_DEPLOYMENT_MODE === 'testnet'
  ? [SOLANA_DEVNET, ETHEREUM_SEPOLIA, BASE_SEPOLIA, ROBINHOOD_TESTNET, ARC_TESTNET]
  : EVM_DEPLOYMENT_MODE === 'mainnet'
    ? [BASE_MAINNET, ROBINHOOD_MAINNET]
    : [SOLANA_DEVNET, ETHEREUM_SEPOLIA, BASE_MAINNET, ROBINHOOD_MAINNET, ARC_TESTNET];

const BANNER_BADGE = EVM_DEPLOYMENT_MODE === 'testnet'
  ? 'TESTNET'
  : EVM_DEPLOYMENT_MODE === 'mainnet'
    ? 'MAINNET'
    : 'MIXED NETWORKS';

const BANNER_SUMMARY = EVM_DEPLOYMENT_MODE === 'testnet'
  ? 'Solana Devnet · Ethereum Sepolia · Base Sepolia · Robinhood & Arc Testnet —'
  : EVM_DEPLOYMENT_MODE === 'mainnet'
    ? 'Base & Robinhood mainnet —'
    : 'Solana Devnet · Ethereum Sepolia · Base & Robinhood Mainnet —';

type Faucet = { label: string; url: string };

const SOLANA_DEVNET_FAUCET: Faucet = { label: 'Solana Devnet SOL', url: 'https://faucet.quicknode.com/solana/devnet' };
const SEPOLIA_FAUCET: Faucet = { label: 'Ethereum Sepolia ETH', url: 'https://faucet.quicknode.com/ethereum/sepolia' };
const BASE_SEPOLIA_FAUCET: Faucet = { label: 'Base Sepolia ETH', url: 'https://faucet.quicknode.com/base/sepolia' };
const ROBINHOOD_TESTNET_FAUCET: Faucet = { label: 'Robinhood Testnet ETH', url: 'https://faucet.quicknode.com/robinhood/testnet' };
// QuickNode has no Arc faucet; Circle issues Arc testnet USDC (the gas token).
const ARC_TESTNET_FAUCET: Faucet = { label: 'Arc Testnet USDC (Circle)', url: 'https://faucet.circle.com/' };

const FAUCETS: Faucet[] = EVM_DEPLOYMENT_MODE === 'testnet'
  ? [SOLANA_DEVNET_FAUCET, SEPOLIA_FAUCET, BASE_SEPOLIA_FAUCET, ROBINHOOD_TESTNET_FAUCET, ARC_TESTNET_FAUCET]
  : EVM_DEPLOYMENT_MODE === 'mainnet'
    ? []
    : [SOLANA_DEVNET_FAUCET, SEPOLIA_FAUCET, ARC_TESTNET_FAUCET];

const DROPDOWN_TRIGGER_STYLE: React.CSSProperties = {
  fontSize: '11.5px',
  fontWeight: 500,
  color: '#78350f',
  border: '1px solid #fbbf24',
  backgroundColor: '#fffbeb',
  padding: '3px 8px',
  borderRadius: '5px',
  cursor: 'pointer',
};

const PERSIST_KEY = 'nave_network_banner_hidden_v5';

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
              {BANNER_BADGE}
            </span>
            <span className="hidden xs:inline">{BANNER_SUMMARY}</span>
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

        {/* Row 2: Network + Faucet dropdowns */}
        <div className="flex flex-wrap items-center gap-2 mt-1.5">
          <DropdownMenu>
            <DropdownMenuTrigger
              className="flex items-center gap-1 flex-shrink-0"
              style={{ ...DROPDOWN_TRIGGER_STYLE, cursor: loadingKey ? 'wait' : 'pointer' }}
              disabled={loadingKey !== null}
            >
              <Fi icon={loadingKey ? 'circle-notch' : 'globe'} style={{ fontSize: '9px', color: '#d97706' }} className={loadingKey ? 'animate-spin' : ''} />
              Network
              <Fi icon="chevron-down" style={{ fontSize: '8px', color: '#d97706' }} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {NETWORKS.map(({ label, family, action, tooltip }) => (
                <DropdownMenuItem
                  key={label}
                  title={tooltip}
                  onSelect={() => handleNetwork(label, family, action)}
                  className="text-xs cursor-pointer"
                >
                  {label}
                  {chainFamily === family && <Fi icon="check" style={{ fontSize: '9px', marginLeft: 'auto' }} />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {FAUCETS.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger className="flex items-center gap-1 flex-shrink-0" style={DROPDOWN_TRIGGER_STYLE}>
                <Fi icon="droplet" style={{ fontSize: '9px', color: '#d97706' }} />
                Faucet
                <Fi icon="chevron-down" style={{ fontSize: '8px', color: '#d97706' }} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {FAUCETS.map(({ label, url }) => (
                  <DropdownMenuItem
                    key={url}
                    onSelect={() => { window.open(url, '_blank', 'noopener,noreferrer'); }}
                    className="text-xs cursor-pointer"
                  >
                    {label}
                    <Fi icon="arrow-up-right-from-square" style={{ fontSize: '9px', marginLeft: 'auto' }} />
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

      </div>
    </div>
  );
}
