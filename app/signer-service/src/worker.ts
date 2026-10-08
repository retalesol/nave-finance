/**
 * Nave scheduler/worker.
 *
 * Replaces curl-based ops with a long-running process that periodically:
 *   1. Triggers the agent-orchestrator in poll mode to advance any eligible
 *      execution requests (approvals, post-review execute_strategy, halts).
 *   2. Triggers snapshot-treasury to refresh treasury NAV snapshots.
 *   3. Proactively replenishes agent wallets using a 3-tier hysteresis model
 *      funded from the protocol ops/revenue wallet (the on-chain 8.5% yield-fee
 *      recipient): refill toward a 0.25 SOL ceiling whenever a wallet drops to
 *      ≤ 0.10 SOL, surface an URGENT signal below 0.05 SOL, and otherwise leave
 *      wallets alone between 0.10 and 0.25 SOL (hysteresis). Thresholds are
 *      overridable — see NAVE_AGENT_SOL_* below.
 *
 * Deployed as a separate process (`npm run worker`). All secrets come from the
 * environment — nothing is embedded in source. Fail-closed: required config
 * missing → exit non-zero so the platform restarts/visibly fails.
 *
 * Env:
 *   SUPABASE_URL                  Supabase project URL (required)
 *   SUPABASE_SERVICE_ROLE_KEY     Service-role key for edge auth (required)
 *   NAVE_AGENT_SECRET             Orchestrator caller secret (required)
 *   NAVE_INDEXER_SECRET           snapshot-treasury caller secret (required)
 *   NAVE_SIGNER_URL               Signer service base URL (required for replenishment)
 *   NAVE_SIGNER_SECRET            Signer service auth secret (required for replenishment)
 *   NAVE_OPS_WALLET_SECRET        Protocol operations keypair (base64 or comma-separated
 *                                 bytes). Funded from Nave's 8.5% yield fee revenue.
 *                                 Required for automatic agent wallet replenishment.
 *   NAVE_AGENT_SOL_REQUEST_THRESHOLD  Critically-low REQUEST tier in SOL (default 0.05).
 *                                 Below this an agent is flagged urgent + refilled.
 *   NAVE_AGENT_SOL_OPERATE_LEVEL  Operate tier in SOL (default 0.10). At/above this an
 *                                 agent can operate and makes no requests.
 *   NAVE_AGENT_SOL_FILL_CEILING   Fill target in SOL (default 0.25). Wallets are topped
 *                                 up to this; never filled above it.
 *   NAVE_AGENT_SOL_REFILL_TRIGGER Refill trigger in SOL (default 0.10 = operate level).
 *                                 Refill toward the ceiling only when balance ≤ this;
 *                                 between trigger and ceiling nothing happens (hysteresis).
 *   NAVE_POLICY_SECRET            policy-evaluator caller secret (optional; the
 *                                 continuous policy loop is skipped if unset)
 *   NAVE_PROPOSER_SECRET          proposal-creator caller secret (optional; the
 *                                 proposal loop is skipped if unset). NOTE: the
 *                                 proposal-creator itself is observe-only unless
 *                                 NAVE_AUTOPROPOSE_ENABLED=true on that function.
 *   ORCHESTRATOR_INTERVAL_MS      Poll cadence (default 60000)
 *   SNAPSHOT_INTERVAL_MS          Snapshot cadence (default 900000 = 15m)
 *   POLICY_INTERVAL_MS            Policy-eval cadence (default 600000 = 10m)
 *   PROPOSAL_INTERVAL_MS          Proposal-creator cadence (default 600000 = 10m)
 *   REPLENISH_INTERVAL_MS         Agent wallet replenishment cadence
 *                                 (default 21600000 = 6h)
 *   STAKING_MIRROR_INTERVAL_MS    Staking global-parity mirror cadence
 *                                 (default 600000 = 10m). The tick itself is
 *                                 gated by STAKING_MIRROR_ENABLED=true and the
 *                                 STAKING_MIRROR_* / BRIDGE_* envs documented
 *                                 in stakingMirror.ts + .env.example.
 */

import { createClient } from '@supabase/supabase-js';
import { collectManagementFees, readDaoAgentGate, replenishAgentWallets } from './index.js';
import { readStakingMirrorConfig, runStakingMirror } from './stakingMirror.js';
import { readBridgeWatcherConfig, runBridgeWatcher } from './bridgeWatcher.js';
import { reconcileStakeClaimWraps, runStakeClaimAccrualTick } from './stakeClaims.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const AGENT_SECRET = process.env.NAVE_AGENT_SECRET;
const INDEXER_SECRET = process.env.NAVE_INDEXER_SECRET;
// Optional: the policy loop is observe-only and additive, so a missing secret
// just disables it rather than failing the whole worker.
const POLICY_SECRET = process.env.NAVE_POLICY_SECRET;
// Optional: the proposal loop is gated twice — a missing secret disables the
// tick here, and the proposal-creator itself stays observe-only unless
// NAVE_AUTOPROPOSE_ENABLED=true. Both must be set for autonomous proposing.
const PROPOSER_SECRET = process.env.NAVE_PROPOSER_SECRET;

const ORCHESTRATOR_INTERVAL_MS = Number(process.env.ORCHESTRATOR_INTERVAL_MS ?? 60_000);
const SNAPSHOT_INTERVAL_MS = Number(process.env.SNAPSHOT_INTERVAL_MS ?? 900_000);
const POLICY_INTERVAL_MS = Number(process.env.POLICY_INTERVAL_MS ?? 600_000);
const PROPOSAL_INTERVAL_MS = Number(process.env.PROPOSAL_INTERVAL_MS ?? 600_000);
// Adaptive agent wallet replenishment: every 6 hours by default.
const REPLENISH_INTERVAL_MS = Number(process.env.REPLENISH_INTERVAL_MS ?? 6 * 60 * 60 * 1000);
// Discrete annual management-fee collection. The on-chain fee is due once per
// year per asset (UTC-midnight anchored); we check HOURLY by default so a due
// asset is collected shortly after its midnight boundary. Each tick is a cheap
// no-op for assets that aren't due yet (the instruction errs cleanly and we
// swallow it), so a tight cadence is safe.
const MANAGEMENT_FEE_INTERVAL_MS = Number(process.env.MANAGEMENT_FEE_INTERVAL_MS ?? 60 * 60 * 1000);
// Staking global-parity mirror (stakingMirror.ts): splits the bridge's 1%
// staking-fee collector across the Solana + EVM drip pools by stake weight.
// Every 10 minutes by default; disabled unless STAKING_MIRROR_ENABLED=true.
const STAKING_MIRROR_INTERVAL_MS = Number(process.env.STAKING_MIRROR_INTERVAL_MS ?? 600_000);
// Independent bridge watcher (bridgeWatcher.ts): retries stale/failed transfers
// and (optionally) scans for missed BridgeLock/BridgeBurnTo events. Every 5
// minutes by default; disabled unless BRIDGE_WATCHER_ENABLED=true.
const BRIDGE_WATCHER_INTERVAL_MS = Number(process.env.BRIDGE_WATCHER_INTERVAL_MS ?? 300_000);

function requireEnv(name: string, value: string | undefined): string {
  if (!value) {
    console.error(`[worker] FATAL: ${name} is not set. Refusing to start.`);
    process.exit(1);
  }
  return value;
}

const supabaseUrl = requireEnv('SUPABASE_URL', SUPABASE_URL);
const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY', SERVICE_ROLE_KEY);
const agentSecret = requireEnv('NAVE_AGENT_SECRET', AGENT_SECRET);
const indexerSecret = requireEnv('NAVE_INDEXER_SECRET', INDEXER_SECRET);

const supabase = createClient(supabaseUrl, serviceKey);

// M8: a stable-per-process replica id used as the distributed-lease holder so
// that, across multiple Railway replicas (or a rolling-restart overlap), only
// ONE replica runs a money-moving loop per tick. Includes pid + a random suffix
// so two replicas never collide on the same holder string.
const REPLICA_ID = `${process.env.RAILWAY_REPLICA_ID ?? process.env.HOSTNAME ?? 'worker'}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Acquire a cross-replica lease for `lockKey` (TTL in seconds). Returns true
 * only when THIS replica now holds the lock. Backed by worker_locks via the
 * race-free try_acquire_worker_lock RPC. On any error we fail-CLOSED (return
 * false / do not run) so a DB hiccup can never cause double money-moving.
 */
async function acquireDbLease(lockKey: string, ttlSeconds: number): Promise<boolean> {
  try {
    const { data, error } = await supabase.rpc('try_acquire_worker_lock', {
      p_lock_key: lockKey,
      p_holder: REPLICA_ID,
      p_ttl_seconds: ttlSeconds,
    });
    if (error) {
      console.warn(`[worker] lease ${lockKey}: acquire failed (${error.message}); skipping this tick.`);
      return false;
    }
    return data === true;
  } catch (err) {
    console.warn(`[worker] lease ${lockKey}: acquire threw (${err instanceof Error ? err.message : err}); skipping.`);
    return false;
  }
}

async function releaseDbLease(lockKey: string): Promise<void> {
  try {
    await supabase.rpc('release_worker_lock', { p_lock_key: lockKey, p_holder: REPLICA_ID });
  } catch { /* lease will expire on its own */ }
}

async function callEdge(fn: string, body: unknown, extraHeaders: Record<string, string> = {}): Promise<void> {
  const url = `${supabaseUrl}/functions/v1/${fn}`;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${serviceKey}`,
        ...extraHeaders,
      },
      body: JSON.stringify(body),
    });
    const text = await resp.text();
    if (!resp.ok) {
      console.error(`[worker] ${fn} -> HTTP ${resp.status}: ${text}`);
    } else {
      console.log(`[worker] ${fn} ok: ${text.slice(0, 300)}`);
    }
  } catch (err) {
    console.error(`[worker] ${fn} request failed:`, err instanceof Error ? err.message : err);
  }
}

async function pollOrchestrator(): Promise<void> {
  await callEdge('agent-orchestrator', { mode: 'poll' }, { 'X-Agent-Secret': agentSecret });
}

async function runSnapshot(): Promise<void> {
  await callEdge('snapshot-treasury', { indexer_secret: indexerSecret });
}

async function runPolicyEval(): Promise<void> {
  if (!POLICY_SECRET) return;
  await callEdge('policy-evaluator', {}, { 'X-Policy-Secret': POLICY_SECRET });
}

async function runProposalCreator(): Promise<void> {
  if (!PROPOSER_SECRET) return;
  await callEdge('proposal-creator', {}, { 'X-Proposer-Secret': PROPOSER_SECRET });
}

/**
 * Filter a DAO list down to those whose on-chain agent gate is open (H4).
 *
 * Skips only DAOs whose gate is READABLE and explicitly closed (frozen or
 * agents disabled) so the periodic replenish + fee loops do not burn ops-wallet
 * SOL on paused/disabled treasuries via predictable on-chain failures. DAOs
 * whose gate cannot be read (RPC miss, or non-Solana addresses such as EVM DAOs
 * that these Solana loops already no-op on) are KEPT, so a transient read miss
 * never starves a live DAO.
 */
async function filterAgentActiveDaos(daos: string[], label: string): Promise<string[]> {
  const gates = await Promise.all(
    daos.map(async (dao) => ({ dao, gate: await readDaoAgentGate(dao) })),
  );
  const active: string[] = [];
  let skipped = 0;
  for (const { dao, gate } of gates) {
    if (gate && (gate.frozen || !gate.agentsEnabled)) {
      skipped++;
      continue;
    }
    active.push(dao);
  }
  if (skipped > 0) {
    console.log(`[worker] ${label}: skipped ${skipped} frozen/agents-disabled DAO(s)`);
  }
  return active;
}

/**
 * Agent wallet replenishment (3-tier hysteresis).
 *
 * Fetches all active DAO addresses from Supabase, then asks the signer service
 * to check and replenish each agent wallet against fixed tiers: refill toward
 * the 0.25 SOL ceiling whenever a wallet drops to ≤ 0.10 SOL, flag an URGENT
 * replenish-needed signal below 0.05 SOL, and leave wallets untouched between
 * 0.10 and 0.25 SOL (hysteresis). Funded entirely from the protocol ops wallet,
 * which receives Nave's on-chain 8.5% yield fee revenue. Thresholds are
 * overridable via NAVE_AGENT_SOL_* on the signer service.
 *
 * Runs every REPLENISH_INTERVAL_MS (default 6 hours) so wallets are proactively
 * maintained and agents never hit zero unexpectedly.
 */
async function runReplenishAgentWallets(): Promise<void> {
  if (!process.env.NAVE_OPS_WALLET_SECRET) {
    // Silently skip if the ops wallet isn't configured yet (e.g. early boot).
    return;
  }

  let daos: string[] = [];
  try {
    const { data, error } = await supabase
      .from('dao_registry')
      .select('dao_onchain_address')
      .not('dao_onchain_address', 'is', null);
    if (error) throw error;
    daos = (data ?? []).map((r: { dao_onchain_address: string }) => r.dao_onchain_address).filter(Boolean);
  } catch (err) {
    console.error('[worker] replenish: failed to fetch DAO list:', err instanceof Error ? err.message : err);
    return;
  }

  if (daos.length === 0) return;

  // H4: only replenish agent wallets for DAOs whose on-chain agents are active.
  daos = await filterAgentActiveDaos(daos, 'replenish');
  if (daos.length === 0) return;

  console.log(`[worker] replenish: checking agent wallets for ${daos.length} DAO(s)`);
  let totalTopUps = 0;
  let totalLamports = 0;
  let totalUrgent = 0;

  for (const daoAddress of daos) {
    try {
      const results = await replenishAgentWallets(daoAddress);
      for (const r of results) {
        if (r.requestedUrgent) totalUrgent++;
        if (r.toppedUp) {
          totalTopUps++;
          totalLamports += r.topUpLamports;
        }
      }
    } catch (err) {
      console.error(
        `[worker] replenish ${daoAddress}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  const urgentNote = totalUrgent > 0
    ? ` ${totalUrgent} wallet(s) were critically low (URGENT, below the 0.05 SOL request threshold).`
    : '';
  if (totalTopUps > 0) {
    console.log(
      `[worker] replenish complete: ${totalTopUps} wallet(s) refilled toward the 0.25 SOL ceiling, ` +
      `${totalLamports} lamports (${(totalLamports / 1e9).toFixed(6)} SOL) total transferred.${urgentNote}`,
    );
  } else {
    console.log(
      `[worker] replenish complete: all agent wallets within the operating band (no refill needed).${urgentNote}`,
    );
  }
}

/**
 * Discrete annual management-fee scheduler.
 *
 * Enumerates active DAOs (same source as replenishment) and asks the signer to
 * collect the per-asset annual management fee for each. The on-chain instruction
 * is permissionless-but-validated and a cheap no-op when an asset isn't due yet
 * (NoManagementFeeDue / zero fee), so this can run on a tight (hourly) cadence
 * to catch each asset's UTC-midnight annual boundary without double-charging.
 *
 * Requires the ops wallet (NAVE_OPS_WALLET_SECRET) as the permissionless
 * fee_collector/payer; skipped entirely when it isn't configured.
 */
async function runCollectManagementFees(): Promise<void> {
  if (!process.env.NAVE_OPS_WALLET_SECRET) {
    // Ops wallet doubles as the permissionless fee_collector/payer.
    return;
  }

  let daos: string[] = [];
  try {
    const { data, error } = await supabase
      .from('dao_registry')
      .select('dao_onchain_address')
      .not('dao_onchain_address', 'is', null);
    if (error) throw error;
    daos = (data ?? []).map((r: { dao_onchain_address: string }) => r.dao_onchain_address).filter(Boolean);
  } catch (err) {
    console.error('[worker] management-fee: failed to fetch DAO list:', err instanceof Error ? err.message : err);
    return;
  }

  if (daos.length === 0) return;

  // H4: only attempt fee collection for DAOs whose on-chain agents are active.
  daos = await filterAgentActiveDaos(daos, 'management-fee');
  if (daos.length === 0) return;

  let collected = 0;
  let skipped = 0;
  for (const daoAddress of daos) {
    try {
      const results = await collectManagementFees(daoAddress);
      for (const r of results) {
        if (r.collected) collected++;
        else skipped++;
      }
    } catch (err) {
      console.error(
        `[worker] management-fee ${daoAddress}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  if (collected > 0) {
    console.log(
      `[worker] management-fee tick: ${collected} asset fee(s) collected, ${skipped} not due / skipped ` +
      `across ${daos.length} DAO(s).`,
    );
  }
}

/**
 * Staking-mirror tick: proportional reward distribution across the Solana +
 * EVM staking drip pools (see stakingMirror.ts). Money-moving, so it runs
 * under safeLeased. Skips silently when STAKING_MIRROR_ENABLED !== 'true'.
 */
async function runStakingMirrorTick(): Promise<void> {
  if (!readStakingMirrorConfig().enabled) return;
  try {
    const result = await runStakingMirror();
    if (result.skipped) {
      console.log(`[worker] staking-mirror: ${result.skipped}` + (result.syncSignature ? ` (sync poke ${result.syncSignature})` : ''));
      return;
    }
    const evmSummary = (result.evm ?? [])
      .map((leg) => `${leg.chainId}:${leg.error ? `FAILED (${leg.error})` : `${leg.shareRaw} (${leg.notifyTx})`}`)
      .join(', ');
    console.log(
      `[worker] staking-mirror distributed ${result.collectorBalanceRaw} raw — ` +
      `solana ${result.solana ? `${result.solana.shareRaw} (${result.solana.signature})` : '0'}` +
      (evmSummary ? `; evm ${evmSummary}` : '') +
      (result.stakeEventsMirrored ? `; mirrored ${result.stakeEventsMirrored} stake event(s)` : ''),
    );
  } catch (err) {
    console.error('[worker] staking-mirror tick failed:', err instanceof Error ? err.message : err);
  }
}

/**
 * Stake-claim accrual tick: folds every EVM staker's reward accrual in the
 * ledger (see stakeClaims.ts) so pending balances stay fresh (≤ one tick
 * stale) even for users who never open the app. Read-fold-write only — no
 * funds move — but leased anyway so replicas don't redundantly hammer RPCs.
 */
async function runStakeClaimAccrual(): Promise<void> {
  try {
    const r = await runStakeClaimAccrualTick();
    if (!r.skipped && r.folded > 0) console.log(`[worker] stake-claim accrual: folded ${r.folded} account(s).`);
  } catch (err) {
    console.error('[worker] stake-claim accrual tick failed:', err instanceof Error ? err.message : err);
  }
  // Two-phase reconciliation: complete the reserve→custody wrap for claims
  // whose EVM mint landed but whose Solana leg did not (see stakeClaims.ts).
  // Money-moving, so it rides the same DB lease as the accrual tick.
  try {
    const w = await reconcileStakeClaimWraps();
    if (!w.skipped && (w.reconciled > 0 || w.pending > 0)) {
      console.log(`[worker] stake-claim wrap reconciliation: completed ${w.reconciled}, still pending ${w.pending}.`);
    }
  } catch (err) {
    console.error('[worker] stake-claim wrap reconciliation failed:', err instanceof Error ? err.message : err);
  }
}

/**
 * Bridge-watcher tick: retries stale/failed bridge transfers and scans for
 * missed events (see bridgeWatcher.ts). Money-moving (drives destination
 * mint/release), so it runs under safeLeased. Skips when disabled.
 */
async function runBridgeWatcherTick(): Promise<void> {
  if (!readBridgeWatcherConfig().enabled) return;
  try {
    const r = await runBridgeWatcher();
    if (r.skipped) return;
    if (r.retried > 0 || r.stuck > 0 || r.enqueuedMissed > 0) {
      console.log(
        `[worker] bridge-watcher: retried ${r.retried} (recovered ${r.recovered}, stuck ${r.stuck}); ` +
        `missed-scan enqueued ${r.enqueuedMissed}/${r.scannedMissed}.`,
      );
    }
  } catch (err) {
    console.error('[worker] bridge-watcher tick failed:', err instanceof Error ? err.message : err);
  }
}

// Guard against overlapping runs if a cycle takes longer than its interval.
const running = { orchestrator: false, snapshot: false, policy: false, proposal: false, replenish: false, managementFee: false, stakingMirror: false, bridgeWatcher: false, stakeClaimAccrual: false };

async function safe(label: keyof typeof running, fn: () => Promise<void>): Promise<void> {
  if (running[label]) {
    console.warn(`[worker] ${label} still running; skipping this tick.`);
    return;
  }
  running[label] = true;
  try {
    await fn();
  } finally {
    running[label] = false;
  }
}

/**
 * Run a money-moving loop under BOTH the in-process mutex AND a cross-replica DB
 * lease (M8). The lease TTL is sized to ~2x the loop's interval so it survives a
 * slow tick but expires quickly if a replica dies. Only the replica that wins
 * the lease runs this tick; others skip — preventing e.g. double management-fee
 * collection at the annual boundary or double agent-wallet replenishment.
 */
async function safeLeased(
  label: keyof typeof running,
  leaseTtlSeconds: number,
  fn: () => Promise<void>,
): Promise<void> {
  if (running[label]) {
    console.warn(`[worker] ${label} still running; skipping this tick.`);
    return;
  }
  if (!(await acquireDbLease(label, leaseTtlSeconds))) {
    // Another replica holds the lease for this tick.
    return;
  }
  running[label] = true;
  try {
    await fn();
  } finally {
    running[label] = false;
    await releaseDbLease(label);
  }
}

const opsConfigured = !!process.env.NAVE_OPS_WALLET_SECRET;

console.log(
  `[worker] starting. orchestrator every ${ORCHESTRATOR_INTERVAL_MS}ms, snapshot every ${SNAPSHOT_INTERVAL_MS}ms` +
    (POLICY_SECRET ? `, policy-eval every ${POLICY_INTERVAL_MS}ms` : `. policy-eval disabled (NAVE_POLICY_SECRET unset)`) +
    (PROPOSER_SECRET ? `, proposal-creator every ${PROPOSAL_INTERVAL_MS}ms` : `. proposal-creator disabled (NAVE_PROPOSER_SECRET unset)`) +
    (opsConfigured ? `, wallet replenishment (hysteresis: refill ≤0.10→0.25 SOL) every ${REPLENISH_INTERVAL_MS}ms` : `. wallet replenishment disabled (NAVE_OPS_WALLET_SECRET unset)`) +
    (opsConfigured ? `, management-fee collection every ${MANAGEMENT_FEE_INTERVAL_MS}ms` : `. management-fee collection disabled (NAVE_OPS_WALLET_SECRET unset)`) +
    (readStakingMirrorConfig().enabled ? `, staking mirror every ${STAKING_MIRROR_INTERVAL_MS}ms.` : `. staking mirror disabled (STAKING_MIRROR_ENABLED unset).`) +
    (readBridgeWatcherConfig().enabled ? ` bridge watcher every ${BRIDGE_WATCHER_INTERVAL_MS}ms.` : ` bridge watcher disabled (BRIDGE_WATCHER_ENABLED unset).`),
);

// Kick once on boot, then on intervals. The orchestrator poll drives agent
// actions (proposals, approvals, executions) through the edge function, so two
// replicas polling concurrently can double-drive the same DAO — it runs under
// the cross-replica DB lease like the other side-effecting loops.
const ORCHESTRATOR_LEASE_TTL_S = Math.ceil((ORCHESTRATOR_INTERVAL_MS * 2) / 1000);
void safeLeased('orchestrator', ORCHESTRATOR_LEASE_TTL_S, pollOrchestrator);
void safe('snapshot', runSnapshot);
void safe('policy', runPolicyEval);
void safe('proposal', runProposalCreator);
// Money-moving loops run under a cross-replica DB lease (M8). Lease TTL ~2x the
// interval (in seconds) so a slow tick keeps its lease but a dead replica's
// lease expires promptly.
const REPLENISH_LEASE_TTL_S = Math.ceil((REPLENISH_INTERVAL_MS * 2) / 1000);
const MANAGEMENT_FEE_LEASE_TTL_S = Math.ceil((MANAGEMENT_FEE_INTERVAL_MS * 2) / 1000);
const STAKING_MIRROR_LEASE_TTL_S = Math.ceil((STAKING_MIRROR_INTERVAL_MS * 2) / 1000);
const BRIDGE_WATCHER_LEASE_TTL_S = Math.ceil((BRIDGE_WATCHER_INTERVAL_MS * 2) / 1000);

void safeLeased('replenish', REPLENISH_LEASE_TTL_S, runReplenishAgentWallets);
void safeLeased('managementFee', MANAGEMENT_FEE_LEASE_TTL_S, runCollectManagementFees);
void safeLeased('stakingMirror', STAKING_MIRROR_LEASE_TTL_S, runStakingMirrorTick);
void safeLeased('bridgeWatcher', BRIDGE_WATCHER_LEASE_TTL_S, runBridgeWatcherTick);
void safeLeased('stakeClaimAccrual', STAKING_MIRROR_LEASE_TTL_S, runStakeClaimAccrual);

setInterval(() => void safeLeased('orchestrator', ORCHESTRATOR_LEASE_TTL_S, pollOrchestrator), ORCHESTRATOR_INTERVAL_MS);
setInterval(() => void safe('snapshot', runSnapshot), SNAPSHOT_INTERVAL_MS);
setInterval(() => void safe('policy', runPolicyEval), POLICY_INTERVAL_MS);
setInterval(() => void safe('proposal', runProposalCreator), PROPOSAL_INTERVAL_MS);
setInterval(() => void safeLeased('replenish', REPLENISH_LEASE_TTL_S, runReplenishAgentWallets), REPLENISH_INTERVAL_MS);
setInterval(() => void safeLeased('managementFee', MANAGEMENT_FEE_LEASE_TTL_S, runCollectManagementFees), MANAGEMENT_FEE_INTERVAL_MS);
setInterval(() => void safeLeased('stakingMirror', STAKING_MIRROR_LEASE_TTL_S, runStakingMirrorTick), STAKING_MIRROR_INTERVAL_MS);
setInterval(() => void safeLeased('bridgeWatcher', BRIDGE_WATCHER_LEASE_TTL_S, runBridgeWatcherTick), BRIDGE_WATCHER_INTERVAL_MS);
setInterval(() => void safeLeased('stakeClaimAccrual', STAKING_MIRROR_LEASE_TTL_S, runStakeClaimAccrual), STAKING_MIRROR_INTERVAL_MS);
