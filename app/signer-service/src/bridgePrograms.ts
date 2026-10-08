// ─── On-chain bridge program encode/decode helpers ──────────────────────────
// The mainnet-hardened bridge moves value through two Anchor programs
// (nave_bridge) and an EVM lockbox (NaveBridge.sol). This module hand-encodes
// the `nave_bridge.release` instruction and decodes the `BridgeLock` event
// WITHOUT a generated IDL, so the relayer has no build-time coupling to the
// program artifacts. Discriminators follow Anchor's convention:
//   instruction: sha256("global:<name>")[0..8]
//   event:       sha256("event:<Name>")[0..8]

import { createHash } from 'crypto';
import {
  PublicKey,
  TransactionInstruction,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';

export const BRIDGE_CONFIG_SEED = Buffer.from('bridge_config');
export const CUSTODY_AUTHORITY_SEED = Buffer.from('bridge_custody_authority');
export const CUSTODY_SEED = Buffer.from('bridge_custody');
export const PROCESSED_RELEASE_SEED = Buffer.from('bridge_processed');

function anchorDiscriminator(kind: 'global' | 'event', name: string): Buffer {
  return createHash('sha256').update(`${kind}:${name}`).digest().subarray(0, 8);
}

const RELEASE_IX_DISCRIMINATOR = anchorDiscriminator('global', 'release');
const BRIDGE_LOCK_EVENT_DISCRIMINATOR = anchorDiscriminator('event', 'BridgeLock');

function u64le(value: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value);
  return buf;
}

// ─── PDA derivation ──────────────────────────────────────────────────────────

export function deriveBridgeConfig(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([BRIDGE_CONFIG_SEED], programId)[0];
}

export function deriveCustodyAuthority(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([CUSTODY_AUTHORITY_SEED], programId)[0];
}

export function deriveCustody(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([CUSTODY_SEED], programId)[0];
}

/**
 * ProcessedRelease replay-guard PDA, keyed by the source chain id (u64 LE) and
 * the 32-byte source message id (the source-chain burn tx hash) so the same
 * inbound burn can never be released twice, and the same message id from two
 * different source chains derives distinct PDAs. `sourceChainId` MUST be encoded
 * little-endian to match the on-chain `source_chain_id.to_le_bytes()` seed.
 */
export function deriveProcessedRelease(
  programId: PublicKey,
  config: PublicKey,
  sourceChainId: bigint,
  sourceMessageId: Uint8Array,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      PROCESSED_RELEASE_SEED,
      config.toBuffer(),
      u64le(sourceChainId),
      Buffer.from(sourceMessageId),
    ],
    programId,
  )[0];
}

// ─── nave_bridge.release instruction ─────────────────────────────────────────

export interface ReleaseAccounts {
  relayer: PublicKey;
  config: PublicKey;
  naveMint: PublicKey;
  custody: PublicKey;
  custodyAuthority: PublicKey;
  recipientNaveAccount: PublicKey;
  protocolFeeAccount: PublicKey;
  stakingPoolAccount: PublicKey;
  processedRelease: PublicKey;
}

/**
 * Build the `nave_bridge.release` instruction. The program transfers `netAmount`
 * to the recipient and resolves the 2.5% fee on Solana (burn / staking /
 * protocol), all bounded by the on-chain pause + per-tx + daily caps + replay
 * guard. `sourceMessageId` is the 32-byte EVM burn tx hash.
 */
export function buildReleaseInstruction(params: {
  programId: PublicKey;
  accounts: ReleaseAccounts;
  sourceChainId: bigint;
  sourceMessageId: Uint8Array;
  netAmount: bigint;
  recipient: PublicKey;
}): TransactionInstruction {
  const { programId, accounts, sourceChainId, sourceMessageId, netAmount, recipient } = params;
  if (sourceMessageId.length !== 32) {
    throw new Error('sourceMessageId must be 32 bytes (EVM tx hash)');
  }

  const data = Buffer.concat([
    RELEASE_IX_DISCRIMINATOR,
    u64le(sourceChainId),
    Buffer.from(sourceMessageId),
    u64le(netAmount),
    recipient.toBuffer(),
  ]);

  const keys = [
    { pubkey: accounts.relayer, isSigner: true, isWritable: true },
    { pubkey: accounts.config, isSigner: false, isWritable: true },
    { pubkey: accounts.naveMint, isSigner: false, isWritable: true },
    { pubkey: accounts.custody, isSigner: false, isWritable: true },
    { pubkey: accounts.custodyAuthority, isSigner: false, isWritable: false },
    { pubkey: accounts.recipientNaveAccount, isSigner: false, isWritable: true },
    { pubkey: accounts.protocolFeeAccount, isSigner: false, isWritable: true },
    { pubkey: accounts.stakingPoolAccount, isSigner: false, isWritable: true },
    { pubkey: accounts.processedRelease, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({ programId, keys, data });
}

// ─── BridgeConfig account decoding (fee-drift guard) ─────────────────────────

/**
 * Absolute byte offset of `fee_bps` inside the on-chain `BridgeConfig`
 * account: 8 (discriminator) + 1 (bump) + 32*5 (owner, pending_owner, relayer,
 * nave_mint, custody) + 1 (custody_authority_bump) + 32*2 (protocol_fee_owner,
 * staking_pool_owner) = 234. Mirrors
 * contracts/solana/programs/nave_bridge/src/state.rs.
 */
export const BRIDGE_CONFIG_FEE_BPS_OFFSET = 234;

export interface BridgeConfigFees {
  feeBps: number;
  stakingBps: number;
  protocolBps: number;
  burnBps: number;
  paused: boolean;
}

/**
 * Decode the fee fields (and pause flag) of the on-chain `BridgeConfig`
 * account. Used by the startup fee-drift guard: the on-chain `fee_bps` is the
 * value the program ACTUALLY charges, so BRIDGE_FEE_BPS (this service) and
 * VITE_NAVE_BRIDGE_FEE_BPS (the app's quote) must both equal it or quotes and
 * EVM→Solana net math silently diverge from reality.
 */
export function decodeBridgeConfigFees(data: Buffer): BridgeConfigFees {
  const need = BRIDGE_CONFIG_FEE_BPS_OFFSET + 2 * 4 + 1; // 4 u16 fields + paused u8
  if (data.length < need) {
    throw new Error(`BridgeConfig account too small (${data.length} bytes; need >= ${need})`);
  }
  const o = BRIDGE_CONFIG_FEE_BPS_OFFSET;
  return {
    feeBps: data.readUInt16LE(o),
    stakingBps: data.readUInt16LE(o + 2),
    protocolBps: data.readUInt16LE(o + 4),
    burnBps: data.readUInt16LE(o + 6),
    paused: data.readUInt8(o + 8) === 1,
  };
}

// ─── BridgeLock event decoding ───────────────────────────────────────────────

export interface BridgeLockEvent {
  sender: string;
  destChainId: bigint;
  /** 0x-prefixed 20-byte EVM recipient. */
  evmRecipient: string;
  grossAmount: bigint;
  netAmount: bigint;
  feeAmount: bigint;
  stakingAmount: bigint;
  protocolAmount: bigint;
  burnAmount: bigint;
  nonce: bigint;
  timestamp: bigint;
}

const LOG_INVOKE_RE = /^Program (\w+) invoke \[(\d+)\]$/;
const LOG_RESULT_RE = /^Program (\w+) (success|failed)/;
const LOG_DATA_RE = /^Program data: (.+)$/;

function programIdString(programId: PublicKey | string): string {
  return typeof programId === 'string' ? new PublicKey(programId).toBase58() : programId.toBase58();
}

/**
 * Decode the first `BridgeLock` Anchor event emitted BY `bridgeProgramId` in a
 * transaction's program logs.
 *
 * Anchor writes events as base64 in `Program data:` log lines, prefixed with
 * the 8-byte event discriminator — but the log line itself carries no program
 * attribution, so ANY program can emit an identically-shaped payload. The
 * runtime does, however, bracket every program's log output with
 * `Program <id> invoke [depth]` / `Program <id> success|failed`. We replay
 * that bracket structure as a stack and only accept `Program data:` lines
 * emitted while the innermost executing program is `bridgeProgramId` (this
 * naturally covers a genuine nave_bridge invocation reached via CPI from an
 * outer program, and rejects a foreign program logging a fake event at any
 * depth). Returns null when no attributable BridgeLock is found.
 *
 * Callers must ALSO verify the program was actually invoked in the transaction
 * (see {@link bridgeProgramInvoked}) — logs can be truncated by the runtime,
 * and the invocation check is the cheaper, structural half of the proof.
 */
export function decodeBridgeLockFromLogs(
  logs: string[],
  bridgeProgramId: PublicKey | string,
): BridgeLockEvent | null {
  const want = programIdString(bridgeProgramId);
  const stack: string[] = [];
  for (const line of logs) {
    const invoke = line.match(LOG_INVOKE_RE);
    if (invoke) {
      stack.push(invoke[1]);
      continue;
    }
    const result = line.match(LOG_RESULT_RE);
    if (result) {
      // Pop the matching frame. Tolerate a malformed/truncated log by only
      // popping when the top frame matches the program that just returned.
      if (stack.length && stack[stack.length - 1] === result[1]) stack.pop();
      continue;
    }
    const m = line.match(LOG_DATA_RE);
    if (!m) continue;
    // Only accept event data while nave_bridge is the innermost executing program.
    if (!stack.length || stack[stack.length - 1] !== want) continue;
    const decoded = decodeBridgeLockPayload(m[1]);
    if (decoded) return decoded;
  }
  return null;
}

/** Decode one base64 `Program data:` payload as a BridgeLock event, or null. */
function decodeBridgeLockPayload(b64: string): BridgeLockEvent | null {
  let buf: Buffer;
  try {
    buf = Buffer.from(b64, 'base64');
  } catch {
    return null;
  }
  if (buf.length < 8 + 32 + 8 + 20 + 8 * 7 + 8) return null;
  if (!buf.subarray(0, 8).equals(BRIDGE_LOCK_EVENT_DISCRIMINATOR)) return null;

  let o = 8;
  const sender = new PublicKey(buf.subarray(o, o + 32)); o += 32;
  const destChainId = buf.readBigUInt64LE(o); o += 8;
  const evmRecipient = '0x' + buf.subarray(o, o + 20).toString('hex'); o += 20;
  const grossAmount = buf.readBigUInt64LE(o); o += 8;
  const netAmount = buf.readBigUInt64LE(o); o += 8;
  const feeAmount = buf.readBigUInt64LE(o); o += 8;
  const stakingAmount = buf.readBigUInt64LE(o); o += 8;
  const protocolAmount = buf.readBigUInt64LE(o); o += 8;
  const burnAmount = buf.readBigUInt64LE(o); o += 8;
  const nonce = buf.readBigUInt64LE(o); o += 8;
  const timestamp = buf.readBigInt64LE(o); o += 8;

  return {
    sender: sender.toBase58(),
    destChainId,
    evmRecipient,
    grossAmount,
    netAmount,
    feeAmount,
    stakingAmount,
    protocolAmount,
    burnAmount,
    nonce,
    timestamp,
  };
}

// ─── Program-invocation attribution ──────────────────────────────────────────

/** Minimal shape shared by `getParsedTransaction` and `getTransaction` results. */
export interface TransactionInvocationShape {
  transaction: {
    message: {
      // jsonParsed form
      accountKeys?: Array<{ pubkey: PublicKey | string } | PublicKey | string>;
      instructions?: Array<{ programId?: PublicKey | string; programIdIndex?: number }>;
      // versioned/compiled form
      staticAccountKeys?: PublicKey[];
      compiledInstructions?: Array<{ programIdIndex: number }>;
    };
  };
  meta?: {
    loadedAddresses?: { writable: PublicKey[]; readonly: PublicKey[] } | null;
    innerInstructions?: Array<{
      instructions: Array<{ programId?: PublicKey | string; programIdIndex?: number }>;
    }> | null;
  } | null;
}

function keyToString(k: { pubkey: PublicKey | string } | PublicKey | string): string {
  if (typeof k === 'string') return k;
  if (k instanceof PublicKey) return k.toBase58();
  const p = k.pubkey;
  return typeof p === 'string' ? p : p.toBase58();
}

/**
 * Collect the full account-key list (static + address-lookup-table loaded, in
 * runtime index order) and the set of program ids targeted by the outer
 * instructions and every inner CPI. Works for both the jsonParsed response
 * (`getParsedTransaction`) and the compiled/versioned response
 * (`getTransaction`).
 */
export function summarizeInvokedPrograms(tx: TransactionInvocationShape): {
  accountKeys: string[];
  invokedPrograms: Set<string>;
} {
  const msg = tx.transaction.message;
  const accountKeys: string[] = [];
  if (Array.isArray(msg.accountKeys)) {
    for (const k of msg.accountKeys) accountKeys.push(keyToString(k));
  } else if (Array.isArray(msg.staticAccountKeys)) {
    for (const k of msg.staticAccountKeys) accountKeys.push(keyToString(k));
    const loaded = tx.meta?.loadedAddresses;
    if (loaded) {
      for (const k of loaded.writable ?? []) accountKeys.push(keyToString(k));
      for (const k of loaded.readonly ?? []) accountKeys.push(keyToString(k));
    }
  }

  const invokedPrograms = new Set<string>();
  const addIx = (ix: { programId?: PublicKey | string; programIdIndex?: number }) => {
    if (ix.programId !== undefined) {
      invokedPrograms.add(keyToString(ix.programId));
    } else if (typeof ix.programIdIndex === 'number') {
      const k = accountKeys[ix.programIdIndex];
      if (k) invokedPrograms.add(k);
    }
  };
  for (const ix of msg.instructions ?? []) addIx(ix);
  for (const ix of msg.compiledInstructions ?? []) addIx(ix);
  for (const inner of tx.meta?.innerInstructions ?? []) {
    for (const ix of inner.instructions ?? []) addIx(ix);
  }
  return { accountKeys, invokedPrograms };
}

/**
 * Structural proof that `bridgeProgramId` participated in the transaction: it
 * must appear in the account keys (static or loaded) AND be the target of the
 * outer instruction or of an inner CPI. Pair with
 * {@link decodeBridgeLockFromLogs}, which attributes the event log itself.
 */
export function bridgeProgramInvoked(
  tx: TransactionInvocationShape,
  bridgeProgramId: PublicKey | string,
): boolean {
  const want = programIdString(bridgeProgramId);
  const { accountKeys, invokedPrograms } = summarizeInvokedPrograms(tx);
  return accountKeys.includes(want) && invokedPrograms.has(want);
}

/**
 * Decode the BridgeLock event of a transaction ONLY IF the event is attributable
 * to `bridgeProgramId` both structurally (program in account keys + targeted by
 * an outer/inner instruction) and in the log bracket stack. Returns null
 * otherwise. This is the single entry point every relay path must use.
 */
export function decodeAttributedBridgeLock(
  tx: TransactionInvocationShape & { meta?: { logMessages?: string[] | null } | null },
  bridgeProgramId: PublicKey | string,
): BridgeLockEvent | null {
  if (!bridgeProgramInvoked(tx, bridgeProgramId)) return null;
  const logs = tx.meta?.logMessages ?? [];
  return decodeBridgeLockFromLogs(logs, bridgeProgramId);
}

// ─── EVM lockbox ABI (bridgeIn) ──────────────────────────────────────────────

export const NAVE_BRIDGE_LOCKBOX_ABI = [
  {
    type: 'function',
    name: 'bridgeIn',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'recipient', type: 'address' },
      { name: 'netAmount', type: 'uint256' },
      { name: 'srcChainId', type: 'uint64' },
      { name: 'srcNonce', type: 'uint64' },
    ],
    outputs: [],
  },
  {
    type: 'event',
    name: 'BridgeIn',
    inputs: [
      { name: 'recipient', type: 'address', indexed: true },
      { name: 'netAmount', type: 'uint256', indexed: false },
      { name: 'srcChainId', type: 'uint64', indexed: true },
      { name: 'srcNonce', type: 'uint64', indexed: true },
    ],
  },
] as const;

/**
 * EVM `WrappedNave.bridgeBurn` event: a single-signature bridge-back where the
 * holder embeds the Solana recipient (32-byte pubkey) in the burn tx itself.
 */
export const WRAPPED_NAVE_BRIDGE_BURN_ABI = [
  {
    type: 'event',
    name: 'BridgeBurnTo',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'solanaRecipient', type: 'bytes32', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'BridgeBurn',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
] as const;
