import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";

import {
  AITERM_PROCESS_VERIFICATION_SCHEMA,
  startAitermMcpTransport,
  verifyAitermRuntime,
} from "./aiterm-process-transport.mjs";
import { closeAitermClaudeSession } from "./aiterm-claude-host-runtime.mjs";
import { readCycleState } from "./cycle-store.mjs";
import { advanceGenerationHostProviderRollover } from "./generation-host-provider-binding.mjs";
import { authorizeGenerationParentRebind } from "./generation-parent-rebind.mjs";
import { advanceGenerationParentRebindProviderBinding } from "./generation-parent-rebind-provider-binding.mjs";
import { readGenerationState } from "./generation-store.mjs";
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
import { readWatchHostBinding } from "./watch-store.mjs";

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

  const ownedRequest = sessionLifecycle === "active"
    ? await requestForActiveClaudeBinding({
        stateRoot,
        target,
        watchId,
        request,
      }, dependencies)
    : request;

  let transport = null;
  try {
    transport = await (dependencies.startAitermMcpTransport ?? startAitermMcpTransport)(
      { verification: checked },
      dependencies.transportDependencies,
    );
    validateTransport(transport);
    const owned = ownedRuntime({
      stateRoot,
      target,
      watchId,
      runtimeRoot: checked.runtime_root,
      launchRequest: ownedRequest,
      transport,
      closeSession: sessionLifecycle === "active",
      dependencies,
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

async function requestForActiveClaudeBinding({ stateRoot, target, watchId, request }, dependencies) {
  const binding = await (dependencies.readWatchHostBinding ?? readWatchHostBinding)({
    stateRoot,
    targetId: target.targetId,
    watchId,
  });
  if (!isPlainObject(binding) || binding.status !== "active" || binding.provider !== "claude" ||
      binding.target_id !== target.targetId || binding.watch_id !== watchId ||
      binding.project_root !== target.projectRoot || binding.launch_handle?.kind !== "claude.session" ||
      typeof binding.launch_handle.value !== "string") {
    fail("E_SUPERVISOR_CLAUDE_BINDING_INVALID", "active Claude session bindingが不正です");
  }
  const rebound = {
    ...structuredClone(request),
    host: {
      ...structuredClone(request.host),
      session_name: binding.launch_handle.value,
    },
  };
  validateParentLaunchRequest(rebound);
  return rebound;
}

export function attachClaudeSessionShutdown(owned) {
  validateOwnedRuntime(owned);
  if (typeof owned.enableSessionShutdown !== "function") {
    fail("E_SUPERVISOR_CLAUDE_RUNTIME_INVALID", "Claude session shutdown所有権を有効化できません");
  }
  owned.enableSessionShutdown();
  return owned;
}

function ownedRuntime({ stateRoot, target, watchId, runtimeRoot, launchRequest, transport, closeSession, dependencies }) {
  const baseClose = once(() => transport.closeAndWait());
  const providerRuntime = {
    provider: "claude",
    runtime_root: runtimeRoot,
    session_id: launchRequest.host.session_name,
    transport,
  };
  const ownedSessions = new Set([launchRequest.host.session_name]);
  let sessionShutdown = closeSession;
  const prepareGenerationParentRebind = async ({ cycleId, proposedParent } = {}) => {
    if (proposedParent?.host !== "claude") {
      fail("E_SUPERVISOR_CLAUDE_REBIND_PROVIDER_UNAVAILABLE", "Claude runtimeはcross-provider rebindを実行できません");
    }
    return (dependencies.authorizeGenerationParentRebind ?? authorizeGenerationParentRebind)({
      stateRoot,
      target,
      watchId,
      cycleId,
      proposedParent,
    }, dependencies.parentRebindDependencies);
  };
  const runtime = {
    providerRuntime,
    providerSignal: transport.terminationSignal,
    advanceGenerationRollover: async () => {
      const request = await rolloverLaunchRequest({
        stateRoot,
        target,
        watchId,
        runtimeRoot,
        activeRequest: launchRequest,
      }, dependencies);
      const result = await (
        dependencies.advanceGenerationHostProviderRollover ?? advanceGenerationHostProviderRollover
      )({
        stateRoot,
        targetId: target.targetId,
        watchId,
        launchRequest: request,
        session: transport,
      }, dependencies.rolloverDependencies);
      applyClaudeSessionTransition({ result, request, providerRuntime, ownedSessions });
      return result;
    },
    prepareGenerationParentRebind,
    advanceGenerationParentRebind: async () => {
      const cycle = await (dependencies.readCycleState ?? readCycleState)({
        stateRoot,
        targetId: target.targetId,
      });
      const pending = cycle?.pending_cycle;
      if (!pending || pending.status !== "prepared" || pending.proposed_state?.host !== "claude") {
        fail("E_SUPERVISOR_CLAUDE_REBIND_CYCLE_INVALID", "Claude parent rebindにprepared Claude cycleが必要です");
      }
      const authorized = await prepareGenerationParentRebind({
        cycleId: pending.cycle_id,
        proposedParent: pending.proposed_state,
      });
      const request = (dependencies.buildAitermClaudeGenerationLaunchRequest ?? buildAitermClaudeGenerationLaunchRequest)({
        target,
        watchId,
        runtimeRoot,
        sessionInstanceId: claudeSessionInstanceId({
          watchId,
          parentEpochId: authorized.authorization.to_parent_epoch_id,
          sequence: 1,
        }),
      });
      const result = await (
        dependencies.advanceGenerationParentRebindProviderBinding ?? advanceGenerationParentRebindProviderBinding
      )({
        stateRoot,
        target,
        watchId,
        authorization: authorized.authorization,
        launchRequest: request,
        oldSession: transport,
        newSession: transport,
      }, dependencies.parentRebindBindingDependencies);
      applyClaudeSessionTransition({ result, request, providerRuntime, ownedSessions });
      return result;
    },
    close: once(async () => {
      const sessionFailures = [];
      if (sessionShutdown) {
        for (const sessionId of [...ownedSessions].reverse()) {
          try {
            await (dependencies.closeAitermClaudeSession ?? closeAitermClaudeSession)({
              stateRoot,
              targetId: target.targetId,
              watchId,
              sessionId,
              transport,
            }, dependencies.closeSessionDependencies);
          } catch (error) {
            sessionFailures.push(error);
          }
        }
      }
      try {
        await baseClose();
      } catch (transportFailure) {
        if (sessionFailures.length > 0) {
          throw new AggregateError([...sessionFailures, transportFailure], "Claude session closeとMCP cleanupが失敗しました");
        }
        throw transportFailure;
      }
      if (sessionFailures.length === 1) throw sessionFailures[0];
      if (sessionFailures.length > 1) throw new AggregateError(sessionFailures, "Claude session cleanupが失敗しました");
    }),
  };
  Object.defineProperty(runtime, "enableSessionShutdown", {
    enumerable: false,
    value: () => { sessionShutdown = true; },
  });
  return runtime;
}

async function rolloverLaunchRequest({
  stateRoot,
  target,
  watchId,
  runtimeRoot,
  activeRequest,
}, dependencies) {
  const generation = await (dependencies.readGenerationState ?? readGenerationState)({
    stateRoot,
    targetId: target.targetId,
  });
  if (!isPlainObject(generation) || generation.provider !== "claude" ||
      generation.target_id !== target.targetId || generation.watch_id !== watchId ||
      !["active", "rollover_requested", "stopping", "terminal_confirmed", "starting"].includes(generation.status)) {
    fail("E_SUPERVISOR_CLAUDE_GENERATION_INVALID", "Claude rollover generation identityが不正です");
  }
  if (!["terminal_confirmed", "starting"].includes(generation.status)) return activeRequest;
  const sequence = generation.status === "terminal_confirmed" ? generation.sequence + 1 : generation.sequence;
  return (dependencies.buildAitermClaudeGenerationLaunchRequest ?? buildAitermClaudeGenerationLaunchRequest)({
    target,
    watchId,
    runtimeRoot,
    sessionInstanceId: claudeSessionInstanceId({
      watchId,
      parentEpochId: generation.parent_epoch_id,
      sequence,
    }),
  });
}

function claudeSessionInstanceId({ watchId, parentEpochId, sequence }) {
  if (typeof watchId !== "string" || typeof parentEpochId !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(parentEpochId) || !Number.isSafeInteger(sequence) || sequence < 1) {
    fail("E_SUPERVISOR_CLAUDE_GENERATION_INVALID", "Claude session instance identityが不正です");
  }
  return `sha256:${createHash("sha256").update(
    `observer.aiterm_claude_session.v1\0${watchId}\0${parentEpochId}\0${sequence}`,
    "utf8",
  ).digest("hex")}`;
}

function applyClaudeSessionTransition({ result, request, providerRuntime, ownedSessions }) {
  if (!isPlainObject(result) || !isPlainObject(request?.host) || typeof request.host.session_name !== "string") return;
  if (["spawn_issued", "spawn_recorded", "provider_ready_recovered"].includes(result.reason) || result.outcome === "activated") {
    ownedSessions.add(request.host.session_name);
  }
  if (result.outcome === "activated") providerRuntime.session_id = request.host.session_name;
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
