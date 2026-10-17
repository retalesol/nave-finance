import { useState, useEffect, useRef, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { useAccount } from 'wagmi';
import { useConnectModal } from '@rainbow-me/rainbowkit';
import { useScrollReveal } from '../hooks/useScrollReveal';
import Fi from '../components/Fi';
import DevnetBanner from '../components/DevnetBanner';
import WalletNetworkMenu from '../components/WalletNetworkMenu';
import DitherGlyph from '../components/homepage/DitherGlyph';
import NaveMark from '../components/NaveMark';
import HomeRoute from '../components/homepage/ChartedRoute';
import Dither from '../components/Dither';
import { usePrefersReducedMotion } from '../components/homepage/useHomeMotion';
import { MOCK_DAO_ADDRESS, DEMO_TREASURY_NAV_ENABLED } from '../lib/mockData';
import { useChain } from '../hooks/useChain';
import { APP_WALLET_CHAINS } from '../lib/chain/types';
import { EVM_DEPLOYMENT_MODE } from '../lib/programConfig';
import { usePlatformTreasuryStats, formatHeroProtocolUsd } from '../hooks/usePlatformTreasuryStats';
import { useNaveTokenStats, formatNavePrice, formatNaveMarketCap, formatNaveHolders } from '../hooks/useNaveTokenStats';

const INK: [number, number, number] = [0x0b / 255, 0x12 / 255, 0x20 / 255];
const PAPER: [number, number, number] = [0xfa / 255, 0xf8 / 255, 0xf3 / 255];
const DEEP_DOT_SOFT: [number, number, number] = [0x4a / 255, 0x5a / 255, 0x7e / 255];

function useNavOnDeep() {
  const [deep, setDeep] = useState(false);
  useEffect(() => {
    const ids = ['protocol', 'governance', 'pricing'];
    let frame = 0;
    const measure = () => {
      frame = 0;
      let next = false;
      for (const id of ids) {
        const el = document.getElementById(id);
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        if (rect.top < 56 && rect.bottom > 0) {
          next = true;
          break;
        }
      }
      setDeep((prev) => (prev === next ? prev : next));
    };
    const onScroll = () => {
      if (!frame) frame = window.requestAnimationFrame(measure);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);
  return deep;
}

function Reveal({
  children,
  className = '',
  variant = 'up',
  stagger = false,
}: {
  children: ReactNode;
  className?: string;
  variant?: 'up' | 'scale' | 'left' | 'right';
  stagger?: boolean;
}) {
  const { ref, visible } = useScrollReveal<HTMLDivElement>();
  const variantClass =
    variant === 'scale' ? 'sr-visible-scale'
    : variant === 'left' ? 'sr-visible-left'
    : variant === 'right' ? 'sr-visible-right'
    : 'sr-visible';

  return (
    <div ref={ref} className={`${stagger ? 'sr-stagger' : ''} ${visible ? variantClass : 'sr-hidden'} ${className}`}>
      {children}
    </div>
  );
}

const NAV_ITEMS = [
  { label: 'Product', href: '#product' },
  { label: 'Protocol', href: '#protocol' },
  { label: 'Governance', href: '#governance' },
  { label: 'Tokenomics', href: '#tokenomics' },
  { label: 'Pricing', href: '#pricing' },
  { label: 'Bridge & Stake', href: '/bridge' },
  { label: 'Documentation', href: '/docs' },
];

function NavBar() {
  const deep = useNavOnDeep();
  const { chainFamily, setChainFamily } = useChain();
  useEffect(() => {
    if (!APP_WALLET_CHAINS.includes(chainFamily)) {
      setChainFamily('base');
    }
  }, [chainFamily, setChainFamily]);

  return (
    <>
      <header className={`home-nav${deep ? ' is-deep' : ''}`}>
        <span className="text-display home-brand">
          <NaveMark />
          Nave
        </span>
        <nav className="home-nav-links">
          {NAV_ITEMS.map((item) => (
            <a key={item.label} href={item.href} className="home-nav-link">
              {item.label}
            </a>
          ))}
        </nav>
        <div className="home-nav-actions">
          <div className="home-wallet">
            <WalletNetworkMenu chains={APP_WALLET_CHAINS} />
          </div>
        </div>
      </header>
      <div className="home-banner-slot">
        <DevnetBanner />
      </div>
    </>
  );
}

function Compass() {
  return (
    <svg className="home-compass" viewBox="0 -8 64 72" fill="none" stroke="currentColor" strokeWidth="1" aria-hidden>
      <circle cx="32" cy="32" r="22" strokeDasharray="1.5 3" />
      <circle cx="32" cy="32" r="3" />
      <path d="M32 6 L36 30 L32 32 L28 30 Z" fill="currentColor" />
      <path d="M32 58 L36 34 L32 32 L28 34 Z" />
      <path d="M6 32 L30 28 L32 32 L30 36 Z" />
      <path d="M58 32 L34 28 L32 32 L34 36 Z" />
      <text x="32" y="4" textAnchor="middle" fontFamily="JetBrains Mono, monospace" fontSize="7" fill="currentColor" stroke="none">N</text>
    </svg>
  );
}

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

  const treasuriesDisplay = statsError ? '—' : statsLoading ? '…' : (stats?.treasuryCount ?? 0).toLocaleString();
  const tvlDisplay = statsError ? '—' : statsLoading ? '…' : formatHeroProtocolUsd(stats?.tvlUsd ?? 0);
  const yieldDisplay = statsError ? '—' : statsLoading ? '…' : formatHeroProtocolUsd(stats?.yieldGeneratedUsd ?? 0);
  const heroStats = [
    { value: treasuriesDisplay, label: 'Treasuries' },
    { value: tvlDisplay, label: 'TVL' },
    { value: yieldDisplay, label: 'Yield Generated' },
  ];

  return (
    <section className="home-hero">
      <div className="home-hero-copy">
        <h1 className="text-display home-hero-title hero-h1">
          From treasury to treasure,
          <br />
          <span className="home-ital">on a charted course.</span>
        </h1>
        <p className="home-hero-sub hero-sub">
          Nave enables internet-native organizations to govern, grow, and deploy capital
          through soulbound policy-driven AI agents
          {EVM_DEPLOYMENT_MODE === 'testnet'
            ? ' — launch a testnet treasury on Solana, Ethereum, Base, Robinhood, or Arc.'
            : ' — create a treasury on Base or Robinhood.'}
        </p>
        <div className="home-hero-ctas hero-cta">
          <button type="button" className="home-brass-btn" onClick={launchTreasury}>
            <Fi icon="castle" style={{ fontSize: '13px' }} />
            Launch a Treasury
          </button>
          <button
            type="button"
            className="home-btn-secondary"
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
          >
            <Fi icon="arrow-right-to-bracket" style={{ fontSize: '13px' }} />
            {connected && !DEMO_TREASURY_NAV_ENABLED ? 'Open App' : 'View Dashboard'}
          </button>
        </div>
        <div className="home-stats">
          {heroStats.map((stat) => (
            <div key={stat.label} className="hero-stat">
              <div className={`text-display home-stat-value${stat.label === 'Yield Generated' ? ' home-brass' : ''}`}>
                {stat.value}
              </div>
              <div className="home-stat-label">{stat.label}</div>
            </div>
          ))}
        </div>
        <aside className="home-backing" aria-label="Supporters">
          <div className="home-backing-pair">
            <div className="home-backing-row">
              <span className="home-backing-role">Incubated by</span>
              <a className="home-backing-name" href="https://trynoah.ai" target="_blank" rel="noopener noreferrer">
                <img src="/partners/noah.svg" alt="" />
                TryNoah.AI
              </a>
            </div>
            <div className="home-backing-row">
              <span className="home-backing-role">Accelerated by</span>
              <a className="home-backing-name" href="https://www.denariilabs.xyz" target="_blank" rel="noopener noreferrer">
                <img src="/partners/denarii-mark.svg" alt="" />
                Denarii Labs
                <span className="home-backing-note">Cohort 004</span>
              </a>
            </div>
          </div>
          <div className="home-backing-row home-backing-backed">
            <span className="home-backing-role">Backed by</span>
            <div className="home-backing-names">
              <a className="home-backing-name" href="https://fin.com" target="_blank" rel="noopener noreferrer">
                <img src="/partners/fin.svg" alt="" />
                Fin.com
              </a>
              <a className="home-backing-name" href="https://genlayer.com" target="_blank" rel="noopener noreferrer">
                <img src="/partners/genlayer-mark.svg" alt="" />
                GenLayer
              </a>
            </div>
          </div>
        </aside>
      </div>
      <div className="home-hero-map" aria-hidden>
        <div className="home-map-canvas">
          <Dither
            eager
            variant="isolines"
            paletteA={INK}
            paletteB={PAPER}
            gain={0.62}
            bias={-0.34}
            isoLevels={6}
            isoLineWidth={0.05}
            isoLineValue={-0.8}
            colorNum={5}
            pixelSize={2}
            waveSpeed={0.03}
            waveFrequency={2.4}
            waveAmplitude={0.3}
            showMark
            lightAngle={Math.PI * 0.75}
            lightStrength={prefersReducedMotion ? 0 : 0.12}
            tiltWithPointer={!prefersReducedMotion}
            disableAnimation={prefersReducedMotion}
            enableMouseInteraction={false}
            mouseRadius={0}
          />
        </div>
        <Compass />
      </div>
    </section>
  );
}

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
    desc: 'Four soulbound AI agents — Executive, Financial, Operational, and Oversight — coordinate treasury operations under constitutional governance mandates.',
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
    desc: EVM_DEPLOYMENT_MODE === 'testnet'
      ? 'Yield follows the treasury chain. Ethereum testnet supplies Compound, Base Sepolia supplies Aave, and Solana Devnet supplies Jito. Robinhood and Arc treasuries can govern and move funds without a lending venue.'
      : 'Yield follows the treasury chain. Base and Robinhood use configured lending adapters such as Aave and Compound. Solana staking stays on Bridge and Stake.',
    tag: 'Yield',
  },
  {
    icon: 'layer-group',
    title: 'Multisig Execution',
    desc: '3-key autonomous agent multisig coordination. Executive signs first, Financial second, Operational validates and signs final approval.',
    tag: 'Security',
  },
];

function Features() {
  return (
    <section id="product" className="home-section home-features">
      <div className="home-wrap">
        <Reveal className="home-sec-head center">
          <div className="nave-section-label">Phase 1 Product</div>
          <h2 className="text-display">Autonomous treasury coordination</h2>
          <p className="home-muted">
            From constitutional policy enforcement to multi-agent execution —
            institutional-grade treasury infrastructure in one protocol.
          </p>
        </Reveal>
        <Reveal stagger className="home-grid-3">
          {FEATURES.map(({ icon, title, desc, tag }) => (
            <div key={title} className="nave-card nave-card-hover home-feature">
              <div className="home-feature-top">
                <DitherGlyph name={icon} />
                <span className="home-tag">{tag}</span>
              </div>
              <div>
                <h3>{title}</h3>
                <p>{desc}</p>
              </div>
            </div>
          ))}
        </Reveal>
      </div>
    </section>
  );
}

const DAO_TYPES = [
  { icon: 'code', title: 'Protocol Treasuries', desc: 'Institutional-grade reserve management for protocol capital.' },
  { icon: 'users', title: 'Creator Economies', desc: 'Revenue-sharing treasuries for creator communities.' },
  { icon: 'gamepad', title: 'Gaming Guilds', desc: 'In-game asset treasuries and coordinated yield strategies.' },
  { icon: 'landmark', title: 'Investment Collectives', desc: 'On-chain capital vehicles with constitutional governance.' },
  { icon: 'globe', title: 'Internet-Native Communities', desc: 'Autonomous treasury coordination for any internet organization.' },
];

function DAOTypes() {
  return (
    <section className="home-section">
      <div className="home-wrap home-dao">
        <Reveal variant="left" className="home-dao-copy">
          <div className="nave-section-label">Supported Treasuries</div>
          <h2 className="text-display">
            Any organization.
            <br />
            <span className="home-ital">Any treasury.</span>
          </h2>
          <p className="home-muted">
            Purpose-built to support every model of internet-native organization
            managing collective capital.
          </p>
        </Reveal>
        <Reveal stagger className="home-dao-list">
          {DAO_TYPES.map(({ icon, title, desc }) => (
            <div key={title} className="home-dao-row">
              <DitherGlyph name={icon} />
              <div>
                <h3>{title}</h3>
                <p>{desc}</p>
              </div>
            </div>
          ))}
        </Reveal>
      </div>
    </section>
  );
}

const CONSTITUTION_BULLETS = [
  'Approved protocols and asset whitelist',
  'Treasury reserve ratios and deployment limits',
  'Risk tolerances and liquidity requirements',
  'Rebalancing frequency and allocation mandates',
  'Emergency governance controls',
];

const CONSTITUTION_ROWS = [
  { label: 'Minimum Stablecoin Reserve', value: '35%' },
  { label: 'Maximum Deployment', value: '65%' },
  { label: 'Liquidity Requirement', value: '15%' },
  { label: 'Rebalancing Frequency', value: 'Weekly' },
];

function ConstitutionShowcase() {
  const prefersReducedMotion = usePrefersReducedMotion();
  return (
    <section id="governance" className="home-section home-deep home-constitution">
      <div className="home-const-sea" aria-hidden>
        <Dither
          variant="isolines"
          paletteA={INK}
          paletteB={DEEP_DOT_SOFT}
          gain={0.9}
          bias={0.1}
          isoLevels={6}
          isoLineWidth={0.08}
          isoLineValue={1}
          colorNum={4}
          pixelSize={2}
          waveSpeed={0.02}
          waveFrequency={2.6}
          waveAmplitude={0.42}
          disableAnimation={prefersReducedMotion}
          enableMouseInteraction={false}
          mouseRadius={0}
        />
      </div>
      <div className="home-const-wash" aria-hidden />
      <div className="home-wrap home-const-grid">
        <Reveal variant="left" className="home-const-copy">
          <div className="nave-section-label">Treasury Constitution</div>
          <h2 className="text-display">
            Programmable treasury policy,
            <br />
            <span className="home-ital">not governance scripting.</span>
          </h2>
          <p className="home-muted">
            DAO members configure treasury rules through an institutional visual interface. The
            four autonomous agents are then constitutionally bound to operate exclusively
            within those parameters.
          </p>
          <ul className="home-bullets">
            {CONSTITUTION_BULLETS.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </Reveal>
        <Reveal variant="right" className="home-chart-wrap">
          <div className="home-lamp" aria-hidden />
          <div className="home-chart-card">
            <h3>Treasury Constitution</h3>
            {CONSTITUTION_ROWS.map(({ label, value }) => (
              <div key={label} className="home-const-row">
                <span>{label}</span>
                <span>{value}</span>
              </div>
            ))}
            <div className="home-approved">
              <div className="nave-label">Approved Protocols</div>
              <div className="chips">
                {['Jito', 'Kamino', 'MarginFi'].map((protocol) => (
                  <span key={protocol} className="home-chip">{protocol}</span>
                ))}
              </div>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

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
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ width: '100%', height: '100%', display: 'block' }} aria-hidden>
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

const TOKEN_UTILITIES = [
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

  const liveStats = [
    { label: 'Price', value: formatNavePrice(stats?.priceUsd ?? null) },
    { label: 'Market Cap', value: formatNaveMarketCap(stats?.marketCapUsd ?? null) },
    { label: 'Holders', value: formatNaveHolders(stats?.holders ?? null) },
  ];

  return (
    <section id="tokenomics" className="home-section">
      <div className="home-wrap">
        <div className="home-tok">
          <Reveal variant="left" className="home-tok-copy">
            <div className="nave-section-label">Tokenomics</div>
            <h2 className="text-display">
              Nave Shares are the
              <br />
              <span className="home-ital">protocol token.</span>
            </h2>
            <p className="home-muted">
              <strong>Nave Shares</strong> (ticker <strong>$NAVE</strong>) are the
              protocol token of Nave, capped at a fixed maximum supply. Holders vote
              where a treasury enables token governance. Forming a treasury does not
              require NAVE.
            </p>
            <ul className="home-check-list">
              {[
                'Fixed maximum supply of 500,000 $NAVE',
                'Governance over DAO votes and treasury decisions',
                'Fully fair launched — no team allocation or supply',
              ].map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </Reveal>
          <Reveal variant="right">
            <div className="nave-card home-supply">
              <div className="home-supply-sea" aria-hidden>
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
              </div>
              {stats && stats.chain.length > 1 && (
                <div className="home-supply-chart" aria-hidden>
                  <TokenPriceChart data={stats.chain} />
                </div>
              )}
              <div className="home-supply-wash" aria-hidden />
              <div className="home-supply-body">
                <div className="nave-label">Max Supply</div>
                <div className="text-display home-supply-figure">500,000</div>
                <span className="home-chip" style={{ marginTop: 14, fontSize: 13 }}>$NAVE</span>
                <div className="home-supply-caption">
                  Nave Shares — the protocol token, fixed and fully fair launched.
                </div>
                <div className="home-supply-stats">
                  {liveStats.map((stat) => (
                    <div key={stat.label} className={stat.label === 'Price' ? 'home-price' : undefined}>
                      <div className="nave-label" style={{ fontSize: 9, marginBottom: 4 }}>{stat.label}</div>
                      <div className={stat.label === 'Price' ? 'home-price-value' : 'home-stat-figure'}>{stat.value}</div>
                    </div>
                  ))}
                </div>
                <button type="button" className="home-contract" onClick={copyAddress} title={contractAddress}>
                  {addressCopied ? 'Copied!' : `Solana: ${shortAddress}`}
                  <Fi icon={addressCopied ? 'check' : 'copy'} style={{ fontSize: '10px' }} />
                </button>
                <div className="home-markets">
                  <a href={dexscreenerUrl} target="_blank" rel="noopener noreferrer" title="View on DexScreener">
                    <DexScreenerIcon size={15} />
                  </a>
                  <a href={geckoterminalUrl} target="_blank" rel="noopener noreferrer" title="View on GeckoTerminal">
                    <GeckoTerminalIcon size={15} />
                  </a>
                </div>
              </div>
            </div>
          </Reveal>
        </div>
        <Reveal stagger className="home-util-grid">
          {TOKEN_UTILITIES.map(({ icon, title, desc }) => (
            <div key={title} className="nave-card nave-card-hover home-util">
              <DitherGlyph name={icon} />
              <div>
                <h3>{title}</h3>
                <p>{desc}</p>
              </div>
            </div>
          ))}
        </Reveal>
      </div>
    </section>
  );
}

const PRICING = [
  {
    title: 'Treasury Formation',
    icon: 'wand-magic-sparkles',
    price: 'Gas',
    period: 'to form a treasury',
    brass: false,
    items: ['Network gas and account rent', 'No protocol fee and no NAVE stake', 'Treasury vault initialization', 'Constitution engine setup', 'Four soulbound agents and governance'],
  },
  {
    title: 'Yield',
    icon: 'signal',
    price: '15%',
    period: 'of realized yield',
    brass: true,
    items: ['Charged when a strategy position is withdrawn', 'Principal is not charged', 'The same 15% if the treasury is frozen', 'SOL staking via Jito and Kamino', 'EVM lending via Aave and Compound'],
  },
];

function Pricing() {
  return (
    <section id="pricing" className="home-section home-deep">
      <div className="home-wrap">
        <Reveal className="home-sec-head">
          <div className="nave-section-label">Business Model</div>
          <h2 className="text-display">Aligned with treasury growth</h2>
          <p className="home-muted">
            Simple, transparent pricing designed for long-term treasury retention and TVL growth.
          </p>
        </Reveal>
        <Reveal stagger className="home-price-grid">
          {PRICING.map(({ title, icon, price, period, brass, items }) => (
            <div key={title} className={`nave-card nave-card-hover home-price-card${brass ? ' is-brass' : ''}`}>
              <div className="top">
                <h3>{title}</h3>
                <DitherGlyph name={icon} small />
              </div>
              <div>
                <div className="text-display home-price-amount">{price}</div>
                <div className="period">{period}</div>
              </div>
              <ul>
                {items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          ))}
        </Reveal>
      </div>
    </section>
  );
}

function FooterSocialIcon({ href, label, children }: { href: string; label: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" aria-label={label}>
      {children}
    </a>
  );
}

function Footer() {
  return (
    <footer className="home-footer">
      <div className="home-wrap home-footer-grid">
        <div>
          <span className="text-display brand">Nave</span>
          <p>
            Autonomous institutional infrastructure for internet-native capital.
            {EVM_DEPLOYMENT_MODE === 'testnet'
              ? ' Testnet treasuries run on Solana Devnet, Ethereum Sepolia, Base Sepolia, Robinhood Testnet, and Arc Testnet.'
              : ' Create a treasury on Base or Robinhood. Bridge and Stake still cover Solana and Ethereum.'}
          </p>
          <div className="home-socials">
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
        <div className="home-footer-badge">
          <a href="https://orynth.dev/projects/nave-finance" target="_blank" rel="noopener" className="inline-block">
            <img
              src="https://orynth.dev/api/badge/nave-finance?theme=light&style=default"
              alt="Featured on Orynth"
              width={260}
              height={80}
              className="max-w-full h-auto"
            />
          </a>
        </div>
      </div>
    </footer>
  );
}

export default function Index() {
  return (
    <div className="home min-h-screen">
      <NavBar />
      <Hero />
      <Features />
      <HomeRoute />
      <DAOTypes />
      <ConstitutionShowcase />
      <Tokenomics />
      <Pricing />
      <Footer />
    </div>
  );
}
