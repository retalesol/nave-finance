// Submits and refreshes one GenLayer review.
// A missing session means the contracts are not configured. Callers continue
// without writing a placeholder row.

import { createGenLayerSession, type GenLayerSession } from "./genlayerClient.ts";
import { fetchStoredTx, saveGenlayerReview } from "./genlayerStore.ts";
import {
  type ChainFamily,
  type GenNetwork,
  type PublicCharterInput,
  type ReviewKind,
  buildHaltArgs,
  buildOpenCaseArgs,
  buildVenueArgs,
  charterRpcParams,
  idArgs,
  isActionHash,
  isChainFamily,
  isGenNetwork,
  normalizeActionHash,
  reviewFromRecord,
  storedDecision,
  treasuryKey,
  type ChainObservation,
} from "./genlayerCharter.ts";

export interface SyncedReview {
  /** Charter pass/fail, or the halt verdict when kind is halt. Venue leaves this empty. */
  decision: string;
  halt_decision: "keep_pause" | "lift_pause" | "";
  rule_ids: string[];
  summary: string;
  finished: boolean;
  provisional: boolean;
  action_hash: string;
  tx_id: string;
  customer_status: "checked" | "needs_closer_look" | "still_checking";
  venue_status: "fine" | "watch" | "stop" | null;
  /** Receipt status actually read. Empty when no transaction status was read. */
  receipt_status: string;
}

// genlayer-js 2.0.0-rc.2 writeContract sends the Phase 2 fee from genlayerClient.
// A timed-out receipt is submitted again.
const CHARTER_SUBMIT_EXTRA_ATTEMPTS = 2;
const REFRESH_LIMIT = 12;

function receiptToken(value: string): string {
  return value.trim().toUpperCase().replace(/[\s-]+/g, "_");
}

/**
 * A finished receipt can still have missed its vote. These are the decided
 * statuses in genlayer-js 2.0.0-rc.2, except LEADER_TIMEOUT, which is retried on
 * its own. VALIDATORS_TIMEOUT is also always retried by receiptNeedsRetry.
 * READY_TO_FINALIZE and the appeal states are still in flight.
 * Status 14 is not in that SDK; Bradbury returns it while the leader is
 * still working, together with NOT_VOTED. Retrying that opens a second case.
 */
const FINISHED_RECEIPTS = new Set([
  "ACCEPTED",
  "FINALIZED",
  "UNDETERMINED",
  "CANCELED",
  "VALIDATORS_TIMEOUT",
]);

/**
 * Retry a leader or validators timeout, or a finished receipt that never received a vote.
 * An in-flight receipt, including PENDING and an unnamed status code, still
 * reports NOT_VOTED. Submitting it again opens a second case.
 */
function receiptNeedsRetry(obs: ChainObservation | null | undefined): boolean {
  if (!obs) return false;
  const status = receiptToken(obs.status);
  // Validators that time out never store a result, whatever the leader returned.
  if (status === "LEADER_TIMEOUT" || status === "VALIDATORS_TIMEOUT") return true;
  if (!FINISHED_RECEIPTS.has(status)) return false;
  return receiptToken(obs.executionResult) === "NOT_VOTED";
}

function envGet(name: string): string {
  try {
    const g = globalThis as { Deno?: { env: { get(key: string): string | undefined } } };
    return g.Deno?.env.get(name) ?? "";
  } catch {
    return "";
  }
}

function serviceHeaders(key: string): Record<string, string> {
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    Accept: "application/json",
  };
}

function markedPresent(value: unknown): boolean {
  if (value === true) return true;
  return typeof value === "string" && value.trim().toLowerCase() === "true";
}

async function readIfPresent(
  session: GenLayerSession,
  kind: ReviewKind,
  hasMethod: string,
  getMethod: string,
  args: string[],
): Promise<unknown> {
  try {
    const present = await session.read(kind, hasMethod, args);
    if (!markedPresent(present)) return null;
    return await session.read(kind, getMethod, args);
  } catch {
    return null;
  }
}

async function readStatus(session: GenLayerSession, txId: string): Promise<ChainObservation> {
  try {
    const obs = await session.status(txId);
    return {
      status: typeof obs?.status === "string" ? obs.status : "",
      executionResult: typeof obs?.executionResult === "string" ? obs.executionResult : "",
    };
  } catch {
    return { status: "Pending", executionResult: "" };
  }
}

/**
 * One fresh write, plus up to two more when the receipt is LEADER_TIMEOUT or
 * a decided receipt whose execution result is NOT_VOTED. A stored timeout
 * already counts as the first receipt, so this call adds at most two writes
 * for it. An in-flight receipt, including status 14 and READY_TO_FINALIZE,
 * is not a reason to write again.
 */
async function submitKind(
  session: GenLayerSession,
  kind: ReviewKind,
  call: { method: string; args: string[] },
  txId: string,
  observation: ChainObservation | null,
): Promise<{ txId: string; observation: ChainObservation | null }> {
  let currentId = txId;
  let current = observation;
  if (!currentId) {
    currentId = await session.write(kind, call.method, call.args);
    current = await readStatus(session, currentId);
  }
  for (let extra = 0; extra < CHARTER_SUBMIT_EXTRA_ATTEMPTS && receiptNeedsRetry(current); extra++) {
    try {
      currentId = await session.write(kind, call.method, call.args);
    } catch {
      break;
    }
    current = await readStatus(session, currentId);
  }
  return { txId: currentId, observation: current };
}

function toSynced(
  recorded: ReturnType<typeof reviewFromRecord>,
  receiptStatus: string,
): SyncedReview {
  return {
    decision: storedDecision(recorded),
    halt_decision: recorded.halt_decision,
    rule_ids: recorded.rule_ids,
    summary: recorded.summary,
    finished: recorded.finished,
    provisional: recorded.provisional,
    action_hash: recorded.action_hash,
    tx_id: recorded.tx_id,
    customer_status: recorded.customer_status,
    venue_status: recorded.venue_status,
    receipt_status: receiptStatus.trim(),
  };
}

function applyCharterTrace(
  kind: ReviewKind,
  observation: ChainObservation | null,
  synced: SyncedReview,
): SyncedReview {
  if (kind !== "charter" || !observation || !receiptNeedsRetry(observation) || synced.summary.trim()) {
    return synced;
  }
  const token = receiptToken(observation.status);
  const reason = token === "LEADER_TIMEOUT" || token === "VALIDATORS_TIMEOUT" ? token : "NOT_VOTED";
  return { ...synced, summary: `Charter submit unfinished: ${reason}.` };
}

export async function syncReview(
  session: GenLayerSession,
  kind: ReviewKind,
  input: PublicCharterInput,
  previousTxId = "",
): Promise<SyncedReview> {
  const actionHash = isActionHash(input.action_hash) ? normalizeActionHash(input.action_hash) : input.action_hash.trim();
  let record: unknown = null;
  let txId = previousTxId.trim();
  let observation: ChainObservation | null = null;
  let sawReceipt = false;

  if (kind === "charter") {
    if (!isActionHash(actionHash)) throw new Error("action_hash must be 64 hex characters");
    const ids = idArgs({ ...input, action_hash: actionHash });
    record = await readIfPresent(session, "charter", "has_case", "get_case", ids);
    if (!record) {
      const prior = txId ? await readStatus(session, txId) : null;
      if (!txId || receiptNeedsRetry(prior)) {
        const call = await buildOpenCaseArgs(input);
        const submitted = await submitKind(session, "charter", call, txId, prior);
        txId = submitted.txId;
        observation = submitted.observation;
        sawReceipt = true;
        if (txId) record = await readIfPresent(session, "charter", "has_case", "get_case", ids) ?? record;
      } else {
        observation = prior;
        sawReceipt = true;
      }
    } else if (txId) {
      observation = await readStatus(session, txId);
      sawReceipt = true;
    }
    // A stored case with an empty transaction id has no receipt. It stays
    // unfinished until status() reads a real transaction.
  } else if (kind === "venue") {
    const call = buildVenueArgs(input);
    const ids = call.args.slice(0, 3);
    const prior = txId ? await readStatus(session, txId) : null;
    // review_venue may replace a finished venue. An in-flight receipt is not a second review.
    if (!txId || receiptNeedsRetry(prior)) {
      const submitted = await submitKind(session, "venue", call, txId, prior);
      txId = submitted.txId;
      observation = submitted.observation;
      sawReceipt = true;
    } else {
      observation = prior;
      sawReceipt = true;
    }
    if (txId) record = await readIfPresent(session, "venue", "has_venue", "get_venue", ids);
  } else {
    if (!isActionHash(actionHash)) throw new Error("action_hash must be 64 hex characters");
    const ids = idArgs({ ...input, action_hash: actionHash });
    record = await readIfPresent(session, "halt", "has_appeal", "get_appeal", ids);
    if (!record) {
      const prior = txId ? await readStatus(session, txId) : null;
      if (!txId || receiptNeedsRetry(prior)) {
        const call = buildHaltArgs(input);
        const submitted = await submitKind(session, "halt", call, txId, prior);
        txId = submitted.txId;
        observation = submitted.observation;
        sawReceipt = true;
        if (txId) record = await readIfPresent(session, "halt", "has_appeal", "get_appeal", ids) ?? record;
      } else {
        observation = prior;
        sawReceipt = true;
      }
    } else if (txId) {
      observation = await readStatus(session, txId);
      sawReceipt = true;
    }
    // A stored appeal with an empty transaction id has no receipt. It stays
    // unfinished until status() reads a real transaction.
  }

  if (!sawReceipt && txId) {
    observation = await readStatus(session, txId);
  }

  const recorded = reviewFromRecord({
    kind,
    record,
    observation,
    actionHash,
    txId,
  });
  return applyCharterTrace(kind, observation, toSynced(recorded, observation?.status ?? ""));
}

function errorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : "Charter submit failed";
  const redacted = raw.replace(/0x[0-9a-fA-F]{64}/g, "[redacted]");
  return redacted.replace(/\s+/g, " ").trim().slice(0, 240) || "Charter submit failed";
}

function failedSubmitReview(input: PublicCharterInput, error: unknown): SyncedReview {
  const actionHash = isActionHash(input.action_hash) ? normalizeActionHash(input.action_hash) : input.action_hash.trim();
  return {
    decision: "",
    halt_decision: "",
    rule_ids: [],
    summary: `Charter submit failed: ${errorText(error)}`,
    finished: false,
    provisional: true,
    action_hash: actionHash,
    tx_id: "",
    customer_status: "still_checking",
    venue_status: null,
    receipt_status: "",
  };
}

/** Stores a failed submit that never received a transaction id. */
async function persistEmptyTxReview(
  input: PublicCharterInput,
  kind: ReviewKind,
  fields: SyncedReview,
): Promise<void> {
  const url = envGet("SUPABASE_URL");
  const key = envGet("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return;
  const row = {
    chain_family: input.chain_family,
    network: input.network,
    treasury: treasuryKey(input.chain_family, input.treasury),
    action_hash: isActionHash(input.action_hash) ? normalizeActionHash(input.action_hash) : input.action_hash.trim(),
    kind,
    decision: fields.decision,
    customer_status: fields.customer_status,
    finished: false,
    provisional: true,
    rule_ids: fields.rule_ids,
    summary: fields.summary,
    venue_status: fields.venue_status,
    tx_id: "",
    case_id: charterRpcParams(input).case_id,
    appeal_requested: false,
    public_inputs: charterRpcParams(input),
    updated_at: new Date().toISOString(),
  };
  await fetch(
    `${url.replace(/\/$/, "")}/rest/v1/genlayer_reviews?on_conflict=chain_family,network,treasury,action_hash,kind`,
    {
      method: "POST",
      headers: {
        ...serviceHeaders(key),
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(row),
    },
  );
}

/**
 * Records a charter submit that threw. An existing transaction id is left in
 * place. A first failure with no transaction id is stored unfinished.
 */
export async function recordCharterSubmitFailure(
  input: PublicCharterInput,
  error: unknown,
): Promise<SyncedReview> {
  const review = failedSubmitReview(input, error);
  const previous = await fetchStoredTx(input, "charter");
  if (!previous) await persistEmptyTxReview(input, "charter", review);
  return review;
}

/**
 * Opens the charter case for this exact action, or refreshes the transaction
 * already stored. Returns null when GenLayer is not configured. A failed
 * submit is stored unfinished so a later gate can see the attempt.
 */
export async function ensureCharterReview(input: PublicCharterInput): Promise<SyncedReview | null> {
  const previous = await fetchStoredTx(input, "charter");
  try {
    const synced = await syncConfiguredReview("charter", input, previous);
    if (!synced) return null;
    if (synced.tx_id) await saveGenlayerReview(input, "charter", synced);
    return synced;
  } catch (err) {
    try {
      return await recordCharterSubmitFailure(input, err);
    } catch {
      return failedSubmitReview(input, err);
    }
  }
}

export async function syncConfiguredReview(
  kind: ReviewKind,
  input: PublicCharterInput,
  previousTxId = "",
): Promise<SyncedReview | null> {
  const session = await createGenLayerSession();
  if (!session) return null;
  try {
    return await syncReview(session, kind, input, previousTxId);
  } finally {
    try {
      await refreshUnfinishedReviews(session);
    } catch {
      // The review above still returns. Unfinished rows are polled on the next call.
    }
  }
}

interface UnfinishedRow {
  chain_family: string;
  network: string;
  treasury: string;
  action_hash: string;
  kind: string;
  tx_id: string;
  public_inputs?: Record<string, unknown> | null;
}

function inputFromRow(row: UnfinishedRow, kind: ReviewKind): PublicCharterInput | null {
  if (!isChainFamily(row.chain_family) || !isGenNetwork(row.network)) return null;
  if ((kind === "charter" || kind === "halt") && !isActionHash(row.action_hash)) return null;
  const extra = row.public_inputs && typeof row.public_inputs === "object" ? row.public_inputs : {};
  const text = (key: string) => (typeof extra[key] === "string" ? extra[key] : "");
  return {
    chain_family: row.chain_family,
    network: row.network,
    treasury: row.treasury,
    action_hash: row.action_hash,
    venue: text("venue") || (kind === "venue" ? row.action_hash : undefined),
    amount: text("amount") || undefined,
    asset: text("asset") || undefined,
    mandate_text: text("mandate_text") || undefined,
    mandate_hash: text("mandate_hash") || undefined,
    constitution_json: text("constitution_json") || undefined,
    constitution_hash: text("constitution_hash") || undefined,
    evidence_url: text("evidence_url") || undefined,
    status_url: text("status_url") || undefined,
    pause_reason: text("pause_reason") || undefined,
    counterevidence: text("counterevidence") || undefined,
  };
}

async function fetchUnfinishedRows(limit: number): Promise<UnfinishedRow[]> {
  const url = envGet("SUPABASE_URL");
  const key = envGet("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return [];
  const params = new URLSearchParams({
    select: "chain_family,network,treasury,action_hash,kind,tx_id,public_inputs",
    finished: "eq.false",
    tx_id: "not.eq.",
    order: "updated_at.asc",
    limit: String(limit),
  });
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/rest/v1/genlayer_reviews?${params}`, {
      headers: serviceHeaders(key),
    });
    if (!res.ok) return [];
    const rows = await res.json();
    if (!Array.isArray(rows)) return [];
    return rows.filter((row): row is UnfinishedRow => {
      return !!row && typeof row === "object" && typeof row.tx_id === "string" && row.tx_id.trim() !== "";
    });
  } catch {
    return [];
  }
}

/** Polls a stored transaction. It does not submit a new case. */
async function pollUnfinishedRow(session: GenLayerSession, row: UnfinishedRow): Promise<boolean> {
  const kind: ReviewKind = row.kind === "venue" || row.kind === "halt" ? row.kind : "charter";
  const input = inputFromRow(row, kind);
  const txId = row.tx_id.trim();
  if (!input || !txId) return false;
  let observation: ChainObservation;
  try {
    const obs = await session.status(txId);
    observation = {
      status: typeof obs?.status === "string" ? obs.status : "",
      executionResult: typeof obs?.executionResult === "string" ? obs.executionResult : "",
    };
  } catch {
    return false;
  }
  if (!observation.status && !observation.executionResult) return false;
  const actionHash = kind === "venue"
    ? (input.venue || input.action_hash).trim()
    : normalizeActionHash(input.action_hash);
  let record: unknown = null;
  if (kind === "charter") {
    record = await readIfPresent(session, "charter", "has_case", "get_case", idArgs({ ...input, action_hash: actionHash }));
  } else if (kind === "venue") {
    record = await readIfPresent(session, "venue", "has_venue", "get_venue", [
      input.chain_family,
      input.network,
      (input.venue || "").trim(),
    ]);
  } else {
    record = await readIfPresent(session, "halt", "has_appeal", "get_appeal", idArgs({ ...input, action_hash: actionHash }));
  }
  // A missed case read must not wipe a stored decision with an empty one.
  if (record == null) return false;
  const synced = applyCharterTrace(kind, observation, toSynced(reviewFromRecord({
    kind,
    record,
    observation,
    actionHash,
    txId,
  }), observation.status));
  await saveGenlayerReview(input, kind, synced);
  return true;
}

/**
 * Polls unfinished reviews that already have a transaction id, so a case can
 * reach finalized without another model inference. Rows with no transaction
 * id are left unfinished.
 */
export async function refreshUnfinishedReviews(session?: GenLayerSession | null): Promise<number> {
  const active = session === undefined ? await createGenLayerSession() : session;
  if (!active) return 0;
  const rows = await fetchUnfinishedRows(REFRESH_LIMIT);
  let updated = 0;
  for (const row of rows) {
    try {
      if (await pollUnfinishedRow(active, row)) updated += 1;
    } catch {
      // Leave this row. The next refresh polls its transaction id again.
    }
  }
  return updated;
}

export function charterInput(args: {
  chainFamily: ChainFamily;
  network: GenNetwork;
  treasury: string;
  actionHash: string;
  venue: string;
  amount: string;
  asset: string;
  mandateText: string;
  constitution: Record<string, unknown>;
  evidenceUrl?: string;
}): PublicCharterInput {
  return {
    chain_family: args.chainFamily,
    network: args.network,
    treasury: treasuryKey(args.chainFamily, args.treasury),
    action_hash: args.actionHash,
    venue: args.venue,
    amount: args.amount,
    asset: args.asset,
    mandate_text: args.mandateText,
    constitution_json: JSON.stringify(args.constitution),
    evidence_url: args.evidenceUrl ?? "",
  };
}
