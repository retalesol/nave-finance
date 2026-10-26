// Ethereum-family yield a Base, Robinhood, or Arc treasury can see.
//
// Sepolia (11155111) stands in for Ethereum mainnet on testnet. The 6–12%
// band sorts and labels rates. It does not hide a lower Aave or wstETH rate.
// Nexo, Nexus Mutual, and Curve are not venues here.
//
// Bridge costs below are named estimates. This module does not quote live
// gas. A one-way cost is spread over a 30-day hold by annualizing it
// (costBps * 365 / 30) and subtracting that drag from the venue APY.
// USDC uses CCTP. ETH uses Arbitrum Nitro on Robinhood and the OP
// StandardBridge on Base. Arc has no Nitro or OP ETH bridge, so ETH there
// uses its own named estimate.

import type { YieldBand, YieldOpportunity } from "./policy.ts";

export const BRIDGE_HOLD_DAYS = 30;
export const YIELD_BAND_MIN_BPS = 600;
export const YIELD_BAND_MAX_BPS = 1_200;

/**
 * CCTP standard transfer charges no protocol fee (Circle: gas only).
 * 15 bps stands in for source burn gas, destination mint gas, and a relayer
 * buffer on a typical treasury clip. Named `estimate:cctp-standard-gas-15bps`.
 */
export const CCTP_USDC_ONE_WAY_COST_BPS_ESTIMATE = 15;

/**
 * Arbitrum Nitro retryable tickets charge gas, not a protocol percent.
 * 20 bps is the stand-in. Named `estimate:arbitrum-nitro-retryable-20bps`.
 */
export const ARBITRUM_NITRO_ETH_ONE_WAY_COST_BPS_ESTIMATE = 20;

/**
 * OP StandardBridge ETH deposits charge gas, not a protocol percent.
 * 12 bps is the stand-in. Named `estimate:op-standard-bridge-gas-12bps`.
 */
export const OP_STANDARD_BRIDGE_ETH_ONE_WAY_COST_BPS_ESTIMATE = 12;

/**
 * Arc is not an Arbitrum Nitro chain and does not use the OP StandardBridge.
 * 25 bps is the stand-in until a live ETH fee exists.
 * Named `estimate:arc-eth-bridge-unspecified-25bps`.
 */
export const ARC_ETH_ONE_WAY_COST_BPS_ESTIMATE = 25;

/** Sepolia Aave V3 adapter bound to the deterministic protocol. */
export const SEPOLIA_AAVE_V3_ADAPTER = "0xa201F28bd676b9C998e5d5dd2206c9B33AE41d51";
/** Sepolia Compound V3 USDC adapter bound to the deterministic protocol. */
export const SEPOLIA_COMPOUND_V3_ADAPTER = "0x88928305ab37bEae440a527d4571DbDBA425dd13";

const SEPOLIA_USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const SEPOLIA_WETH = "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14";
const MAINNET_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const MAINNET_WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const MAINNET_WSTETH = "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0";

/** Morpho Steakhouse USDC vault on Ethereum mainnet (curated, not every market). */
export const MORPHO_STEAKHOUSE_USDC_VAULT = "0xBEEF01735c132Ada46AA9aA4c54623cAA92A64CB";
/** Morpho Gauntlet USDC Prime vault on Ethereum mainnet. */
export const MORPHO_GAUNTLET_USDC_VAULT = "0xdd0f28e19C1780eb6396170735D45153D261490d";

/**
 * Spark Savings sUSDS vault address by chain. Empty means the slot exists
 * and the vault is not allowlisted yet. Do not invent an address here.
 */
export const SPARK_SUSDS_VAULT_BY_CHAIN: Partial<Record<number, string>> = {
  1: "",
  11155111: "",
};

/** Solana yield ids. MarginFi stays off unless its existing flag is on. */
export function solanaYieldProtocolIds(marginfiEnabled = false): string[] {
  const ids = ["kamino", "jito", "jupiter"];
  if (marginfiEnabled) ids.push("marginfi");
  return ids;
}

export function seesEthereumFamilyYield(homeChainId: number): boolean {
  return homeChainId === 8453
    || homeChainId === 84532
    || homeChainId === 4663
    || homeChainId === 46630
    || homeChainId === 5042
    || homeChainId === 5042002;
}

/** Sepolia for testnet homes, Ethereum mainnet for mainnet homes. */
export function ethereumVenueChainId(homeChainId: number): 1 | 11155111 | null {
  if (homeChainId === 84532 || homeChainId === 46630 || homeChainId === 5042002) return 11155111;
  if (homeChainId === 8453 || homeChainId === 4663 || homeChainId === 5042) return 1;
  return null;
}

export function annualizedBridgeDragBps(oneWayCostBps: number, holdDays = BRIDGE_HOLD_DAYS): number {
  if (!Number.isFinite(oneWayCostBps) || oneWayCostBps <= 0 || holdDays <= 0) return 0;
  return Math.round((oneWayCostBps * 365) / holdDays);
}

/** Venue APY minus the one-way bridge cost spread over `holdDays`. */
export function netOfBridgeApyBps(
  venueApyBps: number,
  oneWayCostBps: number,
  holdDays = BRIDGE_HOLD_DAYS,
): number {
  return Math.round(venueApyBps) - annualizedBridgeDragBps(oneWayCostBps, holdDays);
}

export function yieldBandFor(apyBps: number): YieldBand {
  if (apyBps < YIELD_BAND_MIN_BPS) return "below-band";
  if (apyBps > YIELD_BAND_MAX_BPS) return "above-band";
  return "in-band";
}

const BAND_ORDER: Record<YieldBand, number> = {
  "in-band": 0,
  "above-band": 1,
  "below-band": 2,
};

/** In-band first, then above, then below. Unread rates stay last. Nothing is dropped. */
export function compareYieldDisplay(a: YieldOpportunity, b: YieldOpportunity): number {
  const unreadA = a.apyRead === false ? 1 : 0;
  const unreadB = b.apyRead === false ? 1 : 0;
  if (unreadA !== unreadB) return unreadA - unreadB;
  const bandA = a.yieldBand ? BAND_ORDER[a.yieldBand] : 3;
  const bandB = b.yieldBand ? BAND_ORDER[b.yieldBand] : 3;
  if (bandA !== bandB) return bandA - bandB;
  const netA = a.netApyBps ?? a.apyBps;
  const netB = b.netApyBps ?? b.apyBps;
  if (netA !== netB) return netB - netA;
  if (a.protocolId !== b.protocolId) return a.protocolId < b.protocolId ? -1 : 1;
  return 0;
}

export interface BridgeCostEstimate {
  oneWayCostBps: number;
  kind: "estimate" | "live";
  rail: "cctp" | "arbitrum-nitro" | "op-standard-bridge" | "arc-eth-unspecified";
  source: string;
  label: string;
}

export function bridgeCostFor(homeChainId: number, asset: "usdc" | "eth"): BridgeCostEstimate {
  if (asset === "usdc") {
    return {
      oneWayCostBps: CCTP_USDC_ONE_WAY_COST_BPS_ESTIMATE,
      kind: "estimate",
      rail: "cctp",
      source: "estimate:cctp-standard-gas-15bps",
      label: "CCTP (estimate)",
    };
  }
  if (homeChainId === 4663 || homeChainId === 46630) {
    return {
      oneWayCostBps: ARBITRUM_NITRO_ETH_ONE_WAY_COST_BPS_ESTIMATE,
      kind: "estimate",
      rail: "arbitrum-nitro",
      source: "estimate:arbitrum-nitro-retryable-20bps",
      label: "Arbitrum Nitro (estimate)",
    };
  }
  if (homeChainId === 8453 || homeChainId === 84532) {
    return {
      oneWayCostBps: OP_STANDARD_BRIDGE_ETH_ONE_WAY_COST_BPS_ESTIMATE,
      kind: "estimate",
      rail: "op-standard-bridge",
      source: "estimate:op-standard-bridge-gas-12bps",
      label: "OP StandardBridge (estimate)",
    };
  }
  return {
    oneWayCostBps: ARC_ETH_ONE_WAY_COST_BPS_ESTIMATE,
    kind: "estimate",
    rail: "arc-eth-unspecified",
    source: "estimate:arc-eth-bridge-unspecified-25bps",
    label: "Arc ETH bridge (estimate)",
  };
}

interface VenueSpec {
  id: string;
  label: string;
  symbol: string;
  assetClass: "stablecoin" | "blue-chip";
  assetKind: "usdc" | "eth";
  riskScore: number;
  /** Static testnet rate. Never applied to a mainnet home. */
  testnetApyBps: number;
  /** strategy_rates venue id. Omitted when no catalog pool should be reused. */
  rateVenueId?: string;
  mintByChain: Partial<Record<number, string>>;
  /** Nave adapter that can supply the venue. Empty until one is deployed. */
  adapterByChain: Partial<Record<number, string>>;
  /** ERC-4626 vault or staking token. Empty until allowlisted. */
  marketByChain: Partial<Record<number, string>>;
}

/**
 * Curated Ethereum venues. Morpho is an allowlist of ERC-4626 vaults, the
 * same adapter shape as Steakhouse, not a single hardcoded market. Spark
 * Savings sUSDS is the same shape and stays dark until its address slot is
 * filled. wstETH is the ETH staking leg.
 */
export const ETHEREUM_FAMILY_VENUES: readonly VenueSpec[] = [
  {
    id: "aave-v3-usdc",
    label: "Aave V3 USDC",
    symbol: "USDC",
    assetClass: "stablecoin",
    assetKind: "usdc",
    riskScore: 16,
    testnetApyBps: 450,
    rateVenueId: "aave",
    mintByChain: { 1: MAINNET_USDC, 11155111: SEPOLIA_USDC },
    adapterByChain: { 11155111: SEPOLIA_AAVE_V3_ADAPTER },
    marketByChain: {},
  },
  {
    id: "aave-v3-weth",
    label: "Aave V3 WETH",
    symbol: "WETH",
    assetClass: "blue-chip",
    assetKind: "eth",
    riskScore: 22,
    testnetApyBps: 180,
    mintByChain: { 1: MAINNET_WETH, 11155111: SEPOLIA_WETH },
    adapterByChain: { 11155111: SEPOLIA_AAVE_V3_ADAPTER },
    marketByChain: {},
  },
  {
    id: "compound-v3-usdc",
    label: "Compound V3 USDC",
    symbol: "USDC",
    assetClass: "stablecoin",
    assetKind: "usdc",
    riskScore: 18,
    testnetApyBps: 420,
    rateVenueId: "compound",
    mintByChain: { 1: MAINNET_USDC, 11155111: SEPOLIA_USDC },
    adapterByChain: { 11155111: SEPOLIA_COMPOUND_V3_ADAPTER },
    marketByChain: {},
  },
  {
    id: "morpho-steakhouse-usdc",
    label: "Morpho Steakhouse USDC",
    symbol: "USDC",
    assetClass: "stablecoin",
    assetKind: "usdc",
    riskScore: 18,
    testnetApyBps: 360,
    rateVenueId: "morpho-steakhouse-usdc",
    mintByChain: { 1: MAINNET_USDC, 11155111: SEPOLIA_USDC },
    adapterByChain: {},
    marketByChain: { 1: MORPHO_STEAKHOUSE_USDC_VAULT, 11155111: "" },
  },
  {
    id: "morpho-gauntlet-usdc",
    label: "Morpho Gauntlet USDC Prime",
    symbol: "USDC",
    assetClass: "stablecoin",
    assetKind: "usdc",
    riskScore: 18,
    testnetApyBps: 360,
    rateVenueId: "morpho-gauntlet-usdc",
    mintByChain: { 1: MAINNET_USDC, 11155111: SEPOLIA_USDC },
    adapterByChain: {},
    marketByChain: { 1: MORPHO_GAUNTLET_USDC_VAULT, 11155111: "" },
  },
  {
    id: "spark-susds",
    label: "Spark Savings sUSDS",
    symbol: "USDS",
    assetClass: "stablecoin",
    assetKind: "usdc",
    riskScore: 16,
    testnetApyBps: 380,
    rateVenueId: "sky-susds",
    mintByChain: {},
    adapterByChain: {},
    marketByChain: SPARK_SUSDS_VAULT_BY_CHAIN,
  },
  {
    id: "wsteth",
    label: "wstETH",
    symbol: "wstETH",
    assetClass: "blue-chip",
    assetKind: "eth",
    riskScore: 20,
    testnetApyBps: 280,
    mintByChain: { 1: MAINNET_WSTETH },
    adapterByChain: {},
    marketByChain: { 1: MAINNET_WSTETH, 11155111: "" },
  },
];

export interface EthereumFamilyScoreOptions {
  /** Live venue APY in bps, keyed by venue id or catalog rateVenueId. */
  liveApyBps?: Readonly<Record<string, number>>;
  /** True when this treasury has a deployment on Ethereum, or Sepolia on testnet. */
  linkedEthereumTreasury?: boolean;
  /** True only when NAVE_BRIDGE_OUTBOUND_ENABLED is on. Defaults off. */
  outboundBridgeEnabled?: boolean;
}

function usableAddress(value: string | undefined): string {
  const id = (value ?? "").trim();
  if (!id || /^0x0{40}$/i.test(id)) return "";
  return id;
}

function readLiveApy(
  live: Readonly<Record<string, number>> | undefined,
  venueId: string,
  rateVenueId: string | undefined,
): number | null {
  if (!live) return null;
  const direct = live[venueId];
  if (direct != null && Number.isFinite(direct) && direct >= 0) return direct;
  if (rateVenueId) {
    const aliased = live[rateVenueId];
    if (aliased != null && Number.isFinite(aliased) && aliased >= 0) return aliased;
  }
  return null;
}

function executionState(args: {
  linkedEthereumTreasury: boolean;
  outboundBridgeEnabled: boolean;
  adapterReady: boolean;
}): { executable: boolean; executionLabel: string } {
  const missing: string[] = [];
  if (!args.linkedEthereumTreasury) missing.push("no linked Ethereum treasury");
  if (!args.outboundBridgeEnabled) missing.push("outbound bridge is off");
  if (missing.length > 0) {
    return { executable: false, executionLabel: `not executable: ${missing.join("; ")}` };
  }
  if (!args.adapterReady) {
    return { executable: false, executionLabel: "not executable: venue address is not allowlisted" };
  }
  return { executable: true, executionLabel: "executable" };
}

/**
 * Ethereum venues for a Base, Robinhood, or Arc treasury. Each row is
 * bridge-required. Testnet homes use documented static rates. Mainnet homes
 * keep apyRead false unless `liveApyBps` has a read for that venue.
 * Returns [] for Solana, Ethereum, and Sepolia (those are not bridged homes).
 */
export function ethereumFamilyOpportunities(
  homeChainId: number,
  options: EthereumFamilyScoreOptions = {},
): YieldOpportunity[] {
  const venueChainId = ethereumVenueChainId(homeChainId);
  if (venueChainId == null) return [];
  const testnet = venueChainId === 11155111;
  const venueChainLabel = testnet ? "Sepolia" : "Ethereum";
  const linked = options.linkedEthereumTreasury === true;
  const bridgeOn = options.outboundBridgeEnabled === true;

  const rows = ETHEREUM_FAMILY_VENUES.map((venue): YieldOpportunity => {
    const bridge = bridgeCostFor(homeChainId, venue.assetKind);
    const adapter = usableAddress(venue.adapterByChain[venueChainId]);
    const market = usableAddress(venue.marketByChain[venueChainId]);
    const live = readLiveApy(options.liveApyBps, venue.id, venue.rateVenueId);
    const staticBps = testnet ? venue.testnetApyBps : null;
    const venueApy = live ?? staticBps;
    const apyRead = venueApy != null;
    const net = apyRead ? netOfBridgeApyBps(venueApy, bridge.oneWayCostBps) : undefined;
    const execution = executionState({
      linkedEthereumTreasury: linked,
      outboundBridgeEnabled: bridgeOn,
      adapterReady: adapter !== "",
    });
    const rateKind = live != null ? "live-rate" : apyRead ? "testnet-rate" : "mainnet:rate-not-read";
    const rateToken = `${rateKind}:${venue.id}`;
    const execToken = execution.executable ? "executable" : "not-executable";
    return {
      protocolId: venue.id,
      label: venue.label,
      programId: adapter,
      mint: usableAddress(venue.mintByChain[venueChainId]) || undefined,
      symbol: venue.symbol,
      extReserve: market || undefined,
      apyBps: net ?? 0,
      venueApyBps: apyRead ? venueApy : undefined,
      netApyBps: net,
      apyRead,
      riskScore: venue.riskScore,
      assetClass: venue.assetClass,
      liquid: true,
      rateChain: "ethereum",
      rateVenueId: venue.rateVenueId,
      bridgeRequired: true,
      bridgeOneWayCostBps: bridge.oneWayCostBps,
      bridgeCostKind: bridge.kind,
      bridgeCostSource: bridge.source,
      bridgeLabel: bridge.label,
      executable: execution.executable,
      executionLabel: execution.executionLabel,
      yieldBand: net != null ? yieldBandFor(net) : undefined,
      venueChainId,
      venueChainLabel,
      source: `${rateToken}:bridge-required:${bridge.source}:${execToken}`,
    };
  });
  return rows.sort(compareYieldDisplay);
}
