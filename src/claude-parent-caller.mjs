import { isAbsolute } from "node:path";

import {
  AITERM_CLAUDE_STOP_RESULT_SCHEMA,
  activateAitermClaudeObserver,
  recoverAitermClaudeSpawn,
  spawnAitermClaudeObserver,
  stopAitermClaudeObserver,
} from "./aiterm-claude-host-runtime.mjs";
import {
  AITERM_PROCESS_VERIFICATION_SCHEMA,
  verifyAitermRuntime,
} from "./aiterm-process-transport.mjs";
import { fail } from "./observer-error.mjs";
import {
  PARENT_LAUNCH_REQUEST_SCHEMA,
  completeParentStop,
  prepareAitermClaudeParentLaunch,
  recordParentLaunchFailure,
  requestParentLaunchFailureCleanup,
  validateParentHostReceipt,
} from "./parent-launch.mjs";
import {
  OBSERVER_PRODUCT_DIAGNOSTICS_SCHEMA,
  runObserverProductDiagnostics,
} from "./product-diagnostics.mjs";
import {
  attachClaudeSessionShutdown,
  createClaudeSupervisorRuntime,
} from "./supervisor-claude-process.mjs";
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

export const CLAUDE_PARENT_CALLER_RESULT_SCHEMA = "observer.claude_parent_caller_result.v1";

export async function runClaudeParentWatchProcess({
  stateRoot,
  projectRoot,
  runtimeRoot,
  throughlineCommand,
  aitermCommand,
  parentContext,
  planRefs = [],
  testReceipts = [],
  timeoutSeconds = 3600,
  pollIntervalMs = 1_000,
  signal,
} = {}, dependencies = {}) {
  validatePaths({ stateRoot, projectRoot, runtimeRoot, throughlineCommand, aitermCommand });
  validateProcessOptions({ planRefs, testReceipts, timeoutSeconds, pollIntervalMs, signal });
  const context = validateParentWatchContext(parentContext, "start_observer");
  if (context.parentProvider !== "claude" || context.runtimeRoot !== runtimeRoot) {
    fail("E_CLAUDE_PARENT_CONTEXT_MISMATCH", "現在Claude親のruntime contextが一致しません");
  }

  const product = await (dependencies.runProductDiagnostics ?? runObserverProductDiagnostics)(
    { packageRoot: runtimeRoot },
  );
  if (product?.schema !== OBSERVER_PRODUCT_DIAGNOSTICS_SCHEMA || product.status !== "ready") {
    fail("E_CLAUDE_PARENT_PRODUCT_NOT_READY", "Observer productがreadyではありません");
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

  const aitermVerification = await (
    dependencies.verifyAitermRuntime ?? verifyAitermRuntime
  )({ runtimeRoot, aitermCommand }, dependencies.aitermVerificationDependencies);
  validateAitermVerification(aitermVerification, runtimeRoot);

  const parent = await client.read({ projectPath: projectRoot, signal });
  validateCurrentClaudeParent(parent);

  const request = await (
    dependencies.prepareAitermClaudeParentLaunch ?? prepareAitermClaudeParentLaunch
  )({
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
  let spawnReceipt = null;
  let activationConfirmed = false;
  try {
    try {
      owned = await (dependencies.createClaudeSupervisorRuntime ?? createClaudeSupervisorRuntime)({
        stateRoot,
        target,
        watchId: request.watch_id,
        runtimeRoot,
        aitermCommand,
        launchRequest: request,
        verification: aitermVerification,
        sessionLifecycle: "launching",
      }, dependencies.claudeRuntimeDependencies);
      validateOwnedRuntime(owned, request);
    } catch (error) {
      await recordPreSpawnFailure({ stateRoot, request, error }, dependencies);
      throw error;
    }

    let spawnResult;
    try {
      spawnResult = await (dependencies.spawnAitermClaudeObserver ?? spawnAitermClaudeObserver)({
        stateRoot,
        request,
        transport: owned.providerRuntime.transport,
      }, dependencies.claudeHostDependencies);
    } catch (launchError) {
      try {
        const recovered = await (dependencies.recoverAitermClaudeSpawn ?? recoverAitermClaudeSpawn)({
          stateRoot,
          request,
          transport: owned.providerRuntime.transport,
        }, dependencies.claudeHostDependencies);
        spawnResult = { receipt: recovered.receipt };
      } catch (recoveryError) {
        throw new AggregateError([launchError, recoveryError], "Claude initial launchとexact recoveryが失敗しました");
      }
    }
    validateSpawnResult(spawnResult, request);
    spawnReceipt = structuredClone(spawnResult.receipt);

    const activation = await (
      dependencies.activateAitermClaudeObserver ?? activateAitermClaudeObserver
    )({
      stateRoot,
      request,
      receipt: spawnResult.receipt,
      parentThreadSha256: parent.thread_sha256,
    }, dependencies.claudeHostDependencies);
    validateActivation(activation, request);
    activationConfirmed = true;
    owned = (dependencies.attachClaudeSessionShutdown ?? attachClaudeSessionShutdown)(owned);

    const run = dependencies.runSupervisorProcess ?? runSupervisorProcess;
    const processResult = await run({
      stateRoot,
      target,
      watchId: request.watch_id,
      client,
      createProviderRuntime: async () => {
        if (claimed) fail("E_CLAUDE_PARENT_RUNTIME_ALREADY_CLAIMED", "Claude runtime所有権は既にSupervisorへ渡されています");
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
      schema: CLAUDE_PARENT_CALLER_RESULT_SCHEMA,
      status: processResult.status,
      provider: "claude",
      cycle_id: processResult.cycle_id,
    };
  } catch (error) {
    primaryFailure = error;
    if (owned !== null && !claimed && spawnReceipt !== null && !activationConfirmed) {
      try {
        await cleanupFailedClaudeLaunch({ owned, stateRoot, request, spawnReceipt, dependencies });
      } catch (cleanupFailure) {
        primaryFailure = new AggregateError(
          [error, cleanupFailure],
          "Claude pre-ready失敗とlaunch cleanupが失敗しました",
        );
        throw primaryFailure;
      }
    }
    throw error;
  } finally {
    if (owned !== null && !claimed && typeof owned.close === "function") {
      try {
        await owned.close();
      } catch (cleanupFailure) {
        if (primaryFailure !== null) {
          throw new AggregateError(
            [primaryFailure, cleanupFailure],
            "Claude parent caller失敗後のcleanupも失敗しました",
          );
        }
        throw cleanupFailure;
      }
    }
  }
}

async function cleanupFailedClaudeLaunch({ owned, stateRoot, request, spawnReceipt, dependencies }) {
  const stopRequest = await (
    dependencies.requestParentLaunchFailureCleanup ?? requestParentLaunchFailureCleanup
  )({
    stateRoot,
    request,
    receipt: spawnReceipt,
    faultCode: "E_OBSERVER_LAUNCH_CONFIRM_FAILED",
  }, dependencies.parentDependencies);
  const stopped = await (dependencies.stopAitermClaudeObserver ?? stopAitermClaudeObserver)({
    stateRoot,
    request: stopRequest,
    transport: owned.providerRuntime.transport,
  }, dependencies.claudeHostDependencies);
  validateClaudeStopResult(stopped, stopRequest);
  await (dependencies.completeParentStop ?? completeParentStop)({
    stateRoot,
    request: stopRequest,
    receipt: stopped.terminal_receipt,
  }, dependencies.parentDependencies);
}

async function recordPreSpawnFailure({ stateRoot, request, error }, dependencies) {
  try {
    await (dependencies.recordParentLaunchFailure ?? recordParentLaunchFailure)({
      stateRoot,
      request,
      faultCode: "E_OBSERVER_LAUNCH_FAILED",
    }, dependencies.parentDependencies);
  } catch (recordError) {
    throw new AggregateError([error, recordError], "Claude runtime起動失敗とwatch fault記録が失敗しました");
  }
}

function validatePaths({ stateRoot, projectRoot, runtimeRoot, throughlineCommand, aitermCommand }) {
  if (![stateRoot, projectRoot, runtimeRoot, throughlineCommand, aitermCommand]
    .every((value) => typeof value === "string" && isAbsolute(value))) {
    fail("E_CLAUDE_PARENT_CALLER_INPUT_INVALID", "Claude parent callerのpath入力が不正です");
  }
}

function validateProcessOptions({ planRefs, testReceipts, timeoutSeconds, pollIntervalMs, signal }) {
  if (!Array.isArray(planRefs) || !Array.isArray(testReceipts) ||
      !Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600 ||
      !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 100 || pollIntervalMs > 60_000 ||
      (signal !== undefined && !(signal instanceof AbortSignal))) {
    fail("E_CLAUDE_PARENT_CALLER_INPUT_INVALID", "Claude parent callerのprocess入力が不正です");
  }
}

function validateThroughlineVerification(value, runtimeRoot) {
  if (!isPlainObject(value) || value.schema !== THROUGHLINE_PROCESS_VERIFICATION_SCHEMA ||
      value.runtime_root !== runtimeRoot) {
    fail("E_CLAUDE_PARENT_THROUGHLINE_INVALID", "Throughline runtime verificationが不正です");
  }
}

function validateAitermVerification(value, runtimeRoot) {
  if (!isPlainObject(value) || value.schema !== AITERM_PROCESS_VERIFICATION_SCHEMA ||
      value.runtime_root !== runtimeRoot) {
    fail("E_CLAUDE_PARENT_RUNTIME_INVALID", "Aiterm runtime verificationが不正です");
  }
}

function validateClient(value) {
  if (!value || typeof value.read !== "function" || typeof value.wait !== "function") {
    fail("E_CLAUDE_PARENT_THROUGHLINE_INVALID", "verified Throughline clientが不正です");
  }
}

function validateCurrentClaudeParent(value) {
  if (!isPlainObject(value) || value.schema !== "throughline.observer_read.v1" ||
      !["snapshot", "delta", "thread_switched", "host_switched"].includes(value.status) ||
      value.host !== "claude" || typeof value.thread_sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.thread_sha256)) {
    fail("E_CLAUDE_PARENT_NOT_CURRENT", "Throughline current parentがClaudeではありません");
  }
}

function validateLaunchRequest(value, expected) {
  if (!isPlainObject(value) || value.schema !== PARENT_LAUNCH_REQUEST_SCHEMA ||
      value.provider !== "claude" || value.project_root !== expected.projectRoot ||
      value.runtime_root !== expected.runtimeRoot || value.required_handle_kind !== "claude.session") {
    fail("E_CLAUDE_PARENT_LAUNCH_REQUEST_INVALID", "Claude parent launch requestが不正です");
  }
}

function validateOwnedRuntime(value, request) {
  if (!isPlainObject(value) || !isPlainObject(value.providerRuntime) ||
      value.providerRuntime.provider !== "claude" ||
      value.providerRuntime.runtime_root !== request.runtime_root ||
      value.providerRuntime.session_id !== request.host.session_name ||
      !value.providerRuntime.transport || typeof value.providerRuntime.transport.callTool !== "function" ||
      !(value.providerSignal instanceof AbortSignal) || typeof value.close !== "function" ||
      typeof value.advanceGenerationRollover !== "function" ||
      typeof value.prepareGenerationParentRebind !== "function" ||
      typeof value.advanceGenerationParentRebind !== "function") {
    fail("E_CLAUDE_PARENT_RUNTIME_INVALID", "Claude Supervisor runtime所有権が不正です");
  }
}

function validateSpawnResult(value, request) {
  if (!isPlainObject(value) || !isPlainObject(value.receipt)) {
    fail("E_CLAUDE_PARENT_SPAWN_RESULT_INVALID", "Claude spawn resultが不正です");
  }
  validateParentHostReceipt(value.receipt, "spawned");
  requireReceiptIdentity(value.receipt, request, "E_CLAUDE_PARENT_SPAWN_RESULT_INVALID");
}

function validateActivation(value, request) {
  if (!isPlainObject(value) || !isPlainObject(value.ready_receipt) ||
      value.watch_status?.status !== "active" || value.generation?.status !== "active" ||
      value.generation?.provider !== "claude" || value.generation?.target_id !== request.target_id ||
      value.generation?.watch_id !== request.watch_id) {
    fail("E_CLAUDE_PARENT_ACTIVATION_INVALID", "Claude activation resultが不正です");
  }
  validateParentHostReceipt(value.ready_receipt, "ready");
  requireReceiptIdentity(value.ready_receipt, request, "E_CLAUDE_PARENT_ACTIVATION_INVALID");
}

function validateClaudeStopResult(value, request) {
  if (!isPlainObject(value) || Object.keys(value).sort().join(",") !==
      "schema,stop_command_receipt,terminal_receipt" ||
      value.schema !== AITERM_CLAUDE_STOP_RESULT_SCHEMA ||
      !isPlainObject(value.stop_command_receipt) || !isPlainObject(value.terminal_receipt)) {
    fail("E_CLAUDE_PARENT_STOP_RESULT_INVALID", "Claude pre-ready stop resultが不正です");
  }
  validateParentHostReceipt(value.terminal_receipt, "stopped");
  if (value.terminal_receipt.provider !== request.provider ||
      value.terminal_receipt.watch_id !== request.watch_id ||
      value.terminal_receipt.target_id !== request.target_id ||
      value.terminal_receipt.handle?.kind !== request.handle.kind ||
      value.terminal_receipt.handle.value !== request.handle.value) {
    fail("E_CLAUDE_PARENT_STOP_RESULT_INVALID", "Claude pre-ready stop identityが一致しません");
  }
}

function requireReceiptIdentity(receipt, request, code) {
  if (receipt.provider !== "claude" || receipt.watch_id !== request.watch_id ||
      receipt.target_id !== request.target_id || receipt.handle?.kind !== "claude.session" ||
      receipt.handle.value !== request.host.session_name) {
    fail(code, "Claude host receiptがlaunch requestと一致しません");
  }
}

function validateProcessResult(value) {
  if (!isPlainObject(value) || value.schema !== SUPERVISOR_PROCESS_RESULT_SCHEMA ||
      value.provider !== "claude" || !["cancelled", "faulted", "provider_unavailable", "stopping", "stopped"]
        .includes(value.status) ||
      !(value.cycle_id === null || /^c_[a-f0-9]{64}$/.test(value.cycle_id))) {
    fail("E_CLAUDE_PARENT_PROCESS_RESULT_INVALID", "Claude Supervisor process resultが不正です");
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}
