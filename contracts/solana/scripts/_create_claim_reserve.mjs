// One-shot: create the STAKE_CLAIM_RESERVE token account on devnet — a fresh
// standalone NAVE token account OWNED by the relayer authority (like the
// collector), paid for by the deploy wallet. Prints only the new account
// address and the relayer pubkey (never the secret).
import { readFileSync } from 'node:fs';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { createInitializeAccountInstruction, getMinimumBalanceForRentExemptAccount, ACCOUNT_SIZE, TOKEN_PROGRAM_ID } from '@solana/spl-token';

const RPC = process.env.SOLANA_DEVNET_RPC_URL || 'https://api.devnet.solana.com';
const c = new Connection(RPC, 'confirmed');

function parseSecret(raw) {
  const s = raw.trim();
  if (s.startsWith('[')) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(s)));
  if (s.includes(',')) return Keypair.fromSecretKey(Uint8Array.from(s.split(',').map((n) => Number(n.trim()))));
  const decoded = Buffer.from(s, 'base64');
  if (decoded.length === 64) return Keypair.fromSecretKey(new Uint8Array(decoded));
  throw new Error('Unsupported secret format');
}

const relayer = parseSecret(readFileSync(process.env.RELAYER_SECRET_FILE, 'utf8'));
const payer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync('.deploy-wallet-devnet.json', 'utf8'))),
);
const MINT = new PublicKey('GmBMZuXsXpe7TZK27PTcXUyNGcuw9Ew8v3fxys7wM9Wa');

const reserve = Keypair.generate();
const rent = await getMinimumBalanceForRentExemptAccount(c);
const tx = new Transaction().add(
  SystemProgram.createAccount({
    fromPubkey: payer.publicKey,
    newAccountPubkey: reserve.publicKey,
    space: ACCOUNT_SIZE,
    lamports: rent,
    programId: TOKEN_PROGRAM_ID,
  }),
  createInitializeAccountInstruction(reserve.publicKey, MINT, relayer.publicKey),
);
const sig = await sendAndConfirmTransaction(c, tx, [payer, reserve], { commitment: 'confirmed' });
console.log('reserve account:', reserve.publicKey.toBase58());
console.log('owner (relayer):', relayer.publicKey.toBase58());
console.log('create sig:', sig);
