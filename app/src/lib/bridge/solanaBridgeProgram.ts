// ─── nave_bridge single-signature lock instruction (frontend) ────────────────
// Builds the `nave_bridge.lock` instruction so bridging out of Solana is ONE
// signature: the destination EVM recipient is embedded in the instruction data,
// so the user's single signed transaction authorizes the exact payout address
// (no separate off-chain "sign this recipient" message). The instruction also
// pulls the 2.5%-on-top fee and resolves it on Solana (burn / staking /
// protocol) — the app just sends the one lock tx.

import { Buffer } from 'buffer';
import { PublicKey, TransactionInstruction, SystemProgram } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { sha256 } from '@noble/hashes/sha256';

const BRIDGE_CONFIG_SEED = Buffer.from('bridge_config');
const CUSTODY_AUTHORITY_SEED = Buffer.from('bridge_custody_authority');
const CUSTODY_SEED = Buffer.from('bridge_custody');

/** Anchor `global:<name>` instruction discriminator (sha256 first 8 bytes). */
function ixDiscriminator(name: string): Buffer {
  return Buffer.from(sha256(`global:${name}`)).subarray(0, 8);
}

const LOCK_DISCRIMINATOR = ixDiscriminator('lock');

function u64le(value: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value);
  return buf;
}

/** Decode a 0x… 20-byte EVM address into raw bytes for the `evm_recipient` arg. */
function evmAddressToBytes(address: string): Buffer {
  const hex = address.replace(/^0x/, '');
  if (hex.length !== 40) throw new Error('EVM recipient must be a 20-byte 0x address');
  return Buffer.from(hex, 'hex');
}

export function deriveBridgeConfig(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([BRIDGE_CONFIG_SEED], programId)[0];
}
export function deriveBridgeCustody(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([CUSTODY_SEED], programId)[0];
}
export function deriveBridgeCustodyAuthority(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([CUSTODY_AUTHORITY_SEED], programId)[0];
}

/**
 * Build the single-signature `lock` instruction. `netAmount` is what the user
 * bridges (received on EVM); the program pulls `net + 2.5%` and resolves the fee
 * split on Solana. `evmRecipient` (0x…) is embedded so the tx authorizes it.
 */
export function buildBridgeLockInstruction(params: {
  programId: PublicKey;
  sender: PublicKey;
  naveMint: PublicKey;
  protocolFeeAccount: PublicKey;
  stakingPoolAccount: PublicKey;
  netAmount: bigint;
  destChainId: number;
  evmRecipient: string;
}): TransactionInstruction {
  const {
    programId,
    sender,
    naveMint,
    protocolFeeAccount,
    stakingPoolAccount,
    netAmount,
    destChainId,
    evmRecipient,
  } = params;

  if (netAmount <= 0n) throw new Error('buildBridgeLockInstruction: netAmount must be positive');

  const config = deriveBridgeConfig(programId);
  const custody = deriveBridgeCustody(programId);
  const custodyAuthority = deriveBridgeCustodyAuthority(programId);
  const senderNaveAccount = getAssociatedTokenAddressSync(naveMint, sender);

  const data = Buffer.concat([
    LOCK_DISCRIMINATOR,
    u64le(netAmount),
    u64le(BigInt(destChainId)),
    evmAddressToBytes(evmRecipient),
  ]);

  const keys = [
    { pubkey: sender, isSigner: true, isWritable: true },
    { pubkey: config, isSigner: false, isWritable: true },
    { pubkey: naveMint, isSigner: false, isWritable: true },
    { pubkey: senderNaveAccount, isSigner: false, isWritable: true },
    { pubkey: custody, isSigner: false, isWritable: true },
    { pubkey: custodyAuthority, isSigner: false, isWritable: false },
    { pubkey: protocolFeeAccount, isSigner: false, isWritable: true },
    { pubkey: stakingPoolAccount, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({ programId, keys, data });
}

/** Convert a base58 Solana address into the 32-byte `bytes32` the EVM
 * `bridgeBurn` expects for the embedded recipient. */
export function solanaAddressToBytes32(address: string): `0x${string}` {
  const bytes = new PublicKey(address).toBytes();
  return `0x${Buffer.from(bytes).toString('hex')}` as `0x${string}`;
}

// SystemProgram is imported for callers that assemble a full transaction with
// an ATA-creation preface; re-exported so the bridge hook has one import site.
export { SystemProgram };
