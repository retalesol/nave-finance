#!/usr/bin/env node
/**
 * Generate distinct high-entropy bearer secrets for Nave devnet beta.
 *
 * Outputs three independent values (never reuse the same secret across roles).
 * Copy each into the appropriate runtime secret store — do NOT commit these.
 *
 * Usage:
 *   node scripts/generate-secrets.mjs
 *   node scripts/generate-secrets.mjs --kek   # also print a NAVE_MASTER_KEK candidate
 */

import { randomBytes } from 'node:crypto';

const includeKek = process.argv.includes('--kek');

function hexSecret() {
  return randomBytes(32).toString('hex');
}

console.log('\n=== Nave bearer secrets (openssl-equivalent: openssl rand -hex 32) ===\n');
console.log(`NAVE_AGENT_SECRET=${hexSecret()}`);
console.log(`NAVE_SIGNER_SECRET=${hexSecret()}`);
console.log(`NAVE_INDEXER_SECRET=${hexSecret()}`);
if (includeKek) {
  console.log(`NAVE_MASTER_KEK=${randomBytes(32).toString('base64')}`);
}
console.log('\nSet in Supabase:  supabase secrets set NAVE_AGENT_SECRET=... NAVE_INDEXER_SECRET=... NAVE_MASTER_KEK=...');
console.log('Set on Railway (signer): NAVE_SIGNER_SECRET, NAVE_MASTER_KEK');
console.log('Rotate any previously shared or equal values before public beta.\n');
