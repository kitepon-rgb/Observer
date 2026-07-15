import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";

import { fail } from "./observer-error.mjs";
import { readCycleState } from "./cycle-store.mjs";
import { resolveProjectTarget } from "./project-target.mjs";
import { readWatchStatus } from "./watch-store.mjs";

export const MAILBOX_ROUTE_SCHEMA = "observer.mailbox_route.v1";
const PROVIDERS = new Set(["claude", "codex"]);
const ROUTE_STATUSES = new Set(["current", "unknown_target", "watch_inactive", "parent_pending", "stale_parent"]);

export function hashParentThreadId(threadId) {
  if (typeof threadId !== "string" || threadId.length < 1 || Buffer.byteLength(threadId, "utf8") > 256 || /[\u0000-\u001f\u007f]/u.test(threadId)) {
    fail("E_MAILBOX_ROUTE_INPUT_INVALID", "parent thread IDが不正です");
  }
  return createHash("sha256").update(threadId, "utf8").digest("hex");
}

export async function resolveAuthoritativeMailboxRoute({ stateRoot, projectRoot, parentProvider, threadId } = {}, dependencies = {}) {
  if (!PROVIDERS.has(parentProvider)) fail("E_MAILBOX_ROUTE_INPUT_INVALID", "parent providerが不正です");
  const threadSha256 = hashParentThreadId(threadId);
  const target = await (dependencies.resolveProjectTarget ?? resolveProjectTarget)(projectRoot);
  const watch = await (dependencies.readWatchStatus ?? readWatchStatus)({ stateRoot, targetId: target.targetId });
  if (watch === null) return routeResult("unknown_target", target, parentProvider, threadSha256, null, null);
  if (watch.target_id !== target.targetId || watch.project_root !== target.projectRoot || watch.status !== "active") {
    return routeResult("watch_inactive", target, parentProvider, threadSha256, watch.watch_id, null);
  }
  const cycle = await (dependencies.readCycleState ?? readCycleState)({ stateRoot, targetId: target.targetId });
  const parent = cycle.committed_state;
  if (parent === null || parent.status !== "ready") return routeResult("parent_pending", target, parentProvider, threadSha256, watch.watch_id, null);
  if (watch.provider !== parentProvider || parent.host !== parentProvider || parent.thread_sha256 !== threadSha256 || parent.project_root !== target.projectRoot) {
    return routeResult("stale_parent", target, parentProvider, threadSha256, watch.watch_id, parent.cursor);
  }
  return routeResult("current", target, parentProvider, threadSha256, watch.watch_id, parent.cursor);
}

export function validateMailboxRoute(value) {
  if (!isPlainObject(value) || !hasExactKeys(value, [
    "parent_cursor", "project_root", "provider", "schema", "status", "target_id", "thread_sha256", "watch_id",
  ]) || value.schema !== MAILBOX_ROUTE_SCHEMA || !ROUTE_STATUSES.has(value.status) ||
      typeof value.target_id !== "string" || !/^p_[a-f0-9]{64}$/.test(value.target_id) ||
      typeof value.project_root !== "string" || !isAbsolute(value.project_root) ||
      !PROVIDERS.has(value.provider) || typeof value.thread_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.thread_sha256) ||
      (value.watch_id !== null && (typeof value.watch_id !== "string" || !/^w_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.watch_id))) ||
      (value.parent_cursor !== null && (typeof value.parent_cursor !== "string" || value.parent_cursor.length < 1 || value.parent_cursor.length > 4096))) {
    fail("E_MAILBOX_ROUTE_INVALID", "Mailbox routeが不正です");
  }
  if (value.status === "current" && (value.watch_id === null || value.parent_cursor === null)) fail("E_MAILBOX_ROUTE_INVALID", "current Mailbox routeに証拠がありません");
  if (value.status === "unknown_target" && (value.watch_id !== null || value.parent_cursor !== null)) fail("E_MAILBOX_ROUTE_INVALID", "unknown target routeがstateをclaimしています");
  return value;
}

function routeResult(status, target, provider, threadSha256, watchId, parentCursor) {
  return validateMailboxRoute({
    schema: MAILBOX_ROUTE_SCHEMA,
    status,
    target_id: target.targetId,
    project_root: target.projectRoot,
    provider,
    thread_sha256: threadSha256,
    watch_id: watchId,
    parent_cursor: parentCursor,
  });
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function hasExactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}
