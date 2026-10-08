import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'crypto';
import { Keypair, PublicKey, type Connection } from '@solana/web3.js';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { verifySolanaLock } from './bridgeRelayer.js';
import { decodeAttributedBridgeLock } from './bridgePrograms.js';

// Regression coverage for the BridgeLock event-attribution fix (audit
// CRITICAL): `verifySolanaLock` used to accept a `BridgeLock`-shaped
// `Program data:` line from ANY program in the transaction. It must now only
// accept an event that is (a) logged inside nave_bridge's own invoke/success
// bracket and (b) backed by nave_bridge actually being invoked (present in the
// account keys and targeted by an outer or inner instruction).

const bridgeProgram = Keypair.generate().publicKey;
const foreignProgram = Keypair.generate().publicKey;
const sender = Keypair.generate().publicKey;
const recipient = privateKeyToAccount(generatePrivateKey()).address;

function bridgeLockLogLine(nonce = 1n): string {
  const disc = createHash('sha256').update('event:BridgeLock').digest().subarray(0, 8);
  const u64 = (v: bigint) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(v);
    return b;
  };
  const buf = Buffer.concat([
    disc,
    Buffer.from(sender.toBytes()),
    u64(11155111n),
    Buffer.from(recipient.slice(2), 'hex'),
    u64(10_250_000n),
    u64(10_000_000n),
    u64(250_000n),
    u64(100_000n),
    u64(100_000n),
    u64(50_000n),
    u64(nonce),
    u64(1_780_000_000n),
  ]);
  return `Program data: ${buf.toString('base64')}`;
}

/** jsonParsed-shaped tx (what `getParsedTransaction` returns). */
function parsedTx(
  logMessages: string[],
  programs: PublicKey[],
  inner: PublicKey[] = [],
  err: unknown = null,
) {
  return {
    slot: 1,
    blockTime: 0,
    transaction: {
      signatures: ['sig'],
      message: {
        accountKeys: [
          { pubkey: sender, signer: true, writable: true, source: 'transaction' },
          ...programs.map((p) => ({ pubkey: p, signer: false, writable: false, source: 'transaction' })),
          ...inner.map((p) => ({ pubkey: p, signer: false, writable: false, source: 'transaction' })),
        ],
        instructions: programs.map((p) => ({ programId: p, accounts: [], data: '' })),
        recentBlockhash: 'x',
      },
    },
    meta: {
      err,
      logMessages,
      innerInstructions: inner.length
        ? [{ index: 0, instructions: inner.map((p) => ({ programId: p, accounts: [], data: '' })) }]
        : [],
    },
  };
}

function stubConnection(tx: unknown): Connection {
  return { getParsedTransaction: async () => tx } as unknown as Connection;
}

const bracket = (p: PublicKey, inner: string[], depth = 1) => [
  `Program ${p.toBase58()} invoke [${depth}]`,
  ...inner,
  `Program ${p.toBase58()} success`,
];

test('verifySolanaLock accepts a genuine nave_bridge lock (outer instruction)', async () => {
  const tx = parsedTx(bracket(bridgeProgram, ['Program log: Instruction: Lock', bridgeLockLogLine(7n)]), [bridgeProgram]);
  const ev = await verifySolanaLock(stubConnection(tx), 'sig', bridgeProgram);
  assert.equal(ev.nonce, 7n);
  assert.equal(ev.sender, sender.toBase58());
  assert.equal(ev.evmRecipient.toLowerCase(), recipient.toLowerCase());
});

test('verifySolanaLock accepts a genuine nave_bridge lock reached via nested CPI', async () => {
  // Outer program at depth 1 CPIs into nave_bridge at depth 2; the event is
  // logged inside the depth-2 bracket and nave_bridge appears as an inner
  // instruction (plus in accountKeys) but NOT as an outer instruction.
  const logs = [
    `Program ${foreignProgram.toBase58()} invoke [1]`,
    'Program log: Instruction: Wrapper',
    ...bracket(bridgeProgram, ['Program log: Instruction: Lock', bridgeLockLogLine(9n)], 2),
    `Program ${foreignProgram.toBase58()} success`,
  ];
  const tx = parsedTx(logs, [foreignProgram], [bridgeProgram]);
  const ev = await verifySolanaLock(stubConnection(tx), 'sig', bridgeProgram);
  assert.equal(ev.nonce, 9n);
});

test('verifySolanaLock rejects an identical event emitted by a FOREIGN program', async () => {
  // Same bytes, but logged inside the foreign program's bracket and nave_bridge
  // is nowhere in the transaction.
  const tx = parsedTx(bracket(foreignProgram, [bridgeLockLogLine(7n)]), [foreignProgram]);
  await assert.rejects(verifySolanaLock(stubConnection(tx), 'sig', bridgeProgram), /no nave_bridge BridgeLock event/);
});

test('verifySolanaLock rejects a foreign-program event even when nave_bridge is ALSO invoked in the tx', async () => {
  // nave_bridge runs (say, a config read) but emits nothing; the foreign
  // program then logs the forged event in ITS bracket. The structural check
  // passes; the log-stack attribution must still reject it.
  const logs = [
    ...bracket(bridgeProgram, ['Program log: Instruction: Sync']),
    ...bracket(foreignProgram, [bridgeLockLogLine(7n)]),
  ];
  const tx = parsedTx(logs, [bridgeProgram, foreignProgram]);
  await assert.rejects(verifySolanaLock(stubConnection(tx), 'sig', bridgeProgram), /no nave_bridge BridgeLock event/);
});

test('verifySolanaLock rejects a nave_bridge-bracketed log when nave_bridge was not actually invoked', async () => {
  // Log text claims a nave_bridge bracket but the instruction list only
  // targets the foreign program (nave_bridge not in accountKeys either).
  const tx = parsedTx(bracket(bridgeProgram, [bridgeLockLogLine(7n)]), [foreignProgram]);
  await assert.rejects(verifySolanaLock(stubConnection(tx), 'sig', bridgeProgram), /no nave_bridge BridgeLock event/);
});

test('verifySolanaLock rejects a CPI event emitted by a foreign program nested INSIDE nave_bridge', async () => {
  // nave_bridge (depth 1) CPIs a foreign program (depth 2) that logs the fake
  // event: the innermost frame is the foreign program, so it must be rejected.
  const logs = [
    `Program ${bridgeProgram.toBase58()} invoke [1]`,
    ...bracket(foreignProgram, [bridgeLockLogLine(7n)], 2),
    `Program ${bridgeProgram.toBase58()} success`,
  ];
  const tx = parsedTx(logs, [bridgeProgram], [foreignProgram]);
  await assert.rejects(verifySolanaLock(stubConnection(tx), 'sig', bridgeProgram), /no nave_bridge BridgeLock event/);
});

test('verifySolanaLock still rejects missing / failed transactions', async () => {
  await assert.rejects(verifySolanaLock(stubConnection(null), 'sig', bridgeProgram), /not found or not finalized/);
  const failed = parsedTx(bracket(bridgeProgram, [bridgeLockLogLine()]), [bridgeProgram], [], { InstructionError: [0, 'Custom'] });
  await assert.rejects(verifySolanaLock(stubConnection(failed), 'sig', bridgeProgram), /failed on-chain/);
});

test('decodeAttributedBridgeLock handles the compiled/versioned getTransaction shape (watcher path)', () => {
  const lut = Keypair.generate().publicKey; // nave_bridge loaded via an address-lookup table
  const versioned = {
    transaction: {
      message: {
        staticAccountKeys: [sender, foreignProgram],
        compiledInstructions: [{ programIdIndex: 1, accountKeyIndexes: [0], data: new Uint8Array() }],
      },
    },
    meta: {
      err: null,
      loadedAddresses: { writable: [], readonly: [bridgeProgram, lut] },
      // index 2 = first loaded readonly key = nave_bridge (static 0..1, then loaded).
      innerInstructions: [{ index: 0, instructions: [{ programIdIndex: 2, accounts: [0], data: '' }] }],
      logMessages: [
        `Program ${foreignProgram.toBase58()} invoke [1]`,
        ...bracket(bridgeProgram, [bridgeLockLogLine(3n)], 2),
        `Program ${foreignProgram.toBase58()} success`,
      ],
    },
  };
  const ev = decodeAttributedBridgeLock(versioned, bridgeProgram);
  assert.ok(ev);
  assert.equal(ev!.nonce, 3n);

  // Drop the inner CPI → nave_bridge merely loaded, never invoked → rejected.
  const notInvoked = { ...versioned, meta: { ...versioned.meta, innerInstructions: [] } };
  assert.equal(decodeAttributedBridgeLock(notInvoked, bridgeProgram), null);
});
