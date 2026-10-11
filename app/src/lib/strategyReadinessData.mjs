// ─── Strategy readiness data — SINGLE SOURCE OF TRUTH ────────────────────────
// Plain ESM (no TypeScript, no `import.meta.env`, no JSX) so this exact file
// can be imported unmodified by BOTH the Vite browser app (via
// `src/lib/strategyReadiness.ts`, which wraps it with types and env-var
// resolution) AND a plain Node script (`scripts/mainnet-cutover.mjs`, which
// checks `process.env` against the `mainnetEnvVars` listed here). Keeping the
// declarative list in one runtime-agnostic file means "is this strategy ready
// to flip on for mainnet" is answered identically by the UI and by the
// mainnet-cutover preflight gate — there is no second list to fall out of
// sync.
//
// This file intentionally contains NO logic beyond simple derivations — it is
// data, not behavior. Consumers (`strategyReadiness.ts` for the browser,
// `mainnet-cutover.mjs` for Node) own how the data is interpreted for their
// runtime (Vite env vars vs `process.env`).

/**
 * Solana strategies. Each entry:
 *  - id: matches `constitution.approvedProtocols[].protocolId` and the
 *    adapter program-id lookup key.
 *  - requiresFlagEnvVar: if set, this strategy is only selectable in the UI
 *    when that env var is `'true'` (mirrors today's `VITE_NAVE_MARGINFI_ENABLED`
 *    gate). `null` means always selectable (Kamino/Jito).
 *  - mainnetEnvVars: env vars that must be configured for this strategy to be
 *    genuinely live on mainnet (used to build the "what's left to flip on"
 *    checklist and, for the cutover script, a fail-closed assertion when the
 *    strategy isn't explicitly deferred).
 *  - badge / badgeReason: optional UI signal for strategies that are live but
 *    newer/less battle-tested than the others.
 */
export const SOLANA_STRATEGIES = [
  {
    id: 'kamino',
    label: 'Kamino',
    requiresFlagEnvVar: null,
    mainnetEnvVars: ['VITE_NAVE_KAMINO_ADAPTER_ID'],
    badge: null,
    badgeReason: null,
  },
  {
    id: 'jito',
    label: 'Jito',
    requiresFlagEnvVar: null,
    mainnetEnvVars: ['VITE_NAVE_JITO_ADAPTER_ID'],
    badge: null,
    badgeReason: null,
  },
  {
    id: 'jupiter',
    label: 'Jupiter Lend',
    requiresFlagEnvVar: null,
    mainnetEnvVars: ['VITE_JUPITER_LENDING_PROGRAM_ID', 'VITE_JUPITER_LIQUIDITY_PROGRAM_ID'],
    badge: 'beta',
    badgeReason:
      'Newer direct-CPI integration (bypasses the execute_strategy adapter path used by Kamino/Jito) and is off by default — treat as less battle-tested.',
  },
  {
    id: 'marginfi',
    label: 'MarginFi',
    requiresFlagEnvVar: 'VITE_NAVE_MARGINFI_ENABLED',
    mainnetEnvVars: ['VITE_MARGINFI_PROGRAM_ID', 'VITE_NAVE_MARGINFI_ADAPTER_ID'],
    badge: null,
    badgeReason: null,
    // Deposit/withdraw work via the standalone operational-agent path
    // (mirrors Kamino/Jito); the governance-approved execute_strategy path
    // still only does escrow bookkeeping for ALL Solana adapters (existing,
    // audited architecture — not MarginFi-specific). Kept flag-gated pending
    // product decision on that path, not a functional blocker for direct use.
    hiddenUnlessFlag: true,
  },
];

/**
 * EVM strategy adapters, one entry per (protocol) with PER-CHAIN support
 * rules and env-var keys. `chains[chainId]`:
 *  - supported: true if this protocol is expected to work on that chain
 *    (either because Nave's adapter is deployable there, or a third-party
 *    dependency — e.g. a lending pool — exists). `false` means the UI must
 *    keep this option disabled regardless of any configured address.
 *  - configurableWithAdapter: when `supported` is false but this is true, a
 *    deployed-and-validated adapter address can still activate it (used for
 *    Balancer, which needs a concrete pool tuple validated first).
 *  - reason: user-facing (and cutover-log-facing) explanation.
 *  - envVar: the `VITE_EVM_<CHAIN>_<PROTOCOL>_ADAPTER_ADDRESS` var that holds
 *    the deployed Nave adapter contract address for that (chain, protocol).
 */
export const EVM_STRATEGIES = [
  {
    id: 'aave',
    label: 'Aave V3',
    badge: null,
    badgeReason: null,
    chains: {
      1: {
        supported: true,
        reason: 'Official Aave V3 Ethereum mainnet Pool exists in the Aave address book.',
        envVar: 'VITE_EVM_ETHEREUM_AAVE_ADAPTER_ADDRESS',
      },
      8453: {
        supported: true,
        reason: 'Official Aave V3 Base mainnet Pool exists in the Aave address book.',
        envVar: 'VITE_EVM_BASE_AAVE_ADAPTER_ADDRESS',
      },
      11155111: {
        supported: true,
        reason: 'Official Aave V3 Sepolia Pool exists in the Aave address book.',
        envVar: 'VITE_EVM_SEPOLIA_AAVE_ADAPTER_ADDRESS',
      },
      84532: {
        supported: true,
        reason: 'Official Aave V3 Base Sepolia Pool exists in the Aave address book. The deployed adapter must be bound to the current protocol; the older adapter is not a fallback.',
        envVar: 'VITE_EVM_BASE_SEPOLIA_AAVE_ADAPTER_ADDRESS',
      },
      46630: {
        supported: false,
        configurableWithAdapter: false,
        reason: 'Robinhood Testnet has no Aave V3 pool in the Nave address registry.',
        envVar: 'VITE_EVM_ROBINHOOD_TESTNET_AAVE_ADAPTER_ADDRESS',
      },
      5042002: {
        supported: false,
        configurableWithAdapter: false,
        reason: 'Arc Testnet yield is CCTP domain 26 to Sepolia Aave V3. Official Aave on Arc is V4, and Nave does not ship a V4 adapter.',
        envVar: 'VITE_EVM_ARC_TESTNET_AAVE_ADAPTER_ADDRESS',
      },
    },
  },
  {
    id: 'compound',
    label: 'Compound V3',
    badge: null,
    badgeReason: null,
    chains: {
      1: {
        supported: true,
        reason: 'Official Compound III Ethereum mainnet cUSDCv3 Comet exists in the Comet deployments registry.',
        envVar: 'VITE_EVM_ETHEREUM_COMPOUND_ADAPTER_ADDRESS',
      },
      8453: {
        supported: true,
        reason: 'Official Compound III Base mainnet cUSDCv3 Comet exists in the Comet deployments registry.',
        envVar: 'VITE_EVM_BASE_COMPOUND_ADAPTER_ADDRESS',
      },
      11155111: {
        supported: true,
        reason: 'Official Compound III Sepolia cUSDCv3 Comet exists in the Comet deployments registry.',
        envVar: 'VITE_EVM_SEPOLIA_COMPOUND_ADAPTER_ADDRESS',
      },
      84532: {
        supported: false,
        configurableWithAdapter: false,
        reason: 'Compound III has no official Base Sepolia deployment artifact in the Comet deployments registry.',
        envVar: 'VITE_EVM_BASE_SEPOLIA_COMPOUND_ADAPTER_ADDRESS',
      },
      46630: {
        supported: false,
        configurableWithAdapter: false,
        reason: 'Robinhood Testnet has no Compound III Comet in the Nave address registry.',
        envVar: 'VITE_EVM_ROBINHOOD_TESTNET_COMPOUND_ADAPTER_ADDRESS',
      },
      5042002: {
        supported: false,
        configurableWithAdapter: false,
        reason: 'Arc Testnet has no Compound III market. Yield is CCTP to Sepolia Aave V3.',
        envVar: 'VITE_EVM_ARC_TESTNET_COMPOUND_ADAPTER_ADDRESS',
      },
    },
  },
  {
    id: 'balancer',
    label: 'Balancer',
    badge: null,
    badgeReason: null,
    chains: {
      1: {
        supported: true,
        reason: 'Official Balancer v2 Vault exists on Ethereum mainnet.',
        envVar: 'VITE_EVM_ETHEREUM_BALANCER_ADAPTER_ADDRESS',
      },
      8453: {
        supported: true,
        reason: 'Official Balancer v2 Vault exists on Base mainnet.',
        envVar: 'VITE_EVM_BASE_BALANCER_ADAPTER_ADDRESS',
      },
      11155111: {
        supported: false,
        configurableWithAdapter: true,
        reason:
          'Balancer Sepolia v3 core contracts exist, but the current Nave BalancerAdapter targets Balancer v2 Vault plus a concrete poolId/BPT/routed-asset tuple. Configure a deployed compatible adapter only after validating the pool tuple.',
        envVar: 'VITE_EVM_SEPOLIA_BALANCER_ADAPTER_ADDRESS',
      },
      84532: {
        supported: false,
        configurableWithAdapter: true,
        reason:
          'No official Balancer Base Sepolia deployment registry entry was found. Configure a deployed compatible adapter only after validating a concrete pool tuple.',
        envVar: 'VITE_EVM_BASE_SEPOLIA_BALANCER_ADAPTER_ADDRESS',
      },
      46630: {
        supported: false,
        configurableWithAdapter: false,
        reason: 'Balancer stays at the zero address on Robinhood Testnet.',
        envVar: 'VITE_EVM_ROBINHOOD_TESTNET_BALANCER_ADAPTER_ADDRESS',
      },
      5042002: {
        supported: false,
        configurableWithAdapter: false,
        reason: 'Balancer stays at the zero address on Arc Testnet.',
        envVar: 'VITE_EVM_ARC_TESTNET_BALANCER_ADAPTER_ADDRESS',
      },
    },
  },
  {
    id: 'arbitrum-bridge',
    label: 'Arbitrum Bridge (RH → Ethereum)',
    badge: null,
    badgeReason: null,
    chains: {
      4663: {
        supported: true,
        reason: 'Robinhood Nitro L2 gateway bridges WETH/ETH to an Ethereum sister treasury for yield.',
        envVar: 'VITE_EVM_ROBINHOOD_ARBITRUM_BRIDGE_ADAPTER_ADDRESS',
      },
      46630: {
        supported: true,
        reason: 'Robinhood Testnet Arbitrum-style gateway for WETH bridge-out testing.',
        envVar: 'VITE_EVM_ROBINHOOD_TESTNET_ARBITRUM_BRIDGE_ADAPTER_ADDRESS',
      },
      5042002: {
        supported: false,
        configurableWithAdapter: false,
        reason: 'Arc Testnet is not an Arbitrum Nitro chain. USDC yield uses CCTP to Sepolia.',
        envVar: 'VITE_EVM_ARC_TESTNET_ARBITRUM_BRIDGE_ADAPTER_ADDRESS',
      },
    },
  },
  {
    id: 'cctp',
    label: 'CCTP USDC Bridge',
    badge: null,
    badgeReason: null,
    chains: {
      1: {
        supported: true,
        reason: 'Circle CCTP TokenMessenger on Ethereum for USDC hops to Base.',
        envVar: 'VITE_EVM_ETHEREUM_CCTP_BRIDGE_ADAPTER_ADDRESS',
      },
      8453: {
        supported: true,
        reason: 'Circle CCTP TokenMessenger on Base for USDC hops to Ethereum.',
        envVar: 'VITE_EVM_BASE_CCTP_BRIDGE_ADAPTER_ADDRESS',
      },
      4663: {
        supported: false,
        configurableWithAdapter: true,
        reason: 'Robinhood USDC/CCTP domain not configured in NaveAddressRegistry yet (ROBINHOOD_USDC=0).',
        envVar: 'VITE_EVM_ROBINHOOD_CCTP_BRIDGE_ADAPTER_ADDRESS',
      },
      46630: {
        supported: false,
        configurableWithAdapter: true,
        reason: 'Robinhood Testnet USDC is unpublished. CCTP stays off until a USDC address is confirmed. USDG is not a substitute.',
        envVar: 'VITE_EVM_ROBINHOOD_TESTNET_CCTP_BRIDGE_ADAPTER_ADDRESS',
      },
      5042002: {
        supported: true,
        reason: 'Arc Testnet CCTP domain 26 burns USDC to Sepolia (domain 0), then the existing Sepolia Aave V3 adapter supplies it.',
        envVar: 'VITE_EVM_ARC_TESTNET_CCTP_BRIDGE_ADAPTER_ADDRESS',
      },
    },
  },
  {
    id: 'op-standard-bridge',
    label: 'OP Standard Bridge',
    badge: null,
    badgeReason: null,
    chains: {
      1: {
        supported: true,
        reason: 'L1 StandardBridge for ETH/WETH between Ethereum and Base.',
        envVar: 'VITE_EVM_ETHEREUM_OP_BRIDGE_ADAPTER_ADDRESS',
      },
      8453: {
        supported: true,
        reason: 'L2 StandardBridge for ETH/WETH between Base and Ethereum.',
        envVar: 'VITE_EVM_BASE_OP_BRIDGE_ADAPTER_ADDRESS',
      },
      46630: {
        supported: false,
        configurableWithAdapter: false,
        reason: 'Robinhood Testnet does not use the OP Standard Bridge.',
        envVar: 'VITE_EVM_ROBINHOOD_TESTNET_OP_BRIDGE_ADAPTER_ADDRESS',
      },
      5042002: {
        supported: false,
        configurableWithAdapter: false,
        reason: 'Arc Testnet does not use the OP Standard Bridge.',
        envVar: 'VITE_EVM_ARC_TESTNET_OP_BRIDGE_ADAPTER_ADDRESS',
      },
    },
  },
];

/** Testnet-only fallback adapter addresses baked as defaults (env var always takes precedence). */
export const EVM_TESTNET_ADAPTER_FALLBACKS = {
  11155111: {
    aave: '0xFfFDfc7DEfbfaF64c232897452Aa6E6F92809426',
    compound: '0x845d8310A861A95Ed1644643D1BAe086944B1AA0',
    cctp: '0x222D1fb4a59c2b9759099802808fbb57bA5ff9db',
  },
  84532: {
    aave: '0x33D19799EBac88FFDc4e5BF61c199c71963470A6',
  },
  5042002: {
    cctp: '0x1b591C6a976e75F65F54cE863C8d96b3289BBF80',
  },
};

/** Chain ids considered "mainnet" for readiness-checklist purposes. */
export const EVM_MAINNET_CHAIN_IDS = [1, 8453, 4663];
/** Chain ids considered "testnet" for readiness-checklist purposes. */
export const EVM_TESTNET_CHAIN_IDS = [11155111, 84532, 46630, 5042002];
