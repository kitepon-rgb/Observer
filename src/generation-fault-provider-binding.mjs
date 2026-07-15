import * as claudeRuntime from "./claude-host-runtime.mjs";
import * as codexRuntime from "./codex-host-runtime.mjs";
import * as faultCore from "./generation-fault.mjs";
import { fail } from "./observer-error.mjs";
import {
  isObserverFaultCode,
  validateParentLaunchRequest,
  validateParentStopRequest,
} from "./parent-launch.mjs";

export const GENERATION_FAULT_PROVIDER_BINDING_RESULT_SCHEMA = "observer.generation_fault_provider_binding_result.v1";

const CODEX_OBSERVATION_REASONS = new Set([
  "journal_missing", "journal_unreadable", "durable_handle_missing", "thread_read_failed",
  "durable_turn_missing", "terminal_status_mismatch", "turn_in_progress", "turn_status_unknown",
]);

export async function advanceGenerationFaultProviderBinding({
  stateRoot,
  target,
  watchId,
  launchRequest,
  verification = null,
  session = null,
} = {}, dependencies = {}) {
  requireInput({ stateRoot, target, watchId, launchRequest });
  const core = dependencies.fault ?? faultCore;
  const providers = {
    claude: dependencies.claudeRuntime ?? claudeRuntime,
    codex: dependencies.codexRuntime ?? codexRuntime,
  };
  const providerDependencies = dependencies.providerDependencies ?? {};
  const status = await core.readGenerationFaultStatus({ stateRoot, targetId: target.targetId, watchId });
  validateStatus(status, { target, watchId, provider: launchRequest.provider });
  if (status.status === "faulted") return result(status, "faulted", "fault_terminal_recorded");
  if (!["authorize_stop", "observe_terminal", "finalize_fault"].includes(status.action)) {
    fail("E_GENERATION_FAULT_PROVIDER_ACTION_INVALID", "provider bindingで実行できないfault actionです");
  }
  const prepared = await core.prepareGenerationFaultStop({ stateRoot, targetId: target.targetId, watchId });
  validatePrepared(prepared, status);
  if (status.provider === "claude") {
    return advanceClaude({
      core, provider: providers.claude, providerDependencies: providerDependencies.claude,
      stateRoot, target, watchId, launchRequest, verification, status, prepared,
    });
  }
  return advanceCodex({
    core, provider: providers.codex, providerDependencies: providerDependencies.codex,
    stateRoot, target, watchId, launchRequest, session, status, prepared,
  });
}

async function advanceClaude({
  core, provider, providerDependencies, stateRoot, target, watchId, launchRequest, verification, status, prepared,
}) {
  const observed = await provider.observeClaudeObserver({
    request: launchRequest,
    receipt: hostReceipt(launchRequest, prepared.stop_request.handle, "spawned"),
    verification,
  }, providerDependencies);
  if (observed?.observation === null || observed?.observation === undefined) {
    return result(status, "unknown", "provider_terminal_unavailable");
  }
  if (["done", "stopped", "failed"].includes(observed.observation.state)) {
    return confirm({ core, stateRoot, target, watchId, status, receipt: hostReceipt(launchRequest, prepared.stop_request.handle, "stopped") });
  }
  if (!["working", "blocked"].includes(observed.observation.state)) {
    return result(status, "unknown", "provider_state_unknown");
  }
  if (prepared.action !== "issue_once") return result(status, "pending", "terminal_not_observed");
  const stopped = await provider.stopClaudeObserver({
    request: prepared.stop_request,
    observation: observed.observation,
    verification,
  }, providerDependencies);
  if (stopped?.terminal_receipt !== null && stopped?.terminal_receipt !== undefined) {
    return confirm({ core, stateRoot, target, watchId, status, receipt: stopped.terminal_receipt });
  }
  return result(status, "progressed", "stop_issued");
}

async function advanceCodex({
  core, provider, providerDependencies, stateRoot, target, watchId, launchRequest, session, status, prepared,
}) {
  const observed = await provider.observeCodexGenerationTerminal({
    stateRoot,
    request: launchRequest,
    session,
    generationId: status.generation_id,
  }, providerDependencies);
  if (observed?.outcome === "terminal") {
    const stopped = await provider.stopCodexObserver({
      stateRoot,
      request: prepared.stop_request,
      launchRequest,
      session,
      generationId: status.generation_id,
    }, providerDependencies);
    if (stopped?.terminal_receipt === null || stopped?.terminal_receipt === undefined) {
      return result(status, "unknown", "terminal_receipt_unavailable");
    }
    return confirm({ core, stateRoot, target, watchId, status, receipt: stopped.terminal_receipt });
  }
  if (observed?.outcome !== "pending") {
    return result(status, "unknown", boundedReason(observed?.reason, "provider_terminal_unknown"));
  }
  if (prepared.action !== "issue_once") return result(status, "pending", boundedReason(observed.reason, "terminal_not_observed"));
  const stopped = await provider.stopCodexObserver({
    stateRoot,
    request: prepared.stop_request,
    launchRequest,
    session,
    generationId: status.generation_id,
  }, providerDependencies);
  if (stopped?.terminal_receipt !== null && stopped?.terminal_receipt !== undefined) {
    return confirm({ core, stateRoot, target, watchId, status, receipt: stopped.terminal_receipt });
  }
  return result(status, "progressed", "stop_issued");
}

async function confirm({ core, stateRoot, target, watchId, status, receipt }) {
  await core.confirmGenerationFaultTerminal({ stateRoot, targetId: target.targetId, watchId, terminalReceipt: receipt });
  return result(status, "faulted", "fault_terminal_recorded", "faulted");
}

function validateStatus(value, { target, watchId, provider }) {
  const keys = [
    "action", "fault_code", "generation_id", "parent_epoch_id", "provider", "schema",
    "source_generation_status", "status", "target_id", "watch_id",
  ];
  if (!isPlain(value) || Object.keys(value).sort().join(",") !== keys.sort().join(",") ||
      value.schema !== "observer.generation_fault_status.v1" || value.target_id !== target.targetId ||
      value.watch_id !== watchId || value.provider !== provider || !/^sha256:[a-f0-9]{64}$/.test(value.generation_id) ||
      !/^sha256:[a-f0-9]{64}$/.test(value.parent_epoch_id) || !isObserverFaultCode(value.fault_code) ||
      !["active", "rollover_requested", "rebind_required", "stopping", "terminal_confirmed", "starting"].includes(value.source_generation_status) ||
      !["fault_recorded", "stop_authorized", "terminal_observed", "faulted"].includes(value.status) ||
      ({ fault_recorded: "authorize_stop", stop_authorized: "observe_terminal", terminal_observed: "finalize_fault", faulted: "faulted" })[value.status] !== value.action) {
    fail("E_GENERATION_FAULT_PROVIDER_STATUS_INVALID", "generation fault statusがprovider bindingと一致しません");
  }
}

function validatePrepared(value, status) {
  if (!isPlain(value) || Object.keys(value).sort().join(",") !== "action,schema,status,stop_request" || value.schema !== "observer.generation_fault_result.v1" ||
      !["issue_once", "observe_only"].includes(value.action) || !isPlain(value.stop_request) ||
      value.stop_request.provider !== status.provider || value.stop_request.target_id !== status.target_id ||
      value.stop_request.watch_id !== status.watch_id || value.stop_request.fault_code !== status.fault_code) {
    fail("E_GENERATION_FAULT_PROVIDER_PREPARE_INVALID", "fault stop preparationがprovider bindingと一致しません");
  }
  validateParentStopRequest(value.stop_request);
  validateStatus(value.status, {
    target: { targetId: status.target_id }, watchId: status.watch_id, provider: status.provider,
  });
  if (value.status.generation_id !== status.generation_id || value.status.parent_epoch_id !== status.parent_epoch_id ||
      value.status.fault_code !== status.fault_code) {
    fail("E_GENERATION_FAULT_PROVIDER_PREPARE_INVALID", "fault stop statusがread結果と一致しません");
  }
}

function hostReceipt(request, handle, outcome) {
  return {
    schema: "observer.host_receipt.v1",
    provider: request.provider,
    target_id: request.target_id,
    watch_id: request.watch_id,
    outcome,
    handle: structuredClone(handle),
  };
}

function result(status, outcome, reason, phase = status.status) {
  return {
    schema: GENERATION_FAULT_PROVIDER_BINDING_RESULT_SCHEMA,
    provider: status.provider,
    target_id: status.target_id,
    watch_id: status.watch_id,
    phase,
    outcome,
    reason,
  };
}

function boundedReason(value, fallback) {
  return CODEX_OBSERVATION_REASONS.has(value) ? value : fallback;
}

function requireInput({ stateRoot, target, watchId, launchRequest }) {
  if (typeof stateRoot !== "string" || !isPlain(target) || typeof target.targetId !== "string" ||
      typeof target.projectRoot !== "string" || typeof watchId !== "string" || !isPlain(launchRequest) ||
      launchRequest.target_id !== target.targetId || launchRequest.watch_id !== watchId ||
      launchRequest.project_root !== target.projectRoot || !["claude", "codex"].includes(launchRequest.provider)) {
    fail("E_GENERATION_FAULT_PROVIDER_INPUT_INVALID", "generation fault provider binding入力が不正です");
  }
  validateParentLaunchRequest(launchRequest);
}

function isPlain(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
