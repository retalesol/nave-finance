import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_ORCHESTRATOR_SWEEP_MS,
  DEFAULT_POLICY_INTERVAL_MS,
  DEFAULT_PROPOSAL_INTERVAL_MS,
  DEFAULT_REVIEW_WAKE_REFRESH_MS,
  DEFAULT_SNAPSHOT_INTERVAL_MS,
} from "./workerCadence.js";

test("worker defaults match the review-window cadence", () => {
  assert.equal(DEFAULT_ORCHESTRATOR_SWEEP_MS, 15 * 60 * 1000);
  assert.equal(DEFAULT_SNAPSHOT_INTERVAL_MS, 15 * 60 * 1000);
  assert.equal(DEFAULT_POLICY_INTERVAL_MS, 60 * 60 * 1000);
  assert.equal(DEFAULT_PROPOSAL_INTERVAL_MS, 60 * 60 * 1000);
  assert.equal(DEFAULT_REVIEW_WAKE_REFRESH_MS, 15_000);
});
