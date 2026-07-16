import { isAbsolute } from "node:path";

import {
  AITERM_PROCESS_VERIFICATION_SCHEMA,
  startAitermMcpTransport,
  verifyAitermRuntime,
} from "./aiterm-process-transport.mjs";
import { fail } from "./observer-error.mjs";
import {
  buildAitermClaudeGenerationLaunchRequest,
  validateParentLaunchRequest,
} from "./parent-launch.mjs";
import { runSupervisorProcess } from "./supervisor-process.mjs";
import {
  createVerifiedThroughlineClient,
  verifyThroughlineRuntime,
} from "./throughline-process-runtime.mjs";

export async function runClaudeSupervisorProcess({
  stateRoot,
  target,
  watchId,
  runtimeRoot,
  throughlineCommand,
  aitermCommand,
  planRefs = [],
  testReceipts = [],
  timeoutSeconds = 3600,
  pollIntervalMs = 1_000,
  signal,
} = {}, dependencies = {}) {
  if (![runtimeRoot, throughlineCommand, aitermCommand]
    .every((value) => typeof value === "string" && isAbsolute(value))) {
    fail("E_SUPERVISOR_CLAUDE_PROCESS_INPUT_INVALID", "Claude Supervisor processのruntime pathが不正です");
  }
  const throughlineVerification = await (
    dependencies.verifyThroughlineRuntime ?? verifyThroughlineRuntime
  )({ runtimeRoot, throughlineCommand }, dependencies.throughlineVerificationDependencies);
  const client = (dependencies.createVerifiedThroughlineClient ?? createVerifiedThroughlineClient)({
    verification: throughlineVerification,
  }, dependencies.throughlineClientDependencies);
  const run = dependencies.runSupervisorProcess ?? runSupervisorProcess;
  return run({
    stateRoot,
    target,
    watchId,
    client,
    createProviderRuntime: () => (
      dependencies.createClaudeSupervisorRuntime ?? createClaudeSupervisorRuntime
    )({ stateRoot, target, watchId, runtimeRoot, aitermCommand }, dependencies.claudeRuntimeDependencies),
    planRefs,
    testReceipts,
    timeoutSeconds,
    pollIntervalMs,
    signal,
  }, dependencies.processDependencies);
}

export async function createClaudeSupervisorRuntime({
  stateRoot,
  target,
  watchId,
  runtimeRoot,
  aitermCommand,
  launchRequest = null,
  verification = null,
  sessionLifecycle = "active",
} = {}, dependencies = {}) {
  if (![stateRoot, runtimeRoot, aitermCommand].every((value) => typeof value === "string" && isAbsolute(value)) ||
      !["active", "launching"].includes(sessionLifecycle)) {
    fail("E_SUPERVISOR_CLAUDE_RUNTIME_INPUT_INVALID", "Claude Supervisor runtime入力が不正です");
  }
  const request = launchRequest ?? (
    dependencies.buildAitermClaudeGenerationLaunchRequest ?? buildAitermClaudeGenerationLaunchRequest
  )({ target, watchId, runtimeRoot });
  validateParentLaunchRequest(request);
  if (request.provider !== "claude" || request.target_id !== target?.targetId ||
      request.watch_id !== watchId || request.project_root !== target?.projectRoot ||
      request.runtime_root !== runtimeRoot || request.required_handle_kind !== "claude.session") {
    fail("E_SUPERVISOR_CLAUDE_RUNTIME_INPUT_INVALID", "Claude launch requestがruntime identityと一致しません");
  }
  const checked = verification ?? await (
    dependencies.verifyAitermRuntime ?? verifyAitermRuntime
  )({ runtimeRoot, aitermCommand }, dependencies.verificationDependencies);
  validateAitermVerification(checked, runtimeRoot);

  let transport = null;
  try {
    transport = await (dependencies.startAitermMcpTransport ?? startAitermMcpTransport)(
      { verification: checked },
      dependencies.transportDependencies,
    );
    validateTransport(transport);
    const owned = ownedRuntime({
      runtimeRoot: checked.runtime_root,
      sessionId: request.host.session_name,
      transport,
      closeSession: sessionLifecycle === "active",
    });
    transport = null;
    return owned;
  } catch (error) {
    if (transport !== null && typeof transport.closeAndWait === "function") {
      try {
        await transport.closeAndWait();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Claude Supervisor runtime初期化とcleanupが失敗しました");
      }
    }
    throw error;
  }
}

export function attachClaudeSessionShutdown(owned) {
  validateOwnedRuntime(owned);
  return {
    ...owned,
    close: once(() => closeClaudeRuntime({
      transport: owned.providerRuntime.transport,
      sessionId: owned.providerRuntime.session_id,
      baseClose: owned.close,
    })),
  };
}

function ownedRuntime({ runtimeRoot, sessionId, transport, closeSession }) {
  const baseClose = once(() => transport.closeAndWait());
  const close = closeSession
    ? once(() => closeClaudeRuntime({ transport, sessionId, baseClose }))
    : baseClose;
  return {
    providerRuntime: {
      provider: "claude",
      runtime_root: runtimeRoot,
      session_id: sessionId,
      transport,
    },
    providerSignal: transport.terminationSignal,
    advanceGenerationRollover: async () => {
      fail("E_SUPERVISOR_CLAUDE_ROLLOVER_UNAVAILABLE", "Claude generation rolloverはP5-1b4dまで未実装です");
    },
    prepareGenerationParentRebind: async () => {
      fail("E_SUPERVISOR_CLAUDE_REBIND_UNAVAILABLE", "Claude parent rebindはP5-1b4dまで未実装です");
    },
    advanceGenerationParentRebind: async () => {
      fail("E_SUPERVISOR_CLAUDE_REBIND_UNAVAILABLE", "Claude parent rebindはP5-1b4dまで未実装です");
    },
    close,
  };
}

async function closeClaudeRuntime({ transport, sessionId, baseClose }) {
  let sessionFailure = null;
  try {
    await transport.callTool("pty_close", { session_id: sessionId });
  } catch (error) {
    sessionFailure = error;
  }
  try {
    await baseClose();
  } catch (transportFailure) {
    if (sessionFailure !== null) {
      throw new AggregateError([sessionFailure, transportFailure], "Claude session closeとMCP cleanupが失敗しました");
    }
    throw transportFailure;
  }
  if (sessionFailure !== null) throw sessionFailure;
}

function validateAitermVerification(value, runtimeRoot) {
  if (!isPlainObject(value) || value.schema !== AITERM_PROCESS_VERIFICATION_SCHEMA ||
      value.runtime_root !== runtimeRoot) {
    fail("E_SUPERVISOR_CLAUDE_RUNTIME_INVALID", "Aiterm runtime verificationが不正です");
  }
}

function validateTransport(value) {
  if (!value || typeof value.callTool !== "function" || typeof value.closeAndWait !== "function" ||
      !(value.terminationSignal instanceof AbortSignal)) {
    fail("E_SUPERVISOR_CLAUDE_RUNTIME_INVALID", "Aiterm MCP transport所有権が不正です");
  }
}

function validateOwnedRuntime(value) {
  if (!isPlainObject(value) || !isPlainObject(value.providerRuntime) ||
      value.providerRuntime.provider !== "claude" ||
      typeof value.providerRuntime.session_id !== "string" ||
      !value.providerRuntime.transport || typeof value.providerRuntime.transport.callTool !== "function" ||
      !(value.providerSignal instanceof AbortSignal) || typeof value.close !== "function") {
    fail("E_SUPERVISOR_CLAUDE_RUNTIME_INVALID", "Claude runtime所有権が不正です");
  }
}

function once(operation) {
  let promise = null;
  return () => {
    promise ??= Promise.resolve().then(operation);
    return promise;
  };
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}
