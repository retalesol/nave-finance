/**
 * Read EVM NaveTreasury NAV + native ETH for treasury snapshots / aggregates.
 * Mirrors app `readContract(..., 'currentNav')` (micro-USD) and native balance.
 */
import { createPublicClient, http } from "npm:viem@2.21.55";
import { EVM_RPC_CONFIG, evmRpcUrlFor } from "./evmFounder.ts";

const NAV_ABI = [
  {
    type: "function",
    name: "currentNav",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256", name: "nav" }],
  },
  {
    type: "function",
    name: "getApprovedAdapters",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { type: "address[]", name: "adapters" },
      { type: "uint16[]", name: "maxAllocationBps" },
      { type: "bool[]", name: "approved" },
      { type: "string[]", name: "protocolIds" },
    ],
  },
  {
    type: "function",
    name: "position",
    stateMutability: "view",
    inputs: [{ type: "address", name: "adapter" }],
    outputs: [
      { type: "address", name: "asset" },
      { type: "uint256", name: "depositedAmount" },
      { type: "uint256", name: "currentValue" },
    ],
  },
] as const;

/** Same keys as the Solana snapshot rows, so the dashboard reads both alike. */
export interface EvmPositionSnapshot {
  protocol_id: string;
  adapter: string;
  mint: string;
  current_value_base_units: string;
  deposited_base_units: string;
}

export interface EvmTreasurySnapshotMetrics {
  /** On-chain `currentNav` converted from micro-USD to USD. */
  navUsd: number;
  /** Native ETH balance held by the treasury contract (ETH units). */
  nativeEth: number;
  /** Open adapter positions with their current marks. */
  positions: EvmPositionSnapshot[];
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
  const rpcUrl = evmRpcUrlFor(chainId);
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
    const positions: EvmPositionSnapshot[] = [];
    try {
      const [adapters, , , protocolIds] = (await client.readContract({
        address: treasury,
        abi: NAV_ABI,
        functionName: "getApprovedAdapters",
      })) as readonly [readonly `0x${string}`[], readonly number[], readonly boolean[], readonly string[]];
      for (let i = 0; i < adapters.length; i++) {
        const [asset, deposited, current] = (await client.readContract({
          address: treasury,
          abi: NAV_ABI,
          functionName: "position",
          args: [adapters[i]],
        })) as readonly [`0x${string}`, bigint, bigint];
        if (deposited === 0n && current === 0n) continue;
        positions.push({
          protocol_id: protocolIds[i] ?? adapters[i],
          adapter: adapters[i],
          mint: asset,
          current_value_base_units: current.toString(),
          deposited_base_units: deposited.toString(),
        });
      }
    } catch (e) {
      console.warn("[evmTreasuryNav] position read failed", treasury, e instanceof Error ? e.message : e);
    }
    return { navUsd, nativeEth, positions };
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
