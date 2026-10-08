// One-shot: return the collector's balance to the deploy wallet's NAVE ATA.
// The collector token account is owned by the relayer authority, so this signs
// with RELAYER_SECRET_FILE (a file containing the secret in any accepted
// format) — never paste the secret on the command line.
import { readFileSync } from 'node:fs';
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, getAccount, createTransferInstruction } from '@solana/spl-token';

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
const deployWallet = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync('.deploy-wallet-devnet.json', 'utf8'))),
);
const MINT = new PublicKey('GmBMZuXsXpe7TZK27PTcXUyNGcuw9Ew8v3fxys7wM9Wa');
const COLLECTOR = new PublicKey('7HP36mTiamJDqF1rAHkWevKyw1jPy9Xw5pYg7YKFz1T');

const col = await getAccount(c, COLLECTOR);
console.log('collector owner:', col.owner.toBase58());
console.log('relayer pubkey :', relayer.publicKey.toBase58());
console.log('collector balance:', Number(col.amount) / 1e6, 'NAVE');
if (col.amount === 0n) { console.log('nothing to retract'); process.exit(0); }
if (!col.owner.equals(relayer.publicKey)) throw new Error('relayer key does not own the collector — aborting');

const destAta = getAssociatedTokenAddressSync(MINT, deployWallet.publicKey);
const ix = createTransferInstruction(COLLECTOR, destAta, relayer.publicKey, col.amount);
// Deploy wallet pays the fee so the relayer's SOL is untouched.
const tx = new Transaction().add(ix);
tx.feePayer = deployWallet.publicKey;
const sig = await sendAndConfirmTransaction(c, tx, [deployWallet, relayer], { commitment: 'confirmed' });
console.log('retract sig:', sig);
const after = await getAccount(c, COLLECTOR);
console.log('collector balance after:', Number(after.amount) / 1e6, 'NAVE');
