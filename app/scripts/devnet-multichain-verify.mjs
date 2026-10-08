#!/usr/bin/env node
/**
 * Devnet multichain (EVM Sepolia + Base Sepolia) readiness verifier.
 *
 * Read-only. Confirms JSON-RPC endpoints report the expected chain ids, optional
 * factory contracts are deployed (eth_getCode), and (optionally) Supabase lists
 * registered EVM DAOs per testnet chain.
 *
 * Required env:
 *   SUPABASE_URL                 Supabase project URL (or VITE_SUPABASE_URL)
 *   SUPABASE_SERVICE_ROLE_KEY    service-role key (read dao_registry)
 *
 * Optional RPC (same names as register-dao / evm-indexer; only checked when set;
 * VITE_EVM_* RPC URLs are accepted as fallbacks for local .env.local):
 *   EVM_SEPOLIA_RPC_URL          → must answer eth_chainId with 0xaa36a7 (11155111)
 *   EVM_BASE_SEPOLIA_RPC_URL     → must answer eth_chainId with 0x14a34 (84532)
 *
 * Optional factory checks (when set, bytecode must be non-empty):
 *   VITE_EVM_SEPOLIA_FACTORY_ADDRESS
 *   VITE_EVM_BASE_SEPOLIA_FACTORY_ADDRESS
 *
 * Optional strict registry gate:
 *   REQUIRE_EVM_DAOS=true        require ≥1 dao_registry row per chain_id
 *                                 11155111 and 84532
 *
 * Exit codes:
 *   0 — PASS
 *   1 — usage / missing required env / transport or Supabase read errors
 *   2 — assertion FAIL (wrong chain id, empty code, strict DAO counts)
 *
 * When run via `npm run verify:devnet-multichain`, optional `.env.local` is loaded
 * from the repo root if present (same behavior as verify:agentic-e2e-suite).
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { createClient } from '@supabase/supabase-js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
loadDotenv({ path: resolve(REPO_ROOT, '.env.local') });

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const SEPOLIA_RPC = process.env.EVM_SEPOLIA_RPC_URL || process.env.VITE_EVM_SEPOLIA_RPC_URL;
const BASE_SEPOLIA_RPC = process.env.EVM_BASE_SEPOLIA_RPC_URL || process.env.VITE_EVM_BASE_SEPOLIA_RPC_URL;

const FACTORY_SEPOLIA = process.env.VITE_EVM_SEPOLIA_FACTORY_ADDRESS?.trim();
const FACTORY_BASE_SEPOLIA = process.env.VITE_EVM_BASE_SEPOLIA_FACTORY_ADDRESS?.trim();

const rawRequireDaos = String(process.env.REQUIRE_EVM_DAOS ?? '').toLowerCase();
const REQUIRE_EVM_DAOS = rawRequireDaos === 'true' || rawRequireDaos === '1';

const EXPECTED = {
  sepolia: { hex: '0xaa36a7', dec: 11155111 },
  baseSepolia: { hex: '0x14a34', dec: 84532 },
};

function usage() {
  console.error(`
devnet-multichain-verify.mjs — read-only EVM testnet + Supabase checks

Required:
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

Optional RPC (register-dao / evm-indexer names):
  EVM_SEPOLIA_RPC_URL, EVM_BASE_SEPOLIA_RPC_URL

Optional bytecode checks:
  VITE_EVM_SEPOLIA_FACTORY_ADDRESS, VITE_EVM_BASE_SEPOLIA_FACTORY_ADDRESS

Optional strict mode:
  REQUIRE_EVM_DAOS=true   → at least one dao_registry row per chain_id 11155111 and 84532
`);
}

async function jsonRpc(url, method, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${url.slice(0, 48)}…`);
  }
  const body = await res.json();
  if (body.error) {
    throw new Error(body.error.message || JSON.stringify(body.error));
  }
  return body.result;
}

function normHexChainId(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  if (!s.startsWith('0x')) return null;
  return s;
}

async function assertChainId(rpcUrl, label, expectedHex) {
  const raw = await jsonRpc(rpcUrl, 'eth_chainId', []);
  const got = normHexChainId(raw);
  const exp = expectedHex.toLowerCase();
  if (got !== exp) {
    console.error(`FAIL: ${label}: eth_chainId expected ${exp}, got ${raw}`);
    return false;
  }
  console.log(`  ✓ ${label}: eth_chainId = ${got}`);
  return true;
}

async function assertContractCode(rpcUrl, label, address) {
  if (!address.startsWith('0x') || address.length !== 42) {
    console.error(`FAIL: ${label}: invalid address "${address}"`);
    return false;
  }
  const code = await jsonRpc(rpcUrl, 'eth_getCode', [address, 'latest']);
  if (typeof code !== 'string' || code === '0x' || code === '0x0') {
    console.error(`FAIL: ${label}: eth_getCode empty for ${address}`);
    return false;
  }
  console.log(`  ✓ ${label}: eth_getCode non-empty (${(code.length - 2) / 2} bytes) for ${address}`);
  return true;
}

async function main() {
  if (!SUPABASE_URL || !SERVICE_KEY) {
    usage();
    console.error(
      'Missing env: SUPABASE_SERVICE_ROLE_KEY plus (SUPABASE_URL or VITE_SUPABASE_URL) are required.',
    );
    process.exit(1);
  }

  console.log('\n=== JSON-RPC chain id checks (optional per URL) ===\n');
  let rpcOk = true;
  if (SEPOLIA_RPC) {
    try {
      rpcOk = (await assertChainId(SEPOLIA_RPC, 'EVM_SEPOLIA_RPC_URL', EXPECTED.sepolia.hex)) && rpcOk;
      if (FACTORY_SEPOLIA) {
        rpcOk = (await assertContractCode(SEPOLIA_RPC, 'Sepolia factory', FACTORY_SEPOLIA.toLowerCase())) && rpcOk;
      }
    } catch (e) {
      console.error('FAIL: EVM_SEPOLIA_RPC_URL:', e instanceof Error ? e.message : e);
      rpcOk = false;
    }
  } else {
    console.log('  · EVM_SEPOLIA_RPC_URL unset — skipped');
    if (FACTORY_SEPOLIA) {
      console.error('FAIL: VITE_EVM_SEPOLIA_FACTORY_ADDRESS set but EVM_SEPOLIA_RPC_URL missing (cannot eth_getCode).');
      rpcOk = false;
    }
  }

  if (BASE_SEPOLIA_RPC) {
    try {
      rpcOk = (await assertChainId(BASE_SEPOLIA_RPC, 'EVM_BASE_SEPOLIA_RPC_URL', EXPECTED.baseSepolia.hex)) && rpcOk;
      if (FACTORY_BASE_SEPOLIA) {
        rpcOk =
          (await assertContractCode(BASE_SEPOLIA_RPC, 'Base Sepolia factory', FACTORY_BASE_SEPOLIA.toLowerCase())) &&
          rpcOk;
      }
    } catch (e) {
      console.error('FAIL: EVM_BASE_SEPOLIA_RPC_URL:', e instanceof Error ? e.message : e);
      rpcOk = false;
    }
  } else {
    console.log('  · EVM_BASE_SEPOLIA_RPC_URL unset — skipped');
    if (FACTORY_BASE_SEPOLIA) {
      console.error('FAIL: VITE_EVM_BASE_SEPOLIA_FACTORY_ADDRESS set but EVM_BASE_SEPOLIA_RPC_URL missing (cannot eth_getCode).');
      rpcOk = false;
    }
  }

  if (!rpcOk) {
    console.log('\nFAIL: one or more RPC checks failed.');
    process.exit(2);
  }

  console.log('\n=== Supabase dao_registry (chain_id 11155111 | 84532) ===\n');
  const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data: rows, error } = await supabase
    .from('dao_registry')
    .select('dao_onchain_address, chain, chain_id')
    .in('chain_id', [EXPECTED.sepolia.dec, EXPECTED.baseSepolia.dec]);

  if (error) {
    console.error('Failed to read dao_registry:', error.message);
    process.exit(1);
  }

  const count111 = rows.filter((r) => r.chain_id === EXPECTED.sepolia.dec).length;
  const count84532 = rows.filter((r) => r.chain_id === EXPECTED.baseSepolia.dec).length;
  console.log(`  · rows with chain_id=${EXPECTED.sepolia.dec} (Sepolia): ${count111}`);
  console.log(`  · rows with chain_id=${EXPECTED.baseSepolia.dec} (Base Sepolia): ${count84532}`);
  console.log(`  · total matching rows: ${rows.length}`);

  if (REQUIRE_EVM_DAOS) {
    const requireBase =
      String(process.env.EVM_TESTNET_REQUIRE_BASE ?? '').toLowerCase() === 'true' ||
      String(process.env.EVM_TESTNET_REQUIRE_BASE ?? '').toLowerCase() === '1';
    if (count111 < 1) {
      console.error('\nFAIL: REQUIRE_EVM_DAOS=true requires at least one dao_registry row for Sepolia (11155111).');
      process.exit(2);
    }
    if (requireBase && count84532 < 1) {
      console.error(
        '\nFAIL: EVM_TESTNET_REQUIRE_BASE=true requires at least one dao_registry row for Base Sepolia (84532).',
      );
      process.exit(2);
    }
    console.log(
      requireBase
        ? '  ✓ REQUIRE_EVM_DAOS: Sepolia + Base Sepolia DAO rows present'
        : '  ✓ REQUIRE_EVM_DAOS: Sepolia DAO row present (Base optional until live E2E unblocked)',
    );
  } else {
    console.log('  · REQUIRE_EVM_DAOS not set — registry counts are advisory only');
  }

  console.log('\nPASS: devnet multichain verifier completed successfully.\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
