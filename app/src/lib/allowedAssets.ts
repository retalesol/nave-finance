/**
 * Nave curated asset allowlist — frontend mirror.
 *
 * Used in the Assets page configure-position-targets dialog to:
 *   1. Show the founder a list of assets eligible for yield strategies
 *   2. Query live protocol APIs to discover the best pool for each asset
 *   3. Auto-populate the extMarket / extReserve fields
 */

export type AssetClass = 'stablecoin' | 'sol-like' | 'blue-chip' | 'lp';
export type PoolType = 'single-stake' | 'stable-lp' | 'sol-stable-lp';

export interface AllowedAsset {
  symbol: string;
  name: string;
  assetClass: AssetClass;
  /** Mainnet SPL mint address. */
  mint: string;
  /** Devnet mint (where different from mainnet). */
  mintDevnet?: string;
  maxRisk: number;
  eligiblePoolTypes: PoolType[];
  decimals: number;
}

export const ALLOWED_ASSETS: AllowedAsset[] = [
  // ── Stablecoins ─────────────────────────────────────────────────────────
  { symbol: 'USDC',  name: 'USD Coin',                mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', mintDevnet: 'Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr', assetClass: 'stablecoin', maxRisk: 35, eligiblePoolTypes: ['single-stake', 'stable-lp'], decimals: 6 },
  { symbol: 'USDT',  name: 'Tether USD',              mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', assetClass: 'stablecoin', maxRisk: 35, eligiblePoolTypes: ['single-stake', 'stable-lp'], decimals: 6 },
  { symbol: 'PYUSD', name: 'PayPal USD',              mint: '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo', assetClass: 'stablecoin', maxRisk: 40, eligiblePoolTypes: ['single-stake', 'stable-lp'], decimals: 6 },
  { symbol: 'USDe',  name: 'Ethena USDe',             mint: 'DEkqHyPN7GMRJ5cArtVmGpMoXDxUFUa75QM3BQMWF4iP', assetClass: 'stablecoin', maxRisk: 45, eligiblePoolTypes: ['single-stake', 'stable-lp'], decimals: 6 },
  { symbol: 'USD1',  name: 'USD1 (World Liberty)',    mint: 'USD1yTZGs1nLhKAhjfTgvpnpuQop7QzqMefnHxiHxMYz', assetClass: 'stablecoin', maxRisk: 50, eligiblePoolTypes: ['single-stake', 'stable-lp'], decimals: 6 },
  { symbol: 'USDG',  name: 'USDG',                   mint: 'GFX1ZjR2P15tmrSwow6FjyDYcEkoaCQiGMVsW9ZR5M3j', assetClass: 'stablecoin', maxRisk: 55, eligiblePoolTypes: ['single-stake', 'stable-lp'], decimals: 6 },
  { symbol: 'USX',   name: 'USX (UXD Protocol)',      mint: 'Ea5SjE2Y6yvCeW5dYTn7PYMuW5ikXkvbGdcmSnXeaLjS', assetClass: 'stablecoin', maxRisk: 55, eligiblePoolTypes: ['single-stake', 'stable-lp'], decimals: 9 },
  { symbol: 'USDGO', name: 'USDGO (GooseFX)',         mint: 'USDGoPLv5RDKFK3DVEfHQaM3CcLPHTwEZBdqnKMFd7c', assetClass: 'stablecoin', maxRisk: 60, eligiblePoolTypes: ['single-stake'], decimals: 6 },
  { symbol: 'CASH',  name: 'CASH',                    mint: 'CASHVDm2wsJXfhj6VWxb7GiMdoLc17Du7paH4bNr5woT', assetClass: 'stablecoin', maxRisk: 65, eligiblePoolTypes: ['single-stake'], decimals: 6 },
  // ── SOL-like / Liquid Staking ────────────────────────────────────────────
  { symbol: 'SOL',     name: 'Wrapped SOL',          mint: 'So11111111111111111111111111111111111111112', assetClass: 'sol-like', maxRisk: 30, eligiblePoolTypes: ['single-stake', 'sol-stable-lp'], decimals: 9 },
  { symbol: 'JitoSOL', name: 'Jito Staked SOL',      mint: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', assetClass: 'sol-like', maxRisk: 30, eligiblePoolTypes: ['single-stake', 'sol-stable-lp'], decimals: 9 },
  { symbol: 'JupSOL',  name: 'Jupiter Staked SOL',   mint: 'jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v', assetClass: 'sol-like', maxRisk: 30, eligiblePoolTypes: ['single-stake', 'sol-stable-lp'], decimals: 9 },
  { symbol: 'mSOL',    name: 'Marinade Staked SOL',  mint: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', assetClass: 'sol-like', maxRisk: 30, eligiblePoolTypes: ['single-stake', 'sol-stable-lp'], decimals: 9 },
  { symbol: 'bSOL',    name: 'BlazeStake SOL',       mint: 'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1', assetClass: 'sol-like', maxRisk: 35, eligiblePoolTypes: ['single-stake', 'sol-stable-lp'], decimals: 9 },
  { symbol: 'BNSOL',   name: 'Binance Staked SOL',   mint: 'BNSOLmFn9KSAm4dEbfQHsSZXpTqFvb3Tg4DjB8DwZDaG', assetClass: 'sol-like', maxRisk: 35, eligiblePoolTypes: ['single-stake', 'sol-stable-lp'], decimals: 9 },
  { symbol: 'hSOL',    name: 'Helius Staked SOL',    mint: 'he1iusmfkpAdwvxLNGV8Y1iSbj4rUy6yMhEA3fotn9A', assetClass: 'sol-like', maxRisk: 35, eligiblePoolTypes: ['single-stake', 'sol-stable-lp'], decimals: 9 },
  { symbol: 'jSOL',    name: 'JPOOL Staked SOL',     mint: '7Q2afV64in6N6SeZsAAB81TJzwDoD6zpqmHkzi9Dcavn', assetClass: 'sol-like', maxRisk: 40, eligiblePoolTypes: ['single-stake', 'sol-stable-lp'], decimals: 9 },
  { symbol: 'vSOL',    name: 'The Vault SOL',        mint: 'vSoLxydx6akxyMD9XEcGLiHQUtu5i4H2nBg5wFJCfVn', assetClass: 'sol-like', maxRisk: 40, eligiblePoolTypes: ['single-stake'], decimals: 9 },
  { symbol: 'bbSOL',   name: 'Backbone Finance SOL', mint: 'Lz2cLSjj5vCj2JbYwKDEuNWwEbAHqkfS6XVHH9VYv8N', assetClass: 'sol-like', maxRisk: 45, eligiblePoolTypes: ['single-stake'], decimals: 9 },
  { symbol: 'PSOL',    name: 'Parrot Staked SOL',    mint: '9EaLkQrbjmbbuZG9Wdpo8ynCF5kAFBFBGCbdFAEJNbgB', assetClass: 'sol-like', maxRisk: 45, eligiblePoolTypes: ['single-stake'], decimals: 9 },
  // ── Blue-chip tokens ─────────────────────────────────────────────────────
  { symbol: 'JUP',    name: 'Jupiter Exchange',  mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', assetClass: 'blue-chip', maxRisk: 55, eligiblePoolTypes: ['single-stake', 'sol-stable-lp'], decimals: 6 },
  { symbol: 'JTO',    name: 'Jito Governance',   mint: 'jtojtomepa8bemWMmTMKMHmHuMy6oDfbJuFKUQD3mLS', assetClass: 'blue-chip', maxRisk: 55, eligiblePoolTypes: ['single-stake'], decimals: 9 },
  { symbol: 'BONK',   name: 'Bonk',              mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', assetClass: 'blue-chip', maxRisk: 65, eligiblePoolTypes: ['single-stake'], decimals: 5 },
  { symbol: 'RENDER', name: 'Render Network',    mint: 'rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof', assetClass: 'blue-chip', maxRisk: 60, eligiblePoolTypes: ['single-stake'], decimals: 8 },
  { symbol: 'PENGU',  name: 'Pudgy Penguins',    mint: '2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv', assetClass: 'blue-chip', maxRisk: 70, eligiblePoolTypes: ['single-stake'], decimals: 6 },
  { symbol: 'TRUMP',  name: 'Official Trump',    mint: '6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN', assetClass: 'blue-chip', maxRisk: 80, eligiblePoolTypes: ['single-stake'], decimals: 6 },
  { symbol: 'PUMP',   name: 'Pump.fun',          mint: 'PUMPkinSPi4oQWFBDnMiSmwCLJRFTQawXSjBMEBqZSg', assetClass: 'blue-chip', maxRisk: 80, eligiblePoolTypes: ['single-stake'], decimals: 6 },
  // ── LP / Index ────────────────────────────────────────────────────────────
  { symbol: 'JLP', name: 'Jupiter Liquidity Provider', mint: '27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4', assetClass: 'lp', maxRisk: 65, eligiblePoolTypes: ['single-stake'], decimals: 6 },
];

/** Fast mint → asset lookup. */
export const ASSET_BY_MINT: ReadonlyMap<string, AllowedAsset> = new Map(
  ALLOWED_ASSETS.flatMap((a) =>
    [a.mint, ...(a.mintDevnet ? [a.mintDevnet] : [])].map((m) => [m, a] as [string, AllowedAsset]),
  ),
);

/** Returns the AllowedAsset for a mint, or undefined if not in the allowlist. */
export function resolveAsset(mint: string): AllowedAsset | undefined {
  return ASSET_BY_MINT.get(mint);
}

export const STABLECOIN_MINTS: ReadonlySet<string> = new Set(
  ALLOWED_ASSETS.filter((a) => a.assetClass === 'stablecoin').map((a) => a.mint),
);

export const SOL_LIKE_MINTS: ReadonlySet<string> = new Set(
  ALLOWED_ASSETS.filter((a) => a.assetClass === 'sol-like').map((a) => a.mint),
);

// ─── EVM ERC-20 allowlists (Ethereum + Base only) ────────────────────────────
// Keyed STRICTLY by the four supported chain ids: 1 (Ethereum), 8453 (Base),
// 11155111 (Ethereum Sepolia), 84532 (Base Sepolia). There is no slot for any
// other EVM chain.
//
// VERIFIED (2026-06): the mainnet addresses below are the canonical token
// deployments — Ethereum USDC 0xA0b8…eB48, USDT 0xdAC1…1ec7, DAI 0x6B17…1d0F,
// WETH 0xC02a…6Cc2, wstETH 0x7f39…2Ca0; Base USDC 0x8335…2913, USDbC 0xd9aA…b6CA,
// DAI 0x50c5…b0Cb, WETH 0x4200…0006, cbETH 0x2Ae3…ec22. Testnet rows use Circle's
// faucet USDC + canonical WETH. The DAO only ever holds assets the treasury
// REGISTERS on-chain (registerAsset) — this list just gates the create/strategy
// UI; re-confirm against deploy artifacts when adding new assets.

import type { EvmChainId } from './chain/types';

export interface EvmAllowedAsset {
  symbol: string;
  name: string;
  assetClass: AssetClass;
  /** Checksummed ERC-20 token address on the given chain. */
  address: string;
  /** 64-char Pyth price feed id, no 0x. Stablecoins can use all-zero feed ids. */
  pythFeedId?: string;
  decimals: number;
  maxRisk: number;
}

export const EVM_ALLOWED_ASSETS: Record<EvmChainId, EvmAllowedAsset[]> = {
  // ── Ethereum mainnet ───────────────────────────────────────────────────────
  1: [
    { symbol: 'USDC',   name: 'USD Coin',          assetClass: 'stablecoin', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6,  maxRisk: 35 },
    { symbol: 'USDT',   name: 'Tether USD',        assetClass: 'stablecoin', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6,  maxRisk: 35 },
    { symbol: 'DAI',    name: 'Dai Stablecoin',    assetClass: 'stablecoin', address: '0x6B175474E89094C44Da98b954EedeAC495271d0F', decimals: 18, maxRisk: 40 },
    { symbol: 'WETH',   name: 'Wrapped Ether',     assetClass: 'blue-chip',  address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', pythFeedId: 'ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace', decimals: 18, maxRisk: 45 },
    { symbol: 'wstETH', name: 'Wrapped stETH',     assetClass: 'sol-like',   address: '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0', decimals: 18, maxRisk: 45 },
  ],
  // ── Base mainnet ─────────────────────────────────────────────────────────────
  8453: [
    { symbol: 'USDC',  name: 'USD Coin',           assetClass: 'stablecoin', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6,  maxRisk: 35 },
    { symbol: 'USDbC', name: 'USD Base Coin',      assetClass: 'stablecoin', address: '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA', decimals: 6,  maxRisk: 40 },
    { symbol: 'DAI',   name: 'Dai Stablecoin',     assetClass: 'stablecoin', address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', decimals: 18, maxRisk: 40 },
    { symbol: 'WETH',  name: 'Wrapped Ether',      assetClass: 'blue-chip',  address: '0x4200000000000000000000000000000000000006', pythFeedId: 'ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace', decimals: 18, maxRisk: 45 },
    { symbol: 'cbETH', name: 'Coinbase Wrapped ETH', assetClass: 'sol-like', address: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22', decimals: 18, maxRisk: 45 },
  ],
  // ── Ethereum Sepolia (testnet) ───────────────────────────────────────────────
  11155111: [
    { symbol: 'USDC', name: 'USD Coin (Sepolia)',  assetClass: 'stablecoin', address: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', decimals: 6,  maxRisk: 35 },
    { symbol: 'aUSDC', name: 'Aave market USDC (Sepolia)',  assetClass: 'stablecoin', address: '0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8', decimals: 6,  maxRisk: 35 },
    { symbol: 'WETH', name: 'Wrapped Ether (Sepolia)', assetClass: 'blue-chip', address: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14', pythFeedId: 'ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace', decimals: 18, maxRisk: 45 },
  ],
  // ── Base Sepolia (testnet) ─────────────────────────────────────────────────────
  84532: [
    { symbol: 'USDC', name: 'USD Coin (Base Sepolia)', assetClass: 'stablecoin', address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', decimals: 6,  maxRisk: 35 },
    { symbol: 'aUSDC', name: 'Aave market USDC (Base Sepolia)', assetClass: 'stablecoin', address: '0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f', decimals: 6,  maxRisk: 35 },
    { symbol: 'WETH', name: 'Wrapped Ether (Base Sepolia)', assetClass: 'blue-chip', address: '0x4200000000000000000000000000000000000006', pythFeedId: 'ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace', decimals: 18, maxRisk: 45 },
  ],
  // ── Robinhood Chain (mainnet + testnet) ─────────────────────────────────────
  // Local DeFi is limited — agents bridge WETH out to an Ethereum sister treasury.
  // USDC omitted until ROBINHOOD_USDC is non-zero in NaveAddressRegistry.
  4663: [
    { symbol: 'WETH', name: 'Wrapped Ether', assetClass: 'blue-chip', address: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', pythFeedId: 'ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace', decimals: 18, maxRisk: 45 },
  ],
  46630: [
    { symbol: 'USDC', name: 'USD Coin (Robinhood Testnet)', assetClass: 'stablecoin', address: '0xAaaE26C5B891bF00D4cD6eF04148Bf1CB1CC96b1', decimals: 6, maxRisk: 35 },
    { symbol: 'WETH', name: 'Wrapped Ether (Robinhood Testnet)', assetClass: 'blue-chip', address: '0x7943e237c7F95DA44E0301572D358911207852Fa', pythFeedId: 'ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace', decimals: 18, maxRisk: 45 },
  ],
  // Arc Testnet ERC-20 USDC (6 decimals). Native gas USDC (18 decimals) is not listed.
  // No Pyth feed id: stablecoins with an empty feed keep $1 par valuation.
  5042002: [
    { symbol: 'USDC', name: 'USD Coin (Arc Testnet)', assetClass: 'stablecoin', address: '0x3600000000000000000000000000000000000000', decimals: 6, maxRisk: 35 },
  ],
};

/** Fast (chainId, address) → asset lookup for EVM tokens (case-insensitive). */
const EVM_ASSET_BY_KEY: ReadonlyMap<string, EvmAllowedAsset> = new Map(
  (Object.entries(EVM_ALLOWED_ASSETS) as [string, EvmAllowedAsset[]][]).flatMap(([chainId, assets]) =>
    assets.map((a) => [`${chainId}:${a.address.toLowerCase()}`, a] as [string, EvmAllowedAsset]),
  ),
);

/** Returns the allowlisted EVM asset for a (chainId, address), or undefined. */
export function resolveEvmAsset(chainId: EvmChainId, address: string): EvmAllowedAsset | undefined {
  return EVM_ASSET_BY_KEY.get(`${chainId}:${address.trim().toLowerCase()}`);
}

/** All allowlisted ERC-20 assets for a supported chain id. */
export function evmAllowedAssets(chainId: EvmChainId): EvmAllowedAsset[] {
  return EVM_ALLOWED_ASSETS[chainId] ?? [];
}

/** Risk score label for display. */
export function riskLabel(score: number): { label: string; color: string } {
  if (score <= 25) return { label: 'Very Low', color: 'hsl(var(--success))' };
  if (score <= 40) return { label: 'Low',      color: 'hsl(142 60% 45%)' };
  if (score <= 55) return { label: 'Medium',   color: 'hsl(var(--warning))' };
  if (score <= 70) return { label: 'High',     color: 'hsl(28 80% 48%)' };
  return             { label: 'Very High',     color: 'hsl(var(--destructive))' };
}
