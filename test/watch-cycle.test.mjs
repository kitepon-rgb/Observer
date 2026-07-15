import assert from "node:assert/strict";
import test from "node:test";

import { runFixedThroughReplay, runWatchCycle } from "../src/watch-cycle.mjs";

const TARGET = { schema: "observer.project_target.v1", targetId: `p_${"a".repeat(64)}`, projectRoot: "/project" };
const THREAD = "b".repeat(64);
const CURRENT = { schema: "observer.parent_state.v1", target_id: TARGET.targetId, project_root: TARGET.projectRoot, status: "ready", host: "claude", thread_sha256: THREAD, cursor: "tlc1.after" };

function read({ status = "snapshot", afterCursor = null, throughCursor = "tlc1.through", host = "claude", thread = THREAD, turns = [], complete = true, nextToken = null, historyTruncated = false } = {}) {
  return { schema: "throughline.observer_read.v1", status, afterCursor, throughCursor, host, thread_sha256: host === null ? null : thread, turns, historyTruncated, page: { complete, nextToken } };
}

test("watch cycle orients only from a complete snapshot and does not create state while projection is pending", async () => {
  const oriented = await runWatchCycle({ target: TARGET, client: {
    wait: async () => assert.fail("wait must not run during orientation"),
    read: async () => read({ host: null, turns: [{ bounded: true }] }),
  } });
  assert.equal(oriented.status, "oriented");
  assert.equal(oriented.proposed_state.status, "waiting");
  assert.deepEqual(oriented.turns, [{ bounded: true }]);

  const pending = await runWatchCycle({ target: TARGET, client: {
    wait: async () => assert.fail("wait must not run during orientation"),
    read: async () => read({ status: "projection_pending", throughCursor: null, host: null, turns: [] }),
  } });
  assert.deepEqual(pending, { status: "projection_pending", proposed_state: null, turns: [] });
});

test("watch cycle keeps the existing proposal on timeout and faults fail-closed wait states", async () => {
  const timeout = await runWatchCycle({ current: CURRENT, client: {
    read: async () => assert.fail("read must not run after timeout"),
    wait: async () => ({ schema: "throughline.observer_wait.v1", status: "timeout", afterCursor: CURRENT.cursor, throughCursor: CURRENT.cursor }),
  } });
  assert.deepEqual(timeout, { status: "timeout", proposed_state: CURRENT, turns: [] });
  for (const status of ["resync_required", "ambiguous_parent"]) {
    await assert.rejects(runWatchCycle({ current: CURRENT, client: {
      read: async () => assert.fail("read must not run"),
      wait: async () => ({ schema: "throughline.observer_wait.v1", status, afterCursor: CURRENT.cursor, throughCursor: null }),
    } }), status === "resync_required" ? { code: "E_PARENT_RESYNC_REQUIRED" } : { code: "E_PARENT_AMBIGUOUS" });
  }
});

test("watch cycle drains fixed-through pages before proposing a changed parent state", async () => {
  const calls = [];
  const client = {
    wait: async () => ({ schema: "throughline.observer_wait.v1", status: "changed", afterCursor: CURRENT.cursor, throughCursor: "tlc1.fixed" }),
    read: async (input) => {
      calls.push(input);
      return input.pageToken === undefined
        ? read({ status: "delta", afterCursor: CURRENT.cursor, throughCursor: "tlc1.fixed", turns: [{ n: 1 }], complete: false, nextToken: "tlp1.next" })
        : read({ status: "delta", afterCursor: CURRENT.cursor, throughCursor: "tlc1.fixed", turns: [{ n: 2 }], complete: true });
    },
  };
  const result = await runWatchCycle({ current: CURRENT, client });
  assert.equal(result.status, "changed");
  assert.equal(result.proposed_state.cursor, "tlc1.fixed");
  assert.deepEqual(result.turns, [{ n: 1 }, { n: 2 }]);
  assert.deepEqual(calls.map(({ projectPath, afterCursor, throughCursor, pageToken }) => ({ projectPath, afterCursor, throughCursor, pageToken })), [
    { projectPath: "/project", afterCursor: "tlc1.after", throughCursor: "tlc1.fixed", pageToken: undefined },
    { projectPath: "/project", afterCursor: "tlc1.after", throughCursor: "tlc1.fixed", pageToken: "tlp1.next" },
  ]);
});

test("watch cycle keeps the current state when changed read is projection pending or has a cursor mismatch", async () => {
  const pending = await runWatchCycle({ current: CURRENT, client: {
    wait: async () => ({ schema: "throughline.observer_wait.v1", status: "changed", afterCursor: CURRENT.cursor, throughCursor: "tlc1.fixed" }),
    read: async () => read({ status: "projection_pending", afterCursor: CURRENT.cursor, throughCursor: null, host: "claude", turns: [] }),
  } });
  assert.deepEqual(pending, { status: "projection_pending", proposed_state: CURRENT, turns: [], fixed_through_cursor: "tlc1.fixed" });
  await assert.rejects(runWatchCycle({ current: CURRENT, client: {
    wait: async () => ({ schema: "throughline.observer_wait.v1", status: "changed", afterCursor: CURRENT.cursor, throughCursor: "tlc1.fixed" }),
    read: async () => read({ status: "delta", afterCursor: "tlc1.other", throughCursor: "tlc1.fixed" }),
  } }), { code: "E_PARENT_CURSOR_MISMATCH" });
});

test("fixed-through replay never invokes wait or expands a prepared cursor", async () => {
  const calls = [];
  const replayed = await runFixedThroughReplay({ target: TARGET, current: CURRENT, throughCursor: "tlc1.prepared", client: {
    wait: async () => assert.fail("replay must not invoke wait"),
    read: async (input) => {
      calls.push(input);
      return read({ status: "delta", afterCursor: CURRENT.cursor, throughCursor: "tlc1.prepared", turns: [{ n: 1 }] });
    },
  } });
  assert.equal(replayed.proposed_state.cursor, "tlc1.prepared");
  assert.deepEqual(calls.map(({ afterCursor, throughCursor }) => ({ afterCursor, throughCursor })), [{ afterCursor: CURRENT.cursor, throughCursor: "tlc1.prepared" }]);

  const oriented = await runFixedThroughReplay({ target: TARGET, throughCursor: "tlc1.snapshot", client: {
    read: async (input) => {
      assert.equal(input.throughCursor, "tlc1.snapshot");
      return read({ throughCursor: "tlc1.snapshot", host: null });
    },
  } });
  assert.equal(oriented.proposed_state.cursor, "tlc1.snapshot");
});

test("fixed-through orientation replay accepts pending with null through cursor before succeeding", async () => {
  let reads = 0;
  const client = {
    read: async (input) => {
      reads++;
      assert.equal(input.throughCursor, "tlc1.prepared-snapshot");
      return reads === 1
        ? read({ status: "projection_pending", throughCursor: null, host: null, complete: false, nextToken: null })
        : read({ status: "snapshot", throughCursor: "tlc1.prepared-snapshot", host: null });
    },
  };
  assert.equal((await runFixedThroughReplay({ target: TARGET, throughCursor: "tlc1.prepared-snapshot", client })).status, "projection_pending");
  const recovered = await runFixedThroughReplay({ target: TARGET, throughCursor: "tlc1.prepared-snapshot", client });
  assert.equal(recovered.status, "oriented");
  assert.equal(recovered.proposed_state.cursor, "tlc1.prepared-snapshot");
});
