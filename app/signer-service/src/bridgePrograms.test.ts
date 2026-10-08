import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'crypto';
import { PublicKey } from '@solana/web3.js';
import { netFromGross } from './bridgeRelayer.js';
import {
  bridgeProgramInvoked,
  decodeBridgeLockFromLogs,
  deriveBridgeConfig,
  deriveProcessedRelease,
  summarizeInvokedPrograms,
} from './bridgePrograms.js';

// Fee-on-top inverse: the user burned gross = net + 2.5% on the EVM side, so
// releasing on Solana must recover exactly net and a non-negative fee that sums
// back to gross.
test('netFromGross inverts the 2.5%-on-top fee', () => {
  // net = 1.000000 NAVE, gross = 1.025000 NAVE.
  const gross = 1_025_000n;
  const { netRaw, feeRaw } = netFromGross(gross, 250);
  assert.equal(netRaw, 1_000_000n);
  assert.equal(feeRaw, 25_000n);
  assert.equal(netRaw + feeRaw, gross);
});

test('netFromGross never over-pays (net + fee <= gross for any input)', () => {
  for (const gross of [1n, 7n, 333n, 1_000_001n, 987_654_321n]) {
    const { netRaw, feeRaw } = netFromGross(gross, 250);
    assert.ok(netRaw + feeRaw === gross, `sum must equal gross for ${gross}`);
    assert.ok(netRaw <= gross);
    assert.ok(feeRaw >= 0n);
  }
});

const BRIDGE_PROGRAM = new PublicKey('Fu3ZpX1SMvqVhuo7E4uKGvJxe6cJDFDxxmSCET6de9u6');
const OTHER_PROGRAM = new PublicKey('AxVdBgc8eUZ3VXKCCJxF7mAmRAtvtM2eYAbE3XBjnhjf');

function fakeBridgeLockLine(nonce: bigint): string {
  const disc = createHash('sha256').update('event:BridgeLock').digest().subarray(0, 8);
  const u64 = (v: bigint) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(v);
    return b;
  };
  const buf = Buffer.concat([
    disc,
    Buffer.alloc(32, 1), // sender
    u64(84532n),
    Buffer.alloc(20, 2), // evm recipient
    u64(100n), u64(90n), u64(10n), u64(4n), u64(4n), u64(2n),
    u64(nonce),
    u64(1n),
  ]);
  return `Program data: ${buf.toString('base64')}`;
}

test('decodeBridgeLockFromLogs returns null when no BridgeLock event present', () => {
  assert.equal(
    decodeBridgeLockFromLogs(
      [`Program ${BRIDGE_PROGRAM.toBase58()} invoke [1]`, 'Program log: hello', 'Program data: AAAA', `Program ${BRIDGE_PROGRAM.toBase58()} success`],
      BRIDGE_PROGRAM,
    ),
    null,
  );
});

test('decodeBridgeLockFromLogs only attributes events inside the bridge program\'s own log bracket', () => {
  const b = BRIDGE_PROGRAM.toBase58();
  const o = OTHER_PROGRAM.toBase58();

  // Genuine: event inside nave_bridge's bracket.
  const genuine = [`Program ${b} invoke [1]`, fakeBridgeLockLine(5n), `Program ${b} success`];
  assert.equal(decodeBridgeLockFromLogs(genuine, BRIDGE_PROGRAM)?.nonce, 5n);
  assert.equal(decodeBridgeLockFromLogs(genuine, b)?.nonce, 5n, 'string program id accepted too');

  // Foreign: identical bytes inside another program's bracket → null.
  const foreign = [`Program ${o} invoke [1]`, fakeBridgeLockLine(5n), `Program ${o} success`];
  assert.equal(decodeBridgeLockFromLogs(foreign, BRIDGE_PROGRAM), null);

  // Unbracketed `Program data:` (no invoke frame at all) → null.
  assert.equal(decodeBridgeLockFromLogs([fakeBridgeLockLine(5n)], BRIDGE_PROGRAM), null);

  // Nested CPI: outer program → nave_bridge at depth 2 emits → accepted.
  const nested = [
    `Program ${o} invoke [1]`,
    `Program ${b} invoke [2]`,
    fakeBridgeLockLine(6n),
    `Program ${b} success`,
    `Program ${o} success`,
  ];
  assert.equal(decodeBridgeLockFromLogs(nested, BRIDGE_PROGRAM)?.nonce, 6n);

  // Inverse nesting: nave_bridge → foreign program at depth 2 emits → null
  // (innermost frame is the foreign program), and an event nave_bridge emits
  // AFTER the CPI returns is still attributed correctly.
  const inverse = [
    `Program ${b} invoke [1]`,
    `Program ${o} invoke [2]`,
    fakeBridgeLockLine(7n),
    `Program ${o} success`,
    `Program ${b} success`,
  ];
  assert.equal(decodeBridgeLockFromLogs(inverse, BRIDGE_PROGRAM), null);
  const afterCpi = [
    `Program ${b} invoke [1]`,
    `Program ${o} invoke [2]`,
    fakeBridgeLockLine(7n),
    `Program ${o} success`,
    fakeBridgeLockLine(8n),
    `Program ${b} success`,
  ];
  assert.equal(decodeBridgeLockFromLogs(afterCpi, BRIDGE_PROGRAM)?.nonce, 8n, 'skips the foreign frame, takes the bridge one');

  // A failed frame pops too (`Program X failed: ...`).
  const failedForeign = [
    `Program ${o} invoke [1]`,
    fakeBridgeLockLine(1n),
    `Program ${o} failed: custom program error: 0x1`,
    `Program ${b} invoke [1]`,
    fakeBridgeLockLine(2n),
    `Program ${b} success`,
  ];
  assert.equal(decodeBridgeLockFromLogs(failedForeign, BRIDGE_PROGRAM)?.nonce, 2n);
});

test('summarizeInvokedPrograms / bridgeProgramInvoked cover parsed and compiled shapes', () => {
  const b = BRIDGE_PROGRAM.toBase58();
  const o = OTHER_PROGRAM.toBase58();
  const user = new PublicKey(Buffer.alloc(32, 9));

  // jsonParsed: program only reachable via an inner CPI.
  const parsed = {
    transaction: { message: { accountKeys: [{ pubkey: user }, { pubkey: o }, { pubkey: b }], instructions: [{ programId: o }] } },
    meta: { innerInstructions: [{ instructions: [{ programId: b }] }] },
  };
  const sp = summarizeInvokedPrograms(parsed);
  assert.deepEqual(sp.accountKeys, [user.toBase58(), o, b]);
  assert.ok(sp.invokedPrograms.has(b) && sp.invokedPrograms.has(o));
  assert.equal(bridgeProgramInvoked(parsed, BRIDGE_PROGRAM), true);

  // Present in account keys but never invoked → false.
  const idle = { ...parsed, meta: { innerInstructions: [] } };
  assert.equal(bridgeProgramInvoked(idle, BRIDGE_PROGRAM), false);

  // Compiled/versioned with ALT-loaded key: index order is static, then
  // loaded writable, then loaded readonly.
  const compiled = {
    transaction: { message: { staticAccountKeys: [user, OTHER_PROGRAM], compiledInstructions: [{ programIdIndex: 3 }] } },
    meta: { loadedAddresses: { writable: [new PublicKey(Buffer.alloc(32, 4))], readonly: [BRIDGE_PROGRAM] } },
  };
  const sc = summarizeInvokedPrograms(compiled);
  assert.equal(sc.accountKeys[3], b);
  assert.equal(bridgeProgramInvoked(compiled, BRIDGE_PROGRAM), true);
  assert.equal(bridgeProgramInvoked(compiled, OTHER_PROGRAM), false, 'static key that is never a program target');
});

test('PDA derivations are deterministic', () => {
  const programId = new PublicKey('Fu3ZpX1SMvqVhuo7E4uKGvJxe6cJDFDxxmSCET6de9u6');
  const cfg1 = deriveBridgeConfig(programId);
  const cfg2 = deriveBridgeConfig(programId);
  assert.equal(cfg1.toBase58(), cfg2.toBase58());

  const msgId = new Uint8Array(32).fill(7);
  const p1 = deriveProcessedRelease(programId, cfg1, 84532n, msgId);
  const p2 = deriveProcessedRelease(programId, cfg1, 84532n, msgId);
  assert.equal(p1.toBase58(), p2.toBase58());
  // A different message id yields a different replay PDA.
  const p3 = deriveProcessedRelease(programId, cfg1, 84532n, new Uint8Array(32).fill(8));
  assert.notEqual(p1.toBase58(), p3.toBase58());
  // The same message id from a DIFFERENT source chain yields a different replay
  // PDA (audit P6: source_chain_id is part of the seed, no cross-chain collision).
  const p4 = deriveProcessedRelease(programId, cfg1, 11155111n, msgId);
  assert.notEqual(p1.toBase58(), p4.toBase58());
});
