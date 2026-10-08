// ─── Bridge source-tx confirmation helpers ─────────────────────────────────────
// Client-side polling mirrors the relayer's reorg/finality guards so we don't
// surface a scary "failed" state while the source lock/burn is still maturing.

import type { Connection } from '@solana/web3.js';
import type { Hash, PublicClient } from 'viem';

export interface ConfirmationProgress {
  current: number;
  required: number;
  ready: boolean;
}

/** True when a relayer error means "try again shortly", not a hard failure. */
export function isConfirmationWaitError(error?: string): boolean {
  if (!error) return false;
  return (
    /\bconfirmations?; need \d+ before releasing\b/i.test(error) ||
    /not found or not finalized/i.test(error)
  );
}

/** Parse "has N confirmations; need M" from a relayer error string. */
export function parseConfirmationProgress(
  error?: string,
): Pick<ConfirmationProgress, 'current' | 'required'> | null {
  const match = error?.match(/has (\d+) confirmations?; need (\d+)/i);
  if (!match) return null;
  return { current: Number(match[1]), required: Number(match[2]) };
}

/** EVM burn depth — must match signer-service BRIDGE_EVM_CONFIRMATIONS (default 5). */
export async function getEvmBurnConfirmationProgress(
  publicClient: PublicClient,
  txHash: Hash,
  required: number,
): Promise<ConfirmationProgress> {
  try {
    const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
    if (receipt.status !== 'success') {
      return { current: 0, required, ready: false };
    }
    const latest = await publicClient.getBlockNumber();
    const current =
      latest >= receipt.blockNumber ? Number(latest - receipt.blockNumber + 1n) : 0;
    return { current, required, ready: current >= required };
  } catch {
    return { current: 0, required, ready: false };
  }
}

/** Solana lock finality — relayer reads the lock tx at `finalized` commitment. */
export async function getSolanaLockConfirmationProgress(
  connection: Connection,
  signature: string,
): Promise<ConfirmationProgress> {
  const required = 1;
  try {
    const res = await connection.getSignatureStatuses([signature], {
      searchTransactionHistory: true,
    });
    const status = res.value[0];
    if (!status || status.err) {
      return { current: 0, required, ready: false };
    }
    const finalized = status.confirmationStatus === 'finalized';
    return { current: finalized ? 1 : 0, required, ready: finalized };
  } catch {
    return { current: 0, required, ready: false };
  }
}
