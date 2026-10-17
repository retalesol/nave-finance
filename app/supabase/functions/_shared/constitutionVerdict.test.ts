// deno test --node-modules-dir=none --allow-env --allow-read --allow-net --no-check \
//   supabase/functions/_shared/constitutionVerdict.test.ts
// Runs offline: the GenLayer view is supplied and SOLANA_RPC_URL is unset, so
// no chain state can be read and every capital action must fail closed.

import assert from "node:assert/strict";
import {
  assessSignerPayload,
  setChainStateForTests,
  type ChainState,
  type SignerVerdictInput,
} from "./constitutionVerdict.ts";

const DAO = "11111111111111111111111111111111";

function input(overrides: Partial<SignerVerdictInput>): SignerVerdictInput {
  return {
    action: "execute_strategy",
    dao_address: DAO,
    agent_role: "executive",
    chain: "solana",
    genlayer: {},
    ...overrides,
  } as SignerVerdictInput;
}

function failures(record: Record<string, unknown>): string[] {
  return (record.failures as string[] | undefined) ?? [];
}

Deno.env.delete("SOLANA_RPC_URL");
Deno.env.delete("NAVE_COMPOUND_ENABLED");
Deno.env.delete("NAVE_AUTO_WITHDRAW_ENABLED");

Deno.test("accounting marks are allowed and never reach a capital signature", async () => {
  const v = await assessSignerPayload(input({ action: "update_strategy_position_value", agent_role: "operational" }));
  assert.equal(v.allow, true);
  assert.equal(v.record.should_sign, false);
  assert.equal(v.record.amount_moved, 0);
});

Deno.test("control actions stay allowed while capital is paused", async () => {
  const v = await assessSignerPayload(input({ action: "operational_halt", agent_role: "operational" }));
  assert.equal(v.allow, true);
  assert.equal(v.record.action_class, "control");
});

Deno.test("a capital action without a readable constitution fails closed", async () => {
  const v = await assessSignerPayload(input({ action: "execute_strategy", amount: 1_000_000, protocol_id: "kamino" }));
  assert.equal(v.allow, false);
  assert.equal(v.record.should_sign, false);
});

Deno.test("compound needs its flag and a nonzero min_out", async () => {
  const v = await assessSignerPayload(input({ action: "compound", purpose: "compound", amount: 10 }));
  assert.equal(v.allow, false);
  const f = failures(v.record);
  assert.ok(f.some((x) => x.includes("NAVE_COMPOUND_ENABLED is false")), f.join(" | "));
  assert.ok(f.some((x) => x.includes("compound requires min_out > 0")), f.join(" | "));
});

function openTreasury(): ChainState {
  const now = Math.floor(Date.now() / 1000);
  return {
    constitution: {
      approvedProtocols: [{
        protocolId: "kamino",
        programId: "Kamino11111111111111111111111111111111111",
        maxAllocationBps: 10_000,
        riskTier: 1,
        approved: true,
      }],
      confidenceThreshold: 0,
      minStablecoinReserveBps: 1_000,
      maxTotalDeployedBps: 8_000,
      minLiquidityBps: 1_000,
      rebalanceFrequencySecs: 3_600,
      lastRebalanceAt: now,
    },
    vault: {
      navBaseUnits: 2_000_000,
      deployedBaseUnits: 1_000_000,
      navLastRevaluedAt: now,
    },
    gate: { agentsEnabled: true, frozen: false },
    targetDeployed: 1_000_000,
  };
}

Deno.test("compound is refused at min_out 0 and accepted when the flag is on and min_out is positive", async () => {
  const harvest = {
    action: "withdraw_from_strategy",
    purpose: "compound" as const,
    amount: 100_000,
    protocol_id: "kamino",
    payload_hash: "harvest-payload",
    expected_payload_hash: "harvest-payload",
  };
  setChainStateForTests(openTreasury());
  Deno.env.set("NAVE_COMPOUND_ENABLED", "true");
  try {
    const zero = await assessSignerPayload(input({ ...harvest, min_out: 0 }));
    assert.equal(zero.allow, false);
    const zeroFailures = failures(zero.record);
    assert.ok(zeroFailures.some((x) => x.includes("compound requires min_out > 0")), zeroFailures.join(" | "));
    assert.equal(zeroFailures.some((x) => x.includes("NAVE_COMPOUND_ENABLED is false")), false);

    // 50 bps floor of 100_000: amount * (10_000 - 50) / 10_000.
    const accepted = await assessSignerPayload(input({ ...harvest, min_out: 99_500 }));
    assert.equal(accepted.allow, true, failures(accepted.record).join(" | "));
    assert.equal(accepted.record.should_sign, true);
    assert.equal(failures(accepted.record).some((x) => x.includes("compound requires min_out > 0")), false);
  } finally {
    Deno.env.delete("NAVE_COMPOUND_ENABLED");
    setChainStateForTests(null);
  }
});

Deno.test("a withdraw that is not an auto_withdraw repair is refused", async () => {
  const v = await assessSignerPayload(input({ action: "withdraw_from_strategy", amount: 10, protocol_id: "kamino" }));
  assert.equal(v.allow, false);
  assert.ok(failures(v.record).some((x) => x.includes("withdraw requires purpose auto_withdraw")));
});

Deno.test("auto_withdraw is allowed on a compliant treasury when venue is approved and amount <= deployed", async () => {
  setChainStateForTests(openTreasury());
  Deno.env.set("NAVE_AUTO_WITHDRAW_ENABLED", "true");
  try {
    const ok = await assessSignerPayload(input({
      action: "withdraw_from_strategy",
      purpose: "auto_withdraw",
      amount: 500_000,
      protocol_id: "kamino",
      payload_hash: "withdraw-hash",
      expected_payload_hash: "withdraw-hash",
    }));
    assert.equal(ok.allow, true, failures(ok.record).join(" | "));

    const exceeds = await assessSignerPayload(input({
      action: "withdraw_from_strategy",
      purpose: "auto_withdraw",
      amount: 1_500_000,
      protocol_id: "kamino",
      payload_hash: "withdraw-hash",
      expected_payload_hash: "withdraw-hash",
    }));
    assert.equal(exceeds.allow, false);
    assert.ok(failures(exceeds.record).some((x) => x.includes("withdraw amount does not reduce deployed capital")));
  } finally {
    Deno.env.delete("NAVE_AUTO_WITHDRAW_ENABLED");
    setChainStateForTests(null);
  }
});

Deno.test("venue placement is only accepted on a venue deposit", async () => {
  const wrong = await assessSignerPayload(input({ action: "execute_strategy", purpose: "venue_placement" }));
  assert.equal(wrong.allow, false);
  assert.equal(wrong.reason, "venue_placement is only for venue deposits");
  const right = await assessSignerPayload(input({ action: "kamino_deposit", purpose: "venue_placement" }));
  assert.equal(right.allow, true);
  assert.equal(right.record.venue_placement, true);
});

Deno.test("venue recall is only accepted on a venue withdraw", async () => {
  const wrong = await assessSignerPayload(input({ action: "kamino_deposit", purpose: "venue_recall" }));
  assert.equal(wrong.allow, false);
  assert.equal(wrong.reason, "venue_recall is only for venue withdraws");
});

Deno.test("a bundle placement that does not follow its execute op is refused", async () => {
  const v = await assessSignerPayload(input({
    action: "bundle_rebalance",
    bundle_operations: [
      { action: "kamino_deposit", purpose: "venue_placement", protocol_id: "kamino", mint: "M" },
      { action: "execute_strategy", protocol_id: "kamino", mint: "M", amount: 5 },
    ],
  }));
  assert.equal(v.allow, false);
  assert.ok(failures(v.record).some((x) => x.includes("bundle op[0] venue placement must follow its execute_strategy op")));
});

Deno.test("clear_halt needs a readable open gate and a fresh constitution", async () => {
  const v = await assessSignerPayload(input({ action: "clear_halt", agent_role: "operational" }));
  assert.equal(v.allow, false);
  assert.match(v.reason, /agents_enabled|snapshot_freshness/);
});

Deno.test("a bundle op with an empty payload_hash falls through to expected_payload_hash", async () => {
  const bundle = (op: Record<string, unknown>) =>
    input({
      action: "bundle_rebalance",
      agent_role: "operational",
      bundle_operations: [
        { action: "execute_strategy", protocol_id: "kamino", mint: "M", amount: 5, confidence: 100, ...op },
        { action: "kamino_deposit", purpose: "venue_placement", protocol_id: "kamino", mint: "M", amount: 5 },
      ],
    });
  const hashFailure = (v: { record: Record<string, unknown> }) =>
    failures(v.record).find((x) => x.includes("payload_hash_equality"));
  setChainStateForTests(openTreasury());
  try {
    const empty = await assessSignerPayload(bundle({ payload_hash: "", expected_payload_hash: "0xabc" }));
    assert.equal(hashFailure(empty), undefined, failures(empty.record).join(" | "));

    // Control: with no hash anywhere the equality check still fails closed.
    const none = await assessSignerPayload(bundle({ payload_hash: "", expected_payload_hash: "" }));
    assert.ok(hashFailure(none)?.includes("expected payload hash unknown"), failures(none.record).join(" | "));
  } finally {
    setChainStateForTests(null);
  }
});
