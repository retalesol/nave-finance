// Hourly refresh of live venue rates into strategy_rates. Called by pg_cron
// with the service-role key, or by an agent with X-Agent-Secret.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { corsHeadersFor, jsonWithCors, secretsMatch } from "../_shared/http.ts";
import { fetchStrategyRates, toStrategyRateRow } from "../_shared/apySource.ts";

function bearer(req: Request): string {
  const header = req.headers.get("Authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match?.[1] ?? "";
}

Deno.serve(async (req: Request) => {
  const corsHeaders = corsHeadersFor(req);
  const jsonResponse = (data: unknown, status = 200) => jsonWithCors(corsHeaders, data, status);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const agentSecret = Deno.env.get("NAVE_AGENT_SECRET") ?? "";
  const authorized = (serviceKey !== "" && secretsMatch(bearer(req), serviceKey))
    || (agentSecret !== "" && secretsMatch(req.headers.get("X-Agent-Secret"), agentSecret));
  if (!authorized) return jsonResponse({ error: "Unauthorized" }, 401);
  if (!supabaseUrl || !serviceKey) return jsonResponse({ error: "Supabase is not configured" }, 500);

  const rates = await fetchStrategyRates();
  if (rates.length === 0) {
    return jsonResponse({ success: false, error: "No rate source responded" }, 502);
  }

  const supabase = createClient(supabaseUrl, serviceKey);
  const { error } = await supabase
    .from("strategy_rates")
    .upsert(rates.map(toStrategyRateRow), { onConflict: "chain,venue_id" });
  if (error) return jsonResponse({ error: error.message }, 500);

  return jsonResponse({ success: true, updated: rates.length });
});
