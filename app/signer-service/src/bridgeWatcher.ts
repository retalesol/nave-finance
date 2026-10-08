// ─── Independent bridge watcher (relay resilience, audit M-1) ─────────────────
//
// The primary relay path is push-driven: the frontend POSTs /bridge-relay after
// a user's lock/burn. If that POST is lost (tab closed, network blip) or the
// destination leg fails transiently, the user's funds sit locked/burned with no
// automatic recovery — the `unique(source_tx)` row makes a naive re-POST a
// no-op. This watcher closes that gap. It runs on the shared worker under the
// same cross-replica DB lease as the staking mirror, so only one replica sweeps
// per tick.
//
// Two independent passes, both reusing the EXISTING, on-chain-verified relay
// logic (recipient is always taken from the on-chain event, never from a body):
//   1. Retry sweep — re-drive `pending`/`failed` transfers that have gone stale,
//      bounded by `retry_count` (then parked as `stuck` for an operator).
//   2. Missed-event scan — look for BridgeLock (Solana) / BridgeBurnTo (EVM)
//      events with no `bridge_transfers` row and enqueue them.
//
// Safe by construction: the on-chain replay guards (lockbox
// `processed[srcChainId,srcNonce]` / nave_bridge `ProcessedRelease`) are the
// authoritative double-spend protection, so a duplicate destination attempt
// reverts harmlessly rather than paying twice.

import {
  Connection,
  PublicKey,
  type ConfirmedSignatureInfo,
} from '@solana/web3.js';
import { createPublicClient, http, type Hash, type PublicClient } from 'viem';
import {
  decodeAttributedBridgeLock,
  deriveBridgeConfig,
} from './bridgePrograms.js';
import {
  BRIDGE_EVM_CHAINS,
  bridgeLookbackSeconds,
  handleBridgeRelay,
  lookbackBlocksForChain,
  readBridgeConfig,
  readBridgeEvmChainIds,
  resolveEvmChainId,
  type BridgeConfig,
  type BridgeRelayBody,
  type EvmNetwork,
} from './bridgeRelayer.js';
import { createClient } from '@supabase/supabase-js';

// Chain metadata comes from BRIDGE_EVM_CHAINS (bridgeRelayer.ts) so the two
// modules cannot drift. Note (Arbitrum Nitro / Robinhood): the sequencer can
// screen a tx so it never lands at all — this watcher is exactly the recovery
// path for that: the stale-transfer sweep re-drives the row through the
// verified relay (bounded by retry_count) and then parks it 'stuck' for
// operator attention.

/** Max block span per eth_getLogs request (public RPCs cap large ranges). */
const EVM_LOGS_CHUNK_BLOCKS = 5_000n;

export interface BridgeWatcherConfig {
  enabled: boolean;
  /** A transfer must be idle this long before the retry sweep touches it. */
  staleMs: number;
  /** Max automatic re-executions before a transfer is parked as `stuck`. */
  maxRetries: number;
  /** How many recent transfers to consider per sweep. */
  batchSize: number;
  /** Whether to also scan the chains for events missing a DB row. */
  scanMissedEvents: boolean;
  /**
   * Missed-event lookback window in SECONDS (BRIDGE_LOOKBACK_SECONDS, default
   * 2h). Converted to blocks per chain via its block time — a fixed block count
   * is ~17 hours on Ethereum but ~20 minutes on Robinhood.
   */
  lookbackSeconds: number;
  /**
   * Legacy floor in blocks (BRIDGE_WATCHER_EVM_LOOKBACK_BLOCKS). When set, a
   * chain scans at least this many blocks even if the seconds window converts
   * to fewer. 0 when unset.
   */
  evmLookbackBlocksFloor: bigint;
  /** Solana signature lookback for the missed-event scan. */
  solanaSignatureLimit: number;
}

function envNum(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw && Number.isFinite(Number(raw)) ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

export function readBridgeWatcherConfig(): BridgeWatcherConfig {
  return {
    enabled: (process.env.BRIDGE_WATCHER_ENABLED || '').trim().toLowerCase() === 'true',
    staleMs: envNum('BRIDGE_WATCHER_STALE_MS', 10 * 60_000),
    maxRetries: envNum('BRIDGE_WATCHER_MAX_RETRIES', 5),
    batchSize: envNum('BRIDGE_WATCHER_BATCH_SIZE', 25),
    scanMissedEvents: (process.env.BRIDGE_WATCHER_SCAN_EVENTS || '').trim().toLowerCase() === 'true',
    lookbackSeconds: bridgeLookbackSeconds(),
    evmLookbackBlocksFloor: BigInt(Math.max(0, Math.trunc(envNum('BRIDGE_WATCHER_EVM_LOOKBACK_BLOCKS', 0)))),
    solanaSignatureLimit: envNum('BRIDGE_WATCHER_SOLANA_SIG_LIMIT', 100),
  };
}

/** Effective lookback in blocks for one chain (seconds window, floored by the legacy block env). */
export function evmLookbackBlocksFor(chainId: number, wcfg: BridgeWatcherConfig = readBridgeWatcherConfig()): bigint {
  const fromSeconds = lookbackBlocksForChain(chainId, wcfg.lookbackSeconds);
  return fromSeconds > wcfg.evmLookbackBlocksFloor ? fromSeconds : wcfg.evmLookbackBlocksFloor;
}

let _watcherSupabase: ReturnType<typeof createClient> | null = null;
function getWatcherSupabase(): ReturnType<typeof createClient> {
  if (_watcherSupabase) return _watcherSupabase;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured');
  _watcherSupabase = createClient(url, key);
  return _watcherSupabase;
}

let _watcherConnection: Connection | null = null;
function getWatcherConnection(cfg: BridgeConfig): Connection {
  if (_watcherConnection) return _watcherConnection;
  _watcherConnection = new Connection(cfg.solanaRpcUrl, 'confirmed');
  return _watcherConnection;
}

/**
 * Build the relay body for an existing row (recipient is re-derived on-chain).
 * Rows store legacy chain NAMES; re-drive with the canonical numeric chain id,
 * disambiguating a family name through the row's own `network` tag (falls back
 * to NAVE_EVM_NETWORK inside resolveEvmChainId). Throws when the row's route
 * cannot be resolved unambiguously — the caller logs and leaves it for an
 * operator rather than guessing a network.
 */
export function bodyFromRow(row: Record<string, unknown>): BridgeRelayBody {
  const direction = String(row.direction);
  const evmSide = direction === 'solana_to_evm' ? String(row.dest_chain) : String(row.source_chain);
  const rowNetwork = String(row.network ?? '').toLowerCase();
  const network: EvmNetwork | null = rowNetwork === 'mainnet' || rowNetwork === 'testnet' ? rowNetwork : null;
  const evmChainId = resolveEvmChainId(evmSide, { network });
  return {
    direction,
    sourceChain: String(row.source_chain),
    destChain: String(row.dest_chain),
    ...(direction === 'solana_to_evm' ? { destChainId: evmChainId } : { sourceChainId: evmChainId }),
    sourceTx: String(row.source_tx),
  };
}

export interface BridgeQueueCounts {
  pending: number;
  failed: number;
  stuck: number;
}

/** Live counts for the health endpoint / ops surface. */
export async function getBridgeQueueCounts(): Promise<BridgeQueueCounts> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase = getWatcherSupabase() as any;
  const countFor = async (status: string): Promise<number> => {
    const { count, error } = await supabase
      .from('bridge_transfers')
      .select('id', { count: 'exact', head: true })
      .eq('status', status);
    if (error) return 0;
    return Number(count ?? 0);
  };
  const [pending, failed, stuck] = await Promise.all([
    countFor('pending'),
    countFor('failed'),
    countFor('stuck'),
  ]);
  return { pending, failed, stuck };
}

export interface BridgeWatcherResult {
  skipped?: string;
  retried: number;
  recovered: number;
  stuck: number;
  scannedMissed: number;
  enqueuedMissed: number;
}

/**
 * One watcher tick. Returns a structured summary for logging. Never throws for
 * a single-row failure — each transfer is isolated so one bad row can't stall
 * the sweep.
 */
export async function runBridgeWatcher(): Promise<BridgeWatcherResult> {
  const cfg = readBridgeConfig();
  const wcfg = readBridgeWatcherConfig();
  if (!wcfg.enabled) return skip('watcher disabled');
  if (!cfg.enabled) return skip('relayer disabled');

  const result: BridgeWatcherResult = {
    retried: 0,
    recovered: 0,
    stuck: 0,
    scannedMissed: 0,
    enqueuedMissed: 0,
  };

  await retrySweep(wcfg, result);
  if (wcfg.scanMissedEvents) {
    await missedEventScan(cfg, wcfg, result);
  }
  return result;
}

function skip(reason: string): BridgeWatcherResult {
  return { skipped: reason, retried: 0, recovered: 0, stuck: 0, scannedMissed: 0, enqueuedMissed: 0 };
}

/** Re-drive stale, non-terminal transfers through the verified relay path. */
async function retrySweep(wcfg: BridgeWatcherConfig, result: BridgeWatcherResult): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase = getWatcherSupabase() as any;
  const cutoffIso = new Date(Date.now() - wcfg.staleMs).toISOString();

  const { data, error } = await supabase
    .from('bridge_transfers')
    .select('*')
    .in('status', ['pending', 'failed'])
    .lt('updated_at', cutoffIso)
    .order('updated_at', { ascending: true })
    .limit(wcfg.batchSize);
  if (error || !Array.isArray(data)) return;

  for (const row of data as Record<string, unknown>[]) {
    const retries = Number(row.retry_count ?? 0);
    if (retries >= wcfg.maxRetries) {
      // Exhausted automatic recovery — park it for an operator and alert.
      await supabase
        .from('bridge_transfers')
        .update({ status: 'stuck', updated_at: new Date().toISOString() })
        .eq('id', String(row.id));
      result.stuck += 1;
      console.error(
        `[bridge-watcher] transfer ${row.id} (${row.source_tx}) exhausted ${wcfg.maxRetries} retries; parked as STUCK for manual review.`,
      );
      continue;
    }

    let body: BridgeRelayBody;
    try {
      body = bodyFromRow(row);
    } catch (err) {
      // Route cannot be resolved unambiguously (legacy family name, no network
      // tag, NAVE_EVM_NETWORK unset) — never guess a network for a money move.
      console.warn(
        `[bridge-watcher] skipping ${row.source_tx}: cannot resolve route (${err instanceof Error ? err.message : err})`,
      );
      continue;
    }

    result.retried += 1;
    try {
      const res = await handleBridgeRelay(body, {
        allowRetry: true,
        maxRetries: wcfg.maxRetries,
      });
      if (res.status === 'completed') result.recovered += 1;
    } catch (err) {
      // The row was already re-marked 'failed' by handleBridgeRelay; the next
      // sweep will retry it (until maxRetries) with its incremented counter.
      console.warn(
        `[bridge-watcher] retry of ${row.source_tx} failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}

/**
 * Scan the source chains for bridge events that never produced a DB row and
 * enqueue them through the standard relay path. Best-effort and defensive: any
 * per-chain error is logged and skipped so one unreachable RPC can't stall the
 * whole tick.
 */
async function missedEventScan(
  cfg: BridgeConfig,
  wcfg: BridgeWatcherConfig,
  result: BridgeWatcherResult,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase = getWatcherSupabase() as any;

  const hasRow = async (sourceTx: string): Promise<boolean> => {
    const { count } = await supabase
      .from('bridge_transfers')
      .select('id', { count: 'exact', head: true })
      .eq('source_tx', sourceTx);
    return Number(count ?? 0) > 0;
  };

  const allowedChains = readBridgeEvmChainIds();

  const enqueue = async (body: BridgeRelayBody): Promise<void> => {
    result.scannedMissed += 1;
    try {
      await handleBridgeRelay(body);
      result.enqueuedMissed += 1;
    } catch (err) {
      console.warn(
        `[bridge-watcher] enqueue of missed ${body.sourceTx} failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  };

  // ── Solana lock events → solana_to_evm ──
  if (cfg.bridgeProgramId) {
    try {
      const connection = getWatcherConnection(cfg);
      const programId = new PublicKey(cfg.bridgeProgramId);
      const configPda = deriveBridgeConfig(programId);
      const sigs: ConfirmedSignatureInfo[] = await connection.getSignaturesForAddress(configPda, {
        limit: wcfg.solanaSignatureLimit,
      });
      for (const sig of sigs) {
        if (sig.err) continue;
        const tx = await connection.getTransaction(sig.signature, {
          commitment: 'finalized',
          maxSupportedTransactionVersion: 0,
        });
        // Attribution-checked decode: the event must be emitted BY nave_bridge
        // (program in account keys + invoked, log inside its invoke bracket).
        const ev = tx ? decodeAttributedBridgeLock(tx, programId) : null;
        if (!ev) continue;
        if (await hasRow(sig.signature)) continue;
        const destChainId = Number(ev.destChainId);
        if (!BRIDGE_EVM_CHAINS[destChainId] || !allowedChains.has(destChainId)) continue;
        if (!cfg.evmLockbox[destChainId] && !cfg.evmLockboxV1?.[destChainId]) continue;
        await enqueue({
          direction: 'solana_to_evm',
          sourceChain: 'solana',
          destChainId,
          sourceTx: sig.signature,
        });
      }
    } catch (err) {
      console.warn(`[bridge-watcher] solana scan failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // ── EVM burn events → evm_to_solana (canonical shared wNAVE) ──
  for (const chainId of allowedChains) {
    const chainCfg = BRIDGE_EVM_CHAINS[chainId];
    const wrapped = cfg.wrappedNave[chainId];
    const rpcUrl = chainCfg ? process.env[chainCfg.rpcEnv] : undefined;
    if (!chainCfg || !wrapped || !rpcUrl) continue;
    try {
      const client = createPublicClient({ chain: chainCfg.chain, transport: http(rpcUrl) }) as PublicClient;
      const head = await client.getBlockNumber();
      const lookback = evmLookbackBlocksFor(chainId, wcfg);
      const fromBlock = head > lookback ? head - lookback : 0n;
      // Chunk the range: a 2h window is ~28.8k blocks on Robinhood and many
      // public RPCs reject eth_getLogs spans above a few thousand blocks.
      for (let start = fromBlock; start <= head; start += EVM_LOGS_CHUNK_BLOCKS) {
        const end = start + EVM_LOGS_CHUNK_BLOCKS - 1n < head ? start + EVM_LOGS_CHUNK_BLOCKS - 1n : head;
        const logs = await client.getLogs({
          address: wrapped as `0x${string}`,
          event: {
            type: 'event',
            name: 'BridgeBurnTo',
            inputs: [
              { indexed: true, name: 'from', type: 'address' },
              { indexed: true, name: 'solanaRecipient', type: 'bytes32' },
              { indexed: false, name: 'amount', type: 'uint256' },
            ],
          },
          fromBlock: start,
          toBlock: end,
        });
        for (const log of logs) {
          const sourceTx = log.transactionHash as Hash | null;
          if (!sourceTx) continue;
          if (await hasRow(sourceTx)) continue;
          await enqueue({
            direction: 'evm_to_solana',
            sourceChainId: chainId,
            destChain: 'solana',
            sourceTx,
          });
        }
      }
    } catch (err) {
      console.warn(
        `[bridge-watcher] evm scan (${chainId}) failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}
