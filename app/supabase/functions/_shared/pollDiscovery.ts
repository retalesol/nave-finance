// Pure poll-discovery and dispatcher-key rules. No Deno imports so Node tests
// can load this module. The orchestrator is the only caller that performs RPC;
// it may call enumerateEvmExecutionIndices only for a target with enumerate set.

export const SAFETY_SWEEP_MS = 15 * 60 * 1000;
/** Short review windows are armed inside the poll that first sees them. */
export const IN_ISOLATE_WAKE_MAX_MS = 120_000;
/** Wake slightly after reviewEnd so the on-chain check is not early. */
export const REVIEW_WAKE_CUSHION_MS = 1_000;
const LATE_GRACE_MS = 90_000;

export const OPEN_REQUEST_EVENT_TYPES = [
  "ExecutionRequestCreated",
  "ExecutionRequestQueued",
  "AgentApprovalEvent",
  "ExecutiveApprovedEvent",
  "FinancialApprovedEvent",
  "OversightApprovedEvent",
  "OperationalHaltEvent",
  "OperationalClearEvent",
  "AgentApproval",
  "ExecutiveApproved",
  "FinancialApproved",
  "OversightApproved",
  "OperationalHalt",
  "OperationalClear",
] as const;

export const TERMINAL_REQUEST_EVENT_TYPES = [
  "ExecutionExpired",
  "StrategyExecuted",
  "StrategyExecutedEvent",
  "DirectStrategyExecuted",
  "DirectStrategyExecutedEvent",
] as const;

export const INDEXED_REQUEST_EVENT_TYPES = [
  ...OPEN_REQUEST_EVENT_TYPES,
  ...TERMINAL_REQUEST_EVENT_TYPES,
];

const OPEN_EVENTS = new Set<string>(OPEN_REQUEST_EVENT_TYPES);
const EXPIRED_EVENTS = new Set<string>(["ExecutionExpired"]);
const EXECUTED_EVENTS = new Set<string>(
  TERMINAL_REQUEST_EVENT_TYPES.filter((name) => name !== "ExecutionExpired"),
);
export const REVIEW_END_EVENT_TYPES = new Set<string>([
  "OversightApprovedEvent",
  "OversightApproved",
]);

const EVM_CHAINS = new Set(["ethereum", "base", "robinhood", "arc"]);

/** Role that would be sent to agent-dispatcher for this on-chain status. */
const DISPATCH_ROLE: Record<string, string> = {
  Pending: "executive",
  ExecutiveApproved: "financial",
  FinancialApproved: "oversight",
  OversightApproved: "operational",
  InReview: "operational",
  Halted: "operational",
};

export function dispatcherRoleForStatus(status: string): string | null {
  return DISPATCH_ROLE[status] ?? null;
}

export interface IndexedActivityRow {
  dao_onchain_address?: string | null;
  event_type?: string | null;
  raw_data?: Record<string, unknown> | null;
  chain?: string | null;
  chain_id?: number | string | null;
  created_at?: string | null;
}

export interface IndexedActionRow {
  dao_onchain_address?: string | null;
  execution_request_address?: string | null;
  chain?: string | null;
  chain_id?: number | string | null;
  created_at?: string | null;
}

export interface SolanaReadTarget {
  dao: string;
  executionRequest: string;
}

export interface EvmWorkTarget {
  dao: string;
  chainId: number | null;
  chain: string;
  index: number | null;
  executionAddress: string | null;
  /** True only when an indexed hint exists and its index is unknown. */
  enumerate: boolean;
}

export interface PollRpcPlan {
  solanaRead: SolanaReadTarget[];
  /** Solana DAOs whose indexed hint has no execution-request address. */
  solanaEnumerate: string[];
  solanaDaos: string[];
  evmTargets: EvmWorkTarget[];
  /** Registry rows that have no indexed request and must not be RPC-scanned. */
  idleSkipped: string[];
}

export interface DispatchCandidate {
  dao: string;
  chainId?: number | null;
  status: string;
  role?: string;
}

export interface AgentKeyIndex {
  /** `${dao}:${role}` */
  solana: ReadonlySet<string>;
  /** `${daoLower}:${chainId}:${role}` */
  evm: ReadonlySet<string>;
}

export interface ReviewWake {
  dao_address: string;
  execution_request_address: string;
  review_end: number;
}

export function reviewEndFromRaw(raw: Record<string, unknown> | null | undefined): number | null {
  if (!raw) return null;
  const value = raw.reviewEnd ?? raw.review_end;
  const parsed = asPositiveInt(value);
  if (parsed == null) return null;
  return parsed > 1e12 ? Math.floor(parsed / 1000) : parsed;
}

export function indexFromRaw(raw: Record<string, unknown> | null | undefined): number | null {
  if (!raw) return null;
  for (const key of ["index", "proposalIndex", "proposal_index", "request_index"]) {
    const parsed = asPositiveInt(raw[key], true);
    if (parsed != null) return parsed;
  }
  return null;
}

export function parseSyntheticEvmKey(key: string): { execution: string; index: number } | null {
  const splitAt = key.lastIndexOf("#");
  if (splitAt <= 0) return null;
  const execution = key.slice(0, splitAt).toLowerCase();
  const index = Number(key.slice(splitAt + 1));
  if (!/^0x[0-9a-f]{40}$/.test(execution) || !Number.isInteger(index) || index < 0) return null;
  return { execution, index };
}

/**
 * Seconds until `reviewEnd`, classified against the safety-sweep horizon.
 * A 60s testnet window is "schedule". A 24h window stays "skip" until the
 * last sweep interval, when a single timer replaces a per-minute scan.
 */
export function shouldScheduleReviewWake(
  reviewEndSecs: number,
  nowMs: number,
  opts?: { horizonMs?: number; lateGraceMs?: number },
): "schedule" | "fire_now" | "skip" {
  if (!Number.isFinite(reviewEndSecs) || reviewEndSecs <= 0) return "skip";
  const horizon = opts?.horizonMs ?? SAFETY_SWEEP_MS;
  const grace = opts?.lateGraceMs ?? LATE_GRACE_MS;
  const delay = reviewEndSecs * 1000 - nowMs;
  if (delay > horizon) return "skip";
  if (delay > 0) return "schedule";
  if (delay >= -grace) return "fire_now";
  return "skip";
}

export function reviewWakeDelayMs(reviewEndSecs: number, nowMs: number): number {
  return Math.max(0, reviewEndSecs * 1000 - nowMs) + REVIEW_WAKE_CUSHION_MS;
}

export function reviewWakesFromIndexedRows(
  rows: IndexedActivityRow[],
  nowMs: number,
): ReviewWake[] {
  const out: ReviewWake[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row.event_type || !REVIEW_END_EVENT_TYPES.has(row.event_type)) continue;
    const dao = row.dao_onchain_address?.trim();
    if (!dao) continue;
    const reviewEnd = reviewEndFromRaw(row.raw_data);
    if (reviewEnd == null) continue;
    if (shouldScheduleReviewWake(reviewEnd, nowMs) === "skip") continue;
    const index = indexFromRaw(row.raw_data);
    const er = solanaAddressFromRaw(row.raw_data) ?? (index != null ? String(index) : "");
    const key = `${daoKey(dao)}:${er}:${reviewEnd}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ dao_address: dao, execution_request_address: er, review_end: reviewEnd });
  }
  return out;
}

export function planPollRpc(args: {
  activity?: IndexedActivityRow[] | null;
  actions?: IndexedActionRow[] | null;
  registryDaos?: Array<{ dao?: string | null; chainId?: number | null }> | null;
  includeExecutedFollowUps?: boolean;
}): PollRpcPlan {
  const includeExecuted = args.includeExecutedFollowUps !== false;
  const hints: Hint[] = [];
  for (const row of args.activity ?? []) {
    const hint = hintFromActivity(row);
    if (hint) hints.push(hint);
  }
  for (const row of args.actions ?? []) {
    const hint = hintFromAction(row);
    if (hint) hints.push(hint);
  }
  hints.sort((a, b) => a.at - b.at);

  const tracks = new Map<string, Tracked>();
  for (const hint of hints) {
    const id = trackId(hint);
    const prev = tracks.get(id);
    const state = hint.kind === "expired"
      ? "expired"
      : hint.kind === "executed"
        ? "executed"
        : "open";
    tracks.set(id, {
      dao: hint.dao,
      chain: hint.chain || prev?.chain || (hint.evm ? "ethereum" : "solana"),
      chainId: hint.chainId ?? prev?.chainId ?? null,
      er: hint.er ?? prev?.er ?? null,
      index: hint.index ?? prev?.index ?? null,
      executionAddress: hint.executionAddress ?? prev?.executionAddress ?? null,
      evm: hint.evm,
      state,
    });
  }

  const solanaRead: SolanaReadTarget[] = [];
  const solanaEnumerate: string[] = [];
  const evmTargets: EvmWorkTarget[] = [];
  const seenSolanaEr = new Set<string>();
  const seenEvm = new Set<string>();

  for (const track of tracks.values()) {
    if (track.state === "expired") continue;
    if (track.state === "executed" && !includeExecuted) continue;
    if (track.evm) {
      const enumerate = track.index == null && track.state === "open";
      if (track.index == null && !enumerate) continue;
      const dedupe = `${daoKey(track.dao)}:${track.chainId ?? "na"}:${track.index ?? "enum"}`;
      if (seenEvm.has(dedupe)) continue;
      seenEvm.add(dedupe);
      evmTargets.push({
        dao: track.dao.startsWith("0x") || track.dao.startsWith("0X") ? track.dao.toLowerCase() : track.dao,
        chainId: track.chainId,
        chain: track.chain,
        index: track.index,
        executionAddress: track.executionAddress,
        enumerate,
      });
      continue;
    }
    if (track.er) {
      if (seenSolanaEr.has(track.er)) continue;
      seenSolanaEr.add(track.er);
      solanaRead.push({ dao: track.dao, executionRequest: track.er });
    } else if (track.state === "open") {
      solanaEnumerate.push(track.dao);
    }
  }

  const daosWithAddress = new Set(solanaRead.map((target) => target.dao));
  const solanaEnumUnique = [...new Set(solanaEnumerate.filter((dao) => !daosWithAddress.has(dao)))];
  const solanaDaos = [...new Set([
    ...solanaRead.map((target) => target.dao),
    ...solanaEnumUnique,
  ])];
  const daosWithEvmIndex = new Set(
    evmTargets.filter((target) => target.index != null).map((target) => daoKey(target.dao)),
  );
  const evmConcrete = evmTargets.filter(
    (target) => !target.enumerate || !daosWithEvmIndex.has(daoKey(target.dao)),
  );

  const touched = new Set<string>([
    ...solanaDaos.map(daoKey),
    ...evmConcrete.map((target) => daoKey(target.dao)),
  ]);
  const idleSkipped: string[] = [];
  for (const row of args.registryDaos ?? []) {
    const dao = row.dao?.trim();
    if (!dao || touched.has(daoKey(dao))) continue;
    idleSkipped.push(dao);
  }

  return {
    solanaRead,
    solanaEnumerate: solanaEnumUnique,
    solanaDaos,
    evmTargets: evmConcrete,
    idleSkipped,
  };
}

/**
 * True when this work item may call agent-dispatcher.
 * Executed follow-ups do not call the dispatcher, so they are not key-gated here.
 * An EVM item with no chain id fails closed.
 */
export function hasActiveAgentKey(item: DispatchCandidate, keys: AgentKeyIndex): boolean {
  const role = item.role || dispatcherRoleForStatus(item.status);
  if (!role) return true;
  const evm = item.chainId != null || item.dao.startsWith("0x") || item.dao.startsWith("0X");
  if (!evm) return keys.solana.has(`${item.dao}:${role}`);
  if (item.chainId == null) return false;
  return keys.evm.has(`${item.dao.toLowerCase()}:${item.chainId}:${role}`);
}

/**
 * Drop missing-key dispatcher work before the cap so those DAOs do not consume
 * a dispatcher slot. Order of the remaining items is preserved.
 */
export function selectDispatchableWork<T>(
  items: T[],
  hasKey: (item: T) => boolean,
  max: number,
): { dispatch: T[]; parkedMissingKey: T[]; capped: number } {
  const parkedMissingKey: T[] = [];
  const eligible: T[] = [];
  for (const item of items) {
    if (hasKey(item)) eligible.push(item);
    else parkedMissingKey.push(item);
  }
  if (max >= 0 && eligible.length > max) {
    return {
      dispatch: eligible.slice(0, max),
      parkedMissingKey,
      capped: eligible.length - max,
    };
  }
  return { dispatch: eligible, parkedMissingKey, capped: 0 };
}

interface Hint {
  at: number;
  dao: string;
  chain: string;
  chainId: number | null;
  evm: boolean;
  kind: "open" | "executed" | "expired";
  er: string | null;
  index: number | null;
  executionAddress: string | null;
}

interface Tracked extends Omit<Hint, "at" | "kind"> {
  state: "open" | "executed" | "expired";
}

function hintFromActivity(row: IndexedActivityRow): Hint | null {
  const eventType = row.event_type ?? "";
  const kind = EXPIRED_EVENTS.has(eventType)
    ? "expired"
    : EXECUTED_EVENTS.has(eventType)
      ? "executed"
      : OPEN_EVENTS.has(eventType)
        ? "open"
        : null;
  if (!kind) return null;
  const dao = row.dao_onchain_address?.trim();
  if (!dao) return null;
  const chainId = asChainId(row.chain_id);
  const chain = (row.chain ?? "").toLowerCase();
  const evm = isEvm(dao, chain, chainId);
  const synthetic = syntheticFromRaw(row.raw_data);
  const er = evm ? null : solanaAddressFromRaw(row.raw_data);
  return {
    at: atMs(row.created_at),
    dao,
    chain,
    chainId,
    evm,
    kind,
    er,
    index: indexFromRaw(row.raw_data) ?? synthetic?.index ?? null,
    executionAddress: synthetic?.execution ?? null,
  };
}

function hintFromAction(row: IndexedActionRow): Hint | null {
  const dao = row.dao_onchain_address?.trim();
  const address = row.execution_request_address?.trim();
  if (!dao || !address) return null;
  const chainId = asChainId(row.chain_id);
  const chain = (row.chain ?? "").toLowerCase();
  const synthetic = parseSyntheticEvmKey(address);
  const evm = synthetic != null || isEvm(dao, chain, chainId) || address.startsWith("0x");
  return {
    at: atMs(row.created_at),
    dao,
    chain,
    chainId,
    evm,
    kind: "open",
    er: evm ? null : address,
    index: synthetic?.index ?? null,
    executionAddress: synthetic?.execution ?? null,
  };
}

function trackId(hint: Hint): string {
  const dao = daoKey(hint.dao);
  if (!hint.evm) return hint.er ? `sol:${hint.er}` : `solpending:${dao}`;
  if (hint.index != null) return `evm:${dao}:${hint.chainId ?? "na"}:${hint.index}`;
  return `evmpending:${dao}:${hint.chainId ?? "na"}`;
}

function solanaAddressFromRaw(raw: Record<string, unknown> | null | undefined): string | null {
  if (!raw) return null;
  for (const key of ["execution_request", "request", "execution_request_address"]) {
    const value = raw[key];
    if (typeof value !== "string" || value.length === 0) continue;
    if (value.startsWith("0x") || value.startsWith("0X") || value.includes("#")) continue;
    return value;
  }
  return null;
}

function syntheticFromRaw(raw: Record<string, unknown> | null | undefined): { execution: string; index: number } | null {
  if (!raw) return null;
  for (const key of ["execution_request", "request", "execution_request_address"]) {
    const value = raw[key];
    if (typeof value === "string") {
      const parsed = parseSyntheticEvmKey(value);
      if (parsed) return parsed;
    }
  }
  return null;
}

function isEvm(dao: string, chain: string, chainId: number | null): boolean {
  if (dao.startsWith("0x") || dao.startsWith("0X")) return true;
  if (chainId != null) return true;
  return EVM_CHAINS.has(chain);
}

function daoKey(dao: string): string {
  return dao.startsWith("0x") || dao.startsWith("0X") ? dao.toLowerCase() : dao;
}

function asChainId(value: unknown): number | null {
  const parsed = asPositiveInt(value);
  return parsed != null && parsed > 0 ? parsed : null;
}

function asPositiveInt(value: unknown, allowZero = false): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const truncated = Math.trunc(value);
    if (truncated > 0 || (allowZero && truncated === 0)) return truncated;
    return null;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    if (parsed > 0 || (allowZero && parsed === 0)) return parsed;
  }
  return null;
}

function atMs(iso?: string | null): number {
  const parsed = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}
