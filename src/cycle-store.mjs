import { createHash } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";

import { ObserverError, fail } from "./observer-error.mjs";
import { validateParentState } from "./parent-resolver.mjs";
import {
  acquirePrivateLock,
  assertPrivateDirectory,
  assertWithin,
  atomicCreatePrivateFile,
  atomicReplacePrivateFile,
  readPrivateJson,
  removePrivateFile,
} from "./private-state.mjs";
import { validateWatchState } from "./watch-store.mjs";
import { completeGenerationState, validateGenerationState } from "./generation-store.mjs";

export const PENDING_CYCLE_SCHEMA = "observer.pending_cycle.v2";
const TARGET_ID_RE = /^p_[a-f0-9]{64}$/;
const WATCH_ID_RE = /^w_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const CYCLE_ID_RE = /^c_[a-f0-9]{64}$/;
const PENDING_KEYS = [
  "base_cursor", "created_at", "cycle_id", "input_digest", "model_visible_bytes", "proposed_state", "result_digest",
  "schema", "status", "target_id", "updated_at", "watch_id",
];

export async function readCycleState({ stateRoot, targetId }) {
  validateTargetId(targetId);
  const paths = await existingPaths(stateRoot, targetId);
  if (paths === null) return { committed_state: null, pending_cycle: null };
  return withTransaction(paths, null, async () => ({
    committed_state: await readCommitted(paths.cursorPath, targetId),
    pending_cycle: await readPending(paths.pendingPath, targetId),
  }), { allowMissingWatch: true });
}

export async function prepareCycle({ stateRoot, targetId, watchId, baseState = null, proposedState }, dependencies = {}) {
  validateTargetId(targetId);
  validateWatchId(watchId);
  validateOptionalParentState(baseState, targetId);
  validateParentForTarget(proposedState, targetId);
  const paths = await requirePaths(stateRoot, targetId);
  return withTransaction(paths, watchId, async () => {
    const committed = await readCommitted(paths.cursorPath, targetId);
    requireBaseState(committed, baseState);
    const cycleId = cycleIdFor(targetId, baseState?.cursor ?? null, proposedState.cursor);
    const existing = await readPending(paths.pendingPath, targetId);
    if (existing !== null) {
      if (existing.cycle_id === cycleId && existing.watch_id === watchId && sameParentState(existing.proposed_state, proposedState)) return structuredClone(existing);
      fail("E_CYCLE_PENDING_CONFLICT", "別のpending cycleが存在します");
    }
    const timestamp = currentTimestamp(dependencies.now);
    const pending = validatePendingCycle({
      schema: PENDING_CYCLE_SCHEMA,
      cycle_id: cycleId,
      watch_id: watchId,
      target_id: targetId,
      status: "prepared",
      base_cursor: baseState?.cursor ?? null,
      proposed_state: structuredClone(proposedState),
      input_digest: null, model_visible_bytes: null, result_digest: null,
      created_at: timestamp,
      updated_at: timestamp,
    });
    await atomicCreatePrivateFile(paths.pendingPath, serialize(pending));
    return structuredClone(pending);
  });
}

export async function markCycleProcessed({ stateRoot, targetId, watchId, cycleId, inputDigest, modelVisibleBytes, resultDigest }, dependencies = {}) {
  validateIdentifiers({ targetId, watchId, cycleId });
  requireDigest(inputDigest, "cycle input digest"); validateInputBytes(modelVisibleBytes);
  if (typeof resultDigest !== "string" || !DIGEST_RE.test(resultDigest)) fail("E_CYCLE_RESULT_INVALID", "cycle result digestが不正です");
  const paths = await requirePaths(stateRoot, targetId);
  return withTransaction(paths, watchId, async () => {
    const pending = await requirePending(paths.pendingPath, targetId);
    requirePendingOwner(pending, watchId, cycleId);
    if (pending.status === "processed") {
      if (pending.result_digest !== resultDigest || pending.input_digest !== inputDigest || pending.model_visible_bytes !== modelVisibleBytes) fail("E_CYCLE_RESULT_CONFLICT", "processed receiptが一致しません");
      return structuredClone(pending);
    }
    const generation = await readGeneration(paths.generationPath);
    if (generation === null) fail("E_GENERATION_NOT_FOUND", "generation stateがありません");
    if (generation.target_id !== targetId || generation.watch_id !== watchId) fail("E_GENERATION_WATCH_MISMATCH", "generation identityがcycleと一致しません");
    const reservation = { cycle_id: cycleId, input_digest: inputDigest, model_visible_bytes: modelVisibleBytes };
    if (generation.pending_reservation === null || generation.pending_reservation.cycle_id !== reservation.cycle_id || generation.pending_reservation.input_digest !== reservation.input_digest || generation.pending_reservation.model_visible_bytes !== reservation.model_visible_bytes) fail("E_GENERATION_RESERVATION_REQUIRED", "generation reservationが一致しません");
    const next = validatePendingCycle({
      ...pending,
      status: "processed",
      input_digest: inputDigest,
      model_visible_bytes: modelVisibleBytes,
      result_digest: resultDigest,
      updated_at: nextTimestamp(pending.updated_at, dependencies.now),
    });
    await atomicReplacePrivateFile(paths.pendingPath, serialize(next));
    return structuredClone(next);
  });
}

export async function commitProcessedCycle({ stateRoot, targetId, watchId, cycleId }, dependencies = {}) {
  validateIdentifiers({ targetId, watchId, cycleId });
  const paths = await requirePaths(stateRoot, targetId);
  return withTransaction(paths, watchId, async () => {
    const pending = await requirePending(paths.pendingPath, targetId);
    requirePendingOwner(pending, watchId, cycleId);
    if (pending.status !== "processed") fail("E_CYCLE_NOT_PROCESSED", "processed receiptより先にcursorをcommitできません");
    const generation = await readGeneration(paths.generationPath);
    if (generation === null) fail("E_GENERATION_NOT_FOUND", "generation stateがありません");
    if (generation.target_id !== targetId || generation.watch_id !== watchId) fail("E_GENERATION_WATCH_MISMATCH", "generation identityがcycleと一致しません");
    const completion = { cycle_id: pending.cycle_id, input_digest: pending.input_digest, model_visible_bytes: pending.model_visible_bytes, result_digest: `sha256:${pending.result_digest}` };
    const generationNeedsWrite = generation.pending_reservation !== null;
    const nextGeneration = completeGenerationState(generation, completion, dependencies.now);
    const committed = await readCommitted(paths.cursorPath, targetId);
    const committedCursor = committed?.cursor ?? null;
    if (committedCursor === pending.base_cursor) {
      if (committed === null) await atomicCreatePrivateFile(paths.cursorPath, serialize(pending.proposed_state));
      else await atomicReplacePrivateFile(paths.cursorPath, serialize(pending.proposed_state));
      await dependencies.afterCursorCommit?.();
    } else if (committedCursor !== pending.proposed_state.cursor || !sameParentState(committed, pending.proposed_state)) {
      fail("E_CYCLE_BASE_MISMATCH", "committed cursorがpending cycleと一致しません");
    }
    if (generationNeedsWrite) {
      await atomicReplacePrivateFile(paths.generationPath, serialize(nextGeneration));
      await dependencies.afterGenerationCommit?.();
    }
    await removePrivateFile(paths.pendingPath);
    return structuredClone(pending.proposed_state);
  }, { allowedWatchStatuses: ["active", "stopping"] });
}

export function cycleIdFor(targetId, baseCursor, proposedCursor) {
  validateTargetId(targetId);
  if (!isOptionalCursor(baseCursor) || typeof proposedCursor !== "string" || proposedCursor.length === 0 || proposedCursor.length > 4096) {
    fail("E_CYCLE_CURSOR_INVALID", "cycle cursorが不正です");
  }
  if (baseCursor === proposedCursor) fail("E_CYCLE_CURSOR_INVALID", "cycle cursorが進んでいません");
  const digest = createHash("sha256").update(JSON.stringify({ target_id: targetId, base_cursor: baseCursor, proposed_cursor: proposedCursor }), "utf8").digest("hex");
  return `c_${digest}`;
}

export function validatePendingCycle(value) {
  requirePlainObject(value, "pending cycle");
  requireExactKeys(value, PENDING_KEYS, "pending cycle");
  if (value.schema !== PENDING_CYCLE_SCHEMA || !CYCLE_ID_RE.test(value.cycle_id) || !WATCH_ID_RE.test(value.watch_id) || !TARGET_ID_RE.test(value.target_id)) {
    fail("E_CYCLE_STATE_SCHEMA", "pending cycle identityが不正です");
  }
  if (!["prepared", "processed"].includes(value.status) || !isOptionalCursor(value.base_cursor)) fail("E_CYCLE_STATE_SCHEMA", "pending cycle statusが不正です");
  validateParentForTarget(value.proposed_state, value.target_id);
  if (value.cycle_id !== cycleIdFor(value.target_id, value.base_cursor, value.proposed_state.cursor)) fail("E_CYCLE_STATE_SCHEMA", "pending cycle digestが一致しません");
  if (value.status === "prepared") {
    if (value.input_digest !== null || value.model_visible_bytes !== null || value.result_digest !== null) fail("E_CYCLE_STATE_SCHEMA", "prepared pendingのinput/resultはnullです");
  } else if (typeof value.input_digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.input_digest) || !Number.isSafeInteger(value.model_visible_bytes) || value.model_visible_bytes < 0 || value.model_visible_bytes > 262144 || typeof value.result_digest !== "string" || !DIGEST_RE.test(value.result_digest)) fail("E_CYCLE_STATE_SCHEMA", "processed pendingが不正です");
  validateTimestamp(value.created_at);
  validateTimestamp(value.updated_at);
  if (Date.parse(value.updated_at) < Date.parse(value.created_at)) fail("E_CYCLE_STATE_SCHEMA", "pending cycle timestampが後退しています");
  return value;
}

async function existingPaths(stateRoot, targetId) {
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
  return {
    watchPath: join(directory, "current.json"),
    cursorPath: join(directory, "cursor.json"),
    pendingPath: join(directory, "pending-cycle.json"),
    generationPath: join(directory, "generation.json"),
    lockPath: join(directory, "transaction.lock"),
  };
}

async function requirePaths(stateRoot, targetId) {
  const paths = await existingPaths(stateRoot, targetId);
  if (paths === null) fail("E_WATCH_NOT_FOUND", "watch stateがありません");
  return paths;
}

async function withTransaction(paths, watchId, operation, { allowMissingWatch = false, allowedWatchStatuses = ["active"] } = {}) {
  let release;
  try {
    release = await acquirePrivateLock(paths.lockPath);
  } catch (error) {
    if (error instanceof ObserverError && error.code === "E_CONSUMER_LOCKED") fail("E_WATCH_TRANSACTION_LOCKED", "別のwatch transactionが進行中です");
    throw error;
  }
  let primary = null;
  try {
    if (!allowMissingWatch) {
      const watch = validateWatchState(await readPrivateJson(paths.watchPath));
      if (watch.watch_id !== watchId) fail("E_CYCLE_WATCH_MISMATCH", "pending cycleのwatch ownerが一致しません");
      if (!allowedWatchStatuses.includes(watch.status)) fail("E_CYCLE_WATCH_INACTIVE", "active watchだけがcycle stateを変更できます");
    }
    return await operation();
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    try {
      await release();
    } catch (releaseError) {
      if (primary) throw new AggregateError([primary, releaseError], "cycle transactionとlock解放の両方に失敗しました");
      throw releaseError;
    }
  }
}

async function readCommitted(path, targetId) {
  try {
    const state = validateParentState(await readPrivateJson(path));
    if (state.target_id !== targetId) fail("E_CYCLE_STATE_SCHEMA", "committed parent targetが一致しません");
    return state;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function readPending(path, targetId) {
  try {
    const pending = validatePendingCycle(await readPrivateJson(path));
    if (pending.target_id !== targetId) fail("E_CYCLE_STATE_SCHEMA", "pending targetが一致しません");
    return pending;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function requirePending(path, targetId) {
  const pending = await readPending(path, targetId);
  if (pending === null) fail("E_CYCLE_PENDING_MISSING", "pending cycleがありません");
  return pending;
}
async function readGeneration(path) { try { return validateGenerationState(await readPrivateJson(path)); } catch (error) { if (error?.code === "ENOENT") return null; throw error; } }

function requireBaseState(committed, baseState) {
  if (committed === null && baseState === null) return;
  if (committed === null || baseState === null || !sameParentState(committed, baseState)) {
    fail("E_CYCLE_BASE_MISMATCH", "committed parent stateがcycle baseと一致しません");
  }
}

function sameParentState(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function requirePendingOwner(pending, watchId, cycleId) {
  if (pending.watch_id !== watchId || pending.cycle_id !== cycleId) fail("E_CYCLE_PENDING_CONFLICT", "pending cycle ownerが一致しません");
}

function validateIdentifiers({ targetId, watchId, cycleId }) {
  validateTargetId(targetId);
  validateWatchId(watchId);
  if (typeof cycleId !== "string" || !CYCLE_ID_RE.test(cycleId)) fail("E_CYCLE_ID_INVALID", "cycle IDが不正です");
}

function validateTargetId(value) {
  if (typeof value !== "string" || !TARGET_ID_RE.test(value)) fail("E_CYCLE_TARGET_INVALID", "cycle target IDが不正です");
}

function validateWatchId(value) {
  if (typeof value !== "string" || !WATCH_ID_RE.test(value)) fail("E_CYCLE_WATCH_INVALID", "cycle watch IDが不正です");
}

function validateOptionalParentState(value, targetId) {
  if (value !== null) validateParentForTarget(value, targetId);
}

function validateParentForTarget(value, targetId) {
  validateParentState(value);
  if (value.target_id !== targetId) fail("E_CYCLE_TARGET_INVALID", "parent state targetが一致しません");
}

function isOptionalCursor(value) {
  return value === null || typeof value === "string" && value.length > 0 && value.length <= 4096;
}

function currentTimestamp(now) {
  const value = (now ?? (() => new Date()))();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) fail("E_CYCLE_CLOCK_INVALID", "cycle clockが不正です");
  return value.toISOString();
}

function nextTimestamp(previous, now) {
  const next = currentTimestamp(now);
  if (Date.parse(next) < Date.parse(previous)) fail("E_CYCLE_CLOCK_ROLLBACK", "cycle clockが後退しました");
  return next;
}

function validateTimestamp(value) {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(parsed) || new Date(parsed).toISOString() !== value) fail("E_CYCLE_STATE_SCHEMA", "cycle timestampが不正です");
}
function requireDigest(value, field) { if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) fail("E_CYCLE_INPUT_INVALID", `${field}が不正です`); }
function validateInputBytes(value) { if (!Number.isSafeInteger(value) || value < 0 || value > 262144) fail("E_CYCLE_INPUT_INVALID", "model visible bytesが不正です"); }

function serialize(value) {
  return `${JSON.stringify(value)}\n`;
}

function requirePlainObject(value, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail("E_CYCLE_STATE_SCHEMA", `${field}はplain objectである必要があります`);
}

function requireExactKeys(value, expected, field) {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) fail("E_CYCLE_STATE_SCHEMA", `${field}に未知または不足fieldがあります`);
}
