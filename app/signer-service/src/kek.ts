import { createDecipheriv } from 'node:crypto';

// Node-side counterpart to supabase/functions/_shared/kek.ts. Unwraps a
// persisted data key (DEK) using the master key-encryption-key (KEK) held in
// the signer's environment, so the orchestrator never has to ship raw decrypt
// keys over the wire.
//
// NAVE_MASTER_KEK must be a base64-encoded 32-byte (256-bit) key.

export interface WrappedDek {
  wrapped_dek: string;
  dek_wrap_iv: string;
  dek_wrap_tag: string;
}

const cachedKeks = new Map<string, Buffer>();

function loadKekFromEnv(envName: string): Buffer {
  const raw = process.env[envName];
  if (!raw) throw new Error(`${envName} is not configured`);
  // Cache per (env name, value) so a rotated/changed env is never served stale.
  const cacheKey = `${envName}:${raw}`;
  const cached = cachedKeks.get(cacheKey);
  if (cached) return cached;
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error(`${envName} must decode to 32 bytes`);
  cachedKeks.set(cacheKey, key);
  return key;
}

function getMasterKek(): Buffer {
  return loadKekFromEnv('NAVE_MASTER_KEK');
}

export function isKekConfigured(): boolean {
  return Boolean(process.env.NAVE_MASTER_KEK);
}

/** True when NODE_ENV=production — the EVM KEK may never fall back to the Solana KEK there. */
export function isProductionEnv(): boolean {
  return (process.env.NODE_ENV || '').trim().toLowerCase() === 'production';
}

/**
 * Whether the dedicated EVM KEK may fall back to the shared NAVE_MASTER_KEK.
 * Development/test convenience ONLY: in production a missing
 * NAVE_EVM_MASTER_KEK must fail loudly (see {@link assertEvmKekPolicy}) instead
 * of silently unwrapping EVM signing keys with the Solana master key, which
 * collapses the two custody domains into one.
 */
function evmKekFallbackAllowed(): boolean {
  return !isProductionEnv();
}

/** Env var the EVM unwrap path will actually use, or null when none is usable. */
function resolveEvmKekEnvName(): 'NAVE_EVM_MASTER_KEK' | 'NAVE_MASTER_KEK' | null {
  if (process.env.NAVE_EVM_MASTER_KEK) return 'NAVE_EVM_MASTER_KEK';
  if (evmKekFallbackAllowed() && process.env.NAVE_MASTER_KEK) return 'NAVE_MASTER_KEK';
  return null;
}

/**
 * Whether an EVM-signing KEK is available. EVM secrets are kept distinct from
 * Solana: NAVE_EVM_MASTER_KEK is required in production; outside production
 * the shared NAVE_MASTER_KEK is accepted as a fallback.
 */
export function isEvmKekConfigured(): boolean {
  return resolveEvmKekEnvName() !== null;
}

/**
 * Boot-time policy check (audit 8g). Throws when NODE_ENV=production and
 * NAVE_EVM_MASTER_KEK is unset while NAVE_MASTER_KEK is set — the exact
 * configuration in which the old code silently fell back. A production deploy
 * with NEITHER key set is left to the Solana KEK check (`isKekConfigured`).
 * Also validates that a configured EVM KEK decodes to 32 bytes so a typo fails
 * at boot rather than on the first EVM signature.
 */
export function assertEvmKekPolicy(): void {
  if (process.env.NAVE_EVM_MASTER_KEK) {
    loadKekFromEnv('NAVE_EVM_MASTER_KEK');
    return;
  }
  if (isProductionEnv() && process.env.NAVE_MASTER_KEK) {
    throw new Error(
      'NAVE_EVM_MASTER_KEK is not set. In production the EVM signing KEK must be a dedicated key — ' +
        'falling back to NAVE_MASTER_KEK is disabled. Set NAVE_EVM_MASTER_KEK (base64, 32 bytes).',
    );
  }
}

function unwrapWithKek(kek: Buffer, w: WrappedDek): string {
  const iv = Buffer.from(w.dek_wrap_iv, 'base64');
  const tag = Buffer.from(w.dek_wrap_tag, 'base64');
  const ciphertext = Buffer.from(w.wrapped_dek, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', kek, iv);
  decipher.setAuthTag(tag);
  const dek = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return dek.toString('base64');
}

/** Unwrap a stored DEK back to its raw base64 form using the Solana master KEK. */
export function unwrapDek(w: WrappedDek): string {
  return unwrapWithKek(getMasterKek(), w);
}

/**
 * Unwrap a stored DEK using the EVM master KEK (NAVE_EVM_MASTER_KEK). Outside
 * production it falls back to NAVE_MASTER_KEK when the dedicated EVM key is not
 * configured; in production the fallback is refused (throws) so EVM key custody
 * stays separable from the Solana path.
 */
export function unwrapEvmDek(w: WrappedDek): string {
  const envName = resolveEvmKekEnvName();
  if (!envName) {
    throw new Error(
      isProductionEnv()
        ? 'NAVE_EVM_MASTER_KEK is not configured (production refuses the NAVE_MASTER_KEK fallback)'
        : 'NAVE_EVM_MASTER_KEK / NAVE_MASTER_KEK is not configured',
    );
  }
  return unwrapWithKek(loadKekFromEnv(envName), w);
}
