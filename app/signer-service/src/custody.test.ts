import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import { dekAad, type DekBinding, type StoredWrappedDek, unwrapStoredDek } from './kek.js';
import { assertRoleSecretPolicy, authorizeRole } from './roleAuth.js';
import { evmRelaySignerRole, expectedRequestPayloadHash } from './evmRelayer.js';

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

function wrapBound(kek: Buffer, dek: Buffer, binding: DekBinding, ref: 'role' | 'master'): StoredWrappedDek {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', kek, iv);
  cipher.setAAD(dekAad(binding));
  const ct = Buffer.concat([cipher.update(dek), cipher.final()]);
  return {
    wrapped_dek: ct.toString('base64'),
    dek_wrap_iv: iv.toString('base64'),
    dek_wrap_tag: cipher.getAuthTag().toString('base64'),
    dek_wrap_version: 2,
    dek_kek_ref: ref,
  };
}

const dek = randomBytes(32);
const master = randomBytes(32);
const financialKek = randomBytes(32);
const binding: DekBinding = { dao: 'DaoA', role: 'financial', chain: 'solana' };

test('v2 row unwraps with its role KEK and matching binding', () => {
  const row = wrapBound(financialKek, dek, binding, 'role');
  withEnv({ NAVE_KEK_FINANCIAL: financialKek.toString('base64'), NAVE_MASTER_KEK: master.toString('base64') }, () => {
    assert.equal(unwrapStoredDek('solana', row, binding), dek.toString('base64'));
  });
});

test('v2 row copied to another DAO, role or chain does not unwrap', () => {
  const row = wrapBound(master, dek, binding, 'master');
  withEnv({ NAVE_MASTER_KEK: master.toString('base64') }, () => {
    assert.throws(() => unwrapStoredDek('solana', row, { ...binding, dao: 'DaoB' }));
    assert.throws(() => unwrapStoredDek('solana', row, { ...binding, role: 'executive' }));
    assert.throws(() => unwrapStoredDek('solana', row, { ...binding, chain: 'evm:84532' }));
  });
});

test("one role's KEK cannot unwrap another role's row", () => {
  const row = wrapBound(financialKek, dek, binding, 'role');
  withEnv({
    NAVE_KEK_FINANCIAL: randomBytes(32).toString('base64'),
    NAVE_KEK_EXECUTIVE: financialKek.toString('base64'),
  }, () => {
    assert.throws(() => unwrapStoredDek('solana', row, binding));
  });
});

test('role credential: role secret replaces the shared secret for that role', () => {
  const shared = 's'.repeat(40);
  const exec = 'e'.repeat(40);
  withEnv({ NAVE_SIGNER_SECRET_EXECUTIVE: exec, NAVE_REQUIRE_ROLE_SECRETS: undefined }, () => {
    assert.deepEqual(authorizeRole(exec, 'executive', shared), { ok: true });
    assert.equal(authorizeRole(shared, 'executive', shared).ok, false);
    assert.equal(authorizeRole(exec, 'financial', shared).ok, false);
    assert.deepEqual(authorizeRole(shared, 'financial', shared), { ok: true });
    assert.equal(authorizeRole(exec, null, shared).ok, false);
  });
});

test('role credential: NAVE_REQUIRE_ROLE_SECRETS refuses the shared secret', () => {
  const shared = 's'.repeat(40);
  withEnv({ NAVE_SIGNER_SECRET_OVERSIGHT: undefined, NAVE_REQUIRE_ROLE_SECRETS: 'true' }, () => {
    assert.equal(authorizeRole(shared, 'oversight', shared).ok, false);
  });
});

test('role secrets must be distinct from each other and the shared secret', () => {
  const shared = 's'.repeat(40);
  withEnv({ NAVE_SIGNER_SECRET_EXECUTIVE: shared, NAVE_REQUIRE_ROLE_SECRETS: undefined }, () => {
    assert.throws(() => assertRoleSecretPolicy(shared), /must differ/);
  });
  withEnv({
    NAVE_SIGNER_SECRET_EXECUTIVE: 'x'.repeat(40),
    NAVE_SIGNER_SECRET_FINANCIAL: 'x'.repeat(40),
    NAVE_REQUIRE_ROLE_SECRETS: undefined,
  }, () => {
    assert.throws(() => assertRoleSecretPolicy(shared), /must differ/);
  });
});

test('relayer recomputes the payload hash exactly like PayloadHash.sol', () => {
  const adapter = '0x1111111111111111111111111111111111111111' as const;
  const asset = '0x2222222222222222222222222222222222222222' as const;
  const recipient = '0x3333333333333333333333333333333333333333' as const;
  const base = { adapter, asset, recipient, amount: 1_000_000n, destChainId: 84532n };
  // Reference values from `cast keccak $(cast abi-encode ...)`.
  assert.equal(
    expectedRequestPayloadHash({ ...base, kind: 0 }),
    '0x5b72dd1524d322c351de3dcc85e4a8321ab5b974c724590147cef734e9aabd83',
  );
  assert.equal(
    expectedRequestPayloadHash({ ...base, kind: 1 }),
    '0xf029ca723f85847ce26c605f8e477ae4f11be3621569755affdbb1e76c156070',
  );
  assert.equal(
    expectedRequestPayloadHash({ ...base, kind: 2 }),
    '0x3f40c433e85c78e06df6303a11b50f2c91c96d491f08a27d99a17491b619ba38',
  );
  assert.throws(() => expectedRequestPayloadHash({ ...base, kind: 7 }));
});

test('each relay action maps to the role that signs it on-chain', () => {
  assert.equal(evmRelaySignerRole('toggle_agents'), 'guardian');
  assert.equal(evmRelaySignerRole('financial_approve'), 'financial');
  assert.equal(evmRelaySignerRole('oversight_approve'), 'oversight');
  assert.equal(evmRelaySignerRole('execute_strategy'), 'executive');
  assert.equal(evmRelaySignerRole('update_strategy_position_value'), 'operational');
  assert.equal(evmRelaySignerRole('drain_treasury'), null);
});
