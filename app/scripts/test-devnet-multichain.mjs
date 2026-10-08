#!/usr/bin/env node
/**
 * Unified devnet multichain test gate (manual).
 *
 * Phase 1 — sibling nave-contracts runners (optional flags)
 * Phase 2 — app read-only verifiers + beta go/no-go
 *
 * Usage:
 *   node scripts/test-devnet-multichain.mjs
 *   node scripts/test-devnet-multichain.mjs --contracts-only
 *   node scripts/test-devnet-multichain.mjs --solana-smoke --evm-chain-id 11155111
 *   node scripts/test-devnet-multichain.mjs --verifiers-only
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

config({ path: resolve(REPO_ROOT, '.env.local') });

function resolveContractsDir() {
  const fromEnv = process.env.NAVE_CONTRACTS_DIR?.trim();
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const monorepo = resolve(REPO_ROOT, '../contracts');
  if (existsSync(monorepo)) return monorepo;
  return null;
}

function run(label, cmd, args, cwd) {
  console.log(`\n${'='.repeat(72)}\n${label}\n${'='.repeat(72)}\n`);
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: false });
  const code = r.status ?? 1;
  if (code !== 0) {
    console.error(`\nFAIL: ${label} (exit ${code})`);
    process.exit(code);
  }
  console.log(`\nOK: ${label}`);
}

function syncCheckpointFromReports(contractsDir) {
  const reportsDir = resolve(contractsDir, 'test-results');
  const statePath =
    process.env.AGENTIC_E2E_STATE_FILE?.trim() ||
    resolve(REPO_ROOT, 'test-results/agentic-e2e-state.json');

  const updates = [];
  const solReport = resolve(reportsDir, 'solana-devnet-smoke.json');
  if (existsSync(solReport)) {
    try {
      const j = JSON.parse(readFileSync(solReport, 'utf8'));
      const addr = j.daoAddresses?.[0];
      if (addr) updates.push(['solana', addr]);
    } catch {
      /* ignore */
    }
  }
  for (const chainId of [11155111, 84532]) {
    const p = resolve(reportsDir, `evm-testnet-${chainId}.json`);
    if (!existsSync(p)) continue;
    try {
      const j = JSON.parse(readFileSync(p, 'utf8'));
      if (j.treasury) {
        const key = chainId === 11155111 ? 'evm_sepolia' : 'evm_base_sepolia';
        updates.push([key, j.treasury]);
      }
    } catch {
      /* ignore */
    }
  }

  if (!updates.length) return;

  console.log('\n=== Suggested checkpoint DAO addresses (from contract reports) ===\n');
  for (const [chain, addr] of updates) {
    console.log(`  npm run agentic-e2e:checkpoint -- set-dao ${chain} ${addr}`);
    if (existsSync(statePath)) {
      spawnSync(process.execPath, [
        resolve(REPO_ROOT, 'scripts/agentic-e2e-checkpoint.mjs'),
        'set-dao',
        chain,
        addr,
      ], { cwd: REPO_ROOT, stdio: 'inherit' });
    }
  }
}

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    contractsOnly: args.includes('--contracts-only'),
    verifiersOnly: args.includes('--verifiers-only'),
    solanaSmoke: args.includes('--solana-smoke'),
    solanaFull: args.includes('--solana-full'),
    evmChainId: (() => {
      const i = args.indexOf('--evm-chain-id');
      return i >= 0 && args[i + 1] ? Number(args[i + 1]) : null;
    })(),
    evmLive: args.includes('--evm-live'),
  };
}

function main() {
  const opts = parseArgs();
  const contractsDir = resolveContractsDir();
  if (!contractsDir && !opts.verifiersOnly) {
    console.error(
      'NAVE_CONTRACTS_DIR not found. Set it or place nave-contracts beside nave-app.',
    );
    process.exit(1);
  }

  if (!opts.verifiersOnly && contractsDir) {
    if (opts.solanaSmoke) {
      run(
        'Solana devnet smoke',
        'npm',
        ['run', 'test:devnet:solana:smoke'],
        contractsDir,
      );
    }
    if (opts.solanaFull) {
      run('Solana devnet full', 'npm', ['run', 'test:devnet:solana:full'], contractsDir);
    }
    if (opts.evmChainId) {
      const script = opts.evmLive ? 'test:devnet:evm:live' : 'test:devnet:evm';
      run(
        `EVM testnet ${opts.evmChainId}`,
        'npm',
        ['run', script, '--', '--chain-id', String(opts.evmChainId)],
        contractsDir,
      );
    }
    syncCheckpointFromReports(contractsDir);
  }

  if (opts.contractsOnly) {
    console.log('\nPASS: contracts phase only.\n');
    return;
  }

  run('agentic-e2e preflight', 'npm', ['run', 'agentic-e2e:preflight'], REPO_ROOT);
  run('verify:devnet-multichain', 'npm', ['run', 'verify:devnet-multichain'], REPO_ROOT);

  if (process.env.REQUIRE_EVM_DAOS === 'true') {
    run(
      'verify:devnet-multichain (strict)',
      process.execPath,
      [resolve(REPO_ROOT, 'scripts/devnet-multichain-verify.mjs')],
      REPO_ROOT,
    );
  }

  run('agentic-e2e:forge (local EVM regression)', 'npm', ['run', 'agentic-e2e:forge'], REPO_ROOT);

  if (process.env.SKIP_E2E_GATE !== '1') {
    run('verify:agentic-e2e-suite', 'npm', ['run', 'verify:agentic-e2e-suite'], REPO_ROOT);
  } else {
    console.log('\nSKIP: verify:agentic-e2e-suite (SKIP_E2E_GATE=1)\n');
  }

  run('beta:go-no-go', 'npm', ['run', 'beta:go-no-go'], REPO_ROOT);
  console.log('\nPASS: devnet multichain gate completed.\n');
}

main();
