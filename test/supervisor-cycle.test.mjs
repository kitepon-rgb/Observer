import assert from "node:assert/strict";
import test from "node:test";

import { cycleIdFor } from "../src/cycle-store.mjs";
import { runSupervisorCycle, validateModelCallback, validateProviderCleanupCallback } from "../src/supervisor-cycle.mjs";

const TARGET = { schema: "observer.project_target.v1", targetId: `p_${"a".repeat(64)}`, projectRoot: "/project" };
const WATCH_ID = "w_11111111-1111-4111-8111-111111111111";
const CURRENT = parent("tlc1.after");
const INPUT = { schema: "observer.cycle_input.v1", input_digest: `sha256:${"e".repeat(64)}`, model_visible_bytes: 42, value: { prompt: "ephemeral-only" } };
const PROVIDER_RECEIPT = `sha256:${"f".repeat(64)}`;
const RESULT = { schema: "observer.cycle_result.v1", result_digest: "d".repeat(64) };

function parent(cursor) { return { schema: "observer.parent_state.v1", target_id: TARGET.targetId, project_root: TARGET.projectRoot, status: "ready", host: "claude", thread_sha256: "b".repeat(64), cursor }; }
function client() { return { wait: async () => ({ schema: "throughline.observer_wait.v1", status: "changed", afterCursor: CURRENT.cursor, throughCursor: "tlc1.fixed" }), read: async () => ({ schema: "throughline.observer_read.v1", status: "delta", afterCursor: CURRENT.cursor, throughCursor: "tlc1.fixed", host: "claude", thread_sha256: "b".repeat(64), turns: [{ n: 1 }], historyTruncated: false, page: { complete: true, nextToken: null } }) }; }
function callback(outcome, fields = {}) { return { schema: "observer.model_operation_callback.v1", outcome, ...fields }; }
function cleanupCallback() { return { schema: "observer.model_operation_cleanup.v1", outcome: "cleaned" }; }
function operation(identity, status = "prepared") { return { schema: "observer.model_operation.v1", provider: identity.provider, target_id: identity.targetId, watch_id: identity.watchId, generation_id: identity.generationId, cycle_id: identity.cycleId, input_digest: identity.inputDigest, model_visible_bytes: identity.modelVisibleBytes, operation_id: `sha256:${"c".repeat(64)}`, status, provider_operation_receipt_digest: status === "accepted" || status === "completed" || status === "applied" ? PROVIDER_RECEIPT : null, completed_output: status === "completed" || status === "applied" ? { schema: "observer.ai_output.v1", outcome: "no_advisory" } : null, completed_output_digest: status === "completed" || status === "applied" ? `sha256:${"1".repeat(64)}` : null, applied_result: status === "applied" ? RESULT : null, applied_result_digest: status === "applied" ? RESULT.result_digest : null }; }

function fakeStore({ pendingCycle = null, initialOperation = undefined, generationReservation = null, rollover = false, generationTargetId = TARGET.targetId } = {}) {
  const calls = [];
  const generation = { target_id: generationTargetId, provider: "claude", watch_id: WATCH_ID, generation_id: `sha256:${"9".repeat(64)}`, pending_reservation: generationReservation };
  let pending = pendingCycle;
  let currentOperation = initialOperation;
  const store = {
    calls,
    async readCycleState() { calls.push("read"); return { committed_state: CURRENT, pending_cycle: pending }; },
    async prepareCycle(input) { calls.push("prepare"); pending = { status: "prepared", cycle_id: cycleIdFor(TARGET.targetId, CURRENT.cursor, input.proposedState.cursor), watch_id: WATCH_ID, base_cursor: CURRENT.cursor, proposed_state: input.proposedState }; return pending; },
    async readGenerationState() { calls.push("generation"); return generation; },
    async readModelOperation() { calls.push("read-model"); return currentOperation === undefined ? null : structuredClone(currentOperation); },
    async prepareModelOperation(identity) { calls.push("prepare-model"); currentOperation = operation(identity); },
    async reserveModelOperation() { calls.push("reserve-model"); if (rollover) return { action: "rollover_required" }; currentOperation.status = "reserved"; return { action: "issue_once" }; },
    async dispatchModelOperation() { calls.push("dispatch"); currentOperation.status = "dispatching"; },
    async acceptModelOperation(input) { calls.push("accept"); currentOperation.status = "accepted"; currentOperation.provider_operation_receipt_digest = input.providerOperationReceiptDigest; },
    async completeModelOperation() { calls.push("complete"); currentOperation.status = "completed"; currentOperation.completed_output = { schema: "observer.ai_output.v1", outcome: "no_advisory" }; currentOperation.completed_output_digest = `sha256:${"1".repeat(64)}`; },
    async applyModelOperation(input) { calls.push("apply-store"); currentOperation.status = "applied"; currentOperation.applied_result = input.appliedResult; currentOperation.applied_result_digest = input.appliedResult.result_digest; },
    async cleanupPreparedModelOperation() { calls.push("cleanup-prepared"); currentOperation = null; },
    async markCycleProcessed() { calls.push("processed"); pending = { ...pending, status: "processed", input_digest: INPUT.input_digest, model_visible_bytes: INPUT.model_visible_bytes, result_digest: RESULT.result_digest }; },
    async cleanupAppliedModelOperation() { calls.push("cleanup-applied"); currentOperation = null; },
    async commitProcessedCycle() { calls.push("commit"); pending = null; return parent("tlc1.fixed"); },
  };
  return store;
}
function callbacks({ issue = callback("accepted", { provider_operation_receipt_digest: PROVIDER_RECEIPT }), recover = callback("pending"), apply = RESULT } = {}) {
  return {
    prepareCycleInput: async () => structuredClone(INPUT),
    issueModelOperation: async input => issue,
    recoverModelOperation: async input => recover,
    cleanupProviderOperation: async () => cleanupCallback(),
    applyCycle: async input => apply,
    finalizeAppliedCycle: async () => undefined,
  };
}
function run(store, callbacksOverride = {}) { return runSupervisorCycle({ stateRoot: "/state", target: TARGET, watchId: WATCH_ID, client: client(), store, ...callbacks(callbacksOverride) }); }

test("prepared journalをreservationより先に作り、dispatch後だけissueしてacceptedを保存する", async () => {
  const store = fakeStore(); let issued;
  const result = await runSupervisorCycle({ stateRoot: "/state", target: TARGET, watchId: WATCH_ID, client: client(), store, ...callbacks({ issue: callback("accepted", { provider_operation_receipt_digest: PROVIDER_RECEIPT }) }), issueModelOperation: async input => { issued = input; return callback("accepted", { provider_operation_receipt_digest: PROVIDER_RECEIPT }); } });
  assert.equal(result.status, "model_pending");
  assert.equal(issued.operation.action, "issue_once");
  assert.deepEqual(issued.value, INPUT.value);
  assert.deepEqual(store.calls, ["read", "prepare", "generation", "read-model", "prepare-model", "read-model", "reserve-model", "dispatch", "read-model", "accept"]);
});

test("dispatching recoveryはvalueなしでrecoverだけを呼び、pendingを許可しない", async () => {
  const cycleId = cycleIdFor(TARGET.targetId, CURRENT.cursor, "tlc1.fixed");
  const identity = { stateRoot: "/state", targetId: TARGET.targetId, watchId: WATCH_ID, provider: "claude", generationId: `sha256:${"9".repeat(64)}`, cycleId, inputDigest: INPUT.input_digest, modelVisibleBytes: INPUT.model_visible_bytes };
  const pending = { status: "prepared", cycle_id: cycleId, watch_id: WATCH_ID, base_cursor: CURRENT.cursor, proposed_state: parent("tlc1.fixed") };
  const store = fakeStore({ pendingCycle: pending, initialOperation: operation(identity, "dispatching") }); let recovered;
  await assert.rejects(runSupervisorCycle({ stateRoot: "/state", target: TARGET, watchId: WATCH_ID, client: client(), store, ...callbacks({ recover: callback("pending") }), recoverModelOperation: async input => { recovered = input; return callback("pending"); } }), { code: "E_SUPERVISOR_MODEL_CALLBACK" });
  assert.equal("value" in recovered, false);
  assert.equal(recovered.operation.action, "recover_only");
});

test("completed callbackはaccept→complete→provider cleanup→apply→finalize→processed→cleanup→commitする", async () => {
  const store = fakeStore(); const order = [];
  const result = await runSupervisorCycle({ stateRoot: "/state", target: TARGET, watchId: WATCH_ID, client: client(), store, ...callbacks({ issue: callback("completed", { provider_operation_receipt_digest: PROVIDER_RECEIPT, raw_output: '{"schema":"observer.ai_output.v1","outcome":"no_advisory"}' }) }), cleanupProviderOperation: async input => { store.calls.push("cleanup-provider"); order.push("cleanup-provider"); assert.equal(input.operation.action, "cleanup_only"); assert.equal(input.operation.status, "completed"); assert.equal(input.operation.provider_operation_receipt_digest, PROVIDER_RECEIPT); assert.equal(input.operation.completed_output_digest, `sha256:${"1".repeat(64)}`); assert.equal("completed_output" in input.operation, false); return cleanupCallback(); }, applyCycle: async input => { order.push("apply-callback"); assert.equal(input.operation.action, "recover_only"); return RESULT; }, finalizeAppliedCycle: async input => { order.push("finalize"); assert.deepEqual(input.operation.applied_result, RESULT); assert.equal("completed_output" in input.operation, false); } });
  assert.equal(result.status, "committed");
  assert.deepEqual(order, ["cleanup-provider", "apply-callback", "finalize"]);
  assert.deepEqual(store.calls.slice(-9), ["accept", "complete", "read-model", "cleanup-provider", "apply-store", "read-model", "processed", "cleanup-applied", "commit"]);
});

test("既存reservationとjournal欠損はmodel_result_unknown、planned rolloverはpreparedだけcleanupする", async () => {
  const cycleId = cycleIdFor(TARGET.targetId, CURRENT.cursor, "tlc1.fixed");
  const pending = { status: "prepared", cycle_id: cycleId, watch_id: WATCH_ID, base_cursor: CURRENT.cursor, proposed_state: parent("tlc1.fixed") };
  const unknown = await run(fakeStore({ pendingCycle: pending, generationReservation: { cycle_id: cycleId, input_digest: INPUT.input_digest, model_visible_bytes: INPUT.model_visible_bytes } }));
  assert.equal(unknown.status, "model_result_unknown");
  const rollover = await run(fakeStore({ rollover: true }));
  assert.equal(rollover.status, "rollover_required");
  assert.equal(rollover.proposed_state, CURRENT);
});

test("processed recoveryはmatching appliedだけfinalize/cleanupし、journal無しはcommitだけ", async () => {
  const cycleId = cycleIdFor(TARGET.targetId, CURRENT.cursor, "tlc1.fixed");
  const pending = { status: "processed", cycle_id: cycleId, watch_id: WATCH_ID, input_digest: INPUT.input_digest, model_visible_bytes: INPUT.model_visible_bytes, result_digest: RESULT.result_digest };
  const identity = { stateRoot: "/state", targetId: TARGET.targetId, watchId: WATCH_ID, provider: "claude", generationId: `sha256:${"9".repeat(64)}`, cycleId, inputDigest: INPUT.input_digest, modelVisibleBytes: INPUT.model_visible_bytes };
  const store = fakeStore({ pendingCycle: pending, initialOperation: operation(identity, "applied") }); let finalized = 0;
  await runSupervisorCycle({ stateRoot: "/state", target: TARGET, watchId: WATCH_ID, client: client(), store, ...callbacks(), finalizeAppliedCycle: async () => { finalized++; } });
  assert.equal(finalized, 1);
  assert.deepEqual(store.calls, ["read", "read-model", "cleanup-applied", "commit"]);
  const wrongTarget = fakeStore({ pendingCycle: pending, initialOperation: { ...operation(identity, "applied"), target_id: `p_${"0".repeat(64)}` } });
  await assert.rejects(run(wrongTarget), { code: "E_SUPERVISOR_MODEL_OPERATION" });
  const noJournal = fakeStore({ pendingCycle: pending });
  await run(noJournal);
  assert.deepEqual(noJournal.calls, ["read", "read-model", "commit"]);
});

test("callback throwとunknown fieldは丸めず伝播またはfail closedする", async () => {
  const store = fakeStore();
  await assert.rejects(runSupervisorCycle({ stateRoot: "/state", target: TARGET, watchId: WATCH_ID, client: client(), store, ...callbacks(), issueModelOperation: async () => { throw new Error("provider down"); } }), /provider down/);
  await assert.rejects(run(fakeStore(), { issue: { ...callback("accepted", { provider_operation_receipt_digest: PROVIDER_RECEIPT }), extra: true } }), { code: "E_SUPERVISOR_MODEL_CALLBACK" });
});

test("generation target mismatchはjournal作成前に拒否する", async () => {
  const store = fakeStore({ generationTargetId: `p_${"0".repeat(64)}` });
  await assert.rejects(run(store), { code: "E_SUPERVISOR_GENERATION_MISMATCH" });
  assert.deepEqual(store.calls, ["read", "prepare", "generation"]);
});

test("timeoutとprojection pending retryはmodel/cycle journalを余計に変更しない", async () => {
  const timeoutStore = fakeStore();
  const timeout = await runSupervisorCycle({ stateRoot: "/state", target: TARGET, watchId: WATCH_ID, store: timeoutStore, client: { wait: async () => ({ schema: "throughline.observer_wait.v1", status: "timeout", afterCursor: CURRENT.cursor, throughCursor: CURRENT.cursor }), read: async () => assert.fail("timeout must not read") }, ...callbacks() });
  assert.equal(timeout.status, "timeout");
  assert.deepEqual(timeoutStore.calls, ["read"]);

  const store = fakeStore(); let reads = 0;
  const result = await runSupervisorCycle({ stateRoot: "/state", target: TARGET, watchId: WATCH_ID, store, projectionRetries: 1, client: {
    wait: async () => ({ schema: "throughline.observer_wait.v1", status: "changed", afterCursor: CURRENT.cursor, throughCursor: "tlc1.fixed" }),
    read: async () => (++reads === 1 ? { schema: "throughline.observer_read.v1", status: "projection_pending", afterCursor: CURRENT.cursor, throughCursor: null, host: "claude", thread_sha256: "b".repeat(64), turns: [], historyTruncated: false, page: { complete: false, nextToken: null } } : { schema: "throughline.observer_read.v1", status: "delta", afterCursor: CURRENT.cursor, throughCursor: "tlc1.fixed", host: "claude", thread_sha256: "b".repeat(64), turns: [], historyTruncated: false, page: { complete: true, nextToken: null } }),
  }, ...callbacks() });
  assert.equal(reads, 2); assert.equal(result.status, "model_pending");
});

test("prepared fixed-cursor recoveryとoversized inputは4 callback境界でも維持する", async () => {
  const cycleId = cycleIdFor(TARGET.targetId, CURRENT.cursor, "tlc1.fixed");
  const pending = { status: "prepared", cycle_id: cycleId, watch_id: WATCH_ID, base_cursor: CURRENT.cursor, proposed_state: parent("tlc1.fixed") };
  const store = fakeStore({ pendingCycle: pending }); let issue = 0;
  const recovered = await runSupervisorCycle({ stateRoot: "/state", target: TARGET, watchId: WATCH_ID, store, client: client(), ...callbacks(), issueModelOperation: async () => { issue++; return callback("accepted", { provider_operation_receipt_digest: PROVIDER_RECEIPT }); } });
  assert.equal(recovered.status, "model_pending"); assert.equal(issue, 1);
  const largeStore = fakeStore();
  largeStore.reserveModelOperation = async input => { largeStore.calls.push("reserve-model"); assert.equal(input.modelVisibleBytes, 262145); throw Object.assign(new Error("large"), { code: "E_GENERATION_INPUT_TOO_LARGE" }); };
  await assert.rejects(runSupervisorCycle({ stateRoot: "/state", target: TARGET, watchId: WATCH_ID, store: largeStore, client: client(), ...callbacks(), prepareCycleInput: async () => ({ ...INPUT, model_visible_bytes: 262145 }) }), { code: "E_GENERATION_INPUT_TOO_LARGE" });
});

test("invalid cycle resultはprocessed/commitせず、accepted recoveryはpending/completed/unknownを区別する", async () => {
  const badStore = fakeStore();
  await assert.rejects(runSupervisorCycle({ stateRoot: "/state", target: TARGET, watchId: WATCH_ID, store: badStore, client: client(), ...callbacks({ issue: callback("completed", { provider_operation_receipt_digest: PROVIDER_RECEIPT, raw_output: '{"schema":"observer.ai_output.v1","outcome":"no_advisory"}' }), apply: { schema: "observer.cycle_result.v1", result_digest: "bad" } }) }), { code: "E_CYCLE_RESULT_INVALID" });
  assert.equal(badStore.calls.includes("processed"), false); assert.equal(badStore.calls.includes("commit"), false);
  const cycleId = cycleIdFor(TARGET.targetId, CURRENT.cursor, "tlc1.fixed");
  const identity = { stateRoot: "/state", targetId: TARGET.targetId, watchId: WATCH_ID, provider: "claude", generationId: `sha256:${"9".repeat(64)}`, cycleId, inputDigest: INPUT.input_digest, modelVisibleBytes: INPUT.model_visible_bytes };
  const pending = { status: "prepared", cycle_id: cycleId, watch_id: WATCH_ID, base_cursor: CURRENT.cursor, proposed_state: parent("tlc1.fixed") };
  for (const recover of [callback("pending"), callback("unknown", { reason: "provider_result_unknown" })]) {
    const store = fakeStore({ pendingCycle: pending, initialOperation: operation(identity, "accepted") }); let issued = 0; let input;
    const result = await runSupervisorCycle({ stateRoot: "/state", target: TARGET, watchId: WATCH_ID, store, client: client(), ...callbacks(), issueModelOperation: async () => { issued++; }, recoverModelOperation: async value => { input = value; return recover; } });
    assert.equal(result.status, recover.outcome === "pending" ? "model_pending" : "model_result_unknown"); assert.equal(issued, 0); assert.equal("value" in input, false);
  }
});

test("accepted recoveryのcompletedと既存appliedはapply再実行なしで正しい順序へ進む", async () => {
  const cycleId = cycleIdFor(TARGET.targetId, CURRENT.cursor, "tlc1.fixed");
  const identity = { stateRoot: "/state", targetId: TARGET.targetId, watchId: WATCH_ID, provider: "claude", generationId: `sha256:${"9".repeat(64)}`, cycleId, inputDigest: INPUT.input_digest, modelVisibleBytes: INPUT.model_visible_bytes };
  const pending = { status: "prepared", cycle_id: cycleId, watch_id: WATCH_ID, base_cursor: CURRENT.cursor, proposed_state: parent("tlc1.fixed") };
  const completedStore = fakeStore({ pendingCycle: pending, initialOperation: operation(identity, "accepted") }); let issue = 0;
  const completed = await runSupervisorCycle({ stateRoot: "/state", target: TARGET, watchId: WATCH_ID, store: completedStore, client: client(), ...callbacks(), issueModelOperation: async () => { issue++; }, recoverModelOperation: async () => callback("completed", { provider_operation_receipt_digest: PROVIDER_RECEIPT, raw_output: '{"schema":"observer.ai_output.v1","outcome":"no_advisory"}' }) });
  assert.equal(completed.status, "committed"); assert.equal(issue, 0);
  const appliedStore = fakeStore({ pendingCycle: pending, initialOperation: operation(identity, "applied") }); let apply = 0; const order = [];
  const applied = await runSupervisorCycle({ stateRoot: "/state", target: TARGET, watchId: WATCH_ID, store: appliedStore, client: client(), ...callbacks(), applyCycle: async () => { apply++; }, finalizeAppliedCycle: async () => { order.push("finalize"); } });
  assert.equal(applied.status, "committed"); assert.equal(apply, 0); assert.deepEqual(order, ["finalize"]);
  assert.deepEqual(appliedStore.calls.slice(-3), ["processed", "cleanup-applied", "commit"]);
});

test("callback schemaはreceipt、raw output、unknown enumをfail closedにする", () => {
  const invalid = [
    callback("completed", { raw_output: "{}" }),
    callback("accepted", { provider_operation_receipt_digest: "bad" }),
    callback("completed", { provider_operation_receipt_digest: PROVIDER_RECEIPT, raw_output: "x".repeat(16385) }),
    callback("unknown", { reason: "other" }),
    { ...callback("pending"), extra: true },
  ];
  for (const value of invalid) assert.throws(() => validateModelCallback(value), { code: "E_SUPERVISOR_MODEL_CALLBACK" });
  assert.deepEqual(validateProviderCleanupCallback(cleanupCallback()), cleanupCallback());
  for (const value of [undefined, { ...cleanupCallback(), extra: true }, { ...cleanupCallback(), outcome: "pending" }]) assert.throws(() => validateProviderCleanupCallback(value), { code: "E_SUPERVISOR_PROVIDER_CLEANUP" });
});

test("provider cleanup失敗や不正結果はapplyせずそのまま停止する", async () => {
  const invalid = fakeStore();
  await assert.rejects(runSupervisorCycle({ stateRoot: "/state", target: TARGET, watchId: WATCH_ID, client: client(), store: invalid, ...callbacks({ issue: callback("completed", { provider_operation_receipt_digest: PROVIDER_RECEIPT, raw_output: '{"schema":"observer.ai_output.v1","outcome":"no_advisory"}' }) }), cleanupProviderOperation: async () => undefined }), { code: "E_SUPERVISOR_PROVIDER_CLEANUP" });
  assert.equal(invalid.calls.includes("apply-store"), false);

  const thrown = fakeStore();
  await assert.rejects(runSupervisorCycle({ stateRoot: "/state", target: TARGET, watchId: WATCH_ID, client: client(), store: thrown, ...callbacks({ issue: callback("completed", { provider_operation_receipt_digest: PROVIDER_RECEIPT, raw_output: '{"schema":"observer.ai_output.v1","outcome":"no_advisory"}' }) }), cleanupProviderOperation: async () => { throw new Error("cleanup failed"); } }), /cleanup failed/);
  assert.equal(thrown.calls.includes("apply-store"), false);
});

test("store strict parserが拒否するinvalid raw outputはaccept後もcompletedへ進めない", async () => {
  const store = fakeStore();
  store.completeModelOperation = async ({ rawOutput }) => { store.calls.push("complete"); assert.equal(rawOutput, "{}"); throw Object.assign(new Error("invalid output"), { code: "E_OBSERVER_AI_OUTPUT_INVALID" }); };
  await assert.rejects(runSupervisorCycle({ stateRoot: "/state", target: TARGET, watchId: WATCH_ID, store, client: client(), ...callbacks({ issue: callback("completed", { provider_operation_receipt_digest: PROVIDER_RECEIPT, raw_output: "{}" }) }) }), { code: "E_OBSERVER_AI_OUTPUT_INVALID" });
  assert.equal(store.calls.includes("processed"), false);
});

test("old-generation preparedはstore再照合でcurrent generationへ置換しissueできる", async () => {
  const cycleId = cycleIdFor(TARGET.targetId, CURRENT.cursor, "tlc1.fixed");
  const pending = { status: "prepared", cycle_id: cycleId, watch_id: WATCH_ID, base_cursor: CURRENT.cursor, proposed_state: parent("tlc1.fixed") };
  const oldIdentity = { stateRoot: "/state", targetId: TARGET.targetId, watchId: WATCH_ID, provider: "claude", generationId: `sha256:${"8".repeat(64)}`, cycleId, inputDigest: INPUT.input_digest, modelVisibleBytes: INPUT.model_visible_bytes };
  const store = fakeStore({ pendingCycle: pending, initialOperation: operation(oldIdentity, "prepared") }); let issued = 0;
  const result = await runSupervisorCycle({ stateRoot: "/state", target: TARGET, watchId: WATCH_ID, store, client: client(), ...callbacks(), issueModelOperation: async () => { issued++; return callback("accepted", { provider_operation_receipt_digest: PROVIDER_RECEIPT }); } });
  assert.equal(result.status, "model_pending"); assert.equal(issued, 1); assert.equal(store.calls.filter((value) => value === "prepare-model").length, 1);
});

test("old-generation reservedはprepareを再呼出しせずidentity mismatchを拒否する", async () => {
  const cycleId = cycleIdFor(TARGET.targetId, CURRENT.cursor, "tlc1.fixed");
  const pending = { status: "prepared", cycle_id: cycleId, watch_id: WATCH_ID, base_cursor: CURRENT.cursor, proposed_state: parent("tlc1.fixed") };
  const oldIdentity = { stateRoot: "/state", targetId: TARGET.targetId, watchId: WATCH_ID, provider: "claude", generationId: `sha256:${"8".repeat(64)}`, cycleId, inputDigest: INPUT.input_digest, modelVisibleBytes: INPUT.model_visible_bytes };
  const store = fakeStore({ pendingCycle: pending, initialOperation: operation(oldIdentity, "reserved") });
  await assert.rejects(run(store), { code: "E_SUPERVISOR_MODEL_OPERATION" });
  assert.equal(store.calls.includes("prepare-model"), false);
});
