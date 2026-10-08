import { utils as anchorUtils } from '@coral-xyz/anchor';
import { Connection, Keypair } from '@solana/web3.js';

// ─── Shared Solana keypair + confirmation helpers ────────────────────────────
// Used by both the bridge relayer and the faucet relayer (and any future
// Solana-side relayer module) so the parsing/confirmation logic lives in one
// place instead of being duplicated per-module.

/**
 * Parse a Solana secret key in any of the formats this repo accepts: a JSON
 * byte array (`[1,2,...]`), comma-separated bytes, base64, or base58. Mirrors
 * the `loadOpsWallet` parsing in index.ts but also accepts base58.
 */
export function parseSolanaKeypair(raw: string): Keypair {
  const s = raw.trim();
  if (s.startsWith('[')) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(s) as number[]));
  }
  if (s.includes(',')) {
    return Keypair.fromSecretKey(Uint8Array.from(s.split(',').map((n) => Number(n.trim()))));
  }
  // base64 (64-byte secret key) — try first since it is the index.ts default.
  try {
    const decoded = Buffer.from(s, 'base64');
    if (decoded.length === 64) return Keypair.fromSecretKey(new Uint8Array(decoded));
  } catch {
    /* fall through to base58 */
  }
  // base58
  const bytes = anchorUtils.bytes.bs58.decode(s);
  return Keypair.fromSecretKey(new Uint8Array(bytes));
}

/**
 * Confirm a Solana transaction signature, tolerating the classic
 * `TransactionExpiredBlockheightExceededError` false negative: web3.js's
 * blockhash-based `confirmTransaction` can throw "has expired: block height
 * exceeded" purely because its polling loop outlasted the blockhash's valid
 * window — NOT because the transaction actually failed. The transaction can
 * (and often does) still land successfully; relying on the throw alone would
 * mark a successful release/mint/payout as 'failed' even though funds already
 * moved. On that specific error, fall back to the signature's real on-chain
 * status before deciding pass/fail.
 */
export async function confirmSolanaTransactionRobust(
  connection: Connection,
  signature: string,
  blockhash: string,
  lastValidBlockHeight: number,
): Promise<void> {
  try {
    const confirmation = await connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      'confirmed',
    );
    if (confirmation.value.err) {
      throw new Error(`transaction failed on-chain (sig ${signature}): ${JSON.stringify(confirmation.value.err)}`);
    }
    return;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isExpiryRace = /block height exceeded|has expired/i.test(message);
    if (!isExpiryRace) throw err;

    // Don't trust the timeout — check the signature's real on-chain status
    // (searchTransactionHistory covers the case where it already dropped out
    // of the RPC's recent-status cache by the time we check).
    const status = await connection.getSignatureStatus(signature, { searchTransactionHistory: true });
    const value = status.value;
    if (
      value &&
      value.err == null &&
      (value.confirmationStatus === 'confirmed' || value.confirmationStatus === 'finalized')
    ) {
      return; // Actually succeeded — confirmation polling just raced the blockhash window.
    }
    if (value && value.err) {
      throw new Error(`transaction failed on-chain (sig ${signature}): ${JSON.stringify(value.err)}`);
    }
    throw new Error(`transaction not confirmed (sig ${signature}): ${message}`);
  }
}
