import test from 'node:test';
import assert from 'node:assert/strict';
import { NonceTooLowError, TransactionExecutionError } from 'viem';
import {
  isNonceTooLowError,
  pendingTransactionCountRequest,
  sendWithPendingNonceRetry,
} from '../../src/lib/evm/pendingNonceRetry';

const FROM = '0x0000000000000000000000000000000000000001' as const;

test('pending nonce count uses the pending tag', () => {
  const request = pendingTransactionCountRequest(FROM);
  assert.equal(request.address, FROM);
  assert.equal(request.blockTag, 'pending');
});

test('a successful send does not read or override the nonce', async () => {
  let reads = 0;
  const nonces: Array<number | undefined> = [];
  const hash = await sendWithPendingNonceRetry({
    chainId: 11155111,
    address: FROM,
    readPendingNonce: async () => {
      reads += 1;
      return 4;
    },
    send: async (nonce) => {
      nonces.push(nonce);
      return '0xok';
    },
  });
  assert.equal(hash, '0xok');
  assert.equal(reads, 0);
  assert.deepEqual(nonces, [undefined]);
});

test('a wrapped nonce-too-low retries once with the pending nonce', async () => {
  const wrapped = new TransactionExecutionError(new NonceTooLowError({ nonce: 4 }), {
    chain: { id: 11155111 },
  });
  assert.equal(isNonceTooLowError(wrapped), true);
  const nonces: Array<number | undefined> = [];
  const reads: Array<{ chainId: number; address: string }> = [];
  const hash = await sendWithPendingNonceRetry({
    chainId: 11155111,
    address: FROM,
    readPendingNonce: async (chainId, address) => {
      reads.push({ chainId, address });
      return 8;
    },
    send: async (nonce) => {
      nonces.push(nonce);
      if (nonces.length === 1) throw wrapped;
      return '0xretry';
    },
  });
  assert.equal(hash, '0xretry');
  assert.deepEqual(nonces, [undefined, 8]);
  assert.deepEqual(reads, [{ chainId: 11155111, address: FROM }]);
});

test('a plain nonce-too-low message retries once and a second failure stops', async () => {
  let reads = 0;
  let sends = 0;
  await assert.rejects(
    () => sendWithPendingNonceRetry({
      chainId: 11155111,
      address: FROM,
      readPendingNonce: async () => {
        reads += 1;
        return 9;
      },
      send: async () => {
        sends += 1;
        throw new Error('nonce too low: next nonce 9, tx nonce 4');
      },
    }),
    /nonce too low/,
  );
  assert.equal(sends, 2);
  assert.equal(reads, 1);
});

test('an already-known broadcast is not treated as a stale nonce', async () => {
  const err = new NonceTooLowError({
    cause: Object.assign(new Error('already known'), { details: 'already known' }),
  });
  assert.equal(isNonceTooLowError(err), false);
  let reads = 0;
  let sends = 0;
  await assert.rejects(
    () => sendWithPendingNonceRetry({
      chainId: 11155111,
      address: FROM,
      readPendingNonce: async () => {
        reads += 1;
        return 3;
      },
      send: async () => {
        sends += 1;
        throw err;
      },
    }),
    (caught: unknown) => caught === err,
  );
  assert.equal(sends, 1);
  assert.equal(reads, 0);
});

test('other send errors are not retried', async () => {
  let reads = 0;
  await assert.rejects(
    () => sendWithPendingNonceRetry({
      chainId: 84532,
      address: FROM,
      readPendingNonce: async () => {
        reads += 1;
        return 1;
      },
      send: async () => {
        throw new Error('insufficient funds');
      },
    }),
    /insufficient funds/,
  );
  assert.equal(reads, 0);
});
