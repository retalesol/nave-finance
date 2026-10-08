// Shared EVM founder reader: reads NaveTreasury.founder() (the treasury IS the
// DAO address) over the per-chain EVM RPC. Used by founder-gated edge functions
// (register-dao, update-dao-privacy, orchestrator-proxy, agent-admin,
// evm-guardian-freeze, evm-strategy-withdraw, generate-evm-agent-keys) so the
// EVM founder binding is identical everywhere.
//
// RPC env vars mirror the relayer/indexer so all EVM services share one config:
//   1        → EVM_ETHEREUM_RPC_URL           (mainnet: REQUIRED, no fallback)
//   11155111 → EVM_SEPOLIA_RPC_URL            (fallback: publicnode)
//   8453     → EVM_BASE_RPC_URL               (mainnet: REQUIRED, no fallback)
//   84532    → EVM_BASE_SEPOLIA_RPC_URL       (fallback: sepolia.base.org)
//   4663     → EVM_ROBINHOOD_RPC_URL          (mainnet: REQUIRED, no fallback)
//   46630    → EVM_ROBINHOOD_TESTNET_RPC_URL  (fallback: public RH testnet RPC)
//
// Mainnet chains deliberately have NO public-RPC fallback: founder / membership
// checks gate custody and capital movement, so they must run against the
// operator-configured RPC (fail closed when unset).
import { type Chain, createPublicClient, defineChain, http } from "npm:viem@2.21.55";
import { base, baseSepolia, mainnet, sepolia } from "npm:viem@2.21.55/chains";
import { EVM_CHAIN_IDS } from "./chain.ts";

const robinhood = defineChain({
  id: EVM_CHAIN_IDS.robinhood.mainnet,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
});

const robinhoodTestnet = defineChain({
  id: EVM_CHAIN_IDS.robinhood.testnet,
  name: "Robinhood Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.chain.robinhood.com"] } },
});

export const EVM_RPC_CONFIG: Record<
  number,
  { chain: Chain; rpcEnv: string; fallbackUrl?: string; protocolEnv: string }
> = {
  1: { chain: mainnet, rpcEnv: "EVM_ETHEREUM_RPC_URL", protocolEnv: "EVM_ETHEREUM_PROTOCOL_ADDRESS" },
  11155111: {
    chain: sepolia,
    rpcEnv: "EVM_SEPOLIA_RPC_URL",
    fallbackUrl: "https://ethereum-sepolia-rpc.publicnode.com",
    protocolEnv: "EVM_SEPOLIA_PROTOCOL_ADDRESS",
  },
  8453: { chain: base, rpcEnv: "EVM_BASE_RPC_URL", protocolEnv: "EVM_BASE_PROTOCOL_ADDRESS" },
  84532: {
    chain: baseSepolia,
    rpcEnv: "EVM_BASE_SEPOLIA_RPC_URL",
    fallbackUrl: "https://sepolia.base.org",
    protocolEnv: "EVM_BASE_SEPOLIA_PROTOCOL_ADDRESS",
  },
  4663: {
    chain: robinhood,
    rpcEnv: "EVM_ROBINHOOD_RPC_URL",
    protocolEnv: "EVM_ROBINHOOD_PROTOCOL_ADDRESS",
  },
  46630: {
    chain: robinhoodTestnet,
    rpcEnv: "EVM_ROBINHOOD_TESTNET_RPC_URL",
    fallbackUrl: "https://rpc.testnet.chain.robinhood.com",
    protocolEnv: "EVM_ROBINHOOD_TESTNET_PROTOCOL_ADDRESS",
  },
};

const NAVE_TREASURY_FOUNDER_ABI = [
  {
    type: "function",
    name: "founder",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "protocol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

const NAVE_PROTOCOL_REGISTRY_ABI = [
  {
    type: "function",
    name: "isNaveTreasury",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

/** Resolved RPC URL for `chainId` (env, else testnet-only fallback), or null. */
export function evmRpcUrlFor(chainId: number | null | undefined): string | null {
  if (chainId == null) return null;
  const cfg = EVM_RPC_CONFIG[chainId];
  if (!cfg) return null;
  return Deno.env.get(cfg.rpcEnv) ?? cfg.fallbackUrl ?? null;
}

/** True when a per-chain RPC is configured (env or testnet fallback) for `chainId`. */
export function hasEvmRpc(chainId: number): boolean {
  return evmRpcUrlFor(chainId) !== null;
}

/** Configured NaveProtocol address (lowercased) for `chainId`, or null when unset. */
export function evmProtocolAddressFor(chainId: number): string | null {
  const cfg = EVM_RPC_CONFIG[chainId];
  if (!cfg) return null;
  const raw = Deno.env.get(cfg.protocolEnv)?.trim();
  if (!raw || !/^0x[0-9a-fA-F]{40}$/.test(raw)) return null;
  return raw.toLowerCase();
}

/**
 * Read NaveTreasury.founder() for the DAO treasury at `treasury`. Returns the
 * founder address lowercased, or null when the per-chain RPC is unset or the
 * read fails (the caller distinguishes "RPC unavailable" from "founder mismatch").
 */
export async function readEvmTreasuryFounder(
  chainId: number,
  treasury: string,
): Promise<string | null> {
  const cfg = EVM_RPC_CONFIG[chainId];
  const rpcUrl = evmRpcUrlFor(chainId);
  if (!cfg || !rpcUrl) return null;
  try {
    const client = createPublicClient({ chain: cfg.chain, transport: http(rpcUrl) });
    const founder = (await client.readContract({
      address: treasury as `0x${string}`,
      abi: NAVE_TREASURY_FOUNDER_ABI,
      functionName: "founder",
    })) as string;
    return typeof founder === "string" ? founder.toLowerCase() : null;
  } catch {
    return null;
  }
}

export type EvmTreasuryMembership =
  | { ok: true }
  | { ok: false; reason: "rpc_unavailable" | "protocol_unconfigured" | "read_failed" | "protocol_mismatch" | "not_registered" };

/**
 * Verify `treasury` is a genuine NaveTreasury clone of the configured protocol
 * on `chainId`: `treasury.protocol()` must equal the operator-configured
 * NaveProtocol address AND `NaveProtocol.isNaveTreasury(treasury)` must be true.
 * Both checks are anchored to the configured protocol address so a look-alike
 * contract that points at an attacker-controlled "protocol" cannot pass.
 */
export async function verifyEvmTreasuryMembership(
  chainId: number,
  treasury: string,
): Promise<EvmTreasuryMembership> {
  const cfg = EVM_RPC_CONFIG[chainId];
  const rpcUrl = evmRpcUrlFor(chainId);
  if (!cfg || !rpcUrl) return { ok: false, reason: "rpc_unavailable" };
  const protocol = evmProtocolAddressFor(chainId);
  if (!protocol) return { ok: false, reason: "protocol_unconfigured" };
  try {
    const client = createPublicClient({ chain: cfg.chain, transport: http(rpcUrl) });
    const reported = (await client.readContract({
      address: treasury as `0x${string}`,
      abi: NAVE_TREASURY_FOUNDER_ABI,
      functionName: "protocol",
    })) as string;
    if (typeof reported !== "string" || reported.toLowerCase() !== protocol) {
      return { ok: false, reason: "protocol_mismatch" };
    }
    const registered = (await client.readContract({
      address: protocol as `0x${string}`,
      abi: NAVE_PROTOCOL_REGISTRY_ABI,
      functionName: "isNaveTreasury",
      args: [treasury as `0x${string}`],
    })) as boolean;
    return registered === true ? { ok: true } : { ok: false, reason: "not_registered" };
  } catch {
    return { ok: false, reason: "read_failed" };
  }
}
