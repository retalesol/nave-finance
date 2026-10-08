// Integration tests for the independent bridge watcher (bridgeWatcher.ts,
// audit M-1). Driven through the REAL relay code paths against hermetic mock
// servers (see testMockServers.ts). No live network, no secrets.
//
// Covered:
//   • disabled short-circuit (BRIDGE_WATCHER_ENABLED / BRIDGE_RELAYER_ENABLED);
//   • retry sweep re-drives a stale `failed` transfer through the verified relay
//     path and recovers it (status → completed), broadcasting the destination
//     mint exactly once;
//   • a transfer that has exhausted maxRetries is parked as `stuck`, with NO
//     further destination execution;
//   • getBridgeQueueCounts reports pending/failed/stuck counts.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'crypto';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import {
  evmBaseHandlers,
  makeEvmRpcState,
  solanaBaseHandlers,
  startJsonRpcMock,
  startSupabaseMock,
  type SolanaRpcState,
} from './testMockServers.js';
import { keccak256 } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const relayerKeypair = Keypair.generate();
const naveMint = Keypair.generate().publicKey;
const bridgeProgramId = Keypair.generate().publicKey;
const protocolFeeAccount = Keypair.generate().publicKey;
const stakingPoolAccount = Keypair.generate().publicKey;
const solanaSender = Keypair.generate().publicKey;
const evmMinterKey = generatePrivateKey();
const evmLockRecipient = privateKeyToAccount(generatePrivateKey()).address;
const lockboxAddress = '0xdC2c4f3a61AeA908Da5768b63eF9BFF74D13ACf0';
const wrappedNaveAddress = '0x8412cba812593CC8f9Fb510Cd983f79EA2D5fc50';

const solanaState: SolanaRpcState = { sentTransactions: [], sentRawTransactions: [] };
const solanaRpc = await startJsonRpcMock(solanaBaseHandlers(solanaState));
const evmState = makeEvmRpcState('0xaa36a7', lockboxAddress); // wNAVE.minter() = lockbox
const evmRpc = await startJsonRpcMock(evmBaseHandlers(evmState, (raw) => keccak256(raw)));
const supabase = await startSupabaseMock({
  bridge_transfers: { rows: [], unique: 'source_tx' },
});

process.env.BRIDGE_RELAYER_ENABLED = 'true';
process.env.BRIDGE_WATCHER_ENABLED = 'true';
process.env.BRIDGE_WATCHER_STALE_MS = '0'; // everything is immediately eligible
process.env.BRIDGE_WATCHER_MAX_RETRIES = '5';
process.env.BRIDGE_WATCHER_SCAN_EVENTS = 'false';
process.env.BRIDGE_SOLANA_RPC_URL = solanaRpc.url;
process.env.BRIDGE_SOLANA_NAVE_MINT = naveMint.toBase58();
process.env.BRIDGE_SOLANA_BRIDGE_PROGRAM = bridgeProgramId.toBase58();
process.env.BRIDGE_SOLANA_RELAYER_AUTHORITY = bs58.encode(relayerKeypair.secretKey);
process.env.BRIDGE_SOLANA_PROTOCOL_FEE_ACCOUNT = protocolFeeAccount.toBase58();
process.env.BRIDGE_SOLANA_STAKING_POOL_ACCOUNT = stakingPoolAccount.toBase58();
process.env.BRIDGE_EVM_LOCKBOX_11155111 = lockboxAddress;
process.env.BRIDGE_EVM_WRAPPED_NAVE_11155111 = wrappedNaveAddress;
process.env.EVM_SEPOLIA_RPC_URL = evmRpc.url;
process.env.BRIDGE_EVM_MINTER_PRIVATE_KEY = evmMinterKey;
process.env.SUPABASE_URL = supabase.url;
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
process.env.BRIDGE_EVM_CONFIRMATIONS_11155111 = '5';
delete process.env.BRIDGE_EVM_CONFIRMATIONS;
process.env.BRIDGE_FEE_BPS = '250';
process.env.NAVE_CLUSTER = 'devnet';
process.env.NAVE_EVM_NETWORK = 'testnet';
delete process.env.BRIDGE_LOOKBACK_SECONDS;
delete process.env.BRIDGE_WATCHER_EVM_LOOKBACK_BLOCKS;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

const { runBridgeWatcher, getBridgeQueueCounts, readBridgeWatcherConfig, bodyFromRow, evmLookbackBlocksFor } = await import('./bridgeWatcher.js');

after(async () => {
  await Promise.all([solanaRpc.close(), evmRpc.close(), supabase.close()]);
});

const LOCK_SIG = bs58.encode(Buffer.alloc(64, 21));
const lockEvent = {
  sender: solanaSender.toBytes(),
  destChainId: 11155111n,
  evmRecipient: evmLockRecipient,
  grossAmount: 10_250_000n,
  netAmount: 10_000_000n,
  feeAmount: 250_000n,
  stakingAmount: 100_000n,
  protocolAmount: 100_000n,
  burnAmount: 50_000n,
  nonce: 42n,
  timestamp: 1_780_000_000n,
};

function bridgeLockLogLine(ev: typeof lockEvent): string {
  const disc = createHash('sha256').update('event:BridgeLock').digest().subarray(0, 8);
  const u64 = (v: bigint) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(v);
    return b;
  };
  const buf = Buffer.concat([
    disc,
    Buffer.from(ev.sender),
    u64(ev.destChainId),
    Buffer.from(ev.evmRecipient.replace(/^0x/, ''), 'hex'),
    u64(ev.grossAmount),
    u64(ev.netAmount),
    u64(ev.feeAmount),
    u64(ev.stakingAmount),
    u64(ev.protocolAmount),
    u64(ev.burnAmount),
    u64(ev.nonce),
    u64(ev.timestamp),
  ]);
  return `Program data: ${buf.toString('base64')}`;
}

/** Genuine nave_bridge invocation: event inside the program's invoke/success bracket. */
function invokedByBridge(inner: string[]): string[] {
  const p = bridgeProgramId.toBase58();
  return [`Program ${p} invoke [1]`, 'Program log: Instruction: Lock', ...inner, `Program ${p} success`];
}

function parsedTransactionResult(logMessages: string[]) {
  return {
    slot: 100,
    blockTime: 1_780_000_000,
    transaction: {
      signatures: [bs58.encode(Buffer.alloc(64, 7))],
      message: {
        accountKeys: [
          { pubkey: solanaSender.toBase58(), signer: true, writable: true, source: 'transaction' },
          { pubkey: bridgeProgramId.toBase58(), signer: false, writable: false, source: 'transaction' },
        ],
        instructions: [{ programId: bridgeProgramId.toBase58(), accounts: [solanaSender.toBase58()], data: '' }],
        recentBlockhash: 'EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k',
      },
    },
    meta: {
      err: null,
      fee: 5000,
      preBalances: [0],
      postBalances: [0],
      innerInstructions: [],
      logMessages,
      preTokenBalances: [],
      postTokenBalances: [],
      rewards: [],
    },
  };
}

test('watcher config: disabled flags short-circuit', async () => {
  const prev = process.env.BRIDGE_WATCHER_ENABLED;
  try {
    delete process.env.BRIDGE_WATCHER_ENABLED;
    assert.equal(readBridgeWatcherConfig().enabled, false);
    const res = await runBridgeWatcher();
    assert.match(String(res.skipped), /watcher disabled/);
  } finally {
    process.env.BRIDGE_WATCHER_ENABLED = prev;
  }
});

test('retry sweep re-drives a stale failed transfer and recovers it (mints once)', async () => {
  // Seed a failed solana_to_evm transfer as if a prior relay attempt lost its
  // destination leg. The watcher must re-verify on-chain and complete it.
  supabase.tables.bridge_transfers.rows.length = 0;
  supabase.tables.bridge_transfers.rows.push({
    id: 'row-retry-1',
    direction: 'solana_to_evm',
    source_chain: 'solana',
    dest_chain: 'sepolia',
    source_tx: LOCK_SIG,
    recipient: evmLockRecipient,
    amount_raw: '10250000',
    status: 'failed',
    error: 'previous destination failure',
    retry_count: 0,
    updated_at: new Date(0).toISOString(),
    created_at: new Date(0).toISOString(),
  });

  solanaRpc.handlers.getTransaction = () => parsedTransactionResult(invokedByBridge([bridgeLockLogLine(lockEvent)]));
  const mintsBefore = evmState.sentRawTransactions.length;

  const res = await runBridgeWatcher();
  assert.equal(res.skipped, undefined);
  assert.equal(res.retried, 1, 'the stale failed row was retried');
  assert.equal(res.recovered, 1, 'and recovered to completed');

  const row = supabase.tables.bridge_transfers.rows.find((r) => r.source_tx === LOCK_SIG)!;
  assert.equal(row.status, 'completed');
  assert.equal(Number(row.retry_count), 1, 'retry_count incremented on the re-drive');
  assert.equal(evmState.sentRawTransactions.length, mintsBefore + 1, 'exactly one destination mint broadcast');
});

test('a transfer that exhausted maxRetries is parked as stuck (no execution)', async () => {
  supabase.tables.bridge_transfers.rows.length = 0;
  supabase.tables.bridge_transfers.rows.push({
    id: 'row-stuck-1',
    direction: 'evm_to_solana',
    source_chain: 'sepolia',
    dest_chain: 'solana',
    source_tx: `0x${'cd'.repeat(32)}`,
    recipient: Keypair.generate().publicKey.toBase58(),
    amount_raw: '10250000',
    status: 'failed',
    retry_count: 5, // == BRIDGE_WATCHER_MAX_RETRIES
    updated_at: new Date(0).toISOString(),
    created_at: new Date(0).toISOString(),
  });

  const mintsBefore = evmState.sentRawTransactions.length;
  const res = await runBridgeWatcher();
  assert.equal(res.stuck, 1, 'exhausted transfer parked');
  assert.equal(res.retried, 0, 'no retry attempted for an exhausted transfer');

  const row = supabase.tables.bridge_transfers.rows.find((r) => r.id === 'row-stuck-1')!;
  assert.equal(row.status, 'stuck');
  assert.equal(evmState.sentRawTransactions.length, mintsBefore, 'no destination execution for a stuck row');
});

test('getBridgeQueueCounts reports pending/failed/stuck counts', async () => {
  supabase.tables.bridge_transfers.rows.length = 0;
  const base = { direction: 'solana_to_evm', source_chain: 'solana', dest_chain: 'sepolia', recipient: 'x', amount_raw: '1', created_at: new Date().toISOString(), updated_at: new Date().toISOString(), retry_count: 0 };
  supabase.tables.bridge_transfers.rows.push(
    { ...base, id: 'a', source_tx: 'sa', status: 'pending' },
    { ...base, id: 'b', source_tx: 'sb', status: 'pending' },
    { ...base, id: 'c', source_tx: 'sc', status: 'failed' },
    { ...base, id: 'd', source_tx: 'sd', status: 'stuck' },
    { ...base, id: 'e', source_tx: 'se', status: 'completed' },
  );

  const counts = await getBridgeQueueCounts();
  assert.deepEqual(counts, { pending: 2, failed: 1, stuck: 1 });
});

test('bodyFromRow: legacy chain names re-drive as numeric ids; ambiguous family names are never guessed', () => {
  const prev = process.env.NAVE_EVM_NETWORK;
  try {
    // Pinned alias → numeric id regardless of network.
    const a = bodyFromRow({ direction: 'solana_to_evm', source_chain: 'solana', dest_chain: 'sepolia', source_tx: 'x' });
    assert.equal(a.destChainId, 11155111);
    assert.equal(a.sourceChainId, undefined);
    // Family name + the row's own network tag → resolved without NAVE_EVM_NETWORK.
    delete process.env.NAVE_EVM_NETWORK;
    const b = bodyFromRow({ direction: 'evm_to_solana', source_chain: 'base', dest_chain: 'solana', source_tx: 'y', network: 'mainnet' });
    assert.equal(b.sourceChainId, 8453);
    // Family name, no tag, no NAVE_EVM_NETWORK → refuse (a money move must not guess).
    assert.throws(
      () => bodyFromRow({ direction: 'evm_to_solana', source_chain: 'base', dest_chain: 'solana', source_tx: 'z' }),
      /Ambiguous EVM chain 'base'/,
    );
  } finally {
    process.env.NAVE_EVM_NETWORK = prev;
  }
});

test('retry sweep skips (does not stuck or execute) a row whose route cannot be resolved', async () => {
  const prev = process.env.NAVE_EVM_NETWORK;
  supabase.tables.bridge_transfers.rows.length = 0;
  supabase.tables.bridge_transfers.rows.push({
    id: 'row-ambiguous',
    direction: 'evm_to_solana',
    source_chain: 'base',
    dest_chain: 'solana',
    source_tx: `0x${'ef'.repeat(32)}`,
    recipient: Keypair.generate().publicKey.toBase58(),
    amount_raw: '1',
    status: 'failed',
    retry_count: 0,
    updated_at: new Date(0).toISOString(),
    created_at: new Date(0).toISOString(),
  });
  try {
    delete process.env.NAVE_EVM_NETWORK;
    const res = await runBridgeWatcher();
    assert.equal(res.retried, 0);
    assert.equal(res.stuck, 0);
    const row = supabase.tables.bridge_transfers.rows.find((r) => r.id === 'row-ambiguous')!;
    assert.equal(row.status, 'failed', 'row left untouched for an operator');
  } finally {
    process.env.NAVE_EVM_NETWORK = prev;
  }
});

test('evmLookbackBlocksFor: seconds window converts per chain block time, ≥ 2h by default, legacy block env is a floor', () => {
  const saved = { s: process.env.BRIDGE_LOOKBACK_SECONDS, b: process.env.BRIDGE_WATCHER_EVM_LOOKBACK_BLOCKS };
  try {
    delete process.env.BRIDGE_LOOKBACK_SECONDS;
    delete process.env.BRIDGE_WATCHER_EVM_LOOKBACK_BLOCKS;
    const cfg = readBridgeWatcherConfig();
    assert.equal(cfg.lookbackSeconds, 7200);
    assert.equal(evmLookbackBlocksFor(1, cfg), 600n, 'Ethereum 12s blocks');
    assert.equal(evmLookbackBlocksFor(8453, cfg), 3600n, 'Base 2s blocks');
    assert.equal(evmLookbackBlocksFor(4663, cfg), 28_800n, 'Robinhood ~250ms blocks');
    process.env.BRIDGE_LOOKBACK_SECONDS = '600';
    process.env.BRIDGE_WATCHER_EVM_LOOKBACK_BLOCKS = '5000';
    const cfg2 = readBridgeWatcherConfig();
    assert.equal(evmLookbackBlocksFor(1, cfg2), 5000n, 'legacy block floor wins when larger');
    assert.equal(evmLookbackBlocksFor(4663, cfg2), 5000n);
    process.env.BRIDGE_WATCHER_EVM_LOOKBACK_BLOCKS = '10';
    assert.equal(evmLookbackBlocksFor(1, readBridgeWatcherConfig()), 50n, '600s / 12s');
  } finally {
    if (saved.s === undefined) delete process.env.BRIDGE_LOOKBACK_SECONDS; else process.env.BRIDGE_LOOKBACK_SECONDS = saved.s;
    if (saved.b === undefined) delete process.env.BRIDGE_WATCHER_EVM_LOOKBACK_BLOCKS; else process.env.BRIDGE_WATCHER_EVM_LOOKBACK_BLOCKS = saved.b;
  }
});
