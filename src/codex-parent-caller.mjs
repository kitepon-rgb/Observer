import { isAbsolute } from "node:path";

import {
  CODEX_HOST_STOP_RESULT_SCHEMA,
  activateCodexObserver,
  spawnCodexObserverThread,
  stopCodexObserver,
} from "./codex-host-runtime.mjs";
import {
  CODEX_PROCESS_VERIFICATION_SCHEMA,
  verifyCodexAppServerRuntime,
} from "./codex-process-transport.mjs";
import { initializeGeneration } from "./generation-store.mjs";
import { fail } from "./observer-error.mjs";
import {
  PARENT_LAUNCH_REQUEST_SCHEMA,
  PARENT_AUTHORIZATION_SCHEMA,
  completeParentStop,
  prepareParentLaunch,
  recordParentLaunchFailure,
  requestParentStop,
  validateParentHostReceipt,
} from "./parent-launch.mjs";
import {
  OBSERVER_PRODUCT_DIAGNOSTICS_SCHEMA,
  runObserverProductDiagnostics,
} from "./product-diagnostics.mjs";
import {
  createCodexSupervisorRuntime,
} from "./supervisor-codex-process.mjs";
import {
  SUPERVISOR_PROCESS_RESULT_SCHEMA,
  runSupervisorProcess,
} from "./supervisor-process.mjs";
import {
  createVerifiedThroughlineClient,
  THROUGHLINE_PROCESS_VERIFICATION_SCHEMA,
  verifyThroughlineRuntime,
} from "./throughline-process-runtime.mjs";
import { validateParentWatchContext } from "./watch-lifecycle.mjs";
import { readWatchStatus } from "./watch-store.mjs";

export const CODEX_PARENT_CALLER_RESULT_SCHEMA = "observer.codex_parent_caller_result.v1";

export async function runCodexParentWatchProcess({
  stateRoot,
  projectRoot,
  runtimeRoot,
  throughlineCommand,
  codexCommand,
  parentContext,
  planRefs = [],
  testReceipts = [],
  timeoutSeconds = 3600,
  pollIntervalMs = 1_000,
  stopPollIntervalMs = 1_000,
  stopAttempts = 60,
  signal,
} = {}, dependencies = {}) {
  validatePaths({ stateRoot, projectRoot, runtimeRoot, throughlineCommand, codexCommand });
  validateProcessOptions({
    planRefs, testReceipts, timeoutSeconds, pollIntervalMs, stopPollIntervalMs, stopAttempts, signal,
  });
  const context = validateParentWatchContext(parentContext, "start_observer");
  if (context.parentProvider !== "codex" || context.runtimeRoot !== runtimeRoot) {
    fail("E_CODEX_PARENT_CONTEXT_MISMATCH", "現在Codex親のruntime contextが一致しません");
  }

  const product = await (dependencies.runProductDiagnostics ?? runObserverProductDiagnostics)(
    { packageRoot: runtimeRoot },
  );
  if (product?.schema !== OBSERVER_PRODUCT_DIAGNOSTICS_SCHEMA || product.status !== "ready") {
    fail("E_CODEX_PARENT_PRODUCT_NOT_READY", "Observer productがreadyではありません");
  }

  const throughlineVerification = await (
    dependencies.verifyThroughlineRuntime ?? verifyThroughlineRuntime
  )({ runtimeRoot, throughlineCommand }, dependencies.throughlineVerificationDependencies);
  validateThroughlineVerification(throughlineVerification, runtimeRoot);
  const client = (dependencies.createVerifiedThroughlineClient ?? createVerifiedThroughlineClient)(
    { verification: throughlineVerification },
    dependencies.throughlineClientDependencies,
  );
  validateClient(client);

  const codexVerification = await (
    dependencies.verifyCodexAppServerRuntime ?? verifyCodexAppServerRuntime
  )({ runtimeRoot, codexCommand }, dependencies.codexVerificationDependencies);
  validateCodexVerification(codexVerification, runtimeRoot);

  const parent = await client.read({ projectPath: projectRoot, signal });
  validateCurrentCodexParent(parent);

  const request = await (dependencies.prepareParentLaunch ?? prepareParentLaunch)({
    stateRoot,
    projectRoot,
    runtimeRoot,
    authorization: context.authorization,
    expectedPreviousWatchId: context.expectedPreviousWatchId,
  }, dependencies.parentDependencies);
  validateLaunchRequest(request, { projectRoot, runtimeRoot });
  const target = {
    schema: "observer.project_target.v1",
    targetId: request.target_id,
    projectRoot: request.project_root,
  };

  let owned = null;
  let claimed = false;
  let primaryFailure = null;
  try {
    try {
      owned = await (dependencies.createCodexSupervisorRuntime ?? createCodexSupervisorRuntime)({
        stateRoot,
        target,
        watchId: request.watch_id,
        runtimeRoot,
        codexCommand,
      }, dependencies.codexRuntimeDependencies);
      validateOwnedRuntime(owned, runtimeRoot);
    } catch (error) {
      await recordPreSpawnFailure({ stateRoot, request, error }, dependencies);
      throw error;
    }

    const spawnResult = await (dependencies.spawnCodexObserverThread ?? spawnCodexObserverThread)({
      stateRoot,
      request,
      session: owned.providerRuntime.session,
    }, dependencies.codexHostDependencies);
    validateSpawnResult(spawnResult, request);

    const activation = await (dependencies.activateCodexObserver ?? activateCodexObserver)({
      stateRoot,
      request,
      spawnResult,
      session: owned.providerRuntime.session,
    }, dependencies.codexHostDependencies);
    validateActivation(activation, request);
    owned = withTerminalShutdown({
      owned,
      stateRoot,
      request,
      stopPollIntervalMs,
      stopAttempts,
      dependencies,
    });

    await (dependencies.initializeGeneration ?? initializeGeneration)({
      stateRoot,
      targetId: request.target_id,
      watchId: request.watch_id,
      provider: "codex",
      parentThreadSha256: parent.thread_sha256,
      readyReceipt: activation.ready_receipt,
    }, dependencies.generationDependencies);

    const run = dependencies.runSupervisorProcess ?? runSupervisorProcess;
    const processResult = await run({
      stateRoot,
      target,
      watchId: request.watch_id,
      client,
      createProviderRuntime: async () => {
        if (claimed) fail("E_CODEX_PARENT_RUNTIME_ALREADY_CLAIMED", "Codex runtime所有権は既にSupervisorへ渡されています");
        claimed = true;
        return owned;
      },
      planRefs,
      testReceipts,
      timeoutSeconds,
      pollIntervalMs,
      signal,
    }, dependencies.processDependencies);
    validateProcessResult(processResult);
    return {
      schema: CODEX_PARENT_CALLER_RESULT_SCHEMA,
      status: processResult.status,
      provider: "codex",
      cycle_id: processResult.cycle_id,
    };
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    if (owned !== null && !claimed && typeof owned.close === "function") {
      try {
        await owned.close();
      } catch (cleanupFailure) {
        if (primaryFailure !== null) {
          throw new AggregateError(
            [primaryFailure, cleanupFailure],
            "Codex parent caller失敗後のterminal cleanupも失敗しました",
          );
        }
        throw cleanupFailure;
      }
    }
  }
}

async function recordPreSpawnFailure({ stateRoot, request, error }, dependencies) {
  try {
    await (dependencies.recordParentLaunchFailure ?? recordParentLaunchFailure)({
      stateRoot,
      request,
      faultCode: "E_OBSERVER_LAUNCH_FAILED",
    }, dependencies.parentDependencies);
  } catch (recordError) {
    throw new AggregateError([error, recordError], "Codex runtime起動失敗とwatch fault記録が失敗しました");
  }
}

function validatePaths({ stateRoot, projectRoot, runtimeRoot, throughlineCommand, codexCommand }) {
  if (![stateRoot, projectRoot, runtimeRoot, throughlineCommand, codexCommand]
    .every((value) => typeof value === "string" && isAbsolute(value))) {
    fail("E_CODEX_PARENT_CALLER_INPUT_INVALID", "Codex parent callerのpath入力が不正です");
  }
}

function validateProcessOptions({
  planRefs, testReceipts, timeoutSeconds, pollIntervalMs, stopPollIntervalMs, stopAttempts, signal,
}) {
  if (!Array.isArray(planRefs) || !Array.isArray(testReceipts) ||
      !Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600 ||
      !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 100 || pollIntervalMs > 60_000 ||
      !Number.isSafeInteger(stopPollIntervalMs) || stopPollIntervalMs < 100 || stopPollIntervalMs > 60_000 ||
      !Number.isSafeInteger(stopAttempts) || stopAttempts < 1 || stopAttempts > 300 ||
      (signal !== undefined && !(signal instanceof AbortSignal))) {
    fail("E_CODEX_PARENT_CALLER_INPUT_INVALID", "Codex parent callerのprocess入力が不正です");
  }
}

function withTerminalShutdown({ owned, stateRoot, request, stopPollIntervalMs, stopAttempts, dependencies }) {
  const baseClose = () => owned.close();
  let closePromise = null;
  return {
    ...owned,
    close() {
      closePromise ??= closeWithTerminal({
        baseClose,
        session: owned.providerRuntime.session,
        stateRoot,
        request,
        stopPollIntervalMs,
        stopAttempts,
        dependencies,
      });
      return closePromise;
    },
  };
}

async function closeWithTerminal({
  baseClose, session, stateRoot, request, stopPollIntervalMs, stopAttempts, dependencies,
}) {
  let stopFailure = null;
  try {
    await ensureCodexTerminal({
      session, stateRoot, request, stopPollIntervalMs, stopAttempts, dependencies,
    });
  } catch (error) {
    stopFailure = error;
  }
  try {
    await baseClose();
  } catch (closeFailure) {
    if (stopFailure !== null) {
      throw new AggregateError([stopFailure, closeFailure], "Codex terminal確認とtransport cleanupが失敗しました");
    }
    throw closeFailure;
  }
  if (stopFailure !== null) throw stopFailure;
}

async function ensureCodexTerminal({
  session, stateRoot, request, stopPollIntervalMs, stopAttempts, dependencies,
}) {
  const read = dependencies.readWatchStatus ?? readWatchStatus;
  const status = await read({ stateRoot, targetId: request.target_id });
  if (status?.watch_id !== request.watch_id || status.provider !== "codex") {
    fail("E_CODEX_PARENT_STOP_IDENTITY_CHANGED", "停止対象watch identityが変化しました");
  }
  if (["stopped", "faulted"].includes(status.status)) return;
  if (!["active", "stopping"].includes(status.status)) {
    fail("E_CODEX_PARENT_STOP_STATE_INVALID", "Codex watchをterminalへ進められません");
  }

  const stopRequest = await (dependencies.requestParentStop ?? requestParentStop)({
    stateRoot,
    targetId: request.target_id,
    watchId: request.watch_id,
    authorization: {
      schema: PARENT_AUTHORIZATION_SCHEMA,
      intent: "stop_observer",
      parent_provider: "codex",
    },
  }, dependencies.parentDependencies);
  let previousInterruptReceipt = null;
  for (let attempt = 0; attempt < stopAttempts; attempt += 1) {
    const stopped = await (dependencies.stopCodexObserver ?? stopCodexObserver)({
      stateRoot,
      request: stopRequest,
      launchRequest: request,
      session,
      previousInterruptReceipt,
    }, dependencies.codexHostDependencies);
    validateStopResult(stopped);
    if (stopped.command_receipt !== null) previousInterruptReceipt = stopped.command_receipt;
    if (stopped.terminal_receipt !== null) {
      await (dependencies.completeParentStop ?? completeParentStop)({
        stateRoot,
        request: stopRequest,
        receipt: stopped.terminal_receipt,
      }, dependencies.parentDependencies);
      return;
    }
    if (attempt + 1 < stopAttempts) {
      await (dependencies.waitForStopPoll ?? waitForStopPoll)(stopPollIntervalMs);
    }
  }
  fail("E_CODEX_PARENT_STOP_TERMINAL_UNKNOWN", "Codex turn terminalをbounded poll内で確認できません");
}

function validateStopResult(value) {
  if (!isPlainObject(value) || Object.keys(value).sort().join(",") !==
      "command_receipt,journal,schema,terminal_receipt,terminal_status" ||
      value.schema !== CODEX_HOST_STOP_RESULT_SCHEMA || !isPlainObject(value.journal) ||
      !(value.command_receipt === null || isPlainObject(value.command_receipt)) ||
      !(value.terminal_receipt === null || isPlainObject(value.terminal_receipt)) ||
      !(value.terminal_status === null || ["completed", "interrupted", "failed"].includes(value.terminal_status)) ||
      (value.terminal_receipt === null) !== (value.terminal_status === null)) {
    fail("E_CODEX_PARENT_STOP_RESULT_INVALID", "Codex stop resultが不正です");
  }
  if (value.terminal_receipt !== null) validateParentHostReceipt(value.terminal_receipt, "stopped");
}

function waitForStopPoll(milliseconds) {
  return new Promise((resolveWait) => {
    const timer = setTimeout(resolveWait, milliseconds);
    timer.unref?.();
  });
}

function validateThroughlineVerification(value, runtimeRoot) {
  if (!isPlainObject(value) || value.schema !== THROUGHLINE_PROCESS_VERIFICATION_SCHEMA ||
      value.runtime_root !== runtimeRoot) {
    fail("E_CODEX_PARENT_THROUGHLINE_INVALID", "Throughline runtime verificationが不正です");
  }
}

function validateCodexVerification(value, runtimeRoot) {
  if (!isPlainObject(value) || value.schema !== CODEX_PROCESS_VERIFICATION_SCHEMA ||
      value.runtime_root !== runtimeRoot) {
    fail("E_CODEX_PARENT_RUNTIME_INVALID", "Codex runtime verificationが不正です");
  }
}

function validateClient(value) {
  if (!value || typeof value.read !== "function" || typeof value.wait !== "function") {
    fail("E_CODEX_PARENT_THROUGHLINE_INVALID", "verified Throughline clientが不正です");
  }
}

function validateCurrentCodexParent(value) {
  if (!isPlainObject(value) || value.schema !== "throughline.observer_read.v1" ||
      !["snapshot", "delta", "thread_switched", "host_switched"].includes(value.status) ||
      value.host !== "codex" || typeof value.thread_sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.thread_sha256)) {
    fail("E_CODEX_PARENT_NOT_CURRENT", "Throughline current parentがCodexではありません");
  }
}

function validateLaunchRequest(value, expected) {
  if (!isPlainObject(value) || value.schema !== PARENT_LAUNCH_REQUEST_SCHEMA ||
      value.provider !== "codex" || value.project_root !== expected.projectRoot ||
      value.runtime_root !== expected.runtimeRoot) {
    fail("E_CODEX_PARENT_LAUNCH_REQUEST_INVALID", "Codex parent launch requestが不正です");
  }
}

function validateOwnedRuntime(value, runtimeRoot) {
  if (!isPlainObject(value) || !isPlainObject(value.providerRuntime) ||
      value.providerRuntime.provider !== "codex" || value.providerRuntime.runtime_root !== runtimeRoot ||
      !value.providerRuntime.session || typeof value.providerRuntime.session.request !== "function" ||
      !(value.providerSignal instanceof AbortSignal) || typeof value.close !== "function" ||
      typeof value.advanceGenerationRollover !== "function" ||
      typeof value.prepareGenerationParentRebind !== "function" ||
      typeof value.advanceGenerationParentRebind !== "function") {
    fail("E_CODEX_PARENT_RUNTIME_INVALID", "Codex Supervisor runtime所有権が不正です");
  }
}

function validateSpawnResult(value, request) {
  if (!isPlainObject(value) || !isPlainObject(value.receipt)) {
    fail("E_CODEX_PARENT_SPAWN_RESULT_INVALID", "Codex spawn resultが不正です");
  }
  validateParentHostReceipt(value.receipt, "spawned");
  requireReceiptIdentity(value.receipt, request, "E_CODEX_PARENT_SPAWN_RESULT_INVALID");
}

function validateActivation(value, request) {
  if (!isPlainObject(value) || !isPlainObject(value.ready_receipt) ||
      value.watch_status?.status !== "active") {
    fail("E_CODEX_PARENT_ACTIVATION_INVALID", "Codex activation resultが不正です");
  }
  validateParentHostReceipt(value.ready_receipt, "ready");
  requireReceiptIdentity(value.ready_receipt, request, "E_CODEX_PARENT_ACTIVATION_INVALID");
}

function requireReceiptIdentity(receipt, request, code) {
  if (receipt.provider !== "codex" || receipt.watch_id !== request.watch_id ||
      receipt.target_id !== request.target_id) {
    fail(code, "Codex host receiptがlaunch requestと一致しません");
  }
}

function validateProcessResult(value) {
  if (!isPlainObject(value) || value.schema !== SUPERVISOR_PROCESS_RESULT_SCHEMA ||
      value.provider !== "codex" || !["cancelled", "faulted", "provider_unavailable", "stopping", "stopped"]
        .includes(value.status) ||
      !(value.cycle_id === null || /^c_[a-f0-9]{64}$/.test(value.cycle_id))) {
    fail("E_CODEX_PARENT_PROCESS_RESULT_INVALID", "Codex Supervisor process resultが不正です");
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}
