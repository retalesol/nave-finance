/**
 * POST /simulation-engine — regenerate a batch of 50 Nave portfolio simulations.
 *
 * Auth: X-Indexer-Secret (same as snapshot-treasury / cron callers).
 * Also accepts Authorization: Bearer <service_role> for operator use.
 *
 * Writes simulation_batches + simulation_portfolios, prunes older batches
 * (keeps last 5 ready rows).
 */

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { corsHeadersFor, jsonWithCors, requireSecret, secretsMatch } from "../_shared/http.ts";
import {
  DEFAULT_BASELINES,
  generateSimulationBatch,
  type BaselineApys,
} from "../_shared/simulationEngine.ts";

const KEEP_BATCHES = 5;

async function fetchLiveBaselines(): Promise<BaselineApys> {
  const baselines: BaselineApys = { ...DEFAULT_BASELINES };
  try {
    // Reuse the public yield-data function when available in the same project.
    const base = Deno.env.get("SUPABASE_URL");
    const anon = Deno.env.get("SUPABASE_ANON_KEY");
    if (!base || !anon) return baselines;
    const res = await fetch(`${base}/functions/v1/yield-data`, {
      headers: { Authorization: `Bearer ${anon}` },
    });
    if (!res.ok) return baselines;
    const body = await res.json() as {
      opportunities?: Array<{ protocolId?: string; apyBps?: number }>;
    };
    for (const opp of body.opportunities ?? []) {
      const id = (opp.protocolId ?? "").toLowerCase();
      const apy = Number(opp.apyBps);
      if (!Number.isFinite(apy) || apy <= 0) continue;
      if (id === "kamino") baselines.kamino = apy;
      else if (id === "marginfi") baselines.marginfi = apy;
      else if (id === "jupiter") baselines.jupiter = apy;
      else if (id === "jito") baselines.jito = apy;
    }
  } catch {
    // keep builtins
  }
  return baselines;
}

function authorized(req: Request, corsHeaders: Record<string, string>): Response | null {
  // Prefer indexer secret (cron / ops).
  const indexer = Deno.env.get("NAVE_INDEXER_SECRET");
  if (indexer && secretsMatch(req.headers.get("X-Indexer-Secret"), indexer)) {
    return null;
  }
  // Allow service-role bearer for operator scripts.
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const auth = req.headers.get("Authorization") ?? "";
  if (serviceKey && secretsMatch(auth, `Bearer ${serviceKey}`)) {
    return null;
  }
  // Fall through to requireSecret so missing config returns 500, wrong secret 401.
  return requireSecret(req, "NAVE_INDEXER_SECRET", "X-Indexer-Secret", corsHeaders);
}

Deno.serve(async (req) => {
  const corsHeaders = corsHeadersFor(req);
  const jsonResponse = (data: unknown, status = 200) => jsonWithCors(corsHeaders, data, status);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const authErr = authorized(req, corsHeaders);
  if (authErr) return authErr;

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    return jsonResponse({ error: "Supabase not configured" }, 500);
  }

  const supabase = createClient(supabaseUrl, serviceKey);
  const seed = `nave-sim-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

  const { data: batchRow, error: insertErr } = await supabase
    .from("simulation_batches")
    .insert({
      seed,
      status: "generating",
      params: {},
      summary: {},
    })
    .select("id")
    .single();

  if (insertErr || !batchRow) {
    return jsonResponse({ error: insertErr?.message ?? "Failed to create batch" }, 500);
  }

  const batchId = batchRow.id as string;

  try {
    const baselines = await fetchLiveBaselines();
    const result = generateSimulationBatch({ seed, baselines });

    const portfolioRows = result.portfolios.map((p) => ({
      batch_id: batchId,
      run_index: p.runIndex,
      window_start: p.windowStart,
      window_end: p.windowEnd,
      regime_label: p.regimeLabel === "crisis" ? "bear" : p.regimeLabel,
      start_nav_usd: p.startNavUsd,
      end_nav_usd: p.endNavUsd,
      total_return_pct: p.totalReturnPct,
      max_drawdown_pct: p.maxDrawdownPct,
      cagr_pct: p.cagrPct,
      chain_split: p.chainSplit,
      protocol_pnl: p.protocolPnl,
      series: p.series,
    }));

    const { error: portErr } = await supabase.from("simulation_portfolios").insert(portfolioRows);
    if (portErr) throw new Error(portErr.message);

    const paramsPayload = {
      startCapitalUsd: result.params.startCapitalUsd,
      portfolioCount: result.params.portfolioCount,
      horizonMonths: result.params.horizonMonths,
      historyMonths: result.params.historyMonths,
      solanaTargetWeight: result.params.solanaTargetWeight,
      evmTargetWeight: result.params.evmTargetWeight,
      liquidityFloor: result.params.liquidityFloor,
      venues: result.params.venues.map((v) => ({
        id: v.id,
        chain: v.chain,
        network: v.network,
        apyBps: v.apyBps,
        riskScore: v.riskScore,
        cap: v.cap,
      })),
      baselines: result.params.baselines,
    };

    const { error: updErr } = await supabase
      .from("simulation_batches")
      .update({
        status: "ready",
        params: paramsPayload,
        summary: result.summary,
      })
      .eq("id", batchId);

    if (updErr) throw new Error(updErr.message);

    // Prune older ready batches beyond KEEP_BATCHES
    const { data: old } = await supabase
      .from("simulation_batches")
      .select("id")
      .eq("status", "ready")
      .order("created_at", { ascending: false });

    if (old && old.length > KEEP_BATCHES) {
      const dropIds = old.slice(KEEP_BATCHES).map((r) => r.id as string);
      if (dropIds.length) {
        await supabase.from("simulation_batches").delete().in("id", dropIds);
      }
    }

    // Clean failed/generating leftovers older than 1 hour
    const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await supabase
      .from("simulation_batches")
      .delete()
      .in("status", ["failed", "generating"])
      .lt("created_at", cutoff);

    return jsonResponse({
      ok: true,
      batchId,
      seed,
      summary: result.summary,
      portfolioCount: result.portfolios.length,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await supabase
      .from("simulation_batches")
      .update({ status: "failed", error_message: message })
      .eq("id", batchId);
    return jsonResponse({ error: message, batchId }, 500);
  }
});
