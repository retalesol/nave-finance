import assert from "node:assert/strict";
import test from "node:test";
import { evaluateGuardrails } from "../../supabase/functions/_shared/guardrails.ts";
import type { AgentContext } from "../../supabase/functions/_shared/agentContext.ts";
import { withholdStoppedVenues } from "../../supabase/functions/_shared/yieldSources.ts";
import {
  ASK_ANOTHER_CHECK_LABEL,
  CUSTOMER_STATUS_LABEL,
  HOW_CHECKED_LABEL,
  buildHaltArgs,
  counterevidenceError,
  venueWatchJobs,
  VENUE_STATUS_TARGETS,
  assetIsStable,
  buildOpenCaseArgs,
  charterGateOutcome,
  constitutionSnapshot,
  charterRpcParams,
  charterSatisfies,
  customerStatus,
  everydaySentence,
  haltAppealEffect,
  interpretCharterResponse,
  mandateFromRules,
  observationFinished,
  publicInputsError,
  reviewFromRecord,
  screenStatus,
  sha256Hex,
  chainFamilyFrom,
  isChainFamily,
  storedDecision,
} from "../../supabase/functions/_shared/genlayerCharter.ts";
import { syncReview } from "../../supabase/functions/_shared/genlayerSync.ts";
import {
  FAILED_CHECK,
  FINISHED_PASS,
  FOUR_CHAIN_CASES,
  PROVISIONAL_ACCEPT,
  SAME_ACTION_HASH,
} from "./fixtures/genlayer-four-chains.ts";

const NOW = "2026-01-01T00:00:00Z";

function context(genlayer?: AgentContext["genlayer"], actionType = "execute_strategy"): AgentContext {
  return {
    version: "1.1.0",
    daoAddress: "Dao1111111111111111111111111111111111111111",
    daoName: "Test DAO",
    governanceType: "token",
    role: "executive",
    request: {
      address: "Er11111111111111111111111111111111111111111",
      actionType,
      protocolId: "kamino",
      expectedPayloadHash: SAME_ACTION_HASH,
      amount: 1000,
    },
    treasury: {
      totalValueUsd: 100000,
      solBalance: 10,
      usdcBalance: 50000,
      snapshotAt: NOW,
      strategyPositions: [{ current_value: 2000 }],
    },
    approvedProtocols: ["kamino", "jito"],
    riskParams: { confidenceThreshold: 70, maxSingleAllocationBps: 5000 },
    priorActions: [],
    recentActivity: [],
    assembledAt: NOW,
    genlayer,
  };
}

const output = {
  decision: "approve",
  confidence: 88,
  should_sign: true,
  payload_hash: SAME_ACTION_HASH,
  risk_flags: [] as string[],
};

function run(genlayer: AgentContext["genlayer"], flags: { charter?: boolean; venue?: boolean; halt?: boolean }, actionType?: string) {
  return evaluateGuardrails("executive", context(genlayer, actionType), output, {
    failClosedOnUnknown: true,
    genlayerGate: flags.charter ?? false,
    genlayerVenueGate: flags.venue ?? false,
    genlayerHaltGate: flags.halt ?? false,
  });
}

test("customer words and status mapping", () => {
  assert.equal(CUSTOMER_STATUS_LABEL.checked, "Checked");
  assert.equal(CUSTOMER_STATUS_LABEL.needs_closer_look, "Needs a closer look");
  assert.equal(CUSTOMER_STATUS_LABEL.still_checking, "Still checking");
  assert.equal(ASK_ANOTHER_CHECK_LABEL, "Ask for another check");
  assert.equal(HOW_CHECKED_LABEL, "How this was checked");
  assert.equal(customerStatus(FINISHED_PASS), "checked");
  assert.equal(customerStatus(FAILED_CHECK), "needs_closer_look");
  assert.equal(customerStatus(PROVISIONAL_ACCEPT), "still_checking");
  assert.equal(customerStatus(null), "still_checking");
  assert.equal(customerStatus({ decision: "pass", finished: false, provisional: false }), "still_checking");
  assert.equal(
    everydaySentence("Finalized equivalence on chain id 1 with an appeal bond."),
    "This move does not fit the treasury's rules.",
  );
  assert.equal(
    everydaySentence("This would put more into one venue than your limit allows"),
    "This would put more into one venue than your limit allows.",
  );
});

test("public inputs reject an assistant paragraph and omit it from the case", () => {
  assert.match(
    publicInputsError({ chain_family: "base", reasoning_summary: "The assistant already decided this passes." }) ?? "",
    /public inputs only/,
  );
  const params = charterRpcParams({
    chain_family: "solana",
    network: "devnet",
    treasury: "TreasurySame111111111111111111111111111111",
    action_hash: SAME_ACTION_HASH,
    mandate_hash: "m",
    constitution_hash: "c",
    venue: "kamino",
    amount: "1000",
    asset: "USDC",
  });
  for (const key of ["reasoning", "verdict", "summary", "decision", "essay"]) {
    assert.equal(key in params, false);
  }
  assert.equal(params.action_hash, SAME_ACTION_HASH);
});

test("a provisional accept does not satisfy the gate", () => {
  const read = interpretCharterResponse(
    { decision: "pass", status: "accepted", action_hash: SAME_ACTION_HASH, summary: "looks fine" },
    SAME_ACTION_HASH,
  );
  assert.equal(read.customer_status, "still_checking");
  assert.equal(read.finished, false);
  assert.equal(charterSatisfies({
    decision: "pass",
    rule_ids: [],
    summary: "",
    finished: read.finished,
    provisional: read.provisional,
    action_hash: read.action_hash,
  }, SAME_ACTION_HASH), false);

  const closed = interpretCharterResponse(
    { decision: "pass", status: "final", action_hash: SAME_ACTION_HASH, finished: true },
    SAME_ACTION_HASH,
  );
  assert.equal(closed.customer_status, "checked");
  assert.equal(closed.finished, true);
  assert.equal(closed.provisional, false);
});

test("four chains, same action, same status and the same block", () => {
  const blocks = FOUR_CHAIN_CASES.map((chain) => {
    const verdict = run({ chain_family: chain.chain_family, charter: FAILED_CHECK }, { charter: true });
    return {
      family: chain.chain_family,
      status: customerStatus(FAILED_CHECK),
      shouldSign: verdict.shouldSign,
      pass: verdict.pass,
      charter: verdict.checks.find((check) => check.id === "genlayer_charter"),
    };
  });
  for (const row of blocks) {
    assert.equal(row.status, "needs_closer_look");
    assert.equal(row.shouldSign, false);
    assert.equal(row.pass, false);
    assert.equal(row.charter?.ok, false);
    assert.equal(row.charter?.detail, blocks[0].charter?.detail);
  }

  const allows = FOUR_CHAIN_CASES.map((chain) => {
    const verdict = run(
      { chain_family: chain.chain_family, charter: FINISHED_PASS },
      { charter: true },
    );
    return { shouldSign: verdict.shouldSign, pass: verdict.pass, status: customerStatus(FINISHED_PASS) };
  });
  for (const row of allows) {
    assert.equal(row.status, "checked");
    assert.equal(row.shouldSign, true);
    assert.equal(row.pass, true);
  }
});

test("gate off records a failed check and does not block", () => {
  const verdict = run({ charter: FAILED_CHECK }, { charter: false });
  assert.equal(verdict.pass, true);
  assert.equal(verdict.shouldSign, true);
  const charter = verdict.checks.find((check) => check.id === "genlayer_charter");
  assert.ok(charter);
  assert.equal(charter.ok, true);
  assert.match(charter.detail, /NAVE_GENLAYER_GATE off/);
});

test("gate on blocks a missing, failed, unfinished, or mismatched check", () => {
  const missing = run({ charter: null }, { charter: true });
  assert.equal(missing.shouldSign, false);
  assert.ok(missing.failures.some((line) => line.startsWith("genlayer_charter")));

  const failed = run({ charter: FAILED_CHECK }, { charter: true });
  assert.equal(failed.shouldSign, false);
  assert.match(failed.failures.join(" "), /venue than your limit/);

  const unfinished = run({ charter: PROVISIONAL_ACCEPT }, { charter: true });
  assert.equal(unfinished.shouldSign, false);
  assert.match(unfinished.failures.join(" "), /provisional accept/);

  const mismatch = run({
    charter: { ...FINISHED_PASS, action_hash: "other-action" },
  }, { charter: true });
  assert.equal(mismatch.shouldSign, false);
  assert.match(mismatch.failures.join(" "), /does not match/);
});

test("gate on allows a finished pass with the matching action hash", () => {
  const verdict = run({ charter: FINISHED_PASS }, { charter: true });
  assert.equal(verdict.pass, true);
  assert.equal(verdict.shouldSign, true);
  assert.equal(verdict.checks.find((check) => check.id === "payload_hash_equality")?.ok, true);
  assert.equal(verdict.checks.find((check) => check.id === "allocation_cap")?.ok, true);
});

test("venue stop withholds a new deploy only when the venue flag is on", () => {
  const stopped = { status: "stop" as const, venue_id: "kamino", summary: "", finished: true };
  const off = run({ venue: stopped }, { venue: false });
  assert.equal(off.shouldSign, true);
  const on = run({ venue: stopped }, { venue: true });
  assert.equal(on.shouldSign, false);
  assert.ok(on.failures.some((line) => line.startsWith("genlayer_venue")));
  const fine = run({ venue: { ...stopped, status: "fine" } }, { venue: true });
  assert.equal(fine.shouldSign, true);

  const opportunities = [{ protocolId: "kamino" }, { protocolId: "jito" }];
  const watches = [{ protocolId: "kamino", status: "stop" }];
  assert.deepEqual(withholdStoppedVenues(opportunities, watches, false), opportunities);
  assert.deepEqual(withholdStoppedVenues(opportunities, watches, true), [{ protocolId: "jito" }]);

  const evm = [{ protocolId: "aave" }, { protocolId: "compound" }];
  assert.deepEqual(
    withholdStoppedVenues(evm, [{ protocolId: "aave-v3", status: "stop" }], true),
    [{ protocolId: "compound" }],
  );
});

test("keep_pause blocks clear only when the halt flag is on; lift never signs or shortens the window", () => {
  const lift = haltAppealEffect({ decision: "lift_pause" });
  assert.equal(lift.maySignOperationalClear, false);
  assert.equal(lift.shortensReviewWindow, false);
  assert.equal(lift.blockClear, false);
  const keep = haltAppealEffect({ decision: "keep_pause" });
  assert.equal(keep.maySignOperationalClear, false);
  assert.equal(keep.shortensReviewWindow, false);
  assert.equal(keep.blockClear, true);

  const clearing = {
    ...output,
    should_sign: false,
    should_clear_halt: true,
    should_halt: false,
  };
  const base = context({ halt: { decision: "keep_pause", summary: "", finished: true, action_hash: SAME_ACTION_HASH } }, "operational_clear");
  const blocked = evaluateGuardrails("operational", base, clearing, {
    failClosedOnUnknown: true,
    genlayerGate: false,
    genlayerVenueGate: false,
    genlayerHaltGate: true,
  });
  assert.equal(blocked.pass, false);
  assert.equal(blocked.shouldSign, false);
  assert.ok(blocked.failures.some((line) => line.startsWith("genlayer_halt")));

  const recorded = evaluateGuardrails("operational", base, clearing, {
    failClosedOnUnknown: true,
    genlayerHaltGate: false,
  });
  assert.equal(recorded.pass, true);
  assert.equal(recorded.shouldSign, false);

  const lifted = evaluateGuardrails("operational", {
    ...base,
    genlayer: { halt: { decision: "lift_pause", summary: "", finished: true, action_hash: SAME_ACTION_HASH } },
  }, clearing, {
    failClosedOnUnknown: true,
    genlayerGate: false,
    genlayerVenueGate: false,
    genlayerHaltGate: true,
  });
  assert.equal(lifted.pass, true);
  assert.equal(lifted.shouldSign, false);
  assert.equal(haltAppealEffect(lifted && { decision: "lift_pause" }).maySignOperationalClear, false);
});

const ACTION = "ab".repeat(32);

test("an empty review stays off the screen, and an accepted fail stays unfinished", () => {
  assert.equal(screenStatus(null), null);
  assert.equal(screenStatus({ decision: "", tx_id: "" }), null);
  assert.equal(customerStatus({ decision: "fail", finished: false, provisional: true }), "still_checking");
  const accepted = reviewFromRecord({
    kind: "charter",
    record: { decision: "fail", rule_ids: ["allocation_cap"], summary: "This would put more into one venue than your limit allows.", action_hash: ACTION },
    observation: { status: "Accepted", executionResult: "" },
    actionHash: ACTION,
    txId: "0xabc",
  });
  assert.equal(accepted.finished, false);
  assert.equal(accepted.customer_status, "still_checking");
  assert.equal(observationFinished({ status: "Finalized", executionResult: "FinishedWithReturn" }), true);
  assert.equal(observationFinished({ status: "FINALIZED", executionResult: "FINISHED_WITH_RETURN" }), true);
  assert.equal(observationFinished({ status: "FINALIZED", executionResult: "FINISHED_WITH_ERROR" }), false);
  assert.equal(observationFinished({ status: "ACCEPTED", executionResult: "FINISHED_WITH_RETURN" }), false);
  const closed = reviewFromRecord({
    kind: "charter",
    record: { decision: "pass", rule_ids: [], summary: "This move fits the treasury rules.", action_hash: ACTION },
    observation: { status: "Finalized", executionResult: "FinishedWithReturn" },
    actionHash: ACTION,
    txId: "0xabc",
  });
  assert.equal(closed.finished, true);
  assert.equal(closed.provisional, false);
  assert.equal(closed.customer_status, "checked");
});

test("open_case args carry the mandate and constitution, and public inputs allow them", () => {
  const snapshot = constitutionSnapshot({
    approvedVenues: ["aave-v3", "compound-v3"],
    venue: "aave-v3",
    maxSingleAllocationBps: 2500,
    maxDeploymentBps: 8000,
    liquidityFloorBps: 1000,
    reserveFloorBps: 2000,
    navBaseUnits: 1_000_000,
    deployedBaseUnits: 100_000,
    venueDeployedBaseUnits: 50_000,
    reserveBaseUnits: 400_000,
    assetIsStable: true,
  });
  assert.ok(snapshot);
  assert.equal(snapshot.liquid_base_units, "900000");
  assert.equal(snapshot.max_deployment_bps, 8000);
  assert.equal(constitutionSnapshot({
    approvedVenues: [],
    venue: "aave-v3",
    maxSingleAllocationBps: 2500,
    maxDeploymentBps: 8000,
    liquidityFloorBps: 1000,
    reserveFloorBps: 2000,
    navBaseUnits: 1_000_000,
    deployedBaseUnits: 100_000,
    venueDeployedBaseUnits: 50_000,
    reserveBaseUnits: 400_000,
    assetIsStable: true,
  }), null);
  assert.equal(assetIsStable("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"), true);
  assert.equal(assetIsStable("not-a-known-mint"), null);
  const constitution = JSON.stringify({ ...snapshot, note: "x".repeat(400) });
  assert.equal(publicInputsError({
    chain_family: "solana",
    constitution_json: constitution,
    mandate_text: mandateFromRules({
      maxSingleAllocationBps: 2500,
      maxDeploymentBps: 8000,
      liquidityFloorBps: 1000,
      reserveFloorBps: 2000,
    }),
  }), null);
  assert.match(publicInputsError({ reasoning: "The assistant already decided this passes and wrote a long essay." }) ?? "", /public inputs only/);
  return buildOpenCaseArgs({
    chain_family: "ethereum",
    network: "testnet",
    treasury: "0x1111111111111111111111111111111111111111",
    action_hash: `0x${ACTION}`,
    venue: "aave-v3",
    amount: "1000",
    asset: "USDC",
    mandate_text: "Keep at least 10 percent available.",
    constitution_json: constitution,
  }).then(async (call) => {
    assert.equal(call.method, "open_case");
    assert.equal(call.args.length, 11);
    assert.equal(call.args[3], ACTION);
    assert.equal(call.args[7], "Keep at least 10 percent available.");
    assert.equal(call.args[8], await sha256Hex("Keep at least 10 percent available."));
    assert.equal(call.args[9], constitution);
    assert.throws(
      () => buildHaltArgs({
        chain_family: "base",
        network: "testnet",
        treasury: "0x2222222222222222222222222222222222222222",
        action_hash: ACTION,
        pause_reason: "Reviewers asked for another look at this move.",
      }),
      /counterevidence is missing/,
    );
    assert.equal(counterevidenceError("   "), "counterevidence is missing");
    assert.equal(counterevidenceError("lift_pause"), "A prewritten decision is not evidence");
    const evidence = "The venue published a full incident closure and service is restored.";
    const halt = buildHaltArgs({
      chain_family: "base",
      network: "testnet",
      treasury: "0x2222222222222222222222222222222222222222",
      action_hash: ACTION,
      pause_reason: "Reviewers asked for another look at this move.",
      counterevidence: evidence,
    });
    assert.equal(halt.method, "open_appeal");
    assert.equal(halt.args[3], ACTION);
    assert.equal(halt.args[5], evidence);
  });
});

test("venue watch covers kamino, aave v3, and compound v3 and skips balancer", () => {
  const venues = VENUE_STATUS_TARGETS.map((target) => target.venue);
  assert.deepEqual(venues, ["kamino", "aave-v3", "compound-v3"]);
  assert.equal(venues.includes("balancer-v2"), false);
  for (const target of VENUE_STATUS_TARGETS) {
    assert.match(target.statusUrl, /^https:\/\/\S+$/);
  }
  const jobs = venueWatchJobs([
    { treasury: "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2", chain: "solana", network: "devnet" },
    { treasury: "0x1111111111111111111111111111111111111111", chain: "ethereum", network: "testnet" },
    { treasury: "0x2222222222222222222222222222222222222222", chain: "base", network: "testnet" },
    { treasury: "0x3333333333333333333333333333333333333333", chain: "robinhood", network: "testnet" },
    { treasury: "0x4444444444444444444444444444444444444444", chain: "arc", network: "testnet" },
    { treasury: "0x5555555555555555555555555555555555555555", chain: "ethereum", network: "mainnet" },
  ]);
  assert.deepEqual(jobs.map((job) => `${job.chain_family}:${job.venue}`), [
    "solana:kamino",
    "ethereum:aave-v3",
    "ethereum:compound-v3",
    "base:aave-v3",
  ]);
  assert.equal(jobs.some((job) => job.venue.includes("balancer")), false);
  assert.equal(jobs.some((job) => job.network === "mainnet"), false);
  assert.equal(jobs.some((job) => job.chain_family === "arc"), false);
});

test("arc stays in the family union, and venue and halt stay off the charter decision", () => {
  assert.equal(isChainFamily("arc"), true);
  assert.equal(chainFamilyFrom("arc", 5042002), "arc");
  assert.equal(chainFamilyFrom(null, 5042002), "arc");
  assert.equal(chainFamilyFrom(null, 5042), "solana");
  const venue = reviewFromRecord({
    kind: "venue",
    record: { status: "fine", summary: "Aave status page is up." },
    observation: { status: "Finalized", executionResult: "FinishedWithReturn" },
    actionHash: "aave-v3",
    txId: "0xvenue",
  });
  assert.equal(venue.decision, "");
  assert.equal(venue.halt_decision, "");
  assert.equal(venue.venue_status, "fine");
  assert.equal(storedDecision(venue), "");
  const halt = reviewFromRecord({
    kind: "halt",
    record: { decision: "keep_pause", summary: "The pause stays until the incident is closed." },
    observation: { status: "Finalized", executionResult: "FinishedWithReturn" },
    actionHash: ACTION,
    txId: "0xhalt",
  });
  assert.equal(halt.decision, "");
  assert.equal(halt.halt_decision, "keep_pause");
  assert.equal(halt.venue_status, null);
  assert.equal(storedDecision(halt), "keep_pause");
});

test("a configured session opens a case once, and an accepted result does not finish it", async () => {
  const writes: string[] = [];
  const session = {
    async read(_kind: "charter", method: string) {
      if (method === "has_case") return writes.length > 0;
      if (method === "get_case") {
        return { decision: "fail", rule_ids: ["allocation_cap"], summary: "Too much in one venue.", action_hash: ACTION };
      }
      return null;
    },
    async write(_kind: "charter", method: string) {
      writes.push(method);
      return "0xtx";
    },
    async status() {
      return { status: "Accepted", executionResult: "" };
    },
  };
  const input = {
    chain_family: "solana" as const,
    network: "devnet" as const,
    treasury: "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2",
    action_hash: ACTION,
    venue: "kamino",
    amount: "1000",
    asset: "USDC",
    mandate_text: "Keep at least 10 percent available.",
    constitution_json: JSON.stringify({
      approved_venues: ["kamino"],
      max_single_allocation_bps: 2500,
      max_deployment_bps: 8000,
      liquidity_floor_bps: 1000,
      reserve_floor_bps: 2000,
      nav_base_units: "1000000",
      deployed_base_units: "100000",
      venue_deployed_base_units: "50000",
      liquid_base_units: "900000",
      reserve_base_units: "400000",
      asset_is_stable: true,
    }),
  };
  const first = await syncReview(session, "charter", input, "");
  const second = await syncReview(session, "charter", input, first.tx_id);
  assert.deepEqual(writes, ["open_case"]);
  assert.equal(first.tx_id, "0xtx");
  assert.equal(first.customer_status, "still_checking");
  assert.equal(second.finished, false);
  assert.equal(second.customer_status, "still_checking");
});

test("charter outcome is fail-closed only for the signing gate", () => {
  const missing = charterGateOutcome({ gateOn: true, signing: true, expectedActionHash: "", charter: null });
  assert.equal(missing.block, true);
  const off = charterGateOutcome({ gateOn: false, signing: true, expectedActionHash: SAME_ACTION_HASH, charter: FAILED_CHECK });
  assert.equal(off.block, false);
  assert.equal(off.recordedOnly, true);
});
