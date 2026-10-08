// Relayer client. submitBridgeRelay never throws — every network/non-2xx outcome
// is mapped to { status:'failed', error }. It also normalizes the relayer's
// snake_case aliases (dest_tx/id/fee_raw/net_raw). Boundary: global fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { submitBridgeRelay, fetchBridgeTransferStatus } from '../../src/lib/bridge/relayer';
import { supabase } from '../../src/lib/supabaseClient';
import type { BridgeRelayPayload } from '../../src/lib/bridge/types';

const realFetch = globalThis.fetch;
const realFrom = supabase.from.bind(supabase);

function fakeResponse(init: {
  ok: boolean;
  status?: number;
  statusText?: string;
  body?: unknown;
  nonJson?: boolean;
}) {
  return {
    ok: init.ok,
    status: init.status ?? (init.ok ? 200 : 500),
    statusText: init.statusText ?? '',
    async json() {
      if (init.nonJson) throw new Error('not json');
      return init.body ?? {};
    },
  } as unknown as Response;
}

const payload: BridgeRelayPayload = {
  direction: 'solana_to_evm',
  sourceChain: 'solana',
  destChain: 'ethereum',
  sourceTx: 'sig-abc',
};

test.afterEach(() => {
  globalThis.fetch = realFetch;
  (supabase as unknown as { from: typeof realFrom }).from = realFrom;
});

test('submitBridgeRelay: happy path returns the relayer status + dest tx', async () => {
  let capturedUrl = '';
  let capturedBody = '';
  globalThis.fetch = (async (url: string, opts: RequestInit) => {
    capturedUrl = String(url);
    capturedBody = String(opts.body);
    return fakeResponse({ ok: true, body: { status: 'completed', destTxHash: '0xdead', transferId: 't1' } });
  }) as typeof fetch;

  const res = await submitBridgeRelay(payload);
  assert.equal(res.status, 'completed');
  assert.equal(res.destTxHash, '0xdead');
  assert.equal(res.transferId, 't1');
  assert.match(capturedUrl, /\/bridge-relay$/, 'posts to the /bridge-relay endpoint');
  assert.equal(JSON.parse(capturedBody).sourceTx, 'sig-abc', 'source tx is forwarded');
});

test('submitBridgeRelay: normalizes snake_case aliases (dest_tx/id/fee_raw/net_raw)', async () => {
  globalThis.fetch = (async () =>
    fakeResponse({
      ok: true,
      body: { status: 'submitted', dest_tx: '0xbeef', id: 'row-9', fee_raw: '25000', net_raw: '1000000' },
    })) as typeof fetch;

  const res = await submitBridgeRelay(payload);
  assert.equal(res.destTxHash, '0xbeef');
  assert.equal(res.transferId, 'row-9');
  assert.equal(res.feeRaw, '25000');
  assert.equal(res.netRaw, '1000000');
});

test('submitBridgeRelay: non-2xx maps to a failed status with the server error', async () => {
  globalThis.fetch = (async () =>
    fakeResponse({ ok: false, status: 409, statusText: 'Conflict', body: { error: 'duplicate source_tx' } })) as typeof fetch;

  const res = await submitBridgeRelay(payload);
  assert.equal(res.status, 'failed');
  assert.equal(res.error, 'duplicate source_tx');
});

test('submitBridgeRelay: non-2xx without a JSON body falls back to status text', async () => {
  globalThis.fetch = (async () =>
    fakeResponse({ ok: false, status: 502, statusText: 'Bad Gateway', nonJson: true })) as typeof fetch;

  const res = await submitBridgeRelay(payload);
  assert.equal(res.status, 'failed');
  assert.match(res.error ?? '', /502 Bad Gateway/);
});

test('submitBridgeRelay: a thrown fetch (network down) is caught and returned as failed', async () => {
  globalThis.fetch = (async () => {
    throw new Error('ECONNREFUSED');
  }) as typeof fetch;

  const res = await submitBridgeRelay(payload);
  assert.equal(res.status, 'failed');
  assert.equal(res.error, 'ECONNREFUSED');
});

test('fetchBridgeTransferStatus: maps a bridge_transfers row to a relay response', async () => {
  (supabase as unknown as { from: unknown }).from = () => ({
    select: () => ({
      eq: () => ({
        async maybeSingle() {
          return {
            data: {
              status: 'completed',
              dest_tx: '0xfeed',
              error: null,
              fee_raw: 25000,
              net_raw: 1000000,
            },
            error: null,
          };
        },
      }),
    }),
  });

  const res = await fetchBridgeTransferStatus('sig-abc');
  assert.ok(res);
  assert.equal(res!.status, 'completed');
  assert.equal(res!.destTxHash, '0xfeed');
  assert.equal(res!.feeRaw, '25000');
  assert.equal(res!.netRaw, '1000000');
});

test('fetchBridgeTransferStatus: returns null when the row is absent', async () => {
  (supabase as unknown as { from: unknown }).from = () => ({
    select: () => ({
      eq: () => ({
        async maybeSingle() {
          return { data: null, error: null };
        },
      }),
    }),
  });

  const res = await fetchBridgeTransferStatus('missing');
  assert.equal(res, null);
});
