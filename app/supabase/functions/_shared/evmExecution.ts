// EVM execution-request reads for agent-orchestrator poll/dispatch.
//
// On EVM, execution requests are keyed by uint64 index (typically the passed
// proposal index) on the per-DAO NaveExecution clone. Unlike Solana PDAs, there
// is no getProgramAccounts enumeration — poll mode discovers candidate indices
// from recent activity_logs / agent_action_logs and verifies each on-chain via
// getRequest(index).

import {
  createPublicClient,
  http,
  type Chain,
} from "npm:viem@2.21.55";
import { EVM_RPC_CONFIG, evmRpcUrlFor } from "./evmFounder.ts";

const NAVE_TREASURY_ABI = [
  {
    type: "function",
    name: "frozen",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "agentsEnabled",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "governor",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "execution",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "proposalCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const NAVE_EXECUTION_ABI = [
  {
    type: "function",
    name: "getRequest",
    stateMutability: "view",
    inputs: [{ name: "index", type: "uint64" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "exists", type: "bool" },
          { name: "kind", type: "uint8" },
          { name: "status", type: "uint8" },
          { name: "bootstrap", type: "bool" },
          { name: "proposalIndex", type: "uint64" },
          { name: "adapter", type: "address" },
          { name: "asset", type: "address" },
          { name: "recipient", type: "address" },
          { name: "amount", type: "uint256" },
          // Types match the Solidity struct exactly (verified against NaveExecution.sol
          // and the synced NaveExecution.json Foundry artifact):
          { name: "reviewEnd", type: "uint256" },   // was uint64 — ABI mismatch fix (2E)
          { name: "reviewWindow", type: "int64" },   // was uint64 — ABI mismatch fix (2E)
          { name: "withdrawnAmount", type: "uint256" },
          { name: "txPayloadHash", type: "bytes32" },
          { name: "executiveReasoningHash", type: "bytes32" },
          { name: "financialReasoningHash", type: "bytes32" },
          { name: "oversightReasoningHash", type: "bytes32" },
          { name: "operationalHaltReasonHash", type: "bytes32" },
          { name: "createdAt", type: "uint256" },   // was uint64 — ABI mismatch fix (2E)
          { name: "updatedAt", type: "uint256" },   // was uint64 — ABI mismatch fix (2E)
          { name: "executedAt", type: "uint256" },  // was uint64 — ABI mismatch fix (2E)
        ],
      },
    ],
  },
] as const;

export const EVM_STATUS_NAMES = [
  "Pending",
  "ExecutiveApproved",
  "FinancialApproved",
  "OversightApproved",
  "InReview",
  "Executed",
  "Halted",
  "Expired",
] as const;

export interface EvmOnChainRequest {
  status: string;
  reviewEnd: number;
  protocolProgram: string;
  mint: string;
  amount: number;
  payloadHash: string;
  executionAddress: string;
  index: number;
}

export interface EvmAgentGateView {
  frozen: boolean;
  agentsEnabled: boolean;
}

/** `NaveTreasury.position(adapter)` — mirrors Solana's StrategyPosition PDA. */
const NAVE_TREASURY_POSITION_ABI = [
  {
    type: "function",
    name: "position",
    stateMutability: "view",
    inputs: [{ name: "adapter", type: "address" }],
    outputs: [
      { name: "asset", type: "address" },
      { name: "depositedAmount", type: "uint256" },
      { name: "currentValue", type: "uint256" },
    ],
  },
] as const;

export interface EvmPositionAccounting {
  /** Principal deployed into the adapter (base units). */
  depositedBaseUnits: number;
  /** Latest oracle-marked position value (base units). */
  currentValueBaseUnits: number;
}

function clientFor(chainId: number) {
  const cfg = EVM_RPC_CONFIG[chainId];
  if (!cfg) return null;
  const rpcUrl = evmRpcUrlFor(chainId);
  if (!rpcUrl) return null;
  return createPublicClient({ chain: cfg.chain as Chain, transport: http(rpcUrl) });
}

/** Synthetic ER key used in logs: `<execution>#<index>`. */
export function evmErKey(execution: string, index: number): string {
  return `${execution.toLowerCase()}#${index}`;
}

export function parseEvmErKey(key: string): { execution: string; index: number } | null {
  const i = key.lastIndexOf("#");
  if (i <= 0) return null;
  const execution = key.slice(0, i).toLowerCase();
  const index = Number(key.slice(i + 1));
  if (!/^0x[0-9a-f]{40}$/.test(execution) || !Number.isFinite(index) || index < 0) return null;
  return { execution, index };
}

export function isEvmErKey(key: string): boolean {
  return parseEvmErKey(key) != null;
}

export async function resolveEvmExecutionAddress(
  chainId: number,
  treasury: string,
): Promise<string | null> {
  const client = clientFor(chainId);
  if (!client) return null;
  try {
    const execution = (await client.readContract({
      address: treasury as `0x${string}`,
      abi: NAVE_TREASURY_ABI,
      functionName: "execution",
    })) as string;
    return typeof execution === "string" ? execution.toLowerCase() : null;
  } catch {
    return null;
  }
}

export async function readEvmAgentGate(
  chainId: number,
  treasury: string,
): Promise<EvmAgentGateView | null> {
  const client = clientFor(chainId);
  if (!client) return null;
  try {
    const t = { address: treasury as `0x${string}`, abi: NAVE_TREASURY_ABI } as const;
    const [frozen, agentsEnabled] = await Promise.all([
      client.readContract({ ...t, functionName: "frozen" }) as Promise<boolean>,
      client.readContract({ ...t, functionName: "agentsEnabled" }) as Promise<boolean>,
    ]);
    return { frozen: Boolean(frozen), agentsEnabled: Boolean(agentsEnabled) };
  } catch {
    return null;
  }
}

export async function readEvmExecutionRequest(
  chainId: number,
  treasury: string,
  index: number,
): Promise<EvmOnChainRequest | null> {
  const client = clientFor(chainId);
  if (!client) return null;
  try {
    const execution = await resolveEvmExecutionAddress(chainId, treasury);
    if (!execution) return null;
    const r = (await client.readContract({
      address: execution as `0x${string}`,
      abi: NAVE_EXECUTION_ABI,
      functionName: "getRequest",
      args: [BigInt(index)],
    })) as Record<string, unknown>;
    if (!r?.exists) return null;
    const statusByte = Number(r.status ?? 0);
    const payloadHash = String(r.txPayloadHash ?? "0x").replace(/^0x/i, "");
    return {
      status: EVM_STATUS_NAMES[statusByte] ?? `Unknown(${statusByte})`,
      reviewEnd: Number(r.reviewEnd ?? 0),
      protocolProgram: String(r.adapter ?? "").toLowerCase(),
      mint: String(r.asset ?? "").toLowerCase(),
      amount: Number(r.amount ?? 0),
      payloadHash,
      executionAddress: execution,
      index,
    };
  } catch {
    return null;
  }
}

/**
 * Read the (adapter-keyed) strategy position the position oracle refreshes,
 * decoding both the deposited principal and the current marked value so the
 * compound cycle can reason about realized yield. Mirrors Solana's
 * `readPositionAccounting` (StrategyPosition PDA), but keyed by adapter
 * address instead of a `protocol_id` string — EVM has no PDA derivation, the
 * treasury's `_positions` mapping is keyed directly by adapter.
 * Returns null when the treasury/chain is unreadable (fail-safe: no compound).
 */
export async function readEvmPositionAccounting(
  chainId: number,
  treasury: string,
  adapter: string,
): Promise<EvmPositionAccounting | null> {
  const client = clientFor(chainId);
  if (!client) return null;
  try {
    const r = (await client.readContract({
      address: treasury as `0x${string}`,
      abi: NAVE_TREASURY_POSITION_ABI,
      functionName: "position",
      args: [adapter as `0x${string}`],
    })) as readonly [string, bigint, bigint];
    return {
      depositedBaseUnits: Number(r[1]),
      currentValueBaseUnits: Number(r[2]),
    };
  } catch {
    return null;
  }
}

/** Scan recent proposal indices for existing, non-terminal execution requests. */
export async function enumerateEvmExecutionIndices(
  chainId: number,
  treasury: string,
  maxScan = 25,
): Promise<number[]> {
  const client = clientFor(chainId);
  if (!client) return [];
  try {
    const execution = await resolveEvmExecutionAddress(chainId, treasury);
    if (!execution) return [];
    const count = Number(
      await client.readContract({
        address: treasury as `0x${string}`,
        abi: NAVE_TREASURY_ABI,
        functionName: "proposalCount",
      }) as bigint,
    );
    if (!Number.isFinite(count) || count <= 0) return [];
    const start = Math.max(0, count - maxScan);
    const indices: number[] = [];
    for (let i = start; i < count; i++) {
      const r = (await client.readContract({
        address: execution as `0x${string}`,
        abi: NAVE_EXECUTION_ABI,
        functionName: "getRequest",
        args: [BigInt(i)],
      })) as { exists?: boolean; status?: number };
      if (!r?.exists) continue;
      const status = EVM_STATUS_NAMES[Number(r.status ?? 0)] ?? "";
      if (status === "Executed" || status === "Expired") continue;
      indices.push(i);
    }
    return indices;
  } catch {
    return [];
  }
}

/** Pull uint64 index hints from indexer raw_data blobs. */
export function extractEvmIndexFromRaw(raw: Record<string, unknown> | null): number | null {
  if (!raw) return null;
  const candidates = [raw.index, raw.proposalIndex, raw.proposal_index, raw.request_index];
  for (const v of candidates) {
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
    if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
    if (typeof v === "bigint") return Number(v);
  }
  return null;
}
