import { readFileSync } from 'node:fs';
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, getAccount, createTransferInstruction } from '@solana/spl-token';
const RPC=process.env.SOLANA_DEVNET_RPC_URL || 'https://api.devnet.solana.com';
const c=new Connection(RPC,'confirmed');
const w=Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync('.deploy-wallet-devnet.json','utf8'))));
const MINT=new PublicKey('GmBMZuXsXpe7TZK27PTcXUyNGcuw9Ew8v3fxys7wM9Wa');
const COLLECTOR=new PublicKey('7HP36mTiamJDqF1rAHkWevKyw1jPy9Xw5pYg7YKFz1T');
const AMOUNT=200_000_000n; // 200 NAVE (6 decimals)
const dry=!process.argv.includes('--go');

const col=await getAccount(c,COLLECTOR);
console.log('collector mint:', col.mint.toBase58());
console.log('collector balance before:', (Number(col.amount)/1e6));
if(col.mint.toBase58()!==MINT.toBase58()){ throw new Error('collector mint mismatch!'); }

const srcAta=getAssociatedTokenAddressSync(MINT, w.publicKey);
const src=await getAccount(c,srcAta);
console.log('deploy wallet NAVE:', (Number(src.amount)/1e6));

if(dry){ console.log('DRY RUN — pass --go to transfer 200 NAVE to collector'); process.exit(0); }

const ix=createTransferInstruction(srcAta, COLLECTOR, w.publicKey, AMOUNT);
const sig=await sendAndConfirmTransaction(c, new Transaction().add(ix), [w], {commitment:'confirmed'});
console.log('transfer sig:', sig);
const after=await getAccount(c,COLLECTOR);
console.log('collector balance after:', (Number(after.amount)/1e6));
