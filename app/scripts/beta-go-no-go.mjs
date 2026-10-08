#!/usr/bin/env node
/**
 * Devnet public beta go/no-go checker (read-only).
 *
 * Validates configuration and optional live probes documented in the beta plan.
 * Does not mutate state. Exit 0 = ready, non-zero = blockers found.
 *
 * Required for full check:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *
 * Optional (enables deeper checks):
 *   SOLANA_RPC_URL, DAO_ADDRESS, NAVE_SIGNER_URL, NAVE_INDEXER_SECRET,
 *   NAVE_AGENT_SECRET, VITE_SUPABASE_URL (frontend health)
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
loadDotenv({ path: resolve(REPO_ROOT, '.env.local') });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DAO_ADDRESS = process.env.DAO_ADDRESS;
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL;
const SIGNER_URL = process.env.NAVE_SIGNER_URL;
const INDEXER_SECRET = process.env.NAVE_INDEXER_SECRET;
const AGENT_SECRET = process.env.NAVE_AGENT_SECRET;

const blockers = [];
const warnings = [];

function ok(msg) {
  console.log(`  ✓ ${msg}`);
}
function warn(msg) {
  warnings.push(msg);
  console.log(`  ⚠ ${msg}`);
}
function fail(msg) {
  blockers.push(msg);
  console.log(`  ✗ ${msg}`);
}

async function fetchJson(url, init = {}) {
  const res = await fetch(url, init);
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

async function checkEdgeHealth() {
  console.log('\n=== Edge function health ===');
  if (!SUPABASE_URL) {
    fail('SUPABASE_URL unset — cannot probe edge functions');
    return;
  }
  const base = SUPABASE_URL.replace(/\/$/, '');

  for (const [name, path] of [
    ['index-events', '/functions/v1/index-events?health=1'],
    ['snapshot-treasury', '/functions/v1/snapshot-treasury?health=1'],
  ]) {
    const { ok: healthy, data } = await fetchJson(`${base}${path}`);
    if (healthy && data?.ok) ok(`${name} health OK`);
    else fail(`${name} health failed (${JSON.stringify(data)})`);
  }

  // helius-webhook requires auth — skip unauthenticated probe; document instead.
  ok('helius-webhook: auth required (configure Authorization header only, no ?secret=)');
}

async function checkSecretsDistinct() {
  console.log('\n=== Secret hygiene (local env only) ===');
  const agent = process.env.NAVE_AGENT_SECRET;
  const signer = process.env.NAVE_SIGNER_SECRET;
  const indexer = process.env.NAVE_INDEXER_SECRET;
  if (!agent && !signer && !indexer) {
    warn('NAVE_*_SECRET not in env — run generate-secrets.mjs and set in Supabase/Railway');
    return;
  }
  if (agent && signer && agent === signer) fail('NAVE_AGENT_SECRET === NAVE_SIGNER_SECRET (must be distinct)');
  else if (agent && signer) ok('agent and signer secrets differ');
  if (agent && indexer && agent === indexer) fail('NAVE_AGENT_SECRET === NAVE_INDEXER_SECRET (must be distinct)');
  else if (agent && indexer) ok('agent and indexer secrets differ');
  if (signer && indexer && signer === indexer) fail('NAVE_SIGNER_SECRET === NAVE_INDEXER_SECRET (must be distinct)');
  else if (signer && indexer) ok('signer and indexer secrets differ');
}

async function checkSignerHealth() {
  console.log('\n=== Signer service ===');
  if (!SIGNER_URL) {
    warn('NAVE_SIGNER_URL unset — skip signer /health');
    return;
  }
  const { ok: healthy, data } = await fetchJson(`${SIGNER_URL.replace(/\/$/, '')}/health`);
  if (healthy && data?.ok) {
    ok(`signer /health OK (rpc: ${data.rpc})`);
    if (!data?.config?.signerSecret) warn('signer reports signerSecret not configured');
  } else fail(`signer /health failed`);
}

async function checkDaoGate() {
  console.log('\n=== E2E gate (optional DAO) ===');
  if (!DAO_ADDRESS || !SUPABASE_URL || !SERVICE_KEY) {
    warn('Set DAO_ADDRESS + Supabase creds to run verify-e2e-gate inline');
    return;
  }
  const { spawnSync } = await import('node:child_process');
  const env = { ...process.env, DAO_ADDRESS };
  const r = spawnSync('node', ['scripts/verify-e2e-gate.mjs'], {
    env,
    stdio: 'pipe',
    encoding: 'utf8',
  });
  if (r.status === 0) ok(`verify-e2e-gate passed for ${DAO_ADDRESS}`);
  else {
    fail(`verify-e2e-gate failed (exit ${r.status})`);
    if (r.stdout) console.log(r.stdout.slice(-2000));
  }
}

async function checkEscrowDefaults() {
  console.log('\n=== Escrow PDA defaults ===');
  const viteEscrow = process.env.VITE_ESCROW_PDA_ENABLED;
  const signerEscrow = process.env.NAVE_ESCROW_PDA_ENABLED;
  if (viteEscrow === 'false') warn('VITE_ESCROW_PDA_ENABLED=false — no distinct escrow SPL movement');
  else ok('VITE_ESCROW_PDA_ENABLED not false (distinct escrow enabled or unset→default on)');
  if (signerEscrow === 'false') warn('NAVE_ESCROW_PDA_ENABLED=false — signer uses vault as escrow');
  else ok('NAVE_ESCROW_PDA_ENABLED not false');
}

async function main() {
  console.log('=== Devnet public beta go/no-go ===');

  await checkEscrowDefaults();
  await checkSecretsDistinct();
  await checkEdgeHealth();
  await checkSignerHealth();
  await checkDaoGate();

  console.log(`\n=== Summary: ${blockers.length} blocker(s), ${warnings.length} warning(s) ===`);
  if (blockers.length) {
    console.log('\nBlockers:');
    for (const b of blockers) console.log(`  - ${b}`);
    process.exit(1);
  }
  if (warnings.length) {
    console.log('\nWarnings (review before launch):');
    for (const w of warnings) console.log(`  - ${w}`);
  }
  console.log('\nGO: no hard blockers detected.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
