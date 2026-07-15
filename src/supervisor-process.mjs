import { isAbsolute, join, resolve } from "node:path";

import { ObserverError, fail } from "./observer-error.mjs";
import { readGenerationHostRolloverStatus } from "./generation-host-lifecycle.mjs";
import { readGenerationParentRebindStatus } from "./generation-parent-rebind.mjs";
import { readGenerationState } from "./generation-store.mjs";
import {
  acquirePrivateLock,
  assertPrivateDirectory,
  assertWithin,
  inspectPrivateLock,
  recoverPrivateLock,
} from "./private-state.mjs";
import { runSupervisorProductionStep } from "./supervisor-production-step.mjs";
import { readWatchStatus } from "./watch-store.mjs";

export const SUPERVISOR_PROCESS_RESULT_SCHEMA = "observer.supervisor_process_result.v1";

const TARGET = /^p_[a-f0-9]{64}$/;
const WATCH = /^w_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TERMINAL_STEP = new Set(["provider_unavailable"]);
const RECOVERABLE_STEP = new Set(["model_pending"]);
const CONTINUING_STEP = new Set(["timeout", "committed"]);
const WATCH_TERMINAL = new Set(["stopping", "stopped", "faulted"]);
const DEFAULT_POLL_INTERVAL_MS = 1_000;

export async function runSupervisorProcess({
  stateRoot,
  target,
  watchId,
  client,
  createProviderRuntime,
  planRefs = [],
  testReceipts = [],
  timeoutSeconds = 3600,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  signal,
} = {}, dependencies = {}) {
  validateRequest({
    stateRoot, target, watchId, client, createProviderRuntime,
    planRefs, testReceipts, timeoutSeconds, pollIntervalMs, signal,
  });
  const acquire = dependencies.acquirePrivateLock ?? acquirePrivateLock;
  let release;
  try {
    release = await acquire(await processLockPath(stateRoot, target.targetId));
  } catch (error) {
    if (error instanceof ObserverError && error.code === "E_CONSUMER_LOCKED") {
      fail("E_SUPERVISOR_PROCESS_ALREADY_RUNNING", "同じtargetのSupervisor processが既に進行中です");
    }
    throw error;
  }

  let primary = null;
  let closeProviderRuntime = null;
  try {
    const initial = await observeWatch({ stateRoot, target, watchId }, dependencies);
    const initialTerminal = terminalForWatch(initial);
    if (initialTerminal !== null) return processResult(initialTerminal, initial.provider, null);
    if (signal?.aborted) return processResult("cancelled", initial.provider, null);

    const owned = await createProviderRuntime();
    const runtime = validateOwnedRuntime(owned);
    closeProviderRuntime = runtime.close;
    const afterRuntime = await observeWatch({ stateRoot, target, watchId, provider: initial.provider }, dependencies);
    const afterRuntimeTerminal = terminalForWatch(afterRuntime);
    if (afterRuntimeTerminal !== null) return processResult(afterRuntimeTerminal, initial.provider, null);
    if (signal?.aborted) return processResult("cancelled", initial.provider, null);

    let provider = initial.provider;
    const initialRebind = await resumeGenerationParentRebind({
      stateRoot, target, watchId, provider, runtime, pollIntervalMs, signal,
    }, dependencies);
    if (initialRebind.terminal !== null) return processResult(initialRebind.terminal, provider, null);
    provider = initialRebind.provider;
    const initialRolloverTerminal = await resumeGenerationRollover({
      stateRoot, target, watchId, provider, runtime, pollIntervalMs, signal,
    }, dependencies);
    if (initialRolloverTerminal !== null) return processResult(initialRolloverTerminal, provider, null);

    while (true) {
      const observed = await runMonitoredOperation({
        stateRoot,
        target,
        watchId,
        provider,
        pollIntervalMs,
        signal,
        providerSignal: runtime.providerSignal,
        operation: (operationSignal) => (dependencies.runSupervisorProductionStep ?? runSupervisorProductionStep)({
          stateRoot,
          target,
          watchId,
          client,
          providerRuntime: runtime.providerRuntime,
          prepareGenerationParentRebind: runtime.prepareGenerationParentRebind,
          planRefs,
          testReceipts,
          timeoutSeconds,
          signal: operationSignal,
        }, dependencies.stepDependencies),
      }, dependencies);
      if (observed.kind === "terminal") return processResult(observed.status, provider, null);
      const step = validateStepResult(observed.value, provider);
      if (TERMINAL_STEP.has(step.status)) return processResult(step.status, step.provider, step.cycle_id);
      if (step.status === "rebind_required") {
        const rebind = await resumeGenerationParentRebind({
          stateRoot, target, watchId, provider, runtime, pollIntervalMs, signal,
        }, dependencies);
        if (rebind.terminal !== null) return processResult(rebind.terminal, provider, null);
        provider = rebind.provider;
        continue;
      }
      if (step.status === "rollover_required") {
        const rolloverTerminal = await resumeGenerationRollover({
          stateRoot, target, watchId, provider, runtime, pollIntervalMs, signal,
        }, dependencies);
        if (rolloverTerminal !== null) return processResult(rolloverTerminal, provider, null);
        continue;
      }
      if (CONTINUING_STEP.has(step.status)) continue;
      if (step.status === "model_result_unknown") {
        fail("E_SUPERVISOR_MODEL_RESULT_UNKNOWN", "同じmodel operationの結果をexact回収できません");
      }
      if (!RECOVERABLE_STEP.has(step.status)) {
        fail("E_SUPERVISOR_PROCESS_STEP_INVALID", "Supervisor step結果をloopへ適用できません");
      }
      const paused = await runMonitoredOperation({
        stateRoot,
        target,
        watchId,
        provider,
        pollIntervalMs,
        signal,
        providerSignal: runtime.providerSignal,
        operation: (operationSignal) => (dependencies.waitForModelPoll ?? waitForModelPoll)(pollIntervalMs, operationSignal),
      }, dependencies);
      if (paused.kind === "terminal") return processResult(paused.status, provider, null);
    }
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    const cleanupErrors = [];
    if (closeProviderRuntime !== null) {
      try { await closeProviderRuntime(); } catch (error) { cleanupErrors.push(error); }
    }
    try { await release(); } catch (error) { cleanupErrors.push(error); }
    if (cleanupErrors.length > 0) {
      if (primary !== null) throw new AggregateError([primary, ...cleanupErrors], "Supervisor processとcleanupが失敗しました");
      if (cleanupErrors.length === 1) throw cleanupErrors[0];
      throw new AggregateError(cleanupErrors, "Supervisor process cleanupが失敗しました");
    }
  }
}

export async function inspectSupervisorProcessLock({ stateRoot, targetId } = {}, dependencies = {}) {
  return (dependencies.inspectPrivateLock ?? inspectPrivateLock)(await processLockPath(stateRoot, targetId));
}

export async function recoverSupervisorProcessLock({ stateRoot, targetId, expectedNonce } = {}, dependencies = {}) {
  if (typeof expectedNonce !== "string" || expectedNonce.length === 0) {
    fail("E_SUPERVISOR_PROCESS_LOCK_NONCE_REQUIRED", "expected Supervisor process lock nonceが必要です");
  }
  return (dependencies.recoverPrivateLock ?? recoverPrivateLock)(await processLockPath(stateRoot, targetId), expectedNonce);
}

async function runMonitoredOperation({
  stateRoot, target, watchId, provider, pollIntervalMs, signal, providerSignal, operation,
}, dependencies) {
  if (signal?.aborted) return { kind: "terminal", status: "cancelled" };
  if (providerSignal.aborted) providerTerminated();
  const operationController = new AbortController();
  const monitorController = new AbortController();
  const onExternalAbort = () => operationController.abort();
  const onProviderAbort = () => operationController.abort();
  signal?.addEventListener("abort", onExternalAbort, { once: true });
  providerSignal.addEventListener("abort", onProviderAbort, { once: true });
  const operationPromise = Promise.resolve()
    .then(() => operation(operationController.signal))
    .then((value) => ({ kind: "operation", value }), (error) => ({ kind: "operation_error", error }));
  const monitorPromise = monitorWatch({
    stateRoot, target, watchId, provider, pollIntervalMs, signal: monitorController.signal,
  }, dependencies).then(
    (value) => ({ kind: "monitor", value }),
    (error) => ({ kind: "monitor_error", error }),
  );

  const winner = await Promise.race([operationPromise, monitorPromise]);
  if (winner.kind === "operation" || winner.kind === "operation_error") {
    monitorController.abort();
    await monitorPromise;
    signal?.removeEventListener("abort", onExternalAbort);
    providerSignal.removeEventListener("abort", onProviderAbort);
    if (signal?.aborted) return { kind: "terminal", status: "cancelled" };
    if (providerSignal.aborted) providerTerminated();
    if (winner.kind === "operation_error") throw winner.error;
    return { kind: "result", value: winner.value };
  }

  operationController.abort();
  const operationOutcome = await operationPromise;
  signal?.removeEventListener("abort", onExternalAbort);
  providerSignal.removeEventListener("abort", onProviderAbort);
  if (signal?.aborted) return { kind: "terminal", status: "cancelled" };
  if (providerSignal.aborted) providerTerminated();
  if (winner.kind === "monitor_error") {
    if (operationOutcome.kind === "operation_error" && !isCancellation(operationOutcome.error)) {
      throw new AggregateError([winner.error, operationOutcome.error], "watch監視とSupervisor operationが失敗しました");
    }
    throw winner.error;
  }
  if (winner.value === null) {
    if (operationOutcome.kind === "operation_error" && !isCancellation(operationOutcome.error)) throw operationOutcome.error;
    fail("E_SUPERVISOR_PROCESS_MONITOR_STOPPED", "watch monitorが理由なしで終了しました");
  }
  return { kind: "terminal", status: winner.value };
}

async function monitorWatch({ stateRoot, target, watchId, provider, pollIntervalMs, signal }, dependencies) {
  while (await (dependencies.waitForMonitorPoll ?? waitForMonitorPoll)(pollIntervalMs, signal)) {
    const watch = await observeWatch({ stateRoot, target, watchId, provider }, dependencies);
    const terminal = terminalForWatch(watch);
    if (terminal !== null) return terminal;
  }
  return null;
}

async function observeWatch({ stateRoot, target, watchId, provider = null }, dependencies) {
  const watch = await (dependencies.readWatchStatus ?? readWatchStatus)({ stateRoot, targetId: target.targetId });
  const providerMatches = provider === null || (Array.isArray(provider) ? provider.includes(watch?.provider) : watch?.provider === provider);
  if (!isPlainObject(watch) || watch.target_id !== target.targetId || watch.watch_id !== watchId ||
      watch.project_root !== target.projectRoot || !["claude", "codex"].includes(watch.provider) ||
      !providerMatches ||
      !["starting", "launching", "active", "stopping", "stopped", "faulted"].includes(watch.status)) {
    fail("E_SUPERVISOR_PROCESS_WATCH_CHANGED", "Supervisor processのwatch identityが変化しました");
  }
  if (["starting", "launching"].includes(watch.status)) {
    fail("E_SUPERVISOR_PROCESS_WATCH_NOT_ACTIVE", "Supervisor processにはactive watchが必要です");
  }
  return watch;
}

function terminalForWatch(watch) {
  return WATCH_TERMINAL.has(watch.status) ? watch.status : null;
}

function validateOwnedRuntime(value) {
  if (!isPlainObject(value) || Object.keys(value).sort().join(",") !==
      "advanceGenerationParentRebind,advanceGenerationRollover,close,prepareGenerationParentRebind,providerRuntime,providerSignal" ||
      !isPlainObject(value.providerRuntime) || !(value.providerSignal instanceof AbortSignal) || typeof value.close !== "function") {
    fail("E_SUPERVISOR_PROCESS_RUNTIME_INVALID", "Supervisor provider runtime所有権が不正です");
  }
  if (typeof value.advanceGenerationRollover !== "function") {
    fail("E_SUPERVISOR_PROCESS_RUNTIME_INVALID", "generation rollover callbackが不正です");
  }
  if (typeof value.prepareGenerationParentRebind !== "function" || typeof value.advanceGenerationParentRebind !== "function") {
    fail("E_SUPERVISOR_PROCESS_RUNTIME_INVALID", "generation parent rebind callbackが不正です");
  }
  return value;
}

async function resumeGenerationParentRebind({
  stateRoot, target, watchId, provider, runtime, pollIntervalMs, signal,
}, dependencies) {
  while (true) {
    const journal = await observeGenerationParentRebind({ stateRoot, target, watchId }, dependencies);
    const rollover = await observeGenerationRollover({ stateRoot, target, watchId, provider: null }, dependencies);
    if (journal !== null && rollover !== null) {
      fail("E_SUPERVISOR_GENERATION_TRANSITION_CONFLICT", "parent rebindとplanned rollover journalが同居しています");
    }
    if (journal === null) {
      if (rollover !== null) return { terminal: null, provider };
      const generation = await observeAnyGeneration({ stateRoot, target, watchId }, dependencies);
      if (generation.status === "rollover_requested") return { terminal: null, provider };
      if (generation.status !== "active") {
        fail("E_SUPERVISOR_PARENT_REBIND_MISSING", "非active generationにparent rebind journalがありません");
      }
      const watch = await observeWatch({ stateRoot, target, watchId, provider: generation.provider }, dependencies);
      const terminal = terminalForWatch(watch);
      if (terminal !== null) return { terminal, provider };
      return { terminal: null, provider: generation.provider };
    }
    await observeParentRebindGeneration({ stateRoot, target, watchId, journal }, dependencies);
    if (![journal.from_provider, journal.to_provider].includes(provider)) {
      fail("E_SUPERVISOR_PARENT_REBIND_CHANGED", "process providerがparent rebind identityと一致しません");
    }
    const observed = await runMonitoredOperation({
      stateRoot,
      target,
      watchId,
      provider: [journal.from_provider, journal.to_provider],
      pollIntervalMs,
      signal,
      providerSignal: runtime.providerSignal,
      operation: () => runtime.advanceGenerationParentRebind(),
    }, dependencies);
    if (observed.kind === "terminal") return { terminal: observed.status, provider };
    const transition = validateGenerationParentRebindResult(observed.value, { target, watchId, journal });
    if (transition.outcome === "unknown") {
      fail("E_SUPERVISOR_PARENT_REBIND_UNKNOWN", "parent rebind結果をexact回収できません");
    }
    if (transition.outcome === "progressed" || transition.outcome === "activated") continue;
    if (transition.outcome !== "pending") {
      fail("E_SUPERVISOR_PARENT_REBIND_INVALID", "parent rebind結果をprocessへ適用できません");
    }
    const paused = await runMonitoredOperation({
      stateRoot,
      target,
      watchId,
      provider: [journal.from_provider, journal.to_provider],
      pollIntervalMs,
      signal,
      providerSignal: runtime.providerSignal,
      operation: (operationSignal) => (dependencies.waitForRebindPoll ?? waitForModelPoll)(pollIntervalMs, operationSignal),
    }, dependencies);
    if (paused.kind === "terminal") return { terminal: paused.status, provider };
  }
}

async function resumeGenerationRollover({
  stateRoot, target, watchId, provider, runtime, pollIntervalMs, signal,
}, dependencies) {
  while (true) {
    const rebind = await observeGenerationParentRebind({ stateRoot, target, watchId }, dependencies);
    if (rebind !== null) {
      fail("E_SUPERVISOR_GENERATION_TRANSITION_CONFLICT", "planned rollover中にparent rebind journalがあります");
    }
    const generation = await observeGeneration({ stateRoot, target, watchId, provider }, dependencies);
    const journal = await observeGenerationRollover({ stateRoot, target, watchId, provider }, dependencies);
    if (generation.status === "active" && journal === null) return null;
    if (generation.status !== "rollover_requested" && journal === null) {
      fail("E_SUPERVISOR_GENERATION_ROLLOVER_MISSING", "非active generationにrollover journalがありません");
    }

    const observed = await runMonitoredOperation({
      stateRoot,
      target,
      watchId,
      provider,
      pollIntervalMs,
      signal,
      providerSignal: runtime.providerSignal,
      operation: () => runtime.advanceGenerationRollover(),
    }, dependencies);
    if (observed.kind === "terminal") return observed.status;
    const transition = validateGenerationRolloverResult(observed.value, { target, watchId, provider });
    if (transition.outcome === "unknown") {
      fail("E_SUPERVISOR_GENERATION_ROLLOVER_UNKNOWN", "generation rollover結果をexact回収できません");
    }
    if (transition.outcome === "progressed" || transition.outcome === "activated") continue;
    if (transition.outcome !== "pending") {
      fail("E_SUPERVISOR_GENERATION_ROLLOVER_INVALID", "generation rollover結果をprocessへ適用できません");
    }
    const paused = await runMonitoredOperation({
      stateRoot,
      target,
      watchId,
      provider,
      pollIntervalMs,
      signal,
      providerSignal: runtime.providerSignal,
      operation: (operationSignal) => (dependencies.waitForRolloverPoll ?? waitForModelPoll)(pollIntervalMs, operationSignal),
    }, dependencies);
    if (paused.kind === "terminal") return paused.status;
  }
}

async function observeGeneration({ stateRoot, target, watchId, provider }, dependencies) {
  const generation = await (dependencies.readGenerationState ?? readGenerationState)({ stateRoot, targetId: target.targetId });
  if (!isPlainObject(generation) || generation.schema !== "observer.generation_state.v1" ||
      generation.target_id !== target.targetId || generation.watch_id !== watchId || generation.provider !== provider ||
      !["active", "rollover_requested", "stopping", "terminal_confirmed", "starting"].includes(generation.status)) {
    fail("E_SUPERVISOR_GENERATION_CHANGED", "Supervisor processのgeneration identityが変化しました");
  }
  return generation;
}

async function observeAnyGeneration({ stateRoot, target, watchId }, dependencies) {
  const generation = await (dependencies.readGenerationState ?? readGenerationState)({ stateRoot, targetId: target.targetId });
  if (!isPlainObject(generation) || generation.schema !== "observer.generation_state.v1" ||
      generation.target_id !== target.targetId || generation.watch_id !== watchId ||
      !["claude", "codex"].includes(generation.provider) ||
      !["active", "rollover_requested", "rebind_required", "stopping", "terminal_confirmed", "starting"].includes(generation.status)) {
    fail("E_SUPERVISOR_GENERATION_CHANGED", "Supervisor processのgeneration identityが変化しました");
  }
  return generation;
}

async function observeParentRebindGeneration({ stateRoot, target, watchId, journal }, dependencies) {
  const generation = await observeAnyGeneration({ stateRoot, target, watchId }, dependencies);
  const expected = {
    rebind_required: ["rebind_required", journal.from_provider],
    stop_authorized: ["stopping", journal.from_provider],
    terminal_observed: ["terminal_confirmed", journal.from_provider],
    spawn_authorized: ["starting", journal.to_provider],
    spawn_observed: ["starting", journal.to_provider],
    ready_observed: ["starting", journal.to_provider],
  }[journal.status];
  const activationCleanup = journal.status === "ready_observed" && generation.status === "active" &&
    generation.provider === journal.to_provider && generation.generation_id === journal.to_generation_id &&
    generation.parent_epoch_id === journal.to_parent_epoch_id;
  const expectedParentEpoch = ["rebind_required", "stop_authorized", "terminal_observed"].includes(journal.status)
    ? journal.from_parent_epoch_id
    : journal.to_parent_epoch_id;
  if (!activationCleanup && (generation.status !== expected[0] || generation.provider !== expected[1] ||
      generation.generation_id !== (journal.status === "rebind_required" || journal.status === "stop_authorized" ||
        journal.status === "terminal_observed" ? journal.from_generation_id : journal.to_generation_id) ||
      generation.parent_epoch_id !== expectedParentEpoch)) {
    fail("E_SUPERVISOR_PARENT_REBIND_CHANGED", "generationとparent rebind journalが一致しません");
  }
  return generation;
}

async function observeGenerationRollover({ stateRoot, target, watchId, provider }, dependencies) {
  const journal = await (dependencies.readGenerationHostRolloverStatus ?? readGenerationHostRolloverStatus)({
    stateRoot, targetId: target.targetId, watchId,
  });
  if (journal === null) return null;
  if (!isPlainObject(journal) || journal.schema !== "observer.generation_host_rollover_status.v1" ||
      journal.target_id !== target.targetId || journal.watch_id !== watchId || !["claude", "codex"].includes(journal.provider) ||
      (provider !== null && journal.provider !== provider) ||
      !["stop_authorized", "terminal_observed", "spawn_authorized", "spawn_observed", "ready_observed"].includes(journal.status)) {
    fail("E_SUPERVISOR_GENERATION_ROLLOVER_CHANGED", "generation rollover journalがprocess identityと一致しません");
  }
  return journal;
}

async function observeGenerationParentRebind({ stateRoot, target, watchId }, dependencies) {
  const journal = await (dependencies.readGenerationParentRebindStatus ?? readGenerationParentRebindStatus)({
    stateRoot, targetId: target.targetId, watchId,
  });
  if (journal === null) return null;
  const actions = {
    rebind_required: "authorize_stop",
    stop_authorized: "observe_terminal",
    terminal_observed: "authorize_start",
    spawn_authorized: "recover_spawn",
    spawn_observed: "recover_ready",
    ready_observed: "finish_activation",
  };
  const keys = [
    "action", "from_generation_id", "from_parent_epoch_id", "from_provider", "schema", "status", "target_id",
    "to_generation_id", "to_parent_epoch_id", "to_provider", "watch_id",
  ].sort();
  const actual = isPlainObject(journal) ? Object.keys(journal).sort() : [];
  if (!isPlainObject(journal) || actual.length !== keys.length || actual.some((key, index) => key !== keys[index]) ||
      journal.schema !== "observer.generation_parent_rebind_status.v1" ||
      journal.target_id !== target.targetId || journal.watch_id !== watchId ||
      !["claude", "codex"].includes(journal.from_provider) || !["claude", "codex"].includes(journal.to_provider) ||
      actions[journal.status] !== journal.action || !/^sha256:[a-f0-9]{64}$/.test(journal.from_parent_epoch_id) ||
      !/^sha256:[a-f0-9]{64}$/.test(journal.to_parent_epoch_id) || !/^sha256:[a-f0-9]{64}$/.test(journal.from_generation_id) ||
      !(journal.to_generation_id === null || /^sha256:[a-f0-9]{64}$/.test(journal.to_generation_id)) ||
      (["rebind_required", "stop_authorized", "terminal_observed"].includes(journal.status)
        ? journal.to_generation_id !== null
        : journal.to_generation_id === null)) {
    fail("E_SUPERVISOR_PARENT_REBIND_CHANGED", "parent rebind journalがprocess identityと一致しません");
  }
  return journal;
}

function validateGenerationRolloverResult(value, { target, watchId, provider }) {
  if (!isPlainObject(value) ||
      Object.keys(value).sort().join(",") !== "outcome,phase,provider,reason,schema,target_id,watch_id" ||
      value.schema !== "observer.generation_host_provider_binding_result.v1" || value.provider !== provider ||
      value.target_id !== target.targetId || value.watch_id !== watchId ||
      !["stop_authorized", "terminal_observed", "spawn_authorized", "spawn_observed", "ready_observed"].includes(value.phase) ||
      !["pending", "progressed", "activated", "unknown"].includes(value.outcome) ||
      typeof value.reason !== "string" || value.reason.length === 0 || value.reason.length > 128) {
    fail("E_SUPERVISOR_GENERATION_ROLLOVER_INVALID", "generation rollover binding結果が不正です");
  }
  return value;
}

function validateGenerationParentRebindResult(value, { target, watchId, journal }) {
  if (!isPlainObject(value) ||
      Object.keys(value).sort().join(",") !== "outcome,phase,provider,reason,schema,target_id,watch_id" ||
      value.schema !== "observer.generation_parent_rebind_provider_binding_result.v1" ||
      !isPlainObject(value.provider) || Object.keys(value.provider).sort().join(",") !== "from,to" ||
      value.provider.from !== journal.from_provider || value.provider.to !== journal.to_provider ||
      value.target_id !== target.targetId || value.watch_id !== watchId ||
      !["rebind_required", "stop_authorized", "terminal_observed", "spawn_authorized", "spawn_observed", "ready_observed", "active"].includes(value.phase) ||
      !["pending", "progressed", "activated", "unknown"].includes(value.outcome) ||
      typeof value.reason !== "string" || value.reason.length === 0 || value.reason.length > 128) {
    fail("E_SUPERVISOR_PARENT_REBIND_INVALID", "parent rebind binding結果が不正です");
  }
  return value;
}

function validateStepResult(value, provider) {
  if (!isPlainObject(value) || value.schema !== "observer.supervisor_production_result.v1" ||
      value.provider !== provider || ![
        "timeout", "rollover_required", "rebind_required", "model_result_unknown", "model_pending", "committed", "provider_unavailable",
      ].includes(value.status) ||
      (value.cycle_id !== null && (typeof value.cycle_id !== "string" || !/^c_[a-f0-9]{64}$/.test(value.cycle_id)))) {
    fail("E_SUPERVISOR_PROCESS_STEP_INVALID", "Supervisor step結果が不正です");
  }
  return value;
}

function processResult(status, provider, cycleId) {
  return {
    schema: SUPERVISOR_PROCESS_RESULT_SCHEMA,
    status,
    provider,
    cycle_id: cycleId,
  };
}

async function processLockPath(stateRoot, targetId) {
  if (typeof stateRoot !== "string" || !isAbsolute(stateRoot) || !TARGET.test(targetId)) {
    fail("E_SUPERVISOR_PROCESS_INPUT_INVALID", "Supervisor process lock identityが不正です");
  }
  const root = resolve(stateRoot);
  const watches = assertWithin(root, join(root, "watches"));
  const target = assertWithin(root, join(watches, targetId));
  await assertPrivateDirectory(root);
  await assertPrivateDirectory(watches);
  await assertPrivateDirectory(target);
  return join(target, "supervisor-process.lock");
}

function validateRequest({
  stateRoot, target, watchId, client, createProviderRuntime,
  planRefs, testReceipts, timeoutSeconds, pollIntervalMs, signal,
}) {
  if (typeof stateRoot !== "string" || !isAbsolute(stateRoot) || !isPlainObject(target) ||
      target.schema !== "observer.project_target.v1" || !TARGET.test(target.targetId) || !isAbsolute(target.projectRoot) ||
      !WATCH.test(watchId) || !client || typeof client.read !== "function" || typeof client.wait !== "function" ||
      typeof createProviderRuntime !== "function" || !Array.isArray(planRefs) || !Array.isArray(testReceipts) ||
      !Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600 ||
      !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 100 || pollIntervalMs > 60_000 ||
      (signal !== undefined && !(signal instanceof AbortSignal))) {
    fail("E_SUPERVISOR_PROCESS_INPUT_INVALID", "Supervisor process入力が不正です");
  }
}

function waitForMonitorPoll(milliseconds, signal) {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, milliseconds);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function waitForModelPoll(milliseconds, signal) {
  if (signal.aborted) return Promise.reject(cancelled());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      reject(cancelled());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function cancelled() {
  return new ObserverError("E_THROUGHLINE_CANCELLED", "Supervisor process待機が取消されました");
}

function providerTerminated() {
  fail("E_SUPERVISOR_PROVIDER_PROCESS_TERMINATED", "Supervisor provider processが終了しました");
}

function isCancellation(error) {
  return error instanceof ObserverError && error.code === "E_THROUGHLINE_CANCELLED";
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
