// Hermetic mock servers for signer-service integration tests.
//
// NOT a *.test.ts file — `npm test` globs src/**/*.test.ts, so this module is
// only ever pulled in as a helper by the integration test files. It provides
// three local HTTP servers that impersonate the real network surfaces the
// relayer talks to, so `handleBridgeRelay` / `runStakingMirror` can be driven
// through their REAL code paths (web3.js Connection, viem clients,
// supabase-js) with zero live-network dependencies:
//
//   • startJsonRpcMock  — a JSON-RPC 2.0 endpoint (Solana RPC or EVM RPC).
//     Also accepts (and immediately parks) WebSocket upgrades so web3.js's
//     signatureSubscribe-based `confirmTransaction` can connect; confirmation
//     is then resolved through the HTTP block-height/status fallback path.
//   • startSupabaseMock — a minimal PostgREST server with in-memory tables,
//     unique-constraint enforcement (real 23505 conflicts), eq-filters,
//     head+count queries, ignore-duplicates upserts, and fault injection.
//
// Every server binds an ephemeral port on 127.0.0.1 and tracks its sockets so
// teardown is deterministic.

import { createHash } from 'crypto';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Socket } from 'net';

// supabase-js v2 instantiates a RealtimeClient on createClient() and requires
// a WebSocket constructor to exist (Node < 22 has no native global). The
// relayer modules never use realtime, so a inert stub satisfies the check
// without opening any connection.
if (typeof (globalThis as { WebSocket?: unknown }).WebSocket === 'undefined') {
  class InertWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    readyState = InertWebSocket.CLOSED;
    close(): void {}
    send(): void {}
    addEventListener(): void {}
    removeEventListener(): void {}
  }
  (globalThis as { WebSocket?: unknown }).WebSocket = InertWebSocket;
}

// ─── Common plumbing ──────────────────────────────────────────────────────────

interface BaseMock {
  url: string;
  close: () => Promise<void>;
}

function listen(server: http.Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

function trackSockets(server: http.Server): Set<Socket> {
  const sockets = new Set<Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  return sockets;
}

function closer(server: http.Server, sockets: Set<Socket>): () => Promise<void> {
  return () =>
    new Promise((resolve) => {
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
    });
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ─── JSON-RPC mock (Solana RPC / EVM RPC) ─────────────────────────────────────

/** Handler for one JSON-RPC method. Return value becomes `result`. */
export type RpcHandler = (params: unknown[]) => unknown;

export interface RpcCall {
  method: string;
  params: unknown[];
}

export interface JsonRpcMock extends BaseMock {
  /** Live handler table — tests may swap handlers between cases. */
  handlers: Record<string, RpcHandler>;
  /** Every request received, in order (for call-count / ordering assertions). */
  calls: RpcCall[];
}

/**
 * Start a JSON-RPC 2.0 mock. Unknown methods return a JSON-RPC error naming
 * the method so a missing handler fails tests loudly instead of hanging.
 * WebSocket upgrade requests are accepted with a valid handshake and then
 * parked (best-effort — web3.js actually derives its pubsub endpoint as HTTP
 * port + 1, so its signatureSubscribe attempts fail harmlessly and
 * confirmations resolve via the HTTP fallback: block-height expiry →
 * getSignatureStatuses, i.e. the confirmSolanaTransactionRobust path). The
 * dangling reconnect timers this leaves behind are why `npm test` runs with
 * --test-force-exit.
 */
export async function startJsonRpcMock(handlers: Record<string, RpcHandler>): Promise<JsonRpcMock> {
  const calls: RpcCall[] = [];
  const live: Record<string, RpcHandler> = { ...handlers };

  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const requests = Array.isArray(payload) ? payload : [payload];
    const responses = requests.map((r) => {
      const { id, method, params } = r as { id: number; method: string; params?: unknown[] };
      calls.push({ method, params: params ?? [] });
      const handler = live[method];
      if (!handler) {
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `mock: no handler for method ${method}` } };
      }
      try {
        return { jsonrpc: '2.0', id, result: handler(params ?? []) };
      } catch (err) {
        return { jsonrpc: '2.0', id, error: { code: -32000, message: err instanceof Error ? err.message : String(err) } };
      }
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(Array.isArray(payload) ? responses : responses[0]));
  });

  const sockets = trackSockets(server);
  // Minimal WS handshake so web3.js's rpc-websockets client "connects" and
  // stays quiet; subscribe messages are parked (never answered).
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    const accept = createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    sockets.add(socket as Socket);
    socket.on('close', () => sockets.delete(socket as Socket));
  });

  const url = await listen(server);
  return { url, close: closer(server, sockets), handlers: live, calls };
}

// ─── Supabase PostgREST mock ──────────────────────────────────────────────────

export type SupabaseRow = Record<string, unknown>;

export interface SupabaseMockTable {
  rows: SupabaseRow[];
  /** Column with a UNIQUE constraint (insert conflicts return code 23505). */
  unique?: string;
}

export interface SupabaseMock extends BaseMock {
  tables: Record<string, SupabaseMockTable>;
  /**
   * Inject a one-shot 500 on the next INSERT into `table` whose row matches
   * `predicate` (used for the audit-insert-failure reconciliation tests).
   */
  failNextInsert: (table: string, predicate: (row: SupabaseRow) => boolean) => void;
}

let rowIdCounter = 0;

function applyEqFilters(rows: SupabaseRow[], query: URLSearchParams): SupabaseRow[] {
  let out = rows;
  for (const [col, raw] of query.entries()) {
    if (col === 'select' || col === 'on_conflict' || col === 'columns' || col === 'order' || col === 'limit') continue;
    if (!raw.startsWith('eq.')) continue;
    const want = raw.slice(3);
    out = out.filter((r) => {
      const v = r[col];
      if (v === null || v === undefined) return want === 'null';
      return String(v) === want;
    });
  }
  return out;
}

/**
 * Start a minimal PostgREST-compatible server backed by in-memory tables.
 * Supports the exact supabase-js surface the relayer modules use:
 *   insert().select().single(), select().eq().single(), update().eq(),
 *   select(col, { count: 'exact', head: true }).eq()..., and
 *   upsert(rows, { onConflict, ignoreDuplicates: true }).
 */
export async function startSupabaseMock(tables: Record<string, SupabaseMockTable>): Promise<SupabaseMock> {
  const pendingInsertFailures: Array<{ table: string; predicate: (row: SupabaseRow) => boolean }> = [];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://mock');
    const m = url.pathname.match(/^\/rest\/v1\/([^/]+)$/);
    if (!m) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: `mock: unknown path ${url.pathname}` }));
      return;
    }
    const tableName = m[1];
    const table = tables[tableName];
    if (!table) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: `mock: unknown table ${tableName}` }));
      return;
    }

    const prefer = String(req.headers.prefer ?? '');
    const accept = String(req.headers.accept ?? '');
    const wantsObject = accept.includes('application/vnd.pgrst.object+json');
    const wantsRepresentation = prefer.includes('return=representation');
    const wantsCount = prefer.includes('count=exact');
    const ignoreDuplicates = prefer.includes('resolution=ignore-duplicates');

    const respond = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(payload === undefined ? undefined : JSON.stringify(payload));
    };

    if (req.method === 'GET' || req.method === 'HEAD') {
      const matched = applyEqFilters(table.rows, url.searchParams);
      const headers: Record<string, string> = {};
      if (wantsCount) headers['content-range'] = `*/${matched.length}`;
      if (req.method === 'HEAD') {
        res.writeHead(200, { 'content-type': 'application/json', ...headers });
        res.end();
        return;
      }
      if (wantsObject) {
        if (matched.length !== 1) {
          respond(406, { code: 'PGRST116', message: `mock: expected 1 row, got ${matched.length}` }, headers);
          return;
        }
        respond(200, matched[0], headers);
        return;
      }
      respond(200, matched, headers);
      return;
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      const parsed = JSON.parse(body) as SupabaseRow | SupabaseRow[];
      const incoming = Array.isArray(parsed) ? parsed : [parsed];

      const failureIdx = pendingInsertFailures.findIndex(
        (f) => f.table === tableName && incoming.some((row) => f.predicate(row)),
      );
      if (failureIdx >= 0) {
        pendingInsertFailures.splice(failureIdx, 1);
        respond(500, { code: 'XX000', message: 'mock: injected insert failure' });
        return;
      }

      const insertedRows: SupabaseRow[] = [];
      for (const row of incoming) {
        if (table.unique) {
          const dup = table.rows.find((r) => r[table.unique!] === row[table.unique!]);
          if (dup) {
            if (ignoreDuplicates) continue; // upsert(..., ignoreDuplicates) skips silently
            respond(409, {
              code: '23505',
              message: `duplicate key value violates unique constraint "${tableName}_${table.unique}_key"`,
              details: `Key (${table.unique})=(${String(row[table.unique])}) already exists.`,
              hint: null,
            });
            return;
          }
        }
        const stored: SupabaseRow = { id: String(++rowIdCounter), created_at: new Date().toISOString(), ...row };
        table.rows.push(stored);
        insertedRows.push(stored);
      }

      if (!wantsRepresentation) {
        respond(201, undefined);
        return;
      }
      if (wantsObject) {
        respond(201, insertedRows[0]);
        return;
      }
      respond(201, insertedRows);
      return;
    }

    if (req.method === 'PATCH') {
      const body = await readBody(req);
      const patch = JSON.parse(body) as SupabaseRow;
      const matched = applyEqFilters(table.rows, url.searchParams);
      for (const row of matched) Object.assign(row, patch);
      if (!wantsRepresentation) {
        respond(204, undefined);
        return;
      }
      if (wantsObject) {
        if (matched.length !== 1) {
          respond(406, { code: 'PGRST116', message: `mock: expected 1 row, got ${matched.length}` });
          return;
        }
        respond(200, matched[0]);
        return;
      }
      respond(200, matched);
      return;
    }

    respond(405, { message: `mock: unsupported method ${req.method}` });
  });

  const sockets = trackSockets(server);
  const url = await listen(server);
  return {
    url,
    close: closer(server, sockets),
    tables,
    failNextInsert: (t, predicate) => pendingInsertFailures.push({ table: t, predicate }),
  };
}

// ─── Prebuilt handler kits ────────────────────────────────────────────────────

/** 32 zero bytes as a valid-looking base58 blockhash (decodes to 32 bytes). */
export const MOCK_BLOCKHASH = 'EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k';

export interface SolanaRpcState {
  /** Signatures of every transaction submitted via sendTransaction (base58). */
  sentTransactions: string[];
  /** Raw base64 payloads of every submitted transaction, in order. */
  sentRawTransactions: string[];
}

/**
 * Baseline Solana RPC handlers: blockhash issuance, transaction acceptance,
 * and a confirmation path that resolves through web3.js's block-height-expiry
 * fallback (getBlockHeight already past lastValidBlockHeight) followed by a
 * successful getSignatureStatuses — exercising confirmSolanaTransactionRobust
 * exactly as a slow real RPC would.
 */
export function solanaBaseHandlers(state: SolanaRpcState): Record<string, RpcHandler> {
  return {
    getLatestBlockhash: () => ({
      context: { slot: 100 },
      value: { blockhash: MOCK_BLOCKHASH, lastValidBlockHeight: 1000 },
    }),
    // Immediately past lastValidBlockHeight → confirmTransaction rejects with
    // the blockheight-exceeded error → the robust helper falls back to
    // getSignatureStatuses below.
    getBlockHeight: () => 5000,
    sendTransaction: (params) => {
      const rawB64 = String(params[0]);
      state.sentRawTransactions.push(rawB64);
      // Signature = bytes 1..65 of the serialized tx (shortvec count, then sigs).
      const raw = Buffer.from(rawB64, 'base64');
      const sig = bs58encode(raw.subarray(1, 65));
      state.sentTransactions.push(sig);
      return sig;
    },
    getSignatureStatuses: () => ({
      context: { slot: 100 },
      value: [{ slot: 100, confirmations: null, err: null, confirmationStatus: 'confirmed' }],
    }),
  };
}

// Tiny local base58 encoder (avoids importing bs58 into the helper).
const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function bs58encode(bytes: Uint8Array): string {
  let x = BigInt(`0x${Buffer.from(bytes).toString('hex') || '0'}`);
  let out = '';
  while (x > 0n) {
    out = B58_ALPHABET[Number(x % 58n)] + out;
    x /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

export interface EvmRpcState {
  chainIdHex: string;
  /** Raw signed transactions accepted via eth_sendRawTransaction, in order. */
  sentRawTransactions: `0x${string}`[];
  /** Tx hashes returned for those sends, in order. */
  sentTxHashes: `0x${string}`[];
  /** Per-hash receipt overrides (hash → receipt object or handler). */
  receipts: Map<string, unknown>;
  /** When set, the NEXT mined receipt reports status 0x0 (revert). One-shot. */
  revertNextTransaction: boolean;
  nonce: number;
  blockNumberHex: string;
  /**
   * Address returned by `WrappedNave.minter()` (eth_call). The relayer's
   * `resolveMintLockbox` reads this to pick the v2/v1 lockbox; tests set it to
   * the configured lockbox address so the mint path resolves.
   */
  minterAddress: `0x${string}`;
}

export function makeEvmRpcState(chainIdHex: string, minterAddress: `0x${string}` = `0x${'00'.repeat(20)}`): EvmRpcState {
  return {
    chainIdHex,
    sentRawTransactions: [],
    sentTxHashes: [],
    receipts: new Map(),
    revertNextTransaction: false,
    nonce: 0,
    blockNumberHex: '0x64',
    minterAddress,
  };
}

/** keccak256("minter()")[0..4] — the only view the bridge relayer itself calls. */
export const MINTER_SELECTOR = '0x07546172';

/** ABI-encode a 20-byte address as a 32-byte word (eth_call return). */
export function encodeAddressWord(address: string): `0x${string}` {
  return `0x${address.replace(/^0x/, '').toLowerCase().padStart(64, '0')}`;
}

/**
 * Baseline `eth_call` dispatcher: answers `minter()` from `state.minterAddress`
 * and delegates any other selector to `fallback` (or fails loudly).
 */
export function evmCallHandler(
  state: EvmRpcState,
  fallback?: (selector: string, params: unknown[]) => unknown,
): RpcHandler {
  return (params) => {
    const call = (params[0] ?? {}) as { data?: string; input?: string };
    const data = String(call.data ?? call.input ?? '').toLowerCase();
    const selector = data.slice(0, 10);
    if (selector === MINTER_SELECTOR) return encodeAddressWord(state.minterAddress);
    if (fallback) return fallback(selector, params);
    throw new Error(`mock: eth_call selector ${selector} not handled`);
  };
}

/**
 * Baseline EVM RPC handlers sufficient for viem's writeContract →
 * sendRawTransaction → waitForTransactionReceipt pipeline (EIP-1559 fee
 * estimation included). Successful receipts are synthesized for every raw
 * transaction accepted; per-hash overrides go through `state.receipts`.
 */
export function evmBaseHandlers(
  state: EvmRpcState,
  hashRawTx: (raw: `0x${string}`) => `0x${string}`,
): Record<string, RpcHandler> {
  return {
    eth_chainId: () => state.chainIdHex,
    eth_blockNumber: () => state.blockNumberHex,
    eth_getTransactionCount: () => `0x${(state.nonce).toString(16)}`,
    eth_estimateGas: () => '0x30000',
    eth_maxPriorityFeePerGas: () => '0x3b9aca00',
    eth_gasPrice: () => '0x3b9aca00',
    eth_getBlockByNumber: () => ({
      number: state.blockNumberHex,
      hash: `0x${'11'.repeat(32)}`,
      parentHash: `0x${'22'.repeat(32)}`,
      baseFeePerGas: '0x3b9aca00',
      gasLimit: '0x1c9c380',
      gasUsed: '0x0',
      timestamp: '0x66000000',
      miner: `0x${'00'.repeat(20)}`,
      difficulty: '0x0',
      totalDifficulty: '0x0',
      extraData: '0x',
      logsBloom: `0x${'00'.repeat(256)}`,
      mixHash: `0x${'00'.repeat(32)}`,
      nonce: '0x0000000000000000',
      receiptsRoot: `0x${'00'.repeat(32)}`,
      sha3Uncles: `0x${'00'.repeat(32)}`,
      size: '0x0',
      stateRoot: `0x${'00'.repeat(32)}`,
      transactions: [],
      transactionsRoot: `0x${'00'.repeat(32)}`,
      uncles: [],
    }),
    eth_sendRawTransaction: (params) => {
      const raw = String(params[0]) as `0x${string}`;
      const hash = hashRawTx(raw);
      state.sentRawTransactions.push(raw);
      state.sentTxHashes.push(hash);
      state.nonce += 1;
      const status = state.revertNextTransaction ? '0x0' : '0x1';
      state.revertNextTransaction = false;
      state.receipts.set(hash, {
        transactionHash: hash,
        transactionIndex: '0x0',
        blockHash: `0x${'33'.repeat(32)}`,
        blockNumber: state.blockNumberHex,
        from: `0x${'00'.repeat(20)}`,
        to: `0x${'00'.repeat(20)}`,
        contractAddress: null,
        cumulativeGasUsed: '0x5208',
        gasUsed: '0x5208',
        effectiveGasPrice: '0x3b9aca00',
        logs: [],
        logsBloom: `0x${'00'.repeat(256)}`,
        status,
        type: '0x2',
      });
      return hash;
    },
    eth_getTransactionReceipt: (params) => {
      const hash = String(params[0]);
      return state.receipts.get(hash) ?? null;
    },
    eth_getLogs: () => [],
    eth_call: evmCallHandler(state),
  };
}
