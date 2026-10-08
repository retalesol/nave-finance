/**
 * GET /simulation-data — public latest simulation batch + portfolios.
 *
 * If no ready batch exists (or the latest is older than 24h and ?refresh=1),
 * attempts an in-process regenerate using the service role so the public page
 * always has data after first hit.
 */

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { corsHeadersFor, jsonWithCors, secretsMatch } from "../_shared/http.ts";
import {
  DEFAULT_BASELINES,
  generateSimulationBatch,
  type BaselineApys,
} from "../_shared/simulationEngine.ts";

const KEEP_BATCHES = 5;

async function fetchLiveBaselines(): Promise<BaselineApys> {
  const baselines: BaselineApys = { ...DEFAULT_BASELINES };
  try {
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
    // builtins
  }
  return baselines;
}

async function generateAndPersist(
  // deno-lint-ignore no-explicit-any
  supabase: any,
): Promise<string> {
  const seed = `nave-sim-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const { data: batchRow, error: insertErr } = await supabase
    .from("simulation_batches")
    .insert({ seed, status: "generating", params: {}, summary: {} })
    .select("id")
    .single();
  if (insertErr || !batchRow) throw new Error(insertErr?.message ?? "insert failed");

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

    const { error: updErr } = await supabase
      .from("simulation_batches")
      .update({
        status: "ready",
        params: {
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
        },
        summary: result.summary,
      })
      .eq("id", batchId);
    if (updErr) throw new Error(updErr.message);

    const { data: old } = await supabase
      .from("simulation_batches")
      .select("id")
      .eq("status", "ready")
      .order("created_at", { ascending: false });
    if (old && old.length > KEEP_BATCHES) {
      const dropIds = old.slice(KEEP_BATCHES).map((r: { id: string }) => r.id);
      if (dropIds.length) await supabase.from("simulation_batches").delete().in("id", dropIds);
    }

    return batchId;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await supabase
      .from("simulation_batches")
      .update({ status: "failed", error_message: message })
      .eq("id", batchId);
    throw err;
  }
}

Deno.serve(async (req) => {
  const corsHeaders = corsHeadersFor(req, { allowBrowserFallback: true });
  const jsonResponse = (data: unknown, status = 200) => jsonWithCors(corsHeaders, data, status);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "GET") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    return jsonResponse({ error: "Supabase not configured" }, 500);
  }

  const supabase = createClient(supabaseUrl, serviceKey);
  const url = new URL(req.url);
  // `?refresh=1` regenerates a whole batch (live baseline fetches + heavy
  // writes). Anonymous callers can only READ; the refresh path is reserved for
  // cron / ops holding the indexer secret so it cannot be used as a free
  // compute/write amplifier.
  const forceRefresh = url.searchParams.get("refresh") === "1";
  if (forceRefresh) {
    const expected = Deno.env.get("NAVE_INDEXER_SECRET");
    if (!expected || !secretsMatch(req.headers.get("X-Indexer-Secret"), expected)) {
      return jsonResponse({ error: "refresh=1 requires X-Indexer-Secret" }, 401);
    }
  }

  try {
    const { data: latest, error } = await supabase
      .from("simulation_batches")
      .select("*")
      .eq("status", "ready")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) return jsonResponse({ error: error.message }, 500);

    let batchId = latest?.id as string | undefined;

    // Regenerate when empty, or when caller passes ?refresh=1 (cron / ops).
    if (!batchId || forceRefresh || !latest) {
      batchId = await generateAndPersist(supabase);
    }

    const { data: batch, error: batchErr } = await supabase
      .from("simulation_batches")
      .select("*")
      .eq("id", batchId)
      .single();
    if (batchErr || !batch) {
      return jsonResponse({ error: batchErr?.message ?? "Batch not found" }, 500);
    }

    const { data: portfolios, error: portErr } = await supabase
      .from("simulation_portfolios")
      .select(
        "id, run_index, window_start, window_end, regime_label, start_nav_usd, end_nav_usd, total_return_pct, max_drawdown_pct, cagr_pct, chain_split, protocol_pnl, series",
      )
      .eq("batch_id", batchId)
      .order("run_index", { ascending: true });

    if (portErr) return jsonResponse({ error: portErr.message }, 500);

    return jsonResponse({
      batch: {
        id: batch.id,
        createdAt: batch.created_at,
        seed: batch.seed,
        status: batch.status,
        params: batch.params,
        summary: batch.summary,
      },
      portfolios: (portfolios ?? []).map((p) => ({
        id: p.id,
        runIndex: p.run_index,
        windowStart: p.window_start,
        windowEnd: p.window_end,
        regimeLabel: p.regime_label,
        startNavUsd: Number(p.start_nav_usd),
        endNavUsd: Number(p.end_nav_usd),
        totalReturnPct: Number(p.total_return_pct),
        maxDrawdownPct: Number(p.max_drawdown_pct),
        cagrPct: Number(p.cagr_pct),
        chainSplit: p.chain_split,
        protocolPnl: p.protocol_pnl,
        series: p.series,
      })),
    });
  } catch (err) {
    return jsonResponse(
      { error: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
});
