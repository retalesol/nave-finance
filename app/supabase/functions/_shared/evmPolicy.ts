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
    name: "linkedTreasury",
    stateMutability: "view",
    inputs: [{ name: "destChainId", type: "uint256" }],
    outputs: [{ type: "address" }],
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
  {
    type: "function",
    name: "protocol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "getRegisteredAssets",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "assets", type: "address[]" }],
  },
  {
    type: "function",
    name: "assetInfo",
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [
      { name: "registered", type: "bool" },
      { name: "enabled", type: "bool" },
      { name: "isStablecoin", type: "bool" },
      { name: "assetKind", type: "uint8" },
      { name: "pythFeedId", type: "bytes32" },
      { name: "decimals", type: "uint8" },
    ],
  },
  {
    type: "function",
    name: "idleBalance",
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "valueAssetUsd",
    stateMutability: "view",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "uint256" }],
  },
] as const;

const PROTOCOL_TIER_ABI = [
  {
    type: "function",
    name: "riskTierOf",
    stateMutability: "view",
    inputs: [{ name: "adapter", type: "address" }],
    outputs: [{ type: "uint8" }],
  },
] as const;

const ADAPTER_ASSET_ABI = [
  {
    type: "function",
    name: "supportsAsset",
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [{ type: "bool" }],
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
  return c === "base" || c === "robinhood" || c === "ethereum" || c === "arc";
}

/** Tier per adapter from NaveProtocol.riskTierOf; 1 where the protocol predates tiers. */
async function readRiskTiers(
  client: NonNullable<ReturnType<typeof clientFor>>,
  treasury: Address,
  adapters: readonly Address[],
): Promise<number[]> {
  let protocol: Address;
  try {
    protocol = await client.readContract({ address: treasury, abi: TREASURY_POLICY_ABI, functionName: "protocol" });
  } catch {
    return adapters.map(() => 1);
  }
  return Promise.all(adapters.map(async (adapter) => {
    try {
      const tier = Number(await client.readContract({
        address: protocol,
        abi: PROTOCOL_TIER_ABI,
        functionName: "riskTierOf",
        args: [adapter],
      }));
      return tier >= 1 && tier <= 3 ? tier : 1;
    } catch {
      return 1;
    }
  }));
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
    const tiers = await readRiskTiers(client, treasury, adapterAddrs);
    const approvedProtocols: ApprovedProtocol[] = adapterAddrs
      .map((adapter, i) => ({
        protocolId: protocolIds[i] || adapter,
        programId: adapter,
        maxAllocationBps: Number(maxBps[i] ?? 0),
        riskTier: tiers[i],
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

/** Micro-USD value of `amount` base units, via the treasury's own oracle. */
export async function readEvmValueMicroUsd(
  chainId: number,
  dao: string,
  asset: string,
  amount: number,
): Promise<number | null> {
  const treasury = asAddress(dao);
  const token = asAddress(asset);
  const client = clientFor(chainId);
  if (!treasury || !token || !client || !Number.isSafeInteger(amount) || amount < 0) return null;
  try {
    const valued = await client.readContract({
      address: treasury,
      abi: TREASURY_POLICY_ABI,
      functionName: "valueAssetUsd",
      args: [token, BigInt(amount)],
    });
    return safeNum(valued);
  } catch (e) {
    console.error("[evmPolicy] valueAssetUsd failed", dao, chainId, e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * Idle stablecoin value in micro-USD. `0` means the treasury was read and holds
 * none. `null` means the balances could not be read.
 */
export async function readEvmIdleStableMicroUsd(
  chainId: number,
  dao: string,
): Promise<number | null> {
  const treasury = asAddress(dao);
  const client = clientFor(chainId);
  if (!treasury || !client) return null;
  try {
    const assets = await client.readContract({
      address: treasury,
      abi: TREASURY_POLICY_ABI,
      functionName: "getRegisteredAssets",
    });
    let total = 0n;
    for (const asset of assets) {
      const info = await client.readContract({
        address: treasury,
        abi: TREASURY_POLICY_ABI,
        functionName: "assetInfo",
        args: [asset],
      });
      if (!info[2]) continue;
      const idle = await client.readContract({
        address: treasury,
        abi: TREASURY_POLICY_ABI,
        functionName: "idleBalance",
        args: [asset],
      });
      if (idle === 0n) continue;
      const valued = await client.readContract({
        address: treasury,
        abi: TREASURY_POLICY_ABI,
        functionName: "valueAssetUsd",
        args: [asset, idle],
      });
      total += valued;
    }
    return safeNum(total);
  } catch (e) {
    console.error("[evmPolicy] idle stable read failed", dao, chainId, e instanceof Error ? e.message : e);
    return null;
  }
}

export interface EvmHeldAsset {
  mint: string;
  stable: boolean;
  idleBase: number;
  idleMicroUsd: number;
  /** Adapters (lowercase) whose supportsAsset returned true for this asset. */
  adapters: string[];
}

/** Registered, enabled assets with an idle balance, and the adapters that take each. null when unreadable. */
export async function readEvmHeldAssets(
  chainId: number,
  dao: string,
  adapters: string[],
): Promise<EvmHeldAsset[] | null> {
  const treasury = asAddress(dao);
  const client = clientFor(chainId);
  if (!treasury || !client) return null;
  try {
    const assets = await client.readContract({
      address: treasury,
      abi: TREASURY_POLICY_ABI,
      functionName: "getRegisteredAssets",
    });
    const out: EvmHeldAsset[] = [];
    for (const asset of assets) {
      const info = await client.readContract({
        address: treasury,
        abi: TREASURY_POLICY_ABI,
        functionName: "assetInfo",
        args: [asset],
      });
      if (!info[0] || !info[1]) continue;
      const idle = await client.readContract({
        address: treasury,
        abi: TREASURY_POLICY_ABI,
        functionName: "idleBalance",
        args: [asset],
      });
      if (idle === 0n) continue;
      const valued = await client.readContract({
        address: treasury,
        abi: TREASURY_POLICY_ABI,
        functionName: "valueAssetUsd",
        args: [asset, idle],
      });
      const idleBase = safeNum(idle);
      const idleMicroUsd = safeNum(valued);
      if (idleBase == null || idleMicroUsd == null) continue;
      const takers: string[] = [];
      for (const adapter of adapters) {
        const target = asAddress(adapter);
        if (!target || target.toLowerCase() === ZERO) continue;
        try {
          const ok = await client.readContract({
            address: target,
            abi: ADAPTER_ASSET_ABI,
            functionName: "supportsAsset",
            args: [asset],
          });
          if (ok) takers.push(target.toLowerCase());
        } catch {
          // An adapter without supportsAsset takes nothing here.
        }
      }
      out.push({ mint: asset, stable: Boolean(info[2]), idleBase, idleMicroUsd, adapters: takers });
    }
    return out;
  } catch (e) {
    console.error("[evmPolicy] held asset read failed", dao, chainId, e instanceof Error ? e.message : e);
    return null;
  }
}

/** True when this treasury has linked its own address on `destChainId`. */
export async function readEvmSameAddressLink(
  chainId: number,
  dao: string,
  destChainId: number,
): Promise<boolean> {
  const treasury = asAddress(dao);
  const client = clientFor(chainId);
  if (!treasury || !client || !destChainId) return false;
  try {
    const linked = await client.readContract({
      address: treasury,
      abi: TREASURY_POLICY_ABI,
      functionName: "linkedTreasury",
      args: [BigInt(destChainId)],
    });
    return String(linked).toLowerCase() === treasury.toLowerCase();
  } catch {
    return false;
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
