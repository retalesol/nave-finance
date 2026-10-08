// Single-signature nave_bridge `lock` instruction: the EVM recipient + dest
// chain id + NET amount are embedded in the instruction data so the one signed
// tx authorizes the exact payout (no separate off-chain recipient signature).
import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey } from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha256';
import {
  buildBridgeLockInstruction,
  solanaAddressToBytes32,
  deriveBridgeConfig,
  deriveBridgeCustody,
  deriveBridgeCustodyAuthority,
} from '../../src/lib/bridge/solanaBridgeProgram';

const PROGRAM = new PublicKey('Fu3ZpX1SMvqVhuo7E4uKGvJxe6cJDFDxxmSCET6de9u6');
const SENDER = new PublicKey('EJ9qpuQosjwv8N1Rab7SK4zvVpEbvEBbCdum9KseADLn');
const MINT = new PublicKey('GmBMZuXsXpe7TZK27PTcXUyNGcuw9Ew8v3fxys7wM9Wa');
const FEE_ACCT = new PublicKey('6N5JiWP2zF6VXhG6hwgYEYhxBEARAV5P6WRgfYb2zskC');
const POOL_ACCT = new PublicKey('EGg56E1YtL5YapzkF7vkRThHR8i5FeRvm2LLuySdYory');
const EVM_RECIPIENT = '0x1111111111111111111111111111111111111111';

function lockIx(overrides: Partial<Parameters<typeof buildBridgeLockInstruction>[0]> = {}) {
  return buildBridgeLockInstruction({
    programId: PROGRAM,
    sender: SENDER,
    naveMint: MINT,
    protocolFeeAccount: FEE_ACCT,
    stakingPoolAccount: POOL_ACCT,
    netAmount: 1_000_000n,
    destChainId: 11155111,
    evmRecipient: EVM_RECIPIENT,
    ...overrides,
  });
}

test('lock data layout: [disc(8)][netAmount u64][destChainId u64][evmRecipient 20]', () => {
  const ix = lockIx();
  assert.equal(ix.data.length, 8 + 8 + 8 + 20);

  const disc = Buffer.from(sha256('global:lock')).subarray(0, 8);
  assert.deepEqual(ix.data.subarray(0, 8), disc, 'anchor global:lock discriminator');

  assert.equal(ix.data.readBigUInt64LE(8), 1_000_000n, 'net amount encoded little-endian');
  assert.equal(ix.data.readBigUInt64LE(16), 11155111n, 'dest chain id encoded little-endian');
  assert.equal(
    ix.data.subarray(24).toString('hex'),
    '1111111111111111111111111111111111111111',
    'the 20-byte EVM recipient is embedded verbatim',
  );
});

test('lock accounts: sender is the sole signer; PDAs + fee legs are present', () => {
  const ix = lockIx();
  assert.ok(ix.programId.equals(PROGRAM));
  const signers = ix.keys.filter((k) => k.isSigner);
  assert.equal(signers.length, 1);
  assert.ok(signers[0].pubkey.equals(SENDER), 'only the sender signs');

  const keySet = ix.keys.map((k) => k.pubkey.toBase58());
  assert.ok(keySet.includes(deriveBridgeConfig(PROGRAM).toBase58()), 'bridge config PDA');
  assert.ok(keySet.includes(deriveBridgeCustody(PROGRAM).toBase58()), 'custody PDA');
  assert.ok(keySet.includes(deriveBridgeCustodyAuthority(PROGRAM).toBase58()), 'custody authority PDA');
  assert.ok(keySet.includes(FEE_ACCT.toBase58()), 'protocol fee leg destination');
  assert.ok(keySet.includes(POOL_ACCT.toBase58()), 'staking pool leg destination');
});

test('lock: rejects a non-positive net amount', () => {
  assert.throws(() => lockIx({ netAmount: 0n }), /must be positive/);
  assert.throws(() => lockIx({ netAmount: -5n }), /must be positive/);
});

test('lock: rejects a malformed (non-20-byte) EVM recipient', () => {
  assert.throws(() => lockIx({ evmRecipient: '0x1234' }), /20-byte/);
});

test('PDA derivations are deterministic for a program id', () => {
  assert.equal(deriveBridgeConfig(PROGRAM).toBase58(), deriveBridgeConfig(PROGRAM).toBase58());
  assert.notEqual(deriveBridgeConfig(PROGRAM).toBase58(), deriveBridgeCustody(PROGRAM).toBase58());
});

test('solanaAddressToBytes32: encodes the 32-byte pubkey for the EVM bridgeBurn arg', () => {
  const b32 = solanaAddressToBytes32(SENDER.toBase58());
  assert.match(b32, /^0x[0-9a-f]{64}$/, '0x + 32 bytes hex');
  assert.equal(b32.slice(2), Buffer.from(SENDER.toBytes()).toString('hex'));
});
