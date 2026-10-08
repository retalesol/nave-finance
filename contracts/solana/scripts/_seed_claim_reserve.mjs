// One-shot: move test NAVE from the deploy wallet into the claim-on-demand
// reserve (STAKE_CLAIM_RESERVE). Funds stay parked until a staker claims.
import { readFileSync } from 'node:fs';
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, getAccount, createTransferInstruction } from '@solana/spl-token';

const RPC = process.env.SOLANA_DEVNET_RPC_URL || 'https://api.devnet.solana.com';
const c = new Connection(RPC, 'confirmed');
const payer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync('.deploy-wallet-devnet.json', 'utf8'))),
);
const MINT = new PublicKey('GmBMZuXsXpe7TZK27PTcXUyNGcuw9Ew8v3fxys7wM9Wa');
const RESERVE = new PublicKey('5qYUNj7U9vzszAQXh4242scSJdEbB8pALiGkqCGR22G5');
const AMOUNT = 50_000_000n; // 50 NAVE (6 decimals)

const srcAta = getAssociatedTokenAddressSync(MINT, payer.publicKey);
const tx = new Transaction().add(createTransferInstruction(srcAta, RESERVE, payer.publicKey, AMOUNT));
try {
  const sig = await sendAndConfirmTransaction(c, tx, [payer], { commitment: 'confirmed' });
  console.log('seed sig:', sig);
} catch (err) {
  // Devnet confirmation races are common — surface the signature either way.
  console.log('confirm error (tx may still land):', err.signature || err.message);
}
const bal = await getAccount(c, RESERVE);
console.log('reserve balance:', Number(bal.amount) / 1e6, 'NAVE');
