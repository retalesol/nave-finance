#!/usr/bin/env node
/**
 * Sync Anchor IDL JSON + generated TS types from the nave-contracts repo into
 * this app's src/idl/ directory. The IDL is the single source of truth for
 * instruction discriminators, argument encoding, and account layouts.
 *
 * Configure the contracts location with NAVE_CONTRACTS_DIR (absolute path to
 * the `contracts/solana` directory). Defaults to the sibling checkout used in
 * local development.
 */
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(__dirname, '..');
const destDir = join(appRoot, 'src', 'idl');

const contractsDir =
  process.env.NAVE_CONTRACTS_DIR ||
  resolve(appRoot, '..', 'contracts', 'solana');

const idlDir = join(contractsDir, 'target', 'idl');
const typesDir = join(contractsDir, 'target', 'types');

if (!existsSync(idlDir) || !existsSync(typesDir)) {
  console.error(
    `[sync-idl] Could not find Anchor build output.\n` +
      `  Expected: ${idlDir}\n` +
      `            ${typesDir}\n` +
      `  Set NAVE_CONTRACTS_DIR to the contracts/solana directory and run \`anchor build\` first.`,
  );
  process.exit(1);
}

mkdirSync(destDir, { recursive: true });

let copied = 0;
for (const file of readdirSync(idlDir)) {
  if (file.endsWith('.json')) {
    cpSync(join(idlDir, file), join(destDir, file));
    copied++;
  }
}
for (const file of readdirSync(typesDir)) {
  if (file.endsWith('.ts')) {
    cpSync(join(typesDir, file), join(destDir, file));
    copied++;
  }
}

console.log(`[sync-idl] Copied ${copied} files into ${destDir}`);
