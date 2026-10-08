#!/usr/bin/env node
/**
 * Load `.env.local` then run the three agentic multichain verifiers in order:
 *   1) verify:e2e-gate (Solana)
 *   2) verify:devnet-multichain (optional REQUIRE_EVM_DAOS from env)
 *   3) agentic-e2e:forge (Foundry E2ETest in sibling nave-contracts)
 *
 * Usage (from repo root):
 *   node scripts/agentic-e2e-run-verifiers.mjs
 *   REQUIRE_EVM_DAOS=true node scripts/agentic-e2e-run-verifiers.mjs
 */

import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

config({ path: resolve(REPO_ROOT, '.env.local') });

function run(label, argv) {
  console.log(`\n${'='.repeat(72)}\n${label}\n${'='.repeat(72)}\n`);
  const r = spawnSync(process.execPath, argv, {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env: { ...process.env },
    shell: false,
  });
  const code = r.status ?? 1;
  if (code !== 0) {
    console.error(`\nFAIL: ${label} exited ${code}`);
    process.exit(code);
  }
  console.log(`\nOK: ${label}`);
}

run('verify:e2e-gate (Solana)', [resolve(REPO_ROOT, 'scripts/verify-e2e-gate.mjs')]);
run('verify:devnet-multichain', [resolve(REPO_ROOT, 'scripts/devnet-multichain-verify.mjs')]);

const checkpoint = spawnSync(process.execPath, [resolve(REPO_ROOT, 'scripts/agentic-e2e-checkpoint.mjs'), 'run-forge'], {
  cwd: REPO_ROOT,
  stdio: 'inherit',
  env: { ...process.env },
  shell: false,
});
if ((checkpoint.status ?? 1) !== 0) {
  console.error('\nFAIL: agentic-e2e:forge (Foundry E2ETest)');
  process.exit(checkpoint.status ?? 1);
}
console.log('\nOK: agentic-e2e:forge (Foundry E2ETest)');

console.log('\nPASS: full agentic verifier suite completed.\n');
