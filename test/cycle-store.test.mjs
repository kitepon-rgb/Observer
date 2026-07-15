import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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
import { initializeGeneration, readGenerationState, reserveGenerationInput } from "../src/generation-store.mjs";

const TARGET = { schema: "observer.project_target.v1", targetId: `p_${"a".repeat(64)}`, projectRoot: "/repo" };
const UUID = "11111111-1111-4111-8111-111111111111";
const T0 = new Date("2026-07-15T00:00:00.000Z");
const T1 = new Date("2026-07-15T00:01:00.000Z");
const RESULT = "d".repeat(64);
const INPUT = `sha256:${"e".repeat(64)}`;
const THREAD_ID = "019f62a1-1111-7111-8111-111111111111";

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
  await initializeGeneration({ stateRoot, targetId: TARGET.targetId, watchId: starting.watch_id, provider: "codex", parentThreadSha256: "b".repeat(64), readyReceipt: { schema: "observer.host_receipt.v1", provider: "codex", watch_id: starting.watch_id, target_id: TARGET.targetId, outcome: "ready", handle: { kind: "codex.thread", value: THREAD_ID } } }, { now: () => T0 });
  return { stateRoot, watchId: starting.watch_id };
}

test("processed receiptより後にだけorientation cursorをcommitする", async () => {
  const { stateRoot, watchId } = await setup();
  const proposed = parent("tlc1.first");
  const pending = await prepareCycle({ stateRoot, targetId: TARGET.targetId, watchId, proposedState: proposed }, { now: () => T0 });
  const preparedRaw = await readFile(join(stateRoot, "watches", TARGET.targetId, "pending-cycle.json"), "utf8");
  assert.equal(preparedRaw.includes("value") || preparedRaw.includes("ephemeral-only"), false);
  assert.equal(pending.status, "prepared");
  await assert.rejects(commitProcessedCycle({ stateRoot, targetId: TARGET.targetId, watchId, cycleId: pending.cycle_id }), expectCode("E_CYCLE_NOT_PROCESSED"));
  // reserve through the generation store before durable result receipt.
  await reserveGenerationInput({ stateRoot, targetId: TARGET.targetId, watchId, cycleId: pending.cycle_id, inputDigest: INPUT, modelVisibleBytes: 1 }, { now: () => T1 });
  await markCycleProcessed({ stateRoot, targetId: TARGET.targetId, watchId, cycleId: pending.cycle_id, inputDigest: INPUT, modelVisibleBytes: 1, resultDigest: RESULT }, { now: () => T1 });
  const processedRaw = await readFile(join(stateRoot, "watches", TARGET.targetId, "pending-cycle.json"), "utf8");
  assert.equal(processedRaw.includes("value") || processedRaw.includes("ephemeral-only"), false);
  assert.deepEqual(await commitProcessedCycle({ stateRoot, targetId: TARGET.targetId, watchId, cycleId: pending.cycle_id }), proposed);
  assert.deepEqual(await readCycleState({ stateRoot, targetId: TARGET.targetId }), { committed_state: proposed, pending_cycle: null });
});

test("preparedとprocessedは同じcycleへ冪等で、異なる結果を拒否する", async () => {
  const { stateRoot, watchId } = await setup();
  const proposed = parent("tlc1.first");
  const first = await prepareCycle({ stateRoot, targetId: TARGET.targetId, watchId, proposedState: proposed }, { now: () => T0 });
  assert.deepEqual(await prepareCycle({ stateRoot, targetId: TARGET.targetId, watchId, proposedState: proposed }, { now: () => T1 }), first);
  await reserveGenerationInput({ stateRoot, targetId: TARGET.targetId, watchId, cycleId: first.cycle_id, inputDigest: INPUT, modelVisibleBytes: 1 }, { now: () => T1 });
  const processed = await markCycleProcessed({ stateRoot, targetId: TARGET.targetId, watchId, cycleId: first.cycle_id, inputDigest: INPUT, modelVisibleBytes: 1, resultDigest: RESULT }, { now: () => T1 });
  assert.deepEqual(await markCycleProcessed({ stateRoot, targetId: TARGET.targetId, watchId, cycleId: first.cycle_id, inputDigest: INPUT, modelVisibleBytes: 1, resultDigest: RESULT }, { now: () => T1 }), processed);
  await assert.rejects(markCycleProcessed({ stateRoot, targetId: TARGET.targetId, watchId, cycleId: first.cycle_id, inputDigest: INPUT, modelVisibleBytes: 1, resultDigest: "e".repeat(64) }), expectCode("E_CYCLE_RESULT_CONFLICT"));
});

test("cursor commit後pending cleanup前のcrashは監査なしでcleanup再開できる", async () => {
  const { stateRoot, watchId } = await setup();
  const proposed = parent("tlc1.first");
  const pending = await prepareCycle({ stateRoot, targetId: TARGET.targetId, watchId, proposedState: proposed }, { now: () => T0 });
  await reserveGenerationInput({ stateRoot, targetId: TARGET.targetId, watchId, cycleId: pending.cycle_id, inputDigest: INPUT, modelVisibleBytes: 1 }, { now: () => T1 });
  await markCycleProcessed({ stateRoot, targetId: TARGET.targetId, watchId, cycleId: pending.cycle_id, inputDigest: INPUT, modelVisibleBytes: 1, resultDigest: RESULT }, { now: () => T1 });
  await assert.rejects(
    commitProcessedCycle({ stateRoot, targetId: TARGET.targetId, watchId, cycleId: pending.cycle_id }, { afterCursorCommit: () => { throw new Error("crash"); } }),
    /crash/,
  );
  const interrupted = await readCycleState({ stateRoot, targetId: TARGET.targetId });
  assert.deepEqual(interrupted.committed_state, proposed);
  assert.equal(interrupted.pending_cycle.status, "processed");
  const afterCursor = await readGenerationState({ stateRoot, targetId: TARGET.targetId });
  assert.equal(afterCursor.completed_cycles, 0); assert.equal(afterCursor.model_visible_bytes, 0); assert.notEqual(afterCursor.pending_reservation, null);
  assert.deepEqual(await commitProcessedCycle({ stateRoot, targetId: TARGET.targetId, watchId, cycleId: pending.cycle_id }), proposed);
  assert.equal((await readCycleState({ stateRoot, targetId: TARGET.targetId })).pending_cycle, null);
  const recovered = await readGenerationState({ stateRoot, targetId: TARGET.targetId });
  assert.equal(recovered.completed_cycles, 1); assert.equal(recovered.model_visible_bytes, 1); assert.equal(recovered.pending_reservation, null);
  await assert.rejects(commitProcessedCycle({ stateRoot, targetId: TARGET.targetId, watchId, cycleId: pending.cycle_id }), expectCode("E_CYCLE_PENDING_MISSING"));
});

test("generation commit後のcrashはpending cleanupだけを再開しbudgetを二重加算しない", async () => {
  const { stateRoot, watchId } = await setup(); const proposed = parent("tlc1.after-generation");
  const pending = await prepareCycle({ stateRoot, targetId: TARGET.targetId, watchId, proposedState: proposed }, { now: () => T0 });
  await reserveGenerationInput({ stateRoot, targetId: TARGET.targetId, watchId, cycleId: pending.cycle_id, inputDigest: INPUT, modelVisibleBytes: 1 }, { now: () => T1 });
  await markCycleProcessed({ stateRoot, targetId: TARGET.targetId, watchId, cycleId: pending.cycle_id, inputDigest: INPUT, modelVisibleBytes: 1, resultDigest: RESULT }, { now: () => T1 });
  let generationWrites = 0;
  const crashOnce = { afterGenerationCommit: () => { generationWrites++; if (generationWrites === 1) throw new Error("crash"); } };
  await assert.rejects(commitProcessedCycle({ stateRoot, targetId: TARGET.targetId, watchId, cycleId: pending.cycle_id }, crashOnce), /crash/);
  assert.equal((await readGenerationState({ stateRoot, targetId: TARGET.targetId })).completed_cycles, 1);
  assert.equal((await readCycleState({ stateRoot, targetId: TARGET.targetId })).pending_cycle.status, "processed");
  await commitProcessedCycle({ stateRoot, targetId: TARGET.targetId, watchId, cycleId: pending.cycle_id }, crashOnce);
  assert.equal(generationWrites, 1);
  assert.equal((await readGenerationState({ stateRoot, targetId: TARGET.targetId })).completed_cycles, 1);
  assert.equal((await readCycleState({ stateRoot, targetId: TARGET.targetId })).pending_cycle, null);
});

test("改竄generation identityはcursor write前に拒否する", async () => {
  const { stateRoot, watchId } = await setup(); const proposed = parent("tlc1.tamper");
  const pending = await prepareCycle({ stateRoot, targetId: TARGET.targetId, watchId, proposedState: proposed }, { now: () => T0 });
  const file = join(stateRoot, "watches", TARGET.targetId, "generation.json"); const state = JSON.parse(await readFile(file, "utf8")); state.target_id = `p_${"f".repeat(64)}`; await writeFile(file, `${JSON.stringify(state)}\n`);
  await assert.rejects(markCycleProcessed({ stateRoot, targetId: TARGET.targetId, watchId, cycleId: pending.cycle_id, inputDigest: INPUT, modelVisibleBytes: 1, resultDigest: RESULT }), expectCode("E_GENERATION_WATCH_MISMATCH"));
  assert.equal((await readCycleState({ stateRoot, targetId: TARGET.targetId })).committed_state, null);
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
    markCycleProcessed({ stateRoot, targetId: TARGET.targetId, watchId: "w_22222222-2222-4222-8222-222222222222", cycleId: pending.cycle_id, inputDigest: INPUT, modelVisibleBytes: 1, resultDigest: RESULT }),
    expectCode("E_CYCLE_WATCH_MISMATCH"),
  );
  await reserveGenerationInput({ stateRoot, targetId: TARGET.targetId, watchId, cycleId: pending.cycle_id, inputDigest: INPUT, modelVisibleBytes: 1 }, { now: () => T1 });
  await markCycleProcessed({ stateRoot, targetId: TARGET.targetId, watchId, cycleId: pending.cycle_id, inputDigest: INPUT, modelVisibleBytes: 1, resultDigest: RESULT }, { now: () => T1 });
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
