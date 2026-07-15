import { randomUUID } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";

import { ObserverError, fail } from "./observer-error.mjs";
import {
  acquirePrivateLock,
  assertPrivateDirectory,
  assertWithin,
  atomicCreatePrivateFile,
  atomicReplacePrivateFile,
  ensureStatePath,
  inspectPrivateLock,
  readPrivateJson,
  recoverPrivateLock,
} from "./private-state.mjs";
import { TARGET_SCHEMA } from "./project-target.mjs";

export const ACTIVE_WATCH_SCHEMA = "observer.active_watch.v1";
export const WATCH_STATUS_SCHEMA = "observer.watch_status.v1";

const TARGET_ID_RE = /^p_[a-f0-9]{64}$/;
const WATCH_ID_RE = /^w_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HANDLE_KIND_RE = /^[a-z][a-z0-9._-]{0,63}$/;
const FAULT_CODE_RE = /^E_[A-Z0-9_]{1,127}$/;
const LIVE_STATUSES = new Set(["starting", "launching", "active", "stopping"]);
const TERMINAL_STATUSES = new Set(["stopped", "faulted"]);
const STATE_KEYS = [
  "created_at", "fault_code", "launch_handle", "project_root", "provider",
  "schema", "status", "target_id", "updated_at", "watch_id",
];

export async function reserveActiveWatch({ stateRoot, target, provider, expectedPreviousWatchId = null }, dependencies = {}) {
  validateTarget(target);
  validateProvider(provider);
  validateOptionalWatchId(expectedPreviousWatchId, "expected previous watch ID");
  const paths = await watchPaths(stateRoot, target.targetId, { create: true });
  return withWatchTransaction(paths.lockPath, async () => {
    const previous = await readCurrent(paths.currentPath);
    if (previous && LIVE_STATUSES.has(previous.status)) {
      fail("E_WATCH_ALREADY_ACTIVE", "このtargetには既にactive watchがあります", publicWatchStatus(previous));
    }
    if ((previous?.watch_id ?? null) !== expectedPreviousWatchId) {
      fail("E_WATCH_STATE_CHANGED", "watch stateがcallerの観測後に変化しました");
    }
    const timestamp = currentTimestamp(dependencies.now);
    const state = validateWatchState({
      schema: ACTIVE_WATCH_SCHEMA,
      watch_id: `w_${(dependencies.randomUUID ?? randomUUID)()}`,
      target_id: target.targetId,
      project_root: target.projectRoot,
      provider,
      status: "starting",
      created_at: timestamp,
      updated_at: timestamp,
      launch_handle: null,
      fault_code: null,
    });
    if (previous === null) await atomicCreatePrivateFile(paths.currentPath, serialize(state));
    else await atomicReplacePrivateFile(paths.currentPath, serialize(state));
    return publicWatchStatus(state);
  });
}

export async function activateWatch({ stateRoot, targetId, watchId, launchHandle }, dependencies = {}) {
  validateTargetId(targetId);
  validateWatchId(watchId);
  validateLaunchHandle(launchHandle);
  const paths = await requireWatchPaths(stateRoot, targetId);
  return withWatchTransaction(paths.lockPath, async () => {
    const current = await requireCurrent(paths.currentPath);
    requireTransition(current, watchId, ["launching"]);
    if (!sameLaunchHandle(current.launch_handle, launchHandle)) fail("E_WATCH_LAUNCH_HANDLE_MISMATCH", "保存済みlaunch handleが一致しません");
    const next = validateWatchState({
      ...current,
      status: "active",
      updated_at: nextTimestamp(current, dependencies.now),
    });
    await atomicReplacePrivateFile(paths.currentPath, serialize(next));
    return publicWatchStatus(next);
  });
}

export async function attachWatchLaunchHandle({ stateRoot, targetId, watchId, launchHandle }, dependencies = {}) {
  validateTargetId(targetId);
  validateWatchId(watchId);
  validateLaunchHandle(launchHandle);
  const paths = await requireWatchPaths(stateRoot, targetId);
  return withWatchTransaction(paths.lockPath, async () => {
    const current = await requireCurrent(paths.currentPath);
    requireTransition(current, watchId, ["starting", "launching"]);
    if (current.status === "launching") {
      if (!sameLaunchHandle(current.launch_handle, launchHandle)) fail("E_WATCH_LAUNCH_HANDLE_MISMATCH", "保存済みlaunch handleが一致しません");
      return publicWatchStatus(current);
    }
    const next = validateWatchState({
      ...current,
      status: "launching",
      updated_at: nextTimestamp(current, dependencies.now),
      launch_handle: structuredClone(launchHandle),
    });
    await atomicReplacePrivateFile(paths.currentPath, serialize(next));
    return publicWatchStatus(next);
  });
}

export async function requestWatchStop({ stateRoot, targetId, watchId, expectedLaunchHandle = null }, dependencies = {}) {
  validateTargetId(targetId);
  validateWatchId(watchId);
  if (expectedLaunchHandle !== null) validateLaunchHandle(expectedLaunchHandle);
  const paths = await requireWatchPaths(stateRoot, targetId);
  return withWatchTransaction(paths.lockPath, async () => {
    const current = await requireCurrent(paths.currentPath);
    requireTransition(current, watchId, ["launching", "active", "stopping"]);
    if (expectedLaunchHandle !== null && !sameLaunchHandle(current.launch_handle, expectedLaunchHandle)) {
      fail("E_WATCH_LAUNCH_HANDLE_MISMATCH", "保存済みlaunch handleが一致しません");
    }
    if (current.status === "stopping") {
      return { status: publicWatchStatus(current), launchHandle: structuredClone(current.launch_handle) };
    }
    const next = validateWatchState({
      ...current,
      status: "stopping",
      updated_at: nextTimestamp(current, dependencies.now),
    });
    await atomicReplacePrivateFile(paths.currentPath, serialize(next));
    return { status: publicWatchStatus(next), launchHandle: structuredClone(next.launch_handle) };
  });
}

export async function completeWatchStop({ stateRoot, targetId, watchId }, dependencies = {}) {
  return terminalTransition({
    stateRoot, targetId, watchId, expectedStatuses: ["stopping"], status: "stopped", faultCode: null,
  }, dependencies);
}

export async function recordWatchFaultAfterChildExit({ stateRoot, targetId, watchId, faultCode }, dependencies = {}) {
  validateFaultCode(faultCode);
  return terminalTransition({
    stateRoot, targetId, watchId, expectedStatuses: ["launching", "active", "stopping"], status: "faulted", faultCode,
  }, dependencies);
}

export async function recordWatchFaultBeforeChildStart({ stateRoot, targetId, watchId, faultCode }, dependencies = {}) {
  validateFaultCode(faultCode);
  return terminalTransition({
    stateRoot, targetId, watchId, expectedStatuses: ["starting"], status: "faulted", faultCode,
  }, dependencies);
}

export async function readWatchStatus({ stateRoot, targetId }) {
  validateTargetId(targetId);
  const paths = await watchPaths(stateRoot, targetId);
  if (paths === null) return null;
  const current = await readCurrent(paths.currentPath);
  return current === null ? null : publicWatchStatus(current);
}

export async function inspectWatchTransactionLock({ stateRoot, targetId }) {
  validateTargetId(targetId);
  const paths = await watchPaths(stateRoot, targetId);
  if (paths === null) return null;
  return inspectPrivateLock(paths.lockPath);
}

export async function recoverWatchTransactionLock({ stateRoot, targetId, expectedNonce }) {
  validateTargetId(targetId);
  if (typeof expectedNonce !== "string" || expectedNonce.length === 0) {
    fail("E_WATCH_LOCK_NONCE_INVALID", "観測済みwatch lock nonceが必要です");
  }
  const paths = await watchPaths(stateRoot, targetId);
  if (paths === null) return false;
  return recoverPrivateLock(paths.lockPath, expectedNonce);
}

export function validateWatchState(state) {
  requirePlainObject(state, "watch state");
  requireExactKeys(state, STATE_KEYS, "watch state");
  if (state.schema !== ACTIVE_WATCH_SCHEMA) fail("E_WATCH_STATE_SCHEMA", "未対応のwatch state schemaです");
  validateWatchId(state.watch_id);
  validateTargetId(state.target_id);
  if (!isAbsolute(state.project_root)) fail("E_WATCH_STATE_SCHEMA", "watch project rootが不正です");
  validateProvider(state.provider);
  if (![...LIVE_STATUSES, ...TERMINAL_STATUSES].includes(state.status)) fail("E_WATCH_STATE_SCHEMA", "watch statusが不正です");
  validateTimestamp(state.created_at, "created_at");
  validateTimestamp(state.updated_at, "updated_at");
  if (Date.parse(state.updated_at) < Date.parse(state.created_at)) fail("E_WATCH_STATE_SCHEMA", "watch timestampの順序が不正です");
  if (["launching", "active", "stopping"].includes(state.status)) validateLaunchHandle(state.launch_handle);
  else if (state.launch_handle !== null) fail("E_WATCH_STATE_SCHEMA", "このwatch statusにはlaunch handleを保存できません");
  if (state.status === "faulted") {
    if (typeof state.fault_code !== "string" || !FAULT_CODE_RE.test(state.fault_code)) fail("E_WATCH_STATE_SCHEMA", "faulted watchに固定fault codeがありません");
  } else if (state.fault_code !== null) fail("E_WATCH_STATE_SCHEMA", "faulted以外へfault codeを保存できません");
  return state;
}

function publicWatchStatus(state) {
  validateWatchState(state);
  return {
    schema: WATCH_STATUS_SCHEMA,
    watch_id: state.watch_id,
    target_id: state.target_id,
    project_root: state.project_root,
    provider: state.provider,
    status: state.status,
    created_at: state.created_at,
    updated_at: state.updated_at,
    fault_code: state.fault_code,
  };
}

async function terminalTransition({ stateRoot, targetId, watchId, expectedStatuses, status, faultCode }, dependencies) {
  validateTargetId(targetId);
  validateWatchId(watchId);
  const paths = await requireWatchPaths(stateRoot, targetId);
  return withWatchTransaction(paths.lockPath, async () => {
    const current = await requireCurrent(paths.currentPath);
    requireTransition(current, watchId, expectedStatuses);
    const next = validateWatchState({
      ...current,
      status,
      updated_at: nextTimestamp(current, dependencies.now),
      launch_handle: null,
      fault_code: faultCode,
    });
    await atomicReplacePrivateFile(paths.currentPath, serialize(next));
    return publicWatchStatus(next);
  });
}

async function watchPaths(stateRoot, targetId, { create = false } = {}) {
  if (create) {
    const directory = await ensureStatePath(stateRoot, "watches", targetId);
    return { currentPath: join(directory, "current.json"), lockPath: join(directory, "transaction.lock") };
  }
  if (!isAbsolute(stateRoot)) fail("E_PATH_NOT_ABSOLUTE", "state rootは絶対パスである必要があります");
  const root = resolve(stateRoot);
  const watches = assertWithin(root, join(root, "watches"));
  const directory = assertWithin(root, join(watches, targetId));
  try {
    await assertPrivateDirectory(root);
    await assertPrivateDirectory(watches);
    await assertPrivateDirectory(directory);
  } catch (error) {
    if (error instanceof ObserverError && error.code === "E_STATE_DIRECTORY_MISSING") return null;
    throw error;
  }
  return { currentPath: join(directory, "current.json"), lockPath: join(directory, "transaction.lock") };
}

async function requireWatchPaths(stateRoot, targetId) {
  const paths = await watchPaths(stateRoot, targetId);
  if (paths === null) fail("E_WATCH_NOT_FOUND", "watch stateがありません");
  return paths;
}

async function readCurrent(currentPath) {
  try {
    return validateWatchState(await readPrivateJson(currentPath));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function requireCurrent(currentPath) {
  const state = await readCurrent(currentPath);
  if (state === null) fail("E_WATCH_NOT_FOUND", "watch stateがありません");
  return state;
}

async function withWatchTransaction(lockPath, operation) {
  let release;
  try {
    release = await acquirePrivateLock(lockPath);
  } catch (error) {
    if (error instanceof ObserverError && error.code === "E_CONSUMER_LOCKED") {
      fail("E_WATCH_TRANSACTION_LOCKED", "別のwatch transactionが進行中です");
    }
    throw error;
  }
  let primaryError = null;
  try {
    return await operation();
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await release();
    } catch (releaseError) {
      if (primaryError !== null) throw new AggregateError([primaryError, releaseError], "watch transactionとlock解放の両方に失敗しました");
      throw releaseError;
    }
  }
}

function requireTransition(current, watchId, expectedStatuses) {
  if (current.watch_id !== watchId) fail("E_WATCH_STATE_CHANGED", "別のwatchへ遷移しようとしました");
  if (!expectedStatuses.includes(current.status)) fail("E_WATCH_TRANSITION_INVALID", "現在statusから要求されたwatch遷移はできません");
}

function sameLaunchHandle(left, right) {
  return left?.kind === right?.kind && left?.value === right?.value;
}

function validateTarget(target) {
  requirePlainObject(target, "project target", "E_WATCH_TARGET_INVALID");
  if (target.schema !== TARGET_SCHEMA || !TARGET_ID_RE.test(target.targetId) || !isAbsolute(target.projectRoot)) {
    fail("E_WATCH_TARGET_INVALID", "project targetが不正です");
  }
}

function validateTargetId(targetId) {
  if (typeof targetId !== "string" || !TARGET_ID_RE.test(targetId)) fail("E_WATCH_TARGET_INVALID", "watch target IDが不正です");
}

function validateProvider(provider) {
  if (!["codex", "claude"].includes(provider)) fail("E_WATCH_PROVIDER_INVALID", "watch providerが不正です");
}

function validateWatchId(watchId) {
  if (typeof watchId !== "string" || !WATCH_ID_RE.test(watchId)) fail("E_WATCH_ID_INVALID", "watch IDが不正です");
}

function validateOptionalWatchId(watchId, field) {
  if (watchId !== null && (typeof watchId !== "string" || !WATCH_ID_RE.test(watchId))) fail("E_WATCH_ID_INVALID", `${field}が不正です`);
}

function validateFaultCode(faultCode) {
  if (typeof faultCode !== "string" || !FAULT_CODE_RE.test(faultCode)) fail("E_WATCH_FAULT_CODE_INVALID", "watch fault codeが不正です");
}

function validateLaunchHandle(handle) {
  requirePlainObject(handle, "launch handle");
  requireExactKeys(handle, ["kind", "value"], "launch handle");
  if (typeof handle.kind !== "string" || !HANDLE_KIND_RE.test(handle.kind)) fail("E_WATCH_LAUNCH_HANDLE_INVALID", "launch handle kindが不正です");
  if (typeof handle.value !== "string" || handle.value.length === 0 || handle.value.length > 1024 || /[\u0000-\u001f\u007f]/u.test(handle.value)) {
    fail("E_WATCH_LAUNCH_HANDLE_INVALID", "launch handle valueが不正です");
  }
}

function validateTimestamp(value, field) {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || Number.isNaN(parsed) || new Date(parsed).toISOString() !== value) {
    fail("E_WATCH_STATE_SCHEMA", `watch ${field}が不正です`);
  }
}

function currentTimestamp(now) {
  const value = (now ?? (() => new Date()))();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) fail("E_WATCH_CLOCK_INVALID", "watch clockが不正です");
  return value.toISOString();
}

function nextTimestamp(current, now) {
  const timestamp = currentTimestamp(now);
  if (Date.parse(timestamp) < Date.parse(current.updated_at)) fail("E_WATCH_CLOCK_ROLLBACK", "watch clockが後退しました");
  return timestamp;
}

function serialize(state) {
  return `${JSON.stringify(state)}\n`;
}

function requirePlainObject(value, field, code = "E_WATCH_STATE_SCHEMA") {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail(code, `${field}はplain objectである必要があります`);
  }
}

function requireExactKeys(value, expected, field) {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) {
    fail("E_WATCH_STATE_SCHEMA", `${field}に未知または不足fieldがあります`);
  }
}
