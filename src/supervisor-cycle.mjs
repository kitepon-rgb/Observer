import { fail, ObserverError } from "./observer-error.mjs";
import { commitProcessedCycle, cycleIdFor, markCycleProcessed, prepareCycle, readCycleState } from "./cycle-store.mjs";
import { readGenerationState } from "./generation-store.mjs";
import {
  acceptModelOperation,
  applyModelOperation,
  cleanupAppliedModelOperation,
  cleanupPreparedModelOperation,
  completeModelOperation,
  dispatchModelOperation,
  prepareModelOperation,
  readModelOperation,
  reserveModelOperation,
} from "./model-operation-store.mjs";
import { runFixedThroughReplay, runWatchCycle } from "./watch-cycle.mjs";

export const CYCLE_RESULT_SCHEMA = "observer.cycle_result.v1";
export const MODEL_OPERATION_CALLBACK_SCHEMA = "observer.model_operation_callback.v1";
export const MODEL_OPERATION_CLEANUP_SCHEMA = "observer.model_operation_cleanup.v1";
export const DEFAULT_PROJECTION_RETRIES = 3;

export async function runSupervisorCycle({
  stateRoot, target, watchId, client, prepareCycleInput,
  issueModelOperation, recoverModelOperation, cleanupProviderOperation, applyCycle, finalizeAppliedCycle,
  timeoutSeconds = 3600, projectionRetries = DEFAULT_PROJECTION_RETRIES, signal, store = defaultStore,
} = {}) {
  for (const callback of [prepareCycleInput, issueModelOperation, recoverModelOperation, cleanupProviderOperation, applyCycle, finalizeAppliedCycle]) {
    if (typeof callback !== "function") fail("E_SUPERVISOR_CALLBACK", "必須callbackが不正です");
  }
  if (!Number.isSafeInteger(projectionRetries) || projectionRetries < 0) fail("E_SUPERVISOR_RETRY_CONFIG", "projection retry設定が不正です");
  throwIfAborted(signal);
  const cycleState = await store.readCycleState({ stateRoot, targetId: target?.targetId });
  const { committed_state: committed, pending_cycle: pending } = cycleState;

  if (pending?.status === "processed") return recoverProcessed({ stateRoot, target, watchId, pending, store, finalizeAppliedCycle, signal });

  let cycle;
  let existingPending = pending;
  if (pending !== null && pending !== undefined) {
    requirePreparedBase({ committed, pending });
    cycle = await retryProjection(() => runFixedThroughReplay({ target, current: committed, throughCursor: pending.proposed_state.cursor, client, signal }), projectionRetries, signal);
    requireReplayedPending({ target, pending, cycle });
  } else {
    cycle = await runNormalCycle({ target, current: committed, client, timeoutSeconds, projectionRetries, signal });
  }
  if (cycle.status === "timeout") return { status: "timeout", proposed_state: committed, turns: [] };
  if (!['oriented', 'changed'].includes(cycle.status) || cycle.proposed_state === null) fail("E_SUPERVISOR_CYCLE", "supervisor cycle結果が不正です");

  const prepared = existingPending ?? await store.prepareCycle({ stateRoot, targetId: target.targetId, watchId, baseState: committed, proposedState: cycle.proposed_state });
  const expectedCycleId = cycleIdFor(target.targetId, committed?.cursor ?? null, cycle.proposed_state.cursor);
  if (prepared.cycle_id !== expectedCycleId || !sameParentState(prepared.proposed_state, cycle.proposed_state)) fail("E_CYCLE_PENDING_CONFLICT", "prepared cycleがreplayed cycleと一致しません");

  const input = await prepareCycleInput({ cycle_id: prepared.cycle_id, target, proposed_state: cycle.proposed_state, turns: cycle.turns, signal });
  validateCycleInput(input);
  const generation = await store.readGenerationState({ stateRoot, targetId: target.targetId });
  requireCurrentGeneration(generation, watchId, target.targetId);
  const identity = { stateRoot, targetId: target.targetId, watchId, provider: generation.provider, generationId: generation.generation_id, cycleId: prepared.cycle_id, inputDigest: input.input_digest, modelVisibleBytes: input.model_visible_bytes };

  let operation = await store.readModelOperation({ stateRoot, targetId: target.targetId });
  if (existingPending && operation === null && matchesReservation(generation.pending_reservation, identity)) {
    return modelResultUnknown(committed, prepared.cycle_id);
  }
  if (operation === null || operation.status === "prepared") {
    await store.prepareModelOperation(identity);
    operation = await requireOperation(store, stateRoot, target.targetId);
  }
  requireOperationIdentity(operation, identity);

  if (operation.status === "prepared" || operation.status === "reserved") {
    const reserved = await store.reserveModelOperation(identity);
    if (reserved.action === "rollover_required") {
      await store.cleanupPreparedModelOperation({ stateRoot, targetId: target.targetId, operationId: operation.operation_id });
      return { status: "rollover_required", proposed_state: committed, cycle_id: prepared.cycle_id, turns: [] };
    }
    if (reserved.action !== "issue_once") fail("E_SUPERVISOR_MODEL_OPERATION", "prepared operationをissueできません");
    await store.dispatchModelOperation({ stateRoot, targetId: target.targetId, operationId: operation.operation_id });
    operation = await requireOperation(store, stateRoot, target.targetId);
    const callback = await issueModelOperation({ operation: publicOperation(operation), value: input.value, signal });
    return handleProviderCallback({ callback, operation, identity, committed, prepared, cycle, store, cleanupProviderOperation, applyCycle, finalizeAppliedCycle, signal });
  }
  if (operation.status === "dispatching" || operation.status === "accepted") {
    const callback = await recoverModelOperation({ operation: publicOperation(operation, "recover_only"), signal });
    return handleProviderCallback({ callback, operation, identity, committed, prepared, cycle, store, cleanupProviderOperation, applyCycle, finalizeAppliedCycle, signal });
  }
  if (operation.status === "completed" || operation.status === "applied") {
    return applyAndFinalize({ operation, identity, committed, prepared, cycle, store, cleanupProviderOperation, applyCycle, finalizeAppliedCycle, signal });
  }
  fail("E_SUPERVISOR_MODEL_OPERATION", "model operation statusが不正です");
}

async function handleProviderCallback({ callback, operation, identity, committed, prepared, cycle, store, cleanupProviderOperation, applyCycle, finalizeAppliedCycle, signal }) {
  const result = validateModelCallback(callback);
  if (result.outcome === "unknown") return modelResultUnknown(committed, prepared.cycle_id);
  if (result.outcome === "pending") {
    if (operation.status !== "accepted") fail("E_SUPERVISOR_MODEL_CALLBACK", "dispatching operationはpendingにできません");
    return { status: "model_pending", proposed_state: committed, cycle_id: prepared.cycle_id, turns: [] };
  }
  if (result.outcome === "accepted") {
    await store.acceptModelOperation({ stateRoot: identity.stateRoot, targetId: identity.targetId, operationId: operation.operation_id, providerOperationReceiptDigest: result.provider_operation_receipt_digest });
    return { status: "model_pending", proposed_state: committed, cycle_id: prepared.cycle_id, turns: [] };
  }
  await store.acceptModelOperation({ stateRoot: identity.stateRoot, targetId: identity.targetId, operationId: operation.operation_id, providerOperationReceiptDigest: result.provider_operation_receipt_digest });
  await store.completeModelOperation({ stateRoot: identity.stateRoot, targetId: identity.targetId, operationId: operation.operation_id, rawOutput: result.raw_output });
  const completed = await requireOperation(store, identity.stateRoot, identity.targetId);
  return applyAndFinalize({ operation: completed, identity, committed, prepared, cycle, store, cleanupProviderOperation, applyCycle, finalizeAppliedCycle, signal });
}

async function applyAndFinalize({ operation, identity, committed, prepared, cycle, store, cleanupProviderOperation, applyCycle, finalizeAppliedCycle, signal }) {
  let applied = operation;
  if (operation.status === "completed") {
    validateProviderCleanupCallback(await cleanupProviderOperation({ operation: providerCleanupOperation(operation), signal }));
    const result = await applyCycle({ operation: publicOperation(operation), output: structuredClone(operation.completed_output), signal });
    validateCycleResult(result);
    await store.applyModelOperation({ stateRoot: identity.stateRoot, targetId: identity.targetId, operationId: operation.operation_id, appliedResult: result });
    applied = await requireOperation(store, identity.stateRoot, identity.targetId);
  }
  if (applied.status !== "applied") fail("E_SUPERVISOR_MODEL_OPERATION", "applied operationが必要です");
  await finalizeAppliedCycle({ operation: finalizedOperation(applied), signal });
  await store.markCycleProcessed({ stateRoot: identity.stateRoot, targetId: identity.targetId, watchId: identity.watchId, cycleId: prepared.cycle_id, inputDigest: identity.inputDigest, modelVisibleBytes: identity.modelVisibleBytes, resultDigest: applied.applied_result.result_digest });
  await store.cleanupAppliedModelOperation({ stateRoot: identity.stateRoot, targetId: identity.targetId, operationId: applied.operation_id });
  const state = await store.commitProcessedCycle({ stateRoot: identity.stateRoot, targetId: identity.targetId, watchId: identity.watchId, cycleId: prepared.cycle_id });
  return { status: "committed", proposed_state: state, cycle_id: prepared.cycle_id, turns: cycle.turns };
}

async function recoverProcessed({ stateRoot, target, watchId, pending, store, finalizeAppliedCycle, signal }) {
  const operation = await store.readModelOperation({ stateRoot, targetId: target.targetId });
  if (operation !== null) {
    if (operation.status !== "applied" || operation.target_id !== target.targetId || operation.watch_id !== watchId || operation.cycle_id !== pending.cycle_id || operation.input_digest !== pending.input_digest || operation.model_visible_bytes !== pending.model_visible_bytes || operation.applied_result?.result_digest !== pending.result_digest) fail("E_SUPERVISOR_MODEL_OPERATION", "processed cycleとmodel operationが一致しません");
    await finalizeAppliedCycle({ operation: finalizedOperation(operation), signal });
    await store.cleanupAppliedModelOperation({ stateRoot, targetId: target.targetId, operationId: operation.operation_id });
  }
  const state = await store.commitProcessedCycle({ stateRoot, targetId: target.targetId, watchId, cycleId: pending.cycle_id });
  return { status: "committed", proposed_state: state, cycle_id: pending.cycle_id, turns: [] };
}

export function validateCycleResult(value) {
  if (!plain(value) || Object.keys(value).sort().join(",") !== "result_digest,schema" || value.schema !== CYCLE_RESULT_SCHEMA || typeof value.result_digest !== "string" || !/^[a-f0-9]{64}$/.test(value.result_digest)) fail("E_CYCLE_RESULT_INVALID", "cycle callback resultが不正です");
  return value;
}

export function validateCycleInput(value) {
  if (!plain(value) || Object.keys(value).sort().join(",") !== "input_digest,model_visible_bytes,schema,value" || value.schema !== "observer.cycle_input.v1" || typeof value.input_digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.input_digest) || !Number.isSafeInteger(value.model_visible_bytes) || value.model_visible_bytes < 0) fail("E_CYCLE_INPUT_INVALID", "cycle inputが不正です");
  return value;
}

export function validateModelCallback(value) {
  if (!plain(value) || value.schema !== MODEL_OPERATION_CALLBACK_SCHEMA || typeof value.outcome !== "string") fail("E_SUPERVISOR_MODEL_CALLBACK", "model callback resultが不正です");
  const keys = Object.keys(value).sort().join(",");
  if (value.outcome === "accepted" && keys === "outcome,provider_operation_receipt_digest,schema" && digest(value.provider_operation_receipt_digest)) return value;
  if (value.outcome === "pending" && keys === "outcome,schema") return value;
  if (value.outcome === "completed" && keys === "outcome,provider_operation_receipt_digest,raw_output,schema" && digest(value.provider_operation_receipt_digest) && typeof value.raw_output === "string" && Buffer.byteLength(value.raw_output, "utf8") <= 16384) return value;
  if (value.outcome === "unknown" && keys === "outcome,reason,schema" && ["provider_operation_missing", "provider_result_unknown", "provider_unavailable"].includes(value.reason)) return value;
  fail("E_SUPERVISOR_MODEL_CALLBACK", "model callback resultが不正です");
}

export function validateProviderCleanupCallback(value) {
  if (!plain(value) || Object.keys(value).sort().join(",") !== "outcome,schema" || value.schema !== MODEL_OPERATION_CLEANUP_SCHEMA || value.outcome !== "cleaned") fail("E_SUPERVISOR_PROVIDER_CLEANUP", "provider cleanup resultが不正です");
  return value;
}

function publicOperation(operation, action = operation.status === "dispatching" ? "issue_once" : "recover_only") {
  return {
    schema: "observer.model_operation_receipt.v1", action,
    provider: operation.provider, operation_id: operation.operation_id, target_id: operation.target_id, watch_id: operation.watch_id,
    generation_id: operation.generation_id, cycle_id: operation.cycle_id, input_digest: operation.input_digest,
    model_visible_bytes: operation.model_visible_bytes, status: operation.status,
    provider_operation_receipt_digest: operation.provider_operation_receipt_digest,
  };
}

function providerCleanupOperation(operation) {
  if (operation.status !== "completed" || !digest(operation.provider_operation_receipt_digest) || !digest(operation.completed_output_digest)) fail("E_SUPERVISOR_PROVIDER_CLEANUP", "completed provider cleanup証拠が不正です");
  return { ...publicOperation(operation, "cleanup_only"), completed_output_digest: operation.completed_output_digest };
}

function finalizedOperation(operation) { return { ...publicOperation(operation), applied_result: structuredClone(operation.applied_result), completed_output_digest: operation.completed_output_digest }; }
function plain(value) { return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function digest(value) { return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value); }
function modelResultUnknown(committed, cycleId) { return { status: "model_result_unknown", proposed_state: committed, cycle_id: cycleId, turns: [] }; }
function matchesReservation(value, identity) { return value !== null && value?.cycle_id === identity.cycleId && value.input_digest === identity.inputDigest && value.model_visible_bytes === identity.modelVisibleBytes; }
function requireCurrentGeneration(value, watchId, targetId) { if (!value || value.target_id !== targetId || value.watch_id !== watchId || !["claude", "codex"].includes(value.provider) || !digest(value.generation_id)) fail("E_SUPERVISOR_GENERATION_MISMATCH", "current generationが不正です"); }
function requireOperationIdentity(operation, identity) { if (!operation || operation.target_id !== identity.targetId || operation.watch_id !== identity.watchId || operation.provider !== identity.provider || operation.generation_id !== identity.generationId || operation.cycle_id !== identity.cycleId || operation.input_digest !== identity.inputDigest || operation.model_visible_bytes !== identity.modelVisibleBytes) fail("E_SUPERVISOR_MODEL_OPERATION", "model operation identityが一致しません"); }
async function requireOperation(store, stateRoot, targetId) { const operation = await store.readModelOperation({ stateRoot, targetId }); if (operation === null) fail("E_SUPERVISOR_MODEL_OPERATION", "model operationがありません"); return operation; }

async function retryProjection(run, retries, signal) { for (let attempt = 0; attempt <= retries; attempt++) { throwIfAborted(signal); const cycle = await run(); if (cycle.status !== "projection_pending") return cycle; } fail("E_SUPERVISOR_PROJECTION_PENDING", "Throughline projectionが期限内に確定しません"); }
async function runNormalCycle({ target, current, client, timeoutSeconds, projectionRetries, signal }) { const first = await runWatchCycle({ target, current, client, timeoutSeconds, signal }); if (first.status !== "projection_pending") return first; if (typeof first.fixed_through_cursor === "string") return retryAfterPending(() => runFixedThroughReplay({ target, current, throughCursor: first.fixed_through_cursor, client, signal }), projectionRetries, signal); return retryAfterPending(() => runWatchCycle({ target, current, client, timeoutSeconds, signal }), projectionRetries, signal); }
async function retryAfterPending(run, retries, signal) { for (let attempt = 0; attempt < retries; attempt++) { throwIfAborted(signal); const cycle = await run(); if (cycle.status !== "projection_pending") return cycle; } fail("E_SUPERVISOR_PROJECTION_PENDING", "Throughline projectionが期限内に確定しません"); }
function requirePreparedBase({ committed, pending }) { if (pending.status !== "prepared" || (committed?.cursor ?? null) !== pending.base_cursor) fail("E_CYCLE_BASE_MISMATCH", "committed cursorがprepared cycleと一致しません"); }
function requireReplayedPending({ target, pending, cycle }) { if (!['oriented', 'changed'].includes(cycle.status) || cycle.proposed_state === null || !sameParentState(cycle.proposed_state, pending.proposed_state) || cycleIdFor(target.targetId, pending.base_cursor, cycle.proposed_state.cursor) !== pending.cycle_id) fail("E_CYCLE_PENDING_CONFLICT", "prepared cycleをfixed cursorで再構成できません"); }
function sameParentState(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function throwIfAborted(signal) { if (signal?.aborted) throw new ObserverError("E_THROUGHLINE_CANCELLED", "Throughline待機が取消されました"); }

const defaultStore = { readCycleState, prepareCycle, markCycleProcessed, commitProcessedCycle, readGenerationState, prepareModelOperation, reserveModelOperation, dispatchModelOperation, acceptModelOperation, completeModelOperation, applyModelOperation, readModelOperation, cleanupAppliedModelOperation, cleanupPreparedModelOperation };
