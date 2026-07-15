import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ObserverError } from "../src/observer-error.mjs";
import { acquirePrivateLock } from "../src/private-state.mjs";
import {
  inspectSupervisorProcessLock,
  recoverSupervisorProcessLock,
  runSupervisorProcess,
} from "../src/supervisor-process.mjs";

const TARGET_ID = `p_${"a".repeat(64)}`;
const WATCH_ID = "w_11111111-1111-4111-8111-111111111111";
const CYCLE_ID = `c_${"b".repeat(64)}`;
const TARGET = { schema: "observer.project_target.v1", targetId: TARGET_ID, projectRoot: "/project" };
const CLIENT = { read: async () => assert.fail(), wait: async () => assert.fail() };
const ACTIVE = {
  schema: "observer.watch_status.v1",
  target_id: TARGET_ID,
  watch_id: WATCH_ID,
  project_root: TARGET.projectRoot,
  provider: "codex",
  status: "active",
};
const TEST_STATE_ROOT = await mkdtemp(join(tmpdir(), "observer-supervisor-process-"));
await mkdir(join(TEST_STATE_ROOT, "watches", TARGET_ID), { recursive: true, mode: 0o700 });
await chmod(TEST_STATE_ROOT, 0o700);
await chmod(join(TEST_STATE_ROOT, "watches"), 0o700);
await chmod(join(TEST_STATE_ROOT, "watches", TARGET_ID), 0o700);

function request(overrides = {}) {
  return {
    stateRoot: TEST_STATE_ROOT,
    target: TARGET,
    watchId: WATCH_ID,
    client: CLIENT,
    createProviderRuntime: async () => ({ providerRuntime: { provider: "codex" }, close: async () => {} }),
    pollIntervalMs: 100,
    ...overrides,
  };
}

function dependencies(overrides = {}) {
  let released = 0;
  return {
    value: {
      acquirePrivateLock: async () => async () => { released += 1; },
      readWatchStatus: async () => ACTIVE,
      ...overrides,
    },
    released: () => released,
  };
}

function step(status, cycleId = status === "timeout" || status === "provider_unavailable" ? null : CYCLE_ID) {
  return {
    schema: "observer.supervisor_production_result.v1",
    status,
    provider: "codex",
    cycle_id: cycleId,
  };
}

test("timeoutとcommittedは同じruntimeで次stepへ戻り、外部cancelでcleanに閉じる", async () => {
  const controller = new AbortController();
  let created = 0;
  let closed = 0;
  let calls = 0;
  const { value, released } = dependencies({
    runSupervisorProductionStep: async () => {
      calls += 1;
      if (calls === 1) return step("timeout");
      if (calls === 2) return step("committed");
      controller.abort();
      throw new ObserverError("E_THROUGHLINE_CANCELLED", "cancelled");
    },
  });
  const result = await runSupervisorProcess(request({
    signal: controller.signal,
    createProviderRuntime: async () => {
      created += 1;
      return { providerRuntime: { provider: "codex" }, close: async () => { closed += 1; } };
    },
  }), value);
  assert.deepEqual(result, {
    schema: "observer.supervisor_process_result.v1",
    status: "cancelled",
    provider: "codex",
    cycle_id: null,
  });
  assert.equal(calls, 3);
  assert.equal(created, 1);
  assert.equal(closed, 1);
  assert.equal(released(), 1);
});

test("model pendingはbounded poll後に同じoperation回収stepへ進む", async () => {
  let calls = 0;
  let polls = 0;
  const { value, released } = dependencies({
    runSupervisorProductionStep: async () => {
      calls += 1;
      return calls === 1 ? step("model_pending") : step("rollover_required");
    },
    waitForModelPoll: async (milliseconds, signal) => {
      assert.equal(milliseconds, 100);
      assert.equal(signal.aborted, false);
      polls += 1;
    },
  });
  const result = await runSupervisorProcess(request(), value);
  assert.deepEqual(result, {
    schema: "observer.supervisor_process_result.v1",
    status: "rollover_required",
    provider: "codex",
    cycle_id: CYCLE_ID,
  });
  assert.equal(calls, 2);
  assert.equal(polls, 1);
  assert.equal(released(), 1);
});

test("model result unknownは永久pollせずfaultとしてfail loudにする", async () => {
  let polls = 0;
  let closed = 0;
  const { value, released } = dependencies({
    runSupervisorProductionStep: async () => step("model_result_unknown"),
    waitForModelPoll: async () => { polls += 1; },
  });
  await assert.rejects(runSupervisorProcess(request({
    createProviderRuntime: async () => ({
      providerRuntime: { provider: "codex" },
      close: async () => { closed += 1; },
    }),
  }), value), { code: "E_SUPERVISOR_MODEL_RESULT_UNKNOWN" });
  assert.equal(polls, 0);
  assert.equal(closed, 1);
  assert.equal(released(), 1);
});

test("explicit watch stopは進行中waitを取消し、faultへ偽装しない", async () => {
  let reads = 0;
  const { value, released } = dependencies({
    readWatchStatus: async () => {
      reads += 1;
      return reads <= 2 ? ACTIVE : { ...ACTIVE, status: "stopping" };
    },
    waitForMonitorPoll: async (_milliseconds, signal) => !signal.aborted,
    runSupervisorProductionStep: async ({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new ObserverError("E_THROUGHLINE_CANCELLED", "cancelled")), { once: true });
    }),
  });
  const result = await runSupervisorProcess(request(), value);
  assert.deepEqual(result, {
    schema: "observer.supervisor_process_result.v1",
    status: "stopping",
    provider: "codex",
    cycle_id: null,
  });
  assert.equal(released(), 1);
});

test("watch identity変化はoperationを取消してfail loudにする", async () => {
  let reads = 0;
  const { value, released } = dependencies({
    readWatchStatus: async () => {
      reads += 1;
      return reads <= 2 ? ACTIVE : { ...ACTIVE, watch_id: "w_22222222-2222-4222-8222-222222222222" };
    },
    waitForMonitorPoll: async (_milliseconds, signal) => !signal.aborted,
    runSupervisorProductionStep: async ({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new ObserverError("E_THROUGHLINE_CANCELLED", "cancelled")), { once: true });
    }),
  });
  await assert.rejects(runSupervisorProcess(request(), value), { code: "E_SUPERVISOR_PROCESS_WATCH_CHANGED" });
  assert.equal(released(), 1);
});

test("target固有process lockはinspectしたnonceだけで明示回復する", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "observer-supervisor-process-lock-"));
  const targetRoot = join(stateRoot, "watches", TARGET_ID);
  await mkdir(targetRoot, { recursive: true, mode: 0o700 });
  await chmod(stateRoot, 0o700);
  await chmod(join(stateRoot, "watches"), 0o700);
  await chmod(targetRoot, 0o700);
  const lockPath = join(targetRoot, "supervisor-process.lock");
  await acquirePrivateLock(lockPath);
  const owner = await inspectSupervisorProcessLock({ stateRoot, targetId: TARGET_ID });
  assert.equal(typeof owner.nonce, "string");
  await assert.rejects(recoverSupervisorProcessLock({ stateRoot, targetId: TARGET_ID, expectedNonce: "wrong" }), {
    code: "E_LOCK_OWNERSHIP_MISMATCH",
  });
  assert.equal(await recoverSupervisorProcessLock({ stateRoot, targetId: TARGET_ID, expectedNonce: owner.nonce }), true);
  assert.equal(await inspectSupervisorProcessLock({ stateRoot, targetId: TARGET_ID }), null);
});
