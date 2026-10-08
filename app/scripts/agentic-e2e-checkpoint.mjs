#!/usr/bin/env node
/**
 * Resumable multichain agentic E2E checkpoint tracker.
 *
 * Persists progress to test-results/agentic-e2e-state.json so you can stop on
 * a bug, fix infra/code, then continue without re-running earlier manual steps.
 *
 * Usage:
 *   node scripts/agentic-e2e-checkpoint.mjs init
 *   node scripts/agentic-e2e-checkpoint.mjs status
 *   node scripts/agentic-e2e-checkpoint.mjs set-dao solana <base58 pubkey>
 *   node scripts/agentic-e2e-checkpoint.mjs set-dao evm_sepolia 0x…
 *   node scripts/agentic-e2e-checkpoint.mjs set-dao evm_base_sepolia 0x…
 *   node scripts/agentic-e2e-checkpoint.mjs preflight
 *   node scripts/agentic-e2e-checkpoint.mjs complete S1.3
 *   node scripts/agentic-e2e-checkpoint.mjs bug "orchestrator 500 on financial approve"
 *   node scripts/agentic-e2e-checkpoint.mjs note S2.1 "tx sig 5SoT..."
 *   node scripts/agentic-e2e-checkpoint.mjs next
 *   node scripts/agentic-e2e-checkpoint.mjs report
 *   node scripts/agentic-e2e-checkpoint.mjs reset
 *
 * Optional env:
 *   AGENTIC_E2E_STATE_FILE  override state path (default: test-results/agentic-e2e-state.json)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const DEFAULT_STATE = resolve(REPO_ROOT, 'test-results/agentic-e2e-state.json');

const STATE_FILE = process.env.AGENTIC_E2E_STATE_FILE?.trim() || DEFAULT_STATE;

/** Keys in `daoAddresses` — must stay aligned with defaultState() and STEPS.chain. */
const DAO_ADDRESS_KEYS = ['solana', 'evm_sepolia', 'evm_base_sepolia'];

/**
 * Curated env names for agentic multichain QA + verifiers.
 * Each must be documented in `.env.example` (active `KEY=` or commented template).
 */
const PREFLIGHT_GROUPS = [
  {
    label: 'Vite app boot (devnet)',
    keys: [
      'VITE_SOLANA_RPC_URL',
      'VITE_SUPABASE_URL',
      'VITE_SUPABASE_ANON_KEY',
      'VITE_NAVE_CORE_PROGRAM_ID',
      'VITE_NAVE_GOVERNANCE_PROGRAM_ID',
      'VITE_NAVE_EXECUTION_PROGRAM_ID',
      'VITE_NAVE_JITO_ADAPTER_ID',
      'VITE_NAVE_KAMINO_ADAPTER_ID',
      'VITE_NAVE_MARGINFI_ADAPTER_ID',
    ],
  },
  {
    label: 'EVM UI (when exercising Sepolia / Base Sepolia in the app)',
    keys: [
      'VITE_WALLETCONNECT_PROJECT_ID',
      'VITE_EVM_SEPOLIA_RPC_URL',
      'VITE_EVM_BASE_SEPOLIA_RPC_URL',
      'VITE_EVM_SEPOLIA_PROTOCOL_ADDRESS',
      'VITE_EVM_BASE_SEPOLIA_PROTOCOL_ADDRESS',
      'VITE_EVM_SEPOLIA_FACTORY_ADDRESS',
      'VITE_EVM_BASE_SEPOLIA_FACTORY_ADDRESS',
    ],
  },
  {
    label: 'Scripts: verify:e2e-gate (Solana training + reconciliation)',
    keys: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'DAO_ADDRESS', 'SOLANA_RPC_URL'],
  },
  {
    label: 'Scripts: verify:devnet-multichain',
    keys: [
      'SUPABASE_URL',
      'SUPABASE_SERVICE_ROLE_KEY',
      'EVM_SEPOLIA_RPC_URL',
      'EVM_BASE_SEPOLIA_RPC_URL',
    ],
  },
];

/** Canonical step ids — Solana (S*), Sepolia (E*), Base Sepolia (B*). */
const STEPS = [
  { id: 'S0', chain: 'solana', label: 'Preconditions: programs, mocks off, edge secrets, signer, indexer' },
  { id: 'S1.1', chain: 'solana', label: 'Create DAO + governance evidence (token registry only for token-governance)' },
  { id: 'S1.2', chain: 'solana', label: 'Ratify constitution' },
  { id: 'S1.3', chain: 'solana', label: 'Set conservative constitution limits + ratify' },
  { id: 'S1.4', chain: 'solana', label: 'Generate agent keys; confirm encrypted_agent_keys' },
  { id: 'S2.1', chain: 'solana', label: 'Start agents / enable pipeline (operational)' },
  { id: 'S3.1', chain: 'solana', label: 'Strategy proposal → autonomous deploy to approved protocol' },
  { id: 'S3.2', chain: 'solana', label: 'Autonomous withdraw capital + realized yield path' },
  { id: 'S4.1', chain: 'solana', label: 'Transfer proposal to arbitrary wallet → vote → execute' },
  { id: 'S5.1', chain: 'solana', label: 'Token minting + revoke mint/authority per product flow' },
  { id: 'S6.1', chain: 'solana', label: 'Pause agents (toggle_agents false); confirm pipeline blocked; resume' },
  { id: 'S7.1', chain: 'solana', label: 'Deposit test stable (e.g. devnet USDC/PYUSD) + register if needed' },
  { id: 'S8.1', chain: 'solana', label: 'Privacy / visibility settings as applicable' },
  { id: 'S9.1', chain: 'solana', label: 'verify:e2e-gate + reconciliation + agent_action_logs claude-sonnet fields' },

  { id: 'E0', chain: 'evm_sepolia', label: 'Preconditions: factory/protocol env, WC project id, RPC, funded key' },
  { id: 'E1.1', chain: 'evm_sepolia', label: 'Create DAO (Sepolia) + deposit + constitution ratify' },
  { id: 'E1.2', chain: 'evm_sepolia', label: 'Conservative settings ratified' },
  { id: 'E2.1', chain: 'evm_sepolia', label: 'Agents on; strategy execute + withdraw via governor/execution' },
  { id: 'E3.1', chain: 'evm_sepolia', label: 'Transfer proposal → vote → disburse' },
  { id: 'E4.1', chain: 'evm_sepolia', label: 'DAO token mint controls + revoke authorities' },
  { id: 'E5.1', chain: 'evm_sepolia', label: 'Pause agents on treasury' },
  { id: 'E6.1', chain: 'evm_sepolia', label: 'PYUSD/USDC deposit on Sepolia testnet' },
  { id: 'E7.1', chain: 'evm_sepolia', label: 'Privacy mode (Settings) on Sepolia DAO' },
  { id: 'E8.1', chain: 'evm_sepolia', label: 'Supabase/indexer + agent logs for EVM chain_id 11155111' },

  { id: 'B0', chain: 'evm_base_sepolia', label: 'Preconditions for Base Sepolia (84532)' },
  { id: 'B1.1', chain: 'evm_base_sepolia', label: 'Repeat core DAO + agents + strategy + transfer on Base Sepolia' },
  { id: 'B2.1', chain: 'evm_base_sepolia', label: 'Token mint/revoke + pause + deposit + privacy on Base Sepolia' },
  { id: 'B3.1', chain: 'evm_base_sepolia', label: 'Indexer/registry evidence chain_id 84532' },
];

function loadState() {
  if (!existsSync(STATE_FILE)) return null;
  return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
}

function defaultState() {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    completed: [],
    notes: {},
    bugs: [],
    daoAddresses: { solana: '', evm_sepolia: '', evm_base_sepolia: '' },
  };
}

function saveState(state) {
  state.updatedAt = new Date().toISOString();
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  console.log(`Wrote ${STATE_FILE}`);
}

function stepDef(id) {
  return STEPS.find((s) => s.id === id);
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True if .env.example contains an assignment line for KEY (commented or not). */
function keyDocumentedInExample(key, exampleText) {
  const re = new RegExp(`(?:^|\\n)\\s*#?\\s*(?:export\\s+)?${escapeRegExp(key)}\\s*=`, 'm');
  return re.test(exampleText);
}

/** Keys that have a non-empty value in a dotenv file (values are never returned). */
function parseEnvFileAssignedKeys(filePath) {
  const keys = new Set();
  if (!existsSync(filePath)) return keys;
  const text = readFileSync(filePath, 'utf8');
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (/^\s*#/.test(line)) continue;
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let val = m[2].trim();
    if (/^["']/.test(val)) {
      const q = val[0];
      const end = val.indexOf(q, 1);
      val = end > 0 ? val.slice(1, end) : val.slice(1);
    }
    if (val.length > 0) keys.add(m[1]);
  }
  return keys;
}

function isEvmAddress(s) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(s).trim());
}

function normalizeDaoAddress(chain, addr) {
  const a = String(addr).trim();
  if (!a) throw new Error('address is empty');
  if (chain === 'solana') {
    if (a.length < 32 || a.length > 55) throw new Error('Solana address length looks invalid');
    if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(a)) throw new Error('Solana address must be base58 (no 0, O, I, l)');
    return a;
  }
  if (chain === 'evm_sepolia' || chain === 'evm_base_sepolia') {
    if (!isEvmAddress(a)) throw new Error('EVM address must be 0x followed by 40 hex digits');
    return a;
  }
  throw new Error(`unknown chain: ${chain}`);
}

function ensureDaoAddressesShape(state) {
  const defaults = { solana: '', evm_sepolia: '', evm_base_sepolia: '' };
  state.daoAddresses = { ...defaults, ...(state.daoAddresses || {}) };
}

function runPreflight() {
  const examplePath = resolve(REPO_ROOT, '.env.example');
  const localPath = resolve(REPO_ROOT, '.env.local');
  if (!existsSync(examplePath)) {
    console.error('preflight: missing .env.example');
    process.exit(1);
  }
  const exampleText = readFileSync(examplePath, 'utf8');
  const uniqueKeys = [...new Set(PREFLIGHT_GROUPS.flatMap((g) => g.keys))];
  const docMissing = uniqueKeys.filter((k) => !keyDocumentedInExample(k, exampleText));

  console.log('\n## Agentic E2E preflight\n');
  console.log('### .env.example (each curated key must appear as `KEY=` in a line, commented or not)\n');
  if (docMissing.length) {
    console.log('Missing documentation lines for:');
    for (const k of docMissing) console.log(`  - ${k}`);
    console.log('\nAdd commented or real assignments to .env.example so operators know what to set.\n');
  } else {
    console.log('OK — all curated preflight keys are documented in .env.example.\n');
  }

  const localKeys = parseEnvFileAssignedKeys(localPath);
  console.log('### .env.local (key names only; values are never printed)\n');
  if (!existsSync(localPath)) {
    console.log('No .env.local file — copy from .env.example and fill in secrets locally.\n');
  } else {
    console.log(`Scanned: ${localPath}\n`);
  }

  const present = uniqueKeys.filter((k) => localKeys.has(k));
  const absent = uniqueKeys.filter((k) => !localKeys.has(k));
  console.log(`Present (${present.length}): ${present.length ? present.join(', ') : '—'}`);
  console.log(`Absent (${absent.length}): ${absent.length ? absent.join(', ') : '—'}`);

  console.log('\n### By scenario (same keys may repeat across groups)\n');
  for (const g of PREFLIGHT_GROUPS) {
    const miss = g.keys.filter((k) => !localKeys.has(k));
    const ok = g.keys.filter((k) => localKeys.has(k));
    console.log(`**${g.label}**`);
    console.log(`  set in .env.local: ${ok.length ? ok.join(', ') : '—'}`);
    console.log(`  missing: ${miss.length ? miss.join(', ') : '—'}`);
  }

  console.log(
    '\nHandoff: export `DAO_ADDRESS` to match your Solana DAO when running `npm run verify:e2e-gate`,',
  );
  console.log(
    'or use `set-dao solana <pubkey>` here and copy from `status` / `report`. Verifiers also accept',
  );
  console.log(
    '`VITE_SUPABASE_URL` as SUPABASE_URL, `VITE_SOLANA_RPC_URL` as SOLANA_RPC_URL, and `VITE_EVM_*` RPC',
  );
  console.log(
    'URLs for multichain checks. `npm run verify:agentic-e2e-suite` loads `.env.local` and runs gate + multichain + forge.',
  );
  console.log(
    '`SOLANA_RPC_URL` and `EVM_*_RPC_URL` are optional if you rely on script defaults or skip RPC checks.\n',
  );

  const contractsDir = (() => {
    const fromEnv = process.env.NAVE_CONTRACTS_DIR?.trim();
    if (fromEnv && existsSync(fromEnv)) return fromEnv;
    const monorepo = resolve(REPO_ROOT, '../contracts');
    if (existsSync(monorepo)) return monorepo;
    return null;
  })();

  console.log('### Contract test runners (nave-contracts)\n');
  if (!contractsDir) {
    console.log('  nave-contracts not found — set NAVE_CONTRACTS_DIR for live devnet runners.\n');
  } else {
    console.log(`  repo: ${contractsDir}`);
    const scripts = [
      'test:devnet:solana:smoke',
      'test:devnet:solana:full',
      'test:devnet:evm',
    ];
    for (const s of scripts) {
      const pkg = resolve(contractsDir, 'package.json');
      const text = existsSync(pkg) ? readFileSync(pkg, 'utf8') : '';
      console.log(`  ${text.includes(`"${s}"`) ? '✓' : '✗'} npm run ${s}`);
    }
    const rpc = process.env.SOLANA_RPC_URL || process.env.VITE_SOLANA_RPC_URL;
    if (rpc) {
      const ping = spawnSync(
        'curl',
        ['-s', '-o', '/dev/null', '-w', '%{http_code}', '-X', 'POST', rpc, '-H', 'Content-Type: application/json', '-d', '{"jsonrpc":"2.0","id":1,"method":"getHealth"}'],
        { encoding: 'utf8' },
      );
      const ok = ping.stdout?.trim() === '200';
      console.log(`  Solana RPC reachability: ${ok ? 'OK' : 'FAIL or unset'}`);
    } else {
      console.log('  Solana RPC: not set (VITE_SOLANA_RPC_URL / SOLANA_RPC_URL)');
    }
    console.log('');
  }

  process.exit(docMissing.length ? 1 : 0);
}

function usage() {
  console.log(`
agentic-e2e-checkpoint.mjs — resumable multichain QA state

Commands:
  init              create fresh state file (fails if exists; use reset first)
  status            show completed / pending / last bug / daoAddresses
  set-dao <chain> <addr>   update daoAddresses (no JSON edit). Chains: solana | evm_sepolia | evm_base_sepolia
  preflight         verify .env.example documents curated keys; list which are set in .env.local (names only)
  complete <id>     mark step id done (e.g. S1.3)
  bug "<msg>"       append open issue (does not mark steps)
  note <id> "<txt>" attach free-form note to a step id
  next              print lowest pending step id
  report            markdown-ish summary for paste into ticket/runbook
  reset             delete state file
  run-forge         cd sibling contracts/evm && forge test --match-contract E2ETest (local)

State file: ${STATE_FILE}
`);
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === '-h' || cmd === '--help') {
    usage();
    process.exit(cmd ? 0 : 1);
  }

  if (cmd === 'preflight') {
    runPreflight();
  }

  if (cmd === 'run-forge') {
    const fromEnv = process.env.NAVE_EVM_CONTRACTS_DIR?.trim();
    const monorepo = resolve(REPO_ROOT, '../contracts/evm');
    const contracts = fromEnv && existsSync(fromEnv)
      ? fromEnv
      : existsSync(monorepo)
        ? monorepo
        : null;
    if (!contracts) {
      console.error(
        'Could not find contracts/evm. Set NAVE_EVM_CONTRACTS_DIR=/abs/path/to/contracts/evm',
      );
      process.exit(1);
    }
    const r = spawnSync('forge', ['test', '--match-contract', 'E2ETest', '-vv'], {
      cwd: contracts,
      stdio: 'inherit',
      shell: false,
    });
    process.exit(r.status ?? 1);
  }

  if (cmd === 'reset') {
    if (existsSync(STATE_FILE)) {
      unlinkSync(STATE_FILE);
      console.log('Removed state file.');
    } else {
      console.log('No state file to remove.');
    }
    process.exit(0);
  }

  if (cmd === 'init') {
    if (existsSync(STATE_FILE)) {
      console.error('State already exists. Run: node scripts/agentic-e2e-checkpoint.mjs reset');
      process.exit(1);
    }
    const s = defaultState();
    saveState(s);
    console.log('Initialized. Run `status` then `complete S0` after preconditions.');
    process.exit(0);
  }

  let state = loadState();
  if (!state) {
    console.error('No state file. Run: node scripts/agentic-e2e-checkpoint.mjs init');
    process.exit(1);
  }
  ensureDaoAddressesShape(state);

  if (cmd === 'status') {
    const done = new Set(state.completed);
    const pending = STEPS.filter((s) => !done.has(s.id));
    console.log(`\nState: ${STATE_FILE}`);
    console.log(`Completed: ${state.completed.length} / ${STEPS.length}`);
    const da = state.daoAddresses;
    if (da && Object.values(da).some(Boolean)) {
      console.log('\nDAO addresses (checkpoint):');
      for (const k of DAO_ADDRESS_KEYS) {
        if (da[k]) console.log(`  ${k}: ${da[k]}`);
      }
    } else {
      console.log('\nDAO addresses: (unset — use set-dao)');
    }
    if (state.bugs.length) {
      console.log('\nOpen bugs logged:');
      for (const b of state.bugs) console.log(`  - [${b.at}] ${b.text}`);
    }
    console.log('\nNext pending:');
    for (const s of pending.slice(0, 8)) {
      console.log(`  ${s.id}  [${s.chain}] ${s.label}`);
    }
    if (pending.length > 8) console.log(`  … +${pending.length - 8} more`);
    process.exit(0);
  }

  if (cmd === 'set-dao') {
    const chain = rest[0];
    const addr = rest.slice(1).join(' ').trim();
    if (!chain || !addr || !DAO_ADDRESS_KEYS.includes(chain)) {
      console.error(`Usage: set-dao <chain> <address>`);
      console.error(`  chain must be one of: ${DAO_ADDRESS_KEYS.join(', ')}`);
      process.exit(1);
    }
    try {
      state.daoAddresses[chain] = normalizeDaoAddress(chain, addr);
    } catch (e) {
      console.error(String(e?.message || e));
      process.exit(1);
    }
    saveState(state);
    console.log(`Set daoAddresses.${chain}`);
    process.exit(0);
  }

  if (cmd === 'complete') {
    const id = rest[0];
    if (!id || !stepDef(id)) {
      console.error('Unknown step id. Use one of:', STEPS.map((s) => s.id).join(', '));
      process.exit(1);
    }
    if (!state.completed.includes(id)) state.completed.push(id);
    saveState(state);
    console.log(`Marked ${id} complete.`);
    process.exit(0);
  }

  if (cmd === 'bug') {
    const text = rest.join(' ').trim();
    if (!text) {
      console.error('Usage: bug "description"');
      process.exit(1);
    }
    state.bugs.push({ at: new Date().toISOString(), text });
    saveState(state);
    process.exit(0);
  }

  if (cmd === 'note') {
    const id = rest[0];
    const txt = rest.slice(1).join(' ').trim();
    if (!id || !txt) {
      console.error('Usage: note S1.1 "free text"');
      process.exit(1);
    }
    state.notes[id] = state.notes[id] || [];
    state.notes[id].push({ at: new Date().toISOString(), text: txt });
    saveState(state);
    process.exit(0);
  }

  if (cmd === 'next') {
    const done = new Set(state.completed);
    const next = STEPS.find((s) => !done.has(s.id));
    if (!next) {
      console.log('All steps marked complete.');
      process.exit(0);
    }
    console.log(`${next.id}\t[${next.chain}]\t${next.label}`);
    process.exit(0);
  }

  if (cmd === 'report') {
    const done = new Set(state.completed);
    console.log('\n## Agentic multichain E2E checkpoint report\n');
    console.log(`- State file: \`${STATE_FILE}\``);
    console.log(`- Updated: ${state.updatedAt}`);
    console.log(`- Progress: ${state.completed.length}/${STEPS.length} steps marked complete\n`);
    if (state.daoAddresses && Object.values(state.daoAddresses).some(Boolean)) {
      console.log('### DAO addresses\n');
      for (const [k, v] of Object.entries(state.daoAddresses)) {
        if (v) console.log(`- **${k}**: \`${v}\``);
      }
      console.log('');
    }
    console.log('### Steps\n');
    for (const s of STEPS) {
      const mark = done.has(s.id) ? '[x]' : '[ ]';
      console.log(`${mark} **${s.id}** (${s.chain}) — ${s.label}`);
      const notes = state.notes[s.id];
      if (notes?.length) {
        for (const n of notes) console.log(`    - _${n.at}_: ${n.text}`);
      }
    }
    if (state.bugs.length) {
      console.log('\n### Logged issues\n');
      for (const b of state.bugs) console.log(`- ${b.at}: ${b.text}`);
    }
    console.log('\n### Automated verifiers (run when relevant)\n');
    console.log('- Solana training + reconciliation: `npm run verify:e2e-gate` (see docs/DEVNET_E2E_GATE.md)');
    console.log('- EVM testnets + registry: `npm run verify:devnet-multichain`');
    console.log('- Local Foundry EVM lifecycle: `npm run agentic-e2e:forge`');
    process.exit(0);
  }

  usage();
  process.exit(1);
}

main();
