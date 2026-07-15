import { isAbsolute } from "node:path";

import { fail } from "./observer-error.mjs";
import {
  completeParentStop,
  confirmParentHostSpawn,
  confirmParentLaunch,
  PARENT_AUTHORIZATION_SCHEMA,
  prepareParentLaunch,
  requestParentStop,
} from "./parent-launch.mjs";
import { readRegisteredProjectTarget } from "./project-target.mjs";
import { readWatchStatus } from "./watch-store.mjs";

export const PARENT_WATCH_CONTEXT_SCHEMA = "observer.parent_watch_context.v1";
export const WATCH_COMMAND_RESULT_SCHEMA = "observer.watch_command_result.v1";

const PROVIDERS = new Set(["claude", "codex"]);
const WATCH_STATUSES = new Set([
  "starting", "launching", "active", "stopping", "stopped", "faulted",
]);
const ACTION_STATUSES = Object.freeze({
  start: new Set(["provider_unavailable", "starting", "launching", "active"]),
  status: new Set(["not_started", ...WATCH_STATUSES]),
  stop: new Set(["provider_unavailable", "stopping", "stopped"]),
});
const TARGET_ID_RE = /^p_[a-f0-9]{64}$/;
const WATCH_ID_RE = /^w_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FAULT_CODE_RE = /^E_[A-Z0-9_]{1,127}$/;

export async function startObserverWatch({ stateRoot, projectRoot, parentContext } = {}, dependencies = {}) {
  validateCommandPaths(stateRoot, projectRoot);
  const context = validateParentWatchContext(parentContext, "start_observer");
  const adapter = selectHostAdapter(dependencies.hostActions, context.parentProvider, "start");
  if (adapter === null) return watchResult("start", "provider_unavailable", context.parentProvider, null);

  const request = await (dependencies.prepareParentLaunch ?? prepareParentLaunch)({
    stateRoot,
    projectRoot,
    runtimeRoot: context.runtimeRoot,
    authorization: context.authorization,
    expectedPreviousWatchId: context.expectedPreviousWatchId,
  });
  const spawnedReceipt = await adapter.spawn({ stateRoot, request });
  if (spawnedReceipt === null) {
    const watch = await readCurrentWatch({ stateRoot, request }, dependencies);
    return watchResult("start", watch.status, watch.provider, watch);
  }
  await (dependencies.confirmParentHostSpawn ?? confirmParentHostSpawn)({
    stateRoot,
    request,
    receipt: spawnedReceipt,
  });
  const readyReceipt = await adapter.ready({ stateRoot, request, spawnedReceipt });
  if (readyReceipt === null) {
    const watch = await readCurrentWatch({ stateRoot, request }, dependencies);
    return watchResult("start", watch.status, watch.provider, watch);
  }
  const active = await (dependencies.confirmParentLaunch ?? confirmParentLaunch)({
    stateRoot,
    request,
    receipt: readyReceipt,
  });
  return watchResult("start", active.status, active.provider, active);
}

export async function readObserverWatchStatus({ stateRoot, projectRoot } = {}, dependencies = {}) {
  validateCommandPaths(stateRoot, projectRoot);
  const target = await (dependencies.readRegisteredProjectTarget ?? readRegisteredProjectTarget)({
    stateRoot,
    projectRoot,
  });
  const watch = await (dependencies.readWatchStatus ?? readWatchStatus)({
    stateRoot,
    targetId: target.targetId,
  });
  return watch === null
    ? watchResult("status", "not_started", null, null)
    : watchResult("status", watch.status, watch.provider, watch);
}

export async function stopObserverWatch({ stateRoot, projectRoot, parentContext } = {}, dependencies = {}) {
  validateCommandPaths(stateRoot, projectRoot);
  const context = validateParentWatchContext(parentContext, "stop_observer");
  const target = await (dependencies.readRegisteredProjectTarget ?? readRegisteredProjectTarget)({
    stateRoot,
    projectRoot,
  });
  const current = await (dependencies.readWatchStatus ?? readWatchStatus)({
    stateRoot,
    targetId: target.targetId,
  });
  if (current === null) fail("E_WATCH_NOT_FOUND", "watch stateがありません");
  if (current.provider !== context.parentProvider) {
    fail("E_PARENT_PROVIDER_MISMATCH", "現在親とObserver providerが一致しません");
  }
  const adapter = selectHostAdapter(dependencies.hostActions, context.parentProvider, "stop");
  if (adapter === null) {
    return watchResult("stop", "provider_unavailable", current.provider, current);
  }

  const request = await (dependencies.requestParentStop ?? requestParentStop)({
    stateRoot,
    targetId: target.targetId,
    watchId: current.watch_id,
    authorization: context.authorization,
  });
  const terminalReceipt = await adapter.stop({ stateRoot, request });
  if (terminalReceipt === null) {
    const stopping = await (dependencies.readWatchStatus ?? readWatchStatus)({
      stateRoot,
      targetId: target.targetId,
    });
    return watchResult("stop", stopping.status, stopping.provider, stopping);
  }
  const stopped = await (dependencies.completeParentStop ?? completeParentStop)({
    stateRoot,
    request,
    receipt: terminalReceipt,
  });
  return watchResult("stop", stopped.status, stopped.provider, stopped);
}

export function validateWatchCommandResult(value) {
  requirePlainObject(value, "watch command result", "E_WATCH_COMMAND_RESULT_INVALID");
  requireExactKeys(value, ["action", "provider", "schema", "status", "watch"], "E_WATCH_COMMAND_RESULT_INVALID");
  if (value.schema !== WATCH_COMMAND_RESULT_SCHEMA || !Object.hasOwn(ACTION_STATUSES, value.action) ||
      !ACTION_STATUSES[value.action].has(value.status) ||
      (value.provider !== null && !PROVIDERS.has(value.provider))) {
    fail("E_WATCH_COMMAND_RESULT_INVALID", "watch command resultが不正です");
  }
  if (value.watch === null) {
    const unavailable = value.action === "start" && value.status === "provider_unavailable" &&
      PROVIDERS.has(value.provider);
    const notStarted = value.action === "status" && value.status === "not_started" && value.provider === null;
    if (!unavailable && !notStarted) {
      fail("E_WATCH_COMMAND_RESULT_INVALID", "watch command resultにstatusがありません");
    }
    return value;
  }
  validatePublicWatch(value.watch);
  if (value.provider !== value.watch.provider ||
      (value.status !== "provider_unavailable" && value.status !== value.watch.status)) {
    fail("E_WATCH_COMMAND_RESULT_INVALID", "watch command resultとstatusが一致しません");
  }
  return value;
}

function validateParentWatchContext(value, intent) {
  requirePlainObject(value, "parent watch context", "E_PARENT_WATCH_CONTEXT_REQUIRED");
  requireExactKeys(value, [
    "authorization", "expected_previous_watch_id", "parent_provider", "runtime_root", "schema",
  ], "E_PARENT_WATCH_CONTEXT_REQUIRED");
  requirePlainObject(value.authorization, "parent authorization", "E_PARENT_WATCH_CONTEXT_REQUIRED");
  requireExactKeys(value.authorization, ["intent", "parent_provider", "schema"], "E_PARENT_WATCH_CONTEXT_REQUIRED");
  const previousIdValid = value.expected_previous_watch_id === null ||
    WATCH_ID_RE.test(value.expected_previous_watch_id);
  if (value.schema !== PARENT_WATCH_CONTEXT_SCHEMA || !PROVIDERS.has(value.parent_provider) ||
      typeof value.runtime_root !== "string" || !isAbsolute(value.runtime_root) ||
      !previousIdValid || (intent === "stop_observer" && value.expected_previous_watch_id !== null) ||
      value.authorization.schema !== PARENT_AUTHORIZATION_SCHEMA || value.authorization.intent !== intent ||
      value.authorization.parent_provider !== value.parent_provider) {
    fail("E_PARENT_WATCH_CONTEXT_REQUIRED", "現在親のexact watch contextが必要です");
  }
  return {
    authorization: value.authorization,
    expectedPreviousWatchId: value.expected_previous_watch_id,
    parentProvider: value.parent_provider,
    runtimeRoot: value.runtime_root,
  };
}

function selectHostAdapter(hostActions, provider, action) {
  if (hostActions === undefined || hostActions === null || hostActions[provider] === undefined ||
      hostActions[provider]?.available === false) return null;
  const adapter = hostActions[provider];
  requirePlainObject(adapter, "parent host adapter", "E_PARENT_HOST_ACTION_INVALID");
  if (adapter.provider !== provider || adapter.available !== true) {
    fail("E_PARENT_HOST_ACTION_INVALID", "parent host adapterがproviderと一致しません");
  }
  if (action === "start" && (typeof adapter.spawn !== "function" || typeof adapter.ready !== "function")) {
    fail("E_PARENT_HOST_ACTION_INVALID", "parent host adapterにstart actionがありません");
  }
  if (action === "stop" && typeof adapter.stop !== "function") {
    fail("E_PARENT_HOST_ACTION_INVALID", "parent host adapterにstop actionがありません");
  }
  return adapter;
}

async function readCurrentWatch({ stateRoot, request }, dependencies) {
  const watch = await (dependencies.readWatchStatus ?? readWatchStatus)({
    stateRoot,
    targetId: request.target_id,
  });
  if (watch === null || watch.watch_id !== request.watch_id) {
    fail("E_WATCH_STATE_CHANGED", "起動対象watchが一致しません");
  }
  return watch;
}

function watchResult(action, status, provider, watch) {
  return validateWatchCommandResult({
    schema: WATCH_COMMAND_RESULT_SCHEMA,
    action,
    status,
    provider,
    watch: watch === null ? null : structuredClone(watch),
  });
}

function validatePublicWatch(value) {
  requirePlainObject(value, "watch status", "E_WATCH_COMMAND_RESULT_INVALID");
  requireExactKeys(value, [
    "created_at", "fault_code", "project_root", "provider", "schema", "status",
    "target_id", "updated_at", "watch_id",
  ], "E_WATCH_COMMAND_RESULT_INVALID");
  if (value.schema !== "observer.watch_status.v1" || !WATCH_ID_RE.test(value.watch_id) ||
      !TARGET_ID_RE.test(value.target_id) || typeof value.project_root !== "string" ||
      !isAbsolute(value.project_root) || !PROVIDERS.has(value.provider) ||
      !WATCH_STATUSES.has(value.status) || !isTimestamp(value.created_at) ||
      !isTimestamp(value.updated_at) || Date.parse(value.updated_at) < Date.parse(value.created_at) ||
      (value.status === "faulted" ? !FAULT_CODE_RE.test(value.fault_code) : value.fault_code !== null)) {
    fail("E_WATCH_COMMAND_RESULT_INVALID", "watch statusが不正です");
  }
}

function validateCommandPaths(stateRoot, projectRoot) {
  if (typeof stateRoot !== "string" || !isAbsolute(stateRoot)) {
    fail("E_PATH_NOT_ABSOLUTE", "state rootは絶対パスで指定してください");
  }
  if (typeof projectRoot !== "string" || !isAbsolute(projectRoot)) {
    fail("E_PROJECT_PATH_NOT_ABSOLUTE", "project rootは絶対パスで指定してください");
  }
}

function isTimestamp(value) {
  if (typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = Date.parse(value);
  return !Number.isNaN(parsed) && new Date(parsed).toISOString() === value;
}

function requirePlainObject(value, field, code) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    fail(code, `${field}はplain objectである必要があります`);
  }
}

function requireExactKeys(value, expected, code) {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) {
    fail(code, "未知または不足fieldがあります");
  }
}
