import { useEffect, useRef, useState, type CSSProperties } from 'react';
import Fi from './Fi';
import NaveFaucetModal from './NaveFaucetModal';
import { EVM_DEPLOYMENT_MODE } from '../lib/programConfig';

const SEPOLIA_POW_FAUCET = 'https://sepolia-faucet.pk910.de/';
const BRIDGE_TO_BASE = 'https://testnets.superbridge.app/base-sepolia';
const BRIDGE_TO_ROBINHOOD =
  'https://portal.arbitrum.io/bridge?destinationChain=robinhood-chain-testnet&sanitized=true&sourceChain=sepolia';

const BRIDGE_ETH_OPTIONS = [
  { label: 'Bridge ETH to Base', url: BRIDGE_TO_BASE },
  { label: 'Bridge ETH to Robinhood', url: BRIDGE_TO_ROBINHOOD },
] as const;

const outlineBtn: CSSProperties = {
  fontSize: '11.5px',
  fontWeight: 600,
  color: '#92400e',
  border: '1px solid #d97706',
  backgroundColor: 'transparent',
  padding: '4px 10px',
  borderRadius: '5px',
  cursor: 'pointer',
};

/**
 * Bridge-only devnet banner — distinct from the generic `DevnetBanner` shown
 * on the homepage. This one is entirely focused on getting test NAVE and is
 * intentionally NOT dismissible: there is no close / "don't show again"
 * control, so it always persists on the Bridge page (unlike the homepage
 * banner, which the user can close). Hidden on mainnet.
 */
export default function BridgeFaucetBanner() {
  const [faucetOpen, setFaucetOpen] = useState(false);
  const [solFaucetOpen, setSolFaucetOpen] = useState(false);
  const [bridgeMenuOpen, setBridgeMenuOpen] = useState(false);
  const bridgeMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleOutside(e: MouseEvent) {
      if (bridgeMenuRef.current && !bridgeMenuRef.current.contains(e.target as Node)) {
        setBridgeMenuOpen(false);
      }
    }
    if (bridgeMenuOpen) document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, [bridgeMenuOpen]);

  if (EVM_DEPLOYMENT_MODE === 'mainnet') return null;
  return (
    <div
      style={{
        backgroundColor: '#fef3c7',
        borderBottom: '1px solid #fcd34d',
        padding: '8px 16px',
        lineHeight: 1,
      }}
    >
      <div className="max-w-6xl mx-auto flex flex-wrap items-center justify-between gap-2" style={{ fontSize: '12px' }}>
        <span className="flex items-center gap-1.5 flex-shrink-0" style={{ color: '#92400e', fontWeight: 500 }}>
          <span
            style={{
              fontSize: '10px',
              fontWeight: 700,
              letterSpacing: '0.06em',
              backgroundColor: '#d97706',
              color: 'white',
              padding: '2px 5px',
              borderRadius: '3px',
            }}
          >
            DEVNET BETA
          </span>
          <span className="hidden xs:inline">Need test NAVE or SOL to try the bridge?</span>
          <span className="xs:hidden">Need test NAVE or SOL?</span>
        </span>

        <span className="flex flex-wrap items-center gap-2 flex-shrink-0">
          <button
            type="button"
            onClick={() => setFaucetOpen(true)}
            title="Claim 0.1 NAVE on devnet"
            className="flex items-center gap-1.5 flex-shrink-0 transition-colors"
            style={{
              fontSize: '11.5px',
              fontWeight: 600,
              color: 'white',
              border: '1px solid #d97706',
              backgroundColor: '#d97706',
              padding: '4px 10px',
              borderRadius: '5px',
              cursor: 'pointer',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = '#b45309'; e.currentTarget.style.borderColor = '#b45309'; }}
            onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = '#d97706'; e.currentTarget.style.borderColor = '#d97706'; }}
          >
            <Fi icon="droplet" style={{ fontSize: '10px' }} />
            Get Devnet NAVE
          </button>

          <button
            type="button"
            onClick={() => setSolFaucetOpen(true)}
            title="Claim 0.05 SOL on devnet"
            className="flex items-center gap-1.5 flex-shrink-0 transition-colors"
            style={outlineBtn}
            onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = '#fde68a'; }}
            onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
          >
            <Fi icon="droplet" style={{ fontSize: '10px' }} />
            Get Devnet SOL
          </button>

          <a
            href={SEPOLIA_POW_FAUCET}
            target="_blank"
            rel="noopener noreferrer"
            title="Mine Sepolia ETH via PoW faucet"
            className="flex items-center gap-1.5 flex-shrink-0 no-underline transition-colors"
            style={outlineBtn}
            onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = '#fde68a'; }}
            onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
          >
            <Fi icon="magnifying-glass" style={{ fontSize: '10px' }} />
            Mine Sepolia ETH
          </a>

          <div className="relative flex-shrink-0" ref={bridgeMenuRef}>
            <button
              type="button"
              onClick={() => setBridgeMenuOpen((open) => !open)}
              title="Bridge Sepolia ETH to an L2 testnet"
              className="flex items-center gap-1.5 transition-colors"
              style={outlineBtn}
              onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = '#fde68a'; }}
              onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = bridgeMenuOpen ? '#fde68a' : 'transparent'; }}
              aria-expanded={bridgeMenuOpen}
              aria-haspopup="menu"
            >
              <Fi icon="paper-plane" style={{ fontSize: '10px' }} />
              Bridge Sepolia ETH
              <Fi icon="chevron-down" style={{ fontSize: '9px' }} />
            </button>

            {bridgeMenuOpen && (
              <div
                role="menu"
                className="absolute right-0 top-full mt-1.5 min-w-[11rem] rounded-md border z-50 overflow-hidden"
                style={{
                  backgroundColor: '#fffbeb',
                  borderColor: '#fbbf24',
                  boxShadow: '0 4px 12px rgba(120, 53, 15, 0.12)',
                }}
              >
                {BRIDGE_ETH_OPTIONS.map(({ label, url }) => (
                  <a
                    key={url}
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    role="menuitem"
                    className="flex items-center gap-2 px-3 py-2 no-underline transition-colors"
                    style={{ fontSize: '11.5px', fontWeight: 500, color: '#78350f' }}
                    onClick={() => setBridgeMenuOpen(false)}
                    onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = '#fef3c7'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = ''; }}
                  >
                    <Fi icon="arrow-up-right-from-square" style={{ fontSize: '9px', color: '#d97706' }} />
                    {label}
                  </a>
                ))}
              </div>
            )}
          </div>
        </span>
      </div>

      <NaveFaucetModal open={faucetOpen} onClose={() => setFaucetOpen(false)} />
      <NaveFaucetModal variant="sol" open={solFaucetOpen} onClose={() => setSolFaucetOpen(false)} />
    </div>
  );
}
