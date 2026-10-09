// policy-evaluator (Phase 2): continuous, read-only, constitution-driven policy loop.
//
// For each active DAO this function:
//   1. Reads authoritative on-chain state (constitution policy + approved
//      protocols, treasury vault NAV/deployed, per-protocol positions).
//   2. Scans approved-protocol yield opportunities (read-only; see yieldSources).
//   3. Runs the deterministic policy evaluator (see _shared/policy.ts).
//   4. Persists the scored opportunities and the recommendation (with a
//      reproducible proof hash) for audit and downstream governance.
//
// SECURITY POSTURE:
//   - This function NEVER signs or submits transactions. It only writes
//     advisory rows (observe-only). Turning a recommendation into a governance
//     proposal is a separate, explicitly-authorized step (Phase 4).
//   - Auth: requires the X-Policy-Secret header to match NAVE_POLICY_SECRET.
//   - Missing critical on-chain inputs => the DAO is skipped (fail-closed: no
//     recommendation is produced from incomplete state).

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { corsHeadersFor, jsonWithCors, requireSecret } from "../_shared/http.ts";
import {
  listRegisteredMints,
  readConstitution,
  readStrategyPositions,
  readTreasuryVault,
} from "../_shared/onchain.ts";
import {
  isEvmPolicyChain,
  readEvmConstitution,
  readEvmStrategyPositions,
  readEvmTreasuryVault,
} from "../_shared/evmPolicy.ts";
import { scanYieldOpportunities, withholdStoppedVenues } from "../_shared/yieldSources.ts";
import { fetchVenueWatches } from "../_shared/genlayerStore.ts";
import { NAVE_GENLAYER_VENUE_GATE, readGenlayerFlag } from "../_shared/genlayerCharter.ts";
import {
  canonicalPolicy,
  evaluatePolicy,
  policyProofHash,
  scoreOpportunity,
  type PolicyInputs,
} from "../_shared/policy.ts";

const BREACH_FLAGS = new Set([
  "deployment_cap_breached",
  "liquidity_floor_breached",
  "reserve_floor_breached",
]);

async function postAlert(payload: Record<string, unknown>): Promise<void> {
  const url = Deno.env.get("ALERT_WEBHOOK_URL");
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.error("ALERT_WEBHOOK_URL post failed:", e instanceof Error ? e.message : e);
  }
}

interface RequestPayload {
  dao_addresses?: string[];
}

Deno.serve(async (req: Request) => {
  const corsHeaders = corsHeadersFor(req);
  const jsonResponse = (data: unknown, status = 200) => jsonWithCors(corsHeaders, data, status);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const url = new URL(req.url);
  if (req.method === "GET" && url.searchParams.get("health") === "1") {
    return jsonResponse({
      ok: true,
      service: "policy-evaluator",
      config: {
        supabase: Boolean(Deno.env.get("SUPABASE_URL") && Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")),
        policySecret: Boolean(Deno.env.get("NAVE_POLICY_SECRET")),
        rpc: Boolean(Deno.env.get("SOLANA_RPC_URL")),
        evmRpc: Boolean(
          Deno.env.get("EVM_BASE_RPC_URL") || Deno.env.get("EVM_ROBINHOOD_RPC_URL"),
        ),
        yieldSource: Boolean(Deno.env.get("NAVE_YIELD_SOURCE_URL")),
      },
    });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  // Auth: dedicated planner secret (separation of duties from signer/orchestrator).
  const unauth = requireSecret(req, "NAVE_POLICY_SECRET", "X-Policy-Secret", corsHeaders);
  if (unauth) return unauth;

  let body: RequestPayload = {};
  try {
    body = (await req.json()) as RequestPayload;
  } catch {
    body = {};
  }

  const rpcUrl = Deno.env.get("SOLANA_RPC_URL") ?? "";
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  let query = supabase.from("dao_registry").select("dao_onchain_address, name, chain, chain_id");
  if (body.dao_addresses && body.dao_addresses.length > 0) {
    query = query.in("dao_onchain_address", body.dao_addresses);
  }
  const { data: daos, error: daoErr } = await query;
  if (daoErr) {
    return jsonResponse({ error: "Failed to fetch DAOs" }, 500);
  }
  if (!daos || daos.length === 0) {
    return jsonResponse({ success: true, evaluated: 0, message: "No DAOs found" });
  }

  const nowSecs = Math.floor(Date.now() / 1000);
  const nowIso = new Date().toISOString();
  const results: Array<Record<string, unknown>> = [];
  const skipped: Array<{ dao: string; reason: string }> = [];

  for (const dao of daos as Array<{ dao_onchain_address: string; chain?: string | null; chain_id?: number | null }>) {
    const daoAddr = dao.dao_onchain_address;
    const evmChain = isEvmPolicyChain(dao.chain);
    try {
      if (evmChain) {
        const chainId = typeof dao.chain_id === "number" ? dao.chain_id : null;
        if (chainId == null) {
          skipped.push({ dao: daoAddr, reason: "evm_chain_id_missing" });
          continue;
        }
      } else if (!rpcUrl) {
        skipped.push({ dao: daoAddr, reason: "solana_rpc_unconfigured" });
        continue;
      }

      const [constitution, vault] = evmChain
        ? await Promise.all([
          readEvmConstitution(dao.chain_id as number, daoAddr),
          readEvmTreasuryVault(dao.chain_id as number, daoAddr),
        ])
        : await Promise.all([
          readConstitution(rpcUrl, daoAddr),
          readTreasuryVault(rpcUrl, daoAddr),
        ]);

      // Fail-closed on incomplete state: never recommend from partial inputs.
      if (!constitution || !vault) {
        skipped.push({ dao: daoAddr, reason: !constitution ? "constitution_unreadable" : "vault_unreadable" });
        continue;
      }

      const approvedProtocols = constitution.approvedProtocols
        .filter((p) => p.approved)
        .map((p) => ({
          protocolId: p.protocolId,
          programId: p.programId,
          maxAllocationBps: p.maxAllocationBps,
          approved: true,
        }));

      const positions = evmChain
        ? await readEvmStrategyPositions(dao.chain_id as number, daoAddr, approvedProtocols)
        : await readStrategyPositions(
          rpcUrl,
          daoAddr,
          approvedProtocols.map((p) => p.protocolId),
          await listRegisteredMints(rpcUrl, daoAddr),
        );

      const scanned = await scanYieldOpportunities(
        approvedProtocols.map((p) => ({ protocolId: p.protocolId, programId: p.programId })),
        undefined,
        dao.chain ?? undefined,
      );
      const venueWatches = await fetchVenueWatches(supabase, daoAddr, dao.chain ?? "solana");
      const opportunities = withholdStoppedVenues(
        scanned,
        venueWatches,
        readGenlayerFlag(NAVE_GENLAYER_VENUE_GATE),
      );

      const inputs: PolicyInputs = {
        daoAddress: daoAddr,
        navBaseUnits: vault.navBaseUnits,
        deployedBaseUnits: vault.deployedBaseUnits,
        // The single-mint vault model cannot prove multi-asset reserve
        // composition on-chain; leave reserve composition unknown so the
        // evaluator flags it rather than assuming compliance (multi-asset
        // treasury milestone, see Phase 1 notes).
        stablecoinBaseUnits: null,
        positions,
        approvedProtocols,
        policy: {
          minStablecoinReserveBps: constitution.minStablecoinReserveBps,
          maxTotalDeployedBps: constitution.maxTotalDeployedBps,
          minLiquidityBps: constitution.minLiquidityBps,
          rebalanceFrequencySecs: constitution.rebalanceFrequencySecs,
          lastRebalanceAt: constitution.lastRebalanceAt,
          confidenceThreshold: constitution.confidenceThreshold,
        },
        opportunities,
        nowSecs,
      };

      const recommendation = evaluatePolicy(inputs);
      const canonical = canonicalPolicy(recommendation, inputs);
      const proofHash = await policyProofHash(canonical);

      // Persist scored opportunities (snapshot of this cycle's scan).
      if (opportunities.length > 0) {
        const oppRows = opportunities.map((o) => ({
          dao_onchain_address: daoAddr,
          protocol_id: o.protocolId,
          program_id: o.programId,
          apy_bps: o.apyBps,
          risk_score: o.riskScore,
          asset_class: o.assetClass,
          liquid: o.liquid,
          score: scoreOpportunity(o),
          source: o.source ?? "",
          scanned_at: nowIso,
        }));
        const { error: oppErr } = await supabase.from("yield_opportunities").insert(oppRows);
        if (oppErr) console.error(`yield_opportunities insert failed for ${daoAddr}:`, oppErr.message);
      }

      // Persist the recommendation (idempotent on the proof hash).
      const { error: recErr } = await supabase
        .from("rebalance_recommendations")
        .upsert(
          {
            dao_onchain_address: daoAddr,
            engine_version: recommendation.version,
            intent: recommendation.intent,
            drift: recommendation.drift,
            actions: recommendation.actions,
            rejected: recommendation.rejected,
            flags: recommendation.drift.flags,
            summary: recommendation.summary,
            policy_proof_hash: proofHash,
            nav_base_units: inputs.navBaseUnits,
            deployed_base_units: inputs.deployedBaseUnits,
            status: "observe",
          },
          { onConflict: "dao_onchain_address,policy_proof_hash", ignoreDuplicates: true },
        );
      if (recErr) console.error(`rebalance_recommendations upsert failed for ${daoAddr}:`, recErr.message);

      // Alert on hard policy breaches (best-effort, never blocks the loop).
      const breaches = recommendation.drift.flags.filter((f) => BREACH_FLAGS.has(f));
      if (breaches.length > 0) {
        await postAlert({
          dao: daoAddr,
          source: "policy-evaluator",
          breaches,
          drift: recommendation.drift,
          proof_hash: proofHash,
          at: nowIso,
        });
      }

      results.push({
        dao: daoAddr,
        intent: recommendation.intent,
        flags: recommendation.drift.flags,
        actions: recommendation.actions.length,
        proof_hash: proofHash,
      });
    } catch (e) {
      skipped.push({ dao: daoAddr, reason: e instanceof Error ? e.message : "unknown_error" });
    }
  }

  return jsonResponse({
    success: true,
    evaluated: results.length,
    results,
    skipped: skipped.length > 0 ? skipped : undefined,
  });
});
