import test from "node:test";
import assert from "node:assert/strict";
import {
  HALTED_SYSTEM_PROMPT_NOTE,
  haltedRequestNotice,
  isHaltedStatus,
} from "../../supabase/functions/_shared/haltPrompt.ts";

test("only the Halted status gets the notice", () => {
  for (const s of ["InReview", "Pending", "OversightApproved", "", undefined, null]) {
    assert.equal(haltedRequestNotice(s), "");
  }
  assert.equal(isHaltedStatus("Halted"), true);
  assert.equal(isHaltedStatus(" halted "), true);
  assert.equal(isHaltedStatus("Executed"), false);
});

test("the Halted notice says plainly what clear_halt requires", () => {
  const text = haltedRequestNotice("Halted", ["nav_freshness: stale", " "]);
  assert.match(text, /currently HALTED on chain/);
  assert.match(text, /whether the halt is still warranted/);
  assert.match(text, /"clear_halt" with should_clear_halt true only when every guardrail passes and no halt cause remains/);
  assert.match(text, /"continue" or "request_review"/);
  assert.match(text, /nav_freshness: stale/);
});

test("the notice states when no halt causes were recorded", () => {
  assert.match(haltedRequestNotice("Halted", null), /No deterministic halt causes were recorded/);
});

test("the notice does not touch thresholds or guardrails", () => {
  const all = haltedRequestNotice("Halted") + HALTED_SYSTEM_PROMPT_NOTE;
  assert.doesNotMatch(all, /lower|relax|loosen|ignore the guardrail/i);
});
