import { Connection } from "@solana/web3.js";

let installed = false;

function deriveWsEndpoint(httpRpc) {
  if (httpRpc.startsWith("https://")) return `wss://${httpRpc.slice("https://".length)}`;
  if (httpRpc.startsWith("http://")) return `ws://${httpRpc.slice("http://".length)}`;
  return httpRpc;
}

async function confirmSignaturePolling(connection, signature, timeoutMs = 120_000) {
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

export function installPollingConfirm() {
  if (installed) return;
  installed = true;
  const original = Connection.prototype.confirmTransaction;
  Connection.prototype.confirmTransaction = async function patchedConfirmTransaction(strategy, commitment) {
    let sig;
    if (typeof strategy === "string") sig = strategy;
    else if (strategy && typeof strategy === "object" && typeof strategy.signature === "string") {
      sig = strategy.signature;
    }
    if (sig) {
      await confirmSignaturePolling(this, sig);
      return { context: { slot: 0 }, value: { err: null } };
    }
    return original.call(this, strategy, commitment);
  };
}

export function createPosterConnection(rpc) {
  installPollingConfirm();
  return new Connection(rpc, {
    commitment: "confirmed",
    wsEndpoint: deriveWsEndpoint(rpc),
    confirmTransactionInitialTimeout: 120_000,
  });
}
