#!/usr/bin/env node
/**
 * Load env for repo scripts that need Supabase + EVM RPC (indexer shape).
 *
 * Order (later wins for overlapping keys):
 *   1. .env.local (VITE_* and shared dev defaults)
 *   2. evm-indexer/.env.example (template — empty placeholders must not wipe prior vars)
 *   3. evm-indexer/.env (gitignored — put real secrets here for local runs)
 *
 * Then maps VITE_SUPABASE_URL → SUPABASE_URL if the latter is unset.
 *
 * Usage:
 *   node scripts/merge-evm-indexer-env.mjs -- node scripts/devnet-multichain-verify.mjs
 *   node scripts/merge-evm-indexer-env.mjs -- npm run verify:e2e-gate
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { config } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
process.chdir(root);

/** Empty assignments in templates must not mask fallbacks from `.env.local`. */
function unsetIfBlank(name) {
  if (!String(process.env[name] ?? '').trim()) {
    delete process.env[name];
  }
}

config({ path: resolve(root, '.env.local'), override: true });
config({ path: resolve(root, 'evm-indexer/.env.example'), override: true });
const envFile = resolve(root, 'evm-indexer/.env');
if (existsSync(envFile)) {
  config({ path: envFile, override: true });
}

for (const k of [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'NAVE_INDEXER_SECRET',
  'EVM_SEPOLIA_RPC_URL',
  'EVM_BASE_SEPOLIA_RPC_URL',
  'EVM_ETHEREUM_RPC_URL',
  'EVM_BASE_RPC_URL',
]) {
  unsetIfBlank(k);
}

if (!process.env.SUPABASE_URL?.trim() && process.env.VITE_SUPABASE_URL) {
  process.env.SUPABASE_URL = process.env.VITE_SUPABASE_URL;
}

if (!process.env.SUPABASE_URL?.trim() || !process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
  console.error(
    '[merge-evm-indexer-env] After merge: SUPABASE_URL=%s SUPABASE_SERVICE_ROLE_KEY=%s (set service role in evm-indexer/.env — not committed)',
    process.env.SUPABASE_URL ? 'set' : 'missing',
    process.env.SUPABASE_SERVICE_ROLE_KEY ? 'set' : 'missing',
  );
  process.exit(1);
}

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
if (sep === -1 || sep === argv.length - 1) {
  console.error('Usage: node scripts/merge-evm-indexer-env.mjs -- <command> [args...]');
  process.exit(1);
}
const cmd = argv[sep + 1];
const args = argv.slice(sep + 2);
const r = spawnSync(cmd, args, { stdio: 'inherit', env: process.env, shell: process.platform === 'win32' });
process.exit(r.status ?? 1);
