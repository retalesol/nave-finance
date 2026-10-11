// Scheduled caller for VenueWatch.
//
// Posts kind "venue" to genlayer-adjudicator for Kamino, Aave V3, and
// Compound V3 on testing-environment treasuries. Balancer is not included.
// Each post is a real review_venue. A missing GenLayer session writes no row.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { corsHeadersFor, jsonWithCors, secretsMatch } from "../_shared/http.ts";
import { venueWatchJobs, type VenueWatchJob } from "../_shared/genlayerCharter.ts";

const POST_CAP = 8;
const FRESH_MS = 20 * 60 * 60 * 1000;

function bearer(req: Request): string {
  const header = req.headers.get("Authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match?.[1] ?? "";
}

function jobKey(job: Pick<VenueWatchJob, "chain_family" | "network" | "treasury" | "venue">): string {
  return [job.chain_family, job.network, job.treasury, job.venue].join("|");
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
  if (!agentSecret) return jsonResponse({ error: "NAVE_AGENT_SECRET is not configured" }, 500);

  const supabase = createClient(supabaseUrl, serviceKey);
  const { data: daos, error: daoError } = await supabase
    .from("dao_registry")
    .select("dao_onchain_address, chain, network")
    .in("network", ["testnet", "devnet"])
    .in("chain", ["solana", "ethereum", "base"]);
  if (daoError) return jsonResponse({ error: daoError.message }, 500);

  const jobs = venueWatchJobs((daos ?? []).map((dao) => ({
    treasury: String(dao.dao_onchain_address ?? ""),
    chain: String(dao.chain ?? ""),
    network: String(dao.network ?? ""),
  })));

  const freshBefore = new Date(Date.now() - FRESH_MS).toISOString();
  const { data: recent, error: recentError } = await supabase
    .from("genlayer_reviews")
    .select("chain_family, network, treasury, action_hash, updated_at")
    .eq("kind", "venue")
    .gte("updated_at", freshBefore)
    .limit(400);
  if (recentError) return jsonResponse({ error: recentError.message }, 500);

  const fresh = new Set(
    (recent ?? []).map((row) => jobKey({
      chain_family: row.chain_family,
      network: row.network,
      treasury: row.treasury,
      venue: row.action_hash,
    })),
  );

  const results: Array<{ venue: string; treasury: string; ok: boolean; status: number }> = [];
  let skipped = 0;
  for (const job of jobs) {
    if (fresh.has(jobKey(job))) {
      skipped += 1;
      continue;
    }
    if (results.length >= POST_CAP) break;
    const res = await fetch(`${supabaseUrl.replace(/\/$/, "")}/functions/v1/genlayer-adjudicator`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceKey}`,
        "X-Agent-Secret": agentSecret,
      },
      body: JSON.stringify({
        mode: "submit",
        kind: "venue",
        chain_family: job.chain_family,
        network: job.network,
        treasury: job.treasury,
        action_hash: job.venue,
        venue: job.venue,
        status_url: job.status_url,
      }),
    });
    results.push({
      venue: job.venue,
      treasury: job.treasury,
      ok: res.ok,
      status: res.status,
    });
    if (res.status === 503) break;
  }

  return jsonResponse({
    success: true,
    considered: jobs.length,
    posted: results.length,
    skipped,
    results,
  });
});
