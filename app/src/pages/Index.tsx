import { useState, useEffect, useRef, lazy, Suspense } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { useAccount } from 'wagmi';
import { useConnectModal } from '@rainbow-me/rainbowkit';
import { useScrollReveal } from '../hooks/useScrollReveal';
import Fi from '../components/Fi';
import DevnetBanner from '../components/DevnetBanner';
import WalletNetworkMenu from '../components/WalletNetworkMenu';
import { MOCK_DAO_ADDRESS, DEMO_TREASURY_NAV_ENABLED } from '../lib/mockData';
import { useChain } from '../hooks/useChain';
import { APP_WALLET_CHAINS } from '../lib/chain/types';
import { NAVE_DAO_CREATION_STAKE_USD } from '../lib/programConfig';
import { usePlatformTreasuryStats, formatHeroProtocolUsd } from '../hooks/usePlatformTreasuryStats';
import { useNaveTokenStats, formatNavePrice, formatNaveMarketCap, formatNaveHolders } from '../hooks/useNaveTokenStats';

// The three.js/postprocessing wave background is ~1MB and purely decorative —
// lazy-load it off the critical path so the landing page's hero/copy render
// before the WebGL bundle finishes downloading/parsing.
const Dither = lazy(() => import('../components/Dither'));

/* ── Reduced-motion hook (shared by Hero + Tokenomics Dither) ── */
/** Decorative WebGL stays off the first paint so the hero CTA is not waiting on the Three.js chunk. */
function useAfterFirstPaint() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const start = () => {
      if (!cancelled) setReady(true);
    };
    const idle = window.requestIdleCallback?.(start, { timeout: 1500 });
    const timer = idle == null ? window.setTimeout(start, 200) : undefined;
    return () => {
      cancelled = true;
      if (idle != null) window.cancelIdleCallback?.(idle);
      if (timer != null) window.clearTimeout(timer);
    };
  }, []);
  return ready;
}

function usePrefersReducedMotion() {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setPrefersReducedMotion(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setPrefersReducedMotion(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return prefersReducedMotion;
}

/* ── Reveal wrapper ─────────────────────────────────────── */
function Reveal({
  children,
  className = '',
  variant = 'up',
  stagger = false,
  threshold,
  rootMargin,
}: {
  children: React.ReactNode;
  className?: string;
  variant?: 'up' | 'scale' | 'left' | 'right';
  stagger?: boolean;
  threshold?: number;
  rootMargin?: string;
}) {
  const { ref, visible } = useScrollReveal<HTMLDivElement>({ threshold, rootMargin });

  const variantClass =
    variant === 'scale'
      ? 'sr-visible-scale'
      : variant === 'left'
      ? 'sr-visible-left'
      : variant === 'right'
      ? 'sr-visible-right'
      : 'sr-visible';

  return (
    <div
      ref={ref}
      className={`${stagger ? 'sr-stagger' : ''} ${
        visible ? variantClass : 'sr-hidden'
      } ${className}`}
    >
      {children}
    </div>
  );
}

/* ── NavBar ─────────────────────────────────────────────── */
function NavBar() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const { chainFamily, setChainFamily } = useChain();
  // Homepage only offers Base + Robinhood — coerce leftover Solana/Ethereum selection.
  useEffect(() => {
    if (!APP_WALLET_CHAINS.includes(chainFamily)) {
      setChainFamily('base');
    }
  }, [chainFamily, setChainFamily]);
  const navItems = [
    { label: 'Product', href: '#product' },
    { label: 'Protocol', href: '#protocol' },
    { label: 'Governance', href: '#governance' },
    { label: 'Tokenomics', href: '#tokenomics' },
    { label: 'Pricing', href: '#pricing' },
    { label: 'Bridge & Stake', href: '/bridge' },
    { label: 'Documentation', href: '/docs' },
  ];

  return (
    <>
      <header
        className="fixed top-0 inset-x-0 z-50 flex items-center justify-between px-4 sm:px-6 md:px-10"
        style={{
          height: '56px',
          backgroundColor: 'hsla(0, 0%, 100%, 0.92)',
          backdropFilter: 'blur(12px)',
          borderBottom: '1px solid hsl(var(--border))',
        }}
      >
        <span
          className="text-display"
          style={{ fontSize: '22px', color: 'hsl(var(--foreground))' }}
        >
          Nave
        </span>

        <nav className="hidden md:flex items-center gap-7">
          {navItems.map(item => (
            <a
              key={item.label}
              href={item.href}
              className="transition-colors no-underline"
              style={{ fontSize: '13.5px', color: 'hsl(var(--muted-foreground))' }}
              onMouseEnter={e => (e.currentTarget.style.color = 'hsl(var(--foreground))')}
              onMouseLeave={e => (e.currentTarget.style.color = 'hsl(var(--muted-foreground))')}
            >
              {item.label}
            </a>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          {/* Unified wallet + network control (same as Bridge/Stake). Stays a
              dropdown when connected instead of turning into an "Open App"
              button — app entry lives in the nav links and hero CTAs. */}
          <WalletNetworkMenu chains={APP_WALLET_CHAINS} />

          {/* Mobile hamburger */}
          <button
            className="md:hidden p-1.5 rounded-lg"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            aria-label="Toggle menu"
            style={{ color: 'hsl(var(--muted-foreground))' }}
          >
            <Fi icon={mobileMenuOpen ? 'xmark' : 'bars'} style={{ fontSize: '18px' }} />
          </button>
        </div>
      </header>

      {/* Devnet banner — fixed directly below the nav bar */}
      <div className="fixed inset-x-0 z-40" style={{ top: '56px' }}>
        <DevnetBanner />
      </div>

      {/* Mobile slide-down menu — sits below banner (~56px nav + ~38px banner) */}
      {mobileMenuOpen && (
        <div
          className="fixed inset-x-0 z-[45] md:hidden border-b animate-fade-in"
          style={{
            top: '94px',
            backgroundColor: 'hsl(var(--surface-0))',
            borderColor: 'hsl(var(--border))',
            boxShadow: 'var(--shadow-lg)',
          }}
        >
          <nav className="flex flex-col px-4 py-3 space-y-1">
            {navItems.map(item => (
              <a
                key={item.label}
                href={item.href}
                className="px-3 py-2.5 rounded-lg no-underline transition-colors"
                style={{ fontSize: '14px', color: 'hsl(var(--foreground))' }}
                onClick={() => setMobileMenuOpen(false)}
              >
                {item.label}
              </a>
            ))}
          </nav>
        </div>
      )}
    </>
  );
}

/* ── Hero ───────────────────────────────────────────────── */
function Hero() {
  const navigate = useNavigate();
  const { publicKey, connected: solanaConnected } = useWallet();
  const { setVisible } = useWalletModal();
  const { address: evmAddress } = useAccount();
  const { openConnectModal } = useConnectModal();
  const { target } = useChain();
  const isEvm = target.kind === 'evm';
  const connected = isEvm ? !!evmAddress : solanaConnected;
  const pendingCreate = useRef(false);
  const openConnect = () => (isEvm ? openConnectModal?.() : setVisible(true));
  const launchTreasury = () => {
    if (isEvm ? evmAddress : publicKey) {
      navigate('/create-dao');
      return;
    }
    pendingCreate.current = true;
    openConnect();
  };
  useEffect(() => {
    if (!pendingCreate.current) return;
    if (isEvm ? evmAddress : publicKey) {
      pendingCreate.current = false;
      navigate('/create-dao');
    }
  }, [evmAddress, publicKey, isEvm, navigate]);
  const { stats, loading: statsLoading, error: statsError } = usePlatformTreasuryStats();

  const prefersReducedMotion = usePrefersReducedMotion();
  const showDither = useAfterFirstPaint();

  const treasuriesDisplay = statsError ? '—' : statsLoading ? '…' : (stats?.treasuryCount ?? 0).toLocaleString();
  const tvlDisplay = statsError ? '—' : statsLoading ? '…' : formatHeroProtocolUsd(stats?.tvlUsd ?? 0);
  const yieldDisplay = statsError ? '—' : statsLoading ? '…' : formatHeroProtocolUsd(stats?.yieldGeneratedUsd ?? 0);

  const heroStats = [
    { value: treasuriesDisplay, label: 'Treasuries' },
    { value: tvlDisplay, label: 'TVL' },
    { value: yieldDisplay, label: 'Yield Generated' },
  ];

  return (
    <section
      className="relative flex flex-col items-center justify-center text-center px-6 pt-44 pb-28 overflow-hidden"
      style={{ minHeight: '94vh' }}
    >
      {/* Dither wave background */}
      <div
        className="absolute inset-0 z-0 pointer-events-none"
        style={{
          opacity: 0.38,
          mixBlendMode: 'multiply',
        }}
        aria-hidden
      >
        {showDither && (
        <Suspense fallback={null}>
          <Dither
            variant="ocean"
            waveColor={[0.86, 0.85, 0.83]}
            colorNum={5}
            pixelSize={2}
            waveAmplitude={0.3}
            waveFrequency={3}
            waveSpeed={0.08}
            disableAnimation={prefersReducedMotion}
            enableMouseInteraction={false}
            mouseRadius={0.25}
          />
        </Suspense>
        )}
      </div>

      {/* Soft vignette — keeps headline readable on white */}
      <div
        className="absolute inset-0 z-[1] pointer-events-none"
        style={{
          background:
            'radial-gradient(ellipse 60% 50% at 50% 45%, hsl(var(--background)) 30%, transparent 85%)',
        }}
      />

      {/* Headline */}
      <h1
        className="relative z-10 text-display hero-h1 mb-6"
        style={{
          fontSize: 'clamp(34px, 6.5vw, 76px)',
          lineHeight: 1.05,
          letterSpacing: '-0.02em',
          color: 'hsl(var(--foreground))',
          maxWidth: '820px',
          fontWeight: '400',
        }}
      >
        The autonomous treasury{' '}
        <span className="hidden sm:inline"><br /></span>
        <span style={{ fontStyle: 'italic', color: 'hsl(var(--muted-foreground))' }}>
          operating system
        </span>
      </h1>

      {/* Subhead */}
      <p
        className="relative z-10 hero-sub max-w-xl"
        style={{
          fontSize: '16.5px',
          lineHeight: 1.7,
          color: 'hsl(var(--muted-foreground))',
          fontWeight: '400',
        }}
      >
        Nave enables internet-native organizations to govern, grow, and deploy capital
        through soulbound policy-driven AI agents — create a treasury on Base or Robinhood.
      </p>

      {/* CTAs */}
      <div className="relative z-10 flex flex-wrap items-center justify-center gap-3 mt-10 hero-cta">
        <button
          onClick={launchTreasury}
          className="flex items-center gap-2 px-7 py-3 rounded-lg font-medium transition-all"
          style={{
            backgroundColor: 'hsl(var(--primary))',
            color: 'hsl(var(--primary-foreground))',
            fontSize: '14px',
            boxShadow: 'var(--shadow-md)',
          }}
          onMouseEnter={e => {
            e.currentTarget.style.transform = 'translateY(-2px)';
            e.currentTarget.style.boxShadow = 'var(--shadow-lg)';
          }}
          onMouseLeave={e => {
            e.currentTarget.style.transform = '';
            e.currentTarget.style.boxShadow = 'var(--shadow-md)';
          }}
        >
          <Fi icon="castle" style={{ fontSize: '13px' }} />
          Launch a Treasury
        </button>
        <button
          onClick={() => {
            if (connected) {
              if (DEMO_TREASURY_NAV_ENABLED) {
                navigate('/dashboard', { state: { treasuryAddress: MOCK_DAO_ADDRESS } });
              } else {
                navigate('/treasuries');
              }
            } else {
              openConnect();
            }
          }}
          className="flex items-center gap-2 px-7 py-3 rounded-lg font-medium transition-all border"
          style={{
            fontSize: '14px',
            color: 'hsl(var(--foreground))',
            borderColor: 'hsl(var(--border-strong))',
            backgroundColor: 'hsl(var(--surface-0))',
          }}
          onMouseEnter={e =>
            (e.currentTarget.style.backgroundColor = 'hsl(var(--surface-1))')
          }
          onMouseLeave={e =>
            (e.currentTarget.style.backgroundColor = 'hsl(var(--surface-0))')
          }
        >
          <Fi icon="arrow-right-to-bracket" style={{ fontSize: '13px' }} />
          {connected && !DEMO_TREASURY_NAV_ENABLED ? 'Open App' : 'View Dashboard'}
        </button>
      </div>

      {/* Decorative line */}
      <div
        className="relative z-10 hero-line mx-auto mt-14"
        style={{ height: '1px', backgroundColor: 'hsl(var(--border-strong))' }}
      />

      {/* Live protocol aggregates (Supabase RPC `get_platform_treasury_stats`). */}
      <div className="relative z-10 flex flex-wrap justify-center gap-8 sm:gap-12 md:gap-16 mt-10 max-w-3xl mx-auto">
        {heroStats.map(s => (
          <div key={s.label} className="text-center hero-stat min-w-[100px]">
            <div
              className="text-display"
              style={{ fontSize: '28px', color: 'hsl(var(--foreground))' }}
            >
              {s.value}
            </div>
            <div
              style={{
                fontSize: '11px',
                color: 'hsl(var(--muted-foreground))',
                fontFamily: 'var(--font-mono)',
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
                marginTop: '4px',
              }}
            >
              {s.label}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ── Feature pill data ──────────────────────────────────── */
const FEATURES = [
  {
    icon: 'book',
    title: 'Treasury Constitution',
    desc: 'Define approved protocols, reserve ratios, deployment limits, risk tolerances, and treasury mandates through an institutional-grade visual policy engine.',
    tag: 'Core',
  },
  {
    icon: 'share-nodes',
    title: 'Multi-Agent Coordination',
    desc: 'Four soulbound AI agents — Executive, Financial, Oversight, and Operational — coordinate treasury operations under constitutional governance mandates.',
    tag: 'Agents',
  },
  {
    icon: 'desktop',
    title: 'Treasury Dashboard',
    desc: 'Real-time overview of treasury health, allocation breakdown, yield analytics, accounting, and autonomous agent monitoring.',
    tag: 'Analytics',
  },
  {
    icon: 'shield',
    title: 'Governance System',
    desc: 'On-chain proposals, quorum thresholds, voting, and execution pipeline. Governance occurs before autonomous execution.',
    tag: 'DAO',
  },
  {
    icon: 'database',
    title: 'Yield Routing',
    desc: 'Yield follows the treasury chain. Base and Robinhood use configured lending adapters such as Aave and Compound. Solana staking stays on Bridge and Stake.',
    tag: 'Yield',
  },
  {
    icon: 'layer-group',
    title: 'Multisig Execution',
    desc: '3-key autonomous agent multisig coordination. Executive signs first, Financial second, Oversight validates and signs final approval.',
    tag: 'Security',
  },
];

function Features() {
  return (
    <section id="product" className="px-6 md:px-10 py-28 max-w-6xl mx-auto">
      <Reveal className="text-center mb-16">
        <div className="nave-section-label mb-4">Phase 1 Product</div>
        <h2
          className="text-display"
          style={{ fontSize: 'clamp(28px, 4vw, 44px)', letterSpacing: '-0.02em', fontWeight: '400' }}
        >
          Autonomous treasury coordination
        </h2>
        <p
          style={{
            color: 'hsl(var(--muted-foreground))',
            maxWidth: '520px',
            margin: '14px auto 0',
            fontSize: '15.5px',
            lineHeight: 1.7,
          }}
        >
          From constitutional policy enforcement to multi-agent execution —
          institutional-grade treasury infrastructure in one protocol.
        </p>
      </Reveal>

      <Reveal stagger className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {FEATURES.map(({ icon, title, desc, tag }) => (
          <div key={title} className="nave-card nave-card-hover p-6 flex flex-col gap-4">
            <div className="flex items-start justify-between">
              <div
                className="w-9 h-9 rounded-lg flex items-center justify-center"
                style={{
                  backgroundColor: 'hsl(var(--surface-1))',
                  border: '1px solid hsl(var(--border))',
                }}
              >
                <Fi icon={icon} style={{ fontSize: '15px', color: 'hsl(var(--foreground))' }} />
              </div>
              <span
                style={{
                  fontSize: '10px',
                  fontFamily: 'var(--font-mono)',
                  fontWeight: '500',
                  letterSpacing: '0.08em',
                  color: 'hsl(var(--muted-foreground))',
                  border: '1px solid hsl(var(--border))',
                  borderRadius: '4px',
                  padding: '2px 6px',
                }}
              >
                {tag}
              </span>
            </div>
            <div>
              <div
                style={{
                  fontSize: '15px',
                  color: 'hsl(var(--foreground))',
                  fontWeight: '600',
                  marginBottom: '6px',
                }}
              >
                {title}
              </div>
              <p style={{ fontSize: '13.5px', lineHeight: 1.65, color: 'hsl(var(--muted-foreground))' }}>
                {desc}
              </p>
            </div>
          </div>
        ))}
      </Reveal>
    </section>
  );
}

/* ── Agent architecture ─────────────────────────────────── */
const AGENTS = [
  {
    icon: 'crown',
    role: 'Executive Agent',
    tag: 'Strategic Coordinator',
    desc: 'Interprets governance proposals, coordinates treasury intent, validates constitutional alignment, and signs first multisig approval.',
  },
  {
    icon: 'money-bill-wave',
    role: 'Financial Agent',
    tag: 'Operations Layer',
    desc: 'Handles treasury execution, yield optimization, capital deployment, transaction preparation, and signs second multisig approval.',
  },
  {
    icon: 'eye',
    role: 'Oversight Agent',
    tag: 'Safeguard Layer',
    desc: 'Enforces constitutional compliance, reviews all agent decisions, validates execution safety, and signs final multisig approval.',
  },
  {
    icon: 'gear',
    role: 'Operational Agent',
    tag: 'Monitoring Layer',
    desc: 'Continuous treasury monitoring, accounting, analytics, optimization recommendations, suspicious activity detection, and emergency halt capabilities.',
  },
];

function AgentArchitecture() {
  return (
    <section
      id="protocol"
      className="px-6 md:px-10 py-28"
      style={{
        backgroundColor: 'hsl(var(--surface-1))',
        borderTop: '1px solid hsl(var(--border))',
        borderBottom: '1px solid hsl(var(--border))',
      }}
    >
      <div className="max-w-6xl mx-auto">
        <Reveal className="text-center mb-16">
          <div className="nave-section-label mb-4">Protocol Architecture</div>
          <h2
            className="text-display"
            style={{ fontSize: 'clamp(26px, 3.5vw, 40px)', letterSpacing: '-0.02em', fontWeight: '400' }}
          >
            Multi-Agent Constitutional
            <br />
            <span style={{ fontStyle: 'italic', color: 'hsl(var(--muted-foreground))' }}>
              Treasury Governance
            </span>
          </h2>
          <p
            style={{
              color: 'hsl(var(--muted-foreground))',
              maxWidth: '560px',
              margin: '14px auto 0',
              fontSize: '15px',
              lineHeight: 1.7,
            }}
          >
            Every Nave DAO operates through four permanent soulbound AI agents —
            identity-bound fiduciary operators acting under constitutional mandates.
          </p>
        </Reveal>

        <Reveal stagger className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {AGENTS.map(({ icon, role, tag, desc }) => (
            <div key={role} className="nave-card nave-card-hover p-6">
              <div className="flex items-start gap-4">
                <div
                  className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0"
                  style={{ backgroundColor: 'hsl(var(--primary))' }}
                >
                  <Fi icon={icon} style={{ fontSize: '16px', color: 'white' }} />
                </div>
                <div className="flex-1">
                  <div
                    style={{ fontSize: '15px', fontWeight: '600', color: 'hsl(var(--foreground))', marginBottom: '4px' }}
                  >
                    {role}
                  </div>
                  <span
                    className="inline-block mb-2"
                    style={{
                      fontSize: '10px',
                      fontFamily: 'var(--font-mono)',
                      letterSpacing: '0.06em',
                      color: 'hsl(var(--muted-foreground))',
                      border: '1px solid hsl(var(--border))',
                      borderRadius: '3px',
                      padding: '1px 6px',
                    }}
                  >
                    {tag}
                  </span>
                  <p style={{ fontSize: '13.5px', lineHeight: 1.65, color: 'hsl(var(--muted-foreground))' }}>
                    {desc}
                  </p>
                </div>
              </div>
            </div>
          ))}
        </Reveal>

        {/* Execution flow */}
        <Reveal variant="scale" className="mt-12">
          <div className="nave-card p-6">
            <div className="nave-section-label mb-5" style={{ fontSize: '10px' }}>
              Execution Flow
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              {[
                { step: '01', label: 'Governance Vote', desc: 'DAO token holders approve proposal' },
                { step: '02', label: 'Executive Review', desc: 'Constitutional alignment validated, first signature' },
                { step: '03', label: 'Financial Execution', desc: 'Transaction prepared, profitability verified, second signature' },
                { step: '04', label: 'Oversight Approval', desc: 'Compliance validated, final signature, treasury executes' },
              ].map(({ step, label, desc }) => (
                <div key={step} className="flex items-start gap-3">
                  <span
                    style={{
                      fontSize: '22px',
                      fontFamily: 'var(--font-display)',
                      color: 'hsl(var(--border-strong))',
                      lineHeight: 1,
                      flexShrink: 0,
                    }}
                  >
                    {step}
                  </span>
                  <div>
                    <div style={{ fontSize: '13.5px', fontWeight: '600', color: 'hsl(var(--foreground))', marginBottom: '2px' }}>
                      {label}
                    </div>
                    <div style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.5 }}>
                      {desc}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

/* ── DAO types ──────────────────────────────────────────── */
const DAO_TYPES = [
  { icon: 'code', title: 'Protocol Treasuries', desc: 'Institutional-grade reserve management for protocol capital.' },
  { icon: 'users', title: 'Creator Economies', desc: 'Revenue-sharing treasuries for creator communities.' },
  { icon: 'gamepad', title: 'Gaming Guilds', desc: 'In-game asset treasuries and coordinated yield strategies.' },
  { icon: 'landmark', title: 'Investment Collectives', desc: 'On-chain capital vehicles with constitutional governance.' },
  { icon: 'globe', title: 'Internet-Native Communities', desc: 'Autonomous treasury coordination for any internet organization.' },
];

function DAOTypes() {
  return (
    <section className="px-6 md:px-10 py-24 max-w-6xl mx-auto">
      <div className="flex flex-col md:flex-row md:items-end md:justify-between mb-12 gap-4">
        <Reveal variant="left">
          <div className="nave-section-label mb-3">Supported Treasuries</div>
          <h2
            className="text-display"
            style={{ fontSize: 'clamp(24px, 3.5vw, 36px)', letterSpacing: '-0.02em', fontWeight: '400' }}
          >
            Any organization.
            <br />
            <span style={{ fontStyle: 'italic', color: 'hsl(var(--muted-foreground))' }}>
              Any treasury.
            </span>
          </h2>
        </Reveal>
        <Reveal variant="right">
          <p style={{ fontSize: '14px', color: 'hsl(var(--muted-foreground))', maxWidth: '340px', lineHeight: 1.6 }}>
            Purpose-built to support every model of internet-native organization
            managing collective capital.
          </p>
        </Reveal>
      </div>

      <Reveal stagger className="flex flex-wrap gap-3">
        {DAO_TYPES.map(({ icon, title, desc }) => (
          <div
            key={title}
            className="flex items-start gap-3 px-4 py-3.5 rounded-xl border transition-colors"
            style={{
              flex: '1 1 240px',
              backgroundColor: 'hsl(var(--surface-0))',
              borderColor: 'hsl(var(--border))',
            }}
            onMouseEnter={e => (e.currentTarget.style.borderColor = 'hsl(var(--border-strong))')}
            onMouseLeave={e => (e.currentTarget.style.borderColor = 'hsl(var(--border))')}
          >
            <div
              className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5"
              style={{ backgroundColor: 'hsl(var(--surface-1))', border: '1px solid hsl(var(--border))' }}
            >
              <Fi icon={icon} style={{ fontSize: '13px', color: 'hsl(var(--foreground))' }} />
            </div>
            <div>
              <div style={{ fontSize: '13.5px', fontWeight: '500', marginBottom: '3px' }}>{title}</div>
              <div style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.55 }}>{desc}</div>
            </div>
          </div>
        ))}
      </Reveal>
    </section>
  );
}

/* ── Constitution showcase ──────────────────────────────── */
function ConstitutionShowcase() {
  return (
    <section
      id="governance"
      className="px-6 md:px-10 py-28"
      style={{
        backgroundColor: 'hsl(var(--surface-1))',
        borderTop: '1px solid hsl(var(--border))',
        borderBottom: '1px solid hsl(var(--border))',
      }}
    >
      <div className="max-w-6xl mx-auto grid lg:grid-cols-2 gap-14 items-center">
        <Reveal variant="left">
          <div className="nave-section-label mb-4">Treasury Constitution</div>
          <h2
            className="text-display mb-5"
            style={{ fontSize: 'clamp(26px, 3.5vw, 40px)', letterSpacing: '-0.02em', lineHeight: 1.1, fontWeight: '400' }}
          >
            Programmable treasury policy,
            <br />
            <span style={{ fontStyle: 'italic', color: 'hsl(var(--muted-foreground))' }}>
              not governance scripting.
            </span>
          </h2>
          <p style={{ fontSize: '15px', lineHeight: 1.7, color: 'hsl(var(--muted-foreground))', marginBottom: '28px' }}>
            DAO members configure treasury rules through an institutional visual interface. The
            four autonomous agents are then constitutionally bound to operate exclusively
            within those parameters.
          </p>
          <div className="space-y-3">
            {[
              'Approved protocols and asset whitelist',
              'Treasury reserve ratios and deployment limits',
              'Risk tolerances and liquidity requirements',
              'Rebalancing frequency and allocation mandates',
              'Emergency governance controls',
            ].map(item => (
              <div key={item} className="flex items-center gap-2.5">
                <Fi icon="angle-right" style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))', flexShrink: 0 }} />
                <span style={{ fontSize: '13.5px', color: 'hsl(var(--foreground))' }}>{item}</span>
              </div>
            ))}
          </div>
        </Reveal>

        <Reveal variant="right">
          <div className="nave-card p-0 overflow-hidden">
            <div className="px-5 py-3.5 border-b" style={{ borderColor: 'hsl(var(--border))' }}>
              <span style={{ fontSize: '13px', fontWeight: '600' }}>Treasury Constitution</span>
            </div>
            <div className="p-5 space-y-4">
              {[
                { label: 'Minimum Stablecoin Reserve', value: '35%' },
                { label: 'Maximum Deployment', value: '65%' },
                { label: 'Liquidity Requirement', value: '15%' },
                { label: 'Rebalancing Frequency', value: 'Weekly' },
              ].map(({ label, value }) => (
                <div key={label} className="flex items-center justify-between">
                  <span style={{ fontSize: '13px', color: 'hsl(var(--foreground))' }}>{label}</span>
                  <span
                    className="px-2 py-0.5 rounded"
                    style={{
                      fontSize: '12px',
                      fontFamily: 'var(--font-mono)',
                      backgroundColor: 'hsl(var(--surface-1))',
                      border: '1px solid hsl(var(--border))',
                      color: 'hsl(var(--foreground))',
                      fontWeight: '500',
                    }}
                  >
                    {value}
                  </span>
                </div>
              ))}
              <div className="h-px" style={{ backgroundColor: 'hsl(var(--border))' }} />
              <div>
                <div className="nave-label mb-2" style={{ fontSize: '10px' }}>Approved Protocols</div>
                <div className="flex flex-wrap gap-1.5">
                  {['Jito', 'Kamino', 'MarginFi'].map(p => (
                    <span
                      key={p}
                      className="px-2.5 py-1 rounded-md"
                      style={{
                        fontSize: '11.5px',
                        fontFamily: 'var(--font-mono)',
                        backgroundColor: 'hsl(var(--surface-1))',
                        border: '1px solid hsl(var(--border))',
                        color: 'hsl(var(--foreground))',
                      }}
                    >
                      {p}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

/* ── Brand icons (DexScreener, GeckoTerminal) ──────────────
   Inline so they inherit `color` like a normal icon font — both render
   solid black on the homepage per design. Stroke paths sourced from the
   Arcticons set (CC BY-SA 4.0), matching outline style for both marks. */
function DexScreenerIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" style={{ color: '#000' }}>
      <path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.4} d="M12.951 10.765c-4.384 7.074.244 15.697-5.366 25.358l4.657-3.436v0l3.196 5.208l3.23-3.12L24 43.492l5.332-8.715l3.23 3.12l3.196-5.21l4.657 3.437c-5.61-9.66-.982-18.284-5.366-25.358" />
      <path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.4} d="m19.89 23.502l-3.424 2.037c4.622.794 6.467 7.03 7.534 12.389c1.067-5.36 2.912-11.595 7.534-12.389l-3.423-2.037c.436-3.3-1.91-6.552-4.111-6.552s-4.547 3.253-4.11 6.552" />
      <path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.4} d="M26.522 17.69c4.604-2.337 9.597-6.354 11.318-12.439c-1.07 1.375-2.66 2.767-4.518 3.283a15 15 0 0 0-.685-.66C29.536 5.057 27.25 4.508 24 4.508s-5.536.55-8.637 3.364q-.36.329-.685.661c-1.858-.516-3.449-1.908-4.518-3.283c1.72 6.085 6.714 10.102 11.318 12.44" />
      <path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.4} d="M16.049 14.43c-1.098.875-1.352 2.643-.558 3.899c.928 1.47 3.689 2.26 5.117.995m11.343-4.894c1.098.875 1.352 2.643.558 3.899c-.928 1.47-3.689 2.26-5.117.995" />
    </svg>
  );
}

function GeckoTerminalIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" style={{ color: '#000' }}>
      <circle cx={24} cy={24} r={21.5} stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.4} />
      <path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.4} d="M7.051 37.228c4.519-9.359 1.828-21.471 9.117-23.377s12.056 1.345 15.87 2.467s6.978 1.716 7.682 5.27C40.729 26.693 24.13 35.71 27.664 45.5" />
      <path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.4} d="M24.355 26.972c3.196 2.523 6.496 1.685 13.796-1.373m-8.302-10.062c0-2.273-4.148-4.098-6.719-2.079" />
      <circle cx={21.047} cy={19.122} r={3.308} stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.4} />
      <circle cx={34.841} cy={22.991} r={1.4} fill="currentColor" />
      <path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.4} d="M42.375 22.99A18.404 18.404 0 0 0 25.033 5.628" />
    </svg>
  );
}

/* ── 24h price line chart — black line, white glow, no axes/labels ──
   Deliberately minimal: just the shape of the last 24h, meant to be seen
   "through" the dither behind it, not read as a working chart. */
function TokenPriceChart({ data }: { data: { t: number; price: number }[] }) {
  if (data.length < 2) return null;
  const w = 400;
  const h = 180;
  const prices = data.map((d) => d.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || max || 1;
  const points = data
    .map((d, i) => {
      const x = (i / (data.length - 1)) * w;
      const y = h - ((d.price - min) / range) * h * 0.86 - h * 0.07;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      style={{ width: '100%', height: '100%', display: 'block' }}
      aria-hidden
    >
      <polyline
        points={points}
        fill="none"
        stroke="#000"
        strokeWidth={3.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{
          filter:
            'drop-shadow(0 0 3px rgba(255,255,255,0.95)) drop-shadow(0 0 8px rgba(255,255,255,0.85)) drop-shadow(0 0 16px rgba(255,255,255,0.6))',
        }}
      />
    </svg>
  );
}

/* ── Tokenomics ─────────────────────────────────────────── */
const TOKEN_UTILITIES = [
  {
    icon: 'wand-magic-sparkles',
    title: 'Form DAOs',
    desc: `Stake $${NAVE_DAO_CREATION_STAKE_USD} NAVE to form a DAO and activate its treasury infrastructure. The stake is recoverable — it replaces the old SOL creation fee, not a cost.`,
  },
  {
    icon: 'shield',
    title: 'Vote',
    desc: 'Participate in DAO votes and treasury decisions wherever token governance is enabled, aligning holders with protocol direction.',
  },
  {
    icon: 'ship',
    title: 'Fair Launch',
    desc: 'Fully fair launched with no team allocation and no team supply — distribution is open to the community from day one.',
  },
];

function Tokenomics() {
  const prefersReducedMotion = usePrefersReducedMotion();
  const showDither = useAfterFirstPaint();
  const { stats } = useNaveTokenStats();
  const [addressCopied, setAddressCopied] = useState(false);
  const contractAddress = stats?.contractAddress ?? 'EGg56E1YtL5YapzkF7vkRThHR8i5FeRvm2LLuySdYory';
  const shortAddress = `${contractAddress.slice(0, 4)}…${contractAddress.slice(-4)}`;
  const dexscreenerUrl = stats?.links.dexscreener ?? `https://dexscreener.com/solana/${contractAddress}`;
  const geckoterminalUrl = stats?.links.geckoterminal ?? `https://www.geckoterminal.com/solana/tokens/${contractAddress}`;

  function copyAddress() {
    void navigator.clipboard.writeText(contractAddress);
    setAddressCopied(true);
    setTimeout(() => setAddressCopied(false), 1800);
  }

  return (
    <section id="tokenomics" className="px-6 md:px-10 py-28">
      <div className="max-w-6xl mx-auto">
        <div className="grid lg:grid-cols-2 gap-14 items-center">
          {/* Left: headline + narrative */}
          <Reveal variant="left">
            <div className="nave-section-label mb-4">
              <Fi icon="coins" style={{ fontSize: '11px', marginRight: '6px' }} />
              Tokenomics
            </div>
            <h2
              className="text-display mb-5"
              style={{ fontSize: 'clamp(26px, 3.5vw, 40px)', letterSpacing: '-0.02em', lineHeight: 1.1, fontWeight: '400' }}
            >
              Nave Shares align treasury
              <br />
              <span style={{ fontStyle: 'italic', color: 'hsl(var(--muted-foreground))' }}>
                creation and governance.
              </span>
            </h2>
            <p style={{ fontSize: '15px', lineHeight: 1.7, color: 'hsl(var(--muted-foreground))', marginBottom: '20px' }}>
              <span style={{ color: 'hsl(var(--foreground))' }}>Nave Shares</span> (ticker{' '}
              <span style={{ fontFamily: 'var(--font-mono)', color: 'hsl(var(--foreground))' }}>$NAVE</span>) are the
              protocol token of Nave, capped at a fixed maximum supply. Holders stake Nave Shares to form DAOs,
              activate treasury infrastructure, and participate in governance where it is enabled.
            </p>
            <div className="space-y-3">
              {[
                'Fixed maximum supply of 500,000 $NAVE',
                `Recoverable $${NAVE_DAO_CREATION_STAKE_USD} NAVE staked to form a DAO`,
                'Governance over DAO votes and treasury decisions',
                'Fully fair launched — no team allocation or supply',
              ].map(item => (
                <div key={item} className="flex items-center gap-2.5">
                  <Fi icon="angle-right" style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))', flexShrink: 0 }} />
                  <span style={{ fontSize: '13.5px', color: 'hsl(var(--foreground))' }}>{item}</span>
                </div>
              ))}
            </div>
          </Reveal>

          {/* Right: Dither-backed supply card */}
          <Reveal variant="right">
            <div className="nave-card p-0 overflow-hidden relative" style={{ minHeight: '300px' }}>
              {/* Contained Dither visual */}
              <div className="absolute inset-0 z-0 pointer-events-none" style={{ opacity: 0.4, mixBlendMode: 'multiply' }} aria-hidden>
                {showDither && (
                <Suspense fallback={null}>
                  <Dither
                    waveColor={[0.82, 0.81, 0.79]}
                    colorNum={5}
                    pixelSize={2}
                    waveAmplitude={0.28}
                    waveFrequency={3}
                    waveSpeed={0.06}
                    disableAnimation={prefersReducedMotion}
                    enableMouseInteraction={false}
                    mouseRadius={0.25}
                  />
                </Suspense>
                )}
              </div>
              {/* 24h price chart — shown "through" the dither, not meant to be read precisely */}
              {stats && stats.chain.length > 1 && (
                <div className="absolute pointer-events-none" style={{ zIndex: 1, inset: '8% 4% 30% 4%', opacity: 0.8 }} aria-hidden>
                  <TokenPriceChart data={stats.chain} />
                </div>
              )}
              {/* Soft wash to keep figures readable */}
              <div
                className="absolute inset-0 z-[2] pointer-events-none"
                style={{ background: 'radial-gradient(ellipse 70% 60% at 50% 45%, hsl(var(--surface-0)) 20%, transparent 90%)' }}
              />
              <div className="relative z-10 flex flex-col items-center justify-center text-center px-6 py-14">
                <div className="nave-label mb-3" style={{ fontSize: '10px' }}>
                  Max Supply
                </div>
                <div
                  className="text-display"
                  style={{ fontSize: 'clamp(44px, 8vw, 72px)', letterSpacing: '-0.02em', lineHeight: 1, color: 'hsl(var(--foreground))' }}
                >
                  500,000
                </div>
                <div
                  className="mt-3 px-2.5 py-0.5 rounded"
                  style={{
                    fontSize: '13px',
                    fontFamily: 'var(--font-mono)',
                    backgroundColor: 'hsl(var(--surface-1))',
                    border: '1px solid hsl(var(--border))',
                    color: 'hsl(var(--foreground))',
                    fontWeight: '500',
                  }}
                >
                  $NAVE
                </div>
                <div style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))', marginTop: '12px', maxWidth: '260px', lineHeight: 1.6 }}>
                  Nave Shares — the protocol token, fixed and fully fair launched.
                </div>

                {/* Live price / market cap / holders */}
                <div className="flex items-center gap-5 mt-6">
                  {[
                    { label: 'Price', value: formatNavePrice(stats?.priceUsd ?? null) },
                    { label: 'Market Cap', value: formatNaveMarketCap(stats?.marketCapUsd ?? null) },
                    { label: 'Holders', value: formatNaveHolders(stats?.holders ?? null) },
                  ].map((stat) => (
                    <div key={stat.label}>
                      <div className="nave-label" style={{ fontSize: '9px', marginBottom: '3px' }}>
                        {stat.label}
                      </div>
                      <div
                        className="text-display"
                        style={{ fontSize: '16px', color: 'hsl(var(--foreground))', fontFamily: 'var(--font-mono)' }}
                      >
                        {stat.value}
                      </div>
                    </div>
                  ))}
                </div>

                {/* Contract address — copy to clipboard */}
                <button
                  type="button"
                  onClick={copyAddress}
                  title={contractAddress}
                  className="flex items-center gap-2 mt-5 px-3 py-1.5 rounded-full transition-colors"
                  style={{
                    fontSize: '11.5px',
                    fontFamily: 'var(--font-mono)',
                    backgroundColor: 'hsl(var(--surface-1))',
                    border: '1px solid hsl(var(--border))',
                    color: 'hsl(var(--muted-foreground))',
                    cursor: 'pointer',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'hsl(var(--border-strong))')}
                  onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'hsl(var(--border))')}
                >
                  {addressCopied ? 'Copied!' : `Solana: ${shortAddress}`}
                  <Fi icon={addressCopied ? 'check' : 'copy'} style={{ fontSize: '10px' }} />
                </button>

                {/* DexScreener / GeckoTerminal backlinks */}
                <div className="flex items-center gap-3 mt-4">
                  <a
                    href={dexscreenerUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="View on DexScreener"
                    className="flex items-center justify-center rounded-full transition-opacity"
                    style={{ width: '30px', height: '30px', backgroundColor: 'hsl(var(--surface-1))', border: '1px solid hsl(var(--border))' }}
                    onMouseEnter={(e) => (e.currentTarget.style.opacity = '0.7')}
                    onMouseLeave={(e) => (e.currentTarget.style.opacity = '1')}
                  >
                    <DexScreenerIcon size={15} />
                  </a>
                  <a
                    href={geckoterminalUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="View on GeckoTerminal"
                    className="flex items-center justify-center rounded-full transition-opacity"
                    style={{ width: '30px', height: '30px', backgroundColor: 'hsl(var(--surface-1))', border: '1px solid hsl(var(--border))' }}
                    onMouseEnter={(e) => (e.currentTarget.style.opacity = '0.7')}
                    onMouseLeave={(e) => (e.currentTarget.style.opacity = '1')}
                  >
                    <GeckoTerminalIcon size={15} />
                  </a>
                </div>
              </div>
            </div>
          </Reveal>
        </div>

        {/* Utility cards */}
        <Reveal stagger className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-12">
          {TOKEN_UTILITIES.map(({ icon, title, desc }) => (
            <div key={title} className="nave-card nave-card-hover p-6 flex flex-col gap-4">
              <div
                className="w-9 h-9 rounded-lg flex items-center justify-center"
                style={{ backgroundColor: 'hsl(var(--surface-1))', border: '1px solid hsl(var(--border))' }}
              >
                <Fi icon={icon} style={{ fontSize: '15px', color: 'hsl(var(--foreground))' }} />
              </div>
              <div>
                <div style={{ fontSize: '15px', color: 'hsl(var(--foreground))', fontWeight: '600', marginBottom: '6px' }}>
                  {title}
                </div>
                <p style={{ fontSize: '13.5px', lineHeight: 1.65, color: 'hsl(var(--muted-foreground))' }}>
                  {desc}
                </p>
              </div>
            </div>
          ))}
        </Reveal>
      </div>
    </section>
  );
}

/* ── Pricing ────────────────────────────────────────────── */
function Pricing() {
  return (
    <section id="pricing" className="px-6 md:px-10 py-28 max-w-5xl mx-auto">
      <Reveal className="text-center mb-14">
        <div className="nave-section-label mb-4">Business Model</div>
        <h2
          className="text-display"
          style={{ fontSize: 'clamp(26px, 3.5vw, 40px)', letterSpacing: '-0.02em', fontWeight: '400' }}
        >
          Aligned with treasury growth
        </h2>
        <p style={{ color: 'hsl(var(--muted-foreground))', maxWidth: '440px', margin: '12px auto 0', fontSize: '15px', lineHeight: 1.7 }}>
          Simple, transparent pricing designed for long-term treasury retention and TVL growth.
        </p>
      </Reveal>

      <Reveal stagger className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {[
          {
            title: 'DAO Formation',
            titleIcon: 'wand-magic-sparkles',
            price: `$${NAVE_DAO_CREATION_STAKE_USD} NAVE staked`,
            altPrice: null,
            altLabel: null,
            period: 'recoverable — not a fee',
            items: ['Recoverable NAVE stake, not a protocol fee', 'Treasury vault initialization', 'Constitution engine setup', 'Four soulbound agent deployment', 'Governance structure configuration'],
          },
          {
            title: 'Treasury Management',
            titleIcon: 'landmark',
            price: '0.65%',
            altPrice: null,
            altLabel: null,
            period: 'annualized',
            items: ['Continuous agent coordination', 'Constitutional policy enforcement', 'Multisig execution layer', 'Treasury monitoring and accounting'],
          },
          {
            title: 'Yield Performance',
            titleIcon: 'signal',
            price: '8.5%',
            altPrice: null,
            altLabel: null,
            period: 'on generated yield',
            items: ['SOL staking via Jito & Kamino', 'EVM lending via Aave & Compound', 'Stablecoin yield optimization', 'Auto-compounding across chains'],
          },
        ].map(({ title, titleIcon, price, altPrice, altLabel, period, items }) => (
          <div key={title} className="nave-card nave-card-hover p-6 flex flex-col">
            <div className="nave-label mb-3 flex items-center gap-1.5" style={{ fontSize: '10px' }}>
              <Fi icon={titleIcon} style={{ fontSize: '11px' }} />
              {title}
            </div>
            <span className="text-display" style={{ fontSize: '32px', color: 'hsl(var(--foreground))' }}>
              {price}
            </span>
            {altPrice && (
              <div className="flex items-center gap-1.5 mt-1 mb-0.5">
                <span style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))', fontFamily: 'var(--font-display)' }}>
                  {altPrice}
                </span>
                <span style={{ fontSize: '10.5px', color: 'hsl(var(--muted-foreground))', fontFamily: 'var(--font-mono)' }}>
                  {altLabel}
                </span>
              </div>
            )}
            <div
              style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))', fontFamily: 'var(--font-mono)', marginBottom: '20px', marginTop: altPrice ? '4px' : '0' }}
            >
              {period}
            </div>
            <div className="space-y-2 flex-1">
              {items.map(item => (
                <div key={item} className="flex items-start gap-2">
                  <Fi
                    icon="angle-right"
                    style={{ fontSize: '11px', color: 'hsl(var(--muted-foreground))', flexShrink: 0, marginTop: '2px' }}
                  />
                  <span style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.5 }}>
                    {item}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </Reveal>
    </section>
  );
}

/* ── Footer ─────────────────────────────────────────────── */
function FooterSocialIcon({
  href,
  label,
  children,
}: {
  href: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
      className="inline-flex items-center justify-center transition-opacity hover:opacity-70"
      style={{ color: '#000' }}
    >
      {children}
    </a>
  );
}

function Footer() {
  return (
    <footer className="px-6 md:px-10 py-12 border-t" style={{ borderColor: 'hsl(var(--border))' }}>
      <div className="max-w-6xl mx-auto flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
        <div>
          <span className="text-display" style={{ fontSize: '20px', color: 'hsl(var(--foreground))' }}>
            Nave
          </span>
          <p style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))', marginTop: '6px', maxWidth: '340px', lineHeight: 1.6 }}>
            Autonomous institutional infrastructure for internet-native capital. Create a treasury on Base or Robinhood. Bridge and Stake still cover Solana and Ethereum.
          </p>
          <div className="flex items-center gap-4 mt-5">
            <FooterSocialIcon href="https://x.com/navedotfinance" label="Nave on X">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z" />
              </svg>
            </FooterSocialIcon>
            <FooterSocialIcon href="https://t.me/navefinance" label="Nave on Telegram">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.815 1.23-.692.064-1.218-.457-1.887-.898-1.048-.688-1.64-1.117-2.657-1.79-1.204-.79-.423-1.224.263-1.934.18-.187 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212-.07-.062-.174-.041-.249-.024-.106.024-1.793 1.14-5.061 3.345-.479.328-.913.487-1.302.478-.428-.009-1.252-.242-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.015 3.332-1.386 4.025-1.627 4.474-1.635z" />
              </svg>
            </FooterSocialIcon>
          </div>
        </div>
        <a
          href="https://orynth.dev/projects/nave-finance"
          target="_blank"
          rel="noopener"
          className="inline-block"
        >
          <img
            src="https://orynth.dev/api/badge/nave-finance?theme=light&style=default"
            alt="Featured on Orynth"
            width={260}
            height={80}
            className="max-w-full h-auto"
          />
        </a>
      </div>
    </footer>
  );
}

/* ── Page ───────────────────────────────────────────────── */
export default function Index() {
  return (
    <div style={{ backgroundColor: 'hsl(var(--background))' }} className="min-h-screen">
      <NavBar />
      <Hero />
      <Features />
      <AgentArchitecture />
      <DAOTypes />
      <ConstitutionShowcase />
      <Tokenomics />
      <Pricing />
      <Footer />
    </div>
  );
}