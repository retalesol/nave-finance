#!/usr/bin/env node
/**
 * Master-KEK re-wrap job (see scripts/rotate-kek.md and docs/SECRETS.md).
 *
 * Rotating NAVE_MASTER_KEK requires re-wrapping every agent DEK: for each active
 * row in `encrypted_agent_keys`, unwrap `wrapped_dek` with the OLD KEK and
 * re-wrap it with the NEW KEK, writing back wrapped_dek/dek_wrap_iv/dek_wrap_tag.
 * The agent private key ciphertext (encrypted_private_key) is NOT touched — only
 * the envelope around its DEK changes — so the agent keypairs are unchanged.
 *
 * Each row is validated end-to-end before write-back: the DEK must still decrypt
 * the agent private key to the stored public_key. A row that fails validation is
 * reported and skipped (never written), so a bad OLD KEK can't corrupt the table.
 *
 * Required env:
 *   SUPABASE_URL                Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY   service-role key (read/write encrypted_agent_keys)
 *   NAVE_MASTER_KEK_OLD         current KEK (base64 32 bytes)
 *   NAVE_MASTER_KEK_NEW         new KEK (base64 32 bytes) — e.g. `openssl rand -base64 32`
 * Optional env:
 *   DRY_RUN=true                validate + re-wrap in memory but do NOT write back
 */

import { createCipheriv, createDecipheriv } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { Keypair } from '@solana/web3.js';

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  NAVE_MASTER_KEK_OLD,
  NAVE_MASTER_KEK_NEW,
  DRY_RUN,
} = process.env;

const dryRun = String(DRY_RUN).toLowerCase() === 'true';

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !NAVE_MASTER_KEK_OLD || !NAVE_MASTER_KEK_NEW) {
  console.error(
    'Missing env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, NAVE_MASTER_KEK_OLD, NAVE_MASTER_KEK_NEW are required.',
  );
  process.exit(1);
}

function loadKek(b64, label) {
  const key = Buffer.from(b64, 'base64');
  if (key.length !== 32) {
    console.error(`${label} must decode to exactly 32 bytes (got ${key.length}).`);
    process.exit(1);
  }
  return key;
}

const OLD_KEK = loadKek(NAVE_MASTER_KEK_OLD, 'NAVE_MASTER_KEK_OLD');
const NEW_KEK = loadKek(NAVE_MASTER_KEK_NEW, 'NAVE_MASTER_KEK_NEW');

if (OLD_KEK.equals(NEW_KEK)) {
  console.error('OLD and NEW KEK are identical — nothing to rotate.');
  process.exit(1);
}

/** AES-256-GCM decrypt: ciphertext + tag stored separately (base64). */
function gcmDecrypt(key, ivB64, ctB64, tagB64) {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]);
}

/** AES-256-GCM encrypt a buffer; returns { ct, iv, tag } as base64. */
function gcmEncrypt(key, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = createCipheriv('aes-256-gcm', key, Buffer.from(iv));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    wrapped_dek: ct.toString('base64'),
    dek_wrap_iv: Buffer.from(iv).toString('base64'),
    dek_wrap_tag: cipher.getAuthTag().toString('base64'),
  };
}

async function main() {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: rows, error } = await supabase
    .from('encrypted_agent_keys')
    .select(
      'id, dao_onchain_address, agent_role, public_key, encrypted_private_key, encryption_iv, encryption_tag, wrapped_dek, dek_wrap_iv, dek_wrap_tag, dek_wrap_version, is_active',
    )
    .eq('is_active', true);

  if (error) {
    console.error('Failed to read encrypted_agent_keys:', error.message);
    process.exit(1);
  }

  console.log(`\n=== KEK re-wrap (${dryRun ? 'DRY RUN' : 'LIVE'}): ${rows.length} active rows ===\n`);

  // ── Phase 1: Validate and re-wrap ALL rows in memory. No DB writes yet. ──
  // Separating validation from write-back prevents a partial-update window: if
  // any row fails validation, we exit before touching the database. A mid-write
  // failure would leave some rows wrapped with NEW_KEK while the env still
  // carries OLD_KEK → those agent keys would silently break until manually
  // recovered. By gathering all updates first, we ensure the ONLY way to end up
  // with mixed KEK wrapping is a true database connectivity failure during write-
  // back (recoverable by re-running the script with OLD_KEK still in env, since
  // successfully-written rows are idempotent — re-wrapping an already-new-KEK row
  // with NEW_KEK again just costs one extra decrypt/encrypt round-trip).
  const pendingUpdates = []; // { id, tag, ...newEnvelope }
  const failures = [];
  let skipped = 0;

  for (const row of rows) {
    const tag = `${row.agent_role}@${row.dao_onchain_address}`;
    if (!row.wrapped_dek || !row.dek_wrap_iv || !row.dek_wrap_tag) {
      console.log(`  · ${tag}: no wrapped DEK — skipped (legacy row)`);
      skipped += 1;
      continue;
    }
    if (Number(row.dek_wrap_version ?? 1) !== 1) {
      console.log(`  · ${tag}: v2 envelope — rotate with scripts/rewrap-role-keks.mjs`);
      skipped += 1;
      continue;
    }
    try {
      // 1. Unwrap DEK with OLD KEK.
      const dek = gcmDecrypt(OLD_KEK, row.dek_wrap_iv, row.wrapped_dek, row.dek_wrap_tag);

      // 2. Validate: DEK must decrypt the agent key to the stored public_key.
      const secret = gcmDecrypt(dek, row.encryption_iv, row.encrypted_private_key, row.encryption_tag);
      const kp = Keypair.fromSecretKey(new Uint8Array(secret));
      if (kp.publicKey.toBase58() !== row.public_key) {
        failures.push(`${tag}: decrypted keypair pubkey mismatch (bad OLD KEK?)`);
        continue;
      }

      // 3. Re-wrap the DEK with NEW KEK.
      const next = gcmEncrypt(NEW_KEK, dek);

      // 4. Sanity check the new envelope unwraps to the same DEK.
      const check = gcmDecrypt(NEW_KEK, next.dek_wrap_iv, next.wrapped_dek, next.dek_wrap_tag);
      if (!check.equals(dek)) {
        failures.push(`${tag}: re-wrap self-check failed`);
        continue;
      }

      console.log(`  ✓ ${tag}: validated (pending write)`);
      pendingUpdates.push({ id: row.id, tag, ...next });
    } catch (e) {
      failures.push(`${tag}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Fail before any writes if validation found problems.
  if (failures.length > 0) {
    console.log('\n=== VALIDATION FAILURES (no rows written) ===');
    for (const f of failures) console.log(`  - ${f}`);
    console.log('\nDo NOT swap NAVE_MASTER_KEK until all rows re-wrap cleanly.');
    process.exit(2);
  }

  console.log(`\n  All ${pendingUpdates.length} rows validated OK (${skipped} skipped).`);

  if (dryRun) {
    console.log('\nDry run OK — no rows written. Re-run without DRY_RUN to write, then swap NAVE_MASTER_KEK in edge + signer env.');
    return;
  }

  // ── Phase 2: Write back all validated updates. ──
  // All rows passed validation above; now persist the new envelopes. Any write
  // failure is logged with the row ID so a partial state can be diagnosed and
  // completed by re-running the script (which will re-wrap already-updated rows
  // idempotently — unwrap with NEW_KEK, re-wrap with NEW_KEK, no change).
  let rewrapped = 0;
  const writeFailures = [];

  for (const update of pendingUpdates) {
    const { error: upErr } = await supabase
      .from('encrypted_agent_keys')
      .update({
        wrapped_dek: update.wrapped_dek,
        dek_wrap_iv: update.dek_wrap_iv,
        dek_wrap_tag: update.dek_wrap_tag,
      })
      .eq('id', update.id);
    if (upErr) {
      writeFailures.push(`${update.tag} (id=${update.id}): write-back failed: ${upErr.message}`);
    } else {
      console.log(`  ✓ ${update.tag}: written`);
      rewrapped += 1;
    }
  }

  console.log(`\n=== summary: ${rewrapped} re-wrapped, ${skipped} skipped, ${writeFailures.length} write-failures ===`);
  if (writeFailures.length > 0) {
    console.log('WRITE FAILURES (partial state — re-run to complete):');
    for (const f of writeFailures) console.log(`  - ${f}`);
    console.log('\nDo NOT swap NAVE_MASTER_KEK yet. Re-run the script; successfully-written rows are idempotent.');
    process.exit(2);
  }
  console.log('\nAll rows re-wrapped. Now swap NAVE_MASTER_KEK -> the NEW value in edge + signer env.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
