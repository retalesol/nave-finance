import { createClient } from '@supabase/supabase-js';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
} from '@solana/spl-token';
import { resolveSolanaRpcUrl } from './programs.js';
import { confirmSolanaTransactionRobust, parseSolanaKeypair } from './solanaTxUtils.js';

// ─── NAVE devnet faucet (TESTNET) ────────────────────────────────────────────
// A dead-simple "type your address, get 0.1 NAVE" faucet for devnet testing.
// The faucet wallet is a dedicated, separately-funded Solana keypair (NOT the
// bridge custody authority and NOT the deploy/ops wallet) holding a NAVE
// balance + a small SOL balance for transaction fees.
//
// Anti-abuse posture:
//   - Recipient must already hold >= FAUCET_MIN_SOL_BALANCE devnet SOL (proves
//     it's a real, already-funded wallet rather than a throwaway address spun
//     up purely to drain the faucet).
//   - Dual rate limiting (enforced by the caller in index.ts, NOT here): one
//     claim per `FAUCET_CLAIM_COOLDOWN_HOURS` per RECIPIENT ADDRESS and,
//     independently, one claim per window per CALLER IP — both must pass, so
//     rotating IPs alone doesn't bypass the per-address cooldown and vice versa.

export interface FaucetConfig {
  enabled: boolean;
  solanaRpcUrl: string;
  naveMint: string;
  walletSecret: string | undefined;
  /** Raw NAVE base units sent per claim. */
  claimAmountRaw: bigint;
  /** Minimum devnet SOL (lamports) the recipient address must already hold. */
  minSolBalanceLamports: bigint;
  /** Lamports sent per SOL claim (same wallet, separate rate-limit keys). */
  solClaimAmountLamports: bigint;
  /** Claim cooldown, in hours, per address AND per IP (dual-checked by the caller). */
  cooldownHours: number;
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw !== undefined ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function readFaucetConfig(): FaucetConfig {
  const claimAmountNave = envNumber('FAUCET_CLAIM_AMOUNT_NAVE', 0.1);
  const minSolBalance = envNumber('FAUCET_MIN_SOL_BALANCE', 0.01);
  const solClaimAmount = envNumber('FAUCET_SOL_CLAIM_AMOUNT_SOL', 0.05);
  return {
    enabled: (process.env.FAUCET_ENABLED || '').trim().toLowerCase() === 'true',
    solanaRpcUrl: (process.env.FAUCET_SOLANA_RPC_URL || resolveSolanaRpcUrl()).trim(),
    naveMint: (process.env.FAUCET_NAVE_MINT || '').trim(),
    walletSecret: process.env.FAUCET_WALLET_SECRET,
    claimAmountRaw: BigInt(Math.round(claimAmountNave * 1_000_000)), // NAVE has 6 decimals
    minSolBalanceLamports: BigInt(Math.round(minSolBalance * 1_000_000_000)),
    solClaimAmountLamports: BigInt(Math.round(solClaimAmount * 1_000_000_000)),
    cooldownHours: envNumber('FAUCET_CLAIM_COOLDOWN_HOURS', 24),
  };
}

let _faucetWallet: Keypair | null = null;
function getFaucetWallet(cfg: FaucetConfig): Keypair {
  if (_faucetWallet) return _faucetWallet;
  if (!cfg.walletSecret) throw new Error('FAUCET_WALLET_SECRET is not configured');
  _faucetWallet = parseSolanaKeypair(cfg.walletSecret);
  return _faucetWallet;
}

let _faucetConnection: Connection | null = null;
function getFaucetConnection(cfg: FaucetConfig): Connection {
  if (_faucetConnection) return _faucetConnection;
  _faucetConnection = new Connection(cfg.solanaRpcUrl, 'confirmed');
  return _faucetConnection;
}

let _faucetSupabase: ReturnType<typeof createClient> | null = null;
function getFaucetSupabase(): ReturnType<typeof createClient> {
  if (_faucetSupabase) return _faucetSupabase;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured');
  _faucetSupabase = createClient(url, key);
  return _faucetSupabase;
}

async function accountExists(connection: Connection, address: PublicKey): Promise<boolean> {
  try {
    await getAccount(connection, address);
    return true;
  } catch {
    return false;
  }
}

/** Sanitize an error message for the HTTP response (no secrets / stack). */
function sanitizeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/0x[0-9a-fA-F]{64}/g, '0x…').slice(0, 300);
}

export interface FaucetClaimResult {
  signature: string;
  amountRaw: string;
}

/**
 * Send `claimAmountRaw` NAVE from the faucet wallet to `recipient`'s ATA
 * (created if missing, paid by the faucet wallet). Does NOT perform rate
 * limiting or the minimum-SOL-balance check — those are the caller's
 * responsibility (index.ts) so they compose with the shared `enforceLimits`
 * dual-dimension limiter the same way every other public endpoint does.
 */
export async function sendFaucetClaim(recipient: string): Promise<FaucetClaimResult> {
  const cfg = readFaucetConfig();
  if (!cfg.enabled) throw new Error('Faucet is disabled (set FAUCET_ENABLED=true)');
  if (!cfg.naveMint) throw new Error('FAUCET_NAVE_MINT is not configured');

  const connection = getFaucetConnection(cfg);
  const wallet = getFaucetWallet(cfg);
  const mint = new PublicKey(cfg.naveMint);
  const recipientOwner = new PublicKey(recipient);

  const mintInfo = await getMint(connection, mint);
  const decimals = mintInfo.decimals;

  const faucetAta = getAssociatedTokenAddressSync(mint, wallet.publicKey, true);
  const recipientAta = getAssociatedTokenAddressSync(mint, recipientOwner, true);

  const faucetBalance = await getAccount(connection, faucetAta).then((a) => a.amount);
  if (faucetBalance < cfg.claimAmountRaw) {
    throw new Error('Faucet is out of NAVE — please notify the Nave team.');
  }

  const instructions: TransactionInstruction[] = [];
  if (!(await accountExists(connection, recipientAta))) {
    instructions.push(
      createAssociatedTokenAccountInstruction(
        wallet.publicKey,
        recipientAta,
        recipientOwner,
        mint,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
    );
  }
  instructions.push(
    createTransferCheckedInstruction(faucetAta, mint, recipientAta, wallet.publicKey, cfg.claimAmountRaw, decimals),
  );

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const message = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  tx.sign([wallet]);

  const signature = await connection.sendTransaction(tx, { skipPreflight: false, maxRetries: 5 });
  await confirmSolanaTransactionRobust(connection, signature, blockhash, lastValidBlockHeight);

  await logFaucetClaim(recipient, cfg.claimAmountRaw, signature, 'NAVE');

  return { signature, amountRaw: cfg.claimAmountRaw.toString() };
}

/**
 * Send `solClaimAmountLamports` devnet SOL from the faucet wallet to
 * `recipient` (plain system transfer — same wallet that funds NAVE claims).
 * Rate limiting is the caller's responsibility (index.ts), same as the NAVE
 * claim. There is no minimum-balance eligibility check here: the whole point
 * of the SOL faucet is to fund addresses that have no SOL yet.
 */
export async function sendSolFaucetClaim(recipient: string): Promise<FaucetClaimResult> {
  const cfg = readFaucetConfig();
  if (!cfg.enabled) throw new Error('Faucet is disabled (set FAUCET_ENABLED=true)');

  const connection = getFaucetConnection(cfg);
  const wallet = getFaucetWallet(cfg);
  const recipientKey = new PublicKey(recipient);

  // Keep a reserve so the SOL faucet can never drain the wallet below what
  // the NAVE faucet needs for transaction fees + rent exemption.
  const reserveLamports = 20_000_000n; // 0.02 SOL
  const faucetBalance = BigInt(await connection.getBalance(wallet.publicKey, 'confirmed'));
  if (faucetBalance < cfg.solClaimAmountLamports + reserveLamports) {
    throw new Error('Faucet is out of SOL — please notify the Nave team.');
  }

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const message = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: blockhash,
    instructions: [
      SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey: recipientKey,
        lamports: cfg.solClaimAmountLamports,
      }),
    ],
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  tx.sign([wallet]);

  const signature = await connection.sendTransaction(tx, { skipPreflight: false, maxRetries: 5 });
  await confirmSolanaTransactionRobust(connection, signature, blockhash, lastValidBlockHeight);

  await logFaucetClaim(recipient, cfg.solClaimAmountLamports, signature, 'SOL');

  return { signature, amountRaw: cfg.solClaimAmountLamports.toString() };
}

/**
 * Best-effort audit log — never blocks the response on a logging failure.
 * The generated Supabase types don't include faucet_claims (added by
 * migration 1783000000); cast to a loose surface for this write.
 */
async function logFaucetClaim(recipient: string, amountRaw: bigint, signature: string, asset: 'NAVE' | 'SOL'): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const supabase = getFaucetSupabase() as any;
    await supabase.from('faucet_claims').insert({
      recipient,
      amount_raw: amountRaw.toString(),
      signature,
      asset,
    });
  } catch (err) {
    console.error('[faucet] audit log insert failed:', sanitizeError(err));
  }
}

/**
 * Check the recipient's devnet SOL balance against the configured minimum.
 * Returns the balance (lamports) alongside the pass/fail so the caller can
 * surface a precise "you have X, need Y" message.
 */
export async function checkMinSolBalance(
  recipient: string,
): Promise<{ ok: boolean; balanceLamports: bigint; minLamports: bigint }> {
  const cfg = readFaucetConfig();
  const connection = getFaucetConnection(cfg);
  const balance = await connection.getBalance(new PublicKey(recipient), 'confirmed');
  const balanceLamports = BigInt(balance);
  return { ok: balanceLamports >= cfg.minSolBalanceLamports, balanceLamports, minLamports: cfg.minSolBalanceLamports };
}
