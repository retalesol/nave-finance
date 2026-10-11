#!/usr/bin/env node
/**
 * Re-wrap agent and guardian DEKs into the v2 envelope: per-role KEK plus
 * AES-GCM associated data `nave-dek:v2|<dao>|<role>|<chain>`.
 *
 * For every active row in `encrypted_agent_keys` (Solana) and
 * `encrypted_evm_keys` (EVM):
 *   1. unwrap the DEK as stored (v1: family master KEK; v2: per dek_kek_ref + AAD),
 *   2. prove the DEK still decrypts the private key to the stored public key /
 *      address,
 *   3. re-wrap it with the role KEK (or the master KEK when no role KEK is set)
 *      bound to the row, and self-check the new envelope.
 * Every row is validated before anything is written; one failure writes nothing.
 * The private-key ciphertext is never touched, so agent addresses do not change.
 *
 * Env (read from the environment; nothing is printed):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   NAVE_MASTER_KEK                 Solana master KEK (v1 rows / 'master' rows)
 *   NAVE_EVM_MASTER_KEK             EVM master KEK (falls back to NAVE_MASTER_KEK)
 *   NAVE_KEK_<ROLE>                 Solana per-role KEKs (EXECUTIVE, FINANCIAL, OVERSIGHT, OPERATIONAL)
 *   NAVE_EVM_KEK_<ROLE>             EVM per-role KEKs (adds GUARDIAN)
 *   REQUIRE_ROLE_KEKS=true          fail if any row's role KEK is missing
 *   APPLY=true                      write the new envelopes (default is a dry run)
 *
 * Deploy the role KEKs to the signer and the key-generation edge functions
 * before running with APPLY=true; the signer reads `dek_kek_ref` per row, so
 * rows can be migrated while it is live.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { Keypair } from '@solana/web3.js';
import { privateKeyToAccount } from 'viem/accounts';

const env = process.env;
const apply = String(env.APPLY).toLowerCase() === 'true';
const requireRoleKeks = String(env.REQUIRE_ROLE_KEKS).toLowerCase() === 'true';

if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing env: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
  process.exit(1);
}

function loadKek(name) {
  const raw = env[name];
  if (!raw) return null;
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    console.error(`${name} must decode to exactly 32 bytes.`);
    process.exit(1);
  }
  return key;
}

function roleKekName(family, role) {
  const base = role.split('#')[0].toUpperCase();
  return family === 'evm' ? `NAVE_EVM_KEK_${base}` : `NAVE_KEK_${base}`;
}

function masterKek(family) {
  return family === 'evm'
    ? loadKek('NAVE_EVM_MASTER_KEK') ?? loadKek('NAVE_MASTER_KEK')
    : loadKek('NAVE_MASTER_KEK');
}

function aad(binding) {
  return Buffer.from(`nave-dek:v2|${binding.dao}|${binding.role}|${binding.chain}`, 'utf8');
}

function gcmDecrypt(key, ivB64, ctB64, tagB64, associated) {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  if (associated) decipher.setAAD(associated);
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]);
}

function gcmEncrypt(key, plaintext, associated) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(associated);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    wrapped_dek: ct.toString('base64'),
    dek_wrap_iv: iv.toString('base64'),
    dek_wrap_tag: cipher.getAuthTag().toString('base64'),
  };
}

function unwrapStored(family, row, binding) {
  const version = Number(row.dek_wrap_version ?? 1);
  if (version === 1) {
    const kek = masterKek(family);
    if (!kek) throw new Error(`no ${family} master KEK to unwrap a v1 row`);
    return gcmDecrypt(kek, row.dek_wrap_iv, row.wrapped_dek, row.dek_wrap_tag);
  }
  const kek = row.dek_kek_ref === 'role' ? loadKek(roleKekName(family, binding.role)) : masterKek(family);
  if (!kek) throw new Error(`KEK for dek_kek_ref='${row.dek_kek_ref}' is not configured`);
  return gcmDecrypt(kek, row.dek_wrap_iv, row.wrapped_dek, row.dek_wrap_tag, aad(binding));
}

function verifySolana(row, dek) {
  const secret = gcmDecrypt(dek, row.encryption_iv, row.encrypted_private_key, row.encryption_tag);
  return Keypair.fromSecretKey(new Uint8Array(secret)).publicKey.toBase58() === row.public_key;
}

function verifyEvm(row, dek) {
  const plain = gcmDecrypt(dek, row.encryption_iv, row.encrypted_private_key, row.encryption_tag);
  let hex;
  if (plain.length === 32) hex = `0x${plain.toString('hex')}`;
  else {
    const s = plain.toString('utf8').trim();
    hex = s.startsWith('0x') ? s : `0x${s}`;
  }
  return privateKeyToAccount(hex).address.toLowerCase() === String(row.evm_address).toLowerCase();
}

const TABLES = [
  {
    family: 'solana',
    table: 'encrypted_agent_keys',
    columns:
      'id, dao_onchain_address, agent_role, public_key, encrypted_private_key, encryption_iv, encryption_tag, wrapped_dek, dek_wrap_iv, dek_wrap_tag, dek_wrap_version, dek_kek_ref',
    binding: (r) => ({ dao: r.dao_onchain_address, role: r.agent_role, chain: 'solana' }),
    verify: verifySolana,
  },
  {
    family: 'evm',
    table: 'encrypted_evm_keys',
    columns:
      'id, dao_onchain_address, chain_id, signer_role, guardian_index, evm_address, encrypted_private_key, encryption_iv, encryption_tag, wrapped_dek, dek_wrap_iv, dek_wrap_tag, dek_wrap_version, dek_kek_ref',
    binding: (r) => ({
      dao: String(r.dao_onchain_address).toLowerCase(),
      role: r.guardian_index === null || r.guardian_index === undefined ? r.signer_role : `guardian#${r.guardian_index}`,
      chain: `evm:${r.chain_id}`,
    }),
    verify: verifyEvm,
  },
];

async function main() {
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  const updates = [];
  const failures = [];
  let skipped = 0;

  for (const spec of TABLES) {
    const { data: rows, error } = await supabase.from(spec.table).select(spec.columns).eq('is_active', true);
    if (error) {
      console.error(`Failed to read ${spec.table}: ${error.message}`);
      process.exit(1);
    }
    console.log(`\n${spec.table}: ${rows.length} active rows`);
    for (const row of rows) {
      const binding = spec.binding(row);
      const label = `${spec.table} ${binding.role}@${binding.dao} (${binding.chain})`;
      if (!row.wrapped_dek || !row.dek_wrap_iv || !row.dek_wrap_tag) {
        console.log(`  · ${label}: no wrapped DEK, skipped`);
        skipped += 1;
        continue;
      }
      if (String(binding.dao).startsWith('pending:')) {
        console.log(`  · ${label}: unbound pending row, skipped`);
        skipped += 1;
        continue;
      }
      try {
        const dek = unwrapStored(spec.family, row, binding);
        if (!spec.verify(row, dek)) {
          failures.push(`${label}: DEK does not decrypt to the stored key`);
          continue;
        }
        const roleName = roleKekName(spec.family, binding.role);
        const roleKek = loadKek(roleName);
        if (!roleKek && requireRoleKeks) {
          failures.push(`${label}: ${roleName} is not configured`);
          continue;
        }
        const kek = roleKek ?? masterKek(spec.family);
        const next = gcmEncrypt(kek, dek, aad(binding));
        const check = gcmDecrypt(kek, next.dek_wrap_iv, next.wrapped_dek, next.dek_wrap_tag, aad(binding));
        if (!check.equals(dek)) {
          failures.push(`${label}: re-wrap self-check failed`);
          continue;
        }
        updates.push({
          table: spec.table,
          id: row.id,
          label,
          envelope: { ...next, dek_wrap_version: 2, dek_kek_ref: roleKek ? 'role' : 'master' },
        });
        console.log(`  ✓ ${label}: validated (${roleKek ? 'role KEK' : 'master KEK'})`);
      } catch (e) {
        failures.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  if (failures.length > 0) {
    console.log('\nValidation failures (nothing written):');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(2);
  }
  console.log(`\n${updates.length} rows ready, ${skipped} skipped.`);
  if (!apply) {
    console.log('Dry run: nothing written. Re-run with APPLY=true to write.');
    return;
  }

  const writeFailures = [];
  for (const u of updates) {
    const { error } = await supabase.from(u.table).update(u.envelope).eq('id', u.id);
    if (error) writeFailures.push(`${u.label}: ${error.message}`);
  }
  if (writeFailures.length > 0) {
    console.log('Write failures (re-run to finish; written rows re-wrap idempotently):');
    for (const f of writeFailures) console.log(`  - ${f}`);
    process.exit(2);
  }
  console.log(`Re-wrapped ${updates.length} rows.`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
