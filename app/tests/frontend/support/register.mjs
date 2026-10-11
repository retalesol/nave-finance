// ─── Test-only harness bootstrap (preloaded via `node --import`) ──────────────
// Runs in the main thread BEFORE any test/source module executes. It:
//   1. Populates `globalThis.__NAVE_VITE_ENV__` with a deterministic, offline
//      Vite-env stand-in (see vite-env-loader.mjs for how src reads it).
//   2. Registers the `import.meta.env` rewrite loader (chained after tsx).
//
// Two profiles are selected via `process.env.NAVE_TEST_PROFILE`:
//   • default        — bridge + staking FULLY configured (relayer, custody,
//                       program ids, fee accounts, all three testnet wNAVE
//                       tokens: Sepolia / Base Sepolia / Robinhood Testnet).
//   • 'unconfigured' — relayer/custody/wNAVE unset so the bridge is DISABLED and
//                       there are NO supported routes (banner / no-route states).
//
// Values mirror `.env.example` so behavior matches a real testnet deployment.
// NOTHING here hits a network: RPC/Supabase/relayer URLs are inert placeholders.

import { register } from 'node:module';

const PROFILE = process.env.NAVE_TEST_PROFILE ?? 'default';
const unconfigured = PROFILE === 'unconfigured';

// Devnet-flavored RPC (must NOT contain "mainnet" — programConfig derives the
// network label from this string; devnet keeps fees/mints in testnet mode).
const base = {
  MODE: 'test',
  DEV: false,
  PROD: false,
  SSR: false,

  VITE_SOLANA_RPC_URL: 'https://api.devnet.solana.com',
  VITE_SUPABASE_URL: 'https://nave-test.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'test-anon-key-not-a-secret',

  // Required program ids (canonical devnet values from .env.example).
  VITE_NAVE_CORE_PROGRAM_ID: '8GSh9ghC2EL88X9FwftiH2QDrm8drvgSLAUoo45gN5nB',
  VITE_NAVE_GOVERNANCE_PROGRAM_ID: 'CwFouCjZyBrpLGuKvd9VXQqYh4ZYyT9yUQbqmo6k7n9M',
  VITE_NAVE_EXECUTION_PROGRAM_ID: '2sGy7WwF6uGCyBmPqohRtobmutGhKjr2AG2FKvfcpYzb',
  VITE_NAVE_JITO_ADAPTER_ID: 'E2fviyVGWF8iEwZK2M8ysrd63DM5yKxu6nuBMzjBQ2XT',
  VITE_NAVE_KAMINO_ADAPTER_ID: 'B69DnA6h7B7MvLkNjRQDs4qDUbw9zrNwF9c8WuKo7kfD',
  VITE_NAVE_MARGINFI_ADAPTER_ID: 'Gavh8GezswR14BYC851r6vevk267iWDfBkC3Fo49b1q7',
  VITE_NAVE_PROTOCOL_FEE_WALLET: 'EJ9qpuQosjwv8N1Rab7SK4zvVpEbvEBbCdum9KseADLn',

  VITE_SOLANA_NAVE_DEVNET_MINT: 'GmBMZuXsXpe7TZK27PTcXUyNGcuw9Ew8v3fxys7wM9Wa',

  // Bridge fee model: 2.5% on-top, split 1% staking / 1% protocol / 0.5% burn.
  VITE_NAVE_BRIDGE_FEE_BPS: '250',
  VITE_NAVE_BRIDGE_STAKING_BPS: '100',
  VITE_NAVE_BRIDGE_PROTOCOL_BPS: '100',
  VITE_NAVE_BRIDGE_BURN_BPS: '50',
  VITE_NAVE_BRIDGE_FEE_DBPS: '2500',
  VITE_NAVE_BRIDGE_EVM_CONFIRMATIONS: '5',
};

const configuredExtras = {
  VITE_NAVE_BRIDGE_RELAYER_URL: 'https://relayer.nave.test',
  VITE_NAVE_BRIDGE_SOLANA_CUSTODY: '9KTuzRJdDs59KU5UXNXdTQrPznEiiz4URk29NC3PkK5Q',
  VITE_NAVE_BRIDGE_PROGRAM_ID: 'Fu3ZpX1SMvqVhuo7E4uKGvJxe6cJDFDxxmSCET6de9u6',
  VITE_NAVE_STAKING_PROGRAM_ID: 'AxVdBgc8eUZ3VXKCCJxF7mAmRAtvtM2eYAbE3XBjnhjf',
  VITE_NAVE_BRIDGE_PROTOCOL_FEE_ACCOUNT: '6N5JiWP2zF6VXhG6hwgYEYhxBEARAV5P6WRgfYb2zskC',
  VITE_NAVE_BRIDGE_STAKING_POOL_ACCOUNT: 'EGg56E1YtL5YapzkF7vkRThHR8i5FeRvm2LLuySdYory',
  // Canonical testnet wNAVE (Sepolia, Base Sepolia, Robinhood Testnet).
  // Portal and older staking tokens are not substitutes.
  VITE_EVM_SEPOLIA_WRAPPED_NAVE_ADDRESS: '0x1d1d988e8ffE542f1f8F7932DE3A634251D4A042',
  VITE_EVM_BASE_SEPOLIA_WRAPPED_NAVE_ADDRESS: '0xC286e67D59F643a725cf4998af6Bb4f8D1354280',
  VITE_EVM_ROBINHOOD_TESTNET_WRAPPED_NAVE_ADDRESS: '0x7860FF876b49a5A992a7F3a4a6043ea57f17eD96',
  VITE_EVM_SEPOLIA_STAKING_ADDRESS: '0x9BdE2F925fb71bDfC3EA0F0F9617786b5a642F02',
  VITE_EVM_BASE_SEPOLIA_STAKING_ADDRESS: '0x7860FF876b49a5A992a7F3a4a6043ea57f17eD96',
  VITE_EVM_ROBINHOOD_TESTNET_STAKING_ADDRESS: '0x0000000000000000000000000000000000146630',
  VITE_EVM_SEPOLIA_RPC_URL: 'https://sepolia.nave.test',
  VITE_EVM_BASE_SEPOLIA_RPC_URL: 'https://base-sepolia.nave.test',
  VITE_EVM_ROBINHOOD_TESTNET_RPC_URL: 'https://robinhood-testnet.nave.test',
};

globalThis.__NAVE_VITE_ENV__ = unconfigured ? { ...base } : { ...base, ...configuredExtras };

// Chain the rewrite loader AFTER tsx so it post-processes tsx's transpiled JS.
register('./vite-env-loader.mjs', import.meta.url);
