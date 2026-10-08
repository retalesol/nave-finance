#!/usr/bin/env node
/**
 * Sync EVM contract ABIs from the Foundry build output in nave-contracts into
 * this app's src/abi/ directory. The ABI is the single source of truth for the
 * EVM function/read/event surface (the viem clients are typed against it).
 *
 * Foundry writes per-contract artifacts to `contracts/evm/out/<Name>.sol/<Name>.json`
 * with the ABI under the `.abi` key. This script extracts just the `.abi` array
 * and writes `src/abi/<Name>.json`, matching the placeholder files committed
 * today (which scaffold the Part A surface until the contracts are built).
 *
 * Configure the contracts location with NAVE_EVM_CONTRACTS_DIR (absolute path to
 * the `contracts/evm` directory). Defaults to the sibling checkout used in local
 * development.
 *
 * NOTE: This mirrors scripts/sync-idl.mjs (the Anchor IDL sync) for the EVM side.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(__dirname, '..');
const destDir = join(appRoot, 'src', 'abi');

const contractsDir =
  process.env.NAVE_EVM_CONTRACTS_DIR ||
  resolve(appRoot, '..', 'contracts', 'evm');

const outDir = join(contractsDir, 'out');

// Soft mode (`--allow-missing`): when the Foundry build output is absent, warn
// and exit 0 instead of failing. Used by the `prebuild` hook so a Solana-only
// or contracts-not-built environment can still `npm run build` (placeholders
// are retained). An explicit `npm run sync-abi` stays strict (fails closed).
const ALLOW_MISSING = process.argv.includes('--allow-missing');

// The logical contract set the app binds to. ERC20.json is hand-maintained
// (it is not a Nave contract), so it is intentionally excluded from sync.
const CONTRACTS = [
  'NaveProtocol',
  'NaveDAOFactory',
  'NaveTreasury',
  'NaveGovernor',
  'NaveExecution',
  'NaveDaoStake',
];

if (!existsSync(outDir)) {
  const msg =
    `[sync-abi] Could not find Foundry build output.\n` +
    `  Expected: ${outDir}\n` +
    `  Set NAVE_EVM_CONTRACTS_DIR to the contracts/evm directory and run \`forge build\` first.\n` +
    `  (The committed src/abi/*.json placeholders remain in use until then.)`;
  if (ALLOW_MISSING) {
    console.warn(`${msg}\n[sync-abi] --allow-missing set: skipping ABI sync (placeholders retained).`);
    process.exit(0);
  }
  console.error(msg);
  process.exit(1);
}

mkdirSync(destDir, { recursive: true });

let copied = 0;
const missing = [];
for (const name of CONTRACTS) {
  const artifactPath = join(outDir, `${name}.sol`, `${name}.json`);
  if (!existsSync(artifactPath)) {
    missing.push(name);
    continue;
  }
  const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
  if (!Array.isArray(artifact.abi)) {
    console.error(`[sync-abi] ${artifactPath} has no \`abi\` array — skipping.`);
    continue;
  }
  writeFileSync(join(destDir, `${name}.json`), JSON.stringify(artifact.abi, null, 2) + '\n');
  copied++;
}

// Stamp a meta file so the app can tell synced ABIs apart from placeholders.
writeFileSync(
  join(destDir, 'abi.meta.json'),
  JSON.stringify({ syncedAt: new Date().toISOString(), source: outDir, contracts: CONTRACTS, missing }, null, 2) + '\n',
);

if (missing.length) {
  console.warn(`[sync-abi] WARNING: missing artifacts for: ${missing.join(', ')} (placeholders retained).`);
}
console.log(`[sync-abi] Wrote ${copied} ABI file(s) into ${destDir}`);
