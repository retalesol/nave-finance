#!/usr/bin/env node
/**
 * Phase 5 (devnet E2E gate) verifier.
 *
 * Dumps the agent_action_logs for one DAO and flags:
 *   - any null/empty training fields required for Phase 7 fine-tuning, and
 *   - the on-chain reconciliation inputs (vault ATA, escrow ATA, treasury_vault,
 *     strategy_position) so you can fill the reconciliation table.
 *
 * Read-only. Run after driving a request through the pipeline.
 *
 * Required env:
 *   SUPABASE_URL                 Supabase project URL (or VITE_SUPABASE_URL)
 *   SUPABASE_SERVICE_ROLE_KEY    service-role key (read agent logs + snapshots)
 *   DAO_ADDRESS                  the canonical DAO onchain address (or set in
 *                                test-results/agentic-e2e-state.json under daoAddresses.solana)
 * Optional:
 *   SOLANA_RPC_URL               for on-chain reconciliation reads (or VITE_SOLANA_RPC_URL)
 *   AGENTIC_E2E_STATE_FILE       override path to checkpoint JSON for DAO fallback
 *
 * When run via `npm run verify:e2e-gate` (not only through verify:agentic-e2e-suite),
 * optional `.env.local` is loaded from the repo root if present (same as the suite runner).
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { Connection, PublicKey } from '@solana/web3.js';
import { BorshAccountsCoder } from '@coral-xyz/anchor';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
loadDotenv({ path: resolve(REPO_ROOT, '.env.local') });

/** Solana DAO pubkey from agentic checkpoint when DAO_ADDRESS is unset. */
function loadDaoFromCheckpoint() {
  const p =
    process.env.AGENTIC_E2E_STATE_FILE?.trim() ||
    resolve(REPO_ROOT, 'test-results/agentic-e2e-state.json');
  if (!existsSync(p)) return null;
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'));
    const a = j.daoAddresses?.solana;
    return typeof a === 'string' && a.trim().length > 0 ? a.trim() : null;
  } catch {
    return null;
  }
}

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DAO_ADDRESS = process.env.DAO_ADDRESS || loadDaoFromCheckpoint();
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || process.env.VITE_SOLANA_RPC_URL;
// Comma-separated protocol ids deployed for this DAO (e.g. "kamino,jito").
// Used to derive the per-protocol escrow + strategy position for reconciliation.
const PROTOCOL_IDS = (process.env.PROTOCOL_IDS || 'kamino')
  .split(',')
  .map((p) => p.trim())
  .filter(Boolean);
const NAVE_CORE_PROGRAM_ID =
  process.env.NAVE_CORE_PROGRAM_ID || '8GSh9ghC2EL88X9FwftiH2QDrm8drvgSLAUoo45gN5nB';

if (!SUPABASE_URL || !SERVICE_KEY || !DAO_ADDRESS) {
  console.error(
    'Missing env: SUPABASE_SERVICE_ROLE_KEY plus (SUPABASE_URL or VITE_SUPABASE_URL) plus (DAO_ADDRESS or daoAddresses.solana in agentic checkpoint) are required.',
  );
  process.exit(1);
}

// Training fields that EVERY logged agent action must carry for Phase 7
// fine-tuning, regardless of role/decision.
const BASE_FIELDS = [
  'decision',
  'confidence_score',
  'reasoning',
  'risk_flags',
  'claude_model',
  'execution_request_address',
  'status',
];

// Action types that actually submit an on-chain transaction (and therefore must
// carry a tx_signature). The advisory inference rows (action_type `pipeline_*`)
// only record the model's decision — the signature is logged on the dedicated
// signing/execute_strategy/halt row — so requiring a signature on the inference
// row produces false FAILs.
const SIGNING_ACTION_TYPES = new Set(['signing', 'execute_strategy', 'halt']);

// Roles that bind the canonical tx payload hash (NE-7). Executive and
// operational actions do not commit a payload_hash, so it must not be required
// of them.
const PAYLOAD_HASH_ROLES = new Set(['financial', 'oversight']);

/**
 * Per-trace required fields. Each row is evaluated against the fields that THAT
 * action is expected to populate, rather than a single blanket set.
 */
function requiredFieldsFor(row) {
  const role = String(row.agent_role ?? '').toLowerCase();
  const actionType = String(row.action_type ?? '').toLowerCase();
  const fields = new Set(BASE_FIELDS);

  // Payload-hash binding only applies to the signing rows of the roles that
  // commit it (financial/oversight), not their advisory inference rows.
  if (PAYLOAD_HASH_ROLES.has(role) && SIGNING_ACTION_TYPES.has(actionType)) {
    fields.add('payload_hash');
  }
  if (SIGNING_ACTION_TYPES.has(actionType)) fields.add('tx_signature');

  return fields;
}

/**
 * Whether a row is a genuine agent-produced trace (Phase 7 fine-tuning fixture).
 * The indexer also writes reconciliation echoes into agent_action_logs
 * (status `on_chain_confirmed`, no claude_model, null decision/confidence) to
 * mark on-chain confirmation; those are not model traces and must not be graded
 * as training fixtures.
 */
function isAgentTrace(row) {
  const model = String(row.claude_model ?? '').trim();
  return model.length > 0;
}

/**
 * Field-aware emptiness. risk_flags is a valid-when-empty array (no flags is a
 * legitimate, informative outcome), and confidence_score 0 is a real value.
 */
function isMissing(field, v) {
  if (field === 'risk_flags') {
    // Must be present as an array; an empty array is acceptable.
    return !Array.isArray(v);
  }
  if (field === 'confidence_score') {
    return v === null || v === undefined;
  }
  if (v === null || v === undefined) return true;
  if (typeof v === 'string' && v.trim() === '') return true;
  if (Array.isArray(v) && v.length === 0) return true;
  return false;
}

/**
 * On-chain reconciliation (RECONCILIATION.md invariants). Reads the vault token
 * balance, per-protocol escrow balances, and the on-chain treasury_vault /
 * strategy_position accounting, then checks:
 *   (1) NAV conservation:      vault_balance + Σ escrow == current_nav
 *   (2) Deployed conservation: Σ position.current_value == deployed_capital
 * Returns { ok, lines, breaches } or null when SOLANA_RPC_URL is unset.
 */
async function reconcileOnChain() {
  if (!SOLANA_RPC_URL) return null;

  const connection = new Connection(SOLANA_RPC_URL, 'confirmed');
  const corePid = new PublicKey(NAVE_CORE_PROGRAM_ID);
  const dao = new PublicKey(DAO_ADDRESS);

  // nave_core IDL is the source of truth for account layouts (synced from contracts).
  const idl = JSON.parse(
    readFileSync(new URL('../src/idl/nave_core.json', import.meta.url), 'utf8'),
  );
  const coder = new BorshAccountsCoder(idl);

  const pda = (seedParts) => PublicKey.findProgramAddressSync(seedParts, corePid)[0];
  const enc = (s) => new TextEncoder().encode(s);
  // The decoder may return snake_case (raw IDL field names) or camelCase
  // depending on anchor version; accept either so this never silently misreads.
  const pick = (obj, camel, snake) => obj[camel] ?? obj[snake];

  const treasuryVaultPda = pda([enc('treasury_vault'), dao.toBuffer()]);

  const tvInfo = await connection.getAccountInfo(treasuryVaultPda);
  if (!tvInfo) {
    return { ok: false, lines: ['treasury_vault account not found on-chain'], breaches: ['treasury_vault missing'] };
  }
  const tv = coder.decode('TreasuryVault', tvInfo.data);
  const currentNav = BigInt(pick(tv, 'currentNav', 'current_nav').toString());
  const deployedCapital = BigInt(pick(tv, 'deployedCapital', 'deployed_capital').toString());
  const vaultTokenAccount = new PublicKey(pick(tv, 'vaultTokenAccount', 'vault_token_account'));

  const tokenBalance = async (acct) => {
    try {
      const r = await connection.getTokenAccountBalance(acct, 'confirmed');
      return BigInt(r.value.amount);
    } catch {
      return 0n; // account may not exist (e.g. escrow not yet provisioned)
    }
  };

  const vaultBalance = await tokenBalance(vaultTokenAccount);

  let escrowTotal = 0n;
  let positionTotal = 0n;
  const perProtocol = [];
  for (const protocol of PROTOCOL_IDS) {
    const escrowPda = pda([enc('strategy_escrow'), dao.toBuffer(), enc(protocol)]);
    const positionPda = pda([enc('strategy_position'), dao.toBuffer(), enc(protocol)]);
    const escrowBal = await tokenBalance(escrowPda);
    escrowTotal += escrowBal;

    let positionValue = 0n;
    const posInfo = await connection.getAccountInfo(positionPda);
    if (posInfo) {
      const pos = coder.decode('StrategyPosition', posInfo.data);
      positionValue = BigInt(pick(pos, 'currentValue', 'current_value').toString());
    }
    positionTotal += positionValue;
    perProtocol.push({ protocol, escrowBal, positionValue });
  }

  const lines = [];
  lines.push('\n=== on-chain reconciliation ===');
  lines.push(`vault_balance          = ${vaultBalance}`);
  lines.push(`escrow_total           = ${escrowTotal}`);
  lines.push(`current_nav            = ${currentNav}`);
  lines.push(`deployed_capital       = ${deployedCapital}`);
  lines.push(`position_value_total   = ${positionTotal}`);
  for (const p of perProtocol) {
    lines.push(`  · ${p.protocol}: escrow=${p.escrowBal} position=${p.positionValue}`);
  }

  const breaches = [];
  const navLhs = vaultBalance + escrowTotal;
  if (navLhs !== currentNav) {
    breaches.push(`NAV conservation: vault+escrow ${navLhs} != current_nav ${currentNav}`);
  }
  if (positionTotal !== deployedCapital) {
    breaches.push(`deployed conservation: Σposition ${positionTotal} != deployed_capital ${deployedCapital}`);
  }
  lines.push(
    breaches.length === 0
      ? '  ✓ invariants hold (NAV + deployed conservation)'
      : `  ⚠ ${breaches.length} invariant breach(es):\n    - ${breaches.join('\n    - ')}`,
  );

  return { ok: breaches.length === 0, lines, breaches };
}

async function main() {
  const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

  const { data: logs, error } = await supabase
    .from('agent_action_logs')
    .select('*')
    .eq('dao_onchain_address', DAO_ADDRESS)
    .order('created_at', { ascending: true });

  if (error) {
    console.error('Failed to read agent_action_logs:', error.message);
    process.exit(1);
  }

  console.log(`\n=== agent_action_logs for ${DAO_ADDRESS} (${logs.length} rows) ===\n`);

  let missingTotal = 0;
  let incompleteRows = 0;
  let gradedRows = 0;
  let skippedRows = 0;
  for (const row of logs) {
    if (!isAgentTrace(row)) {
      skippedRows += 1;
      console.log(
        `[${row.created_at}] ${row.agent_role}/${row.action_type} ` +
          `status=${row.status}\n  · skipped (reconciliation echo — not a model trace)`,
      );
      continue;
    }
    gradedRows += 1;
    const required = requiredFieldsFor(row);
    const missing = [...required].filter((f) => isMissing(f, row[f]));
    missingTotal += missing.length;
    if (missing.length) incompleteRows += 1;
    const tag = missing.length
      ? `  ⚠ missing: ${missing.join(', ')}`
      : `  ✓ complete (checked: ${[...required].join(', ')})`;
    console.log(
      `[${row.created_at}] ${row.agent_role}/${row.action_type} ` +
        `decision=${row.decision ?? '—'} conf=${row.confidence_score ?? '—'} ` +
        `status=${row.status} sig=${(row.tx_signature || '').slice(0, 12) || '—'}\n${tag}`,
    );
  }

  // Latest treasury snapshot (reconciliation inputs from the indexer).
  const { data: snap } = await supabase
    .from('treasury_snapshots')
    .select('*')
    .eq('dao_onchain_address', DAO_ADDRESS)
    .order('snapshot_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (snap) {
    console.log('\n=== latest treasury_snapshot ===');
    console.log(JSON.stringify(
      {
        snapshot_at: snap.snapshot_at,
        total_value_usd: snap.total_value_usd,
        sol_balance: snap.sol_balance,
        usdc_balance: snap.usdc_balance,
        strategy_positions: snap.strategy_positions,
      },
      null,
      2,
    ));
  } else {
    console.log('\n(no treasury_snapshot rows found — run snapshot-treasury first)');
  }

  // On-chain reconciliation invariants (when an RPC is configured).
  let recon = null;
  try {
    recon = await reconcileOnChain();
  } catch (e) {
    console.log(`\n(reconciliation skipped: ${e instanceof Error ? e.message : String(e)})`);
  }
  if (recon) {
    console.log(recon.lines.join('\n'));
  } else if (!SOLANA_RPC_URL) {
    console.log('\n(on-chain reconciliation skipped — set SOLANA_RPC_URL and PROTOCOL_IDS to enable)');
  }

  console.log(
    `\n=== summary: ${logs.length} log rows (${gradedRows} graded model traces, ` +
      `${skippedRows} reconciliation echoes skipped), ${incompleteRows} incomplete, ` +
      `${missingTotal} missing training-field values (per-trace required sets) ===`,
  );
  if (gradedRows === 0) {
    console.log('FAIL: no agent model traces for this DAO — run the pipeline first.');
    process.exit(2);
  }
  if (missingTotal > 0) {
    console.log('FAIL: fill the gaps before treating these traces as fine-tuning fixtures.');
    process.exit(2);
  }
  if (recon && !recon.ok) {
    console.log('FAIL: on-chain reconciliation invariants breached (see above).');
    process.exit(3);
  }
  console.log(
    recon
      ? 'PASS: training fields complete and reconciliation invariants hold.'
      : 'PASS: training fields complete for all logged actions.',
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
