import { timingSafeEqual } from 'node:crypto';

// Per-role caller credentials. Each signing role has its own secret so no one
// caller credential can carry a request through every approval step:
//
//   NAVE_SIGNER_SECRET_EXECUTIVE / _FINANCIAL / _OVERSIGHT / _OPERATIONAL / _GUARDIAN
//
// When a role secret is set, ONLY that secret authorizes the role; the shared
// NAVE_SIGNER_SECRET no longer does. When it is unset, the shared secret is
// accepted unless NAVE_REQUIRE_ROLE_SECRETS=true (mainnet cutover sets it).

export type SignerRole = 'executive' | 'financial' | 'oversight' | 'operational' | 'guardian';

export const SIGNER_ROLES: readonly SignerRole[] = [
  'executive',
  'financial',
  'oversight',
  'operational',
  'guardian',
];

export function roleSecretEnvName(role: SignerRole): string {
  return `NAVE_SIGNER_SECRET_${role.toUpperCase()}`;
}

export function isSignerRole(value: unknown): value is SignerRole {
  return typeof value === 'string' && (SIGNER_ROLES as readonly string[]).includes(value);
}

function requireRoleSecrets(): boolean {
  return (process.env.NAVE_REQUIRE_ROLE_SECRETS || '').trim().toLowerCase() === 'true';
}

function secretEquals(provided: string | undefined, expected: string): boolean {
  if (!provided || !expected || provided.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  } catch {
    return false;
  }
}

export type RoleAuthResult = { ok: true } | { ok: false; status: 401 | 400; error: string };

/**
 * Authorize a request that will sign as `role`. `sharedSecret` is the legacy
 * NAVE_SIGNER_SECRET.
 */
export function authorizeRole(
  provided: string | undefined,
  role: SignerRole | null,
  sharedSecret: string,
): RoleAuthResult {
  if (!role) {
    return { ok: false, status: 400, error: 'Request does not name a signing role' };
  }
  const roleSecret = process.env[roleSecretEnvName(role)] || '';
  if (roleSecret) {
    return secretEquals(provided, roleSecret)
      ? { ok: true }
      : { ok: false, status: 401, error: 'Unauthorized' };
  }
  if (requireRoleSecrets()) {
    return {
      ok: false,
      status: 401,
      error: `${roleSecretEnvName(role)} is not configured (NAVE_REQUIRE_ROLE_SECRETS=true)`,
    };
  }
  return secretEquals(provided, sharedSecret)
    ? { ok: true }
    : { ok: false, status: 401, error: 'Unauthorized' };
}

/**
 * Boot-time check: role secrets must be distinct from each other and from the
 * shared secret, otherwise the split is cosmetic.
 */
export function assertRoleSecretPolicy(sharedSecret: string): void {
  const seen = new Map<string, string>();
  if (sharedSecret) seen.set(sharedSecret, 'NAVE_SIGNER_SECRET');
  for (const role of SIGNER_ROLES) {
    const name = roleSecretEnvName(role);
    const value = process.env[name];
    if (!value) {
      if (requireRoleSecrets()) {
        throw new Error(`${name} is required when NAVE_REQUIRE_ROLE_SECRETS=true`);
      }
      continue;
    }
    if (value.length < 32) throw new Error(`${name} must be at least 32 characters`);
    const clash = seen.get(value);
    if (clash) throw new Error(`${name} must differ from ${clash}`);
    seen.set(value, name);
  }
}
