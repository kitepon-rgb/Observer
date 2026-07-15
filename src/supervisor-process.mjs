import { isAbsolute, join, resolve } from "node:path";

import { ObserverError, fail } from "./observer-error.mjs";
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
const TERMINAL_STEP = new Set(["rollover_required", "provider_unavailable"]);
const RECOVERABLE_STEP = new Set(["model_pending", "model_result_unknown"]);
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

    while (true) {
      const observed = await runMonitoredOperation({
        stateRoot,
        target,
        watchId,
        provider: initial.provider,
        pollIntervalMs,
        signal,
        operation: (operationSignal) => (dependencies.runSupervisorProductionStep ?? runSupervisorProductionStep)({
          stateRoot,
          target,
          watchId,
          client,
          providerRuntime: runtime.providerRuntime,
          planRefs,
          testReceipts,
          timeoutSeconds,
          signal: operationSignal,
        }, dependencies.stepDependencies),
      }, dependencies);
      if (observed.kind === "terminal") return processResult(observed.status, initial.provider, null);
      const step = validateStepResult(observed.value, initial.provider);
      if (TERMINAL_STEP.has(step.status)) return processResult(step.status, step.provider, step.cycle_id);
      if (CONTINUING_STEP.has(step.status)) continue;
      if (!RECOVERABLE_STEP.has(step.status)) {
        fail("E_SUPERVISOR_PROCESS_STEP_INVALID", "Supervisor step結果をloopへ適用できません");
      }
      const paused = await runMonitoredOperation({
        stateRoot,
        target,
        watchId,
        provider: initial.provider,
        pollIntervalMs,
        signal,
        operation: (operationSignal) => (dependencies.waitForModelPoll ?? waitForModelPoll)(pollIntervalMs, operationSignal),
      }, dependencies);
      if (paused.kind === "terminal") return processResult(paused.status, initial.provider, null);
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

async function runMonitoredOperation({ stateRoot, target, watchId, provider, pollIntervalMs, signal, operation }, dependencies) {
  if (signal?.aborted) return { kind: "terminal", status: "cancelled" };
  const operationController = new AbortController();
  const monitorController = new AbortController();
  const onExternalAbort = () => operationController.abort();
  signal?.addEventListener("abort", onExternalAbort, { once: true });
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
    if (signal?.aborted) return { kind: "terminal", status: "cancelled" };
    if (winner.kind === "operation_error") throw winner.error;
    return { kind: "result", value: winner.value };
  }

  operationController.abort();
  const operationOutcome = await operationPromise;
  signal?.removeEventListener("abort", onExternalAbort);
  if (signal?.aborted) return { kind: "terminal", status: "cancelled" };
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
  if (!isPlainObject(watch) || watch.target_id !== target.targetId || watch.watch_id !== watchId ||
      watch.project_root !== target.projectRoot || !["claude", "codex"].includes(watch.provider) ||
      (provider !== null && watch.provider !== provider) ||
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
  if (!isPlainObject(value) || Object.keys(value).sort().join(",") !== "close,providerRuntime" ||
      !isPlainObject(value.providerRuntime) || typeof value.close !== "function") {
    fail("E_SUPERVISOR_PROCESS_RUNTIME_INVALID", "Supervisor provider runtime所有権が不正です");
  }
  return value;
}

function validateStepResult(value, provider) {
  if (!isPlainObject(value) || value.schema !== "observer.supervisor_production_result.v1" ||
      value.provider !== provider || ![
        "timeout", "rollover_required", "model_result_unknown", "model_pending", "committed", "provider_unavailable",
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

function isCancellation(error) {
  return error instanceof ObserverError && error.code === "E_THROUGHLINE_CANCELLED";
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
