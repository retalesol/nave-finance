import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { corsHeadersFor, jsonWithCors, requireSecret } from "../_shared/http.ts";
import { clientKey, rateLimit } from "../_shared/rateLimit.ts";
import { type ChainKind, normalizeChain } from "../_shared/chain.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

interface AgentRoleHealth {
  role: string;
  last_action_at: string | null;
  actions_24h: number;
  errors_24h: number;
  last_decision: string | null;
  last_confidence: number | null;
  active_sessions: number;
}

interface HealthResponse {
  dao_address: string;
  chain: ChainKind;
  chain_id: number | null;
  agents: AgentRoleHealth[];
  system_healthy: boolean;
  checked_at: string;
}

const AGENT_ROLES = ["executive", "financial", "oversight", "operational"];

// ─── Main Handler ────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  const corsHeaders = corsHeadersFor(req);
  const jsonResponse = (data: unknown, status = 200) =>
    jsonWithCors(corsHeaders, data, status);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    if (req.method !== "POST") {
      return jsonResponse({ error: "Method not allowed" }, 405);
    }

    const limited = rateLimit(req, { key: clientKey(req, "health"), limit: 60, windowMs: 60_000 }, corsHeaders);
    if (limited) return limited;

    // ── Authenticate ──────────────────────────────────────────────────────
    // Agent activity (decisions, errors, session counts) is sensitive; require
    // the shared agent secret so it is not publicly enumerable per DAO.
    //
    // Deliberately ops-only (pre-redeploy audit decision): the dashboard does
    // NOT call this function — `src/hooks/useAgentHealth.ts` computes the same
    // view from RLS-protected `agent_action_logs` / `agent_sessions` reads, so
    // per-DAO visibility is governed by RLS rather than by an open endpoint.
    // This stays as a secret-gated probe for operators / monitoring.
    const authError = requireSecret(req, "NAVE_AGENT_SECRET", "X-Agent-Secret", corsHeaders);
    if (authError) return authError;

    const reqBody = await req.json();
    const { dao_address } = reqBody;

    if (!dao_address) {
      return jsonResponse({ error: "Missing required field: dao_address" }, 400);
    }

    // Optional chain discriminator. When omitted we do NOT filter by chain (a
    // DAO address is unique per chain anyway); when provided we scope the logs
    // query and echo it back. Defaults to Solana for the response field.
    const chainProvided = reqBody.chain !== undefined && reqBody.chain !== null && reqBody.chain !== "";
    let chainSel: { chain: ChainKind; chain_id: number | null } = { chain: "solana", chain_id: null };
    try {
      chainSel = normalizeChain(reqBody.chain, reqBody.chain_id);
    } catch (e) {
      return jsonResponse({ error: e instanceof Error ? e.message : "Invalid chain" }, 400);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const now = new Date();
    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

    const logsQuery = supabase
      .from("agent_action_logs")
      .select("agent_role, status, decision, confidence_score, created_at")
      .eq("dao_onchain_address", dao_address)
      .gte("created_at", twentyFourHoursAgo)
      .order("created_at", { ascending: false });
    if (chainProvided) logsQuery.eq("chain", chainSel.chain);

    const [logsRes, sessionsRes] = await Promise.all([
      logsQuery,
      supabase
        .from("agent_sessions")
        .select("agent_role, session_status")
        .eq("dao_onchain_address", dao_address)
        .eq("session_status", "active"),
    ]);

    const logs = logsRes.data || [];
    const activeSessions = sessionsRes.data || [];

    const agentHealth: AgentRoleHealth[] = AGENT_ROLES.map((role) => {
      const roleLogs = logs.filter(
        (l: Record<string, unknown>) => l.agent_role === role,
      );
      const latestLog = roleLogs[0] || null;
      const errorCount = roleLogs.filter(
        (l: Record<string, unknown>) => l.status === "error" || l.status === "guardrail_blocked",
      ).length;
      const roleActiveSessions = activeSessions.filter(
        (s: Record<string, unknown>) => s.agent_role === role,
      ).length;

      return {
        role,
        last_action_at: latestLog?.created_at || null,
        actions_24h: roleLogs.length,
        errors_24h: errorCount,
        last_decision: latestLog?.decision || null,
        last_confidence: latestLog?.confidence_score ?? null,
        active_sessions: roleActiveSessions,
      };
    });

    const systemHealthy = agentHealth.every(
      (a) => a.errors_24h <= Math.max(1, a.actions_24h * 0.25),
    );

    const response: HealthResponse = {
      dao_address,
      chain: chainSel.chain,
      chain_id: chainSel.chain_id,
      agents: agentHealth,
      system_healthy: systemHealthy,
      checked_at: now.toISOString(),
    };

    return jsonResponse(response);
  } catch (error) {
    console.error("agent-health error:", error);
    return jsonResponse(
      { error: error instanceof Error ? error.message : "Internal server error" },
      500,
    );
  }
});
