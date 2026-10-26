import test from "node:test";
import assert from "node:assert/strict";
import {
  isKeyMissFailure,
  redispatchWaitSecs,
  waitsOnlyForRefresh,
  REDISPATCH_COOLDOWN_SECS,
  REFRESH_RETRY_SECS,
} from "../../supabase/functions/_shared/redispatchCooldown.ts";

const NOW = Date.parse("2026-10-17T13:00:00Z");
const ago = (secs: number) => new Date(NOW - secs * 1000).toISOString();
const wait = (
  last: Parameters<typeof redispatchWaitSecs>[0]["last"],
  requestStatus = "InReview",
  role = "operational",
) => redispatchWaitSecs({ last, requestStatus, role, nowMs: NOW });

test("constants match the orchestrator defaults", () => {
  assert.equal(REDISPATCH_COOLDOWN_SECS, 21600);
  assert.equal(REFRESH_RETRY_SECS, 600);
});

test("waitsOnlyForRefresh is true only when every failure is refreshable", () => {
  assert.equal(waitsOnlyForRefresh("nav_freshness: stale; snapshot_freshness: old"), true);
  assert.equal(waitsOnlyForRefresh("nav_freshness: stale; max_allocation: too big"), false);
  assert.equal(waitsOnlyForRefresh(""), false);
});

test("no prior row means no wait", () => {
  assert.equal(wait(undefined), 0);
});

test("a block, review, or reject waits the full cooldown", () => {
  assert.equal(wait({ status: "guardrail_blocked", error_message: "max_allocation: x", created_at: ago(60) }), 21600 - 60);
  assert.equal(wait({ decision: "request_review", status: "completed", created_at: ago(60) }), 21600 - 60);
  assert.equal(wait({ decision: "reject", status: "completed", created_at: ago(21600 + 1) }), 0);
});

test("a refresh-only block waits only the refresh retry", () => {
  const last = { status: "guardrail_blocked", error_message: "nav_freshness: stale", created_at: ago(100) };
  assert.equal(wait(last), 500);
  assert.equal(wait({ ...last, created_at: ago(601) }), 0);
});

test("a failed execute waits the refresh retry only", () => {
  const last = { decision: "execute", status: "failed", error_message: "payload_hash_equality: expected payload hash unknown", created_at: ago(120) };
  assert.equal(wait(last), 480);
  assert.equal(wait({ ...last, created_at: ago(700) }), 0);
});

test("a failed model call waits the refresh retry", () => {
  assert.equal(wait({ status: "error", error_message: "429", created_at: ago(30) }), 570);
});

test("a key-not-found failure waits the full cooldown, not the refresh retry", () => {
  const last = {
    status: "failed",
    error_message: "Agent key not found or inactive",
    created_at: ago(100),
  };
  assert.equal(isKeyMissFailure(last.error_message), true);
  assert.equal(waitsOnlyForRefresh(last.error_message), false);
  assert.equal(wait(last), 21600 - 100);
  assert.equal(wait({ ...last, created_at: ago(700) }), 21600 - 700);
  assert.equal(wait({ status: "failed", error_message: "Agent key not found", created_at: ago(60) }), 21600 - 60);
});

test("an inactive-key failure waits the full cooldown", () => {
  assert.equal(wait({ status: "error", error_message: "inactive key", created_at: ago(30) }), 21600 - 30);
  assert.equal(wait({ status: "failed", error_message: "inactive-key", created_at: ago(30) }), 21600 - 30);
  assert.equal(isKeyMissFailure("payload_hash_equality: expected payload hash unknown"), false);
});

test("a ready InReview request is not starved by a completed continue", () => {
  assert.equal(wait({ decision: "continue", status: "completed", created_at: ago(1) }, "InReview"), 0);
});

test("a Halted request whose last Oversight answer was not clear_halt waits the full cooldown", () => {
  assert.equal(wait({ decision: "continue", status: "completed", created_at: ago(120) }, "Halted"), 21600 - 120);
  assert.equal(wait({ decision: "continue", status: "completed", created_at: ago(21601) }, "Halted"), 0);
});

test("a Halted request after a clear_halt answer may run immediately", () => {
  assert.equal(wait({ decision: "clear_halt", status: "completed", created_at: ago(5) }, "Halted"), 0);
});

test("a failed clear_halt on a Halted request retries after the refresh window", () => {
  assert.equal(wait({ decision: "clear_halt", status: "failed", created_at: ago(100) }, "Halted"), 500);
});

test("the Halted wait applies to the operational role only", () => {
  assert.equal(wait({ decision: "continue", status: "completed", created_at: ago(5) }, "Halted", "oversight"), 0);
});

test("a cooldown of 0 turns every wait off", () => {
  assert.equal(
    redispatchWaitSecs({
      last: { status: "failed", created_at: ago(1) },
      requestStatus: "Halted",
      role: "operational",
      nowMs: NOW,
      cooldownSecs: 0,
    }),
    0,
  );
});
