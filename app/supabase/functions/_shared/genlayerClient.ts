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

interface ChainModule {
  testnetBradbury: { id: number; rpcUrls: { default: { http: readonly string[] } } };
  testnetAsimov: { id: number; rpcUrls: { default: { http: readonly string[] } } };
  studionet: { id: number; rpcUrls: { default: { http: readonly string[] } } };
  localnet: { id: number; rpcUrls: { default: { http: readonly string[] } } };
}

function pickChain(rpc: string, chains: ChainModule) {
  const url = rpc.toLowerCase();
  if (url.includes("asimov")) return chains.testnetAsimov;
  if (url.includes("studio.genlayer.com")) return chains.studionet;
  if (url.includes("localhost") || url.includes("127.0.0.1")) return chains.localnet;
  return chains.testnetBradbury;
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

  const sdk = await import("npm:genlayer-js@1.1.8");
  const chains = await import("npm:genlayer-js@1.1.8/chains") as ChainModule;
  const account = sdk.createAccount(key);
  const client = sdk.createClient({
    chain: pickChain(rpc, chains),
    account,
    endpoint: rpc,
  });
  const addresses: Record<ReviewKind, `0x${string}`> = { charter, venue, halt };

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
      });
      const id = txIdOf(tx);
      if (!id) throw new Error("GenLayer did not return a transaction id");
      return id;
    },
    async status(txId) {
      const tx = await client.getTransaction({ hash: txId as `0x${string}` });
      const status = typeof tx?.statusName === "string" ? tx.statusName : "";
      const executionResult = typeof tx?.txExecutionResultName === "string" ? tx.txExecutionResultName : "";
      return { status, executionResult };
    },
  };
}
