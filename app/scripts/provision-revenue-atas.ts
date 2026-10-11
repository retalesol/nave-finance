#!/usr/bin/env node
/**
 * provision-revenue-atas.ts
 *
 * Creates Associated Token Accounts (ATAs) on the protocol revenue wallet for
 * every mint registered across all active DAOs, funding each from the payer
 * wallet. Run this before deploying a new DAO or adding a new asset to an
 * existing one.
 *
 * The 15% realized-yield skim transfers to the revenue wallet's ATA for the
 * relevant mint. The annual management fee is 0, so there is no collect tick.
 * If the ATA does not exist, a withdrawal that realizes yield will FAIL.
 *
 * Usage:
 *   npx tsx scripts/provision-revenue-atas.ts [--dry-run]
 *
 * Required env:
 *   SOLANA_RPC_URL                   Mainnet/devnet RPC endpoint
 *   NAVE_PROTOCOL_REVENUE_WALLET     Base58 pubkey of the revenue wallet
 *   NAVE_PAYER_SECRET                Base64 or comma-separated keypair bytes
 *                                    (payer for ATA creation rent; typically
 *                                     the same ops wallet as NAVE_OPS_WALLET_SECRET)
 *   SUPABASE_URL                     Supabase project URL (for DAO/mint listing)
 *   SUPABASE_SERVICE_ROLE_KEY        Supabase service-role key
 *
 * Optional:
 *   NAVE_MINTS                       Comma-separated list of mint pubkeys to
 *                                    provision. Overrides the DB-derived list.
 */

import { createClient } from '@supabase/supabase-js';
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';

// ── Config ─────────────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) { console.error(`FATAL: ${name} is required`); process.exit(1); }
  return v;
}

function loadKeypair(raw: string): Keypair {
  const cleaned = raw.trim();
  if (cleaned.startsWith('[')) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(cleaned)));
  const bytes = cleaned.includes(',')
    ? Uint8Array.from(cleaned.split(',').map(Number))
    : Buffer.from(cleaned, 'base64');
  return Keypair.fromSecretKey(bytes);
}

const DRY_RUN = process.argv.includes('--dry-run');

const rpcUrl       = requireEnv('SOLANA_RPC_URL');
const revenueWallet = new PublicKey(requireEnv('NAVE_PROTOCOL_REVENUE_WALLET'));
const payer        = loadKeypair(requireEnv('NAVE_PAYER_SECRET'));
const supabaseUrl  = requireEnv('SUPABASE_URL');
const supabaseKey  = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

const connection = new Connection(rpcUrl, 'confirmed');
const supabase   = createClient(supabaseUrl, supabaseKey);

// ── Discover mints ──────────────────────────────────────────────────────────

async function discoverMints(): Promise<PublicKey[]> {
  if (process.env.NAVE_MINTS) {
    return process.env.NAVE_MINTS.split(',').map(m => new PublicKey(m.trim()));
  }

  // Pull all registered asset mints from dao_registry / token_registry tables.
  // Fall back to well-known stablecoin mints (USDC mainnet) if DB is empty.
  const { data: assets, error } = await supabase
    .from('dao_registry')
    .select('dao_onchain_address');

  if (error) {
    console.warn('Could not query dao_registry:', error.message);
    console.warn('Falling back to NAVE_MINTS env or built-in defaults.');
  }

  // Collect mints from token registries stored in DB snapshot / activity logs.
  // The most reliable source is the treasury_snapshots table which records per-
  // asset balances, or the dao_registry.token_mint field.
  const mintSet = new Set<string>();

  if (assets && assets.length > 0) {
    // Read token/asset mint fields from each DAO registry row.
    const { data: registries } = await supabase
      .from('dao_registry')
      .select('token_mint, voting_mint')
      .not('token_mint', 'is', null);

    for (const r of registries ?? []) {
      if (r.token_mint) mintSet.add(r.token_mint);
      if (r.voting_mint) mintSet.add(r.voting_mint);
    }

    // Also pull mints from recent treasury snapshots (captures stablecoins etc).
    const { data: snapshots } = await supabase
      .from('treasury_snapshots')
      .select('strategy_positions')
      .order('snapshot_at', { ascending: false })
      .limit(20);

    for (const snap of snapshots ?? []) {
      for (const pos of (snap.strategy_positions ?? []) as Array<{ mint?: string }>) {
        if (pos.mint) mintSet.add(pos.mint);
      }
    }
  }

  if (mintSet.size === 0) {
    // Hard-coded well-known mainnet mints as a safety fallback.
    const KNOWN_MINTS = [
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
      'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
      'So11111111111111111111111111111111111111112',   // wSOL
    ];
    console.warn('No mints found in DB; using built-in mainnet defaults:', KNOWN_MINTS);
    for (const m of KNOWN_MINTS) mintSet.add(m);
  }

  return [...mintSet].map(m => new PublicKey(m));
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[provision-revenue-atas] Revenue wallet: ${revenueWallet.toBase58()}`);
  console.log(`[provision-revenue-atas] Payer:          ${payer.publicKey.toBase58()}`);
  console.log(`[provision-revenue-atas] RPC:            ${rpcUrl}`);
  console.log(`[provision-revenue-atas] Dry run:        ${DRY_RUN}`);
  console.log();

  const mints = await discoverMints();
  console.log(`[provision-revenue-atas] Mints to check (${mints.length}):`);
  for (const m of mints) console.log(`  - ${m.toBase58()}`);
  console.log();

  let created = 0;
  let alreadyExist = 0;
  const errors: string[] = [];

  for (const mint of mints) {
    const ata = getAssociatedTokenAddressSync(
      mint,
      revenueWallet,
      true, // allowOwnerOffCurve — revenue wallet may be a PDA; safe to set true
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );

    const existing = await connection.getAccountInfo(ata);
    if (existing) {
      console.log(`  ✓ ${mint.toBase58().slice(0, 8)}… ATA exists: ${ata.toBase58()}`);
      alreadyExist++;
      continue;
    }

    console.log(`  + ${mint.toBase58().slice(0, 8)}… creating ATA: ${ata.toBase58()}`);

    if (DRY_RUN) {
      created++;
      continue;
    }

    try {
      const ix = createAssociatedTokenAccountInstruction(
        payer.publicKey,
        ata,
        revenueWallet,
        mint,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      );
      const tx = new Transaction().add(ix);
      const sig = await sendAndConfirmTransaction(connection, tx, [payer]);
      console.log(`    sig: ${sig}`);
      created++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ✗ Failed for mint ${mint.toBase58()}: ${msg}`);
      errors.push(`${mint.toBase58()}: ${msg}`);
    }
  }

  console.log();
  console.log(`[provision-revenue-atas] Done.`);
  console.log(`  Created:      ${created}${DRY_RUN ? ' (dry-run, not sent)' : ''}`);
  console.log(`  Already exist: ${alreadyExist}`);
  if (errors.length > 0) {
    console.error(`  Errors (${errors.length}):`);
    for (const e of errors) console.error(`    - ${e}`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('[provision-revenue-atas] Fatal:', err);
  process.exit(1);
});
