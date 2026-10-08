// ─── Solana NAVE lock helpers (trusted-relayer MVP) ──────────────────────────
// Build the SPL transfer that locks NAVE into the Nave-controlled custody token
// account, plus helpers to resolve the user's NAVE ATA and read their balance.
// NAVE is a 6-decimal SPL token, so we use `createTransferCheckedInstruction`
// (which asserts mint + decimals on-chain) for safety.

import type { Connection, TransactionInstruction } from '@solana/web3.js';
import { PublicKey } from '@solana/web3.js';
import {
  createTransferCheckedInstruction,
  getAssociatedTokenAddress,
  getAssociatedTokenAddressSync,
  getAccount,
  TokenAccountNotFoundError,
  TokenInvalidAccountOwnerError,
} from '@solana/spl-token';
import { NAVE_DECIMALS, SOLANA_NAVE_MINT } from '../programConfig';

/** Resolve the owner's associated token account (ATA) for the NAVE mint. */
export async function getNaveAtaAddress(owner: PublicKey): Promise<PublicKey> {
  return getAssociatedTokenAddress(SOLANA_NAVE_MINT, owner);
}

/**
 * Build the lock transfer: move `amountRaw` NAVE base units from the owner's ATA
 * into the bridge custody token account. `createTransferCheckedInstruction`
 * verifies the mint + decimals on-chain so a wrong-decimals amount can't slip in.
 */
export function buildLockTransferInstruction(params: {
  owner: PublicKey;
  custody: PublicKey;
  mint: PublicKey;
  amountRaw: bigint;
  /** Optional pre-resolved source ATA; defaults to the owner's NAVE ATA. */
  source?: PublicKey;
}): TransactionInstruction {
  const { owner, custody, mint, amountRaw, source } = params;
  if (amountRaw <= 0n) {
    throw new Error('buildLockTransferInstruction: amountRaw must be positive.');
  }
  const sourceAta = source ?? getAssociatedTokenAddressSync(mint, owner);
  return createTransferCheckedInstruction(
    sourceAta,
    mint,
    custody,
    owner,
    amountRaw,
    NAVE_DECIMALS,
  );
}

/**
 * Read the owner's NAVE balance (base units). Returns 0n when the ATA does not
 * exist yet or is owned by a different program (i.e. the user holds no NAVE).
 */
export async function getNaveBalanceRaw(
  connection: Connection,
  owner: PublicKey,
): Promise<bigint> {
  const ata = await getNaveAtaAddress(owner);
  try {
    const account = await getAccount(connection, ata);
    return account.amount;
  } catch (err) {
    if (err instanceof TokenAccountNotFoundError || err instanceof TokenInvalidAccountOwnerError) {
      return 0n;
    }
    throw err;
  }
}
