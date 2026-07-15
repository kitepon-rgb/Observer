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
const OLD_PARENT_EPOCH = `sha256:${"1".repeat(64)}`;
const NEW_PARENT_EPOCH = `sha256:${"2".repeat(64)}`;
const OLD_GENERATION_ID = `sha256:${"3".repeat(64)}`;
const NEW_GENERATION_ID = `sha256:${"4".repeat(64)}`;
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
const ACTIVE_GENERATION = {
  schema: "observer.generation_state.v1",
  target_id: TARGET_ID,
  watch_id: WATCH_ID,
  provider: "codex",
  status: "active",
};
const TEST_STATE_ROOT = await mkdtemp(join(tmpdir(), "observer-supervisor-process-"));
await mkdir(join(TEST_STATE_ROOT, "watches", TARGET_ID), { recursive: true, mode: 0o700 });
await chmod(TEST_STATE_ROOT, 0o700);
await chmod(join(TEST_STATE_ROOT, "watches"), 0o700);
await chmod(join(TEST_STATE_ROOT, "watches", TARGET_ID), 0o700);

function request(overrides = {}) {
  const providerController = new AbortController();
  return {
    stateRoot: TEST_STATE_ROOT,
    target: TARGET,
    watchId: WATCH_ID,
    client: CLIENT,
    createProviderRuntime: async () => ({
      providerRuntime: { provider: "codex" },
      providerSignal: providerController.signal,
      prepareGenerationParentRebind: async () => assert.fail("rebind prepareは呼ばれない"),
      advanceGenerationParentRebind: async () => assert.fail("rebind callbackは呼ばれない"),
      advanceGenerationRollover: async () => assert.fail("rollover callbackは呼ばれない"),
      close: async () => {},
    }),
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
      readGenerationState: async () => ACTIVE_GENERATION,
      readGenerationHostRolloverStatus: async () => null,
      readGenerationParentRebindStatus: async () => null,
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

function parentRebindJournal(status, from = "codex", to = "codex") {
  const actions = {
    rebind_required: "authorize_stop",
    stop_authorized: "observe_terminal",
    terminal_observed: "authorize_start",
    spawn_authorized: "recover_spawn",
    spawn_observed: "recover_ready",
    ready_observed: "finish_activation",
  };
  return {
    schema: "observer.generation_parent_rebind_status.v1",
    target_id: TARGET_ID,
    watch_id: WATCH_ID,
    from_provider: from,
    to_provider: to,
    from_parent_epoch_id: OLD_PARENT_EPOCH,
    to_parent_epoch_id: NEW_PARENT_EPOCH,
    from_generation_id: OLD_GENERATION_ID,
    to_generation_id: ["spawn_authorized", "spawn_observed", "ready_observed"].includes(status)
      ? NEW_GENERATION_ID
      : null,
    status,
    action: actions[status],
  };
}

function parentRebindResult(outcome, phase, from = "codex", to = "codex", reason = "transition_recorded") {
  return {
    schema: "observer.generation_parent_rebind_provider_binding_result.v1",
    provider: { from, to },
    target_id: TARGET_ID,
    watch_id: WATCH_ID,
    phase,
    outcome,
    reason,
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
      return {
        providerRuntime: { provider: "codex" },
        providerSignal: new AbortController().signal,
        prepareGenerationParentRebind: async () => assert.fail("rebind prepareは呼ばれない"),
        advanceGenerationParentRebind: async () => assert.fail("rebind callbackは呼ばれない"),
        advanceGenerationRollover: async () => assert.fail("rollover callbackは呼ばれない"),
        close: async () => { closed += 1; },
      };
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

test("model pending後のplanned rolloverは同じruntimeで回収しprepared cycleへ戻る", async () => {
  const controller = new AbortController();
  let calls = 0;
  let modelPolls = 0;
  let rolloverPolls = 0;
  let rolloverCalls = 0;
  let generation = ACTIVE_GENERATION;
  let journal = null;
  const { value, released } = dependencies({
    runSupervisorProductionStep: async () => {
      calls += 1;
      if (calls === 1) return step("model_pending");
      if (calls === 2) {
        generation = { ...ACTIVE_GENERATION, status: "rollover_requested" };
        return step("rollover_required");
      }
      controller.abort();
      throw new ObserverError("E_THROUGHLINE_CANCELLED", "cancelled");
    },
    waitForModelPoll: async (milliseconds, signal) => {
      assert.equal(milliseconds, 100);
      assert.equal(signal.aborted, false);
      modelPolls += 1;
    },
    waitForRolloverPoll: async () => { rolloverPolls += 1; },
    readGenerationState: async () => generation,
    readGenerationHostRolloverStatus: async () => journal,
  });
  const result = await runSupervisorProcess(request({
    signal: controller.signal,
    createProviderRuntime: async () => ({
      providerRuntime: { provider: "codex" },
      providerSignal: new AbortController().signal,
      prepareGenerationParentRebind: async () => assert.fail("rebind prepareは呼ばれない"),
      advanceGenerationParentRebind: async () => assert.fail("rebind callbackは呼ばれない"),
      advanceGenerationRollover: async () => {
        rolloverCalls += 1;
        journal = {
          schema: "observer.generation_host_rollover_status.v1",
          target_id: TARGET_ID,
          watch_id: WATCH_ID,
          provider: "codex",
          status: rolloverCalls === 1 ? "stop_authorized" : "spawn_observed",
        };
        if (rolloverCalls === 1) return rollover("progressed", "stop_authorized", "stop_issued");
        if (rolloverCalls === 2) return rollover("pending", "stop_authorized", "terminal_not_observed");
        generation = ACTIVE_GENERATION;
        journal = null;
        return rollover("activated", "spawn_observed", "provider_ready_recovered");
      },
      close: async () => {},
    }),
  }), value);
  assert.deepEqual(result, {
    schema: "observer.supervisor_process_result.v1",
    status: "cancelled",
    provider: "codex",
    cycle_id: null,
  });
  assert.equal(calls, 3);
  assert.equal(modelPolls, 1);
  assert.equal(rolloverPolls, 1);
  assert.equal(rolloverCalls, 3);
  assert.equal(released(), 1);
});

test("parent rebindは同じleaseでprogressed／pending／activatedを進めprepared cycleへ戻る", async () => {
  const controller = new AbortController();
  const proposedParent = { host: "claude", marker: "prepared-parent" };
  let watch = ACTIVE;
  let generation = {
    ...ACTIVE_GENERATION,
    generation_id: OLD_GENERATION_ID,
    parent_epoch_id: OLD_PARENT_EPOCH,
  };
  let journal = null;
  let productionCalls = 0;
  let prepareCalls = 0;
  let rebindCalls = 0;
  let rebindPolls = 0;
  let owned;
  const { value } = dependencies({
    readWatchStatus: async () => watch,
    readGenerationState: async () => generation,
    readGenerationParentRebindStatus: async () => journal,
    waitForRebindPoll: async () => { rebindPolls += 1; },
    runSupervisorProductionStep: async (input) => {
      productionCalls += 1;
      if (productionCalls === 1) {
        await input.prepareGenerationParentRebind({ cycleId: CYCLE_ID, proposedParent });
        return step("rebind_required");
      }
      assert.equal(input.providerRuntime.provider, "claude");
      controller.abort();
      throw new ObserverError("E_THROUGHLINE_CANCELLED", "cancelled");
    },
  });
  const result = await runSupervisorProcess(request({
    signal: controller.signal,
    createProviderRuntime: async () => {
      owned = {
        providerRuntime: { provider: "codex" },
        providerSignal: new AbortController().signal,
        prepareGenerationParentRebind: async (input) => {
          prepareCalls += 1;
          assert.deepEqual(input, { cycleId: CYCLE_ID, proposedParent });
          journal = parentRebindJournal("rebind_required", "codex", "claude");
          generation = { ...generation, status: "rebind_required" };
          return { marker: "recorded" };
        },
        advanceGenerationParentRebind: async () => {
          rebindCalls += 1;
          if (rebindCalls === 1) {
            journal = parentRebindJournal("stop_authorized", "codex", "claude");
            generation = { ...generation, status: "stopping" };
            return parentRebindResult("progressed", "stop_authorized", "codex", "claude");
          }
          if (rebindCalls === 2) {
            return parentRebindResult("pending", "stop_authorized", "codex", "claude", "terminal_not_observed");
          }
          generation = {
            ...generation,
            status: "active",
            provider: "claude",
            generation_id: NEW_GENERATION_ID,
            parent_epoch_id: NEW_PARENT_EPOCH,
          };
          watch = { ...watch, provider: "claude" };
          owned.providerRuntime = { provider: "claude" };
          journal = null;
          return parentRebindResult("activated", "active", "codex", "claude", "provider_ready_recovered");
        },
        advanceGenerationRollover: async () => assert.fail("planned rolloverは呼ばれない"),
        close: async () => {},
      };
      return owned;
    },
  }), value);
  assert.deepEqual(result, {
    schema: "observer.supervisor_process_result.v1",
    status: "cancelled",
    provider: "claude",
    cycle_id: null,
  });
  assert.equal(productionCalls, 2);
  assert.equal(prepareCalls, 1);
  assert.equal(rebindCalls, 3);
  assert.equal(rebindPolls, 1);
});

test("process restartはparent rebind journalをproduction stepより先に回収する", async () => {
  const controller = new AbortController();
  const order = [];
  let generation = {
    ...ACTIVE_GENERATION,
    status: "stopping",
    generation_id: OLD_GENERATION_ID,
    parent_epoch_id: OLD_PARENT_EPOCH,
  };
  let journal = parentRebindJournal("stop_authorized");
  const { value } = dependencies({
    readGenerationState: async () => generation,
    readGenerationParentRebindStatus: async () => journal,
    runSupervisorProductionStep: async () => {
      order.push("production");
      controller.abort();
      throw new ObserverError("E_THROUGHLINE_CANCELLED", "cancelled");
    },
  });
  const result = await runSupervisorProcess(request({
    signal: controller.signal,
    createProviderRuntime: async () => ({
      providerRuntime: { provider: "codex" },
      providerSignal: new AbortController().signal,
      prepareGenerationParentRebind: async () => assert.fail("restart回収中はprepareを呼ばない"),
      advanceGenerationParentRebind: async () => {
        order.push("rebind");
        generation = {
          ...generation,
          status: "active",
          generation_id: NEW_GENERATION_ID,
          parent_epoch_id: NEW_PARENT_EPOCH,
        };
        journal = null;
        return parentRebindResult("activated", "active", "codex", "codex", "provider_ready_recovered");
      },
      advanceGenerationRollover: async () => assert.fail("planned rolloverは呼ばれない"),
      close: async () => {},
    }),
  }), value);
  assert.equal(result.status, "cancelled");
  assert.deepEqual(order, ["rebind", "production"]);
});

test("parent rebind unknownは別hostへfallbackせずfail loudにする", async () => {
  const generation = {
    ...ACTIVE_GENERATION,
    status: "rebind_required",
    generation_id: OLD_GENERATION_ID,
    parent_epoch_id: OLD_PARENT_EPOCH,
  };
  const { value } = dependencies({
    readGenerationState: async () => generation,
    readGenerationParentRebindStatus: async () => parentRebindJournal("rebind_required"),
  });
  await assert.rejects(runSupervisorProcess(request({
    createProviderRuntime: async () => ({
      providerRuntime: { provider: "codex" },
      providerSignal: new AbortController().signal,
      prepareGenerationParentRebind: async () => assert.fail("prepareは呼ばれない"),
      advanceGenerationParentRebind: async () => parentRebindResult("unknown", "rebind_required", "codex", "codex", "terminal_unknown"),
      advanceGenerationRollover: async () => assert.fail("planned rolloverは呼ばれない"),
      close: async () => {},
    }),
  }), value), { code: "E_SUPERVISOR_PARENT_REBIND_UNKNOWN" });
});

test("parent rebindとplanned rollover journalの同居を拒否する", async () => {
  const { value } = dependencies({
    readGenerationParentRebindStatus: async () => parentRebindJournal("rebind_required"),
    readGenerationHostRolloverStatus: async () => ({
      schema: "observer.generation_host_rollover_status.v1",
      target_id: TARGET_ID,
      watch_id: WATCH_ID,
      provider: "codex",
      status: "stop_authorized",
    }),
  });
  await assert.rejects(runSupervisorProcess(request(), value), {
    code: "E_SUPERVISOR_GENERATION_TRANSITION_CONFLICT",
  });
});

test("process restartは非active generationをproduction stepより先に回収する", async () => {
  const controller = new AbortController();
  const order = [];
  let generation = { ...ACTIVE_GENERATION, status: "starting" };
  let journal = {
    schema: "observer.generation_host_rollover_status.v1",
    target_id: TARGET_ID,
    watch_id: WATCH_ID,
    provider: "codex",
    status: "spawn_observed",
  };
  const { value } = dependencies({
    readGenerationState: async () => generation,
    readGenerationHostRolloverStatus: async () => journal,
    runSupervisorProductionStep: async () => {
      order.push("production");
      controller.abort();
      throw new ObserverError("E_THROUGHLINE_CANCELLED", "cancelled");
    },
  });
  const result = await runSupervisorProcess(request({
    signal: controller.signal,
    createProviderRuntime: async () => ({
      providerRuntime: { provider: "codex" },
      providerSignal: new AbortController().signal,
      prepareGenerationParentRebind: async () => assert.fail("rebind prepareは呼ばれない"),
      advanceGenerationParentRebind: async () => assert.fail("rebind callbackは呼ばれない"),
      advanceGenerationRollover: async () => {
        order.push("rollover");
        generation = ACTIVE_GENERATION;
        journal = null;
        return rollover("activated", "spawn_observed", "provider_ready_recovered");
      },
      close: async () => {},
    }),
  }), value);
  assert.equal(result.status, "cancelled");
  assert.deepEqual(order, ["rollover", "production"]);
});

test("activation後journal cleanup前のrestartもproduction stepより先に回収する", async () => {
  const controller = new AbortController();
  const order = [];
  let journal = {
    schema: "observer.generation_host_rollover_status.v1",
    target_id: TARGET_ID,
    watch_id: WATCH_ID,
    provider: "codex",
    status: "ready_observed",
  };
  const { value } = dependencies({
    readGenerationHostRolloverStatus: async () => journal,
    runSupervisorProductionStep: async () => {
      order.push("production");
      controller.abort();
      throw new ObserverError("E_THROUGHLINE_CANCELLED", "cancelled");
    },
  });
  const result = await runSupervisorProcess(request({
    signal: controller.signal,
    createProviderRuntime: async () => ({
      providerRuntime: { provider: "codex" },
      providerSignal: new AbortController().signal,
      prepareGenerationParentRebind: async () => assert.fail("rebind prepareは呼ばれない"),
      advanceGenerationParentRebind: async () => assert.fail("rebind callbackは呼ばれない"),
      advanceGenerationRollover: async () => {
        order.push("cleanup-rollover");
        journal = null;
        return rollover("activated", "ready_observed", "provider_ready_recovered");
      },
      close: async () => {},
    }),
  }), value);
  assert.equal(result.status, "cancelled");
  assert.deepEqual(order, ["cleanup-rollover", "production"]);
});

test("rollover unknownは別spawnへfallbackせずfail loudにする", async () => {
  const { value } = dependencies({
    readGenerationState: async () => ({ ...ACTIVE_GENERATION, status: "rollover_requested" }),
  });
  await assert.rejects(runSupervisorProcess(request({
    createProviderRuntime: async () => ({
      providerRuntime: { provider: "codex" },
      providerSignal: new AbortController().signal,
      prepareGenerationParentRebind: async () => assert.fail("rebind prepareは呼ばれない"),
      advanceGenerationParentRebind: async () => assert.fail("rebind callbackは呼ばれない"),
      advanceGenerationRollover: async () => rollover("unknown", "stop_authorized", "terminal_not_observed"),
      close: async () => {},
    }),
  }), value), { code: "E_SUPERVISOR_GENERATION_ROLLOVER_UNKNOWN" });
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
      providerSignal: new AbortController().signal,
      prepareGenerationParentRebind: async () => assert.fail("rebind prepareは呼ばれない"),
      advanceGenerationParentRebind: async () => assert.fail("rebind callbackは呼ばれない"),
      advanceGenerationRollover: async () => assert.fail("rollover callbackは呼ばれない"),
      close: async () => { closed += 1; },
    }),
  }), value), { code: "E_SUPERVISOR_MODEL_RESULT_UNKNOWN" });
  assert.equal(polls, 0);
  assert.equal(closed, 1);
  assert.equal(released(), 1);
});

test("provider process faultはThroughline waitを取消しcycle mutation前にfail loudにする", async () => {
  const providerController = new AbortController();
  let closed = 0;
  const { value, released } = dependencies({
    waitForMonitorPoll: async (_milliseconds, signal) => new Promise((resolve) => {
      signal.addEventListener("abort", () => resolve(false), { once: true });
    }),
    runSupervisorProductionStep: async ({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new ObserverError("E_THROUGHLINE_CANCELLED", "cancelled")), { once: true });
      providerController.abort();
    }),
  });
  await assert.rejects(runSupervisorProcess(request({
    createProviderRuntime: async () => ({
      providerRuntime: { provider: "codex" },
      providerSignal: providerController.signal,
      prepareGenerationParentRebind: async () => assert.fail("rebind prepareは呼ばれない"),
      advanceGenerationParentRebind: async () => assert.fail("rebind callbackは呼ばれない"),
      advanceGenerationRollover: async () => assert.fail("rollover callbackは呼ばれない"),
      close: async () => { closed += 1; },
    }),
  }), value), { code: "E_SUPERVISOR_PROVIDER_PROCESS_TERMINATED" });
  assert.equal(closed, 1);
  assert.equal(released(), 1);
});

function rollover(outcome, phase, reason) {
  return {
    schema: "observer.generation_host_provider_binding_result.v1",
    provider: "codex",
    target_id: TARGET_ID,
    watch_id: WATCH_ID,
    phase,
    outcome,
    reason,
  };
}

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
