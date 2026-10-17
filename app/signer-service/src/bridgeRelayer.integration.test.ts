// Integration-style tests for the /bridge-relay handler logic
// (handleBridgeRelay in bridgeRelayer.ts), driven end-to-end through the REAL
// code paths — web3.js Connection, viem public/wallet clients, supabase-js —
// against hermetic local mock servers (see testMockServers.ts). No live
// network, no secrets.
//
// Covered (audit workstream 3):
//   • route validation: invalid direction / chains / tx-hash shape, and
//     configured-but-unset routes fail BEFORE any DB write;
//   • BRIDGE_RELAYER_ENABLED gating semantics (readBridgeConfig().enabled —
//     the HTTP 503 gate in index.ts keys off exactly this flag);
//   • rate-limit spec composition used by POST /bridge-relay (global + per-IP
//     + per-action bridge:ip dimension trips first for a single abusive IP);
//   • recipient is taken from the ON-CHAIN event, never the HTTP body — the
//     core anti-theft property (a forged body recipient is ignored in both
//     directions);
//   • idempotency: a duplicate source_tx returns the existing row
//     (duplicate: true) and never executes the destination a second time;
//   • confirmation-depth gating: an EVM burn under BRIDGE_EVM_CONFIRMATIONS
//     is rejected with NO DB write (reorg guard);
//   • failure handling: a destination failure marks the row 'failed' and the
//     sanitized error is surfaced.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'crypto';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  keccak256,
  parseTransaction,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  evmBaseHandlers,
  makeEvmRpcState,
  solanaBaseHandlers,
  startJsonRpcMock,
  startSupabaseMock,
  type SolanaRpcState,
} from './testMockServers.js';

// ─── Fixture identities ───────────────────────────────────────────────────────

const relayerKeypair = Keypair.generate();
const naveMint = Keypair.generate().publicKey;
const bridgeProgramId = Keypair.generate().publicKey;
const protocolFeeAccount = Keypair.generate().publicKey;
const stakingPoolAccount = Keypair.generate().publicKey;
const solanaSender = Keypair.generate().publicKey;
const solanaBurnRecipient = Keypair.generate().publicKey; // embedded in the EVM burn event
const evmMinterKey = generatePrivateKey(); // the relayer's EVM signing key
const evmLockRecipient = privateKeyToAccount(generatePrivateKey()).address; // embedded in the Solana lock event
const evmBurner = privateKeyToAccount(generatePrivateKey()).address;
const lockboxAddress = '0xdC2c4f3a61AeA908Da5768b63eF9BFF74D13ACf0';
const wrappedNaveAddress = '0x8412cba812593CC8f9Fb510Cd983f79EA2D5fc50';

// ─── Mock servers (started before the module under test is imported, since
//     bridgeRelayer caches its Connection / Supabase client singletons) ────────

const solanaState: SolanaRpcState = { sentTransactions: [], sentRawTransactions: [] };
const solanaRpc = await startJsonRpcMock(solanaBaseHandlers(solanaState));

const evmState = makeEvmRpcState('0xaa36a7', lockboxAddress); // Sepolia 11155111; wNAVE.minter() = lockbox
const evmRpc = await startJsonRpcMock(evmBaseHandlers(evmState, (raw) => keccak256(raw)));

const supabase = await startSupabaseMock({
  bridge_transfers: { rows: [], unique: 'source_tx' },
});

process.env.BRIDGE_RELAYER_ENABLED = 'true';
process.env.BRIDGE_SOLANA_RPC_URL = solanaRpc.url;
process.env.BRIDGE_SOLANA_NAVE_MINT = naveMint.toBase58();
process.env.BRIDGE_SOLANA_BRIDGE_PROGRAM = bridgeProgramId.toBase58();
process.env.BRIDGE_SOLANA_RELAYER_AUTHORITY = bs58.encode(relayerKeypair.secretKey);
process.env.BRIDGE_SOLANA_PROTOCOL_FEE_ACCOUNT = protocolFeeAccount.toBase58();
process.env.BRIDGE_SOLANA_STAKING_POOL_ACCOUNT = stakingPoolAccount.toBase58();
process.env.BRIDGE_EVM_LOCKBOX_11155111 = lockboxAddress;
process.env.BRIDGE_EVM_WRAPPED_NAVE_11155111 = wrappedNaveAddress;
// 84532 intentionally NOT configured — used by the unconfigured-route tests.
delete process.env.BRIDGE_EVM_LOCKBOX_84532;
delete process.env.BRIDGE_EVM_WRAPPED_NAVE_84532;
process.env.EVM_SEPOLIA_RPC_URL = evmRpc.url;
process.env.BRIDGE_EVM_MINTER_PRIVATE_KEY = evmMinterKey;
process.env.SUPABASE_URL = supabase.url;
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
// Per-chain confirmation override (the global BRIDGE_EVM_CONFIRMATIONS can only
// RAISE a chain's safe default, never lower it — see evmConfirmationsForChain).
process.env.BRIDGE_EVM_CONFIRMATIONS_11155111 = '5';
delete process.env.BRIDGE_EVM_CONFIRMATIONS;
process.env.BRIDGE_FEE_BPS = '250';
process.env.NAVE_CLUSTER = 'devnet';
// Family names ('base', 'ethereum') resolve ONLY via this explicit EVM network
// selector — never via the Solana cluster.
process.env.NAVE_EVM_NETWORK = 'testnet';
delete process.env.BRIDGE_EVM_CHAIN_IDS;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

// Deferred imports so the env + servers above are live before module init.
const {
  handleBridgeRelay,
  readBridgeConfig,
  checkBridgeFeeBpsDrift,
  resolveEvmChainId,
  evmConfirmationsForChain,
} = await import('./bridgeRelayer.js');
const { NAVE_BRIDGE_LOCKBOX_ABI, WRAPPED_NAVE_BRIDGE_BURN_ABI } = await import('./bridgePrograms.js');
const rateLimit = await import('./rateLimit.js');

after(async () => {
  await Promise.all([solanaRpc.close(), evmRpc.close(), supabase.close()]);
});

// ─── Event-fixture builders ───────────────────────────────────────────────────

/** Anchor-encode a nave_bridge BridgeLock event as a `Program data:` log line. */
function bridgeLockLogLine(ev: {
  sender: Uint8Array;
  destChainId: bigint;
  evmRecipient: string;
  grossAmount: bigint;
  netAmount: bigint;
  feeAmount: bigint;
  stakingAmount: bigint;
  protocolAmount: bigint;
  burnAmount: bigint;
  nonce: bigint;
  timestamp: bigint;
}): string {
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

/**
 * Wrap event/log lines in the runtime's invoke/success bracket for `program`,
 * exactly as a real nave_bridge `lock` instruction would log them.
 */
function invokedBy(program: string, inner: string[], depth = 1): string[] {
  return [`Program ${program} invoke [${depth}]`, 'Program log: Instruction: Lock', ...inner, `Program ${program} success`];
}

/**
 * Minimal jsonParsed getTransaction result web3.js accepts. By default the
 * outer instruction targets nave_bridge and the program id is in accountKeys
 * (the structural half of event attribution); `opts.program` swaps in a
 * different program to model a foreign caller.
 */
function parsedTransactionResult(
  logMessages: string[],
  err: unknown = null,
  opts: { program?: string; instructions?: Array<{ programId: string; accounts: string[]; data: string }> } = {},
) {
  const program = opts.program ?? bridgeProgramId.toBase58();
  return {
    slot: 100,
    blockTime: 1_780_000_000,
    transaction: {
      signatures: [bs58.encode(Buffer.alloc(64, 7))],
      message: {
        accountKeys: [
          { pubkey: solanaSender.toBase58(), signer: true, writable: true, source: 'transaction' },
          { pubkey: program, signer: false, writable: false, source: 'transaction' },
        ],
        instructions: opts.instructions ?? [{ programId: program, accounts: [solanaSender.toBase58()], data: '' }],
        recentBlockhash: 'EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k',
      },
    },
    meta: {
      err,
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

/** EVM receipt for a WrappedNave BridgeBurnTo burn at `blockNumber`. */
function burnReceipt(txHash: `0x${string}`, blockNumber: bigint, grossRaw: bigint) {
  const topics = encodeEventTopics({
    abi: WRAPPED_NAVE_BRIDGE_BURN_ABI,
    eventName: 'BridgeBurnTo',
    args: {
      from: evmBurner as `0x${string}`,
      solanaRecipient: `0x${Buffer.from(solanaBurnRecipient.toBytes()).toString('hex')}` as `0x${string}`,
    },
  });
  return {
    transactionHash: txHash,
    transactionIndex: '0x0',
    blockHash: `0x${'44'.repeat(32)}`,
    blockNumber: `0x${blockNumber.toString(16)}`,
    from: evmBurner,
    to: wrappedNaveAddress,
    contractAddress: null,
    cumulativeGasUsed: '0x5208',
    gasUsed: '0x5208',
    effectiveGasPrice: '0x3b9aca00',
    logsBloom: `0x${'00'.repeat(256)}`,
    status: '0x1',
    type: '0x2',
    logs: [
      {
        address: wrappedNaveAddress,
        topics,
        data: encodeAbiParameters([{ type: 'uint256' }], [grossRaw]),
        blockNumber: `0x${blockNumber.toString(16)}`,
        transactionHash: txHash,
        transactionIndex: '0x0',
        blockHash: `0x${'44'.repeat(32)}`,
        logIndex: '0x0',
        removed: false,
      },
    ],
  };
}

// Canonical lock event used by the happy-path + idempotency tests. Fee is
// on-top 250 bps: gross 10.25 NAVE, net 10 NAVE, fee 0.25 NAVE (1%/1%/0.5%).
const LOCK_SIG = bs58.encode(Buffer.alloc(64, 1));
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
  nonce: 7n,
  timestamp: 1_780_000_000n,
};

// ─── BRIDGE_RELAYER_ENABLED gating ────────────────────────────────────────────

test('BRIDGE_RELAYER_ENABLED gates the relayer config flag (503 gate in index.ts keys off it)', () => {
  const prev = process.env.BRIDGE_RELAYER_ENABLED;
  try {
    delete process.env.BRIDGE_RELAYER_ENABLED;
    assert.equal(readBridgeConfig().enabled, false, 'unset must be disabled');
    process.env.BRIDGE_RELAYER_ENABLED = 'false';
    assert.equal(readBridgeConfig().enabled, false);
    process.env.BRIDGE_RELAYER_ENABLED = '1'; // strict: only the literal "true"
    assert.equal(readBridgeConfig().enabled, false);
    process.env.BRIDGE_RELAYER_ENABLED = ' TRUE ';
    assert.equal(readBridgeConfig().enabled, true, 'trimmed/case-insensitive "true" enables');
    process.env.BRIDGE_RELAYER_ENABLED = 'true';
    assert.equal(readBridgeConfig().enabled, true);
  } finally {
    process.env.BRIDGE_RELAYER_ENABLED = prev;
  }
});

// ─── Route validation (must fail BEFORE any DB write) ─────────────────────────

test('rejects invalid direction and missing required fields', async () => {
  await assert.rejects(
    handleBridgeRelay({ direction: 'sideways', sourceChain: 'solana', destChain: 'sepolia', sourceTx: 'x' }),
    /direction must be/,
  );
  await assert.rejects(
    handleBridgeRelay({ direction: 'solana_to_evm', sourceChain: 'solana', destChain: 'sepolia' }),
    /sourceTx is required/,
  );
  await assert.rejects(
    handleBridgeRelay({ direction: 'solana_to_evm', destChain: 'sepolia', sourceTx: 'x' }),
    /sourceChain is required/,
  );
  await assert.rejects(
    handleBridgeRelay({ direction: 'solana_to_evm', sourceChain: 'solana', sourceTx: 'x' }),
    /destChainId \(or legacy destChain\) is required/,
  );
  await assert.rejects(
    handleBridgeRelay({ direction: 'evm_to_solana', destChain: 'solana', sourceTx: `0x${'11'.repeat(32)}` }),
    /sourceChainId \(or legacy sourceChain\) is required/,
  );
  await assert.rejects(
    handleBridgeRelay({ direction: 'solana_to_evm', sourceChain: 'solana', destChainId: 'sepolia', sourceTx: 'x' }),
    /destChainId must be a numeric EVM chain id/,
  );
  assert.equal(supabase.tables.bridge_transfers.rows.length, 0, 'no DB write on validation failure');
});

test('rejects unsupported and mismatched routes', async () => {
  // Wrong source chain for the direction.
  await assert.rejects(
    handleBridgeRelay({ direction: 'solana_to_evm', sourceChain: 'sepolia', destChain: 'sepolia', sourceTx: 'x' }),
    /requires sourceChain 'solana'/,
  );
  await assert.rejects(
    handleBridgeRelay({ direction: 'evm_to_solana', sourceChain: 'sepolia', destChain: 'base', sourceTx: `0x${'11'.repeat(32)}` }),
    /requires destChain 'solana'/,
  );
  // Chain not in the allow-list at all.
  await assert.rejects(
    handleBridgeRelay({ direction: 'solana_to_evm', sourceChain: 'solana', destChain: 'polygon', sourceTx: 'x' }),
    /Unsupported EVM chain/,
  );
  await assert.rejects(
    handleBridgeRelay({ direction: 'solana_to_evm', sourceChain: 'solana', destChain: 999999, sourceTx: 'x' }),
    /Unsupported EVM chain/,
  );
  await assert.rejects(
    handleBridgeRelay({ direction: 'solana_to_evm', sourceChain: 'solana', destChainId: 999999, sourceTx: 'x' }),
    /Unsupported EVM chain/,
  );
  // A numeric id on the OTHER network than NAVE_EVM_NETWORK is refused outright
  // (a testnet relayer must never be steered onto Ethereum mainnet).
  await assert.rejects(
    handleBridgeRelay({ direction: 'solana_to_evm', sourceChain: 'solana', destChainId: 1, sourceTx: 'x' }),
    /not enabled on this relayer/,
  );
  // A legacy name that contradicts the supplied id is refused.
  await assert.rejects(
    handleBridgeRelay({ direction: 'solana_to_evm', sourceChain: 'solana', destChainId: 11155111, destChain: 'base', sourceTx: 'x' }),
    /destChain does not match the supplied chain id/,
  );
  // Malformed EVM tx hash for the burn direction.
  await assert.rejects(
    handleBridgeRelay({ direction: 'evm_to_solana', sourceChain: 'sepolia', destChain: 'solana', sourceTx: 'not-a-hash' }),
    /32-byte EVM tx hash/,
  );
  assert.equal(supabase.tables.bridge_transfers.rows.length, 0);
});

test('rejects supported-but-unconfigured routes (Base Sepolia has no lockbox/wNAVE configured)', async () => {
  await assert.rejects(
    handleBridgeRelay({ direction: 'solana_to_evm', sourceChain: 'solana', destChain: 'base', sourceTx: LOCK_SIG }),
    /lockbox not configured for chain 84532/,
  );
  await assert.rejects(
    handleBridgeRelay({
      direction: 'evm_to_solana',
      sourceChain: 'base',
      destChain: 'solana',
      sourceTx: `0x${'22'.repeat(32)}`,
    }),
    /WrappedNave address not configured for chain 84532/,
  );
  assert.equal(supabase.tables.bridge_transfers.rows.length, 0);
});

// ─── Source-verification failures (forged/absent source tx) ───────────────────

test('solana_to_evm: missing, failed, and event-less source transactions are rejected with no DB write', async () => {
  const missingSig = bs58.encode(Buffer.alloc(64, 2));
  solanaRpc.handlers.getTransaction = (params) => {
    const sig = String(params[0]);
    if (sig === missingSig) return null;
    return parsedTransactionResult(['Program log: nothing relevant']);
  };
  await assert.rejects(
    handleBridgeRelay({ direction: 'solana_to_evm', sourceChain: 'solana', destChain: 'sepolia', sourceTx: missingSig }),
    /not found or not finalized/,
  );
  const eventlessSig = bs58.encode(Buffer.alloc(64, 3));
  await assert.rejects(
    handleBridgeRelay({ direction: 'solana_to_evm', sourceChain: 'solana', destChain: 'sepolia', sourceTx: eventlessSig }),
    /no nave_bridge BridgeLock event/,
  );
  const failedSig = bs58.encode(Buffer.alloc(64, 4));
  solanaRpc.handlers.getTransaction = () => parsedTransactionResult(invokedBy(bridgeProgramId.toBase58(), [bridgeLockLogLine(lockEvent)]), { InstructionError: [0, 'Custom'] });
  await assert.rejects(
    handleBridgeRelay({ direction: 'solana_to_evm', sourceChain: 'solana', destChain: 'sepolia', sourceTx: failedSig }),
    /failed on-chain/,
  );
  assert.equal(supabase.tables.bridge_transfers.rows.length, 0);
});

test('solana_to_evm: destChain that does not match the chain embedded in the lock is rejected', async () => {
  // Temporarily configure the Base lockbox so the route resolves and the check
  // under test (event destChainId vs requested destChain) is what fires.
  process.env.BRIDGE_EVM_LOCKBOX_84532 = lockboxAddress;
  try {
    solanaRpc.handlers.getTransaction = () => parsedTransactionResult(invokedBy(bridgeProgramId.toBase58(), [bridgeLockLogLine(lockEvent)])); // destChainId = 11155111
    await assert.rejects(
      handleBridgeRelay({ direction: 'solana_to_evm', sourceChain: 'solana', destChain: 'base', sourceTx: LOCK_SIG }),
      /destChain does not match the destination embedded in the lock transaction/,
    );
  } finally {
    delete process.env.BRIDGE_EVM_LOCKBOX_84532;
  }
  assert.equal(supabase.tables.bridge_transfers.rows.length, 0);
});

// ─── Happy path: recipient comes from the ON-CHAIN event, never the body ──────

test('solana_to_evm happy path: mints the on-chain event recipient/net, ignoring a forged body recipient', async () => {
  const attackerRecipient = privateKeyToAccount(generatePrivateKey()).address;
  solanaRpc.handlers.getTransaction = () => parsedTransactionResult(invokedBy(bridgeProgramId.toBase58(), [bridgeLockLogLine(lockEvent)]));

  const result = await handleBridgeRelay({
    direction: 'solana_to_evm',
    sourceChain: 'solana',
    destChain: 'sepolia',
    sourceTx: LOCK_SIG,
    // The attack: a third party replays the victim's public lock tx with
    // their OWN recipient in the HTTP body. It must be ignored entirely.
    recipient: attackerRecipient,
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.duplicate, false);
  assert.equal(
    result.recipient.toLowerCase(),
    evmLockRecipient.toLowerCase(),
    'recipient must come from the on-chain BridgeLock event, not the HTTP body',
  );
  assert.notEqual(result.recipient.toLowerCase(), attackerRecipient.toLowerCase());
  assert.equal(result.amount_raw, '10250000');
  assert.equal(result.net_raw, '10000000');
  assert.equal(result.fee_raw, '250000');
  assert.equal(result.sender, solanaSender.toBase58());
  assert.ok(result.dest_tx, 'destination mint tx recorded');

  // Decode the ACTUAL signed EVM transaction the relayer broadcast and verify
  // the bridgeIn calldata: recipient/net from the event, replay key =
  // (solanaSrcChainId 900, lock nonce 7).
  assert.equal(evmState.sentRawTransactions.length, 1, 'exactly one mint transaction broadcast');
  const tx = parseTransaction(evmState.sentRawTransactions[0]);
  assert.equal(tx.to?.toLowerCase(), lockboxAddress.toLowerCase());
  const call = decodeFunctionData({ abi: NAVE_BRIDGE_LOCKBOX_ABI, data: tx.data! });
  assert.equal(call.functionName, 'bridgeIn');
  const [mintRecipient, mintAmount, srcChainId, srcNonce] = call.args as readonly [string, bigint, bigint, bigint];
  assert.equal(mintRecipient.toLowerCase(), evmLockRecipient.toLowerCase());
  assert.equal(mintAmount, 10_000_000n, 'mints NET only (fee already resolved on Solana)');
  assert.equal(srcChainId, 900n);
  assert.equal(srcNonce, 7n);

  // Fee-leg telemetry persisted on the row.
  const row = supabase.tables.bridge_transfers.rows.find((r) => r.source_tx === LOCK_SIG)!;
  assert.equal(row.status, 'completed');
  assert.equal(row.staking_raw, '100000');
  assert.equal(row.protocol_raw, '100000');
  assert.equal(row.burn_raw, '50000');
  assert.equal(row.source_nonce, '7');
});

// ─── Event attribution: a foreign program's identical event is rejected ───────

test('solana_to_evm: a BridgeLock-shaped event emitted by a FOREIGN program is rejected (no DB write, no mint)', async () => {
  const foreignProgram = Keypair.generate().publicKey.toBase58();
  const forgedSig = bs58.encode(Buffer.alloc(64, 9));
  const mintsBefore = evmState.sentRawTransactions.length;

  // Case A: the foreign program is the only program invoked; it logs a
  // byte-identical BridgeLock payload. Structural check fails (nave_bridge is
  // not in accountKeys / not invoked) AND the log bracket belongs to the
  // foreign program.
  solanaRpc.handlers.getTransaction = () =>
    parsedTransactionResult(invokedBy(foreignProgram, [bridgeLockLogLine(lockEvent)]), null, { program: foreignProgram });
  await assert.rejects(
    handleBridgeRelay({ direction: 'solana_to_evm', sourceChain: 'solana', destChainId: 11155111, sourceTx: forgedSig }),
    /no nave_bridge BridgeLock event/,
  );

  // Case B: nave_bridge IS invoked in the same tx (structural check passes)
  // but the event line is logged by the foreign program's frame, not by
  // nave_bridge — the log-stack attribution must still reject it.
  solanaRpc.handlers.getTransaction = () =>
    parsedTransactionResult(
      [
        ...invokedBy(bridgeProgramId.toBase58(), ['Program log: Instruction: SomethingElse']),
        ...invokedBy(foreignProgram, [bridgeLockLogLine(lockEvent)]),
      ],
      null,
      {
        instructions: [
          { programId: bridgeProgramId.toBase58(), accounts: [], data: '' },
          { programId: foreignProgram, accounts: [], data: '' },
        ],
      },
    );
  await assert.rejects(
    handleBridgeRelay({ direction: 'solana_to_evm', sourceChain: 'solana', destChainId: 11155111, sourceTx: forgedSig }),
    /no nave_bridge BridgeLock event/,
  );

  // Case C: event logged inside nave_bridge's bracket, but nave_bridge is NOT
  // in the instruction list (log-only spoof of a truncated/foreign tx).
  solanaRpc.handlers.getTransaction = () =>
    parsedTransactionResult(invokedBy(bridgeProgramId.toBase58(), [bridgeLockLogLine(lockEvent)]), null, {
      instructions: [{ programId: foreignProgram, accounts: [], data: '' }],
    });
  await assert.rejects(
    handleBridgeRelay({ direction: 'solana_to_evm', sourceChain: 'solana', destChainId: 11155111, sourceTx: forgedSig }),
    /no nave_bridge BridgeLock event/,
  );

  assert.equal(supabase.tables.bridge_transfers.rows.some((r) => r.source_tx === forgedSig), false);
  assert.equal(evmState.sentRawTransactions.length, mintsBefore, 'forged events never reach the mint');
});

// ─── Canonical numeric chain-id input ────────────────────────────────────────

test('solana_to_evm: numeric destChainId (no legacy destChain) relays and reports evm_chain_id', async () => {
  const sig = bs58.encode(Buffer.alloc(64, 10));
  const ev = { ...lockEvent, nonce: 8n };
  solanaRpc.handlers.getTransaction = () => parsedTransactionResult(invokedBy(bridgeProgramId.toBase58(), [bridgeLockLogLine(ev)]));
  const mintsBefore = evmState.sentRawTransactions.length;

  const result = await handleBridgeRelay({ direction: 'solana_to_evm', destChainId: 11155111, sourceTx: sig });
  assert.equal(result.status, 'completed');
  assert.equal(result.evm_chain_id, 11155111);
  assert.equal(result.source_chain, 'solana');
  assert.equal(result.dest_chain, 'ethereum', 'row label falls back to the canonical family name');
  assert.equal(evmState.sentRawTransactions.length, mintsBefore + 1);

  const row = supabase.tables.bridge_transfers.rows.find((r) => r.source_tx === sig)!;
  assert.equal(row.network, 'testnet', 'network tag comes from the EVM chain, not the Solana cluster');
});

test('resolveEvmChainId: family names resolve ONLY via NAVE_EVM_NETWORK and fail closed when unset', () => {
  const prevNet = process.env.NAVE_EVM_NETWORK;
  const prevIds = process.env.BRIDGE_EVM_CHAIN_IDS;
  try {
    process.env.NAVE_EVM_NETWORK = 'testnet';
    assert.equal(resolveEvmChainId('base'), 84532);
    assert.equal(resolveEvmChainId('ethereum'), 11155111);
    assert.equal(resolveEvmChainId('robinhood'), 46630);
    assert.equal(resolveEvmChainId(84532), 84532);
    assert.equal(resolveEvmChainId('84532'), 84532);
    // Mainnet ids are not enabled on a testnet relayer even when supplied numerically.
    assert.throws(() => resolveEvmChainId(8453), /not enabled on this relayer/);

    process.env.NAVE_EVM_NETWORK = 'mainnet';
    assert.equal(resolveEvmChainId('base'), 8453);
    assert.equal(resolveEvmChainId('ethereum'), 1);
    assert.equal(resolveEvmChainId('robinhood'), 4663);
    assert.throws(() => resolveEvmChainId('sepolia'), /not enabled on this relayer/);

    // Unset: numeric ids still work (every known chain allowed), family names are ambiguous → reject.
    delete process.env.NAVE_EVM_NETWORK;
    assert.equal(resolveEvmChainId(8453), 8453);
    assert.equal(resolveEvmChainId(84532), 84532);
    assert.throws(() => resolveEvmChainId('base'), /Ambiguous EVM chain 'base'/);
    // ...unless the caller supplies an explicit network hint (watcher re-drive from a tagged row).
    assert.equal(resolveEvmChainId('base', { network: 'mainnet' }), 8453);

    // The Solana cluster must have NO influence on EVM chain resolution.
    process.env.NAVE_CLUSTER = 'mainnet';
    assert.throws(() => resolveEvmChainId('base'), /Ambiguous/);
    process.env.NAVE_CLUSTER = 'devnet';

    // BRIDGE_EVM_CHAIN_IDS narrows the enabled set explicitly.
    process.env.NAVE_EVM_NETWORK = 'testnet';
    process.env.BRIDGE_EVM_CHAIN_IDS = '11155111';
    assert.equal(resolveEvmChainId(11155111), 11155111);
    assert.throws(() => resolveEvmChainId(84532), /not enabled on this relayer/);
    assert.throws(() => resolveEvmChainId('base'), /not enabled on this relayer/);
  } finally {
    process.env.NAVE_EVM_NETWORK = prevNet;
    if (prevIds === undefined) delete process.env.BRIDGE_EVM_CHAIN_IDS;
    else process.env.BRIDGE_EVM_CHAIN_IDS = prevIds;
  }
});

test('evmConfirmationsForChain: chain-aware defaults, per-chain override, global can only raise', () => {
  const saved = {
    g: process.env.BRIDGE_EVM_CONFIRMATIONS,
    s: process.env.BRIDGE_EVM_CONFIRMATIONS_11155111,
    r: process.env.BRIDGE_EVM_CONFIRMATIONS_4663,
  };
  try {
    delete process.env.BRIDGE_EVM_CONFIRMATIONS;
    delete process.env.BRIDGE_EVM_CONFIRMATIONS_11155111;
    delete process.env.BRIDGE_EVM_CONFIRMATIONS_4663;
    assert.equal(evmConfirmationsForChain(1), 12);
    assert.equal(evmConfirmationsForChain(8453), 30);
    assert.equal(evmConfirmationsForChain(4663), 60, 'Robinhood ~250ms blocks need a deep default');
    assert.equal(evmConfirmationsForChain(11155111), 12);
    // A shallow global value must NOT lower the Robinhood default (the audited bug)...
    process.env.BRIDGE_EVM_CONFIRMATIONS = '5';
    assert.equal(evmConfirmationsForChain(4663), 60);
    assert.equal(evmConfirmationsForChain(1), 12);
    // ...but a deeper global value raises every chain.
    process.env.BRIDGE_EVM_CONFIRMATIONS = '100';
    assert.equal(evmConfirmationsForChain(1), 100);
    // Explicit per-chain env is the operator override, in either direction.
    process.env.BRIDGE_EVM_CONFIRMATIONS_4663 = '90';
    assert.equal(evmConfirmationsForChain(4663), 90);
    process.env.BRIDGE_EVM_CONFIRMATIONS_11155111 = '3';
    assert.equal(evmConfirmationsForChain(11155111), 3);
  } finally {
    for (const [k, v] of [
      ['BRIDGE_EVM_CONFIRMATIONS', saved.g],
      ['BRIDGE_EVM_CONFIRMATIONS_11155111', saved.s],
      ['BRIDGE_EVM_CONFIRMATIONS_4663', saved.r],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

// ─── Idempotency on duplicate source_tx ───────────────────────────────────────

test('replaying the same source_tx returns the existing row and never mints twice', async () => {
  const mintsBefore = evmState.sentRawTransactions.length;
  const rowsBefore = supabase.tables.bridge_transfers.rows.length;

  const replay = await handleBridgeRelay({
    direction: 'solana_to_evm',
    sourceChain: 'solana',
    destChain: 'sepolia',
    sourceTx: LOCK_SIG,
  });

  assert.equal(replay.duplicate, true, 'idempotent replay flagged');
  assert.equal(replay.status, 'completed');
  assert.equal(replay.recipient.toLowerCase(), evmLockRecipient.toLowerCase());
  assert.equal(evmState.sentRawTransactions.length, mintsBefore, 'NO second destination mint');
  assert.equal(supabase.tables.bridge_transfers.rows.length, rowsBefore, 'no new row');
});

// ─── Confirmation-depth gating (reorg guard) ──────────────────────────────────

const BURN_TX = `0x${'aa'.repeat(32)}` as `0x${string}`;
const BURN_GROSS = 10_250_000n; // gross (net+fee): net = gross*10000/10250 = 10_000_000

test('evm_to_solana: a burn under BRIDGE_EVM_CONFIRMATIONS is rejected with no DB write', async () => {
  // Burn mined at block 100; head at 102 → 3 confirmations < required 5.
  evmState.receipts.set(BURN_TX, burnReceipt(BURN_TX, 100n, BURN_GROSS));
  evmState.blockNumberHex = '0x66';

  await assert.rejects(
    handleBridgeRelay({ direction: 'evm_to_solana', sourceChain: 'sepolia', destChain: 'solana', sourceTx: BURN_TX }),
    /has 3 confirmations; need 5/,
  );
  assert.equal(
    supabase.tables.bridge_transfers.rows.some((r) => r.source_tx === BURN_TX),
    false,
    'reorg-guarded burn must not touch the DB',
  );
});

test('evm_to_solana: reverted burn transactions are rejected', async () => {
  const revertedTx = `0x${'bb'.repeat(32)}` as `0x${string}`;
  evmState.receipts.set(revertedTx, { ...burnReceipt(revertedTx, 100n, BURN_GROSS), status: '0x0' });
  await assert.rejects(
    handleBridgeRelay({ direction: 'evm_to_solana', sourceChain: 'sepolia', destChain: 'solana', sourceTx: revertedTx }),
    /reverted on-chain/,
  );
});

// ─── Burn direction: recipient-from-event + failure marks the row 'failed' ────

test('evm_to_solana: recipient comes from the burn event; a destination failure marks the row failed', async () => {
  // Enough confirmations now (head 200 → 101 confs).
  evmState.blockNumberHex = '0xc8';
  // The release reads the on-chain fee before it builds the transfer.
  solanaRpc.handlers.getAccountInfo = () => ({
    context: { slot: 100 },
    value: {
      data: [syntheticBridgeConfig({ feeBps: 250, stakingBps: 100, protocolBps: 100, burnBps: 50 }).toString('base64'), 'base64'],
      executable: false,
      lamports: 1_000_000,
      owner: bridgeProgramId.toBase58(),
      rentEpoch: 0,
      space: 347,
    },
  });

  // Force the DESTINATION (Solana release) to fail deterministically after
  // verification + insert, by removing a required release-side config.
  const prevProtocol = process.env.BRIDGE_SOLANA_PROTOCOL_FEE_ACCOUNT;
  delete process.env.BRIDGE_SOLANA_PROTOCOL_FEE_ACCOUNT;
  try {
    await assert.rejects(
      handleBridgeRelay({
        direction: 'evm_to_solana',
        sourceChain: 'sepolia',
        destChain: 'solana',
        sourceTx: BURN_TX,
        // Forged body recipient — must be ignored in this direction too.
        recipient: Keypair.generate().publicKey.toBase58(),
      }),
      /BRIDGE_SOLANA_PROTOCOL_FEE_ACCOUNT is not configured/,
    );
  } finally {
    process.env.BRIDGE_SOLANA_PROTOCOL_FEE_ACCOUNT = prevProtocol;
  }

  const row = supabase.tables.bridge_transfers.rows.find((r) => r.source_tx === BURN_TX)!;
  assert.ok(row, 'row inserted after successful source verification');
  assert.equal(row.status, 'failed', 'destination failure marks the row failed');
  assert.match(String(row.error), /BRIDGE_SOLANA_PROTOCOL_FEE_ACCOUNT/);
  assert.equal(
    row.recipient,
    solanaBurnRecipient.toBase58(),
    'recipient must be the Solana pubkey embedded in the BridgeBurnTo event',
  );
  assert.equal(row.amount_raw, BURN_GROSS.toString());
  assert.equal(row.source_message_id, BURN_TX, 'burn tx hash recorded as the release replay key');
});

test('evm_to_solana: a failed transfer source_tx is permanently consumed (documented retry gap)', async () => {
  // NOTE (audit finding M-2): the unique(source_tx) row from the failed
  // attempt above makes any retry return duplicate:true with status 'failed'
  // — there is no automatic or caller-triggerable retry path. This test pins
  // the CURRENT behavior; the independent-watcher recommendation covers the
  // remediation.
  const replay = await handleBridgeRelay({
    direction: 'evm_to_solana',
    sourceChain: 'sepolia',
    destChain: 'solana',
    sourceTx: BURN_TX,
  });
  assert.equal(replay.duplicate, true);
  assert.equal(replay.status, 'failed', 'failed rows are returned as-is on replay (no retry)');
});

// ─── Rate-limit spec composition for POST /bridge-relay ───────────────────────

test('bridge-relay rate-limit dimensions: per-action bridge:ip trips before per-IP and global', async () => {
  // Mirrors the exact spec shape index.ts composes for POST /bridge-relay:
  // global(300)/ip(60)/bridge:ip(20) per minute — scaled down here so the
  // per-action dimension is the first to trip for a single abusive IP while
  // other IPs stay unaffected.
  const suffix = Math.random().toString(36).slice(2);
  const specsFor = (ip: string) => [
    { key: `global:${suffix}`, limit: 30, windowMs: 60_000 },
    { key: `ip:${ip}:${suffix}`, limit: 6, windowMs: 60_000 },
    { key: `bridge:ip:${ip}:${suffix}`, limit: 2, windowMs: 60_000 },
  ];

  assert.equal(await rateLimit.enforceLimits(specsFor('10.0.0.1')), null);
  assert.equal(await rateLimit.enforceLimits(specsFor('10.0.0.1')), null);
  const blocked = await rateLimit.enforceLimits(specsFor('10.0.0.1'));
  assert.ok(blocked && blocked.allowed === false, '3rd request from the same IP must be limited');
  assert.match(blocked!.key, /^bridge:ip:10\.0\.0\.1/, 'the bridge per-action dimension trips first');
  assert.ok(blocked!.retryAfterSeconds > 0);

  // A different caller IP is unaffected (global has plenty of headroom).
  assert.equal(await rateLimit.enforceLimits(specsFor('10.0.0.2')), null);
});

// ─── Fee-bps drift guard (runtime check against the mock chain) ───────────────

function syntheticBridgeConfig(fees: { feeBps: number; stakingBps: number; protocolBps: number; burnBps: number }): Buffer {
  const buf = Buffer.alloc(347); // BridgeConfig::LEN
  buf.writeUInt16LE(fees.feeBps, 234);
  buf.writeUInt16LE(fees.stakingBps, 236);
  buf.writeUInt16LE(fees.protocolBps, 238);
  buf.writeUInt16LE(fees.burnBps, 240);
  return buf;
}

test('checkBridgeFeeBpsDrift passes when on-chain fee_bps matches BRIDGE_FEE_BPS', async () => {
  solanaRpc.handlers.getAccountInfo = () => ({
    context: { slot: 100 },
    value: {
      data: [syntheticBridgeConfig({ feeBps: 250, stakingBps: 100, protocolBps: 100, burnBps: 50 }).toString('base64'), 'base64'],
      executable: false,
      lamports: 1_000_000,
      owner: bridgeProgramId.toBase58(),
      rentEpoch: 0,
      space: 347,
    },
  });
  const drift = await checkBridgeFeeBpsDrift();
  assert.equal(drift.skipped, undefined);
  assert.equal(drift.ok, true);
  assert.equal(drift.onChainFeeBps, 250);
  assert.equal(drift.envFeeBps, 250);
  assert.equal(drift.onChainStakingBps, 100);
  assert.equal(drift.onChainProtocolBps, 100);
  assert.equal(drift.onChainBurnBps, 50);
});

test('checkBridgeFeeBpsDrift flags drift when on-chain fee_bps differs from BRIDGE_FEE_BPS', async () => {
  solanaRpc.handlers.getAccountInfo = () => ({
    context: { slot: 100 },
    value: {
      data: [syntheticBridgeConfig({ feeBps: 300, stakingBps: 150, protocolBps: 100, burnBps: 50 }).toString('base64'), 'base64'],
      executable: false,
      lamports: 1_000_000,
      owner: bridgeProgramId.toBase58(),
      rentEpoch: 0,
      space: 347,
    },
  });
  const drift = await checkBridgeFeeBpsDrift();
  assert.equal(drift.ok, false, 'on-chain 300 != env 250 must be flagged');
  assert.equal(drift.onChainFeeBps, 300);
  assert.match(String(drift.error), /FEE BPS DRIFT/);
});

test('checkBridgeFeeBpsDrift skips (never crashes) when disabled or unconfigured', async () => {
  const prev = process.env.BRIDGE_RELAYER_ENABLED;
  try {
    process.env.BRIDGE_RELAYER_ENABLED = 'false';
    const disabled = await checkBridgeFeeBpsDrift();
    assert.equal(disabled.ok, true);
    assert.match(String(disabled.skipped), /disabled/);
  } finally {
    process.env.BRIDGE_RELAYER_ENABLED = prev;
  }
  // Missing config account → skipped, not thrown.
  solanaRpc.handlers.getAccountInfo = () => ({ context: { slot: 100 }, value: null });
  const missing = await checkBridgeFeeBpsDrift();
  assert.equal(missing.ok, true);
  assert.match(String(missing.skipped), /not found/);
});
