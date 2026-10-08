#!/usr/bin/env node

const DEFAULT_BRIDGE_FEE_BPS = 200;
const DBPS_PER_BPS = 10;
const MAX_UINT16 = 65_535;

function readNumber(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number; got "${raw}".`);
  }
  return value;
}

function assertEvmAddress(name, value) {
  if (!value) return;
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`${name} must be an EVM address; got "${value}".`);
  }
}

const feeBps = readNumber("NAVE_BRIDGE_FEE_BPS", DEFAULT_BRIDGE_FEE_BPS);
if (feeBps < 0 || feeBps > 10_000) {
  throw new Error(`NAVE_BRIDGE_FEE_BPS must be between 0 and 10000; got ${feeBps}.`);
}

const expectedDbps = feeBps * DBPS_PER_BPS;
const feeDbps = readNumber("NAVE_BRIDGE_FEE_DBPS", expectedDbps);
if (feeDbps !== expectedDbps) {
  throw new Error(`NAVE_BRIDGE_FEE_DBPS must equal NAVE_BRIDGE_FEE_BPS * 10; got ${feeDbps}, expected ${expectedDbps}.`);
}
if (feeDbps > MAX_UINT16) {
  throw new Error(`NAVE_BRIDGE_FEE_DBPS must fit Wormhole Executor FeeArgs.uint16; got ${feeDbps}.`);
}

assertEvmAddress("NAVE_BRIDGE_REFERRER_FEE_PAYEE_EVM", process.env.NAVE_BRIDGE_REFERRER_FEE_PAYEE_EVM);

console.log("NAVE bridge fee config OK");
console.log(`- fee: ${feeBps} bps (${feeBps / 100}%)`);
console.log(`- Wormhole Executor FeeArgs.dbps: ${feeDbps}`);
console.log(`- referrer payee configured: ${process.env.NAVE_BRIDGE_REFERRER_FEE_PAYEE_EVM ? "yes" : "no"}`);
console.log("Docs gate: use Wormhole NTT Executor / Connect route for fee capture; bare NTT SDK usage must be rechecked before build.");
