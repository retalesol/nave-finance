import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import { assertEvmKekPolicy, isEvmKekConfigured, unwrapDek, unwrapEvmDek, type WrappedDek } from './kek.js';

// Audit 8g: NAVE_EVM_MASTER_KEK must never silently fall back to
// NAVE_MASTER_KEK in production.

function wrap(kek: Buffer, dek: Buffer): WrappedDek {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', kek, iv);
  const ct = Buffer.concat([cipher.update(dek), cipher.final()]);
  return { wrapped_dek: ct.toString('base64'), dek_wrap_iv: iv.toString('base64'), dek_wrap_tag: cipher.getAuthTag().toString('base64') };
}

const solanaKek = randomBytes(32);
const evmKek = randomBytes(32);
const dek = randomBytes(32);
const wrappedWithSolana = wrap(solanaKek, dek);
const wrappedWithEvm = wrap(evmKek, dek);

function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('outside production the EVM unwrap may fall back to NAVE_MASTER_KEK', () => {
  withEnv({ NODE_ENV: 'development', NAVE_MASTER_KEK: solanaKek.toString('base64'), NAVE_EVM_MASTER_KEK: undefined }, () => {
    assert.equal(isEvmKekConfigured(), true);
    assert.doesNotThrow(() => assertEvmKekPolicy());
    assert.equal(unwrapEvmDek(wrappedWithSolana), dek.toString('base64'));
  });
});

test('in production a missing NAVE_EVM_MASTER_KEK fails the boot policy and refuses to unwrap', () => {
  withEnv({ NODE_ENV: 'production', NAVE_MASTER_KEK: solanaKek.toString('base64'), NAVE_EVM_MASTER_KEK: undefined }, () => {
    assert.equal(isEvmKekConfigured(), false, 'no silent fallback in production');
    assert.throws(() => assertEvmKekPolicy(), /NAVE_EVM_MASTER_KEK is not set/);
    assert.throws(() => unwrapEvmDek(wrappedWithSolana), /production refuses the NAVE_MASTER_KEK fallback/);
    // The Solana path is unaffected.
    assert.equal(unwrapDek(wrappedWithSolana), dek.toString('base64'));
  });
});

test('in production a dedicated NAVE_EVM_MASTER_KEK is used (and only it)', () => {
  withEnv(
    { NODE_ENV: 'production', NAVE_MASTER_KEK: solanaKek.toString('base64'), NAVE_EVM_MASTER_KEK: evmKek.toString('base64') },
    () => {
      assert.equal(isEvmKekConfigured(), true);
      assert.doesNotThrow(() => assertEvmKekPolicy());
      assert.equal(unwrapEvmDek(wrappedWithEvm), dek.toString('base64'));
      // A DEK wrapped with the Solana KEK must NOT unwrap through the EVM path.
      assert.throws(() => unwrapEvmDek(wrappedWithSolana));
    },
  );
});

test('a malformed NAVE_EVM_MASTER_KEK fails at boot, not on first use', () => {
  withEnv({ NODE_ENV: 'production', NAVE_EVM_MASTER_KEK: Buffer.alloc(16).toString('base64') }, () => {
    assert.throws(() => assertEvmKekPolicy(), /must decode to 32 bytes/);
  });
});
