// Talks to a deployed GenLayer contract. Reads use the contract view methods.
// Writes use open_case, review_venue, and open_appeal. Nothing here invents a verdict.

import type { ReviewKind } from "./genlayerCharter.ts";

export interface GenLayerSession {
  read(kind: ReviewKind, functionName: string, args: string[]): Promise<unknown>;
  write(kind: ReviewKind, functionName: string, args: string[]): Promise<string>;
  status(txId: string): Promise<{ status: string; executionResult: string }>;
}

function envGet(name: string): string {
  try {
    const g = globalThis as { Deno?: { env: { get(key: string): string | undefined } } };
    return g.Deno?.env.get(name) ?? "";
  } catch {
    return "";
  }
}

function signerKey(raw: string): `0x${string}` | null {
  const text = raw.trim();
  const hex = text.startsWith("0x") ? text : `0x${text}`;
  return /^0x[0-9a-fA-F]{64}$/.test(hex) ? hex as `0x${string}` : null;
}

function address(raw: string): `0x${string}` | null {
  const text = raw.trim();
  return /^0x[0-9a-fA-F]{40}$/.test(text) ? text as `0x${string}` : null;
}

interface ChainDescriptor {
  id: number;
  name: string;
  rpcUrls: { default: { http: readonly string[] } };
  nativeCurrency: { name: string; symbol: string; decimals: number };
  blockExplorers?: { default: { name: string; url: string } };
}

interface ChainModule {
  testnetBradbury: ChainDescriptor;
  testnetAsimov: ChainDescriptor;
  studionet: ChainDescriptor;
  localnet: ChainDescriptor;
}

function pickChain(rpc: string, chains: ChainModule) {
  const url = rpc.toLowerCase();
  if (url.includes("asimov")) return chains.testnetAsimov;
  if (url.includes("studio.genlayer.com")) return chains.studionet;
  if (url.includes("localhost") || url.includes("127.0.0.1")) return chains.localnet;
  return chains.testnetBradbury;
}

/** Prefer the SDK name. An unnamed numeric status stays as its code. */
function receiptLabel(name: unknown, code: unknown): string {
  if (typeof name === "string" && name.trim()) return name;
  if (typeof code === "number" && Number.isFinite(code)) return String(code);
  if (typeof code === "string" && code.trim()) return code;
  return "";
}

function txIdOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const id = obj.hash ?? obj.txId ?? obj.tx_id ?? obj.transaction_hash;
    if (typeof id === "string") return id;
  }
  return "";
}

/**
 * A session exists only when the RPC, the signer key, and all three contract
 * addresses are set. Otherwise the product records nothing and signs as before.
 */
export async function createGenLayerSession(): Promise<GenLayerSession | null> {
  const rpc = envGet("NAVE_GENLAYER_RPC_URL");
  const key = signerKey(envGet("NAVE_GENLAYER_SIGNER_KEY"));
  const charter = address(envGet("NAVE_GENLAYER_CHARTER_ADDRESS"));
  const venue = address(envGet("NAVE_GENLAYER_VENUE_ADDRESS"));
  const halt = address(envGet("NAVE_GENLAYER_HALT_ADDRESS"));
  if (!rpc || !key || !charter || !venue || !halt) return null;

  const sdk = await import("npm:genlayer-js@2.0.0-rc.2");
  const chains = await import("npm:genlayer-js@2.0.0-rc.2/chains") as ChainModule;
  const account = sdk.createAccount(key);
  const client = sdk.createClient({
    chain: pickChain(rpc, chains),
    account,
    endpoint: rpc,
  });
  const addresses: Record<ReviewKind, `0x${string}`> = { charter, venue, halt };
  // Phase 2 rejects a zero fee. This is the distribution that deployed the
  // three contracts. The SDK quotes feeValue from FeeManager. The contract
  // still receives user value 0.
  const fees = {
    distribution: {
      leaderTimeunitsAllocation: 100n,
      validatorTimeunitsAllocation: 200n,
      appealRounds: 0n,
      executionBudgetPerRound: 25000000000000000n,
      executionConsumed: 0n,
      totalMessageFees: 0n,
      rotations: [3n],
      maxPriceGenPerTimeUnit: 2n,
      storageFeeMaxGasPrice: 300000000n,
      receiptFeeMaxGasPrice: 300000000n,
    },
  };

  return {
    async read(kind, functionName, args) {
      return await client.readContract({
        address: addresses[kind],
        functionName,
        args,
        jsonSafeReturn: true,
      });
    },
    async write(kind, functionName, args) {
      const tx = await client.writeContract({
        address: addresses[kind],
        functionName,
        args,
        value: 0n,
        fees,
      });
      const id = txIdOf(tx);
      if (!id) throw new Error("GenLayer did not return a transaction id");
      return id;
    },
    async status(txId) {
      const tx = await client.getTransaction({ hash: txId as (`0x${string}` & { length: 66 }) });
      return { status: receiptLabel(tx?.statusName, tx?.status), executionResult: receiptLabel(tx?.txExecutionResultName, tx?.txExecutionResult) };
    },
  };
}
