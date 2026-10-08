import * as anchor from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  sendAndConfirmTransaction,
  type Signer,
  type Transaction,
} from "@solana/web3.js";

/** HTTP-only RPCs (e.g. Alchemy) need an explicit ws endpoint for signatureSubscribe. */
export function deriveWsEndpoint(httpRpc: string): string {
  const fromEnv = process.env.SOLANA_DEVNET_WS || process.env.ANCHOR_WS_URL;
  if (fromEnv?.trim()) return fromEnv.trim();
  if (httpRpc.startsWith("https://")) return `wss://${httpRpc.slice("https://".length)}`;
  if (httpRpc.startsWith("http://")) return `ws://${httpRpc.slice("http://".length)}`;
  return httpRpc;
}

/** Poll getSignatureStatuses — works on HTTP-only RPCs without signatureSubscribe. */
export async function confirmSignaturePolling(
  connection: Connection,
  signature: string,
  timeoutMs = 120_000
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { value } = await connection.getSignatureStatuses([signature], {
      searchTransactionHistory: true,
    });
    const status = value[0];
    if (status?.err) {
      throw new Error(`Transaction ${signature} failed: ${JSON.stringify(status.err)}`);
    }
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Transaction ${signature} timed out after ${timeoutMs}ms`);
}

let pollingConfirmInstalled = false;

export function installDevnetPollingConfirm(): void {
  if (pollingConfirmInstalled) return;
  pollingConfirmInstalled = true;

  const original = Connection.prototype.confirmTransaction;
  Connection.prototype.confirmTransaction = async function patchedConfirmTransaction(
    this: Connection,
    strategy: unknown,
    commitment?: string
  ) {
    let sig: string | undefined;
    if (typeof strategy === "string") {
      sig = strategy;
    } else if (strategy && typeof strategy === "object") {
      const s = strategy as { signature?: string };
      if (typeof s.signature === "string") sig = s.signature;
    }
    if (sig) {
      await confirmSignaturePolling(this, sig);
      return { context: { slot: 0 }, value: { err: null } };
    }
    return original.call(this, strategy as never, commitment as never);
  };
}

export function patchConnectionPollingConfirm(connection: Connection): void {
  installDevnetPollingConfirm();
  void connection;
}

export function patchProviderPollingConfirm(provider: anchor.AnchorProvider): void {
  patchConnectionPollingConfirm(provider.connection);
}

export function createDevnetConnection(rpc?: string): Connection {
  installDevnetPollingConfirm();
  const url = rpc || process.env.RPC || process.env.ANCHOR_PROVIDER_URL || "https://api.devnet.solana.com";
  const connection = new Connection(url, {
    commitment: "confirmed",
    wsEndpoint: deriveWsEndpoint(url),
    confirmTransactionInitialTimeout: 120_000,
  });
  patchConnectionPollingConfirm(connection);
  return connection;
}

export function createDevnetProvider(
  founder: Keypair,
  rpc?: string
): anchor.AnchorProvider {
  const connection = createDevnetConnection(rpc);
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(founder), {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
    confirmTransactionInitialTimeout: 120_000,
  });
  patchProviderPollingConfirm(provider);
  return provider;
}

/** Drop-in for @solana/web3.js sendAndConfirmTransaction on HTTP-only RPCs. */
export async function sendAndConfirmPolling(
  connection: Connection,
  transaction: Transaction,
  signers: Signer[],
  options?: Parameters<typeof sendAndConfirmTransaction>[3]
): Promise<string> {
  const sig = await connection.sendTransaction(transaction, signers, options);
  await confirmSignaturePolling(connection, sig);
  return sig;
}
