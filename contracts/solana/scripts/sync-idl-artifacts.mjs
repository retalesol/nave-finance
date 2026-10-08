#!/usr/bin/env node
/**
 * Copy Anchor IDL JSON (+ TS types when present) from target/idl into
 * solana/idl/ for repo consumers and CI drift checks.
 *
 * Run after `anchor build`:
 *   node scripts/sync-idl-artifacts.mjs
 */
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(root, 'target', 'idl');
const destDir = join(root, 'idl');

if (!existsSync(srcDir)) {
  console.error(`[sync-idl-artifacts] Missing ${srcDir}. Run anchor build first.`);
  process.exit(1);
}

mkdirSync(destDir, { recursive: true });
let copied = 0;
for (const file of readdirSync(srcDir)) {
  if (file.endsWith('.json')) {
    cpSync(join(srcDir, file), join(destDir, file));
    copied++;
  }
}
console.log(`[sync-idl-artifacts] Synced ${copied} IDL file(s) → ${destDir}`);
