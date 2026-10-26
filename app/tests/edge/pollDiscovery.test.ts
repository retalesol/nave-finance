import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  IN_ISOLATE_WAKE_MAX_MS,
  hasActiveAgentKey,
  planPollRpc,
  reviewWakesFromIndexedRows,
  selectDispatchableWork,
  shouldScheduleReviewWake,
  type AgentKeyIndex,
} from "../../supabase/functions/_shared/pollDiscovery.ts";

const IDLE = "0x00000000000000000000000000000000000000aa";
const BUSY = "0x00000000000000000000000000000000000000bb";
const NOW_MS = Date.parse("2026-10-23T18:00:00Z");
const NOW_SEC = Math.floor(NOW_MS / 1000);

const noKeys: AgentKeyIndex = { solana: new Set(), evm: new Set() };

test("idle DAO is not RPC-scanned", () => {
  const plan = planPollRpc({
    registryDaos: [{ dao: IDLE }, { dao: BUSY }],
    activity: [{
      dao_onchain_address: BUSY,
      event_type: "ExecutionRequestCreated",
      raw_data: { index: 4 },
      chain: "base",
      chain_id: 84532,
      created_at: "2026-10-23T17:00:00Z",
    }],
  });

  assert.deepEqual(plan.idleSkipped, [IDLE]);
  assert.equal(plan.evmTargets.length, 1);
  assert.equal(plan.evmTargets[0]?.dao, BUSY);
  assert.equal(plan.evmTargets[0]?.index, 4);
  assert.equal(plan.evmTargets[0]?.enumerate, false);
  assert.deepEqual(plan.evmTargets.filter((target) => target.enumerate), []);
  assert.deepEqual(plan.solanaEnumerate, []);
});

test("a registry with no indexed open requests is not enumerated", () => {
  const plan = planPollRpc({
    registryDaos: [{ dao: IDLE }, { dao: "SolIdleDao111" }],
    activity: [],
    actions: [],
  });
  assert.deepEqual(plan.evmTargets, []);
  assert.deepEqual(plan.solanaEnumerate, []);
  assert.deepEqual(plan.solanaRead, []);
  assert.deepEqual(plan.idleSkipped, [IDLE, "SolIdleDao111"]);
});

test("an indexed EVM hint with no index enumerates only that treasury", () => {
  const plan = planPollRpc({
    registryDaos: [{ dao: IDLE }, { dao: BUSY }],
    activity: [{
      dao_onchain_address: BUSY,
      event_type: "ExecutionRequestQueued",
      raw_data: { payloadHash: "0xabc" },
      chain: "base",
      chain_id: 84532,
      created_at: "2026-10-23T17:00:00Z",
    }],
  });
  assert.deepEqual(plan.idleSkipped, [IDLE]);
  assert.equal(plan.evmTargets.length, 1);
  assert.equal(plan.evmTargets[0]?.enumerate, true);
  assert.equal(plan.evmTargets[0]?.dao, BUSY);
  assert.equal(plan.evmTargets[0]?.index, null);
});

test("an expired indexed request is not scanned", () => {
  const plan = planPollRpc({
    registryDaos: [{ dao: BUSY }],
    activity: [
      {
        dao_onchain_address: BUSY,
        event_type: "ExecutionRequestCreated",
        raw_data: { index: 1 },
        chain: "base",
        chain_id: 84532,
        created_at: "2026-10-23T17:00:00Z",
      },
      {
        dao_onchain_address: BUSY,
        event_type: "ExecutionExpired",
        raw_data: { index: 1 },
        chain: "base",
        chain_id: 84532,
        created_at: "2026-10-23T17:05:00Z",
      },
    ],
  });
  assert.deepEqual(plan.evmTargets, []);
  assert.deepEqual(plan.idleSkipped, [BUSY]);
});

test("a known Solana execution request is read and not program-scanned", () => {
  const plan = planPollRpc({
    activity: [{
      dao_onchain_address: "SolDao111",
      event_type: "ExecutionRequestCreated",
      raw_data: { execution_request: "ErAddress111" },
      chain: "solana",
      created_at: "2026-10-23T17:00:00Z",
    }],
  });
  assert.deepEqual(plan.solanaRead, [{ dao: "SolDao111", executionRequest: "ErAddress111" }]);
  assert.deepEqual(plan.solanaEnumerate, []);
});

test("a Solana queued event with no address enumerates only that DAO", () => {
  const plan = planPollRpc({
    registryDaos: [{ dao: "SolIdle" }, { dao: "SolDao111" }],
    activity: [{
      dao_onchain_address: "SolDao111",
      event_type: "ExecutionRequestQueued",
      raw_data: { proposal: "prop1" },
      chain: "solana",
      created_at: "2026-10-23T17:00:00Z",
    }],
  });
  assert.deepEqual(plan.solanaEnumerate, ["SolDao111"]);
  assert.deepEqual(plan.solanaRead, []);
  assert.deepEqual(plan.idleSkipped, ["SolIdle"]);
});

test("no dispatcher call without a key, and missing keys do not consume the cap", () => {
  const items = [
    ...Array.from({ length: 30 }, (_, i) => ({
      id: `parked-${i}`,
      dao: "NoKeyDao",
      chainId: null as number | null,
      status: "Pending",
    })),
    { id: "keyed", dao: "KeyedDao", chainId: null as number | null, status: "Pending" },
    { id: "evm-open", dao: BUSY, chainId: 84532, status: "InReview" },
    { id: "executed", dao: "NoKeyDao", chainId: null as number | null, status: "Executed" },
  ];
  const keys: AgentKeyIndex = {
    solana: new Set(["KeyedDao:executive"]),
    evm: new Set(),
  };
  const selected = selectDispatchableWork(
    items,
    (item) => hasActiveAgentKey(item, keys),
    25,
  );
  assert.deepEqual(selected.dispatch.map((item) => item.id), ["keyed", "executed"]);
  assert.equal(selected.parkedMissingKey.some((item) => item.id === "evm-open"), true);
  assert.equal(selected.parkedMissingKey.length, 31);
  assert.equal(selected.capped, 0);

  const wrongChain = hasActiveAgentKey(
    { dao: BUSY, chainId: 1, status: "InReview" },
    { solana: new Set(), evm: new Set([`${BUSY}:84532:operational`]) },
  );
  const rightChain = hasActiveAgentKey(
    { dao: BUSY, chainId: 84532, status: "InReview" },
    { solana: new Set(), evm: new Set([`${BUSY}:84532:operational`]) },
  );
  assert.equal(wrongChain, false);
  assert.equal(rightChain, true);
  assert.equal(hasActiveAgentKey({ dao: "NoKeyDao", chainId: null, status: "Pending" }, noKeys), false);
});

test("keyed work is still capped at the dispatcher limit", () => {
  const items = Array.from({ length: 30 }, (_, i) => ({
    id: String(i),
    dao: "KeyedDao",
    chainId: null as number | null,
    status: "Pending",
  }));
  const keys: AgentKeyIndex = { solana: new Set(["KeyedDao:executive"]), evm: new Set() };
  const selected = selectDispatchableWork(items, (item) => hasActiveAgentKey(item, keys), 25);
  assert.equal(selected.dispatch.length, 25);
  assert.equal(selected.capped, 5);
  assert.equal(selected.parkedMissingKey.length, 0);
});

test("a 60s review window is armed and a 24h window is not", () => {
  assert.equal(shouldScheduleReviewWake(NOW_SEC + 60, NOW_MS), "schedule");
  assert.equal(
    shouldScheduleReviewWake(NOW_SEC + 60, NOW_MS, { horizonMs: IN_ISOLATE_WAKE_MAX_MS }),
    "schedule",
  );
  assert.equal(shouldScheduleReviewWake(NOW_SEC + 24 * 60 * 60, NOW_MS), "skip");
  assert.equal(shouldScheduleReviewWake(NOW_SEC + 10 * 60, NOW_MS), "schedule");
  assert.equal(
    shouldScheduleReviewWake(NOW_SEC + 10 * 60, NOW_MS, { horizonMs: IN_ISOLATE_WAKE_MAX_MS }),
    "skip",
  );
  assert.equal(shouldScheduleReviewWake(NOW_SEC - 30, NOW_MS), "fire_now");
  assert.equal(shouldScheduleReviewWake(NOW_SEC - 10 * 60, NOW_MS), "skip");
});

test("indexed oversight rows schedule a review-end wake without an idle DAO", () => {
  const wakes = reviewWakesFromIndexedRows([
    {
      dao_onchain_address: BUSY,
      event_type: "OversightApprovedEvent",
      raw_data: { index: "7", reviewEnd: String(NOW_SEC + 60) },
      created_at: "2026-10-23T17:59:00Z",
    },
    {
      dao_onchain_address: IDLE,
      event_type: "OversightApprovedEvent",
      raw_data: { index: "1", reviewEnd: String(NOW_SEC + 24 * 60 * 60) },
      created_at: "2026-10-23T17:00:00Z",
    },
  ], NOW_MS);
  assert.deepEqual(wakes, [{
    dao_address: BUSY,
    execution_request_address: "7",
    review_end: NOW_SEC + 60,
  }]);
});

test("a treasury with no active key produces zero dispatcher calls across two sweep intervals", () => {
  const treasury = "0x00000000000000000000000000000000000000cc";
  const keys = { solana: new Set(), evm: new Set() };
  let dispatcherCalls = 0;
  for (let sweep = 0; sweep < 2; sweep++) {
    const now = NOW_MS + sweep * 15 * 60 * 1000;
    const plan = planPollRpc({
      registryDaos: [{ dao: treasury, chainId: 11155111 }, { dao: IDLE }],
      activity: [{
        dao_onchain_address: treasury,
        event_type: "ExecutionRequestCreated",
        raw_data: { index: 1 },
        chain: "ethereum",
        chain_id: 11155111,
        created_at: new Date(now - 60_000).toISOString(),
      }],
    });
    assert.equal(plan.evmTargets.length, 1);
    assert.equal(plan.evmTargets[0]?.enumerate, false);
    assert.equal(plan.idleSkipped.includes(IDLE), true);
    const selected = selectDispatchableWork(
      [{ dao: treasury, chainId: 11155111, status: "Pending" }],
      (item) => hasActiveAgentKey(item, keys),
      25,
    );
    dispatcherCalls += selected.dispatch.length;
    assert.equal(selected.parkedMissingKey.length, 1);
    assert.equal(selected.dispatch.length, 0);
  }
  assert.equal(dispatcherCalls, 0);

  const keyed = selectDispatchableWork(
    [{ dao: treasury, chainId: 11155111, status: "Pending" }],
    (item) => hasActiveAgentKey(item, {
      solana: new Set(),
      evm: new Set([`${treasury}:11155111:executive`]),
    }),
    25,
  );
  assert.deepEqual(keyed.dispatch, [{ dao: treasury, chainId: 11155111, status: "Pending" }]);
  assert.equal(keyed.parkedMissingKey.length, 0);
});

test("orchestrator poll does not scan the EVM registry and gates dispatcher calls", () => {
  const src = readFileSync(
    new URL("../../supabase/functions/agent-orchestrator/index.ts", import.meta.url),
    "utf8",
  );
  assert.equal(src.includes('.in("chain", ["ethereum", "base", "robinhood", "arc"])'), false);
  assert.match(src, /target\.enumerate/);
  assert.match(src, /hasActiveAgentKey/);
  assert.match(src, /selectDispatchableWork/);
  assert.match(src, /encrypted_agent_keys/);
  assert.match(src, /encrypted_evm_keys/);
  assert.match(src, /\.eq\("is_active", true\)/);
});
