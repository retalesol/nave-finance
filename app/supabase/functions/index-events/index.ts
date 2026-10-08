import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { corsHeadersFor, jsonWithCors, secretsMatch } from "../_shared/http.ts";
import { type ChainKind, daoNetworkFor, normalizeChain } from "../_shared/chain.ts";
import { isMainnetCluster } from "../_shared/cluster.ts";

// ─── Event types from Anchor (Solana) program logs OR EVM contract logs ──
// The EVM indexer normalizes its decoded logs to the SAME canonical event_type
// names emitted by the Solana programs (e.g. "VaultDeposited"), so the routing
// below is chain-agnostic. Each event additionally carries a chain/chain_id
// discriminator (defaults to 'solana' for backward compatibility).

interface ParsedEvent {
  dao_onchain_address: string;
  event_type: string;
  description: string;
  actor: string;
  agent_role?: string;
  tx_signature: string; // Solana sig, or EVM `${txHash}:${logIndex}` (dedup key)
  slot: number; // Solana slot, or EVM block number
  block_time?: string; // ISO 8601
  raw_data?: Record<string, unknown>;
  chain?: string; // 'solana' | 'ethereum' | 'base' (defaults to batch chain)
  chain_id?: number; // EVM numeric id; null/omitted for Solana
}

interface RequestPayload {
  events: ParsedEvent[];
  indexer_secret?: string; // legacy body field; prefer the X-Indexer-Secret header
  // Optional batch-level default chain when individual events omit it.
  chain?: string;
  chain_id?: number;
}

// Treasury-affecting event types that should trigger a snapshot update.
// These are the canonical Anchor event names emitted by the programs.
const TREASURY_EVENTS = new Set([
  "VaultDeposited",
  "VaultWithdrawn",
  "StrategyExecutedEvent",
  "DirectStrategyExecutedEvent",
  "StrategyWithdrawnEvent",
  "ManagementFeeCollected",
  "PerformanceFeeCollected",
  "DaoTokenMinted",
  "AdditionalTokensMinted",
]);

// Agent-specific event types that should cross-reference agent_action_logs
const AGENT_EVENTS = new Set([
  "ExecutiveApprovedEvent",
  "FinancialApprovedEvent",
  "OversightApprovedEvent",
  "AgentApprovalEvent",
  "OperationalHaltEvent",
  "OperationalClearEvent",
  "AgentStatusChangedEvent",
  "AgentKeyRotatedEvent",
  // ExecutionRequestCreated carries the ExecutionRequest address (raw_data.request).
  // Cross-referencing it into agent_action_logs records that ER address so the
  // orchestrator's cheaper log-based discovery can pick up the request — notably
  // the BOOTSTRAP ER, which `ExecutionRequestQueued` (no ER address) cannot
  // surface. (The getProgramAccounts fallback in agent-orchestrator covers the
  // case where this row is missing.)
  "ExecutionRequestCreated",
]);

// When any of these land in activity_logs, nudge agent-orchestrator (poll) so the
// signing pipeline advances without relying on signer-service worker / manual curl.
// Aligned with agent-orchestrator POLL_ACTIVITY_EVENT_TYPES (+ legacy aliases).
const ORCHESTRATOR_POLL_HINT_EVENTS = new Set([
  "ProposalFinalized",
  "ExecutionRequestCreated",
  "ExecutionRequestQueued",
  "AgentApprovalEvent",
  "ExecutiveApprovedEvent",
  "FinancialApprovedEvent",
  "OversightApprovedEvent",
  "OperationalHaltEvent",
  "OperationalClearEvent",
  "AgentStatusChangedEvent",
  "ConstitutionUpdated",
  "PolicyParametersUpdated",
  "ReviewWindowUpdated",
  "AgentsToggled",
  "ProposalPassed",
  "AgentApproval",
  "ExecutiveApproved",
  "FinancialApproved",
  "OversightApproved",
]);

// Agent role extraction from event types
function extractAgentRole(eventType: string): string | null {
  if (eventType === "ExecutiveApprovedEvent" || eventType === "AgentApprovalEvent") return "executive";
  if (eventType === "FinancialApprovedEvent") return "financial";
  if (eventType === "OversightApprovedEvent") return "oversight";
  if (eventType === "OperationalHaltEvent" || eventType === "OperationalClearEvent") return "operational";
  return null;
}

// Map event types to agent_action_logs action_type
function eventToActionType(eventType: string): string {
  if (eventType.includes("Approved")) return "approval";
  if (eventType === "OperationalHaltEvent") return "halt";
  if (eventType === "OperationalClearEvent") return "clear_halt";
  if (eventType === "AgentStatusChangedEvent") return "status_change";
  if (eventType === "AgentKeyRotatedEvent") return "key_rotation";
  if (eventType === "ExecutionRequestCreated") return "execution_request_created";
  return "unknown";
}

// Map event types to agent_action_logs decision
function eventToDecision(eventType: string): string | null {
  if (eventType.includes("Approved")) return "approve";
  if (eventType === "OperationalHaltEvent") return "halt";
  if (eventType === "OperationalClearEvent") return "clear_halt";
  return null;
}

/** Pull a string ref (proposal / request) out of an event's raw_data. */
function rawRef(e: ParsedEvent, field: "proposal" | "request"): string | null {
  const v = e.raw_data?.[field];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Backfills `dao_onchain_address` on events that only carry a `proposal` or
 * `request` reference. Mutates `targetEvents` in place. Builds the ref→dao map
 * from the full incoming batch, then falls back to previously-indexed rows.
 */
// deno-lint-ignore no-explicit-any
async function resolveMissingDaoAddresses(
  supabase: any,
  batch: ParsedEvent[],
  targetEvents: ParsedEvent[],
): Promise<void> {
  const proposalToDao = new Map<string, string>();
  const requestToDao = new Map<string, string>();

  // 1) Learn mappings from any event in the batch that has both a dao and a ref.
  for (const e of batch) {
    if (!e.dao_onchain_address) continue;
    const p = rawRef(e, "proposal");
    const r = rawRef(e, "request");
    if (p) proposalToDao.set(p, e.dao_onchain_address);
    if (r) requestToDao.set(r, e.dao_onchain_address);
  }

  // 2) Determine which refs still need resolution from the database.
  const needProposals = new Set<string>();
  const needRequests = new Set<string>();
  for (const e of targetEvents) {
    if (e.dao_onchain_address) continue;
    const p = rawRef(e, "proposal");
    const r = rawRef(e, "request");
    if (p && !proposalToDao.has(p)) needProposals.add(p);
    if (r && !requestToDao.has(r)) needRequests.add(r);
  }

  const lookup = async (field: "proposal" | "request", keys: string[]) => {
    if (keys.length === 0) return;
    const target = field === "proposal" ? proposalToDao : requestToDao;
    const { data, error } = await supabase
      .from("activity_logs")
      .select("dao_onchain_address, raw_data")
      .neq("dao_onchain_address", "")
      .in(`raw_data->>${field}`, keys);
    if (error || !data) return;
    for (const row of data) {
      const key = row.raw_data?.[field];
      if (typeof key === "string" && row.dao_onchain_address) {
        if (!target.has(key)) target.set(key, row.dao_onchain_address);
      }
    }
  };

  await Promise.all([
    lookup("proposal", Array.from(needProposals)),
    lookup("request", Array.from(needRequests)),
  ]);

  // 3) Backfill.
  for (const e of targetEvents) {
    if (e.dao_onchain_address) continue;
    const p = rawRef(e, "proposal");
    const r = rawRef(e, "request");
    const resolved = (p && proposalToDao.get(p)) || (r && requestToDao.get(r));
    if (resolved) e.dao_onchain_address = resolved;
  }
}

// The on-chain event that announces a new DAO. Carries `dao`, `dao_id`,
// `founder` and `name_len` (the name string itself is not in the event).
// The EVM indexer normalizes NaveDAOFactory's creation event to this same name.
const DAO_INITIALIZED_EVENT = "DaoInitialized";

/**
 * Coerce a u64-ish value from raw_data into a JS number. Anchor encodes u64 as
 * a bn.js instance; depending on the producer it may arrive as a decimal string
 * (preferred) or as a serialized bn.js object ({ words, negative, ... }). Handle
 * both so dao_id is always usable. Returns NaN if it can't be parsed.
 */
function coerceU64(v: unknown): number {
  if (v === null || v === undefined) return NaN;
  if (typeof v === "number") return v;
  if (typeof v === "string") return Number(v);
  if (typeof v === "object") {
    // deno-lint-ignore no-explicit-any
    const o = v as any;
    if (Array.isArray(o.words)) {
      let val = 0;
      for (let i = o.words.length - 1; i >= 0; i--) {
        val = val * 0x4000000 + o.words[i]; // bn.js: little-endian 26-bit words
      }
      return o.negative ? -val : val;
    }
  }
  return NaN;
}

/**
 * Upserts the canonical DAO identity from `DaoInitialized` events so every DAO
 * — even ones created outside the UI — gets a `dao_registry` row. We only write
 * the fields the chain guarantees (`dao_onchain_address`, `dao_id`,
 * `creator_wallet`); name/governance_type/socials are filled by the `register-dao`
 * edge function. Per-row upsert (merge-duplicates) so we never clobber richer
 * metadata that may have already been written client-side.
 */
// deno-lint-ignore no-explicit-any
async function upsertDaoRegistry(
  supabase: any,
  newEvents: ParsedEvent[],
  resolveChain: (e: ParsedEvent) => { chain: ChainKind; chain_id: number | null },
): Promise<number> {
  let upserted = 0;
  for (const e of newEvents) {
    if (e.event_type !== DAO_INITIALIZED_EVENT) continue;
    const addr = e.dao_onchain_address;
    if (!addr) continue;

    const rd = e.raw_data ?? {};
    let founder =
      (typeof rd.founder === "string" && rd.founder) || e.actor || "";
    if (!founder) continue; // creator_wallet is NOT NULL

    const c = resolveChain(e);
    // EVM addresses are case-insensitive — store lowercased so founder-gated
    // lookups (agent-admin pause/resume, register-dao) match the same casing
    // every other EVM path uses. Solana base58 keys ARE case-sensitive, so they
    // are stored verbatim.
    if (c.chain !== "solana") founder = founder.toLowerCase();
    // deno-lint-ignore no-explicit-any
    const row: Record<string, any> = {
      dao_onchain_address: addr,
      creator_wallet: founder,
      chain: c.chain,
      chain_id: c.chain_id,
      network: daoNetworkFor(c, isMainnetCluster()),
    };

    const daoId = coerceU64(rd.dao_id ?? (rd as Record<string, unknown>).daoId);
    if (!Number.isNaN(daoId)) row.dao_id = daoId;

    const { error } = await supabase
      .from("dao_registry")
      .upsert(row, { onConflict: "dao_onchain_address", ignoreDuplicates: false });

    if (error) {
      console.error(`Failed to upsert dao_registry for ${addr}:`, error);
    } else {
      upserted += 1;
    }
  }
  return upserted;
}

/**
 * Server-to-server invocation of `snapshot-treasury` for the given DAOs. Used to
 * produce real treasury valuations when treasury-affecting events land, instead
 * of writing zero-value placeholder snapshots. Best-effort: never throws.
 */
async function invokeSnapshotTreasury(
  daoAddresses: string[],
  indexerSecret: string,
): Promise<void> {
  if (daoAddresses.length === 0) return;
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const resp = await fetch(`${supabaseUrl}/functions/v1/snapshot-treasury`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
        "X-Indexer-Secret": indexerSecret,
      },
      body: JSON.stringify({
        dao_addresses: daoAddresses,
      }),
    });
    if (!resp.ok) {
      console.error(
        "snapshot-treasury invocation failed:",
        resp.status,
        (await resp.text()).slice(0, 300),
      );
    }
  } catch (e) {
    console.error("Failed to invoke snapshot-treasury:", e);
  }
}

/**
 * Capability check: is this bearer a service-role credential? Byte-comparing
 * against the runtime-injected SUPABASE_SERVICE_ROLE_KEY is fragile (the
 * platform can reissue the JWT so a caller's valid copy differs byte-for-byte),
 * so instead PROVE the privilege by calling the GoTrue admin API — anon and
 * authenticated tokens are rejected there. Only consulted when the shared
 * X-Indexer-Secret didn't match, so the extra roundtrip is off the hot path.
 */
async function isServiceRoleBearer(bearer: string): Promise<boolean> {
  if (!bearer || bearer.length < 30) return false;
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  if (!supabaseUrl) return false;
  try {
    const resp = await fetch(`${supabaseUrl}/auth/v1/admin/users?page=1&per_page=1`, {
      headers: { apikey: bearer, Authorization: `Bearer ${bearer}` },
    });
    return resp.ok;
  } catch {
    return false;
  }
}

/**
 * Best-effort poll of agent-orchestrator so ERs advance (Executive → Financial → …)
 * after relevant chain events are indexed. Same auth model as signer-service worker.
 * Skips quietly when NAVE_AGENT_SECRET is not configured on the Edge runtime.
 */
async function invokeAgentOrchestratorPoll(): Promise<void> {
  const agentSecret = Deno.env.get("NAVE_AGENT_SECRET");
  if (!agentSecret) {
    console.warn(
      "index-events: NAVE_AGENT_SECRET unset — skipping agent-orchestrator poll hook",
    );
    return;
  }
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) return;
  try {
    const resp = await fetch(`${supabaseUrl}/functions/v1/agent-orchestrator`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceKey}`,
        "X-Agent-Secret": agentSecret,
      },
      body: JSON.stringify({ mode: "poll" }),
    });
    const text = await resp.text();
    if (!resp.ok) {
      console.error(
        "agent-orchestrator poll hook failed:",
        resp.status,
        text.slice(0, 500),
      );
    }
  } catch (e) {
    console.error("agent-orchestrator poll hook error:", e);
  }
}

Deno.serve(async (req: Request) => {
  const corsHeaders = corsHeadersFor(req);
  const jsonResponse = (data: unknown, status = 200) =>
    jsonWithCors(corsHeaders, data, status);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    // ── Lightweight health check (no auth, no secrets leaked) ──────────────
    const url = new URL(req.url);
    if (req.method === "GET" && url.searchParams.get("health") === "1") {
      return jsonResponse({
        ok: true,
        service: "index-events",
        config: {
          supabase: Boolean(Deno.env.get("SUPABASE_URL") && Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")),
          indexerSecret: Boolean(Deno.env.get("NAVE_INDEXER_SECRET")),
          orchestratorPollHook: Boolean(Deno.env.get("NAVE_AGENT_SECRET")),
        },
      });
    }

    if (req.method !== "POST") {
      return jsonResponse({ error: "Method not allowed" }, 405);
    }

    const body: RequestPayload = await req.json();
    const { events } = body;
    // Prefer the secret from the X-Indexer-Secret header (headers are far less
    // likely to be captured in proxy/invocation logs than JSON bodies). Fall
    // back to the legacy body field so a mid-rollout deploy order still works.
    const indexer_secret = req.headers.get("X-Indexer-Secret") ?? body.indexer_secret;

    // Batch-level default chain (events may override per-event). Defaults to
    // Solana so all existing Helius callers keep working unchanged.
    // Scope "indexer": additionally accepts robinhood (bridge/staking events;
    // no DAO contracts live there — DAO-scoped functions keep rejecting it).
    let batchChain: { chain: ChainKind; chain_id: number | null };
    try {
      batchChain = normalizeChain(body.chain, body.chain_id, "indexer");
    } catch (e) {
      return jsonResponse({ error: e instanceof Error ? e.message : "Invalid chain" }, 400);
    }
    const resolveChain = (e: ParsedEvent) => {
      if (e.chain === undefined && e.chain_id === undefined) return batchChain;
      try {
        return normalizeChain(e.chain ?? batchChain.chain, e.chain_id ?? batchChain.chain_id, "indexer");
      } catch {
        return batchChain;
      }
    };

    // ── Auth: indexer secret OR proven service-role bearer ────────────────
    // The evm-indexer authenticates with X-Indexer-Secret AND the project's
    // service-role key as the bearer. A valid service-role bearer is strictly
    // MORE privileged than the shared secret (it grants full DB access), so
    // accepting it is safe and keeps indexing alive across shared-secret
    // rotations that reach the callers before the function env.
    const expectedSecret = Deno.env.get("NAVE_INDEXER_SECRET");
    const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const secretOk = Boolean(expectedSecret) && secretsMatch(indexer_secret, expectedSecret);
    if (!secretOk && !(await isServiceRoleBearer(bearer))) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }

    if (!Array.isArray(events) || events.length === 0) {
      return jsonResponse({ error: "No events provided" }, 400);
    }

    // Cap batch size to prevent abuse
    if (events.length > 500) {
      return jsonResponse(
        { error: "Batch too large. Max 500 events per request." },
        400,
      );
    }

    // ── Supabase client ─────────────────────────────────────────────────
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // ── Normalize per-event dedup keys ────────────────────────────────────
    // FN-M2: one Solana transaction can emit several events (VoteCast +
    // VoteEscrowLocked, ProposalCreated + ProposalCountRecorded, …). Using the
    // bare signature as the dedup key drops every event after the first, so
    // suffix each event with its index within its transaction:
    // `${signature}:${eventIndex}` — the same convention the EVM indexer
    // already uses (`${txHash}:${logIndex}`, which arrives pre-suffixed and is
    // left untouched). Event order within a tx is deterministic (log decode
    // order), so Helius retries reproduce identical keys.
    const perSigCounter = new Map<string, number>();
    for (const e of events) {
      if (!e.tx_signature || e.tx_signature.includes(":")) continue;
      const idx = perSigCounter.get(e.tx_signature) ?? 0;
      perSigCounter.set(e.tx_signature, idx + 1);
      e.tx_signature = `${e.tx_signature}:${idx}`;
    }

    // ── Deduplicate by per-event key ──────────────────────────────────────
    // This pre-check keeps replayed batches from re-triggering downstream
    // side-effects (snapshots, orchestrator polls); the authoritative,
    // race-proof gate is the UNIQUE constraint + upsert(ignoreDuplicates)
    // below, so concurrent Helius retries can no longer double-count.
    const txSigs = events.map((e) => e.tx_signature).filter(Boolean);
    const { data: existingLogs } = await supabase
      .from("activity_logs")
      .select("tx_signature")
      .in("tx_signature", txSigs);

    const existingSigs = new Set(
      (existingLogs || []).map((l: { tx_signature: string }) => l.tx_signature),
    );

    const newEvents = events.filter(
      (e) => !existingSigs.has(e.tx_signature),
    );

    if (newEvents.length === 0) {
      return jsonResponse({
        success: true,
        inserted: 0,
        skipped: events.length,
        message: "All events already indexed",
      });
    }

    // ── Resolve DAO for events that only reference a proposal/execution request ─
    // Vote/approval/strategy events carry `proposal` or `request` (an execution
    // request PDA) instead of `dao`. The dao-linking events (ProposalCreated,
    // ExecutionRequestCreated/Queued) are emitted earlier, so map those refs to
    // their dao using the current batch first, then previously-indexed rows.
    await resolveMissingDaoAddresses(supabase, events, newEvents);

    // ── Insert activity logs ──────────────────────────────────────────────
    const logRows = newEvents.map((e) => {
      const c = resolveChain(e);
      return {
        dao_onchain_address: e.dao_onchain_address,
        chain: c.chain,
        chain_id: c.chain_id,
        event_type: e.event_type,
        description: e.description || "",
        actor: e.actor || "",
        agent_role: e.agent_role || null,
        tx_signature: e.tx_signature,
        slot: e.slot,
        block_time: e.block_time || null,
        raw_data: e.raw_data || {},
      };
    });

    const { error: insertError } = await supabase
      .from("activity_logs")
      .upsert(logRows, { onConflict: "tx_signature", ignoreDuplicates: true });

    if (insertError) {
      console.error("Failed to insert activity logs:", insertError);
      return jsonResponse(
        { error: "Failed to insert activity logs" },
        500,
      );
    }

    // ── Register new DAOs (canonical identity from DaoInitialized) ────────
    // Must run before the treasury snapshot so snapshot-treasury can resolve
    // the DAO's vault for any treasury event landing in the same batch.
    const daosRegistered = await upsertDaoRegistry(supabase, newEvents, resolveChain);

    // ── Real treasury valuation for treasury-affecting events ────────────
    // snapshot-treasury currently values Solana vaults only; EVM treasury
    // valuation is produced by the EVM indexer / cutover flow, so we only
    // trigger it for Solana DAOs here (EVM events still land in activity_logs).
    const treasuryDaos = new Set<string>();
    for (const e of newEvents) {
      if (
        TREASURY_EVENTS.has(e.event_type) &&
        e.dao_onchain_address &&
        resolveChain(e).chain === "solana"
      ) {
        treasuryDaos.add(e.dao_onchain_address);
      }
    }

    // Compute real balances via snapshot-treasury instead of zero placeholders.
    await invokeSnapshotTreasury(Array.from(treasuryDaos), expectedSecret ?? indexer_secret ?? "");

    // ── Cross-reference agent events to agent_action_logs ────────────────
    const agentEvents = newEvents.filter((e) => AGENT_EVENTS.has(e.event_type));
    let agentLogsCrossReferenced = 0;

    if (agentEvents.length > 0) {
      const agentLogRows = agentEvents.map((e) => {
        const role = e.agent_role || extractAgentRole(e.event_type);
        const actionType = eventToActionType(e.event_type);
        const decision = eventToDecision(e.event_type);

        const erAddress =
          (e.raw_data?.execution_request_address as string) ||
          (e.raw_data?.executionRequest as string) ||
          (e.raw_data?.execution_request as string) ||
          (e.raw_data?.request as string) ||
          "";

        const reasoningHash =
          (e.raw_data?.reasoning_hash as string) ||
          (e.raw_data?.reasoningHash as string) ||
          "";

        const c = resolveChain(e);
        return {
          dao_onchain_address: e.dao_onchain_address,
          chain: c.chain,
          chain_id: c.chain_id,
          // Per-event dedup key; a partial unique index on
          // (tx_signature) WHERE status = 'on_chain_confirmed' makes concurrent
          // re-indexing of the same event a no-op instead of a double row.
          tx_signature: e.tx_signature,
          agent_role: role || "unknown",
          action_type: actionType,
          reasoning: `On-chain event: ${e.event_type}. ${e.description || ""}`.trim(),
          constitution_check: {},
          payload_hash: "",
          reasoning_hash: reasoningHash,
          execution_request_address: erAddress,
          status: "on_chain_confirmed",
          error_message: "",
          confidence_score: null,
          risk_flags: [],
          decision,
          claude_model: null,
          raw_claude_response: null,
          retry_count: 0,
        };
      });

      const { error: agentLogError } = await supabase
        .from("agent_action_logs")
        .insert(agentLogRows);

      if (agentLogError) {
        // 23505 = unique_violation on the partial event-dedup index: a
        // concurrent retry already cross-referenced these events. Benign.
        if ((agentLogError as { code?: string }).code === "23505") {
          console.warn("Agent action logs already cross-referenced (concurrent retry) — skipping.");
        } else {
          console.error("Failed to cross-reference agent action logs:", agentLogError);
        }
      } else {
        agentLogsCrossReferenced = agentLogRows.length;
      }
    }

    const orchestratorPollHint = newEvents.some((e) =>
      ORCHESTRATOR_POLL_HINT_EVENTS.has(e.event_type)
    );
    if (orchestratorPollHint) {
      await invokeAgentOrchestratorPoll();
    }

    return jsonResponse({
      success: true,
      inserted: newEvents.length,
      skipped: events.length - newEvents.length,
      daos_registered: daosRegistered,
      treasury_updates_flagged: treasuryDaos.size,
      agent_logs_cross_referenced: agentLogsCrossReferenced,
      orchestrator_poll_triggered: orchestratorPollHint,
    });
  } catch (error) {
    console.error("index-events error:", error);
    return jsonResponse(
      {
        error: error instanceof Error
          ? error.message
          : "Internal server error",
      },
      500,
    );
  }
});
