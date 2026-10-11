import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { encodeAbiParameters, toFunctionSelector } from 'viem';
import { expectedRequestPayloadHash, relayEvmAgentAction } from './evmRelayer.js';

const TREASURY = '0x1111111111111111111111111111111111111111';
const EXECUTION = '0x2222222222222222222222222222222222222222';
const IMPOSTOR = '0x3333333333333333333333333333333333333333';
const ADAPTER = '0x4444444444444444444444444444444444444444';
const ASSET = '0x5555555555555555555555555555555555555555';
const ZERO = '0x0000000000000000000000000000000000000000';
const ZERO32 = `0x${'00'.repeat(32)}` as const;

const EXECUTION_SELECTOR = toFunctionSelector('execution()');
const GET_REQUEST_SELECTOR = toFunctionSelector('getRequest(uint64)');

interface StubRequest {
  exists: boolean;
  kind: number;
  status: number;
  amount: bigint;
  txPayloadHash?: `0x${string}`;
}

let current: StubRequest = { exists: true, kind: 0, status: 0, amount: 1_000_000n };
let server: Server;

function encodeRequest(r: StubRequest): `0x${string}` {
  const hash = r.txPayloadHash
    ?? expectedRequestPayloadHash({ kind: r.kind, adapter: ADAPTER, asset: ASSET, recipient: ZERO, amount: r.amount, destChainId: 0n });
  return encodeAbiParameters(
    [{
      type: 'tuple',
      components: [
        { name: 'exists', type: 'bool' },
        { name: 'kind', type: 'uint8' },
        { name: 'status', type: 'uint8' },
        { name: 'bootstrap', type: 'bool' },
        { name: 'proposalIndex', type: 'uint64' },
        { name: 'adapter', type: 'address' },
        { name: 'asset', type: 'address' },
        { name: 'recipient', type: 'address' },
        { name: 'amount', type: 'uint256' },
        { name: 'reviewEnd', type: 'uint256' },
        { name: 'reviewWindow', type: 'int64' },
        { name: 'withdrawnAmount', type: 'uint256' },
        { name: 'txPayloadHash', type: 'bytes32' },
        { name: 'executiveReasoningHash', type: 'bytes32' },
        { name: 'financialReasoningHash', type: 'bytes32' },
        { name: 'oversightReasoningHash', type: 'bytes32' },
        { name: 'operationalHaltReasonHash', type: 'bytes32' },
        { name: 'createdAt', type: 'uint256' },
        { name: 'updatedAt', type: 'uint256' },
        { name: 'executedAt', type: 'uint256' },
        { name: 'destChainId', type: 'uint256' },
      ],
    }],
    [{
      exists: r.exists,
      kind: r.kind,
      status: r.status,
      bootstrap: false,
      proposalIndex: 0n,
      adapter: ADAPTER,
      asset: ASSET,
      recipient: ZERO,
      amount: r.amount,
      reviewEnd: 0n,
      reviewWindow: 0n,
      withdrawnAmount: 0n,
      txPayloadHash: hash,
      executiveReasoningHash: ZERO32,
      financialReasoningHash: ZERO32,
      oversightReasoningHash: ZERO32,
      operationalHaltReasonHash: ZERO32,
      createdAt: 0n,
      updatedAt: 0n,
      executedAt: 0n,
      destChainId: 0n,
    }],
  );
}

function rpcResult(method: string, params: unknown[]): unknown {
  if (method === 'eth_chainId') return '0xaa36a7';
  if (method !== 'eth_call') throw new Error(`unexpected RPC ${method}`);
  const call = params[0] as { to: string; data?: string; input?: string };
  const data = (call.data ?? call.input ?? '').toLowerCase();
  if (data.startsWith(EXECUTION_SELECTOR) && call.to.toLowerCase() === TREASURY) {
    return encodeAbiParameters([{ type: 'address' }], [EXECUTION]);
  }
  if (data.startsWith(GET_REQUEST_SELECTOR) && call.to.toLowerCase() === EXECUTION) {
    return encodeRequest(current);
  }
  throw new Error(`unexpected call to ${call.to} ${data.slice(0, 10)}`);
}

before(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      const one = (msg: { id: number; method: string; params: unknown[] }) => {
        try {
          return { jsonrpc: '2.0', id: msg.id, result: rpcResult(msg.method, msg.params ?? []) };
        } catch (error) {
          return { jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: String(error) } };
        }
      };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(Array.isArray(parsed) ? parsed.map(one) : one(parsed)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.EVM_SEPOLIA_RPC_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
});

function relay(action: string, extra: Record<string, unknown> = {}) {
  return relayEvmAgentAction({
    chain_id: 11155111,
    action,
    dao_address: TREASURY,
    execution_address: EXECUTION,
    index: 0,
    ...extra,
  } as Parameters<typeof relayEvmAgentAction>[0]);
}

test('relay refuses a target that is not the treasury’s own NaveExecution', async () => {
  current = { exists: true, kind: 0, status: 0, amount: 1_000_000n };
  await assert.rejects(relay('executive_approve', { execution_address: IMPOSTOR }), /is not this treasury's NaveExecution/);
});

test('relay refuses a request that does not exist', async () => {
  current = { exists: false, kind: 0, status: 0, amount: 0n };
  await assert.rejects(relay('executive_approve'), /does not exist/);
});

test('relay refuses an action the request state cannot leave', async () => {
  current = { exists: true, kind: 0, status: 0, amount: 1_000_000n };
  await assert.rejects(relay('execute_strategy'), /cannot run from request status 0/);
  current = { exists: true, kind: 0, status: 5, amount: 1_000_000n };
  await assert.rejects(relay('financial_approve'), /cannot run from request status 5/);
});

test('relay refuses a strategy action on a transfer request', async () => {
  current = { exists: true, kind: 1, status: 5, amount: 1_000_000n };
  await assert.rejects(relay('withdraw_from_strategy', { amount: '1000' }), /requires request kind 0, found 1/);
});

test('relay refuses an approval when the on-chain payload hash does not match its fields', async () => {
  current = { exists: true, kind: 0, status: 1, amount: 1_000_000n, txPayloadHash: `0x${'ab'.repeat(32)}` };
  await assert.rejects(relay('financial_approve'), /payload hash does not match/);
});

test('relay refuses an approval whose caller-supplied fields differ from the chain', async () => {
  current = { exists: true, kind: 0, status: 1, amount: 1_000_000n };
  await assert.rejects(relay('financial_approve', { amount: '999' }), /amount does not match the on-chain request/);
  await assert.rejects(relay('financial_approve', { adapter: IMPOSTOR }), /adapter does not match the on-chain request/);
});
