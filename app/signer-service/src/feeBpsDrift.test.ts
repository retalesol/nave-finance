// Fee-bps drift guard (CI half).
//
// The bridge fee is duplicated in three places:
//   1. on-chain `BridgeConfig.fee_bps` — what the nave_bridge program ACTUALLY
//      charges on lock and resolves on release;
//   2. `BRIDGE_FEE_BPS` (signer-service) — used for the EVM→Solana
//      net-from-gross math in bridgeRelayer.ts;
//   3. `VITE_NAVE_BRIDGE_FEE_BPS` (web app) — the quote users see and the
//      on-top amount the lock/burn UI charges.
//
// Drift between them silently mis-quotes users or makes the relayer release a
// net that disagrees with what was burned. Guarding is split in two:
//   • runtime: checkBridgeFeeBpsDrift() (bridgeRelayer.ts) compares env vs the
//     LIVE on-chain config at signer startup — covered by
//     bridgeRelayer.integration.test.ts;
//   • CI (this file): the signer and app CODE DEFAULTS and the tracked
//     .env.example values must all agree, so a config change in one place
//     cannot land without touching the others.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { decodeBridgeConfigFees, BRIDGE_CONFIG_FEE_BPS_OFFSET } from './bridgePrograms.js';

const appEnvExample = readFileSync(fileURLToPath(new URL('../../.env.example', import.meta.url)), 'utf8');
const signerEnvExample = readFileSync(fileURLToPath(new URL('../.env.example', import.meta.url)), 'utf8');
const programConfigTs = readFileSync(
  fileURLToPath(new URL('../../src/lib/programConfig.ts', import.meta.url)),
  'utf8',
);

function extractNumber(source: string, pattern: RegExp, label: string): number {
  const m = source.match(pattern);
  assert.ok(m, `could not locate ${label} (pattern ${pattern})`);
  return Number(m![1]);
}

test('fee bps agree across signer default, signer .env.example, app .env.example, and app code default', async () => {
  // Signer code default: readBridgeConfig() with BRIDGE_FEE_BPS unset.
  const prev = process.env.BRIDGE_FEE_BPS;
  delete process.env.BRIDGE_FEE_BPS;
  const { readBridgeConfig } = await import('./bridgeRelayer.js');
  const signerDefault = readBridgeConfig().feeBps;
  if (prev !== undefined) process.env.BRIDGE_FEE_BPS = prev;

  // App code default: the fallback in optionalEnvNumber('VITE_NAVE_BRIDGE_FEE_BPS', N).
  const appDefault = extractNumber(
    programConfigTs,
    /optionalEnvNumber\('VITE_NAVE_BRIDGE_FEE_BPS',\s*(\d+)\)/,
    "app default in src/lib/programConfig.ts",
  );

  // Tracked example env files (the documented operational values).
  const appEnvValue = extractNumber(appEnvExample, /^VITE_NAVE_BRIDGE_FEE_BPS=(\d+)/m, 'app .env.example');
  const signerEnvValue = extractNumber(signerEnvExample, /^#?\s*BRIDGE_FEE_BPS=(\d+)/m, 'signer .env.example');

  assert.equal(signerDefault, appDefault, 'signer BRIDGE_FEE_BPS default != app VITE_NAVE_BRIDGE_FEE_BPS default');
  assert.equal(appEnvValue, appDefault, 'app .env.example VITE_NAVE_BRIDGE_FEE_BPS drifted from the code default');
  assert.equal(signerEnvValue, appDefault, 'signer .env.example BRIDGE_FEE_BPS drifted from the app value');
});

test('fee split legs in the app .env.example sum to the total fee (mirrors on-chain validate_fee_config)', () => {
  const fee = extractNumber(appEnvExample, /^VITE_NAVE_BRIDGE_FEE_BPS=(\d+)/m, 'fee bps');
  const staking = extractNumber(appEnvExample, /^VITE_NAVE_BRIDGE_STAKING_BPS=(\d+)/m, 'staking bps');
  const protocol = extractNumber(appEnvExample, /^VITE_NAVE_BRIDGE_PROTOCOL_BPS=(\d+)/m, 'protocol bps');
  const burn = extractNumber(appEnvExample, /^VITE_NAVE_BRIDGE_BURN_BPS=(\d+)/m, 'burn bps');
  assert.equal(staking + protocol + burn, fee, `fee legs ${staking}+${protocol}+${burn} != total ${fee}`);
});

// ─── BridgeConfig on-chain layout decode (used by the runtime drift check) ────

function syntheticBridgeConfig(fields: {
  feeBps: number;
  stakingBps: number;
  protocolBps: number;
  burnBps: number;
  paused: boolean;
}): Buffer {
  const buf = Buffer.alloc(347); // BridgeConfig::LEN (see nave_bridge state.rs)
  const o = BRIDGE_CONFIG_FEE_BPS_OFFSET;
  buf.writeUInt16LE(fields.feeBps, o);
  buf.writeUInt16LE(fields.stakingBps, o + 2);
  buf.writeUInt16LE(fields.protocolBps, o + 4);
  buf.writeUInt16LE(fields.burnBps, o + 6);
  buf.writeUInt8(fields.paused ? 1 : 0, o + 8);
  return buf;
}

test('decodeBridgeConfigFees reads fee_bps/staking/protocol/burn/paused at the documented offsets', () => {
  const fields = { feeBps: 250, stakingBps: 100, protocolBps: 100, burnBps: 50, paused: false };
  assert.deepEqual(decodeBridgeConfigFees(syntheticBridgeConfig(fields)), fields);

  const paused = { feeBps: 300, stakingBps: 150, protocolBps: 100, burnBps: 50, paused: true };
  assert.deepEqual(decodeBridgeConfigFees(syntheticBridgeConfig(paused)), paused);
});

test('decodeBridgeConfigFees rejects truncated accounts', () => {
  assert.throws(() => decodeBridgeConfigFees(Buffer.alloc(200)), /too small/);
});
