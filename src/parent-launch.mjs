import { isAbsolute } from "node:path";

import { fail } from "./observer-error.mjs";
import { canonicalDirectory } from "./private-state.mjs";
import { registerProjectTarget } from "./project-target.mjs";
import {
  activateWatch,
  attachWatchLaunchHandle,
  completeWatchStop,
  readWatchStatus,
  recordWatchFaultAfterChildExit,
  recordWatchFaultBeforeChildStart,
  requestWatchStop,
  reserveActiveWatch,
} from "./watch-store.mjs";

export const PARENT_AUTHORIZATION_SCHEMA = "observer.parent_authorization.v1";
export const PARENT_LAUNCH_REQUEST_SCHEMA = "observer.parent_launch_request.v1";
export const CHILD_START_SCHEMA = "observer.child_start.v1";
export const HOST_RECEIPT_SCHEMA = "observer.host_receipt.v1";
export const CODEX_TURN_TERMINAL_SCHEMA = "observer.codex_turn_terminal.v1";
export const PARENT_STOP_REQUEST_SCHEMA = "observer.parent_stop_request.v1";

const TARGET_ID_RE = /^p_[a-f0-9]{64}$/;
const WATCH_ID_RE = /^w_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CODEX_THREAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CODEX_TURN_ID_RE = CODEX_THREAD_ID_RE;
const CLAUDE_JOB_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const LAUNCH_FAULT_CODES = new Set([
  "E_OBSERVER_LAUNCH_FAILED",
  "E_OBSERVER_ROUTING_FAILED",
  "E_OBSERVER_LAUNCH_CORRELATION_FAILED",
  "E_OBSERVER_LAUNCH_CONFIRM_FAILED",
]);

export async function prepareParentLaunch({
  stateRoot,
  projectRoot,
  runtimeRoot,
  authorization,
  expectedPreviousWatchId = null,
} = {}, dependencies = {}) {
  const provider = validateAuthorization(authorization, "start_observer");
  const canonicalRuntimeRoot = await (dependencies.canonicalDirectory ?? canonicalDirectory)(runtimeRoot);
  const registered = await (dependencies.registerProjectTarget ?? registerProjectTarget)({ stateRoot, projectRoot });
  const target = publicTarget(registered);
  const starting = await (dependencies.reserveActiveWatch ?? reserveActiveWatch)({
    stateRoot,
    target,
    provider,
    expectedPreviousWatchId,
  });
  return launchRequest({ target, starting, provider, runtimeRoot: canonicalRuntimeRoot });
}

export async function confirmParentLaunch({ stateRoot, request, receipt } = {}, dependencies = {}) {
  validateLaunchRequest(request);
  validateHostReceipt(receipt, "ready");
  requireReceiptMatches(request, receipt);
  return (dependencies.activateWatch ?? activateWatch)({
    stateRoot,
    targetId: request.target_id,
    watchId: request.watch_id,
    launchHandle: structuredClone(receipt.handle),
  });
}

export async function confirmParentHostSpawn({ stateRoot, request, receipt } = {}, dependencies = {}) {
  validateLaunchRequest(request);
  validateHostReceipt(receipt, "spawned");
  requireReceiptMatches(request, receipt);
  return (dependencies.attachWatchLaunchHandle ?? attachWatchLaunchHandle)({
    stateRoot,
    targetId: request.target_id,
    watchId: request.watch_id,
    launchHandle: structuredClone(receipt.handle),
  });
}

export async function recordParentLaunchFailure({
  stateRoot,
  request,
  faultCode = "E_OBSERVER_LAUNCH_FAILED",
} = {}, dependencies = {}) {
  validateLaunchRequest(request);
  if (!LAUNCH_FAULT_CODES.has(faultCode)) fail("E_PARENT_LAUNCH_FAULT_INVALID", "launch fault codeが不正です");
  return (dependencies.recordWatchFaultBeforeChildStart ?? recordWatchFaultBeforeChildStart)({
    stateRoot,
    targetId: request.target_id,
    watchId: request.watch_id,
    faultCode,
  });
}

export async function requestParentStop({ stateRoot, targetId, watchId, authorization } = {}, dependencies = {}) {
  const provider = validateAuthorization(authorization, "stop_observer");
  validateTargetId(targetId);
  validateWatchId(watchId);
  const current = await (dependencies.readWatchStatus ?? readWatchStatus)({ stateRoot, targetId });
  if (current === null || current.watch_id !== watchId) fail("E_WATCH_STATE_CHANGED", "停止対象watchが一致しません");
  if (current.provider !== provider) fail("E_PARENT_PROVIDER_MISMATCH", "現在親とObserver providerが一致しません");
  const stopping = await (dependencies.requestWatchStop ?? requestWatchStop)({ stateRoot, targetId, watchId });
  return stopRequest({ status: stopping.status, handle: stopping.launchHandle, terminal: "stopped", faultCode: null });
}

export async function requestParentLaunchFailureCleanup({ stateRoot, request, receipt, faultCode } = {}, dependencies = {}) {
  validateLaunchRequest(request);
  validateHostReceipt(receipt, ["spawned", "ready"]);
  requireReceiptMatches(request, receipt);
  if (!LAUNCH_FAULT_CODES.has(faultCode)) fail("E_PARENT_LAUNCH_FAULT_INVALID", "launch fault codeが不正です");
  const stopping = await (dependencies.requestWatchStop ?? requestWatchStop)({
    stateRoot,
    targetId: request.target_id,
    watchId: request.watch_id,
    expectedLaunchHandle: structuredClone(receipt.handle),
  });
  return stopRequest({ status: stopping.status, handle: stopping.launchHandle, terminal: "faulted", faultCode });
}

export async function completeParentStop({ stateRoot, request, receipt } = {}, dependencies = {}) {
  validateStopRequest(request);
  validateHostReceipt(receipt, "stopped");
  requireReceiptMatches(request, receipt);
  const stopping = await (dependencies.requestWatchStop ?? requestWatchStop)({
    stateRoot,
    targetId: request.target_id,
    watchId: request.watch_id,
    expectedLaunchHandle: structuredClone(request.handle),
  });
  if (request.terminal === "faulted") {
    return (dependencies.recordWatchFaultAfterChildExit ?? recordWatchFaultAfterChildExit)({
      stateRoot,
      targetId: request.target_id,
      watchId: request.watch_id,
      faultCode: request.fault_code,
    });
  }
  return (dependencies.completeWatchStop ?? completeWatchStop)({ stateRoot, targetId: request.target_id, watchId: request.watch_id });
}

export function validateParentLaunchRequest(value) {
  return validateLaunchRequest(value);
}

export function validateParentStopRequest(value) {
  return validateStopRequest(value);
}

function launchRequest({ target, starting, provider, runtimeRoot }) {
  const childStart = {
    schema: CHILD_START_SCHEMA,
    mode: "observe",
    provider,
    watch_id: starting.watch_id,
    target_id: target.targetId,
    project_root: target.projectRoot,
    runtime_root: runtimeRoot,
  };
  const host = provider === "codex"
    ? {
        kind: "codex.app_server_thread.v1",
        cwd: runtimeRoot,
        approval_policy: "never",
        sandbox: "read-only",
        ephemeral: false,
        service_name: "observer",
      }
    : {
        kind: "claude.background_agent.v1",
        agent: "observer",
        name: claudeJobNameFor(target.targetId, starting.watch_id),
        cwd: runtimeRoot,
      };
  const request = {
    schema: PARENT_LAUNCH_REQUEST_SCHEMA,
    provider,
    watch_id: starting.watch_id,
    target_id: target.targetId,
    project_root: target.projectRoot,
    runtime_root: runtimeRoot,
    required_handle_kind: handleKindFor(provider),
    host,
    child_start: childStart,
  };
  return validateLaunchRequest(request);
}

function stopRequest({ status, handle, terminal, faultCode }) {
  const request = {
    schema: PARENT_STOP_REQUEST_SCHEMA,
    provider: status.provider,
    watch_id: status.watch_id,
    target_id: status.target_id,
    project_root: status.project_root,
    handle: structuredClone(handle),
    terminal,
    fault_code: faultCode,
  };
  return validateStopRequest(request);
}

function validateAuthorization(value, expectedIntent) {
  requirePlainObject(value, "parent authorization", "E_PARENT_AUTHORIZATION_REQUIRED");
  requireExactKeys(value, ["intent", "parent_provider", "schema"], "parent authorization", "E_PARENT_AUTHORIZATION_REQUIRED");
  if (value.schema !== PARENT_AUTHORIZATION_SCHEMA || value.intent !== expectedIntent || !isProvider(value.parent_provider)) {
    fail("E_PARENT_AUTHORIZATION_REQUIRED", "利用者の明示指示を受けた現在親のauthorizationが必要です");
  }
  return value.parent_provider;
}

function validateLaunchRequest(value) {
  requirePlainObject(value, "launch request", "E_PARENT_LAUNCH_SCHEMA");
  requireExactKeys(value, [
    "child_start", "host", "project_root", "provider", "required_handle_kind",
    "runtime_root", "schema", "target_id", "watch_id",
  ], "launch request", "E_PARENT_LAUNCH_SCHEMA");
  if (value.schema !== PARENT_LAUNCH_REQUEST_SCHEMA || !isProvider(value.provider)) fail("E_PARENT_LAUNCH_SCHEMA", "launch request schemaが不正です");
  validateTargetId(value.target_id);
  validateWatchId(value.watch_id);
  validateAbsolutePath(value.project_root, "project root", "E_PARENT_LAUNCH_SCHEMA");
  validateAbsolutePath(value.runtime_root, "runtime root", "E_PARENT_LAUNCH_SCHEMA");
  if (value.required_handle_kind !== handleKindFor(value.provider)) fail("E_PARENT_LAUNCH_SCHEMA", "launch handle kindがproviderと一致しません");
  validateChildStart(value.child_start, value);
  validateHostRequest(value.host, value);
  return value;
}

function validateChildStart(value, request) {
  requirePlainObject(value, "child start", "E_PARENT_LAUNCH_SCHEMA");
  requireExactKeys(value, ["mode", "project_root", "provider", "runtime_root", "schema", "target_id", "watch_id"], "child start", "E_PARENT_LAUNCH_SCHEMA");
  if (value.schema !== CHILD_START_SCHEMA || value.mode !== "observe" || value.provider !== request.provider ||
      value.watch_id !== request.watch_id || value.target_id !== request.target_id ||
      value.project_root !== request.project_root || value.runtime_root !== request.runtime_root) {
    fail("E_PARENT_LAUNCH_SCHEMA", "child startがlaunch requestと一致しません");
  }
}

function validateHostRequest(value, request) {
  requirePlainObject(value, "host launch request", "E_PARENT_LAUNCH_SCHEMA");
  if (request.provider === "codex") {
    requireExactKeys(value, ["approval_policy", "cwd", "ephemeral", "kind", "sandbox", "service_name"], "Codex host request", "E_PARENT_LAUNCH_SCHEMA");
    if (value.kind !== "codex.app_server_thread.v1" || value.cwd !== request.runtime_root || value.approval_policy !== "never" ||
        value.sandbox !== "read-only" || value.ephemeral !== false || value.service_name !== "observer") {
      fail("E_PARENT_LAUNCH_SCHEMA", "Codex host requestが不正です");
    }
    return;
  }
  requireExactKeys(value, ["agent", "cwd", "kind", "name"], "Claude host request", "E_PARENT_LAUNCH_SCHEMA");
  if (value.kind !== "claude.background_agent.v1" || value.agent !== "observer" || value.name !== claudeJobNameFor(request.target_id, request.watch_id) || value.cwd !== request.runtime_root) {
    fail("E_PARENT_LAUNCH_SCHEMA", "Claude host requestが不正です");
  }
}

export function claudeJobNameFor(targetId, watchId) {
  validateTargetId(targetId);
  validateWatchId(watchId);
  return `observer-${targetId.slice(2, 14)}-${watchId.slice(2)}`;
}

function validateStopRequest(value) {
  requirePlainObject(value, "stop request", "E_PARENT_STOP_SCHEMA");
  requireExactKeys(value, ["fault_code", "handle", "project_root", "provider", "schema", "target_id", "terminal", "watch_id"], "stop request", "E_PARENT_STOP_SCHEMA");
  if (value.schema !== PARENT_STOP_REQUEST_SCHEMA || !isProvider(value.provider)) fail("E_PARENT_STOP_SCHEMA", "stop request schemaが不正です");
  validateTargetId(value.target_id);
  validateWatchId(value.watch_id);
  validateAbsolutePath(value.project_root, "project root", "E_PARENT_STOP_SCHEMA");
  validateHandle(value.handle, value.provider, "E_PARENT_STOP_SCHEMA");
  if (value.terminal === "stopped") {
    if (value.fault_code !== null) fail("E_PARENT_STOP_SCHEMA", "通常stop requestにfault codeを指定できません");
  } else if (value.terminal === "faulted") {
    if (!LAUNCH_FAULT_CODES.has(value.fault_code)) fail("E_PARENT_STOP_SCHEMA", "launch cleanup fault codeが不正です");
  } else fail("E_PARENT_STOP_SCHEMA", "stop terminalが不正です");
  return value;
}

function validateHostReceipt(value, expectedOutcome) {
  requirePlainObject(value, "host receipt", "E_PARENT_HOST_RECEIPT");
  const accepted = Array.isArray(expectedOutcome) ? expectedOutcome : [expectedOutcome];
  const codexTerminal = value?.provider === "codex" && value?.outcome === "stopped";
  requireExactKeys(value, ["handle", "outcome", "provider", "schema", "target_id", "watch_id", ...(codexTerminal ? ["terminal"] : [])], "host receipt", "E_PARENT_HOST_RECEIPT");
  if (value.schema !== HOST_RECEIPT_SCHEMA || !accepted.includes(value.outcome) || !isProvider(value.provider)) fail("E_PARENT_HOST_RECEIPT", "host receiptが不正です");
  validateTargetId(value.target_id);
  validateWatchId(value.watch_id);
  validateHandle(value.handle, value.provider, "E_PARENT_HOST_RECEIPT");
  if (codexTerminal) validateCodexTerminal(value.terminal, value.handle.value);
}

function requireReceiptMatches(request, receipt) {
  if (receipt.provider !== request.provider || receipt.watch_id !== request.watch_id || receipt.target_id !== request.target_id) {
    fail("E_PARENT_HOST_RECEIPT_MISMATCH", "host receiptがrequestと一致しません");
  }
  const expected = request.required_handle_kind ?? handleKindFor(request.provider);
  if (receipt.handle.kind !== expected) fail("E_PARENT_HOST_RECEIPT_MISMATCH", "host receipt handle kindがrequestと一致しません");
  if (receipt.terminal !== undefined && receipt.terminal.thread_id !== receipt.handle.value) {
    fail("E_PARENT_STOP_HANDLE_MISMATCH", "Codex terminal threadが保存済みhandleと一致しません");
  }
  if (request.handle !== undefined && !sameHandle(request.handle, receipt.handle)) {
    fail("E_PARENT_STOP_HANDLE_MISMATCH", "stop receipt handleがrequestと一致しません");
  }
}

function validateHandle(value, provider, code) {
  requirePlainObject(value, "host handle", code);
  requireExactKeys(value, ["kind", "value"], "host handle", code);
  if (value.kind !== handleKindFor(provider) || typeof value.value !== "string") fail(code, "host handleがproviderと一致しません");
  if (provider === "codex" ? !CODEX_THREAD_ID_RE.test(value.value) : !CLAUDE_JOB_ID_RE.test(value.value)) fail(code, "host handle valueが不正です");
}

function validateCodexTerminal(value, expectedThreadId) {
  requirePlainObject(value, "Codex turn terminal", "E_PARENT_HOST_RECEIPT");
  requireExactKeys(value, ["observed_at", "schema", "status", "thread_id", "turn_id"], "Codex turn terminal", "E_PARENT_HOST_RECEIPT");
  if (value.schema !== CODEX_TURN_TERMINAL_SCHEMA || value.thread_id !== expectedThreadId ||
      !CODEX_THREAD_ID_RE.test(value.thread_id) || !CODEX_TURN_ID_RE.test(value.turn_id) ||
      !["completed", "interrupted", "failed"].includes(value.status) || !isCanonicalTimestamp(value.observed_at)) {
    fail("E_PARENT_HOST_RECEIPT", "Codex turn terminalが不正です");
  }
}

function publicTarget(value) {
  return { schema: value.schema, targetId: value.targetId, projectRoot: value.projectRoot };
}

function handleKindFor(provider) {
  return provider === "codex" ? "codex.thread" : "claude.job";
}

function isProvider(value) {
  return value === "codex" || value === "claude";
}

function validateTargetId(value) {
  if (typeof value !== "string" || !TARGET_ID_RE.test(value)) fail("E_PARENT_TARGET_INVALID", "target IDが不正です");
}

function validateWatchId(value) {
  if (typeof value !== "string" || !WATCH_ID_RE.test(value)) fail("E_PARENT_WATCH_INVALID", "watch IDが不正です");
}

function validateAbsolutePath(value, field, code) {
  if (typeof value !== "string" || !isAbsolute(value) || /[\u0000-\u001f\u007f]/u.test(value)) fail(code, `${field}が不正です`);
}

function sameHandle(left, right) {
  return left?.kind === right?.kind && left?.value === right?.value;
}

function isCanonicalTimestamp(value) {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function requirePlainObject(value, field, code) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(code, `${field}はplain objectである必要があります`);
}

function requireExactKeys(value, expected, field, code) {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) fail(code, `${field}に未知または不足fieldがあります`);
}
