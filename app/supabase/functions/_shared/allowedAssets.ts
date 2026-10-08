/**
 * Nave curated asset allowlist.
 *
 * These are the assets the autonomous agents are permitted to deploy treasury
 * capital into. They represent the highest-liquidity, highest-TVL tokens on
 * Solana — stablecoins, blue-chip LSTs, and major governance/utility tokens.
 *
 * Pool types each asset is eligible for:
 *   single-stake  — single-token lending / staking vault (e.g. USDC on Kamino)
 *   stable-lp     — stable↔stable LP (e.g. USDC-USDT pool)
 *   sol-stable-lp — LST↔stable LP (e.g. JitoSOL-USDC)
 *
 * Risk scores (0-100, lower = safer):
 *   0-20   stablecoins on established protocols
 *   20-40  major LSTs (JitoSOL, JupSOL, mSOL, …)
 *   40-60  blue-chip tokens with deep liquidity (JUP, BONK, JTO, …)
 *   60-80  mid-cap or newer tokens (JLP, PENGU, RENDER, …)
 *   80-100 higher-risk / speculative (TRUMP, PUMP, …)
 *
 * Mint addresses are for mainnet. Devnet has only a subset (USDC, wSOL).
 * The poolScanner queries live protocol APIs and intersects with this list
 * at runtime, so entries with uncertain mints are still useful once the
 * mint is confirmed — update the constant and redeploy the edge functions.
 */

export type AssetClass = "stablecoin" | "sol-like" | "blue-chip" | "lp";
export type PoolType = "single-stake" | "stable-lp" | "sol-stable-lp";

export interface AllowedAsset {
  /** Display symbol */
  symbol: string;
  /** Human-readable name */
  name: string;
  /** Asset class drives constitution-level policy (reserve floor, deployment caps). */
  assetClass: AssetClass;
  /** Mainnet SPL mint address. */
  mint: string;
  /** Devnet mint (where available). */
  mintDevnet?: string;
  /** Maximum acceptable pool risk score for this asset (0-100). */
  maxRisk: number;
  /** Pool types this asset is eligible for. */
  eligiblePoolTypes: PoolType[];
  /** Token decimals. */
  decimals: number;
}

// ─── Stablecoins ─────────────────────────────────────────────────────────────

const STABLECOINS: AllowedAsset[] = [
  {
    symbol: "USDC",
    name: "USD Coin",
    assetClass: "stablecoin",
    mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    mintDevnet: "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr",
    maxRisk: 35,
    eligiblePoolTypes: ["single-stake", "stable-lp"],
    decimals: 6,
  },
  {
    symbol: "USDT",
    name: "Tether USD",
    assetClass: "stablecoin",
    mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    maxRisk: 35,
    eligiblePoolTypes: ["single-stake", "stable-lp"],
    decimals: 6,
  },
  {
    symbol: "PYUSD",
    name: "PayPal USD",
    assetClass: "stablecoin",
    mint: "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo",
    maxRisk: 40,
    eligiblePoolTypes: ["single-stake", "stable-lp"],
    decimals: 6,
  },
  {
    symbol: "USDe",
    name: "Ethena USDe",
    assetClass: "stablecoin",
    // Ethena's USDe bridged to Solana via Wormhole
    mint: "DEkqHyPN7GMRJ5cArtVmGpMoXDxUFUa75QM3BQMWF4iP",
    maxRisk: 45,
    eligiblePoolTypes: ["single-stake", "stable-lp"],
    decimals: 6,
  },
  {
    symbol: "USD1",
    name: "USD1 (World Liberty Financial)",
    assetClass: "stablecoin",
    mint: "USD1yTZGs1nLhKAhjfTgvpnpuQop7QzqMefnHxiHxMYz",
    maxRisk: 50,
    eligiblePoolTypes: ["single-stake", "stable-lp"],
    decimals: 6,
  },
  {
    symbol: "USDG",
    name: "USDG (Global Dollar)",
    assetClass: "stablecoin",
    // GLP-backed stablecoin; verify at https://api.jup.ag/tokens/v1?symbols=USDG
    mint: "GFX1ZjR2P15tmrSwow6FjyDYcEkoaCQiGMVsW9ZR5M3j",
    maxRisk: 55,
    eligiblePoolTypes: ["single-stake", "stable-lp"],
    decimals: 6,
  },
  {
    symbol: "USX",
    name: "USX (UXD Protocol)",
    assetClass: "stablecoin",
    mint: "Ea5SjE2Y6yvCeW5dYTn7PYMuW5ikXkvbGdcmSnXeaLjS",
    maxRisk: 55,
    eligiblePoolTypes: ["single-stake", "stable-lp"],
    decimals: 9,
  },
  {
    symbol: "USDGO",
    name: "USDGO (GooseFX)",
    assetClass: "stablecoin",
    // Verify at https://api.jup.ag/tokens/v1?symbols=USDGO
    mint: "USDGoPLv5RDKFK3DVEfHQaM3CcLPHTwEZBdqnKMFd7c",
    maxRisk: 60,
    eligiblePoolTypes: ["single-stake"],
    decimals: 6,
  },
  {
    symbol: "CASH",
    name: "CASH (Cashio / perp.fi)",
    assetClass: "stablecoin",
    // Verify mint — multiple tokens named CASH exist on Solana
    mint: "CASHVDm2wsJXfhj6VWxb7GiMdoLc17Du7paH4bNr5woT",
    maxRisk: 65,
    eligiblePoolTypes: ["single-stake"],
    decimals: 6,
  },
];

// ─── SOL-like / Liquid Staking Tokens ────────────────────────────────────────

const SOL_LIKE: AllowedAsset[] = [
  {
    symbol: "SOL",
    name: "Wrapped SOL",
    assetClass: "sol-like",
    mint: "So11111111111111111111111111111111111111112", // wSOL (same as native SOL on-chain)
    mintDevnet: "So11111111111111111111111111111111111111112",
    maxRisk: 30,
    eligiblePoolTypes: ["single-stake", "sol-stable-lp"],
    decimals: 9,
  },
  {
    symbol: "JitoSOL",
    name: "Jito Staked SOL",
    assetClass: "sol-like",
    mint: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn",
    maxRisk: 30,
    eligiblePoolTypes: ["single-stake", "sol-stable-lp"],
    decimals: 9,
  },
  {
    symbol: "JupSOL",
    name: "Jupiter Staked SOL",
    assetClass: "sol-like",
    mint: "jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v",
    maxRisk: 30,
    eligiblePoolTypes: ["single-stake", "sol-stable-lp"],
    decimals: 9,
  },
  {
    symbol: "mSOL",
    name: "Marinade Staked SOL",
    assetClass: "sol-like",
    mint: "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",
    maxRisk: 30,
    eligiblePoolTypes: ["single-stake", "sol-stable-lp"],
    decimals: 9,
  },
  {
    symbol: "bSOL",
    name: "BlazeStake SOL",
    assetClass: "sol-like",
    mint: "bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1",
    maxRisk: 35,
    eligiblePoolTypes: ["single-stake", "sol-stable-lp"],
    decimals: 9,
  },
  {
    symbol: "BNSOL",
    name: "Binance Staked SOL",
    assetClass: "sol-like",
    mint: "BNSOLmFn9KSAm4dEbfQHsSZXpTqFvb3Tg4DjB8DwZDaG",
    maxRisk: 35,
    eligiblePoolTypes: ["single-stake", "sol-stable-lp"],
    decimals: 9,
  },
  {
    symbol: "hSOL",
    name: "Helius Staked SOL",
    assetClass: "sol-like",
    mint: "he1iusmfkpAdwvxLNGV8Y1iSbj4rUy6yMhEA3fotn9A",
    maxRisk: 35,
    eligiblePoolTypes: ["single-stake", "sol-stable-lp"],
    decimals: 9,
  },
  {
    symbol: "jSOL",
    name: "JPOOL Staked SOL",
    assetClass: "sol-like",
    mint: "7Q2afV64in6N6SeZsAAB81TJzwDoD6zpqmHkzi9Dcavn",
    maxRisk: 40,
    eligiblePoolTypes: ["single-stake", "sol-stable-lp"],
    decimals: 9,
  },
  {
    symbol: "vSOL",
    name: "The Vault SOL",
    assetClass: "sol-like",
    mint: "vSoLxydx6akxyMD9XEcGLiHQUtu5i4H2nBg5wFJCfVn",
    maxRisk: 40,
    eligiblePoolTypes: ["single-stake", "sol-stable-lp"],
    decimals: 9,
  },
  {
    symbol: "bbSOL",
    name: "Backbone Finance SOL",
    assetClass: "sol-like",
    mint: "Lz2cLSjj5vCj2JbYwKDEuNWwEbAHqkfS6XVHH9VYv8N",
    maxRisk: 45,
    eligiblePoolTypes: ["single-stake"],
    decimals: 9,
  },
  {
    symbol: "PSOL",
    name: "Parrot Staked SOL",
    assetClass: "sol-like",
    mint: "9EaLkQrbjmbbuZG9Wdpo8ynCF5kAFBFBGCbdFAEJNbgB",
    maxRisk: 45,
    eligiblePoolTypes: ["single-stake"],
    decimals: 9,
  },
];

// ─── Blue-chip tokens ─────────────────────────────────────────────────────────

const BLUE_CHIP: AllowedAsset[] = [
  {
    symbol: "JUP",
    name: "Jupiter Exchange",
    assetClass: "blue-chip",
    mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
    maxRisk: 55,
    eligiblePoolTypes: ["single-stake", "sol-stable-lp"],
    decimals: 6,
  },
  {
    symbol: "JTO",
    name: "Jito Governance",
    assetClass: "blue-chip",
    mint: "jtojtomepa8bemWMmTMKMHmHuMy6oDfbJuFKUQD3mLS",
    maxRisk: 55,
    eligiblePoolTypes: ["single-stake"],
    decimals: 9,
  },
  {
    symbol: "BONK",
    name: "Bonk",
    assetClass: "blue-chip",
    mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
    maxRisk: 65,
    eligiblePoolTypes: ["single-stake"],
    decimals: 5,
  },
  {
    symbol: "RENDER",
    name: "Render Network",
    assetClass: "blue-chip",
    mint: "rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof",
    maxRisk: 60,
    eligiblePoolTypes: ["single-stake"],
    decimals: 8,
  },
  {
    symbol: "PENGU",
    name: "Pudgy Penguins",
    assetClass: "blue-chip",
    mint: "2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv",
    maxRisk: 70,
    eligiblePoolTypes: ["single-stake"],
    decimals: 6,
  },
  {
    symbol: "TRUMP",
    name: "Official Trump",
    assetClass: "blue-chip",
    mint: "6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN",
    maxRisk: 80,
    eligiblePoolTypes: ["single-stake"],
    decimals: 6,
  },
  {
    symbol: "PUMP",
    name: "Pump.fun",
    assetClass: "blue-chip",
    // Verify: pump.fun governance token mint (confirm before enabling)
    mint: "PUMPkinSPi4oQWFBDnMiSmwCLJRFTQawXSjBMEBqZSg",
    maxRisk: 80,
    eligiblePoolTypes: ["single-stake"],
    decimals: 6,
  },
];

// ─── LP / Index tokens ────────────────────────────────────────────────────────

const LP_TOKENS: AllowedAsset[] = [
  {
    symbol: "JLP",
    name: "Jupiter Liquidity Provider",
    assetClass: "lp",
    mint: "27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4",
    maxRisk: 65,
    eligiblePoolTypes: ["single-stake"],
    decimals: 6,
  },
];

// ─── Master list ─────────────────────────────────────────────────────────────

export const ALLOWED_ASSETS: AllowedAsset[] = [
  ...STABLECOINS,
  ...SOL_LIKE,
  ...BLUE_CHIP,
  ...LP_TOKENS,
];

/** Set of all allowed mainnet mint addresses for O(1) lookup. */
export const ALLOWED_MINTS_MAINNET: ReadonlySet<string> = new Set(
  ALLOWED_ASSETS.map((a) => a.mint),
);

/** Allowed devnet mints (where available) + mainnet mints used on devnet. */
export const ALLOWED_MINTS_DEVNET: ReadonlySet<string> = new Set([
  ...ALLOWED_ASSETS.map((a) => a.mintDevnet ?? a.mint),
]);

/** Resolve an AllowedAsset by mint (mainnet or devnet). */
export function resolveAsset(mint: string): AllowedAsset | undefined {
  return ALLOWED_ASSETS.find(
    (a) => a.mint === mint || (a.mintDevnet && a.mintDevnet === mint),
  );
}

/** Returns true when a mint is in the curated allowlist for the given network. */
export function isMintAllowed(mint: string, isMainnet = false): boolean {
  return isMainnet
    ? ALLOWED_MINTS_MAINNET.has(mint)
    : ALLOWED_MINTS_DEVNET.has(mint);
}

/** Stablecoin mints only (for reserve-floor calculations). */
export const STABLECOIN_MINTS: ReadonlySet<string> = new Set(
  ALLOWED_ASSETS.filter((a) => a.assetClass === "stablecoin").map((a) => a.mint),
);

/** SOL-like mints only (for LST-specific strategy routing). */
export const SOL_LIKE_MINTS: ReadonlySet<string> = new Set(
  ALLOWED_ASSETS.filter((a) => a.assetClass === "sol-like").map((a) => a.mint),
);
