/**
 * Read EVM NaveTreasury NAV + native ETH for treasury snapshots / aggregates.
 * Mirrors app `readContract(..., 'currentNav')` (micro-USD) and native balance.
 */
import { createPublicClient, http } from "npm:viem@2.21.55";
import { EVM_RPC_CONFIG } from "./evmFounder.ts";

const NAV_ABI = [
  {
    type: "function",
    name: "currentNav",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256", name: "nav" }],
  },
] as const;

export interface EvmTreasurySnapshotMetrics {
  /** On-chain `currentNav` converted from micro-USD to USD. */
  navUsd: number;
  /** Native ETH balance held by the treasury contract (ETH units). */
  nativeEth: number;
}

/**
 * Best-effort read of `currentNav` + `getBalance(treasury)`.
 * Returns null when RPC is unset, chain is unsupported, or the contract read fails.
 */
export async function readEvmTreasurySnapshotMetrics(
  chainId: number,
  treasury: `0x${string}`,
): Promise<EvmTreasurySnapshotMetrics | null> {
  const cfg = EVM_RPC_CONFIG[chainId];
  if (!cfg) return null;
  const rpcUrl = Deno.env.get(cfg.rpcEnv) ?? cfg.fallbackUrl;
  if (!rpcUrl) return null;
  try {
    const client = createPublicClient({ chain: cfg.chain, transport: http(rpcUrl) });
    const navMicro = (await client.readContract({
      address: treasury,
      abi: NAV_ABI,
      functionName: "currentNav",
    })) as bigint;
    const navUsd = Number(navMicro) / 1_000_000;
    const wei = await client.getBalance({ address: treasury });
    const nativeEth = Number(wei) / 1e18;
    return { navUsd, nativeEth };
  } catch (e) {
    console.error(
      "[evmTreasuryNav] read failed",
      treasury,
      chainId,
      e instanceof Error ? e.message : e,
    );
    return null;
  }
}
