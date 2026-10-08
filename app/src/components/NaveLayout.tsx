import { useState, useEffect } from 'react';
import NaveModal from './NaveModal';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAccount, useSwitchChain } from 'wagmi';
import Fi from './Fi';
import WalletNetworkMenu from './WalletNetworkMenu';
import NotificationFeed from './NotificationFeed';
import RobinhoodTreasuryNotice from './RobinhoodTreasuryNotice';

import { useDaoContext } from '../hooks/useDaoContext';
import { useDaoRegistry } from '../hooks/useDaoRegistry';
import { useIsMobile } from '../hooks/use-mobile';
import { useChain } from '../hooks/useChain';
import { APP_WALLET_CHAINS, chainFamilyLabel } from '../lib/chain/types';
import type { ChainFamily } from '../lib/chain/types';
import { activeEvmChainId } from '../lib/programConfig';
import { getDaoPublicUrl } from '../lib/daoSlug';

interface NaveLayoutProps {
  children: React.ReactNode;
}

// DAO data is now fetched live via useDaoRegistry hook

type NavItem = {
  icon: string;
  label: string;
  path: string;
  tokenGovOnly?: boolean;
};

const PRIMARY_NAV: NavItem[] = [
  { icon: 'landmark', label: 'Dashboard', path: '/dashboard' },
  { icon: 'shield', label: 'Activity', path: '/governance' },
  { icon: 'castle', label: 'Constitution', path: '/policy' },
];

const MORE_NAV: NavItem[] = [
  { icon: 'layer-group', label: 'Assets', path: '/assets' },
  { icon: 'users', label: 'Agents', path: '/agent' },
  { icon: 'circle', label: 'Tokens', path: '/tokens', tokenGovOnly: true },
  { icon: 'gear', label: 'Settings', path: '/settings' },
];

/** Map IA route aliases to canonical nav paths for active-state highlighting. */
function navPathForActiveState(pathname: string): string {
  const aliases: Record<string, string> = {
    '/votes': '/governance',
    '/rules': '/policy',
    '/automation': '/agent',
    '/team': '/settings',
  };
  return aliases[pathname] ?? pathname;
}

/** Row 2 of the sidebar DAO card — shows a shareable link (slug URL) or
 *  the truncated DAO address, with a one-tap copy button. */
function SidebarDaoLinkRow({ daoAddress, slug }: { daoAddress: string; slug: string | null }) {
  const [copied, setCopied] = useState(false);
  const shareUrl = slug ? getDaoPublicUrl(slug) : null;
  const displayText = shareUrl
    ? shareUrl.replace(/^https?:\/\//, '')
    : `${daoAddress.slice(0, 6)}…${daoAddress.slice(-4)}`;
  const copyValue = shareUrl ?? daoAddress;

  function handleCopy(e: React.MouseEvent) {
    e.stopPropagation();
    navigator.clipboard.writeText(copyValue);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }

  return (
    <div
      className="flex items-center gap-1.5 px-2.5 py-1.5 border-t"
      style={{ borderColor: 'hsl(var(--border))', backgroundColor: 'hsl(var(--surface-0))' }}
    >
      <Fi icon="link" style={{ fontSize: '9px', color: 'hsl(var(--muted-foreground))', flexShrink: 0 }} />
      <span
        className="nave-mono flex-1 min-w-0 truncate"
        style={{ fontSize: '10px', color: 'hsl(var(--muted-foreground))' }}
        title={copyValue}
      >
        {displayText}
      </span>
      <button
        onClick={handleCopy}
        title="Copy link"
        className="flex items-center gap-0.5 px-1.5 py-0.5 rounded transition-colors flex-shrink-0"
        style={{ fontSize: '9.5px', color: copied ? 'hsl(var(--success))' : 'hsl(var(--muted-foreground))' }}
        onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'hsl(var(--surface-2))')}
        onMouseLeave={e => (e.currentTarget.style.backgroundColor = '')}
      >
        <Fi icon={copied ? 'check' : 'copy'} style={{ fontSize: '9px' }} />
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

export default function NaveLayout({ children }: NaveLayoutProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const { chainFamily, setChainFamily } = useChain();
  const { isConnected: evmConnected, chainId: connectedChainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const isMobile = useIsMobile();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [pendingChainFamily, setPendingChainFamily] = useState<ChainFamily | null>(null);
  const { daoAddress, setDaoAddress } = useDaoContext();
  const { dao, loading: daoLoading } = useDaoRegistry(daoAddress);
  const daoName = dao?.name || (daoLoading ? 'Loading...' : 'No DAO Selected');
  const daoType = dao?.governanceType === 'token' ? 'Token Governance' : dao?.governanceType === 'wallet' ? 'Wallet Governance' : 'Treasury';
  const isTokenGov = dao?.governanceType === 'token';
  const moreItems = MORE_NAV.filter((item) => !item.tokenGovOnly || isTokenGov);
  const activeNavPath = navPathForActiveState(location.pathname);
  const moreActive = moreItems.some((item) => activeNavPath === item.path);

  // Mobile closes the sheet after navigation. Desktop keeps a More item visible.
  useEffect(() => {
    setMoreOpen(isMobile ? false : moreActive);
  }, [location.pathname, isMobile, moreActive]);

  // DAO app only offers Base + Robinhood in the network picker.
  useEffect(() => {
    if (!APP_WALLET_CHAINS.includes(chainFamily)) {
      setChainFamily('base');
    }
  }, [chainFamily, setChainFamily]);

  /**
   * Apply app + wallet chain change. WalletNetworkMenu skips its default
   * switchChainAsync when onNetworkSelect is set, so this layout owns both.
   */
  async function applyChainFamily(family: ChainFamily) {
    setChainFamily(family);
    if (family !== 'solana' && evmConnected) {
      const chainId = activeEvmChainId(family);
      if (connectedChainId !== chainId) {
        try {
          await switchChainAsync?.({ chainId });
        } catch {
          // Wallet rejected or cannot switch — app chain family still updates
          // so lobby filtering / routing match the user's intent.
        }
      }
    }
  }

  // Switching networks while inside a treasury: clear the active DAO and
  // navigate to the treasury lobby so the user can pick a treasury on the
  // new chain. Without this, the sidebar still shows the old DAO.
  function handleChainSwitch(family: typeof chainFamily) {
    if (family === chainFamily) return;
    if (daoAddress) {
      setPendingChainFamily(family);
      return;
    }
    void applyChainFamily(family);
    setSidebarOpen(false);
  }

  async function confirmChainSwitch() {
    if (!pendingChainFamily) return;
    const nextFamily = pendingChainFamily;
    setPendingChainFamily(null);
    // Clear DAO before/with chain update so syncFromAddress(null) does not
    // race a later wallet snap; applyChainFamily then sets the target network.
    setDaoAddress(null);
    await applyChainFamily(nextFamily);
    navigate('/treasuries');
    setSidebarOpen(false);
  }

  return (
    <div className="flex h-screen overflow-hidden" style={{ backgroundColor: 'hsl(var(--background))' }}>
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 lg:hidden"
          style={{ backgroundColor: 'rgba(0,0,0,0.2)' }}
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`
          fixed inset-y-0 left-0 z-40 flex flex-col w-56 border-r
          transition-transform duration-200 ease-out
          lg:static lg:translate-x-0
          ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
        `}
        style={{
          backgroundColor: 'hsl(var(--surface-0))',
          borderColor: 'hsl(var(--border))',
        }}
      >
        {/* Logo */}
        <div
          className="flex items-center justify-between px-5 py-4 border-b"
          style={{ borderColor: 'hsl(var(--border))' }}
        >
          <Link to="/" className="no-underline">
            <span className="text-display" style={{ fontSize: '19px', color: 'hsl(var(--foreground))' }}>
              Nave
            </span>
          </Link>
          <button
            className="lg:hidden p-1 rounded"
            onClick={() => setSidebarOpen(false)}
            aria-label="Close sidebar"
            style={{ color: 'hsl(var(--muted-foreground))' }}
          >
            <Fi icon="xmark" style={{ fontSize: '16px' }} />
          </button>
        </div>

        {/* DAO selector — two-row card matching the lobby design */}
        <div className="px-3 py-3 border-b" style={{ borderColor: 'hsl(var(--border))' }}>
          <div
            className="rounded-md overflow-hidden"
            style={{ border: '1px solid hsl(var(--border))' }}
            data-onboarding-id="dao-selector"
          >
            {/* Row 1 — icon + name + governance type (click → switch treasury) */}
            <button
              onClick={() => { navigate('/treasuries'); setSidebarOpen(false); }}
              className="w-full flex items-center gap-2.5 px-2.5 py-2 text-left transition-colors"
              style={{ backgroundColor: 'hsl(var(--surface-1))' }}
              onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'hsl(var(--surface-2))')}
              onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'hsl(var(--surface-1))')}
            >
              <div
                className="w-7 h-7 rounded-md flex items-center justify-center flex-shrink-0"
                style={{ backgroundColor: 'hsl(var(--primary))' }}
              >
                <Fi icon="landmark" style={{ fontSize: '12px', color: 'white' }} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-medium truncate" style={{ fontSize: '13px', color: 'hsl(var(--foreground))' }}>
                  {daoName}
                </div>
                <div style={{ fontSize: '10.5px', color: 'hsl(var(--muted-foreground))' }}>
                  {daoType}
                </div>
              </div>
              <Fi icon="chevron-down" style={{ fontSize: '10px', color: 'hsl(var(--muted-foreground))', flexShrink: 0 }} />
            </button>

            {/* Row 2 — shareable link (slug URL) or DAO address + copy */}
            {daoAddress && (
              <SidebarDaoLinkRow
                daoAddress={daoAddress}
                slug={dao?.slug ?? null}
              />
            )}
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-3 py-3 space-y-0.5 overflow-y-auto">
          {PRIMARY_NAV.map(({ icon, label, path }) => {
            const active = activeNavPath === path;
            return (
              <Link
                key={path}
                to={path}
                onClick={() => setSidebarOpen(false)}
                className="flex items-center gap-2.5 px-2.5 py-2 rounded-md no-underline transition-colors"
                data-onboarding-id={`nav-${path.replace('/', '')}`}
                style={{
                  fontSize: '13.5px',
                  fontWeight: active ? '500' : '400',
                  color: active ? 'hsl(var(--foreground))' : 'hsl(var(--muted-foreground))',
                  backgroundColor: active ? 'hsl(var(--surface-1))' : 'transparent',
                }}
              >
                <Fi
                  icon={icon}
                  style={{
                    fontSize: '14px',
                    width: '16px',
                    textAlign: 'center',
                    color: 'inherit',
                  }}
                />
                {label}
              </Link>
            );
          })}
          <button
            type="button"
            onClick={() => setMoreOpen((open) => !open)}
            className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-md transition-colors"
            aria-expanded={moreOpen}
            aria-label="More navigation"
            style={{
              fontSize: '13.5px',
              fontWeight: moreOpen || moreActive ? '500' : '400',
              color: moreOpen || moreActive ? 'hsl(var(--foreground))' : 'hsl(var(--muted-foreground))',
              backgroundColor: 'transparent',
            }}
          >
            <Fi icon="ellipsis" style={{ fontSize: '14px', width: '16px', textAlign: 'center' }} />
            More
          </button>
          {moreOpen && moreItems.map(({ icon, label, path }) => {
            const active = activeNavPath === path;
            return (
              <Link
                key={path}
                to={path}
                onClick={() => setSidebarOpen(false)}
                className="flex items-center gap-2.5 px-2.5 py-2 rounded-md no-underline transition-colors"
                data-onboarding-id={`nav-${path.replace('/', '')}`}
                style={{
                  fontSize: '13.5px',
                  fontWeight: active ? '500' : '400',
                  color: active ? 'hsl(var(--foreground))' : 'hsl(var(--muted-foreground))',
                  backgroundColor: active ? 'hsl(var(--surface-1))' : 'transparent',
                  paddingLeft: '2.25rem',
                }}
              >
                <Fi
                  icon={icon}
                  style={{
                    fontSize: '14px',
                    width: '16px',
                    textAlign: 'center',
                    color: 'inherit',
                  }}
                />
                {label}
              </Link>
            );
          })}
        </nav>

        {/* New Treasury */}
        <div className="px-3 py-3 border-t" style={{ borderColor: 'hsl(var(--border))' }}>
          <button
            onClick={() => { navigate('/create-dao'); setSidebarOpen(false); }}
            className="w-full flex items-center gap-2 px-2.5 py-2 rounded-md transition-all font-medium"
            style={{
              fontSize: '13px',
              color: 'hsl(var(--foreground))',
              border: '1px solid hsl(var(--border-strong))',
              backgroundColor: 'hsl(var(--surface-0))',
            }}
            onMouseEnter={e => {
              e.currentTarget.style.backgroundColor = 'hsl(var(--surface-1))';
              e.currentTarget.style.borderColor = 'hsl(var(--foreground))';
            }}
            onMouseLeave={e => {
              e.currentTarget.style.backgroundColor = 'hsl(var(--surface-0))';
              e.currentTarget.style.borderColor = 'hsl(var(--border-strong))';
            }}
          >
            <Fi icon="plus" style={{ fontSize: '12px' }} />
            New Treasury
          </button>
        </div>
      </aside>

      {/* Main area */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Top bar */}
        <header
          className="flex items-center justify-between px-4 py-3 border-b flex-shrink-0"
          style={{
            backgroundColor: 'hsl(var(--surface-0))',
            borderColor: 'hsl(var(--border))',
            height: '53px',
          }}
        >
          <button
            className="lg:hidden p-1 rounded"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open sidebar"
            style={{ color: 'hsl(var(--muted-foreground))' }}
          >
            <Fi icon="bars" style={{ fontSize: '17px' }} />
          </button>

          {/* Notifications + unified wallet/network control. The network
              selector inside the menu routes through handleChainSwitch so
              switching chains while inside a treasury still clears the active
              DAO (and confirms first when one is selected). */}
          <div className="flex items-center gap-2 ml-auto">
            {daoAddress && <NotificationFeed />}
            <WalletNetworkMenu onNetworkSelect={handleChainSwitch} chains={APP_WALLET_CHAINS} />
          </div>
        </header>

        {/* Page content */}
        <main
          className="flex-1 overflow-y-auto"
          style={{
            backgroundColor: 'hsl(var(--background))',
            paddingBottom: isMobile ? 'calc(64px + env(safe-area-inset-bottom, 0px))' : undefined,
          }}
        >
          {/* Robinhood hosts Bridge & Stake plus treasuries; yield typically
              bridges to Ethereum. Soft info banner — does not block UX. */}
          {chainFamily === 'robinhood' && (
            <div className="px-4 pt-4 -mb-2">
              <RobinhoodTreasuryNotice />
            </div>
          )}
          {children}
        </main>
      </div>

      {/* ── Mobile bottom tab bar ─────────────────────────────── */}
      {isMobile && (
        <>
          {moreOpen && (
            <div
              className="fixed inset-0 z-40"
              style={{ backgroundColor: 'rgba(0,0,0,0.2)' }}
              onClick={() => setMoreOpen(false)}
            />
          )}
          {moreOpen && (
            <div
              className="fixed inset-x-0 z-50 border-t rounded-t-xl overflow-hidden"
              style={{
                bottom: 'calc(56px + env(safe-area-inset-bottom, 0px))',
                backgroundColor: 'hsl(var(--surface-0))',
                borderColor: 'hsl(var(--border))',
                boxShadow: 'var(--shadow-lg)',
              }}
            >
              {moreItems.map(({ icon, label, path }) => {
                const active = activeNavPath === path;
                return (
                  <Link
                    key={path}
                    to={path}
                    onClick={() => setMoreOpen(false)}
                    className="flex items-center gap-3 px-4 py-3 no-underline transition-colors border-b last:border-b-0"
                    style={{
                      borderColor: 'hsl(var(--border))',
                      color: active ? 'hsl(var(--foreground))' : 'hsl(var(--muted-foreground))',
                      backgroundColor: active ? 'hsl(var(--surface-1))' : 'transparent',
                    }}
                  >
                    <Fi icon={icon} style={{ fontSize: '15px', width: '18px', textAlign: 'center' }} />
                    <span style={{ fontSize: '13.5px', fontWeight: active ? '600' : '400' }}>{label}</span>
                  </Link>
                );
              })}
            </div>
          )}
          <nav
            className="fixed bottom-0 inset-x-0 z-50 flex items-stretch border-t"
            style={{
              minHeight: '56px',
              backgroundColor: 'hsl(var(--surface-0))',
              borderColor: 'hsl(var(--border))',
              paddingBottom: 'env(safe-area-inset-bottom, 0px)',
            }}
          >
            {PRIMARY_NAV.map(({ icon, label, path }) => {
              const active = activeNavPath === path;
              return (
                <Link
                  key={path}
                  to={path}
                  className="flex-1 flex flex-col items-center justify-center gap-0.5 no-underline transition-colors"
                  style={{
                    color: active ? 'hsl(var(--foreground))' : 'hsl(var(--muted-foreground))',
                  }}
                >
                  <Fi icon={icon} style={{ fontSize: '16px', color: 'inherit' }} />
                  <span style={{ fontSize: '10px', fontWeight: active ? '600' : '400', letterSpacing: '0.02em' }}>
                    {label}
                  </span>
                </Link>
              );
            })}
            <button
              type="button"
              onClick={() => setMoreOpen((open) => !open)}
              className="flex-1 flex flex-col items-center justify-center gap-0.5 border-0 bg-transparent transition-colors"
              style={{
                color: moreOpen || moreActive ? 'hsl(var(--foreground))' : 'hsl(var(--muted-foreground))',
              }}
              aria-expanded={moreOpen}
              aria-label="More navigation"
            >
              <Fi icon="ellipsis" style={{ fontSize: '16px', color: 'inherit' }} />
              <span
                style={{
                  fontSize: '10px',
                  fontWeight: moreOpen || moreActive ? '600' : '400',
                  letterSpacing: '0.02em',
                }}
              >
                More
              </span>
            </button>
          </nav>
        </>
      )}

      {pendingChainFamily && (
        <ChainSwitchConfirmDialog
          fromLabel={chainFamilyLabel(chainFamily)}
          toLabel={chainFamilyLabel(pendingChainFamily)}
          onConfirm={() => void confirmChainSwitch()}
          onCancel={() => setPendingChainFamily(null)}
        />
      )}
    </div>
  );
}

function ChainSwitchConfirmDialog({
  fromLabel,
  toLabel,
  onConfirm,
  onCancel,
}: {
  fromLabel: string;
  toLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <NaveModal open title="Switch network?" icon="right-left" onClose={onCancel} maxWidth={448}>
      <div className="px-5 py-4 space-y-4">
        <p style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.55 }}>
          Switching from {fromLabel} to {toLabel} deselects your current treasury. You will return to the lobby to pick a treasury on the new network.
        </p>
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 rounded-lg border"
            style={{ fontSize: '13px', borderColor: 'hsl(var(--border))', color: 'hsl(var(--muted-foreground))' }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="px-4 py-2 rounded-lg font-medium"
            style={{ fontSize: '13px', backgroundColor: 'hsl(var(--primary))', color: 'hsl(var(--primary-foreground))' }}
          >
            Switch network
          </button>
        </div>
      </div>
    </NaveModal>
  );
}