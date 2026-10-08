// Client-side confirmation polling mirrors the relayer's finality guards so the
// UI shows "confirming" (not a scary "failed") while a lock/burn matures, and
// recognizes the relayer's retryable "need N confirmations" / "not finalized"
// errors — the basis of the pending-relay + retry path in useBridge.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isConfirmationWaitError,
  parseConfirmationProgress,
  getEvmBurnConfirmationProgress,
  getSolanaLockConfirmationProgress,
} from '../../src/lib/bridge/confirmations';

test('isConfirmationWaitError: recognizes retryable maturing-source errors', () => {
  assert.equal(isConfirmationWaitError('tx has 2 confirmations; need 5 before releasing'), true);
  assert.equal(isConfirmationWaitError('source tx not found or not finalized yet'), true);
  assert.equal(isConfirmationWaitError('insufficient balance in custody'), false);
  assert.equal(isConfirmationWaitError(undefined), false);
});

test('parseConfirmationProgress: extracts current/required depth from the error', () => {
  assert.deepEqual(parseConfirmationProgress('has 3 confirmations; need 5'), { current: 3, required: 5 });
  assert.deepEqual(parseConfirmationProgress('has 1 confirmation; need 5'), { current: 1, required: 5 });
  assert.equal(parseConfirmationProgress('unrelated error'), null);
});

test('getEvmBurnConfirmationProgress: ready only once depth >= required', async () => {
  // receipt at block 100, latest 104 → depth = 104-100+1 = 5 confirmations.
  const client = {
    async getTransactionReceipt() {
      return { status: 'success', blockNumber: 100n };
    },
    async getBlockNumber() {
      return 104n;
    },
  };
  const progress = await getEvmBurnConfirmationProgress(client as never, '0xhash' as never, 5);
  assert.deepEqual(progress, { current: 5, required: 5, ready: true });
});

test('getEvmBurnConfirmationProgress: not ready while still shallow', async () => {
  const client = {
    async getTransactionReceipt() {
      return { status: 'success', blockNumber: 100n };
    },
    async getBlockNumber() {
      return 101n; // depth = 2
    },
  };
  const progress = await getEvmBurnConfirmationProgress(client as never, '0xhash' as never, 5);
  assert.deepEqual(progress, { current: 2, required: 5, ready: false });
});

test('getEvmBurnConfirmationProgress: a reverted burn is never ready', async () => {
  const client = {
    async getTransactionReceipt() {
      return { status: 'reverted', blockNumber: 100n };
    },
    async getBlockNumber() {
      return 200n;
    },
  };
  const progress = await getEvmBurnConfirmationProgress(client as never, '0xhash' as never, 5);
  assert.deepEqual(progress, { current: 0, required: 5, ready: false });
});

test('getEvmBurnConfirmationProgress: an RPC error resolves to not-ready (no throw)', async () => {
  const client = {
    async getTransactionReceipt() {
      throw new Error('receipt not found');
    },
    async getBlockNumber() {
      return 200n;
    },
  };
  const progress = await getEvmBurnConfirmationProgress(client as never, '0xhash' as never, 5);
  assert.deepEqual(progress, { current: 0, required: 5, ready: false });
});

test('getSolanaLockConfirmationProgress: ready only at finalized commitment', async () => {
  const finalized = {
    async getSignatureStatuses() {
      return { value: [{ err: null, confirmationStatus: 'finalized' }] };
    },
  };
  assert.deepEqual(await getSolanaLockConfirmationProgress(finalized as never, 'sig'), {
    current: 1,
    required: 1,
    ready: true,
  });

  const confirmed = {
    async getSignatureStatuses() {
      return { value: [{ err: null, confirmationStatus: 'confirmed' }] };
    },
  };
  assert.deepEqual(await getSolanaLockConfirmationProgress(confirmed as never, 'sig'), {
    current: 0,
    required: 1,
    ready: false,
  });
});

test('getSolanaLockConfirmationProgress: an errored/missing status is not ready', async () => {
  const errored = {
    async getSignatureStatuses() {
      return { value: [{ err: { InstructionError: [] }, confirmationStatus: 'finalized' }] };
    },
  };
  assert.equal((await getSolanaLockConfirmationProgress(errored as never, 'sig')).ready, false);

  const missing = {
    async getSignatureStatuses() {
      return { value: [null] };
    },
  };
  assert.equal((await getSolanaLockConfirmationProgress(missing as never, 'sig')).ready, false);
});
