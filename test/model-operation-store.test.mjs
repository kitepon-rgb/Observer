import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  acceptModelOperation,
  applyModelOperation,
  cleanupAppliedModelOperation,
  cleanupPreparedModelOperation,
  completeModelOperation,
  dispatchModelOperation,
  inspectModelOperationLock,
  prepareModelOperation,
  readModelOperation,
  recoverModelOperationLock,
  reserveModelOperation,
} from "../src/model-operation-store.mjs";
import { ObserverError } from "../src/observer-error.mjs";
import { acquirePrivateLock } from "../src/private-state.mjs";

const targetId = `p_${"a".repeat(64)}`;
const watchId = "w_11111111-1111-4111-8111-111111111111";
const generationId = `sha256:${"b".repeat(64)}`;
const cycleId = `c_${"c".repeat(64)}`;
const inputDigest = `sha256:${"d".repeat(64)}`;
const receiptDigest = `sha256:${"e".repeat(64)}`;
const cycleResult = { schema: "observer.cycle_result.v1", result_digest: "f".repeat(64) };

async function setup() {
  const stateRoot = await mkdtemp(join(tmpdir(), "model-operation-"));
  await chmod(stateRoot, 0o700);
  await mkdir(join(stateRoot, "watches", targetId), { recursive: true, mode: 0o700 });
  return stateRoot;
}

function input(stateRoot, patch = {}) {
  return { stateRoot, targetId, watchId, generationId, cycleId, inputDigest, modelVisibleBytes: 8, provider: "codex", ...patch };
}

function generation(patch = {}) { return { provider: "codex", watch_id: watchId, generation_id: generationId, status: "active", pending_reservation: null, ...patch }; }
function dependencies() { return { readGenerationState: async () => generation(), reserveGenerationInput: async () => ({ outcome: "reserved" }) }; }
function expect(code) { return (error) => error instanceof ObserverError && error.code === code; }

async function completed(stateRoot) {
  const prepared = await prepareModelOperation(input(stateRoot));
  await reserveModelOperation(input(stateRoot), dependencies());
  await dispatchModelOperation({ stateRoot, targetId, operationId: prepared.operation_id });
  await acceptModelOperation({ stateRoot, targetId, operationId: prepared.operation_id, providerOperationReceiptDigest: receiptDigest });
  await completeModelOperation({ stateRoot, targetId, operationId: prepared.operation_id, rawOutput: '{"schema":"observer.ai_output.v1","outcome":"no_advisory"}' });
  return prepared;
}

test("preparedはreservation前に耐久化し、matching reservation後だけdispatchingへ進む", async () => {
  const stateRoot = await setup();
  const prepared = await prepareModelOperation(input(stateRoot));
  assert.equal(prepared.status, "prepared");
  const reserved = await reserveModelOperation(input(stateRoot), dependencies());
  assert.equal(reserved.action, "issue_once");
  const issued = await dispatchModelOperation({ stateRoot, targetId, operationId: prepared.operation_id });
  assert.equal(issued.status, "dispatching");
  assert.equal((await dispatchModelOperation({ stateRoot, targetId, operationId: prepared.operation_id })).action, "recover_only");
});

test("identity conflictと禁止遷移をfail closedにする", async () => {
  const stateRoot = await setup();
  const prepared = await prepareModelOperation(input(stateRoot));
  await assert.rejects(prepareModelOperation(input(stateRoot, { modelVisibleBytes: 9 })), expect("E_MODEL_OPERATION_CONFLICT"));
  await assert.rejects(acceptModelOperation({ stateRoot, targetId, operationId: prepared.operation_id, providerOperationReceiptDigest: receiptDigest }), expect("E_MODEL_OPERATION_TRANSITION_INVALID"));
  await assert.rejects(applyModelOperation({ stateRoot, targetId, operationId: prepared.operation_id, appliedResult: cycleResult }), expect("E_MODEL_OPERATION_TRANSITION_INVALID"));
});

test("acceptedはreceipt digestだけ、completedは16KiB以下のstrict canonical outputだけを保存する", async () => {
  const stateRoot = await setup();
  const prepared = await prepareModelOperation(input(stateRoot));
  await reserveModelOperation(input(stateRoot), dependencies());
  await dispatchModelOperation({ stateRoot, targetId, operationId: prepared.operation_id });
  await acceptModelOperation({ stateRoot, targetId, operationId: prepared.operation_id, providerOperationReceiptDigest: receiptDigest });
  await assert.rejects(completeModelOperation({ stateRoot, targetId, operationId: prepared.operation_id, rawOutput: "x".repeat(16 * 1024 + 1) }), expect("E_OBSERVER_AI_OUTPUT_LIMIT"));
  await completeModelOperation({ stateRoot, targetId, operationId: prepared.operation_id, rawOutput: '{"schema":"observer.ai_output.v1","outcome":"no_advisory"}' });
  const state = await readModelOperation({ stateRoot, targetId });
  assert.deepEqual(state.completed_output, { schema: "observer.ai_output.v1", outcome: "no_advisory" });
  assert.equal(JSON.stringify(state).includes("raw-thread"), false);
});

test("completeはacceptedだけを許しdispatching shortcutを拒否する", async () => {
  const stateRoot = await setup();
  const prepared = await prepareModelOperation(input(stateRoot));
  await reserveModelOperation(input(stateRoot), dependencies());
  await dispatchModelOperation({ stateRoot, targetId, operationId: prepared.operation_id });
  await assert.rejects(
    completeModelOperation({ stateRoot, targetId, operationId: prepared.operation_id, rawOutput: '{"schema":"observer.ai_output.v1","outcome":"no_advisory"}' }),
    expect("E_MODEL_OPERATION_TRANSITION_INVALID"),
  );
});

test("appliedはexact cycle result本体を保存し、同一resultだけ冪等に回復する", async () => {
  const stateRoot = await setup();
  const prepared = await completed(stateRoot);
  await applyModelOperation({ stateRoot, targetId, operationId: prepared.operation_id, appliedResult: cycleResult });
  const state = await readModelOperation({ stateRoot, targetId });
  assert.deepEqual(state.applied_result, cycleResult);
  await applyModelOperation({ stateRoot, targetId, operationId: prepared.operation_id, appliedResult: cycleResult });
  await assert.rejects(applyModelOperation({ stateRoot, targetId, operationId: prepared.operation_id, appliedResult: { ...cycleResult, result_digest: "0".repeat(64) } }), expect("E_MODEL_OPERATION_APPLY_CONFLICT"));
});

test("journalは0600、lock競合は0700 private lockを維持する", async () => {
  const stateRoot = await setup();
  const prepared = await prepareModelOperation(input(stateRoot));
  const directory = join(stateRoot, "watches", targetId);
  assert.equal((await stat(join(directory, "model-operation.json"))).mode & 0o777, 0o600);
  const lock = join(directory, "model-operation.lock");
  await mkdir(lock, { mode: 0o700 });
  assert.equal((await stat(lock)).mode & 0o777, 0o700);
  await assert.rejects(dispatchModelOperation({ stateRoot, targetId, operationId: prepared.operation_id }), expect("E_CONSUMER_LOCKED"));
  await rm(lock, { recursive: true });
});

test("model lockはinspect nonceを明示したrecoverだけを許しwrong nonceとunknown fileを拒否する", async () => {
  const stateRoot = await setup();
  await prepareModelOperation(input(stateRoot));
  const lockPath = join(stateRoot, "watches", targetId, "model-operation.lock");
  await acquirePrivateLock(lockPath);
  const observed = await inspectModelOperationLock({ stateRoot, targetId });
  assert.equal(typeof observed.nonce, "string");
  await assert.rejects(recoverModelOperationLock({ stateRoot, targetId, expectedNonce: "wrong" }), expect("E_LOCK_OWNERSHIP_MISMATCH"));
  await writeFile(join(lockPath, "unexpected"), "x\n", { mode: 0o600 });
  await assert.rejects(recoverModelOperationLock({ stateRoot, targetId, expectedNonce: observed.nonce }), expect("E_LOCK_STATE_INVALID"));
  await rm(lockPath, { recursive: true });
  await acquirePrivateLock(lockPath);
  const recoveredOwner = await inspectModelOperationLock({ stateRoot, targetId });
  await recoverModelOperationLock({ stateRoot, targetId, expectedNonce: recoveredOwner.nonce });
});

test("corrupt relationshipとtimestamp後退をread時に拒否する", async () => {
  const stateRoot = await setup();
  await prepareModelOperation(input(stateRoot));
  const path = join(stateRoot, "watches", targetId, "model-operation.json");
  const corrupt = JSON.parse(await readFile(path, "utf8"));
  corrupt.status = "accepted";
  await writeFile(path, `${JSON.stringify(corrupt)}\n`, { mode: 0o600 });
  await assert.rejects(readModelOperation({ stateRoot, targetId }), expect("E_MODEL_OPERATION_STATE_INVALID"));
  corrupt.status = "prepared";
  corrupt.applied_result = cycleResult;
  corrupt.applied_result_digest = cycleResult.result_digest;
  await writeFile(path, `${JSON.stringify(corrupt)}\n`, { mode: 0o600 });
  await assert.rejects(readModelOperation({ stateRoot, targetId }), expect("E_MODEL_OPERATION_STATE_INVALID"));
  corrupt.applied_result = null;
  corrupt.applied_result_digest = null;
  corrupt.created_at = "2026-07-15T01:00:00.000Z";
  corrupt.updated_at = "2026-07-15T00:00:00.000Z";
  await writeFile(path, `${JSON.stringify(corrupt)}\n`, { mode: 0o600 });
  await assert.rejects(readModelOperation({ stateRoot, targetId }), expect("E_MODEL_OPERATION_STATE_INVALID"));
});

test("transitionは直前updated_atより時計を後退させない", async () => {
  const stateRoot = await setup();
  const prepared = await prepareModelOperation(input(stateRoot), { now: () => new Date("2026-07-15T01:00:00.000Z") });
  await assert.rejects(
    reserveModelOperation(input(stateRoot), { ...dependencies(), now: () => new Date("2026-07-15T00:00:00.000Z") }),
    expect("E_MODEL_OPERATION_CLOCK_INVALID"),
  );
  assert.equal((await readModelOperation({ stateRoot, targetId })).operation_id, prepared.operation_id);
});

test("cleanupはplanned rolloverのpreparedとprocessed移管後のappliedに限定する", async () => {
  const stateRoot = await setup();
  const prepared = await prepareModelOperation(input(stateRoot));
  await cleanupPreparedModelOperation({ stateRoot, targetId, operationId: prepared.operation_id });
  assert.equal(await readModelOperation({ stateRoot, targetId }), null);
  const applied = await completed(stateRoot);
  await assert.rejects(cleanupAppliedModelOperation({ stateRoot, targetId, operationId: applied.operation_id }), expect("E_MODEL_OPERATION_CLEANUP_FORBIDDEN"));
  await applyModelOperation({ stateRoot, targetId, operationId: applied.operation_id, appliedResult: cycleResult });
  await cleanupAppliedModelOperation({ stateRoot, targetId, operationId: applied.operation_id }, {
    readCycleState: async () => ({ pending_cycle: { status: "processed", watch_id: watchId, cycle_id: cycleId, input_digest: inputDigest, model_visible_bytes: 8, result_digest: cycleResult.result_digest } }),
  });
  assert.equal(await readModelOperation({ stateRoot, targetId }), null);
});

test("planned rolloverのsame generation preparedはreservationなしを照合してcleanup可能なrollover_requiredへ回復する", async () => {
  const stateRoot = await setup();
  const prepared = await prepareModelOperation(input(stateRoot));
  const recovered = await reserveModelOperation(input(stateRoot), {
    readGenerationState: async () => generation({ status: "rollover_requested", pending_reservation: null }),
    reserveGenerationInput: async () => { throw new Error("must not reserve"); },
  });
  assert.deepEqual({ action: recovered.action, reason: recovered.reason }, { action: "rollover_required", reason: "generation_rollover_planned" });
  await cleanupPreparedModelOperation({ stateRoot, targetId, operationId: prepared.operation_id });
  assert.equal(await readModelOperation({ stateRoot, targetId }), null);
});

test("旧generationのpreparedだけをcurrent generation一致時に新operationへatomic置換する", async () => {
  const stateRoot = await setup();
  const old = await prepareModelOperation(input(stateRoot));
  const nextGenerationId = `sha256:${"9".repeat(64)}`;
  const replaced = await prepareModelOperation(input(stateRoot, { generationId: nextGenerationId }), {
    readGenerationState: async () => generation({ generation_id: nextGenerationId, pending_reservation: null }),
  });
  assert.notEqual(replaced.operation_id, old.operation_id);
  assert.equal(replaced.reason, "old_prepared_replaced");
  assert.equal((await readModelOperation({ stateRoot, targetId })).generation_id, nextGenerationId);
});

test("reserved operationはgeneration交代後も置換せずfail closedにする", async () => {
  const stateRoot = await setup();
  await prepareModelOperation(input(stateRoot));
  await reserveModelOperation(input(stateRoot), dependencies());
  const nextGenerationId = `sha256:${"9".repeat(64)}`;
  await assert.rejects(
    prepareModelOperation(input(stateRoot, { generationId: nextGenerationId }), { readGenerationState: async () => generation({ generation_id: nextGenerationId }) }),
    expect("E_MODEL_OPERATION_CONFLICT"),
  );
});
