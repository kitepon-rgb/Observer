import assert from "node:assert/strict";
import test from "node:test";

import { ObserverError } from "../src/observer-error.mjs";
import {
  PARENT_STATE_SCHEMA,
  proposeParentTransition,
  resolveParentSnapshot,
  validateParentState,
} from "../src/parent-resolver.mjs";

const TARGET = { schema: "observer.project_target.v1", targetId: `p_${"a".repeat(64)}`, projectRoot: "/repo" };
const THREAD_A = "b".repeat(64);
const THREAD_B = "c".repeat(64);
const CURSOR_A = "tlc1.a";
const CURSOR_B = "tlc1.b";

function read(overrides = {}) {
  return {
    schema: "throughline.observer_read.v1",
    status: "snapshot",
    host: "codex",
    thread_sha256: THREAD_A,
    afterCursor: null,
    throughCursor: CURSOR_A,
    turns: [],
    historyTruncated: false,
    page: { complete: true, nextToken: null },
    ...overrides,
  };
}

function expectCode(code) {
  return (error) => error instanceof ObserverError && error.code === code;
}

test("snapshotからhash-only parent identityとempty waiting stateを解決する", () => {
  assert.deepEqual(resolveParentSnapshot({ target: TARGET, readResult: read() }), {
    status: "resolved",
    state: {
      schema: PARENT_STATE_SCHEMA,
      target_id: TARGET.targetId,
      project_root: TARGET.projectRoot,
      status: "ready",
      host: "codex",
      thread_sha256: THREAD_A,
      cursor: CURSOR_A,
    },
  });
  const empty = resolveParentSnapshot({
    target: TARGET,
    readResult: read({ host: null, thread_sha256: null, throughCursor: "tlc1.empty" }),
  });
  assert.equal(empty.state.status, "waiting");
  assert.equal(empty.state.host, null);
});

test("ambiguousとresyncはfail closed、projection pendingはstateを作らない", () => {
  assert.throws(() => resolveParentSnapshot({ target: TARGET, readResult: read({ status: "ambiguous_parent", host: null, thread_sha256: null, throughCursor: null }) }), expectCode("E_PARENT_AMBIGUOUS"));
  assert.throws(() => resolveParentSnapshot({ target: TARGET, readResult: read({ status: "resync_required", host: null, thread_sha256: null, throughCursor: null }) }), expectCode("E_PARENT_RESYNC_REQUIRED"));
  assert.deepEqual(resolveParentSnapshot({ target: TARGET, readResult: read({ status: "projection_pending", throughCursor: null, page: { complete: false, nextToken: null } }) }), { status: "pending", state: null });
});

test("delta、thread switch、host switchはwire statusとidentityの整合を要求する", () => {
  const current = resolveParentSnapshot({ target: TARGET, readResult: read() }).state;
  const delta = proposeParentTransition({ current, readResult: read({ status: "delta", afterCursor: CURSOR_A, throughCursor: CURSOR_B }) });
  assert.equal(delta.state.cursor, CURSOR_B);
  assert.equal(delta.state.thread_sha256, THREAD_A);

  const thread = proposeParentTransition({ current, readResult: read({ status: "thread_switched", thread_sha256: THREAD_B, afterCursor: CURSOR_A, throughCursor: CURSOR_B }) });
  assert.equal(thread.state.thread_sha256, THREAD_B);
  const host = proposeParentTransition({ current, readResult: read({ status: "host_switched", host: "claude", thread_sha256: THREAD_B, afterCursor: CURSOR_A, throughCursor: CURSOR_B }) });
  assert.equal(host.state.host, "claude");

  assert.throws(() => proposeParentTransition({ current, readResult: read({ status: "delta", thread_sha256: THREAD_B, afterCursor: CURSOR_A }) }), expectCode("E_PARENT_IDENTITY_MISMATCH"));
  assert.throws(() => proposeParentTransition({ current, readResult: read({ status: "thread_switched", host: "claude", thread_sha256: THREAD_B, afterCursor: CURSOR_A }) }), expectCode("E_PARENT_IDENTITY_MISMATCH"));
});

test("未完pageとprojection pendingは保存stateを進めない", () => {
  const current = resolveParentSnapshot({ target: TARGET, readResult: read() }).state;
  const paged = proposeParentTransition({
    current,
    readResult: read({ status: "delta", afterCursor: CURSOR_A, throughCursor: CURSOR_B, page: { complete: false, nextToken: "tlp1.next" } }),
  });
  assert.equal(paged.status, "page_pending");
  assert.equal(paged.state, current);
  assert.equal(paged.candidate.cursor, CURSOR_B);
  const pending = proposeParentTransition({
    current,
    readResult: read({ status: "projection_pending", afterCursor: CURSOR_A, throughCursor: null, page: { complete: false, nextToken: null } }),
  });
  assert.deepEqual(pending, { status: "pending", state: current, throughCursor: null, nextToken: null });
});

test("cursor連結、exact schema、parent state schemaを厳格に検証する", () => {
  const current = resolveParentSnapshot({ target: TARGET, readResult: read() }).state;
  assert.throws(() => proposeParentTransition({ current, readResult: read({ status: "delta", afterCursor: "tlc1.other" }) }), expectCode("E_PARENT_CURSOR_MISMATCH"));
  assert.throws(() => resolveParentSnapshot({ target: TARGET, readResult: { ...read(), secret: "raw-session" } }), expectCode("E_THROUGHLINE_SCHEMA"));
  assert.throws(() => validateParentState({ ...current, raw_session_id: "secret" }), expectCode("E_PARENT_STATE_SCHEMA"));
});
