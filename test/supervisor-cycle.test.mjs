import assert from "node:assert/strict";
import test from "node:test";

import { cycleIdFor } from "../src/cycle-store.mjs";
import { runSupervisorCycle } from "../src/supervisor-cycle.mjs";

const TARGET = { schema: "observer.project_target.v1", targetId: `p_${"a".repeat(64)}`, projectRoot: "/project" };
const WATCH_ID = "w_11111111-1111-4111-8111-111111111111";
const THREAD = "b".repeat(64);
const CURRENT = parent("tlc1.after");
const RESULT = { schema: "observer.cycle_result.v1", result_digest: "d".repeat(64) };
const INPUT = { schema: "observer.cycle_input.v1", input_digest: `sha256:${"e".repeat(64)}`, model_visible_bytes: 42, value: { prompt: "ephemeral-only" } };
async function inputBuilder() { return structuredClone(INPUT); }

function parent(cursor) {
  return { schema: "observer.parent_state.v1", target_id: TARGET.targetId, project_root: TARGET.projectRoot, status: "ready", host: "claude", thread_sha256: THREAD, cursor };
}

function read({ status = "delta", afterCursor = CURRENT.cursor, throughCursor = "tlc1.through", turns = [], complete = true, nextToken = null } = {}) {
  return { schema: "throughline.observer_read.v1", status, afterCursor, throughCursor, host: "claude", thread_sha256: THREAD, turns, historyTruncated: false, page: { complete, nextToken } };
}

function wait(status, throughCursor) {
  return { schema: "throughline.observer_wait.v1", status, afterCursor: CURRENT.cursor, throughCursor };
}

function pending({ status = "prepared", proposed = parent("tlc1.fixed"), baseCursor = CURRENT.cursor, resultDigest = null } = {}) {
  return { status, cycle_id: cycleIdFor(TARGET.targetId, baseCursor, proposed.cursor), watch_id: WATCH_ID, base_cursor: baseCursor, proposed_state: proposed, result_digest: resultDigest };
}

function fakeStore({ committed = CURRENT, pendingCycle = null } = {}) {
  const calls = [];
  return {
    calls,
    async readCycleState() { calls.push("read"); return { committed_state: committed, pending_cycle: pendingCycle }; },
    async prepareCycle(input) { calls.push(["prepare", input]); return pending({ proposed: input.proposedState, baseCursor: input.baseState?.cursor ?? null }); },
    async reserveGenerationInput(input) { calls.push(["reserve", input]); return { outcome: "reserved", reservation: "created" }; },
    async markCycleProcessed(input) { calls.push(["processed", input]); },
    async commitProcessedCycle(input) { calls.push(["commit", input]); return pendingCycle?.proposed_state ?? calls.find((item) => Array.isArray(item) && item[0] === "prepare")[1].proposedState; },
  };
}

test("supervisor prepares, processes durably, then marks and commits a normal changed cycle", async () => {
  const store = fakeStore();
  let callback;
  const result = await runSupervisorCycle({ stateRoot: "/state", target: TARGET, watchId: WATCH_ID, store, client: {
    wait: async () => wait("changed", "tlc1.fixed"),
    read: async () => read({ throughCursor: "tlc1.fixed", turns: [{ n: 1 }] }),
  }, prepareCycleInput: inputBuilder, processCycle: async (input) => { callback = input; return RESULT; } });
  assert.equal(result.status, "committed");
  assert.equal(result.proposed_state.cursor, "tlc1.fixed");
  assert.equal(callback.cycle_id, cycleIdFor(TARGET.targetId, CURRENT.cursor, "tlc1.fixed"));
  assert.deepEqual(callback.turns, [{ n: 1 }]);
  assert.deepEqual(callback.input, { schema: INPUT.schema, input_digest: INPUT.input_digest, model_visible_bytes: INPUT.model_visible_bytes });
  assert.deepEqual(callback.value, INPUT.value);
  assert.equal("value" in callback.input, false);
  assert.deepEqual(store.calls.map((item) => Array.isArray(item) ? item[0] : item), ["read", "prepare", "reserve", "processed", "commit"]);
});

test("processed recovery commits without replaying or re-running the callback", async () => {
  const recovery = pending({ status: "processed", resultDigest: RESULT.result_digest });
  const store = fakeStore({ pendingCycle: recovery });
  const result = await runSupervisorCycle({ stateRoot: "/state", target: TARGET, watchId: WATCH_ID, store, client: {
    wait: async () => assert.fail("processed recovery must not wait"), read: async () => assert.fail("processed recovery must not read"),
  }, prepareCycleInput: inputBuilder, processCycle: async () => assert.fail("processed recovery must not process") });
  assert.equal(result.status, "committed");
  assert.deepEqual(store.calls, ["read", ["commit", { stateRoot: "/state", targetId: TARGET.targetId, watchId: WATCH_ID, cycleId: recovery.cycle_id }]]);
});

test("prepared recoveryはfixed cursorを再構築し、新規reservation時だけprocessする", async () => {
  const recovery = pending();
  const store = fakeStore({ pendingCycle: recovery });
  let processed = 0;
  const result = await runSupervisorCycle({ stateRoot: "/state", target: TARGET, watchId: WATCH_ID, store, client: {
    wait: async () => assert.fail("prepared recovery must not wait"), read: async (input) => { assert.equal(input.throughCursor, "tlc1.fixed"); return read({ throughCursor: "tlc1.fixed" }); },
  }, prepareCycleInput: inputBuilder, processCycle: async () => { processed++; return RESULT; } });
  assert.equal(result.status, "committed");
  assert.equal(processed, 1);
  assert.deepEqual(store.calls.map((item) => Array.isArray(item) ? item[0] : item), ["read", "reserve", "processed", "commit"]);
});

test("projection pending retries without store mutation and timeout remains normal without a journal", async () => {
  const store = fakeStore({ committed: null });
  let reads = 0;
  const result = await runSupervisorCycle({ stateRoot: "/state", target: TARGET, watchId: WATCH_ID, store, projectionRetries: 1, client: {
    wait: async () => assert.fail("orientation must not wait"),
    read: async () => {
      reads++;
      return reads === 1
        ? { ...read({ status: "projection_pending", afterCursor: null, throughCursor: null }), host: null, thread_sha256: null, page: { complete: false, nextToken: null } }
        : { ...read({ status: "snapshot", afterCursor: null, throughCursor: "tlc1.orientation" }), host: null, thread_sha256: null };
    },
  }, prepareCycleInput: inputBuilder, processCycle: async () => RESULT });
  assert.equal(reads, 2);
  assert.equal(result.status, "committed");
  assert.deepEqual(store.calls.map((item) => Array.isArray(item) ? item[0] : item), ["read", "prepare", "reserve", "processed", "commit"]);

  const timeoutStore = fakeStore();
  const timeout = await runSupervisorCycle({ stateRoot: "/state", target: TARGET, watchId: WATCH_ID, store: timeoutStore, client: {
    wait: async () => wait("timeout", CURRENT.cursor), read: async () => assert.fail("timeout must not read"),
  }, prepareCycleInput: inputBuilder, processCycle: async () => assert.fail("timeout must not process") });
  assert.deepEqual(timeout, { status: "timeout", proposed_state: CURRENT, turns: [] });
  assert.deepEqual(timeoutStore.calls, ["read"]);
});

test("changed projection retry replays the first fixed through cursor without a second wait", async () => {
  const store = fakeStore();
  let waits = 0;
  let reads = 0;
  const result = await runSupervisorCycle({ stateRoot: "/state", target: TARGET, watchId: WATCH_ID, store, projectionRetries: 1, client: {
    wait: async () => {
      waits++;
      assert.equal(waits, 1, "projection retry must not start another wait");
      return wait("changed", "tlc1.first-fixed");
    },
    read: async (input) => {
      reads++;
      assert.equal(input.throughCursor, "tlc1.first-fixed");
      return reads === 1
        ? read({ status: "projection_pending", throughCursor: null, turns: [] })
        : read({ status: "delta", throughCursor: "tlc1.first-fixed", turns: [{ recovered: true }] });
    },
  }, prepareCycleInput: inputBuilder, processCycle: async () => RESULT });
  assert.equal(result.proposed_state.cursor, "tlc1.first-fixed");
  assert.equal(waits, 1);
  assert.equal(reads, 2);
});

test("invalid durable callback result never marks processed or commits", async () => {
  const store = fakeStore();
  await assert.rejects(runSupervisorCycle({ stateRoot: "/state", target: TARGET, watchId: WATCH_ID, store, client: {
    wait: async () => wait("changed", "tlc1.fixed"), read: async () => read({ throughCursor: "tlc1.fixed" }),
  }, prepareCycleInput: inputBuilder, processCycle: async () => ({ schema: "observer.cycle_result.v1", result_digest: "not-a-digest" }) }), { code: "E_CYCLE_RESULT_INVALID" });
  assert.deepEqual(store.calls.map((item) => Array.isArray(item) ? item[0] : item), ["read", "prepare", "reserve"]);
});

test("existing reservationはmodel callbackを再送せず、rolloverもpendingをpreparedのまま残す", async () => {
  for (const reservation of ["existing", "rollover"]) {
    const store = fakeStore();
    store.reserveGenerationInput = async (input) => {
      store.calls.push(["reserve", input]);
      return reservation === "existing" ? { outcome: "reserved", reservation: "existing" } : { outcome: "planned_rollover" };
    };
    const result = await runSupervisorCycle({ stateRoot: "/state", target: TARGET, watchId: WATCH_ID, store, client: {
      wait: async () => wait("changed", "tlc1.fixed"), read: async () => read({ throughCursor: "tlc1.fixed" }),
    }, prepareCycleInput: inputBuilder, processCycle: async () => assert.fail("non-created reservation must not process") });
    assert.equal(result.status, reservation === "existing" ? "model_result_unknown" : "rollover_required");
    assert.deepEqual(store.calls.map((item) => Array.isArray(item) ? item[0] : item), ["read", "prepare", "reserve"]);
  }
});

test("oversized inputはvalidatorで拒否せずgeneration reservationへ渡す", async () => {
  const store = fakeStore(); let reserved = false;
  store.reserveGenerationInput = async (input) => { reserved = input.modelVisibleBytes === 262145; throw Object.assign(new Error("large"), { code: "E_GENERATION_INPUT_TOO_LARGE" }); };
  const oversized = async () => ({ ...INPUT, model_visible_bytes: 262145 });
  await assert.rejects(runSupervisorCycle({ stateRoot: "/state", target: TARGET, watchId: WATCH_ID, store, client: { wait: async () => wait("changed", "tlc1.fixed"), read: async () => read({ throughCursor: "tlc1.fixed" }) }, prepareCycleInput: oversized, processCycle: async () => assert.fail("oversized input must not process") }), { code: "E_GENERATION_INPUT_TOO_LARGE" });
  assert.equal(reserved, true);
});
