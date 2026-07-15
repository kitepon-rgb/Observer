import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  commitProcessedCycle,
  cycleIdFor,
  markCycleProcessed,
  prepareCycle,
  readCycleState,
} from "../src/cycle-store.mjs";
import { ObserverError } from "../src/observer-error.mjs";
import { activateWatch, attachWatchLaunchHandle, reserveActiveWatch } from "../src/watch-store.mjs";

const TARGET = { schema: "observer.project_target.v1", targetId: `p_${"a".repeat(64)}`, projectRoot: "/repo" };
const UUID = "11111111-1111-4111-8111-111111111111";
const T0 = new Date("2026-07-15T00:00:00.000Z");
const T1 = new Date("2026-07-15T00:01:00.000Z");
const RESULT = "d".repeat(64);

function parent(cursor, thread = "b".repeat(64)) {
  return { schema: "observer.parent_state.v1", target_id: TARGET.targetId, project_root: TARGET.projectRoot, status: "ready", host: "codex", thread_sha256: thread, cursor };
}

function expectCode(code) {
  return (error) => error instanceof ObserverError && error.code === code;
}

async function setup() {
  const stateRoot = await mkdtemp(join(tmpdir(), "observer-cycle-"));
  const starting = await reserveActiveWatch({ stateRoot, target: TARGET, provider: "codex" }, { randomUUID: () => UUID, now: () => T0 });
  const launchHandle = { kind: "codex.agent", value: "/root/observer" };
  await attachWatchLaunchHandle({ stateRoot, targetId: TARGET.targetId, watchId: starting.watch_id, launchHandle }, { now: () => T0 });
  await activateWatch({ stateRoot, targetId: TARGET.targetId, watchId: starting.watch_id, launchHandle }, { now: () => T0 });
  return { stateRoot, watchId: starting.watch_id };
}

test("processed receiptより後にだけorientation cursorをcommitする", async () => {
  const { stateRoot, watchId } = await setup();
  const proposed = parent("tlc1.first");
  const pending = await prepareCycle({ stateRoot, targetId: TARGET.targetId, watchId, proposedState: proposed }, { now: () => T0 });
  assert.equal(pending.status, "prepared");
  await assert.rejects(commitProcessedCycle({ stateRoot, targetId: TARGET.targetId, watchId, cycleId: pending.cycle_id }), expectCode("E_CYCLE_NOT_PROCESSED"));
  await markCycleProcessed({ stateRoot, targetId: TARGET.targetId, watchId, cycleId: pending.cycle_id, resultDigest: RESULT }, { now: () => T1 });
  assert.deepEqual(await commitProcessedCycle({ stateRoot, targetId: TARGET.targetId, watchId, cycleId: pending.cycle_id }), proposed);
  assert.deepEqual(await readCycleState({ stateRoot, targetId: TARGET.targetId }), { committed_state: proposed, pending_cycle: null });
});

test("preparedとprocessedは同じcycleへ冪等で、異なる結果を拒否する", async () => {
  const { stateRoot, watchId } = await setup();
  const proposed = parent("tlc1.first");
  const first = await prepareCycle({ stateRoot, targetId: TARGET.targetId, watchId, proposedState: proposed }, { now: () => T0 });
  assert.deepEqual(await prepareCycle({ stateRoot, targetId: TARGET.targetId, watchId, proposedState: proposed }, { now: () => T1 }), first);
  const processed = await markCycleProcessed({ stateRoot, targetId: TARGET.targetId, watchId, cycleId: first.cycle_id, resultDigest: RESULT }, { now: () => T1 });
  assert.deepEqual(await markCycleProcessed({ stateRoot, targetId: TARGET.targetId, watchId, cycleId: first.cycle_id, resultDigest: RESULT }, { now: () => T1 }), processed);
  await assert.rejects(markCycleProcessed({ stateRoot, targetId: TARGET.targetId, watchId, cycleId: first.cycle_id, resultDigest: "e".repeat(64) }), expectCode("E_CYCLE_RESULT_CONFLICT"));
});

test("cursor commit後pending cleanup前のcrashは監査なしでcleanup再開できる", async () => {
  const { stateRoot, watchId } = await setup();
  const proposed = parent("tlc1.first");
  const pending = await prepareCycle({ stateRoot, targetId: TARGET.targetId, watchId, proposedState: proposed }, { now: () => T0 });
  await markCycleProcessed({ stateRoot, targetId: TARGET.targetId, watchId, cycleId: pending.cycle_id, resultDigest: RESULT }, { now: () => T1 });
  await assert.rejects(
    commitProcessedCycle({ stateRoot, targetId: TARGET.targetId, watchId, cycleId: pending.cycle_id }, { afterCursorCommit: () => { throw new Error("crash"); } }),
    /crash/,
  );
  const interrupted = await readCycleState({ stateRoot, targetId: TARGET.targetId });
  assert.deepEqual(interrupted.committed_state, proposed);
  assert.equal(interrupted.pending_cycle.status, "processed");
  assert.deepEqual(await commitProcessedCycle({ stateRoot, targetId: TARGET.targetId, watchId, cycleId: pending.cycle_id }), proposed);
  assert.equal((await readCycleState({ stateRoot, targetId: TARGET.targetId })).pending_cycle, null);
});

test("base cursor CAS、pending競合、watch owner不一致をfail closedにする", async () => {
  const { stateRoot, watchId } = await setup();
  const first = parent("tlc1.first");
  const pending = await prepareCycle({ stateRoot, targetId: TARGET.targetId, watchId, proposedState: first }, { now: () => T0 });
  await assert.rejects(
    prepareCycle({ stateRoot, targetId: TARGET.targetId, watchId, proposedState: parent("tlc1.other") }, { now: () => T1 }),
    expectCode("E_CYCLE_PENDING_CONFLICT"),
  );
  await assert.rejects(
    markCycleProcessed({ stateRoot, targetId: TARGET.targetId, watchId: "w_22222222-2222-4222-8222-222222222222", cycleId: pending.cycle_id, resultDigest: RESULT }),
    expectCode("E_CYCLE_WATCH_MISMATCH"),
  );
  await markCycleProcessed({ stateRoot, targetId: TARGET.targetId, watchId, cycleId: pending.cycle_id, resultDigest: RESULT }, { now: () => T1 });
  await commitProcessedCycle({ stateRoot, targetId: TARGET.targetId, watchId, cycleId: pending.cycle_id });
  await assert.rejects(
    prepareCycle({ stateRoot, targetId: TARGET.targetId, watchId, baseState: null, proposedState: parent("tlc1.second") }),
    expectCode("E_CYCLE_BASE_MISMATCH"),
  );
  await assert.rejects(
    prepareCycle({ stateRoot, targetId: TARGET.targetId, watchId, baseState: parent("tlc1.first", "c".repeat(64)), proposedState: parent("tlc1.second") }),
    expectCode("E_CYCLE_BASE_MISMATCH"),
  );
});

test("cycle IDは決定的digestでraw cursorを公開しない", () => {
  const id = cycleIdFor(TARGET.targetId, "tlc1.secret-after", "tlc1.secret-through");
  assert.match(id, /^c_[a-f0-9]{64}$/);
  assert.doesNotMatch(id, /secret|tlc1/);
  assert.equal(id, cycleIdFor(TARGET.targetId, "tlc1.secret-after", "tlc1.secret-through"));
  assert.throws(() => cycleIdFor(TARGET.targetId, "tlc1.same", "tlc1.same"), expectCode("E_CYCLE_CURSOR_INVALID"));
});
