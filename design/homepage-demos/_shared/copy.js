/*!
 * NAVE_COPY — real homepage copy, extracted from app/src/pages/Index.tsx
 * (mainnet variant of every conditional string).
 * Icons are the Font Awesome names used by <Fi icon="..."/> so demos can map them
 * to their own glyphs. Live numbers (hero stats, token stats) are static fallbacks.
 */
(function (root) {
  'use strict';

  var CONTRACT = 'EGg56E1YtL5YapzkF7vkRThHR8i5FeRvm2LLuySdYory';

  root.NAVE_COPY = {
    brand: 'Nave',

    nav: [
      { label: 'Product', href: '#product' },
      { label: 'Protocol', href: '#protocol' },
      { label: 'Governance', href: '#governance' },
      { label: 'Tokenomics', href: '#tokenomics' },
      { label: 'Pricing', href: '#pricing' },
      { label: 'Bridge & Stake', href: '/bridge' },
      { label: 'Documentation', href: '/docs' }
    ],

    hero: {
      h1: 'The autonomous treasury',
      h1Italic: 'operating system',
      sub: 'Nave enables internet-native organizations to govern, grow, and deploy capital through soulbound policy-driven AI agents — create a treasury on Base or Robinhood.',
      ctaPrimary: { label: 'Launch a Treasury', icon: 'castle' },
      ctaSecondary: { label: 'View Dashboard', icon: 'arrow-right-to-bracket' },
      // Live protocol aggregates (Supabase RPC get_platform_treasury_stats) on the real
      // site. The VALUES below are illustrative placeholders; only the labels are real copy.
      stats: [
        { value: '12', label: 'Treasuries' },
        { value: '$1.2M', label: 'TVL' },
        { value: '$48K', label: 'Yield Generated' }
      ]
    },

    features: {
      id: 'product',
      sectionLabel: 'Phase 1 Product',
      h2: 'Autonomous treasury coordination',
      sub: 'From constitutional policy enforcement to multi-agent execution — institutional-grade treasury infrastructure in one protocol.',
      items: [
        { icon: 'book', title: 'Treasury Constitution', tag: 'Core',
          desc: 'Define approved protocols, reserve ratios, deployment limits, risk tolerances, and treasury mandates through an institutional-grade visual policy engine.' },
        { icon: 'share-nodes', title: 'Multi-Agent Coordination', tag: 'Agents',
          desc: 'Four soulbound AI agents — Executive, Financial, Operational, and Oversight — coordinate treasury operations under constitutional governance mandates.' },
        { icon: 'desktop', title: 'Treasury Dashboard', tag: 'Analytics',
          desc: 'Real-time overview of treasury health, allocation breakdown, yield analytics, accounting, and autonomous agent monitoring.' },
        { icon: 'shield', title: 'Governance System', tag: 'DAO',
          desc: 'On-chain proposals, quorum thresholds, voting, and execution pipeline. Governance occurs before autonomous execution.' },
        { icon: 'database', title: 'Yield Routing', tag: 'Yield',
          desc: 'Yield follows the treasury chain. Base and Robinhood use configured lending adapters such as Aave and Compound. Solana staking stays on Bridge and Stake.' },
        { icon: 'layer-group', title: 'Multisig Execution', tag: 'Security',
          desc: '3-key autonomous agent multisig coordination. Executive signs first, Financial second, Operational validates and signs final approval.' }
      ]
    },

    agents: {
      id: 'protocol',
      sectionLabel: 'Protocol Architecture',
      h2: 'Multi-Agent Constitutional',
      h2Italic: 'Treasury Governance',
      sub: 'Every Nave DAO operates through four permanent soulbound AI agents — identity-bound fiduciary operators acting under constitutional mandates.',
      items: [
        { icon: 'crown', role: 'Executive Agent', tag: 'Strategic Coordinator',
          desc: 'Interprets governance proposals, coordinates treasury intent, validates constitutional alignment, and signs first multisig approval.' },
        { icon: 'money-bill-wave', role: 'Financial Agent', tag: 'Operations Layer',
          desc: 'Handles treasury execution, yield optimization, capital deployment, transaction preparation, and signs second multisig approval.' },
        { icon: 'eye', role: 'Operational Agent', tag: 'Safeguard Layer',
          desc: 'Enforces constitutional compliance, reviews all agent decisions, validates execution safety, and signs final multisig approval.' },
        { icon: 'gear', role: 'Oversight Agent', tag: 'Monitoring Layer',
          desc: 'Continuous treasury monitoring, accounting, analytics, optimization recommendations, suspicious activity detection, and emergency halt capabilities.' }
      ],
      executionFlow: {
        label: 'Execution Flow',
        steps: [
          { step: '01', label: 'Governance Vote', desc: 'DAO token holders approve proposal' },
          { step: '02', label: 'Executive Review', desc: 'Constitutional alignment validated, first signature' },
          { step: '03', label: 'Financial Execution', desc: 'Transaction prepared, profitability verified, second signature' },
          { step: '04', label: 'Operational Approval', desc: 'Compliance validated, final signature, treasury executes' }
        ]
      }
    },

    daoTypes: {
      sectionLabel: 'Supported Treasuries',
      h2: 'Any organization.',
      h2Italic: 'Any treasury.',
      sub: 'Purpose-built to support every model of internet-native organization managing collective capital.',
      items: [
        { icon: 'code', title: 'Protocol Treasuries', desc: 'Institutional-grade reserve management for protocol capital.' },
        { icon: 'users', title: 'Creator Economies', desc: 'Revenue-sharing treasuries for creator communities.' },
        { icon: 'gamepad', title: 'Gaming Guilds', desc: 'In-game asset treasuries and coordinated yield strategies.' },
        { icon: 'landmark', title: 'Investment Collectives', desc: 'On-chain capital vehicles with constitutional governance.' },
        { icon: 'globe', title: 'Internet-Native Communities', desc: 'Autonomous treasury coordination for any internet organization.' }
      ]
    },

    constitution: {
      id: 'governance',
      sectionLabel: 'Treasury Constitution',
      h2: 'Programmable treasury policy,',
      h2Italic: 'not governance scripting.',
      sub: 'DAO members configure treasury rules through an institutional visual interface. The four autonomous agents are then constitutionally bound to operate exclusively within those parameters.',
      bullets: [
        'Approved protocols and asset whitelist',
        'Treasury reserve ratios and deployment limits',
        'Risk tolerances and liquidity requirements',
        'Rebalancing frequency and allocation mandates',
        'Emergency governance controls'
      ],
      card: {
        title: 'Treasury Constitution',
        rows: [
          { label: 'Minimum Stablecoin Reserve', value: '35%' },
          { label: 'Maximum Deployment', value: '65%' },
          { label: 'Liquidity Requirement', value: '15%' },
          { label: 'Rebalancing Frequency', value: 'Weekly' }
        ],
        approvedLabel: 'Approved Protocols',
        approvedProtocols: ['Jito', 'Kamino', 'MarginFi']
      }
    },

    tokenomics: {
      id: 'tokenomics',
      sectionLabel: 'Tokenomics',
      sectionIcon: 'coins',
      h2: 'Nave Shares are the',
      h2Italic: 'protocol token.',
      // Rich paragraph: "Nave Shares" and "$NAVE" are emphasised in the source.
      sub: 'Nave Shares (ticker $NAVE) are the protocol token of Nave, capped at a fixed maximum supply. Holders vote where a treasury enables token governance. Forming a treasury does not require NAVE.',
      subParts: { lead: 'Nave Shares', tickerPrefix: ' (ticker ', ticker: '$NAVE',
        rest: ') are the protocol token of Nave, capped at a fixed maximum supply. Holders vote where a treasury enables token governance. Forming a treasury does not require NAVE.' },
      bullets: [
        'Fixed maximum supply of 500,000 $NAVE',
        'Governance over DAO votes and treasury decisions',
        'Fully fair launched — no team allocation or supply'
      ],
      supplyCard: {
        label: 'Max Supply',
        supply: '500,000',
        ticker: '$NAVE',
        caption: 'Nave Shares — the protocol token, fixed and fully fair launched.',
        stats: [
          { label: 'Price', value: '$0.39' },
          { label: 'Market Cap', value: '$151K' },
          { label: 'Holders', value: '267' }
        ],
        contractAddress: CONTRACT,
        contractShort: 'EGg5…Yory',
        contractButton: 'Solana: EGg5…Yory',
        contractCopied: 'Copied!',
        links: {
          dexscreener: 'https://dexscreener.com/solana/' + CONTRACT,
          geckoterminal: 'https://www.geckoterminal.com/solana/tokens/' + CONTRACT
        }
      },
      utilities: [
        { icon: 'shield', title: 'Vote',
          desc: 'Participate in DAO votes and treasury decisions wherever token governance is enabled, aligning holders with protocol direction.' },
        { icon: 'ship', title: 'Fair Launch',
          desc: 'Fully fair launched with no team allocation and no team supply — distribution is open to the community from day one.' }
      ]
    },

    pricing: {
      id: 'pricing',
      sectionLabel: 'Business Model',
      h2: 'Aligned with treasury growth',
      sub: 'Simple, transparent pricing designed for long-term treasury retention and TVL growth.',
      cards: [
        { title: 'Treasury Formation', icon: 'wand-magic-sparkles', price: 'Gas', period: 'to form a treasury',
          items: ['Network gas and account rent', 'No protocol fee and no NAVE stake', 'Treasury vault initialization', 'Constitution engine setup', 'Four soulbound agents and governance'] },
        { title: 'Yield', icon: 'signal', price: '15%', period: 'of realized yield',
          items: ['Charged when a strategy position is withdrawn', 'Principal is not charged', 'The same 15% if the treasury is frozen', 'SOL staking via Jito and Kamino', 'EVM lending via Aave and Compound'] }
      ]
    },

    footer: {
      brand: 'Nave',
      text: 'Autonomous institutional infrastructure for internet-native capital. Create a treasury on Base or Robinhood. Bridge and Stake still cover Solana and Ethereum.',
      social: [
        { label: 'Nave on X', href: 'https://x.com/navedotfinance', icon: 'x',
          svgPath: 'M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z' },
        { label: 'Nave on Telegram', href: 'https://t.me/navefinance', icon: 'telegram',
          svgPath: 'M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.815 1.23-.692.064-1.218-.457-1.887-.898-1.048-.688-1.64-1.117-2.657-1.79-1.204-.79-.423-1.224.263-1.934.18-.187 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212-.07-.062-.174-.041-.249-.024-.106.024-1.793 1.14-5.061 3.345-.479.328-.913.487-1.302.478-.428-.009-1.252-.242-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.015 3.332-1.386 4.025-1.627 4.474-1.635z' }
      ],
      orynth: { href: 'https://orynth.dev/projects/nave-finance', badge: 'https://orynth.dev/api/badge/nave-finance?theme=light&style=default', alt: 'Featured on Orynth' }
    },

    // Dither props used on the live site, for parity checks.
    ditherPresets: {
      hero: { sceneMode: 'ocean', gain: 0.86, colorNum: 5, pixelSize: 2, waveAmplitude: 0.3, waveFrequency: 3, waveSpeed: 0.08, layerOpacity: 0.38 },
      tokenomics: { sceneMode: 'waves', gain: 0.82, colorNum: 5, pixelSize: 2, waveAmplitude: 0.28, waveFrequency: 3, waveSpeed: 0.06, layerOpacity: 0.4 }
    }
  };
})(typeof window !== 'undefined' ? window : this);
