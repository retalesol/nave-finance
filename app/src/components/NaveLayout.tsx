import { useState, useEffect } from 'react';
import NaveModal from './NaveModal';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAccount } from 'wagmi';
import Fi from './Fi';
import WalletNetworkMenu from './WalletNetworkMenu';
import NotificationFeed from './NotificationFeed';
import RobinhoodTreasuryNotice from './RobinhoodTreasuryNotice';
import NaveMark from './NaveMark';

import { useDaoContext } from '../hooks/useDaoContext';
import { useDaoRegistry } from '../hooks/useDaoRegistry';
import { useIsMobile } from '../hooks/use-mobile';
import { useChain } from '../hooks/useChain';
import { APP_WALLET_CHAINS, chainFamilyLabel } from '../lib/chain/types';
import type { ChainFamily } from '../lib/chain/types';
import { activeEvmChainId } from '../lib/programConfig';
import { ensureWalletOnChain } from '../lib/evm/ensureWalletChain';
import { getDaoPublicUrl } from '../lib/daoSlug';

interface NaveLayoutProps {
  children: React.ReactNode;
  /** Optional opt-out from the default 860px centered column. */
  wide?: boolean;
}

type NavItem = {
  icon: string;
  label: string;
  path: string;
  onboardingId: string;
  state?: Record<string, unknown>;
  tokenGovOnly?: boolean;
};

const NAV: NavItem[] = [
  { icon: 'landmark', label: 'Overview', path: '/overview', onboardingId: 'nav-dashboard' },
  { icon: 'layer-group', label: 'Money', path: '/money', onboardingId: 'nav-assets' },
  { icon: 'users', label: 'Agents', path: '/agents', onboardingId: 'nav-agent' },
  { icon: 'shield', label: 'Decisions', path: '/decisions', onboardingId: 'nav-governance' },
  { icon: 'castle', label: 'Rules', path: '/rules', onboardingId: 'nav-policy' },
  { icon: 'right-left', label: 'Bridge', path: '/bridge', onboardingId: 'nav-bridge' },
  { icon: 'coins', label: 'Stake', path: '/stake', onboardingId: 'nav-stake' },
  { icon: 'gear', label: 'Settings', path: '/settings', onboardingId: 'nav-settings' },
  { icon: 'circle', label: 'Tokens', path: '/tokens', onboardingId: 'nav-tokens', tokenGovOnly: true },
];

/** Map canonical and legacy routes to canonical nav paths for active-state highlighting. */
function navPathForActiveState(pathname: string): string {
  if (
    pathname.startsWith('/decisions') ||
    pathname.startsWith('/governance') ||
    pathname.startsWith('/votes')
  ) {
    return '/decisions';
  }
  const aliases: Record<string, string> = {
    '/dashboard': '/overview',
    '/assets': '/money',
    '/agent': '/agents',
    '/automation': '/agents',
    '/policy': '/rules',
    '/team': '/settings',
  };
  return aliases[pathname] ?? pathname;
}

/** Row 2 of the sidebar DAO selector — shows a shareable link (slug URL) or
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
      className="flex items-center gap-1.5 mt-1"
      style={{ color: 'hsl(var(--faint))' }}
    >
      <span
        className="nave-mono flex-1 min-w-0 truncate"
        style={{ fontSize: '11px', color: 'hsl(var(--faint))' }}
        title={copyValue}
      >
        {displayText}
      </span>
      <button
        type="button"
        onClick={handleCopy}
        title="Copy link"
        className="flex items-center gap-0.5 px-1.5 py-0.5 rounded transition-colors flex-shrink-0"
        style={{ fontSize: '10px', color: copied ? 'hsl(var(--success))' : 'hsl(var(--muted-foreground))' }}
        onMouseEnter={e => (e.currentTarget.style.color = 'hsl(var(--foreground))')}
        onMouseLeave={e => (e.currentTarget.style.color = copied ? 'hsl(var(--success))' : 'hsl(var(--muted-foreground))')}
      >
        <Fi icon={copied ? 'check' : 'copy'} style={{ fontSize: '9px' }} />
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

export default function NaveLayout({ children, wide = false }: NaveLayoutProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const { chainFamily, setChainFamily } = useChain();
  const { isConnected: evmConnected, chainId: connectedChainId } = useAccount();
  const isMobile = useIsMobile();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [pendingChainFamily, setPendingChainFamily] = useState<ChainFamily | null>(null);
  const { daoAddress, setDaoAddress } = useDaoContext();
  const { dao, loading: daoLoading } = useDaoRegistry(daoAddress);
  const daoName = dao?.name || (daoLoading ? 'Loading...' : 'No DAO Selected');
  const daoType = dao?.governanceType === 'token' ? 'Token Governance' : dao?.governanceType === 'wallet' ? 'Wallet Governance' : 'Treasury';
  const isTokenGov = dao?.governanceType === 'token';
  const navItems = NAV.filter((item) => !item.tokenGovOnly || isTokenGov);
  const activeNavPath = navPathForActiveState(location.pathname);
  const activeNavLabel = NAV.find((item) => !item.state && item.path === activeNavPath)?.label ?? 'Overview';

  // DAO app only offers Base + Robinhood in the network picker.
  useEffect(() => {
    if (!APP_WALLET_CHAINS.includes(chainFamily)) {
      setChainFamily('base');
    }
  }, [chainFamily, setChainFamily]);

  /**
   * Apply app + wallet chain change. WalletNetworkMenu skips its default
   * switch when onNetworkSelect is set, so this layout owns both.
   */
  async function applyChainFamily(family: ChainFamily) {
    setChainFamily(family);
    if (family !== 'solana' && evmConnected) {
      const chainId = activeEvmChainId(family);
      if (connectedChainId !== chainId) {
        try {
          await ensureWalletOnChain(chainId);
        } catch {
          // Wallet rejected or cannot switch — app chain family still updates
          // so lobby filtering / routing match the user's intent.
        }
      }
    }
  }

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
          style={{ backgroundColor: 'rgba(17, 24, 39, 0.35)', backdropFilter: 'blur(2px)' }}
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar — 210px on warm paper with hairline right border */}
      <aside
        className={`
          fixed inset-y-0 left-0 z-40 flex flex-col w-[210px] border-r
          transition-transform duration-200 ease-out
          lg:static lg:translate-x-0
          ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
        `}
        style={{
          backgroundColor: 'hsl(var(--background))',
          borderColor: 'hsl(var(--surface-2))',
          padding: '22px 18px',
        }}
      >
        {/* Brand */}
        <div className="flex items-center justify-between" style={{ marginBottom: '26px' }}>
          <Link to="/" className="no-underline flex items-center gap-2">
            <NaveMark />
            <span
              className="text-display"
              style={{
                fontFamily: 'var(--font-display)',
                fontWeight: 400,
                fontSize: '19px',
                color: 'hsl(var(--foreground))',
              }}
            >
              Nave
            </span>
          </Link>
          <button
            className="lg:hidden p-1 rounded"
            onClick={() => setSidebarOpen(false)}
            aria-label="Close sidebar"
            style={{ color: 'hsl(var(--muted-foreground))' }}
          >
            <Fi icon="xmark" style={{ fontSize: '15px' }} />
          </button>
        </div>

        {/* Flattened DAO selector */}
        <div
          style={{ marginBottom: '24px' }}
          data-onboarding-id="dao-selector"
        >
          <button
            type="button"
            onClick={() => { navigate('/treasuries'); setSidebarOpen(false); }}
            className="w-full text-left group bg-transparent border-0 p-0 cursor-pointer"
            title="Switch treasury"
          >
            <div
              className="truncate group-hover:text-brass transition-colors"
              style={{
                fontSize: '13.5px',
                fontWeight: 600,
                lineHeight: 1.3,
                color: 'hsl(var(--foreground))',
              }}
            >
              {daoName}
            </div>
            <div
              className="flex items-center gap-1 truncate"
              style={{
                fontSize: '11.5px',
                color: 'hsl(var(--faint))',
                marginTop: '2px',
              }}
            >
              <span>{chainFamilyLabel(chainFamily)} · {daoType}</span>
              <span style={{ fontSize: '10px' }}>⌄</span>
            </div>
          </button>

          {daoAddress && (
            <SidebarDaoLinkRow
              daoAddress={daoAddress}
              slug={dao?.slug ?? null}
            />
          )}
        </div>

        {/* Nav */}
        <nav className="flex-1 flex flex-col gap-0.5 overflow-y-auto">
          {navItems.map(({ icon, label, path, onboardingId, state }) => {
            const active = !state && activeNavPath === path;
            return (
              <Link
                key={onboardingId}
                to={path}
                state={state}
                onClick={() => setSidebarOpen(false)}
                className="flex items-center gap-2.5 rounded-[8px] no-underline transition-all"
                data-onboarding-id={onboardingId}
                style={{
                  padding: '8px 10px',
                  fontSize: '13.5px',
                  fontWeight: active ? 600 : 400,
                  color: active ? 'hsl(var(--foreground))' : 'hsl(var(--muted-foreground))',
                  backgroundColor: active ? '#ffffff' : 'transparent',
                  boxShadow: active ? '0 1px 3px rgba(17, 24, 39, 0.05)' : 'none',
                }}
                onMouseEnter={e => {
                  if (!active) {
                    e.currentTarget.style.color = 'hsl(var(--foreground))';
                    e.currentTarget.style.backgroundColor = '#ffffff';
                  }
                }}
                onMouseLeave={e => {
                  if (!active) {
                    e.currentTarget.style.color = 'hsl(var(--muted-foreground))';
                    e.currentTarget.style.backgroundColor = 'transparent';
                  }
                }}
              >
                <Fi
                  icon={icon}
                  style={{
                    fontSize: '13px',
                    width: '15px',
                    textAlign: 'center',
                    color: 'inherit',
                    opacity: active ? 0.9 : 0.7,
                  }}
                />
                <span>{label}</span>
              </Link>
            );
          })}

          <button
            type="button"
            onClick={() => { navigate('/create-dao'); setSidebarOpen(false); }}
            className="flex items-center gap-2 w-full text-left rounded-[8px] transition-all bg-transparent border-0 cursor-pointer"
            style={{
              marginTop: '14px',
              padding: '8px 10px',
              fontSize: '13.5px',
              fontWeight: 500,
              color: 'hsl(var(--muted-foreground))',
            }}
            onMouseEnter={e => {
              e.currentTarget.style.color = 'hsl(var(--foreground))';
              e.currentTarget.style.backgroundColor = '#ffffff';
            }}
            onMouseLeave={e => {
              e.currentTarget.style.color = 'hsl(var(--muted-foreground))';
              e.currentTarget.style.backgroundColor = 'transparent';
            }}
          >
            <span>+ New treasury</span>
          </button>
        </nav>
      </aside>

      {/* Main area */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Sticky paper-blur topbar */}
        <header
          className="sticky top-0 z-30 flex items-center justify-between border-b flex-shrink-0"
          style={{
            padding: isMobile ? '11px 16px' : '13px 32px',
            backgroundColor: 'rgba(250, 248, 243, 0.9)',
            backdropFilter: 'blur(12px)',
            WebkitBackdropFilter: 'blur(12px)',
            borderColor: 'hsl(var(--surface-2))',
          }}
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <button
              className="lg:hidden p-1 rounded"
              onClick={() => setSidebarOpen(true)}
              aria-label="Open sidebar"
              style={{ color: 'hsl(var(--muted-foreground))' }}
            >
              <Fi icon="bars" style={{ fontSize: '16px' }} />
            </button>
            <span className="truncate" style={{ fontSize: '13px', color: 'hsl(var(--faint))' }}>
              <b style={{ color: 'hsl(var(--foreground))', fontWeight: 600 }}>{activeNavLabel}</b>
              {dao?.name ? ` · ${dao.name}` : ''}
            </span>
          </div>

          <div className="flex items-center gap-2 ml-auto flex-shrink-0">
            {daoAddress && <NotificationFeed />}
            <WalletNetworkMenu onNetworkSelect={handleChainSwitch} chains={APP_WALLET_CHAINS} />
          </div>
        </header>

        {/* Page content */}
        <main
          className="flex-1 overflow-y-auto"
          style={{
            backgroundColor: 'hsl(var(--background))',
            paddingBottom: isMobile ? 'calc(76px + env(safe-area-inset-bottom, 0px))' : undefined,
          }}
        >
          <div
            className={wide ? 'w-full' : 'max-w-[860px] mx-auto w-full'}
            style={
              wide
                ? undefined
                : {
                    padding: isMobile ? '28px 20px 100px' : '44px 32px 90px',
                  }
            }
          >
            {chainFamily === 'robinhood' && (
              <div className="mb-4">
                <RobinhoodTreasuryNotice />
              </div>
            )}
            {children}
          </div>
        </main>
      </div>

      {/* ── Mobile bottom tab bar ─────────────────────────────── */}
      {isMobile && (
        <nav
          className="fixed bottom-0 inset-x-0 z-50 flex items-stretch justify-around border-t overflow-x-auto"
          style={{
            backgroundColor: 'rgba(255, 255, 255, 0.95)',
            backdropFilter: 'blur(12px)',
            WebkitBackdropFilter: 'blur(12px)',
            borderColor: 'hsl(var(--border))',
            padding: '7px 4px calc(7px + env(safe-area-inset-bottom, 0px))',
          }}
        >
          {navItems.slice(0, 5).map(({ icon, label, path }) => {
            const active = activeNavPath === path;
            return (
              <Link
                key={path}
                to={path}
                className="flex flex-col items-center justify-center gap-0.5 no-underline rounded-[8px] transition-colors"
                style={{
                  padding: '5px 9px',
                  fontSize: '9.5px',
                  fontWeight: active ? 600 : 400,
                  color: active ? 'hsl(var(--foreground))' : 'hsl(var(--faint))',
                  backgroundColor: active ? 'hsl(var(--background))' : 'transparent',
                }}
              >
                <Fi icon={icon} style={{ fontSize: '13px', color: 'inherit' }} />
                <span>{label}</span>
              </Link>
            );
          })}
          <Link
            to="/create-dao"
            className="flex flex-col items-center justify-center gap-0.5 no-underline rounded-[8px] transition-colors"
            style={{
              padding: '5px 9px',
              fontSize: '9.5px',
              fontWeight: activeNavPath === '/create-dao' ? 600 : 400,
              color: activeNavPath === '/create-dao' ? 'hsl(var(--foreground))' : 'hsl(var(--faint))',
              backgroundColor: activeNavPath === '/create-dao' ? 'hsl(var(--background))' : 'transparent',
            }}
          >
            <Fi icon="plus" style={{ fontSize: '13px', color: 'inherit' }} />
            <span>New</span>
          </Link>
        </nav>
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
    <NaveModal open title="Switch network?" icon="right-left" onClose={onCancel} maxWidth={480}>
      <div className="space-y-4" style={{ padding: '18px 22px 22px' }}>
        <p style={{ fontSize: '13.5px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.6, margin: 0 }}>
          Switching from <b style={{ color: 'hsl(var(--foreground))', fontWeight: 500 }}>{fromLabel}</b> to{' '}
          <b style={{ color: 'hsl(var(--foreground))', fontWeight: 500 }}>{toLabel}</b> deselects your current treasury. You will return to the lobby to pick a treasury on the new network.
        </p>
        <div
          className="flex items-center justify-end gap-2 pt-4 border-t"
          style={{ borderColor: 'hsl(var(--surface-2))' }}
        >
          <button
            type="button"
            onClick={onCancel}
            className="px-3.5 py-2 rounded-[9px] transition-colors"
            style={{ fontSize: '13px', fontWeight: 600, color: 'hsl(var(--muted-foreground))' }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="px-4 py-2 rounded-[9px] font-semibold transition-colors"
            style={{ fontSize: '13px', backgroundColor: '#111827', color: '#ffffff' }}
          >
            Switch network
          </button>
        </div>
      </div>
    </NaveModal>
  );
}
