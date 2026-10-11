// proposal-creator (Phase 4): governance-safe action creation.
//
// Turns deterministic policy recommendations (rebalance_recommendations, written
// by the observe-only policy-evaluator) into on-chain GOVERNANCE PROPOSALS via
// the signer's `create_proposal` action. It NEVER executes or approves anything.
//
// SEPARATION OF DUTIES (unchanged):
//   - planner (this fn + policy-evaluator)  → recommends and PROPOSES
//   - existing 4-agent pipeline             → approves / halts / executes
//   - signer-service                        → key custody boundary only
//
// SAFETY POSTURE:
//   - Auth: requires X-Proposer-Secret == NAVE_PROPOSER_SECRET (fail-closed).
//   - Staged rollout: does nothing unless NAVE_AUTOPROPOSE_ENABLED == "true".
//     Default is observe-only — it reports candidates without proposing.
//   - Idempotency is enforced end-to-end: the signer reserves an
//     agent_proposals row keyed on (dao, idempotency_key) BEFORE submitting, so
//     a recommendation can never spawn two proposals even under concurrency.
//   - Both `deploy` AND `withdraw` actions are proposed (the latter from
//     `reduce_exposure` and the withdraw legs of `rebalance` recommendations).
//     On-chain both are the same ProposalType::Strategy primitive; the
//     direction is carried as `action_kind` so the downstream pipeline runs
//     the correct instruction. `hold` is a no-op (nothing to propose).
//
// STAGED GATES:
//   - NAVE_AUTOPROPOSE_ENABLED == "true" is the master gate (observe-only when
//     unset/false — nothing is proposed).
//   - NAVE_AUTOPROPOSE_WITHDRAW_ENABLED == "true" is an ADDITIONAL gate that
//     must also be set before any `withdraw` leg is actually proposed. This
//     lets deploys go live before the more sensitive capital-OUT moves. When
//     the master gate is on but the withdraw gate is off, withdraw candidates
//     are reported as `withheld` and the source recommendation is left at
//     'observe' so a later run (with the gate on) can finish those legs.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { corsHeadersFor, jsonWithCors, requireSecret } from "../_shared/http.ts";
import { signerSecretFor, solanaSignerRole } from "../_shared/signerAuth.ts";

interface RecommendedAction {
  actionType: "deploy" | "withdraw" | "hold";
  protocolId: string;
  programId: string;
  amountBaseUnits: number;
  /**
   * SPL mint of the asset this action deploys/withdraws. DAOs are multi-asset,
   * so this is threaded to the signer's create_proposal so the NE-7 payload
   * binds the CORRECT asset mint (not the DAO's first registered token). May be
   * undefined for withdraw legs derived from on-chain positions — in that case
   * the signer derives the asset from the DAO's registered assets by AssetKind.
   */
  mint?: string;
  rationale?: string;
}

interface RecommendationRow {
  id: string;
  dao_onchain_address: string;
  intent: string;
  actions: RecommendedAction[];
  summary: string;
  policy_proof_hash: string;
  status: string;
}

interface RequestPayload {
  dao_addresses?: string[];
  /** Max recommendations to act on this run (safety cap). Default 10. */
  limit?: number;
}

interface DaoChainRow {
  dao_onchain_address: string;
  chain: string | null;
  chain_id: number | null;
  voting_token_mint: string | null;
}

function isEvmDaoChain(chain: string | null | undefined): boolean {
  const c = (chain ?? "").toLowerCase();
  return c === "base" || c === "robinhood" || c === "ethereum" || c === "arc";
}

async function callSigner(payload: Record<string, unknown>): Promise<{ ok: boolean; data?: Record<string, unknown>; error?: string; status?: number }> {
  const signerUrl = Deno.env.get("NAVE_SIGNER_URL");
  const signerSecret = Deno.env.get("NAVE_SIGNER_SECRET");
  if (!signerUrl) return { ok: false, error: "NAVE_SIGNER_URL not configured" };
  if (!signerSecret) return { ok: false, error: "NAVE_SIGNER_SECRET not configured" };
  const evm = isEvmDaoChain(typeof payload.chain === "string" ? payload.chain : null);
  const path = evm ? "/relay-evm" : "/sign";
  try {
    const resp = await fetch(`${signerUrl.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Signer-Secret": signerSecretFor(
          evm ? "operational" : solanaSignerRole(typeof payload.agent_role === "string" ? payload.agent_role : undefined),
        ) ?? signerSecret,
      },
      body: JSON.stringify(payload),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return { ok: false, error: data.error || `Signer HTTP ${resp.status}`, status: resp.status };
    }
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Signer request failed" };
  }
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
      service: "proposal-creator",
      config: {
        supabase: Boolean(Deno.env.get("SUPABASE_URL") && Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")),
        proposerSecret: Boolean(Deno.env.get("NAVE_PROPOSER_SECRET")),
        signer: Boolean(Deno.env.get("NAVE_SIGNER_URL") && Deno.env.get("NAVE_SIGNER_SECRET")),
        autoProposeEnabled: (Deno.env.get("NAVE_AUTOPROPOSE_ENABLED") ?? "").toLowerCase() === "true",
        autoProposeWithdrawEnabled: (Deno.env.get("NAVE_AUTOPROPOSE_WITHDRAW_ENABLED") ?? "").toLowerCase() === "true",
      },
    });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  // Auth: dedicated proposer secret (separation of duties from signer/orchestrator).
  const unauth = requireSecret(req, "NAVE_PROPOSER_SECRET", "X-Proposer-Secret", corsHeaders);
  if (unauth) return unauth;

  let body: RequestPayload = {};
  try {
    body = (await req.json()) as RequestPayload;
  } catch {
    body = {};
  }

  const limit = Math.max(1, Math.min(50, Number(body.limit) || 10));
  // Planner is a dedicated proposer-only custody key (separation of duties).
  // NAVE_PROPOSER_ROLE can override to another valid role if needed.
  const proposerRole = Deno.env.get("NAVE_PROPOSER_ROLE") || "planner";
  const autoEnabled = (Deno.env.get("NAVE_AUTOPROPOSE_ENABLED") ?? "").toLowerCase() === "true";
  // Additional gate for capital-OUT moves. Withdraw legs (reduce_exposure +
  // the unwind side of rebalances) are only proposed once this is also "true".
  const withdrawEnabled = (Deno.env.get("NAVE_AUTOPROPOSE_WITHDRAW_ENABLED") ?? "").toLowerCase() === "true";

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // Pull the most recent observe-only recommendations that have not yet been
  // turned into proposals. Newest first so we act on current state.
  let query = supabase
    .from("rebalance_recommendations")
    .select("id, dao_onchain_address, intent, actions, summary, policy_proof_hash, status")
    .eq("status", "observe")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (body.dao_addresses && body.dao_addresses.length > 0) {
    query = query.in("dao_onchain_address", body.dao_addresses);
  }

  const { data: recs, error: recErr } = await query;
  if (recErr) {
    return jsonResponse({ error: `Failed to read recommendations: ${recErr.message}` }, 500);
  }

  // Select every actionable leg (deploy OR withdraw) with a positive amount and
  // a protocol. A `reduce_exposure` recommendation contributes multiple
  // withdraws (one per unwound position); a `rebalance` recommendation may
  // contribute BOTH withdraw and deploy legs. `hold` contributes nothing.
  const candidates: Array<{ rec: RecommendationRow; action: RecommendedAction }> = [];
  for (const rec of (recs ?? []) as RecommendationRow[]) {
    for (const a of rec.actions ?? []) {
      if (
        (a.actionType === "deploy" || a.actionType === "withdraw") &&
        a.amountBaseUnits > 0 &&
        a.protocolId
      ) {
        candidates.push({ rec, action: a });
      }
    }
  }

  // Observe-only mode (default): report what WOULD be proposed, change nothing.
  if (!autoEnabled) {
    return jsonResponse({
      success: true,
      mode: "observe",
      auto_propose_enabled: false,
      withdraw_propose_enabled: withdrawEnabled,
      candidates: candidates.map((c) => ({
        recommendation_id: c.rec.id,
        dao: c.rec.dao_onchain_address,
        intent: c.rec.intent,
        action_kind: c.action.actionType,
        protocol_id: c.action.protocolId,
        amount_base_units: c.action.amountBaseUnits,
        proof_hash: c.rec.policy_proof_hash,
      })),
      message: "NAVE_AUTOPROPOSE_ENABLED is not 'true'; no proposals created.",
    });
  }

  const daoAddrs = [...new Set(candidates.map((c) => c.rec.dao_onchain_address))];
  const chainByDao = new Map<string, DaoChainRow>();
  if (daoAddrs.length > 0) {
    const { data: chainRows, error: chainErr } = await supabase
      .from("dao_registry")
      .select("dao_onchain_address, chain, chain_id, voting_token_mint")
      .in("dao_onchain_address", daoAddrs);
    if (chainErr) {
      return jsonResponse({ error: `Failed to read DAO chains: ${chainErr.message}` }, 500);
    }
    for (const row of (chainRows ?? []) as DaoChainRow[]) {
      chainByDao.set(row.dao_onchain_address, row);
    }
  }

  const created: Array<Record<string, unknown>> = [];
  const errors: Array<{ recommendation_id: string; dao: string; action_kind: string; protocol_id: string; error: string }> = [];
  const withheld: Array<{ recommendation_id: string; dao: string; action_kind: string; protocol_id: string; amount_base_units: number }> = [];

  // Group candidate legs by recommendation so the recommendation's status is
  // only advanced when ALL of its actionable legs were proposed (or deduped).
  // If any leg was withheld (withdraw gate off) or errored, the recommendation
  // is left at 'observe' so a later run can finish the remaining legs — the
  // signer's UNIQUE (dao, idempotency_key) index makes the already-proposed
  // legs benign 409 no-ops on that retry.
  const byRec = new Map<string, { rec: RecommendationRow; actions: RecommendedAction[] }>();
  for (const c of candidates) {
    const entry = byRec.get(c.rec.id) ?? { rec: c.rec, actions: [] };
    entry.actions.push(c.action);
    byRec.set(c.rec.id, entry);
  }

  for (const { rec, actions } of byRec.values()) {
    let recProposalAddress = "";
    let anyProgress = false; // a leg was created OR already existed (409)
    let anyWithheld = false;
    let anyError = false;

    for (const action of actions) {
      const actionKind = action.actionType as "deploy" | "withdraw";

      // Capital-OUT moves require the additional withdraw gate.
      if (actionKind === "withdraw" && !withdrawEnabled) {
        withheld.push({
          recommendation_id: rec.id,
          dao: rec.dao_onchain_address,
          action_kind: actionKind,
          protocol_id: action.protocolId,
          amount_base_units: action.amountBaseUnits,
        });
        anyWithheld = true;
        continue;
      }

      // Per-action idempotency key: bind the proof to the SPECIFIC action
      // (kind + protocol + asset mint + amount) so distinct legs of one
      // recommendation can't collide — in particular a withdraw and a deploy to
      // the same protocol for the same amount stay distinct, AND two different
      // assets deployed to the same protocol/amount (multi-asset DAOs) stay
      // distinct — while a retry of the SAME leg is deduped by the signer's
      // UNIQUE constraint.
      const mintKeyPart = action.mint ?? "default";
      const idempotencyKey = `${rec.policy_proof_hash}:${actionKind}:${action.protocolId}:${mintKeyPart}:${action.amountBaseUnits}`;
      const verb = actionKind === "withdraw" ? "Withdraw from" : "Deploy to";

      const daoChain = chainByDao.get(rec.dao_onchain_address);
      const evm = isEvmDaoChain(daoChain?.chain);
      if (evm && (typeof daoChain?.chain_id !== "number")) {
        anyError = true;
        errors.push({
          recommendation_id: rec.id,
          dao: rec.dao_onchain_address,
          action_kind: actionKind,
          protocol_id: action.protocolId,
          error: "EVM DAO is missing chain_id; refusing to propose against a Solana PDA",
        });
        continue;
      }
      if (evm && (!action.programId?.startsWith("0x") || !action.mint?.startsWith("0x"))) {
        anyError = true;
        errors.push({
          recommendation_id: rec.id,
          dao: rec.dao_onchain_address,
          action_kind: actionKind,
          protocol_id: action.protocolId,
          error: "EVM proposal requires an adapter address and an asset address",
        });
        continue;
      }

      const signRes = await callSigner({
        action: "create_proposal",
        action_kind: actionKind,
        dao_address: rec.dao_onchain_address,
        agent_role: proposerRole,
        protocol_id: action.protocolId,
        amount: action.amountBaseUnits,
        // Thread the asset mint (when known) so the signer binds the correct
        // multi-asset mint into the NE-7 payload. Omitted for withdraw legs
        // without a known mint → signer derives it by AssetKind.
        ...(action.mint ? { mint: action.mint } : {}),
        ...(action.programId ? { program_id: action.programId, adapter: action.programId } : {}),
        ...(evm
          ? {
            chain: daoChain?.chain,
            chain_id: daoChain?.chain_id,
            asset: action.mint,
            voting_mint: daoChain?.voting_token_mint ?? undefined,
          }
          : {}),
        title: `${verb} ${action.protocolId}`,
        description: (action.rationale || rec.summary || `Policy recommendation ${rec.id}`).slice(0, 256),
        idempotency_key: idempotencyKey,
        recommendation_id: rec.id,
      });

      if (!signRes.ok) {
        // A 409 means a proposal already exists for this key — benign no-op.
        if (signRes.status === 409) {
          anyProgress = true;
        } else {
          anyError = true;
          errors.push({
            recommendation_id: rec.id,
            dao: rec.dao_onchain_address,
            action_kind: actionKind,
            protocol_id: action.protocolId,
            error: signRes.error ?? "unknown",
          });
        }
        continue;
      }

      anyProgress = true;
      const proposalAddress = (signRes.data?.proposal_address as string) ?? "";
      if (!recProposalAddress && proposalAddress) recProposalAddress = proposalAddress;

      created.push({
        recommendation_id: rec.id,
        dao: rec.dao_onchain_address,
        action_kind: actionKind,
        protocol_id: action.protocolId,
        amount_base_units: action.amountBaseUnits,
        proposal_address: proposalAddress,
        signature: signRes.data?.signature,
      });
    }

    // Advance the recommendation only when every actionable leg has been
    // proposed (or deduped) with nothing withheld or errored.
    if (anyProgress && !anyWithheld && !anyError) {
      const update: Record<string, unknown> = { status: "proposed" };
      if (recProposalAddress) update.proposal_address = recProposalAddress;
      await supabase.from("rebalance_recommendations").update(update).eq("id", rec.id);
    }
  }

  return jsonResponse({
    success: true,
    mode: "active",
    auto_propose_enabled: true,
    withdraw_propose_enabled: withdrawEnabled,
    proposed: created.length,
    created,
    withheld: withheld.length > 0 ? withheld : undefined,
    errors: errors.length > 0 ? errors : undefined,
  });
});
