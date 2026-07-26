import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ObserverError } from "../src/observer-error.mjs";
import { ensureStatePath } from "../src/private-state.mjs";
import {
  GENERATION_MAX_COMPLETED_CYCLES,
  GENERATION_MAX_MODEL_VISIBLE_BYTES,
  activateGeneration,
  authorizeGenerationRebind,
  beginNextGeneration,
  beginReboundGeneration,
  completeGenerationCycle,
  confirmGenerationTerminal,
  generationParentEpochId,
  initializeGeneration,
  readGenerationState,
  requestGenerationRebindStop,
  requestGenerationStop,
  reserveGenerationInput,
  validateGenerationState,
} from "../src/generation-store.mjs";

const TARGET_ID = `p_${"a".repeat(64)}`;
const WATCH_ID = "w_11111111-1111-4111-8111-111111111111";
const NEXT_WATCH_ID = "w_22222222-2222-4222-8222-222222222222";
const THREAD_SHA = "b".repeat(64);
const CYCLE = `c_${"c".repeat(64)}`;
const INPUT = `sha256:${"d".repeat(64)}`;
const RESULT = `sha256:${"e".repeat(64)}`;
const T0 = new Date("2026-07-15T00:00:00.000Z");
const T1 = new Date("2026-07-15T00:01:00.000Z");

function receipt(outcome = "ready", handle = "job-private-1") {
  return {
    schema: "observer.host_receipt.v1", provider: "claude", watch_id: WATCH_ID, target_id: TARGET_ID, outcome,
    handle: { kind: "claude.job", value: handle },
  };
}
function nextReceipt() {
  return {
    schema: "observer.host_receipt.v1", provider: "claude", watch_id: NEXT_WATCH_ID, target_id: TARGET_ID, outcome: "ready",
    handle: { kind: "claude.job", value: "job-private-2" },
  };
}
function deps(time = T0) {
  return {
    now: () => time,
    readWatchStatus: async () => ({ provider: "claude", watch_id: WATCH_ID, target_id: TARGET_ID, status: "active" }),
  };
}
function expectCode(code) { return (error) => error instanceof ObserverError && error.code === code; }
async function box() { return mkdtemp(join(tmpdir(), "observer-generation-")); }
async function initialize(stateRoot) {
  await ensureStatePath(stateRoot, "watches", TARGET_ID);
  return initializeGeneration({ stateRoot, targetId: TARGET_ID, watchId: WATCH_ID, provider: "claude", parentThreadSha256: THREAD_SHA, readyReceipt: receipt() }, deps());
}

test("initializeは既存active watch directoryを要求し、不正identityで空directoryを残さない", async () => {
  const stateRoot = await box();
  await assert.rejects(
    initializeGeneration({ stateRoot, targetId: TARGET_ID, watchId: WATCH_ID, provider: "claude", parentThreadSha256: THREAD_SHA, readyReceipt: receipt() }, deps()),
    expectCode("E_GENERATION_NOT_FOUND"),
  );
  await assert.rejects(lstat(join(stateRoot, "watches")), { code: "ENOENT" });
  await assert.rejects(
    initializeGeneration({ stateRoot, targetId: "bad", watchId: WATCH_ID, provider: "claude", parentThreadSha256: THREAD_SHA, readyReceipt: receipt() }, deps()),
    expectCode("E_GENERATION_STATE_INVALID"),
  );
  await assert.rejects(lstat(join(stateRoot, "watches")), { code: "ENOENT" });
});

test("active watchとready receiptを照合してraw handleなしのgeneration stateを作る", async () => {
  const stateRoot = await box();
  const state = await initialize(stateRoot);
  assert.equal(state.status, "active");
  assert.equal(state.sequence, 1);
  assert.equal(state.completed_cycles, 0);
  assert.equal(JSON.stringify(state).includes("job-private-1"), false);
  const raw = await readFile(join(stateRoot, "watches", TARGET_ID, "generation.json"), "utf8");
  assert.equal(raw.includes("job-private-1"), false);
  assert.equal(raw.includes(THREAD_SHA), false);
  assert.deepEqual(await readGenerationState({ stateRoot, targetId: TARGET_ID }), state);
});

test("terminal watchから予約された新watchは未予約の旧generationを置換する", async () => {
  const stateRoot = await box();
  const previous = await initialize(stateRoot);
  const next = await initializeGeneration({
    stateRoot,
    targetId: TARGET_ID,
    watchId: NEXT_WATCH_ID,
    provider: "claude",
    parentThreadSha256: "c".repeat(64),
    readyReceipt: nextReceipt(),
  }, {
    now: () => T1,
    readWatchStatus: async () => ({
      provider: "claude", watch_id: NEXT_WATCH_ID, target_id: TARGET_ID, status: "active",
    }),
  });
  assert.equal(previous.watch_id, WATCH_ID);
  assert.equal(next.watch_id, NEXT_WATCH_ID);
  assert.equal(next.status, "active");
  assert.equal(next.sequence, 1);
  assert.equal(next.completed_cycles, 0);
  assert.notEqual(next.generation_id, previous.generation_id);
  assert.deepEqual(await readGenerationState({ stateRoot, targetId: TARGET_ID }), next);
});

test("前watchのpending reservationまたは途中遷移は新watchで破棄しない", async () => {
  const stateRoot = await box();
  await initialize(stateRoot);
  await reserveGenerationInput({
    stateRoot, targetId: TARGET_ID, watchId: WATCH_ID, cycleId: CYCLE,
    inputDigest: INPUT, modelVisibleBytes: 100,
  }, deps(T1));
  const input = {
    stateRoot,
    targetId: TARGET_ID,
    watchId: NEXT_WATCH_ID,
    provider: "claude",
    parentThreadSha256: "c".repeat(64),
    readyReceipt: nextReceipt(),
  };
  const nextDeps = {
    now: () => T1,
    readWatchStatus: async () => ({
      provider: "claude", watch_id: NEXT_WATCH_ID, target_id: TARGET_ID, status: "active",
    }),
  };
  await assert.rejects(initializeGeneration(input, nextDeps), expectCode("E_GENERATION_PREVIOUS_WATCH_UNRESOLVED"));
  assert.equal((await readGenerationState({ stateRoot, targetId: TARGET_ID })).watch_id, WATCH_ID);
});

test("同一reservationとcompletionは冪等、異なる値は拒否しbudgetはcompletion時だけ加算する", async () => {
  const stateRoot = await box(); await initialize(stateRoot);
  const first = await reserveGenerationInput({ stateRoot, targetId: TARGET_ID, watchId: WATCH_ID, cycleId: CYCLE, inputDigest: INPUT, modelVisibleBytes: 100 }, deps(T1));
  const retry = await reserveGenerationInput({ stateRoot, targetId: TARGET_ID, watchId: WATCH_ID, cycleId: CYCLE, inputDigest: INPUT, modelVisibleBytes: 100 }, deps(T1));
  assert.equal(first.outcome, "reserved"); assert.equal(retry.outcome, "reserved");
  await assert.rejects(
    reserveGenerationInput({ stateRoot, targetId: TARGET_ID, watchId: WATCH_ID, cycleId: CYCLE, inputDigest: INPUT, modelVisibleBytes: 101 }, deps(T1)),
    expectCode("E_GENERATION_RESERVATION_CONFLICT"),
  );
  const complete = await completeGenerationCycle({ stateRoot, targetId: TARGET_ID, watchId: WATCH_ID, cycleId: CYCLE, inputDigest: INPUT, modelVisibleBytes: 100, resultDigest: RESULT }, deps(T1));
  assert.equal(complete.completed_cycles, 1); assert.equal(complete.model_visible_bytes, 100);
  assert.equal((await completeGenerationCycle({ stateRoot, targetId: TARGET_ID, watchId: WATCH_ID, cycleId: CYCLE, inputDigest: INPUT, modelVisibleBytes: 100, resultDigest: RESULT }, deps(T1))).completed_cycles, 1);
  await assert.rejects(
    completeGenerationCycle({ stateRoot, targetId: TARGET_ID, watchId: WATCH_ID, cycleId: CYCLE, inputDigest: INPUT, modelVisibleBytes: 100, resultDigest: `sha256:${"f".repeat(64)}` }, deps(T1)),
    expectCode("E_GENERATION_COMPLETION_CONFLICT"),
  );
});

test("cycle上限とbyte上限はmodel前にplanned rolloverへ遷移し、fresh過大入力はfail closedする", async () => {
  const stateRoot = await box(); await initialize(stateRoot);
  await assert.rejects(
    reserveGenerationInput({ stateRoot, targetId: TARGET_ID, watchId: WATCH_ID, cycleId: CYCLE, inputDigest: INPUT, modelVisibleBytes: GENERATION_MAX_MODEL_VISIBLE_BYTES + 1 }, deps(T1)),
    expectCode("E_GENERATION_INPUT_TOO_LARGE"),
  );
  for (let index = 1; index <= GENERATION_MAX_COMPLETED_CYCLES; index += 1) {
    const digit = index.toString(16);
    const cycleId = `c_${digit.repeat(64)}`;
    const inputDigest = `sha256:${digit.repeat(64)}`;
    await reserveGenerationInput({ stateRoot, targetId: TARGET_ID, watchId: WATCH_ID, cycleId, inputDigest, modelVisibleBytes: 1 }, deps(T1));
    await completeGenerationCycle({ stateRoot, targetId: TARGET_ID, watchId: WATCH_ID, cycleId, inputDigest, modelVisibleBytes: 1, resultDigest: `sha256:${"f".repeat(64)}` }, deps(T1));
  }
  const rollover = await reserveGenerationInput({ stateRoot, targetId: TARGET_ID, watchId: WATCH_ID, cycleId: `c_${"f".repeat(64)}`, inputDigest: `sha256:${"f".repeat(64)}`, modelVisibleBytes: 1 }, deps(T1));
  assert.equal(rollover.outcome, "planned_rollover");
  assert.equal(rollover.state.status, "rollover_requested");
  assert.equal(rollover.state.rollover_reason, "completed_cycles");
});

test("terminal receipt確認前には次sequenceを開始できず、confirmed後だけstartingからactiveへ進む", async () => {
  const stateRoot = await box(); await initialize(stateRoot);
  const rollover = await reserveGenerationInput({ stateRoot, targetId: TARGET_ID, watchId: WATCH_ID, cycleId: CYCLE, inputDigest: INPUT, modelVisibleBytes: GENERATION_MAX_MODEL_VISIBLE_BYTES }, deps(T1));
  await completeGenerationCycle({ stateRoot, targetId: TARGET_ID, watchId: WATCH_ID, cycleId: CYCLE, inputDigest: INPUT, modelVisibleBytes: GENERATION_MAX_MODEL_VISIBLE_BYTES, resultDigest: RESULT }, deps(T1));
  const planned = await reserveGenerationInput({ stateRoot, targetId: TARGET_ID, watchId: WATCH_ID, cycleId: `c_${"f".repeat(64)}`, inputDigest: `sha256:${"f".repeat(64)}`, modelVisibleBytes: 1 }, deps(T1));
  assert.equal(rollover.outcome, "reserved"); assert.equal(planned.outcome, "planned_rollover");
  await assert.rejects(beginNextGeneration({ stateRoot, targetId: TARGET_ID, watchId: WATCH_ID }, deps(T1)), expectCode("E_GENERATION_TRANSITION_INVALID"));
  await requestGenerationStop({ stateRoot, targetId: TARGET_ID, watchId: WATCH_ID }, deps(T1));
  await assert.rejects(confirmGenerationTerminal({ stateRoot, targetId: TARGET_ID, watchId: WATCH_ID, terminalReceipt: receipt("stopped", "other-job") }, deps(T1)), expectCode("E_GENERATION_TERMINAL_HANDLE_MISMATCH"));
  await confirmGenerationTerminal({ stateRoot, targetId: TARGET_ID, watchId: WATCH_ID, terminalReceipt: receipt("stopped") }, deps(T1));
  const starting = await beginNextGeneration({ stateRoot, targetId: TARGET_ID, watchId: WATCH_ID }, deps(T1));
  assert.equal(starting.status, "starting"); assert.equal(starting.sequence, 2);
  assert.deepEqual(await beginNextGeneration({ stateRoot, targetId: TARGET_ID, watchId: WATCH_ID }, deps(T1)), starting);
  const active = await activateGeneration({ stateRoot, targetId: TARGET_ID, watchId: WATCH_ID, readyReceipt: receipt("ready", "job-private-2") }, deps(T1));
  assert.equal(active.status, "active"); assert.equal(active.sequence, 2);
  assert.deepEqual(await activateGeneration({ stateRoot, targetId: TARGET_ID, watchId: WATCH_ID, readyReceipt: receipt("ready", "job-private-2") }, deps(T1)), active);
  await assert.rejects(activateGeneration({ stateRoot, targetId: TARGET_ID, watchId: WATCH_ID, readyReceipt: receipt("ready", "job-private-3") }, deps(T1)), expectCode("E_GENERATION_ACTIVATION_CONFLICT"));
});

test("parent rebindは旧generationをmodel前に閉じnew epoch sequence 1だけを開始する", async () => {
  const stateRoot = await box();
  const initial = await initialize(stateRoot);
  const authorized = await authorizeGenerationRebind({
    stateRoot, targetId: TARGET_ID, watchId: WATCH_ID, expectedGenerationId: initial.generation_id,
  }, deps(T1));
  assert.equal(authorized.status, "rebind_required");
  assert.equal(authorized.rollover_reason, "parent_rebind");
  await assert.rejects(
    reserveGenerationInput({ stateRoot, targetId: TARGET_ID, watchId: WATCH_ID, cycleId: CYCLE, inputDigest: INPUT, modelVisibleBytes: 1 }, deps(T1)),
    expectCode("E_GENERATION_TRANSITION_INVALID"),
  );
  await requestGenerationRebindStop({
    stateRoot, targetId: TARGET_ID, watchId: WATCH_ID, expectedGenerationId: initial.generation_id,
  }, deps(T1));
  await confirmGenerationTerminal({
    stateRoot, targetId: TARGET_ID, watchId: WATCH_ID, terminalReceipt: receipt("stopped"),
  }, deps(T1));
  await assert.rejects(beginNextGeneration({ stateRoot, targetId: TARGET_ID, watchId: WATCH_ID }, deps(T1)), expectCode("E_GENERATION_TRANSITION_INVALID"));
  const nextThread = "f".repeat(64);
  const input = {
    stateRoot,
    targetId: TARGET_ID,
    watchId: WATCH_ID,
    nextProvider: "codex",
    parentThreadSha256: nextThread,
    expectedFromProvider: "claude",
    expectedFromGenerationId: initial.generation_id,
    expectedFromParentEpochId: initial.parent_epoch_id,
  };
  const starting = await beginReboundGeneration(input, deps(T1));
  assert.equal(starting.status, "starting");
  assert.equal(starting.provider, "codex");
  assert.equal(starting.sequence, 1);
  assert.equal(starting.parent_epoch_id, generationParentEpochId("codex", nextThread));
  assert.notEqual(starting.generation_id, initial.generation_id);
  await assert.rejects(beginNextGeneration({ stateRoot, targetId: TARGET_ID, watchId: WATCH_ID }, {
    now: () => T1,
    readWatchStatus: async () => ({ provider: "codex", watch_id: WATCH_ID, target_id: TARGET_ID, status: "active" }),
  }), expectCode("E_GENERATION_TRANSITION_INVALID"));
  assert.deepEqual(await beginReboundGeneration(input, deps(T1)), starting);
  const codexReady = {
    schema: "observer.host_receipt.v1", provider: "codex", watch_id: WATCH_ID, target_id: TARGET_ID, outcome: "ready",
    handle: { kind: "codex.thread", value: "11111111-1111-7111-8111-111111111111" },
  };
  const active = await activateGeneration({ stateRoot, targetId: TARGET_ID, watchId: WATCH_ID, readyReceipt: codexReady }, {
    now: () => T1,
    readWatchStatus: async () => ({ provider: "codex", watch_id: WATCH_ID, target_id: TARGET_ID, status: "active" }),
  });
  assert.equal(active.status, "active");
  assert.equal(active.sequence, 1);
  assert.equal(active.previous_terminal_receipt_digest !== null, true);
});

test("parent rebindはpending model reservationを正常終了へ丸めない", async () => {
  const stateRoot = await box();
  const initial = await initialize(stateRoot);
  await reserveGenerationInput({ stateRoot, targetId: TARGET_ID, watchId: WATCH_ID, cycleId: CYCLE, inputDigest: INPUT, modelVisibleBytes: 1 }, deps(T1));
  await assert.rejects(authorizeGenerationRebind({
    stateRoot, targetId: TARGET_ID, watchId: WATCH_ID, expectedGenerationId: initial.generation_id,
  }, deps(T1)), expectCode("E_GENERATION_REBIND_OPERATION_PENDING"));
});

test("generation identity、status relationship、invalid timestampをfail closedで拒否する", async () => {
  const stateRoot = await box();
  const state = await initialize(stateRoot);
  assert.throws(() => validateGenerationState({ ...state, generation_id: `sha256:${"f".repeat(64)}` }), expectCode("E_GENERATION_STATE_INVALID"));
  assert.throws(() => validateGenerationState({ ...state, rollover_reason: "completed_cycles" }), expectCode("E_GENERATION_STATE_INVALID"));
  assert.throws(() => validateGenerationState({ ...state, status: "rollover_requested", rollover_reason: "parent_rebind", pending_reservation: null }), expectCode("E_GENERATION_STATE_INVALID"));
  assert.throws(() => validateGenerationState({ ...state, created_at: "not-a-time" }), expectCode("E_GENERATION_STATE_INVALID"));
  assert.throws(() => validateGenerationState({ ...state, model_visible_bytes: 1 }), expectCode("E_GENERATION_STATE_INVALID"));
  assert.throws(() => validateGenerationState({
    ...state,
    completed_cycles: 1,
    model_visible_bytes: 1,
    last_completed_cycle: { cycle_id: CYCLE, input_digest: INPUT, model_visible_bytes: 2, result_digest: RESULT },
  }), expectCode("E_GENERATION_STATE_INVALID"));
  assert.throws(() => validateGenerationState({
    ...state,
    completed_cycles: 1,
    model_visible_bytes: GENERATION_MAX_MODEL_VISIBLE_BYTES,
    last_completed_cycle: { cycle_id: CYCLE, input_digest: INPUT, model_visible_bytes: 1, result_digest: RESULT },
    pending_reservation: { cycle_id: CYCLE, input_digest: INPUT, model_visible_bytes: 1 },
  }), expectCode("E_GENERATION_STATE_INVALID"));
});
