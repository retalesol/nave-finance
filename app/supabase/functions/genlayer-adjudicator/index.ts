// genlayer-adjudicator
//
// Submits a case id and public inputs (chain family, network, treasury,
// action hash, and the public mandate/constitution/venue fields). It does not
// accept an assistant paragraph as the verdict, and it does not call /sign or
// /relay-evm.
//
// Results are stored in public.genlayer_reviews, one row shape for Solana and
// every EVM family, keyed by chain family + network + treasury + action hash.
// That table is the shared read for the proposal card and the treasury page.
// Recommendation rows stay observe-only; a review is not folded into a
// policy proof hash because the same treasury is judged per chain family.
//
// A review is written only after a real open_case, review_venue, or open_appeal
// on the configured GenLayer contracts. Accepted is stored as still checking.
// This function never sends a Nave mainnet transaction.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { corsHeadersFor, jsonWithCors, requireSecret } from "../_shared/http.ts";
import { clientKey, rateLimit } from "../_shared/rateLimit.ts";
import {
  type CustomerStatus,
  type PublicCharterInput,
  charterRpcParams,
  isActionHash,
  normalizeActionHash,
  parsePublicCase,
  publicInputsError,
  treasuryKey,
} from "../_shared/genlayerCharter.ts";
import { syncConfiguredReview } from "../_shared/genlayerSync.ts";

type Mode = "submit" | "appeal" | "read";

Deno.serve(async (req: Request) => {
  const corsHeaders = corsHeadersFor(req, { allowBrowserFallback: true });
  const jsonResponse = (data: unknown, status = 200) => jsonWithCors(corsHeaders, data, status);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const limited = rateLimit(req, { key: clientKey(req, "genlayer"), limit: 30, windowMs: 60_000 }, corsHeaders);
  if (limited) return limited;

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  const mode = String(body.mode ?? "submit") as Mode;
  if (mode !== "submit" && mode !== "appeal" && mode !== "read") {
    return jsonResponse({ error: "mode must be submit, appeal, or read" }, 400);
  }

  const rejected = publicInputsError(body);
  if (rejected) return jsonResponse({ error: rejected }, 400);

  const parsed = parsePublicCase(body);
  if (!parsed.ok) return jsonResponse({ error: parsed.error }, 400);

  if (mode === "submit" || mode === "read") {
    const authError = requireSecret(req, "NAVE_AGENT_SECRET", "X-Agent-Secret", corsHeaders);
    if (authError) return authError;
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    return jsonResponse({ error: "Supabase is not configured" }, 500);
  }
  const supabase = createClient(supabaseUrl, serviceKey);
  const input = parsed.input;
  const kind = body.kind === "venue" || body.kind === "halt" ? body.kind : "charter";

  if ((mode === "submit" || mode === "appeal") && !isActionHash(input.action_hash) && kind !== "venue") {
    return jsonResponse({ error: "action_hash must be 64 hex characters" }, 400);
  }

  if (mode === "appeal") {
    if (kind !== "charter" && kind !== "halt") {
      return jsonResponse({ error: "Another check is for this move." }, 400);
    }
    const existing = await readRow(supabase, input, "charter");
    const pause = input.pause_reason
      ?? (typeof existing?.summary === "string" && existing.summary.trim().length >= 12
        ? existing.summary
        : "Reviewers asked for another look at this move.");
    let synced;
    try {
      synced = await syncConfiguredReview("halt", {
        ...input,
        pause_reason: pause,
        counterevidence: input.counterevidence ?? "",
        venue: input.venue || "move",
        amount: input.amount || "0",
        asset: input.asset || "asset",
      }, "");
    } catch (err) {
      return jsonResponse({ error: err instanceof Error ? err.message : "GenLayer review failed" }, 502);
    }
    if (!synced) return jsonResponse({ error: "GenLayer review is not configured" }, 503);
    const stored = await upsertReview(supabase, input, "halt", { ...synced, appeal_requested: true });
    if (!stored.ok) return jsonResponse({ error: stored.error }, 500);
    return jsonResponse({
      success: true,
      customer_status: synced.customer_status,
      appeal_requested: true,
      tx_id: synced.tx_id,
    });
  }

  const existing = await readRow(supabase, input, kind);
  const previousTx = typeof existing?.tx_id === "string" ? existing.tx_id : "";
  const txForSync = kind === "venue" && mode === "submit" ? "" : previousTx;
  let synced;
  try {
    synced = await syncConfiguredReview(kind, input, txForSync);
  } catch (err) {
    if (mode === "read") return jsonResponse({ success: true, review: existing });
    return jsonResponse({ error: err instanceof Error ? err.message : "GenLayer review failed" }, 502);
  }
  if (!synced) {
    if (mode === "read") return jsonResponse({ success: true, review: existing });
    return jsonResponse({ error: "GenLayer review is not configured" }, 503);
  }
  const interpreted = synced;

  const stored = await upsertReview(supabase, input, kind, {
    ...interpreted,
    appeal_requested: existing?.appeal_requested === true,
    venue_status: interpreted.venue_status,
  });
  if (!stored.ok) return jsonResponse({ error: stored.error }, 500);

  return jsonResponse({
    success: true,
    customer_status: interpreted.customer_status,
    finished: interpreted.finished,
    provisional: interpreted.provisional,
  });
});

interface StoredFields {
  decision: string;
  rule_ids: string[];
  summary: string;
  finished: boolean;
  provisional: boolean;
  action_hash: string;
  tx_id: string;
  customer_status: CustomerStatus;
  appeal_requested: boolean;
  venue_status: "fine" | "watch" | "stop" | null;
}

async function upsertReview(
  supabase: ReturnType<typeof createClient>,
  input: PublicCharterInput,
  kind: "charter" | "venue" | "halt",
  fields: StoredFields,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const row = {
    chain_family: input.chain_family,
    network: input.network,
    treasury: treasuryKey(input.chain_family, input.treasury),
    action_hash: reviewKey(input, kind),
    kind,
    decision: fields.decision,
    customer_status: fields.customer_status,
    finished: fields.finished,
    provisional: fields.provisional,
    rule_ids: fields.rule_ids,
    summary: fields.summary,
    venue_status: fields.venue_status,
    tx_id: fields.tx_id,
    case_id: charterRpcParams(input).case_id,
    appeal_requested: fields.appeal_requested,
    public_inputs: charterRpcParams(input),
    updated_at: new Date().toISOString(),
  };
  const { error } = await supabase.from("genlayer_reviews").upsert(row, {
    onConflict: "chain_family,network,treasury,action_hash,kind",
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

function reviewKey(input: PublicCharterInput, kind: string): string {
  if (kind === "venue" && input.venue?.trim()) return input.venue.trim();
  return isActionHash(input.action_hash) ? normalizeActionHash(input.action_hash) : input.action_hash.trim();
}

async function readRow(
  supabase: ReturnType<typeof createClient>,
  input: PublicCharterInput,
  kind: string,
): Promise<Record<string, unknown> | null> {
  const { data } = await supabase
    .from("genlayer_reviews")
    .select("chain_family, network, treasury, action_hash, kind, decision, customer_status, finished, provisional, rule_ids, summary, venue_status, tx_id, case_id, appeal_requested")
    .eq("chain_family", input.chain_family)
    .eq("network", input.network)
    .eq("treasury", treasuryKey(input.chain_family, input.treasury))
    .eq("action_hash", reviewKey(input, kind))
    .eq("kind", kind)
    .maybeSingle();
  return data;
}
