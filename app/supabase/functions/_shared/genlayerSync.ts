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
  idArgs,
  isActionHash,
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
    if (present !== true) return null;
    return await session.read(kind, getMethod, args);
  } catch {
    return null;
  }
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

  if (kind === "charter") {
    if (!isActionHash(actionHash)) throw new Error("action_hash must be 64 hex characters");
    const ids = idArgs({ ...input, action_hash: actionHash });
    record = await readIfPresent(session, "charter", "has_case", "get_case", ids);
    if (!record && !txId) {
      const call = await buildOpenCaseArgs(input);
      txId = await session.write("charter", call.method, call.args);
    }
  } else if (kind === "venue") {
    const call = buildVenueArgs(input);
    if (txId) {
      record = await readIfPresent(session, "venue", "has_venue", "get_venue", call.args.slice(0, 3));
    } else {
      txId = await session.write("venue", call.method, call.args);
    }
  } else {
    if (!isActionHash(actionHash)) throw new Error("action_hash must be 64 hex characters");
    const ids = idArgs({ ...input, action_hash: actionHash });
    record = await readIfPresent(session, "halt", "has_appeal", "get_appeal", ids);
    if (!record && !txId) {
      const call = buildHaltArgs(input);
      txId = await session.write("halt", call.method, call.args);
    }
  }

  let observation: ChainObservation | null = null;
  if (txId) {
    try {
      observation = await session.status(txId);
    } catch {
      observation = { status: "Pending", executionResult: "" };
    }
  } else if (record) {
    observation = { status: "Accepted", executionResult: "" };
  }

  const recorded = reviewFromRecord({
    kind,
    record,
    observation,
    actionHash,
    txId,
  });
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
  };
}

/**
 * Opens the charter case for this exact action, or refreshes the transaction
 * already stored. Returns null when GenLayer is not configured. A failed
 * submit throws so the caller can leave the previous row alone.
 */
export async function ensureCharterReview(input: PublicCharterInput): Promise<SyncedReview | null> {
  const previous = await fetchStoredTx(input, "charter");
  const synced = await syncConfiguredReview("charter", input, previous);
  if (!synced?.tx_id) return synced;
  await saveGenlayerReview(input, "charter", synced);
  return synced;
}

export async function syncConfiguredReview(
  kind: ReviewKind,
  input: PublicCharterInput,
  previousTxId = "",
): Promise<SyncedReview | null> {
  const session = await createGenLayerSession();
  if (!session) return null;
  return await syncReview(session, kind, input, previousTxId);
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
