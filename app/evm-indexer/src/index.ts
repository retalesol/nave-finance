/**
 * Nave EVM event indexer (viem polling worker).
 *
 * Reads Nave contract logs on Ethereum and Base (mainnets 1 / 8453 + testnets
 * Sepolia 11155111 / Base Sepolia 84532), normalizes them to the canonical Nave
 * event names, and forwards batches to the shared `index-events` Supabase edge
 * function — the SAME pipeline Helius feeds for Solana. Helius remains the
 * Solana indexer; this worker handles EVM only.
 *
 * Why polling (getLogs) instead of a provider webhook: it is provider-agnostic
 * (works with Alchemy, Ankr, or any JSON-RPC), needs no public ingress, and is
 * trivially resumable via a persisted block cursor. index-events dedups by
 * tx_signature = `${txHash}:${logIndex}`, so a small re-scan overlap on restart
 * is harmless.
 *
 * Env (see .env.example):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   (required)
 *   NAVE_INDEXER_SECRET                        (required — auth to index-events)
 *   EVM_ETHEREUM_RPC_URL / EVM_SEPOLIA_RPC_URL / EVM_BASE_RPC_URL /
 *   EVM_BASE_SEPOLIA_RPC_URL / EVM_ROBINHOOD_RPC_URL /
 *   EVM_ROBINHOOD_TESTNET_RPC_URL              (set the ones you want to index)
 *   EVM_INDEXER_POLL_MS        poll cadence (default 15000)
 *   EVM_LOG_CHUNK_BLOCKS       getLogs block span per request (default 2000)
 *   EVM_FINALITY_TAG           'safe' (default) | 'finalized' | 'none' — scan
 *                              up to this block tag; 'none' falls back to
 *                              head - EVM_CONFIRMATIONS
 *   EVM_CONFIRMATIONS          numeric lag fallback when the RPC does not
 *                              support the finality tag (default 15 L1 / 60 L2)
 *   EVM_REORG_REWIND_BLOCKS    blocks to rewind when the stored cursor block
 *                              hash no longer matches the chain (default 64)
 *   NAVE_EVM_START_BLOCK_<id>  first block to scan (default: chain head)
 *   NAVE_EVM_WATCH_ADDRESSES_<id>  optional 0x,0x allowlist (reduces topic
 *                              collisions; when unset we topic-filter chain-wide)
 *   NAVE_EVM_ABI_PATH          optional synced contract ABI JSON override
 *   PORT                       health endpoint port (default 8788)
 */

import { createServer } from 'node:http';
import { createClient } from '@supabase/supabase-js';
import {
  type AbiEvent,
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  createPublicClient,
  getAddress,
  http,
  type Log,
  type PublicClient,
} from 'viem';
import { enabledChains, type EvmChainConfig } from './chains.js';
import { EVENT_META, loadEventAbi, TREASURY_GETTER_ABI } from './events.js';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[evm-indexer] FATAL: ${name} is not set. Refusing to start.`);
    process.exit(1);
  }
  return v;
}

const SUPABASE_URL = requireEnv('SUPABASE_URL');
const SERVICE_ROLE_KEY = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
const INDEXER_SECRET = requireEnv('NAVE_INDEXER_SECRET');

const POLL_MS = Number(process.env.EVM_INDEXER_POLL_MS ?? 15_000);
const CHUNK_BLOCKS = BigInt(process.env.EVM_LOG_CHUNK_BLOCKS ?? 2_000);
const MAX_BATCH = 500; // index-events caps a request at 500 events.

// ── Reorg safety (FN-M3) ─────────────────────────────────────────────────────
// Scan up to the chain's `safe` (default) or `finalized` block instead of a
// thin fixed lag; 2 blocks behind head is far inside the reorg window on L2s.
const FINALITY_TAG = (process.env.EVM_FINALITY_TAG ?? 'safe') as 'safe' | 'finalized' | 'none';
// Numeric fallback when the RPC doesn't support the finality tag. L2 blocks
// are fast (2s on Base), so they need a deeper lag than L1.
const CONFIRMATIONS_OVERRIDE = process.env.EVM_CONFIRMATIONS ? BigInt(process.env.EVM_CONFIRMATIONS) : null;
const DEFAULT_CONFIRMATIONS_L1 = 15n;
const DEFAULT_CONFIRMATIONS_L2 = 60n;
// If the block hash recorded with the cursor no longer matches the chain, a
// reorg crossed our cursor: rewind this many blocks and re-scan (index-events
// dedups by `${txHash}:${logIndex}`, so the overlap is harmless).
const REORG_REWIND_BLOCKS = BigInt(process.env.EVM_REORG_REWIND_BLOCKS ?? 64);

function fallbackConfirmations(cfg: EvmChainConfig): bigint {
  if (CONFIRMATIONS_OVERRIDE !== null) return CONFIRMATIONS_OVERRIDE;
  // L2s (Base ~2s blocks; Robinhood is Arbitrum Nitro with sub-second blocks)
  // need a deeper numeric lag than L1. Nitro nodes DO serve the safe/finalized
  // tags (mapped to L1 batch posting/finality), so this fallback only fires
  // when EVM_FINALITY_TAG=none or the RPC rejects the tag.
  return cfg.chain === 'ethereum' ? DEFAULT_CONFIRMATIONS_L1 : DEFAULT_CONFIRMATIONS_L2;
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
const EVENT_ABI: AbiEvent[] = loadEventAbi();

interface ParsedEvent {
  dao_onchain_address: string;
  event_type: string;
  description: string;
  actor: string;
  agent_role?: string;
  tx_signature: string;
  slot: number;
  block_time?: string;
  raw_data?: Record<string, unknown>;
  chain: string;
  chain_id: number;
}

/** Recursively convert bigints to strings so the payload is JSON-serializable. */
function sanitize(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = sanitize(v);
    return out;
  }
  return value;
}

function pickActor(args: Record<string, unknown>, candidates: string[]): string {
  for (const key of candidates) {
    const v = args[key];
    if (typeof v === 'string' && v.length > 0) return v.toLowerCase();
  }
  return '';
}

function parseAddressList(envName: string): `0x${string}`[] | undefined {
  const raw = process.env[envName];
  if (!raw) return undefined;
  const list = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^0x[0-9a-f]{40}$/.test(s)) as `0x${string}`[];
  return list.length > 0 ? list : undefined;
}

// ─── Cursor persistence ──────────────────────────────────────────────────────

interface Cursor {
  lastBlock: bigint;
  /** Hash of `lastBlock` when it was scanned; null for legacy rows. */
  lastBlockHash: string | null;
}

async function readCursor(chainId: number): Promise<Cursor | null> {
  const { data, error } = await supabase
    .from('evm_indexer_cursors')
    .select('last_block, last_block_hash')
    .eq('chain_id', chainId)
    .maybeSingle<{ last_block: number; last_block_hash: string | null }>();
  if (error) {
    console.error(`[evm-indexer] cursor read failed for ${chainId}:`, error.message);
    return null;
  }
  return data ? { lastBlock: BigInt(data.last_block), lastBlockHash: data.last_block_hash } : null;
}

async function writeCursor(cfg: EvmChainConfig, lastBlock: bigint, lastBlockHash: string | null): Promise<void> {
  const { error } = await supabase.from('evm_indexer_cursors').upsert(
    {
      chain_id: cfg.chainId,
      chain: cfg.chain,
      last_block: Number(lastBlock),
      last_block_hash: lastBlockHash,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'chain_id' },
  );
  if (error) console.error(`[evm-indexer] cursor write failed for ${cfg.chainId}:`, error.message);
}

// ─── index-events forwarding ─────────────────────────────────────────────────

async function forwardEvents(cfg: EvmChainConfig, events: ParsedEvent[]): Promise<void> {
  if (events.length === 0) return;
  for (let i = 0; i < events.length; i += MAX_BATCH) {
    const batch = events.slice(i, i + MAX_BATCH);
    const resp = await fetch(`${SUPABASE_URL}/functions/v1/index-events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        'X-Indexer-Secret': INDEXER_SECRET,
      },
      body: JSON.stringify({
        events: batch,
        chain: cfg.chain,
        chain_id: cfg.chainId,
      }),
    });
    const text = await resp.text();
    if (!resp.ok) {
      throw new Error(`index-events HTTP ${resp.status}: ${text.slice(0, 300)}`);
    }
    console.log(`[evm-indexer] ${cfg.label}: forwarded ${batch.length} event(s) -> ${text.slice(0, 200)}`);
  }
}

const CACHE_MAX_ENTRIES = 10_000;
// Negative treasury() results (contract reverts — the emitter is not a Nave
// clone, e.g. a topic collision) are re-checked after this TTL instead of
// being remembered forever.
const TREASURY_NEGATIVE_TTL_MS = 60 * 60 * 1000;

interface TreasuryCacheEntry {
  value: string;
  /** ms epoch after which a negative ('') entry must be re-resolved. */
  expiresAt: number | null;
}

function trimCache(map: Map<string, unknown>, max = CACHE_MAX_ENTRIES): void {
  while (map.size > max) {
    const first = map.keys().next().value;
    if (first === undefined) break;
    map.delete(first);
  }
}

interface ChainRuntime {
  cfg: EvmChainConfig;
  client: PublicClient;
  addresses?: `0x${string}`[];
  blockTimeCache: Map<string, string>;
  /** emitter clone address (lowercased) → its treasury() address (lowercased). */
  treasuryCache: Map<string, TreasuryCacheEntry>;
}

/** Thrown when a chunk hit a transient failure and must be retried without advancing the cursor. */
class ChunkRetryError extends Error {}

/** A revert/zero-data response is a property of the contract, not of the RPC. */
function isContractLevelFailure(err: unknown): boolean {
  return (
    err instanceof BaseError &&
    err.walk((e) => e instanceof ContractFunctionRevertedError || e instanceof ContractFunctionZeroDataError) !== null
  );
}

/**
 * Resolve the treasury (DAO) address for a governor/execution clone by reading
 * its `treasury()` getter, caching successes indefinitely.
 *
 * FN-M3: previously a FAILED read was cached as '' forever, so one RPC blip
 * permanently dropped every subsequent event from that governor until restart.
 * Now only contract-level reverts (emitter genuinely has no treasury(), e.g. a
 * topic collision) are negative-cached, and only with a TTL; transient RPC
 * failures throw ChunkRetryError so the whole chunk is retried next tick.
 */
async function resolveTreasury(rt: ChainRuntime, emitter: string): Promise<string> {
  const key = emitter.toLowerCase();
  const cached = rt.treasuryCache.get(key);
  if (cached !== undefined && (cached.expiresAt === null || cached.expiresAt > Date.now())) {
    return cached.value;
  }
  try {
    const addr = (await rt.client.readContract({
      address: getAddress(emitter),
      abi: TREASURY_GETTER_ABI,
      functionName: 'treasury',
    })) as `0x${string}`;
    const resolved = addr.toLowerCase();
    rt.treasuryCache.set(key, { value: resolved, expiresAt: null });
    trimCache(rt.treasuryCache);
    return resolved;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isContractLevelFailure(err)) {
      console.warn(`[evm-indexer] treasury() reverted for ${emitter} (not a Nave clone?) — negative-caching with TTL:`, msg);
      rt.treasuryCache.set(key, { value: '', expiresAt: Date.now() + TREASURY_NEGATIVE_TTL_MS });
      trimCache(rt.treasuryCache);
      return '';
    }
    throw new ChunkRetryError(`treasury() resolve failed transiently for ${emitter}: ${msg}`);
  }
}

async function blockTime(rt: ChainRuntime, blockNumber: bigint): Promise<string | undefined> {
  const key = blockNumber.toString();
  const cached = rt.blockTimeCache.get(key);
  if (cached) return cached;
  try {
    const block = await rt.client.getBlock({ blockNumber });
    const iso = new Date(Number(block.timestamp) * 1000).toISOString();
    rt.blockTimeCache.set(key, iso);
    trimCache(rt.blockTimeCache);
    return iso;
  } catch {
    return undefined;
  }
}

async function normalizeLog(rt: ChainRuntime, log: Log): Promise<ParsedEvent | null> {
  const { cfg } = rt;
  // viem types `eventName`/`args` loosely on a generic Log; narrow here.
  const eventName = (log as unknown as { eventName?: string }).eventName;
  const args = ((log as unknown as { args?: Record<string, unknown> }).args ?? {}) as Record<string, unknown>;
  if (!eventName) return null;
  const meta = EVENT_META[eventName];
  if (!meta) return null;

  const emitter = (log.address ?? '').toLowerCase();
  // Resolve the DAO (treasury) address per the event's daoSource strategy.
  let dao = '';
  if (meta.daoSource === 'emitter') {
    dao = emitter;
  } else if (meta.daoSource === 'arg' && meta.daoArg) {
    const daoRaw = args[meta.daoArg];
    dao = typeof daoRaw === 'string' ? daoRaw.toLowerCase() : '';
  } else if (meta.daoSource === 'treasuryGetter') {
    dao = await resolveTreasury(rt, emitter);
  }
  if (!dao) return null; // unattributable — drop rather than mislabel

  const txHash = log.transactionHash ?? '';
  const logIndex = log.logIndex ?? 0;
  if (!txHash) return null;

  return {
    dao_onchain_address: dao,
    event_type: meta.canonical,
    description: `EVM ${cfg.label} event: ${eventName}`,
    actor: pickActor(args, meta.actorArgs),
    agent_role: meta.agentRole,
    tx_signature: `${txHash}:${logIndex}`,
    slot: Number(log.blockNumber ?? 0n),
    raw_data: sanitize(args) as Record<string, unknown>,
    chain: cfg.chain,
    chain_id: cfg.chainId,
  };
}

/** Highest block we consider settled enough to scan. Prefers the chain's
 *  safe/finalized tag; falls back to a per-chain numeric confirmation lag. */
async function settledHead(rt: ChainRuntime): Promise<bigint> {
  const { cfg, client } = rt;
  if (FINALITY_TAG !== 'none') {
    try {
      const block = await client.getBlock({ blockTag: FINALITY_TAG });
      return block.number ?? 0n;
    } catch (err) {
      console.warn(
        `[evm-indexer] ${cfg.label}: '${FINALITY_TAG}' block tag unavailable, falling back to numeric confirmations:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  const head = await client.getBlockNumber();
  const lag = fallbackConfirmations(cfg);
  return head > lag ? head - lag : 0n;
}

/**
 * Detect a reorg across the persisted cursor: if the block we recorded as
 * `lastBlock` now has a different hash, the canonical chain replaced it —
 * rewind the cursor so replaced/moved logs are re-scanned (dedup makes the
 * overlap safe). Returns the (possibly rewound) cursor block.
 */
async function reorgCheckedCursor(rt: ChainRuntime, cursor: Cursor): Promise<bigint> {
  const { cfg, client } = rt;
  if (!cursor.lastBlockHash) return cursor.lastBlock; // legacy row — hash recorded from now on
  try {
    const block = await client.getBlock({ blockNumber: cursor.lastBlock });
    if (block.hash === cursor.lastBlockHash) return cursor.lastBlock;
  } catch {
    // Block not found at that height (chain shrank past our cursor) — treat as reorg.
  }
  const rewound = cursor.lastBlock > REORG_REWIND_BLOCKS ? cursor.lastBlock - REORG_REWIND_BLOCKS : 0n;
  console.warn(
    `[evm-indexer] ${cfg.label}: REORG detected at block ${cursor.lastBlock} ` +
      `(stored hash ${cursor.lastBlockHash} no longer canonical) — rewinding to ${rewound}.`,
  );
  return rewound;
}

async function scanChain(rt: ChainRuntime): Promise<void> {
  const { cfg, client } = rt;

  const safeHead = await settledHead(rt);

  const stored = await readCursor(cfg.chainId);
  let cursorBlock: bigint;
  if (stored === null) {
    // First run: start at an explicit override, else the current settled head
    // (no historical backfill — set NAVE_EVM_START_BLOCK_<id> to backfill).
    const override = process.env[cfg.startBlockEnv];
    const start = override ? BigInt(override) : safeHead;
    cursorBlock = start > 0n ? start - 1n : 0n;
    await writeCursor(cfg, cursorBlock, null);
    console.log(`[evm-indexer] ${cfg.label}: seeded cursor at block ${cursorBlock}`);
  } else {
    cursorBlock = await reorgCheckedCursor(rt, stored);
  }

  let fromBlock = cursorBlock + 1n;
  if (fromBlock > safeHead) return; // nothing new beyond the settled head

  while (fromBlock <= safeHead) {
    const toBlock = fromBlock + CHUNK_BLOCKS - 1n > safeHead ? safeHead : fromBlock + CHUNK_BLOCKS - 1n;

    const logs = (await client.getLogs({
      events: EVENT_ABI,
      fromBlock,
      toBlock,
      ...(rt.addresses ? { address: rt.addresses } : {}),
    })) as Log[];

    const events: ParsedEvent[] = [];
    for (const log of logs) {
      const ev = await normalizeLog(rt, log);
      if (!ev) continue;
      ev.block_time = await blockTime(rt, log.blockNumber ?? toBlock);
      events.push(ev);
    }

    // Forward BEFORE advancing the cursor so a forward failure is retried.
    await forwardEvents(cfg, events);
    // Record the hash of toBlock alongside the height for reorg detection.
    let toBlockHash: string | null = null;
    try {
      toBlockHash = (await client.getBlock({ blockNumber: toBlock })).hash ?? null;
    } catch {
      // Hash unavailable — cursor still advances; the next tick re-records it.
    }
    await writeCursor(cfg, toBlock, toBlockHash);
    if (events.length > 0) {
      console.log(`[evm-indexer] ${cfg.label}: blocks ${fromBlock}-${toBlock} -> ${events.length} event(s)`);
    }
    fromBlock = toBlock + 1n;
  }
}

// ─── Main loop ───────────────────────────────────────────────────────────────

function buildRuntimes(): ChainRuntime[] {
  return enabledChains().map((cfg) => ({
    cfg,
    client: createPublicClient({ chain: cfg.viemChain, transport: http(cfg.rpcUrl) }) as PublicClient,
    addresses: parseAddressList(cfg.watchAddressesEnv),
    blockTimeCache: new Map(),
    treasuryCache: new Map(),
  }));
}

const runtimes = buildRuntimes();

if (runtimes.length === 0) {
  console.error(
    '[evm-indexer] FATAL: no EVM chains configured. Set at least one of ' +
      'EVM_ETHEREUM_RPC_URL, EVM_SEPOLIA_RPC_URL, EVM_BASE_RPC_URL, EVM_BASE_SEPOLIA_RPC_URL.',
  );
  process.exit(1);
}

const running = new Set<number>();

async function tick(): Promise<void> {
  await Promise.all(
    runtimes.map(async (rt) => {
      if (running.has(rt.cfg.chainId)) {
        console.warn(`[evm-indexer] ${rt.cfg.label}: previous scan still running; skipping tick.`);
        return;
      }
      running.add(rt.cfg.chainId);
      try {
        await scanChain(rt);
      } catch (err) {
        console.error(`[evm-indexer] ${rt.cfg.label}: scan failed:`, err instanceof Error ? err.message : err);
      } finally {
        running.delete(rt.cfg.chainId);
      }
    }),
  );
}

// Minimal health endpoint for platform health checks.
const PORT = Number(process.env.PORT ?? 8788);
createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      ok: true,
      service: 'evm-indexer',
      chains: runtimes.map((r) => ({ chainId: r.cfg.chainId, label: r.cfg.label, addressFiltered: !!r.addresses })),
    }),
  );
}).listen(PORT, () => console.log(`[evm-indexer] health endpoint on :${PORT}`));

console.log(
  `[evm-indexer] starting. chains: ${runtimes.map((r) => `${r.cfg.label}(${r.cfg.chainId})`).join(', ')}; ` +
    `poll ${POLL_MS}ms, chunk ${CHUNK_BLOCKS} blocks, finality '${FINALITY_TAG}' ` +
    `(fallback lag: ${runtimes.map((r) => `${r.cfg.label}=${fallbackConfirmations(r.cfg)}`).join(', ')}), ` +
    `reorg rewind ${REORG_REWIND_BLOCKS} blocks.`,
);

void tick();
setInterval(() => void tick(), POLL_MS);
