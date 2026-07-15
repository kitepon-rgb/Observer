import { isAbsolute } from "node:path";

import { fail } from "./observer-error.mjs";

export const PARENT_STATE_SCHEMA = "observer.parent_state.v1";
export const THROUGHLINE_READ_SCHEMA = "throughline.observer_read.v1";

const TARGET_ID_RE = /^p_[a-f0-9]{64}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const READ_KEYS = Object.freeze([
  "afterCursor", "historyTruncated", "host", "page", "schema", "status",
  "thread_sha256", "throughCursor", "turns",
]);

export function resolveParentSnapshot({ target, readResult }) {
  validateTarget(target);
  validateReadResult(readResult);
  failClosedState(readResult);

  if (readResult.status === "projection_pending") {
    return { status: "pending", state: null };
  }
  if (readResult.status !== "snapshot" || readResult.afterCursor !== null || !readResult.page.complete) {
    fail("E_PARENT_READ_STATE", "初回parent readはcomplete snapshotである必要があります");
  }
  return { status: "resolved", state: stateFromRead(target, readResult) };
}

export function proposeParentTransition({ current, readResult }) {
  validateParentState(current);
  validateReadResult(readResult);
  failClosedState(readResult);
  if (readResult.afterCursor !== current.cursor) {
    fail("E_PARENT_CURSOR_MISMATCH", "read resultが保存cursorへ連結していません");
  }
  if (readResult.status === "projection_pending") {
    return { status: "pending", state: current, throughCursor: null, nextToken: null };
  }
  if (!["delta", "thread_switched", "host_switched"].includes(readResult.status)) {
    fail("E_PARENT_READ_STATE", "parent transitionへ適用できないread状態です");
  }
  validateTransitionIdentity(current, readResult);
  const candidate = stateFromRead({
    schema: "observer.project_target.v1",
    targetId: current.target_id,
    projectRoot: current.project_root,
  }, readResult);
  if (!readResult.page.complete) {
    if (typeof readResult.page.nextToken !== "string" || readResult.page.nextToken.length === 0) {
      fail("E_PARENT_READ_STATE", "未完pageにはnext tokenが必要です");
    }
    return {
      status: "page_pending",
      state: current,
      candidate,
      throughCursor: readResult.throughCursor,
      nextToken: readResult.page.nextToken,
    };
  }
  return { status: "resolved", state: candidate };
}

export function validateParentState(state) {
  requirePlainObject(state, "parent state", "E_PARENT_STATE_SCHEMA");
  requireExactKeys(state, ["cursor", "host", "project_root", "schema", "status", "target_id", "thread_sha256"], "parent state", "E_PARENT_STATE_SCHEMA");
  if (state.schema !== PARENT_STATE_SCHEMA) fail("E_PARENT_STATE_SCHEMA", "未対応のparent state schemaです");
  if (!TARGET_ID_RE.test(state.target_id) || !isAbsolute(state.project_root)) fail("E_PARENT_STATE_SCHEMA", "parent target identityが不正です");
  if (typeof state.cursor !== "string" || state.cursor.length === 0 || state.cursor.length > 4096) fail("E_PARENT_STATE_SCHEMA", "parent cursorが不正です");
  if (state.status === "waiting") {
    if (state.host !== null || state.thread_sha256 !== null) fail("E_PARENT_STATE_SCHEMA", "waiting parent identityが不正です");
  } else if (state.status === "ready") {
    if (!["claude", "codex"].includes(state.host) || !SHA256_RE.test(state.thread_sha256)) fail("E_PARENT_STATE_SCHEMA", "ready parent identityが不正です");
  } else fail("E_PARENT_STATE_SCHEMA", "parent statusが不正です");
  return state;
}

function stateFromRead(target, readResult) {
  const state = {
    schema: PARENT_STATE_SCHEMA,
    target_id: target.targetId,
    project_root: target.projectRoot,
    status: readResult.host === null ? "waiting" : "ready",
    host: readResult.host,
    thread_sha256: readResult.thread_sha256,
    cursor: readResult.throughCursor,
  };
  return validateParentState(state);
}

function validateTarget(target) {
  requirePlainObject(target, "target", "E_PARENT_TARGET_INVALID");
  requireExactKeys(target, ["projectRoot", "schema", "targetId"], "target", "E_PARENT_TARGET_INVALID");
  if (target.schema !== "observer.project_target.v1" || !TARGET_ID_RE.test(target.targetId) || !isAbsolute(target.projectRoot)) {
    fail("E_PARENT_TARGET_INVALID", "project targetが不正です");
  }
}

function validateReadResult(value) {
  requirePlainObject(value, "Throughline read result");
  requireExactKeys(value, READ_KEYS, "Throughline read result");
  if (value.schema !== THROUGHLINE_READ_SCHEMA) fail("E_THROUGHLINE_SCHEMA", "未対応のThroughline read schemaです");
  if (!["snapshot", "delta", "thread_switched", "host_switched", "resync_required", "projection_pending", "ambiguous_parent"].includes(value.status)) {
    fail("E_THROUGHLINE_SCHEMA", "未知のThroughline read statusです");
  }
  if (!Array.isArray(value.turns) || value.turns.length > 100 || typeof value.historyTruncated !== "boolean") {
    fail("E_THROUGHLINE_SCHEMA", "Throughline read payloadが不正です");
  }
  requirePlainObject(value.page, "Throughline page");
  requireExactKeys(value.page, ["complete", "nextToken"], "Throughline page");
  if (typeof value.page.complete !== "boolean" || !(value.page.nextToken === null || typeof value.page.nextToken === "string")) {
    fail("E_THROUGHLINE_SCHEMA", "Throughline page payloadが不正です");
  }
  if (!(value.afterCursor === null || typeof value.afterCursor === "string") || !(value.throughCursor === null || typeof value.throughCursor === "string")) {
    fail("E_THROUGHLINE_SCHEMA", "Throughline cursor payloadが不正です");
  }
  if (value.host === null) {
    if (value.thread_sha256 !== null) fail("E_THROUGHLINE_SCHEMA", "空parent identityが不正です");
  } else if (!["claude", "codex"].includes(value.host) || !SHA256_RE.test(value.thread_sha256)) {
    fail("E_THROUGHLINE_SCHEMA", "Throughline parent identityが不正です");
  }
  if (!["resync_required", "projection_pending", "ambiguous_parent"].includes(value.status) && typeof value.throughCursor !== "string") {
    fail("E_THROUGHLINE_SCHEMA", "成功readにthrough cursorがありません");
  }
  return value;
}

function failClosedState(readResult) {
  if (readResult.status === "ambiguous_parent") fail("E_PARENT_AMBIGUOUS", "現在親を一意に解決できません");
  if (readResult.status === "resync_required") fail("E_PARENT_RESYNC_REQUIRED", "parent cursorの再orientationが必要です");
}

function validateTransitionIdentity(current, result) {
  if (result.status === "delta") {
    if (current.status === "ready" && (result.host !== current.host || result.thread_sha256 !== current.thread_sha256)) {
      fail("E_PARENT_IDENTITY_MISMATCH", "deltaが保存parent identityと一致しません");
    }
    return;
  }
  if (result.status === "thread_switched") {
    if (current.status !== "ready" || result.host !== current.host || result.thread_sha256 === current.thread_sha256) {
      fail("E_PARENT_IDENTITY_MISMATCH", "thread switch identityが不正です");
    }
    return;
  }
  if (current.status !== "ready" || result.host === current.host) {
    fail("E_PARENT_IDENTITY_MISMATCH", "host switch identityが不正です");
  }
}

function requirePlainObject(value, field, code = "E_THROUGHLINE_SCHEMA") {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail(code, `${field}はplain objectである必要があります`);
  }
}

function requireExactKeys(value, expected, field, code = "E_THROUGHLINE_SCHEMA") {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) {
    fail(code, `${field}に未知または不足fieldがあります`);
  }
}
