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
  contractRecord,
  mergeStoredCharter,
  scaleBaseToMicroUsd,
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
import { recordCharterSubmitFailure, syncReview } from "../../supabase/functions/_shared/genlayerSync.ts";
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

test("a finished pass with the gate off does not set shouldSign", () => {
  const flags = {
    failClosedOnUnknown: true,
    genlayerGate: false,
    genlayerVenueGate: false,
    genlayerHaltGate: false,
  };
  const declined = evaluateGuardrails(
    "executive",
    context({ charter: FINISHED_PASS }),
    { ...output, decision: "reject", should_sign: false },
    flags,
  );
  const recorded = declined.checks.find((check) => check.id === "genlayer_charter");
  assert.ok(recorded);
  assert.equal(recorded.ok, true);
  assert.match(recorded.detail, /NAVE_GENLAYER_GATE off/);
  assert.equal(declined.pass, true);
  assert.equal(declined.shouldSign, false);

  const overCap = context({ charter: FINISHED_PASS });
  overCap.request.amount = 90_000;
  const blocked = evaluateGuardrails("executive", overCap, output, flags);
  assert.equal(blocked.checks.find((check) => check.id === "allocation_cap")?.ok, false);
  assert.equal(blocked.checks.find((check) => check.id === "genlayer_charter")?.ok, true);
  assert.equal(blocked.shouldSign, false);
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
  assert.equal(closed.summary, "This move fits the treasury rules.");
  const essay = reviewFromRecord({
    kind: "charter",
    record: { decision: "pass", rule_ids: [], summary: "Finalized essay about equivalence.", action_hash: ACTION },
    observation: { status: "Finalized", executionResult: "FinishedWithReturn" },
    actionHash: ACTION,
    txId: "0xabc",
  });
  assert.equal(essay.summary, "");
  const noReceipt = reviewFromRecord({
    kind: "charter",
    record: { decision: "pass", rule_ids: [], summary: "This move fits the treasury rules.", action_hash: ACTION },
    observation: null,
    actionHash: ACTION,
    txId: "",
  });
  assert.equal(noReceipt.finished, false);
  assert.equal(noReceipt.customer_status, "still_checking");
  assert.equal(noReceipt.tx_id, "");
});

test("an EVM payload hash with 0x matches the stored hash without it", () => {
  const stored = { decision: "pass" as const, rule_ids: [], summary: "", finished: true, provisional: false, action_hash: ACTION };
  assert.equal(charterSatisfies(stored, `0x${ACTION}`), true);
  assert.equal(charterSatisfies({ ...stored, action_hash: `0x${ACTION}` }, ACTION), true);
  assert.equal(charterSatisfies(stored, `0x${"cd".repeat(32)}`), false);
});

test("a JSON contract read keeps its decision, and an empty read does not erase a stored pass", () => {
  const parsed = contractRecord(JSON.stringify({
    decision: "pass",
    summary: "This move fits the treasury rules.",
    action_hash: ACTION,
  }));
  assert.equal(parsed.decision, "pass");
  const fromString = reviewFromRecord({
    kind: "charter",
    record: JSON.stringify({
      decision: "pass",
      rule_ids: [],
      summary: "This move fits the treasury rules.",
      action_hash: ACTION,
    }),
    observation: { status: "Finalized", executionResult: "FinishedWithReturn" },
    actionHash: ACTION,
    txId: "0xabc",
  });
  assert.equal(fromString.decision, "pass");
  assert.equal(fromString.finished, true);
  const kept = mergeStoredCharter({
    decision: "",
    summary: "",
    finished: true,
    provisional: false,
    customer_status: "still_checking",
    rule_ids: [],
    tx_id: "0xabc",
  }, {
    decision: "pass",
    summary: "This move fits the treasury rules.",
    finished: true,
    provisional: false,
    customer_status: "checked",
    rule_ids: [],
    tx_id: "0xabc",
  });
  assert.equal(kept.decision, "pass");
  assert.equal(kept.customer_status, "checked");
  const replaced = mergeStoredCharter({
    ...kept,
    decision: "fail",
    summary: "This would put more into one venue than your limit allows.",
    customer_status: "needs_closer_look",
  }, { decision: "pass", tx_id: "0xabc" });
  assert.equal(replaced.decision, "fail");
});

test("non-stable amounts are priced in micro-USD before they meet a dollar cap", () => {
  // 0.02 SOL against a treasury whose wSOL pile is 0.05 SOL marked at $5.273637.
  const priced = scaleBaseToMicroUsd(20_000_000, 50_000_000, 5_273_637);
  assert.equal(priced, 2_109_454);
  assert.ok(priced != null && priced <= Math.floor(5_273_637 * 5000 / 10_000));
  assert.equal(scaleBaseToMicroUsd(400_000, 400_000, 400_000), 400_000);
  assert.equal(scaleBaseToMicroUsd(1, 0, 1), null);
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
  assert.equal(assetIsStable("0x3600000000000000000000000000000000000000"), true);
  assert.equal(assetIsStable("0xAaaE26C5B891bF00D4cD6eF04148Bf1CB1CC96b1"), true);
  assert.equal(assetIsStable("0x7943e237c7F95DA44E0301572D358911207852Fa"), false);
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

test("venue watch covers all five testnet chains and skips balancer", () => {
  const venues = VENUE_STATUS_TARGETS.map((target) => target.venue);
  assert.deepEqual(venues, [
    "kamino",
    "jito",
    "aave-v3",
    "compound-v3",
    "morpho-steakhouse-usdg",
    "morpho-steakhouse-usdc",
  ]);
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
    "solana:jito",
    "ethereum:aave-v3",
    "ethereum:compound-v3",
    "base:aave-v3",
    "robinhood:morpho-steakhouse-usdg",
    "arc:morpho-steakhouse-usdc",
  ]);
  assert.equal(jobs.some((job) => job.venue.includes("balancer")), false);
  assert.equal(jobs.some((job) => job.network === "mainnet"), false);
  assert.equal(jobs.some((job) => job.chain_family === "robinhood"), true);
  assert.equal(jobs.some((job) => job.chain_family === "arc"), true);
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

function charterCaseInput() {
  return {
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
}

test("a charter write retries leader timeout and not voted, and stops after two extra attempts", async () => {
  const receipts = [
    { status: "LEADER_TIMEOUT", executionResult: "" },
    { status: "ACCEPTED", executionResult: "NOT_VOTED" },
    { status: "LEADER_TIMEOUT", executionResult: "NOT_VOTED" },
    { status: "FINALIZED", executionResult: "FINISHED_WITH_RETURN" },
  ];
  let statusCalls = 0;
  const writes: string[][] = [];
  const session = {
    async read() {
      return false;
    },
    async write(_kind: "charter", method: string, args: string[]) {
      writes.push([method, ...args]);
      return `0xtx${writes.length}`;
    },
    async status() {
      const receipt = receipts[statusCalls] ?? receipts[receipts.length - 1];
      statusCalls += 1;
      return receipt;
    },
  };
  const result = await syncReview(session, "charter", charterCaseInput(), "");
  assert.equal(writes.length, 3);
  assert.equal(statusCalls, 3);
  for (const call of writes) assert.equal(call[0], "open_case");
  assert.equal(writes[0].length, writes[1].length);
  assert.equal(result.tx_id, "0xtx3");
  assert.equal(result.receipt_status, "LEADER_TIMEOUT");
  assert.equal(result.finished, false);
  assert.equal(result.provisional, true);
  assert.equal(result.customer_status, "still_checking");
  assert.match(result.summary, /LEADER_TIMEOUT/);
});

test("an unnamed in-flight status with not voted is not submitted again", async () => {
  const writes: string[] = [];
  const session = {
    async read() {
      return false;
    },
    async write() {
      writes.push("open_case");
      return "0xinflight";
    },
    async status() {
      return { status: "14", executionResult: "NOT_VOTED" };
    },
  };
  const input = charterCaseInput();
  const first = await syncReview(session, "charter", input, "");
  const second = await syncReview(session, "charter", input, first.tx_id);
  assert.equal(writes.length, 1);
  assert.equal(first.tx_id, "0xinflight");
  assert.equal(first.receipt_status, "14");
  assert.equal(first.finished, false);
  assert.equal(second.tx_id, "0xinflight");
  assert.doesNotMatch(first.summary, /NOT_VOTED/);
});

test("a ready-to-finalize receipt is still in flight and is not submitted again", async () => {
  const writes: string[] = [];
  const session = {
    async read() {
      return false;
    },
    async write() {
      writes.push("open_case");
      return "0xready";
    },
    async status() {
      return { status: "READY_TO_FINALIZE", executionResult: "NOT_VOTED" };
    },
  };
  const input = charterCaseInput();
  const first = await syncReview(session, "charter", input, "");
  const second = await syncReview(session, "charter", input, first.tx_id);
  assert.equal(writes.length, 1);
  assert.equal(first.tx_id, "0xready");
  assert.equal(first.receipt_status, "READY_TO_FINALIZE");
  assert.equal(first.finished, false);
  assert.equal(second.tx_id, "0xready");
  assert.doesNotMatch(first.summary, /NOT_VOTED/);
});

test("a pending not-voted receipt is still in progress and is not submitted again", async () => {
  const writes: string[] = [];
  const session = {
    async read() {
      return false;
    },
    async write() {
      writes.push("open_case");
      return "0xpending";
    },
    async status() {
      return { status: "PENDING", executionResult: "NOT_VOTED" };
    },
  };
  const input = charterCaseInput();
  const first = await syncReview(session, "charter", input, "");
  const second = await syncReview(session, "charter", input, first.tx_id);
  assert.equal(writes.length, 1);
  assert.equal(first.tx_id, "0xpending");
  assert.equal(first.receipt_status, "PENDING");
  assert.equal(first.finished, false);
  assert.equal(first.customer_status, "still_checking");
  assert.equal(second.tx_id, "0xpending");
  assert.equal(second.finished, false);
  assert.doesNotMatch(first.summary, /NOT_VOTED/);
});

test("a stored accepted transaction is polled and is not submitted again", async () => {
  const writes: string[] = [];
  const session = {
    async read() {
      return false;
    },
    async write() {
      writes.push("open_case");
      return "0xnew";
    },
    async status() {
      return { status: "Accepted", executionResult: "FINISHED_WITH_RETURN" };
    },
  };
  const result = await syncReview(session, "charter", charterCaseInput(), "0xstored");
  assert.deepEqual(writes, []);
  assert.equal(result.tx_id, "0xstored");
  assert.equal(result.receipt_status, "Accepted");
  assert.equal(result.finished, false);
  assert.equal(result.customer_status, "still_checking");
});

test("a stored leader timeout gets two extra charter writes", async () => {
  const receipts = [
    { status: "LEADER_TIMEOUT", executionResult: "" },
    { status: "LEADER_TIMEOUT", executionResult: "" },
    { status: "FINALIZED", executionResult: "FINISHED_WITH_RETURN" },
  ];
  let statusCalls = 0;
  const writes: string[] = [];
  const session = {
    async read(_kind: "charter", method: string) {
      if (method === "has_case") return writes.length >= 2;
      if (method === "get_case") {
        return { decision: "pass", rule_ids: [], summary: "This move fits the treasury rules.", action_hash: ACTION };
      }
      return null;
    },
    async write() {
      writes.push("open_case");
      return `0xretry${writes.length}`;
    },
    async status() {
      const receipt = receipts[statusCalls] ?? receipts[receipts.length - 1];
      statusCalls += 1;
      return receipt;
    },
  };
  const result = await syncReview(session, "charter", charterCaseInput(), "0xold");
  assert.deepEqual(writes, ["open_case", "open_case"]);
  assert.equal(result.tx_id, "0xretry2");
  assert.equal(result.receipt_status, "FINALIZED");
  assert.equal(result.finished, true);
  assert.equal(result.decision, "pass");
  assert.equal(result.customer_status, "checked");
});

test("a stored validators timeout is written again only while no case is stored", async () => {
  const writes: string[] = [];
  let stored = false;
  const session = {
    async read(_kind: "charter", method: string) {
      if (method === "has_case") return stored;
      if (method === "get_case") {
        return { decision: "pass", rule_ids: [], summary: "This move fits the treasury rules.", action_hash: ACTION };
      }
      return null;
    },
    async write() {
      writes.push("open_case");
      return `0xretry${writes.length}`;
    },
    async status(txId: string) {
      return txId === "0xold"
        ? { status: "VALIDATORS_TIMEOUT", executionResult: "NONDET_DISAGREE" }
        : { status: "PENDING", executionResult: "NOT_VOTED" };
    },
  };
  const first = await syncReview(session, "charter", charterCaseInput(), "0xold");
  assert.deepEqual(writes, ["open_case"]);
  assert.equal(first.tx_id, "0xretry1");
  assert.equal(first.finished, false);

  stored = true;
  await syncReview(session, "charter", charterCaseInput(), "0xold");
  assert.deepEqual(writes, ["open_case"], "a stored case is never opened again");
});

test("a stored case without a transaction id stays unfinished and is not marked Accepted", async () => {
  let statusCalls = 0;
  const writes: string[] = [];
  const session = {
    async read(_kind: "charter", method: string) {
      if (method === "has_case") return true;
      if (method === "get_case") {
        return {
          decision: "pass",
          rule_ids: [],
          summary: "This move fits the treasury rules.",
          action_hash: ACTION,
        };
      }
      return null;
    },
    async write() {
      writes.push("open_case");
      return "0xshould-not-write";
    },
    async status() {
      statusCalls += 1;
      return { status: "Accepted", executionResult: "FINISHED_WITH_RETURN" };
    },
  };
  const result = await syncReview(session, "charter", charterCaseInput(), "  ");
  assert.deepEqual(writes, []);
  assert.equal(statusCalls, 0);
  assert.equal(result.tx_id, "");
  assert.equal(result.receipt_status, "");
  assert.equal(result.decision, "pass");
  assert.equal(result.summary, "This move fits the treasury rules.");
  assert.equal(result.finished, false);
  assert.equal(result.provisional, true);
  assert.equal(result.customer_status, "still_checking");
});

function haltCaseInput() {
  return {
    chain_family: "ethereum" as const,
    network: "testnet" as const,
    treasury: "0x2222222222222222222222222222222222222222",
    action_hash: ACTION,
    venue: "aave-v3",
    amount: "1000",
    asset: "USDC",
    pause_reason: "Reviewers asked for another look at this move.",
    counterevidence: "The venue published a full incident closure and service is restored.",
  };
}

test("an in-flight halt appeal is not opened again", async () => {
  const writes: string[] = [];
  const session = {
    async read() {
      return false;
    },
    async write() {
      writes.push("open_appeal");
      return "0xhalt";
    },
    async status() {
      return { status: "14", executionResult: "NOT_VOTED" };
    },
  };
  const input = haltCaseInput();
  const first = await syncReview(session, "halt", input, "");
  const second = await syncReview(session, "halt", input, first.tx_id);
  assert.equal(writes.length, 1);
  assert.equal(first.tx_id, "0xhalt");
  assert.equal(first.receipt_status, "14");
  assert.equal(first.finished, false);
  assert.equal(second.tx_id, "0xhalt");
  assert.equal(second.halt_decision, "");
});

test("a stored halt leader timeout is retried and does not replace an open appeal", async () => {
  const writes: string[] = [];
  const session = {
    async read(_kind: "halt", method: string) {
      if (method === "has_appeal") return writes.length > 0;
      if (method === "get_appeal") {
        return { decision: "lift_pause", summary: "A second check says the pause can be lifted by the treasury operators." };
      }
      return null;
    },
    async write() {
      writes.push("open_appeal");
      return "0xhalt-retry";
    },
    async status() {
      return writes.length > 1
        ? { status: "FINALIZED", executionResult: "FINISHED_WITH_RETURN" }
        : { status: "LEADER_TIMEOUT", executionResult: "NOT_VOTED" };
    },
  };
  const input = haltCaseInput();
  const first = await syncReview(session, "halt", input, "0xold-timeout");
  assert.deepEqual(writes, ["open_appeal", "open_appeal"]);
  assert.equal(first.finished, true);
  assert.equal(first.halt_decision, "lift_pause");
  assert.equal(first.decision, "lift_pause");
  const second = await syncReview(session, "halt", input, first.tx_id);
  assert.deepEqual(writes, ["open_appeal", "open_appeal"]);
  assert.equal(second.tx_id, first.tx_id);
});

test("an in-flight venue review is not submitted again", async () => {
  const writes: string[] = [];
  const session = {
    async read() {
      return false;
    },
    async write() {
      writes.push("review_venue");
      return "0xvenue";
    },
    async status() {
      return { status: "14", executionResult: "NOT_VOTED" };
    },
  };
  const input = {
    chain_family: "ethereum" as const,
    network: "testnet" as const,
    treasury: "0x1111111111111111111111111111111111111111",
    action_hash: "aave-v3",
    venue: "aave-v3",
    status_url: "https://status.aave.com/api/v2/summary.json",
  };
  const first = await syncReview(session, "venue", input, "");
  const second = await syncReview(session, "venue", input, first.tx_id);
  assert.equal(writes.length, 1);
  assert.equal(first.receipt_status, "14");
  assert.equal(first.finished, false);
  assert.equal(first.venue_status, null);
  assert.equal(second.tx_id, "0xvenue");
});

test("a thrown charter submit is returned unfinished instead of dropped", async () => {
  const review = await recordCharterSubmitFailure(charterCaseInput(), new Error("rpc down"));
  assert.equal(review.finished, false);
  assert.equal(review.provisional, true);
  assert.equal(review.customer_status, "still_checking");
  assert.equal(review.decision, "");
  assert.equal(review.tx_id, "");
  assert.equal(review.receipt_status, "");
  assert.match(review.summary, /Charter submit failed: rpc down/);
});

test("charter outcome is fail-closed only for the signing gate", () => {
  const missing = charterGateOutcome({ gateOn: true, signing: true, expectedActionHash: "", charter: null });
  assert.equal(missing.block, true);
  const off = charterGateOutcome({ gateOn: false, signing: true, expectedActionHash: SAME_ACTION_HASH, charter: FAILED_CHECK });
  assert.equal(off.block, false);
  assert.equal(off.recordedOnly, true);
});
