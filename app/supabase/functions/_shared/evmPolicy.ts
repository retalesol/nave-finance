// EVM constitution + position reader for Base, Robinhood, and Ethereum treasuries.
//
// policy-evaluator used to derive Solana PDAs for every DAO. A treasury created
// on Base or Robinhood has no nave_core account, so that read returned null and
// the policy loop skipped it. This module reads the same fields from
// NaveTreasury (policy bps, approved adapters, NAV, per-adapter positions).
// Solana DAOs stay on `_shared/onchain.ts`.

import { createPublicClient, http, type Address } from "npm:viem@2.21.55";
import { EVM_RPC_CONFIG, evmRpcUrlFor } from "./evmFounder.ts";
import type { ApprovedProtocol, ConstitutionView, PositionView, VaultView } from "./onchain.ts";

const TREASURY_POLICY_ABI = [
  {
    type: "function",
    name: "policyBps",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "minStableReserveBps", type: "uint16" },
      { name: "maxTotalDeployedBps_", type: "uint16" },
      { name: "minLiquidityBps_", type: "uint16" },
    ],
  },
  {
    type: "function",
    name: "confidenceThreshold",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
  {
    type: "function",
    name: "rebalanceFrequencySecs",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "int64" }],
  },
  {
    type: "function",
    name: "lastRebalanceAt",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "int64" }],
  },
  {
    type: "function",
    name: "getApprovedAdapters",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "adapters", type: "address[]" },
      { name: "maxAllocationBps", type: "uint16[]" },
      { name: "approved", type: "bool[]" },
      { name: "protocolIds", type: "string[]" },
    ],
  },
  {
    type: "function",
    name: "currentNav",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "deployedCapital",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "lastRevaluedAt",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
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

const ZERO = "0x0000000000000000000000000000000000000000";

function asAddress(dao: string): Address | null {
  return /^0x[0-9a-fA-F]{40}$/.test(dao) ? (dao as Address) : null;
}

function safeNum(v: bigint): number | null {
  if (v < 0n || v > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(v);
}

function clientFor(chainId: number) {
  const cfg = EVM_RPC_CONFIG[chainId];
  const rpcUrl = evmRpcUrlFor(chainId);
  if (!cfg || !rpcUrl) return null;
  return createPublicClient({ chain: cfg.chain, transport: http(rpcUrl) });
}

/** True for DAO rows whose constitution lives on an EVM treasury clone. */
export function isEvmPolicyChain(chain: string | null | undefined): boolean {
  const c = (chain ?? "").toLowerCase();
  return c === "base" || c === "robinhood" || c === "ethereum";
}

export async function readEvmConstitution(
  chainId: number,
  dao: string,
): Promise<ConstitutionView | null> {
  const treasury = asAddress(dao);
  const client = clientFor(chainId);
  if (!treasury || !client) return null;
  try {
    const [policy, confidence, freq, last, adapters] = await Promise.all([
      client.readContract({ address: treasury, abi: TREASURY_POLICY_ABI, functionName: "policyBps" }),
      client.readContract({ address: treasury, abi: TREASURY_POLICY_ABI, functionName: "confidenceThreshold" }),
      client.readContract({ address: treasury, abi: TREASURY_POLICY_ABI, functionName: "rebalanceFrequencySecs" }),
      client.readContract({ address: treasury, abi: TREASURY_POLICY_ABI, functionName: "lastRebalanceAt" }),
      client.readContract({ address: treasury, abi: TREASURY_POLICY_ABI, functionName: "getApprovedAdapters" }),
    ]);
    const [adapterAddrs, maxBps, approved, protocolIds] = adapters;
    const approvedProtocols: ApprovedProtocol[] = adapterAddrs
      .map((adapter, i) => ({
        protocolId: protocolIds[i] || adapter,
        programId: adapter,
        maxAllocationBps: Number(maxBps[i] ?? 0),
        approved: Boolean(approved[i]),
      }))
      .filter((p) => p.programId.toLowerCase() !== ZERO);
    const freqN = safeNum(BigInt(freq));
    const lastN = safeNum(BigInt(last));
    if (freqN == null || lastN == null) return null;
    return {
      approvedProtocols,
      confidenceThreshold: Number(confidence),
      minStablecoinReserveBps: Number(policy[0]),
      maxTotalDeployedBps: Number(policy[1]),
      minLiquidityBps: Number(policy[2]),
      rebalanceFrequencySecs: freqN,
      lastRebalanceAt: lastN,
    };
  } catch (e) {
    console.error("[evmPolicy] constitution read failed", dao, chainId, e instanceof Error ? e.message : e);
    return null;
  }
}

export async function readEvmTreasuryVault(
  chainId: number,
  dao: string,
): Promise<VaultView | null> {
  const treasury = asAddress(dao);
  const client = clientFor(chainId);
  if (!treasury || !client) return null;
  try {
    const [nav, deployed, revalued] = await Promise.all([
      client.readContract({ address: treasury, abi: TREASURY_POLICY_ABI, functionName: "currentNav" }),
      client.readContract({ address: treasury, abi: TREASURY_POLICY_ABI, functionName: "deployedCapital" }),
      client.readContract({ address: treasury, abi: TREASURY_POLICY_ABI, functionName: "lastRevaluedAt" }),
    ]);
    const navN = safeNum(nav);
    const deployedN = safeNum(deployed);
    const revaluedN = safeNum(revalued);
    if (navN == null || deployedN == null || revaluedN == null) return null;
    return {
      navBaseUnits: navN,
      deployedBaseUnits: deployedN,
      navLastRevaluedAt: revaluedN,
    };
  } catch (e) {
    console.error("[evmPolicy] vault read failed", dao, chainId, e instanceof Error ? e.message : e);
    return null;
  }
}

/** One position per approved adapter. `currentValue` is the on-chain mark. */
export async function readEvmStrategyPositions(
  chainId: number,
  dao: string,
  protocols: Array<{ protocolId: string; programId: string }>,
): Promise<PositionView[]> {
  const treasury = asAddress(dao);
  const client = clientFor(chainId);
  if (!treasury || !client) {
    return protocols.map((p) => ({ protocolId: p.protocolId, currentValueBaseUnits: 0, mint: null }));
  }
  const out: PositionView[] = [];
  for (const p of protocols) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(p.programId) || p.programId.toLowerCase() === ZERO) {
      out.push({ protocolId: p.protocolId, currentValueBaseUnits: 0, mint: null });
      continue;
    }
    try {
      const pos = await client.readContract({
        address: treasury,
        abi: TREASURY_POLICY_ABI,
        functionName: "position",
        args: [p.programId as Address],
      });
      const value = safeNum(pos[2]);
      const asset = pos[0];
      out.push({
        protocolId: p.protocolId,
        currentValueBaseUnits: value ?? 0,
        mint: asset && asset.toLowerCase() !== ZERO ? asset : null,
      });
    } catch {
      out.push({ protocolId: p.protocolId, currentValueBaseUnits: 0, mint: null });
    }
  }
  return out;
}
