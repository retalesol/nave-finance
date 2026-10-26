import { useState, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useWallet } from '@solana/wallet-adapter-react';
import { useAccount } from 'wagmi';
import NaveModal from './NaveModal';
import { NaveMenu, NaveMenuItem } from './NaveMenu';
import Fi from './Fi';
import NotificationFeed from './NotificationFeed';
import WalletNetworkMenu from './WalletNetworkMenu';
import { DepositFundsModal } from './DepositFlow';

import { useDaoContext } from '../hooks/useDaoContext';
import { useDaoRegistry } from '../hooks/useDaoRegistry';
import { useProposals } from '../hooks/useProposals';
import { useDaoMembership } from '../hooks/useDaoMembership';
import { useWatchedDaos } from '../hooks/useWatchedDaos';
import { useTreasuryAssets } from '../hooks/useTreasuryAssets';
import { useTokenRegistry } from '../hooks/useTokenRegistry';
import { useIsMobile } from '../hooks/use-mobile';
import { useChain } from '../hooks/useChain';
import {
  APP_WALLET_CHAINS,
  WALLET_CHAINS,
  chainFamilyLabel,
  daoNetworkLabel,
  evmTarget,
  isEvmAddress,
  isEvmChainId,
  type ChainFamily,
} from '../lib/chain/types';
import { activeEvmChainId, SOLANA_NETWORK } from '../lib/programConfig';
import { ensureWalletOnChain } from '../lib/evm/ensureWalletChain';
import { getDaoPublicUrl } from '../lib/daoSlug';
import { PAY_NAV, PAY_NAV_ADVANCED, PAY_NAV_PRIMARY } from '../lib/pay/nav';
import { appBreadcrumbs } from '../lib/breadcrumbs';
import AppBreadcrumb from './AppBreadcrumb';
import NaveMark from './NaveMark';
import TreasuryLogo from './TreasuryLogo';
import { isPayAppPath } from '../lib/pay/paths';
import { prefetchAppRoute } from '../lib/routePrefetch';

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

const NETWORK_OPTIONS: readonly { family: ChainFamily; label: string; description: string }[] = [
  { family: 'base', label: 'Base', description: 'Low fees · Aave & Compound earning' },
  { family: 'ethereum', label: 'Ethereum', description: 'Deepest liquidity · higher gas' },
  { family: 'solana', label: 'Solana', description: 'Fast · Jito & Kamino staking' },
  { family: 'robinhood', label: 'Robinhood', description: 'Stock tokens · earning via bridge' },
  { family: 'arc', label: 'Arc', description: 'New · USDC-native (testnet)' },
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

function shortenAddress(addr: string): string {
  if (!addr) return '';
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export default function NaveLayout({ children, wide = false }: NaveLayoutProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const { target, chainFamily, setChainFamily, rememberDaoChain } = useChain();
  const { publicKey } = useWallet();
  const { address: evmAddress, isConnected: evmConnected, chainId: connectedChainId } = useAccount();
  const isMobile = useIsMobile();

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [productModalOpen, setProductModalOpen] = useState(false);
  const productMenuRef = useRef<HTMLDivElement>(null);
  const [pendingChainFamily, setPendingChainFamily] = useState<ChainFamily | null>(null);
  const [treasuryModalOpen, setTreasuryModalOpen] = useState(false);
  const [searchModalOpen, setSearchModalOpen] = useState(false);
  const [depositModalOpen, setDepositModalOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [payMoreOpen, setPayMoreOpen] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const mainRef = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    mainRef.current?.scrollTo(0, 0);
  }, [location.pathname]);

  const { daoAddress, setDaoAddress, isMockMode } = useDaoContext();
  const { dao, loading: daoLoading } = useDaoRegistry(daoAddress);
  const proposalCount =
    typeof dao?.nextProposalIndex === 'number'
      ? dao.nextProposalIndex
      : (dao?.proposalCount ?? 0) + (dao?.archivedProposalCount ?? 0);
  const { activeProposals } = useProposals(daoAddress, proposalCount);
  const activeProposalsCount = activeProposals.length;
  const membership = useDaoMembership();
  const treasuryAssets = useTreasuryAssets(daoAddress);
  const tokenRegistry = useTokenRegistry(daoAddress);
  const votingMint = tokenRegistry.tokens[0]?.mint ?? null;

  const isEvm = target.kind === 'evm';
  const activeWalletAddress = isEvm ? (evmAddress ?? null) : (publicKey?.toBase58() ?? null);
  const { daos: watchedDaos } = useWatchedDaos(activeWalletAddress);

  const daoName = dao?.name || (daoLoading ? 'Loading...' : 'Select a treasury');
  const isTokenGov = dao?.governanceType === 'token';
  const inPay = isPayAppPath(location.pathname);
  const payAdvancedOpen = payMoreOpen || PAY_NAV_ADVANCED.some((item) => (
    location.pathname === item.path || location.pathname.startsWith(`${item.path}/`)
  ));
  const navItems = inPay
    ? (payAdvancedOpen ? PAY_NAV : PAY_NAV_PRIMARY)
    : NAV.filter((item) => !item.tokenGovOnly || isTokenGov);
  const activeNavPath = inPay
    ? (location.pathname.length > 1 ? location.pathname.replace(/\/+$/, '') : location.pathname)
    : navPathForActiveState(location.pathname);

  const agentsActive = dao ? !dao.frozen && (dao.agentsEnabled ?? true) : true;
  const agentsFrozen = dao?.frozen ?? false;

  const networkLabel = useMemo(() => {
    if (dao?.chainId != null && isEvmChainId(dao.chainId)) {
      return evmTarget(dao.chainId).family === 'robinhood'
        ? 'Robinhood'
        : chainFamilyLabel(evmTarget(dao.chainId).family);
    }
    return chainFamilyLabel(chainFamily);
  }, [dao?.chainId, chainFamily]);

  const slugOrShortAddr = useMemo(() => {
    if (dao?.slug) return `nave.finance/${dao.slug}`;
    if (daoAddress && !isMockMode) return shortenAddress(daoAddress);
    if (isMockMode) return 'nave.finance/atlas';
    return 'Choose or create';
  }, [dao?.slug, daoAddress, isMockMode]);

  const roleLabel = useMemo(() => {
    if (membership.isFounder) return 'Founder';
    if (membership.isGuardian) return 'Guardian';
    if (membership.isMember) return 'Member';
    return 'Connected';
  }, [membership.isFounder, membership.isGuardian, membership.isMember]);

  // Keep valid chain family on mount
  useEffect(() => {
    if (!WALLET_CHAINS.includes(chainFamily) && !APP_WALLET_CHAINS.includes(chainFamily)) {
      setChainFamily('base');
    }
  }, [chainFamily, setChainFamily]);

  // Global ⌘K / Ctrl+K shortcut for search
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchQuery('');
        setSearchModalOpen((prev) => !prev);
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    if (searchModalOpen) {
      const t = window.setTimeout(() => searchInputRef.current?.focus(), 60);
      return () => window.clearTimeout(t);
    }
  }, [searchModalOpen]);

  function copyWithFeedback(value: string, key: string) {
    if (!value) return;
    navigator.clipboard.writeText(value);
    setCopiedKey(key);
    window.setTimeout(() => {
      setCopiedKey((curr) => (curr === key ? null : curr));
    }, 1600);
  }

  async function applyChainFamily(family: ChainFamily) {
    setChainFamily(family);
    if (family !== 'solana' && evmConnected) {
      const chainId = activeEvmChainId(family);
      if (connectedChainId !== chainId) {
        try {
          await ensureWalletOnChain(chainId);
        } catch {
          // Wallet rejected or cannot switch — app chain family still updates
        }
      }
    }
  }

  function handleChainSwitch(family: ChainFamily) {
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

  function chooseProduct(next: 'nave' | 'pay') {
    setProductModalOpen(false);
    setSidebarOpen(false);
    if (next === 'pay') {
      if (!inPay) navigate('/pay');
      return;
    }
    if (inPay) navigate('/overview');
  }

  function handleAddFundsClick() {
    if (daoAddress) {
      setDepositModalOpen(true);
    } else {
      navigate('/overview', { state: { openDeposit: true } });
    }
  }

  const searchCommands = useMemo(
    () => [
      { label: 'Open Nave', keywords: 'nave treasury overview home', run: () => navigate('/overview') },
      { label: 'Open Nave Pay', keywords: 'pay books invoices nave pay', run: () => navigate('/pay') },
      { label: 'Go to Overview', keywords: 'overview dashboard home balance', run: () => navigate('/overview') },
      { label: 'Go to Money & assets', keywords: 'money assets holdings aave compound venues', run: () => navigate('/money') },
      { label: 'Go to Agents', keywords: 'agents coordinator investor guardrail watcher diary freeze', run: () => navigate('/agents') },
      { label: 'Go to Decisions', keywords: 'decisions governance votes proposals', run: () => navigate('/decisions') },
      { label: 'Go to Rules', keywords: 'rules policy constitution reserve', run: () => navigate('/rules') },
      { label: 'Go to Bridge', keywords: 'bridge cross-chain transfer', run: () => navigate('/bridge') },
      { label: 'Go to Stake', keywords: 'stake nave rewards', run: () => navigate('/stake') },
      { label: 'Go to Settings', keywords: 'settings profile members guardians freeze', run: () => navigate('/settings') },
      ...(isTokenGov
        ? [{ label: 'Go to Tokens', keywords: 'tokens mint governance', run: () => navigate('/tokens') }]
        : []),
      { label: 'New treasury', keywords: 'create new treasury dao launch', run: () => navigate('/create-dao') },
      { label: 'Add funds', keywords: 'add funds deposit receive qr wallet', run: () => handleAddFundsClick() },
      {
        label: 'Propose a payment',
        keywords: 'propose payment send withdraw transfer',
        run: () => navigate('/overview', { state: { openCreateTx: true } }),
      },
      {
        label: 'Start a decision',
        keywords: 'start decision proposal vote',
        run: () => navigate('/decisions'),
      },
      {
        label: 'Reports',
        keywords: 'reports monthly statement export',
        run: () => navigate('/overview', { state: { openReports: true } }),
      },
      {
        label: 'See Walkthrough',
        keywords: 'walkthrough tour guide intro onboarding help see again',
        run: () => {
          navigate('/walkthrough', {
            state: daoAddress
              ? { treasuryAddress: daoAddress, live: true, replay: true }
              : { replay: true },
          });
        },
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isTokenGov, daoAddress],
  );

  const filteredSearchCommands = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return searchCommands;
    return searchCommands.filter(
      (cmd) => cmd.label.toLowerCase().includes(q) || cmd.keywords.toLowerCase().includes(q),
    );
  }, [searchCommands, searchQuery]);

  const shareOrAddressValue = useMemo(() => {
    if (dao?.slug) return getDaoPublicUrl(dao.slug);
    return daoAddress ?? '';
  }, [dao?.slug, daoAddress]);

  return (
    <div className="flex h-screen overflow-hidden" style={{ backgroundColor: '#FAF8F3', color: '#111827' }}>
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 lg:hidden"
          style={{ backgroundColor: 'rgba(17, 24, 39, 0.35)', backdropFilter: 'blur(2px)' }}
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar — 210px on warm paper with hairline right border (#EFEAE0) */}
      <aside
        className={`
          fixed inset-y-0 left-0 z-40 flex flex-col w-[210px] border-r
          transition-transform duration-200 ease-out
          lg:static lg:translate-x-0
          ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
        `}
        style={{
          width: '210px',
          backgroundColor: '#FAF8F3',
          borderRight: '1px solid #EFEAE0',
          padding: '22px 18px',
        }}
      >
        {/* Brand — product menu. Tile stays; the word is the active product. */}
        <div className="flex items-center justify-between" style={{ marginBottom: '28px' }}>
          <div ref={productMenuRef} className="min-w-0">
          <button
            type="button"
            onClick={() => setProductModalOpen((open) => !open)}
            aria-haspopup="menu"
            aria-expanded={productModalOpen}
            title="Switch product"
            className="flex items-center bg-transparent border-0 p-0 cursor-pointer min-w-0"
            style={{ gap: '8px' }}
          >
            <NaveMark />
            <b
              style={{
                fontFamily: 'var(--font-display)',
                fontWeight: 400,
                fontSize: '18px',
                color: '#111827',
                letterSpacing: '-0.02em',
                whiteSpace: 'nowrap',
              }}
            >
              {inPay ? 'Nave Pay' : 'Nave'}
            </b>
            <span style={{ color: '#6B7280', fontSize: '12px', flexShrink: 0 }} aria-hidden>
              ⌄
            </span>
          </button>
          <NaveMenu
            open={productModalOpen}
            onClose={() => setProductModalOpen(false)}
            anchorRef={productMenuRef}
            minWidth={220}
          >
            <NaveMenuItem selected={!inPay} onClick={() => chooseProduct('nave')}>
              Nave
            </NaveMenuItem>
            <NaveMenuItem selected={inPay} onClick={() => chooseProduct('pay')}>
              Nave Pay
            </NaveMenuItem>
          </NaveMenu>
          </div>
          <button
            type="button"
            className="lg:hidden p-1 rounded"
            onClick={() => setSidebarOpen(false)}
            aria-label="Close sidebar"
            style={{ color: '#6B7280' }}
          >
            <Fi icon="xmark" style={{ fontSize: '15px' }} />
          </button>
        </div>

        {/* Treasury switcher block (.tname + .tsub) */}
        <button
          type="button"
          onClick={() => setTreasuryModalOpen(true)}
          title="Switch treasury"
          data-onboarding-id="dao-selector"
          className="w-full text-left bg-transparent border-0 p-0 cursor-pointer group"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            marginBottom: '22px',
          }}
        >
          <TreasuryLogo url={dao?.logoUrl} name={daoName} size={34} />
          <span className="min-w-0">
            <span
              className="truncate group-hover:text-brass transition-colors"
              style={{
                display: 'block',
                fontSize: '13.5px',
                fontWeight: 600,
                lineHeight: 1.3,
                color: '#111827',
              }}
            >
              {daoName}
            </span>
            <span
              className="truncate"
              style={{
                display: 'block',
                fontSize: '11.5px',
                color: '#9CA3AF',
                marginTop: '2px',
              }}
            >
              {networkLabel} · {slugOrShortAddr} ⌄
            </span>
          </span>
        </button>

        {/* Nav list (nav.main) */}
        <nav
          className="main flex flex-col overflow-y-auto"
          style={{ gap: '2px' }}
        >
          {navItems.map((item) => {
            const { label, path, onboardingId } = item;
            const state = 'state' in item ? item.state : undefined;
            const active = !state && activeNavPath === path;
            const isAgentsItem = path === '/agents';
            const isDecisionsItem = path === '/decisions';
            return (
              <Link
                key={onboardingId}
                to={path}
                state={state}
                onClick={() => setSidebarOpen(false)}
                onPointerEnter={() => prefetchAppRoute(path)}
                onPointerDown={() => prefetchAppRoute(path)}
                className={`navitem no-underline${active ? ' active' : ''}`}
                data-onboarding-id={onboardingId}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '9px',
                  width: '100%',
                  textAlign: 'left',
                  padding: '8px 10px',
                  borderRadius: '8px',
                  fontSize: '13.5px',
                  fontWeight: active ? 600 : 400,
                  color: active ? '#111827' : '#6B7280',
                  backgroundColor: active ? '#ffffff' : 'transparent',
                  boxShadow: active ? '0 1px 3px rgba(17, 24, 39, 0.05)' : 'none',
                  transition: '0.15s',
                  textDecoration: 'none',
                }}
                onMouseEnter={(e) => {
                  if (!active) {
                    e.currentTarget.style.color = '#111827';
                    e.currentTarget.style.backgroundColor = '#ffffff';
                  }
                }}
                onMouseLeave={(e) => {
                  if (!active) {
                    e.currentTarget.style.color = '#6B7280';
                    e.currentTarget.style.backgroundColor = 'transparent';
                  }
                }}
              >
                <span>{label}</span>
                {isAgentsItem && (
                  <span
                    className="live"
                    title={agentsFrozen ? 'Frozen' : agentsActive ? 'Active' : 'Paused'}
                    style={{
                      marginLeft: 'auto',
                      width: '6px',
                      height: '6px',
                      borderRadius: '50%',
                      backgroundColor: agentsFrozen
                        ? '#9CA3AF'
                        : agentsActive
                          ? '#2F7D4F'
                          : '#B9974F',
                      flexShrink: 0,
                    }}
                  />
                )}
                {isDecisionsItem && activeProposalsCount > 0 && (
                  <span
                    className="n"
                    style={{
                      marginLeft: 'auto',
                      fontSize: '11px',
                      color: '#ffffff',
                      backgroundColor: '#B9974F',
                      minWidth: '18px',
                      height: '18px',
                      borderRadius: '99px',
                      display: 'grid',
                      placeItems: 'center',
                      fontWeight: 600,
                      padding: '0 4px',
                      flexShrink: 0,
                    }}
                  >
                    {activeProposalsCount}
                  </span>
                )}
              </Link>
            );
          })}

          {inPay && (
            <button
              type="button"
              onClick={() => setPayMoreOpen((open) => !open)}
              className="navitem bg-transparent border-0 cursor-pointer"
              style={{
                display: 'flex',
                alignItems: 'center',
                width: '100%',
                textAlign: 'left',
                marginTop: '8px',
                padding: '8px 10px',
                borderRadius: '8px',
                fontSize: '13px',
                color: '#6B7280',
              }}
            >
              {payAdvancedOpen ? 'Fewer books' : 'More books'}
            </button>
          )}

          {!inPay && (
          <button
            type="button"
            onClick={() => {
              navigate('/create-dao');
              setSidebarOpen(false);
            }}
            className="navitem bg-transparent border-0 cursor-pointer"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '9px',
              width: '100%',
              textAlign: 'left',
              marginTop: '14px',
              padding: '8px 10px',
              borderRadius: '8px',
              fontSize: '13.5px',
              fontWeight: activeNavPath === '/create-dao' ? 600 : 400,
              color: activeNavPath === '/create-dao' ? '#111827' : '#6B7280',
              backgroundColor: activeNavPath === '/create-dao' ? '#ffffff' : 'transparent',
              transition: '0.15s',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = '#111827';
              e.currentTarget.style.backgroundColor = '#ffffff';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = activeNavPath === '/create-dao' ? '#111827' : '#6B7280';
              e.currentTarget.style.backgroundColor = activeNavPath === '/create-dao' ? '#ffffff' : 'transparent';
            }}
          >
            + New treasury
          </button>
          )}
        </nav>

        <div
          className="side-foot"
          style={{
            marginTop: 'auto',
            paddingTop: '16px',
            borderTop: '1px solid #EFEAE0',
          }}
        >
          <button
            type="button"
            onClick={handleAddFundsClick}
            className="w-full"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '13px',
              fontWeight: 600,
              borderRadius: '9px',
              padding: '9px 14px',
              border: '1px solid #E7E2D6',
              backgroundColor: '#ffffff',
              color: '#111827',
            }}
          >
            Add funds
          </button>
        </div>
      </aside>

      {/* Main area */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Top Header Bar (<header class="topbar">) */}
        <header
          className="topbar sticky top-0 z-30 flex items-center flex-shrink-0"
          style={{
            gap: '10px',
            padding: isMobile ? '11px 16px' : '13px 32px',
            backgroundColor: 'rgba(250, 248, 243, 0.9)',
            backdropFilter: 'blur(12px)',
            WebkitBackdropFilter: 'blur(12px)',
            borderBottom: '1px solid #EFEAE0',
          }}
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <button
              type="button"
              className="lg:hidden p-1 rounded"
              onClick={() => setSidebarOpen(true)}
              aria-label="Open sidebar"
              style={{ color: '#6B7280' }}
            >
              <Fi icon="bars" style={{ fontSize: '16px' }} />
            </button>
            <AppBreadcrumb crumbs={appBreadcrumbs(location.pathname, location.search)} />
          </div>

          <div
            className="top-actions"
            style={{
              marginLeft: 'auto',
              display: 'flex',
              gap: '8px',
              alignItems: 'center',
              flexShrink: 0,
            }}
          >
            <NotificationFeed />
            <WalletNetworkMenu
              chains={APP_WALLET_CHAINS}
              onNetworkSelect={handleChainSwitch}
              account={{
                role: roleLabel,
                rights:
                  membership.isFounder || membership.isGuardian
                    ? 'Propose, vote, freeze'
                    : 'Propose and vote',
                onSettings: () => {
                  setSidebarOpen(false);
                  navigate('/settings');
                },
              }}
            />
          </div>
        </header>

        {/* Page content */}
        <main
          ref={mainRef}
          className="flex-1 overflow-y-auto"
          style={{
            scrollBehavior: 'auto',
            backgroundColor: '#FAF8F3',
            paddingBottom: isMobile ? 'calc(76px + env(safe-area-inset-bottom, 0px))' : undefined,
          }}
        >
          <div
            className={wide ? 'w-full' : 'mx-auto w-full'}
            style={
              wide
                ? undefined
                : {
                    maxWidth: inPay ? 1120 : 860,
                    padding: isMobile ? '28px 20px 100px' : inPay ? '28px 32px 90px' : '44px 32px 90px',
                  }
            }
          >
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
            borderColor: '#E7E2D6',
            padding: '7px 4px calc(7px + env(safe-area-inset-bottom, 0px))',
          }}
        >
          {navItems.slice(0, 5).map(({ icon, label, path }) => {
            const active = activeNavPath === path;
            return (
              <Link
                key={path}
                to={path}
                onPointerDown={() => prefetchAppRoute(path)}
                className="flex flex-col items-center justify-center gap-0.5 no-underline rounded-[8px] transition-colors"
                style={{
                  padding: '5px 9px',
                  fontSize: '9.5px',
                  fontWeight: active ? 600 : 400,
                  color: active ? '#111827' : '#9CA3AF',
                  backgroundColor: active ? '#FAF8F3' : 'transparent',
                }}
              >
                <Fi icon={icon} style={{ fontSize: '13px', color: 'inherit' }} />
                <span>{label}</span>
              </Link>
            );
          })}
          {!inPay && (
          <Link
            to="/create-dao"
            className="flex flex-col items-center justify-center gap-0.5 no-underline rounded-[8px] transition-colors"
            style={{
              padding: '5px 9px',
              fontSize: '9.5px',
              fontWeight: activeNavPath === '/create-dao' ? 600 : 400,
              color: activeNavPath === '/create-dao' ? '#111827' : '#9CA3AF',
              backgroundColor: activeNavPath === '/create-dao' ? '#FAF8F3' : 'transparent',
            }}
          >
            <Fi icon="plus" style={{ fontSize: '13px', color: 'inherit' }} />
            <span>New</span>
          </Link>
          )}
        </nav>
      )}

      {/* ── Treasury Switcher Modal ───────────────────────────── */}
      <NaveModal
        open={treasuryModalOpen}
        title="Your treasuries"
        onClose={() => setTreasuryModalOpen(false)}
        maxWidth={520}
      >
        <div style={{ padding: '18px 22px 22px' }}>
          {/* Current treasury + one-click copy link/address */}
          {daoAddress && (
            <div
              className="flex items-center gap-2 mb-3"
              style={{
                backgroundColor: '#FAF8F3',
                border: '1px solid #E7E2D6',
                borderRadius: '10px',
                padding: '10px 12px',
              }}
            >
              <div className="flex-1 min-w-0">
                <div style={{ fontSize: '12px', fontWeight: 600, color: '#111827' }} className="truncate">
                  {daoName}
                </div>
                <code
                  className="nave-mono block truncate"
                  style={{ fontSize: '11px', color: '#6B7280', marginTop: '2px' }}
                >
                  {shareOrAddressValue}
                </code>
              </div>
              <button
                type="button"
                onClick={() => copyWithFeedback(shareOrAddressValue, 'treasury-share')}
                style={{
                  fontSize: '12px',
                  fontWeight: 600,
                  borderRadius: '8px',
                  padding: '6px 11px',
                  border: '1px solid #E7E2D6',
                  backgroundColor: '#ffffff',
                  color: copiedKey === 'treasury-share' ? '#2F7D4F' : '#111827',
                  flexShrink: 0,
                }}
              >
                {copiedKey === 'treasury-share' ? 'Copied ✓' : dao?.slug ? 'Copy link' : 'Copy address'}
              </button>
            </div>
          )}

          {/* Watched / available treasuries */}
          <div>
            {watchedDaos.length > 0 ? (
              watchedDaos.map((item) => {
                const isCurrent =
                  !!daoAddress &&
                  item.daoOnchainAddress.toLowerCase() === daoAddress.toLowerCase();
                const itemChainLabel =
                  item.chainId != null && isEvmChainId(item.chainId)
                    ? daoNetworkLabel(item.chainId, SOLANA_NETWORK)
                    : isEvmAddress(item.daoOnchainAddress)
                      ? 'Base'
                      : 'Solana';
                const itemSub = item.slug
                  ? `${itemChainLabel} · nave.finance/${item.slug}`
                  : `${itemChainLabel} · ${shortenAddress(item.daoOnchainAddress)}`;

                return (
                  <button
                    key={item.daoOnchainAddress}
                    type="button"
                    onClick={() => {
                      if (item.chainId != null && isEvmChainId(item.chainId)) {
                        rememberDaoChain(item.daoOnchainAddress, item.chainId);
                      }
                      setDaoAddress(item.daoOnchainAddress);
                      setTreasuryModalOpen(false);
                      setSidebarOpen(false);
                      navigate(inPay ? '/pay' : '/overview', { state: { treasuryAddress: item.daoOnchainAddress } });
                    }}
                    className="w-full text-left flex items-center gap-3 transition-colors group"
                    style={{
                      padding: '12px 4px',
                      borderBottom: '1px solid #EFEAE0',
                    }}
                  >
                    <TreasuryLogo url={item.logoUrl} name={item.name} size={32} />
                    <div className="flex-1 min-w-0">
                      <div
                        className="truncate group-hover:text-brass transition-colors"
                        style={{ fontSize: '14px', fontWeight: 500, color: '#111827' }}
                      >
                        {item.name}
                      </div>
                      <div
                        className="truncate"
                        style={{ fontSize: '12.5px', color: '#6B7280', marginTop: '2px' }}
                      >
                        {itemSub}
                      </div>
                    </div>
                    <span
                      style={{
                        marginLeft: 'auto',
                        fontSize: '12px',
                        fontWeight: isCurrent ? 600 : 400,
                        color: isCurrent ? '#2F7D4F' : '#6B7280',
                        flexShrink: 0,
                      }}
                    >
                      {isCurrent ? 'Current' : 'Switch →'}
                    </span>
                  </button>
                );
              })
            ) : (
              <div style={{ padding: '12px 4px', fontSize: '13px', color: '#6B7280' }}>
                Browse all treasuries in the lobby or create a new one below.
              </div>
            )}
          </div>

          <div
            className="flex items-center justify-end gap-2 flex-wrap"
            style={{
              marginTop: '20px',
              paddingTop: '16px',
              borderTop: '1px solid #EFEAE0',
            }}
          >
            <button
              type="button"
              onClick={() => {
                setTreasuryModalOpen(false);
                setSidebarOpen(false);
                navigate('/treasuries');
              }}
              style={{
                fontSize: '13px',
                fontWeight: 600,
                borderRadius: '9px',
                padding: '8px 14px',
                border: '1px solid #E7E2D6',
                backgroundColor: '#ffffff',
                color: '#111827',
              }}
            >
              All treasuries
            </button>
            <button
              type="button"
              onClick={() => {
                setTreasuryModalOpen(false);
                setSidebarOpen(false);
                navigate('/create-dao');
              }}
              style={{
                fontSize: '13px',
                fontWeight: 600,
                borderRadius: '9px',
                padding: '8px 14px',
                border: '1px solid #111827',
                backgroundColor: '#111827',
                color: '#ffffff',
              }}
            >
              + New treasury
            </button>
          </div>
        </div>
      </NaveModal>

      {/* ── Search / Command Modal (⌕ / ⌘K) ───────────────────── */}
      <NaveModal
        open={searchModalOpen}
        title="Search"
        subtitle="Jump to a page, action, asset, or decision."
        onClose={() => setSearchModalOpen(false)}
        maxWidth={520}
      >
        <div style={{ padding: '18px 22px 22px' }}>
          <div style={{ marginBottom: '16px' }}>
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && filteredSearchCommands.length > 0) {
                  e.preventDefault();
                  const first = filteredSearchCommands[0];
                  setSearchModalOpen(false);
                  first.run();
                }
              }}
              placeholder="Try “report”, “aave”, “freeze”…"
              style={{
                width: '100%',
                border: '1px solid #E7E2D6',
                backgroundColor: '#ffffff',
                borderRadius: '10px',
                padding: '11px 13px',
                fontSize: '14.5px',
                color: '#111827',
                outline: 'none',
              }}
            />
          </div>
          <div>
            {filteredSearchCommands.length > 0 ? (
              filteredSearchCommands.map((cmd) => (
                <button
                  key={cmd.label}
                  type="button"
                  onClick={() => {
                    setSearchModalOpen(false);
                    setSidebarOpen(false);
                    cmd.run();
                  }}
                  className="w-full text-left flex items-center gap-3 group"
                  style={{
                    padding: '12px 4px',
                    borderBottom: '1px solid #EFEAE0',
                  }}
                >
                  <span
                    className="group-hover:text-brass transition-colors"
                    style={{ fontSize: '14px', fontWeight: 500, color: '#111827' }}
                  >
                    {cmd.label}
                  </span>
                  <span style={{ marginLeft: 'auto', color: '#6B7280' }}>→</span>
                </button>
              ))
            ) : (
              <div style={{ padding: '12px 4px', fontSize: '13px', color: '#6B7280' }}>
                No matching pages or actions.
              </div>
            )}
          </div>
        </div>
      </NaveModal>

      {/* ── Deposit Funds Modal (Add funds in header) ─────────── */}
      {depositModalOpen && daoAddress && (
        <DepositFundsModal
          daoAddress={daoAddress}
          daoName={dao?.name}
          vaultMint={votingMint}
          registeredAssets={treasuryAssets.assets}
          initialTab="address"
          onClose={() => setDepositModalOpen(false)}
          onDeposited={() => {
            treasuryAssets.refetch();
          }}
        />
      )}

      {pendingChainFamily && (
        <ChainSwitchConfirmDialog
          fromLabel={chainFamilyLabel(chainFamily)}
          toLabel={chainFamilyLabel(pendingChainFamily)}
          onConfirm={() => void confirmChainSwitch()}
          onCancel={() => setPendingChainFamily(null)}
        />
      )}

      <button
        type="button"
        aria-label="Search"
        title="Search (⌘K)"
        onClick={() => {
          setSearchQuery('');
          setSearchModalOpen(true);
        }}
        style={{
          position: 'fixed',
          right: 20,
          bottom: isMobile ? 'calc(88px + env(safe-area-inset-bottom, 0px))' : 20,
          zIndex: 45,
          width: 46,
          height: 46,
          borderRadius: '50%',
          border: '1px solid #111827',
          backgroundColor: '#111827',
          color: '#ffffff',
          boxShadow: '0 12px 28px -14px rgba(17, 24, 39, 0.55)',
          display: 'grid',
          placeItems: 'center',
          fontSize: 18,
          cursor: 'pointer',
        }}
      >
        ⌕
      </button>
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
