// deno test --node-modules-dir=none --allow-env --allow-read --allow-net --no-check \
//   supabase/functions/_shared/constitutionVerdict.test.ts
// Runs offline: the GenLayer view is supplied and SOLANA_RPC_URL is unset, so
// no chain state can be read and every capital action must fail closed.

import assert from "node:assert/strict";
import { assessSignerPayload, type SignerVerdictInput } from "./constitutionVerdict.ts";

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

Deno.test("a withdraw that is not an auto_withdraw repair is refused", async () => {
  const v = await assessSignerPayload(input({ action: "withdraw_from_strategy", amount: 10, protocol_id: "kamino" }));
  assert.equal(v.allow, false);
  assert.ok(failures(v.record).some((x) => x.includes("withdraw requires purpose auto_withdraw")));
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
