import type { Address } from 'viem';
import type { EvmChainId } from '../chain/types';

const NONCE_TOO_LOW = /nonce too low/i;
const ALREADY_IN_POOL = /already known|transaction already imported/i;

/**
 * True for a nonce the node has already consumed.
 * "already known" is a duplicate broadcast, not a stale nonce, so it does not match.
 */
export function isNonceTooLowError(err: unknown): boolean {
  const texts: string[] = [];
  let named = false;
  const seen = new Set<unknown>();
  let current: unknown = err;
  for (let depth = 0; depth < 8 && current != null && !seen.has(current); depth += 1) {
    seen.add(current);
    if (typeof current === 'string') {
      texts.push(current);
      break;
    }
    if (typeof current !== 'object') break;
    const obj = current as {
      name?: unknown;
      shortMessage?: unknown;
      details?: unknown;
      message?: unknown;
      cause?: unknown;
      error?: unknown;
    };
    if (obj.name === 'NonceTooLowError') named = true;
    for (const value of [obj.shortMessage, obj.details, obj.message]) {
      if (typeof value === 'string' && value) texts.push(value);
    }
    const next = obj.cause ?? obj.error;
    if (!next || next === current) break;
    current = next;
  }
  const blob = texts.join('\n');
  if (ALREADY_IN_POOL.test(blob) && !NONCE_TOO_LOW.test(blob)) return false;
  if (NONCE_TOO_LOW.test(blob)) return true;
  return named;
}

/**
 * `eth_getTransactionCount` at `pending` counts a tx from this wallet that is
 * still in the pool. `latest` would hand that same nonce out again.
 */
export function pendingTransactionCountRequest(address: Address): {
  address: Address;
  blockTag: 'pending';
} {
  return { address, blockTag: 'pending' };
}

async function readPendingNonce(chainId: EvmChainId, address: Address): Promise<number> {
  const { publicClientForChain } = await import('./readers');
  return publicClientForChain(chainId).getTransactionCount(pendingTransactionCountRequest(address));
}

/**
 * First send lets the wallet pick the nonce. On nonce-too-low, read the pending
 * count from the app RPC and retry exactly once with that nonce.
 */
export async function sendWithPendingNonceRetry<T>(args: {
  chainId: EvmChainId;
  address: Address;
  send: (nonce?: number) => Promise<T>;
  readPendingNonce?: (chainId: EvmChainId, address: Address) => Promise<number>;
}): Promise<T> {
  try {
    return await args.send();
  } catch (err) {
    if (!isNonceTooLowError(err)) throw err;
    const nonce = await (args.readPendingNonce ?? readPendingNonce)(args.chainId, args.address);
    return await args.send(nonce);
  }
}
