import { createHash } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";

import { observerAiOutputDigest, parseObserverAiOutput } from "./observer-ai-contract.mjs";
import { fail, ObserverError } from "./observer-error.mjs";
import { acquirePrivateLock, assertPrivateDirectory, assertWithin, atomicCreatePrivateFile, atomicReplacePrivateFile, readPrivateJson, removePrivateFile } from "./private-state.mjs";
import { readGenerationState, reserveGenerationInput } from "./generation-store.mjs";

export const MODEL_OPERATION_SCHEMA = "observer.model_operation.v1";
export const MODEL_OPERATION_RECEIPT_SCHEMA = "observer.model_operation_receipt.v1";
const STATUSES = new Set(["prepared", "reserved", "dispatching", "accepted", "completed", "applied"]);
const KEYS = Object.freeze(["applied_result", "applied_result_digest", "completed_output", "completed_output_digest", "created_at", "cycle_id", "generation_id", "input_digest", "model_visible_bytes", "operation_id", "provider", "provider_operation_receipt_digest", "schema", "status", "target_id", "updated_at", "watch_id"]);
const TARGET = /^p_[a-f0-9]{64}$/;
const WATCH = /^w_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const RESULT_DIGEST = /^[a-f0-9]{64}$/;
const CYCLE = /^c_[a-f0-9]{64}$/;

export async function prepareModelOperation(input, dependencies = {}) {
  validateIdentity(input); requireDigest(input.inputDigest, "input digest"); requireBytes(input.modelVisibleBytes);
  return transaction(input.stateRoot, input.targetId, dependencies, async ({ journalPath }) => {
    const expected = create(input, now(dependencies)); const existing = await read(journalPath);
    if (existing === null) { await atomicCreatePrivateFile(journalPath, serialize(expected)); return receipt(expected, "prepared", "created"); }
    requireSameIdentity(existing, expected); return receipt(existing, existing.status === "prepared" ? "prepared" : "recover_only", "existing");
  });
}

export async function reserveModelOperation(input, dependencies = {}) {
  validateIdentity(input); requireDigest(input.inputDigest, "input digest"); requireBytes(input.modelVisibleBytes);
  return transaction(input.stateRoot, input.targetId, dependencies, async ({ journalPath }) => {
    const state = await requireJournal(journalPath); requireMatchesInput(state, input);
    if (state.status !== "prepared" && state.status !== "reserved") return receipt(state, "recover_only", "already_dispatched");
    const generation = await (dependencies.readGenerationState ?? readGenerationState)({ stateRoot: input.stateRoot, targetId: input.targetId });
    if (generation === null || generation.provider !== state.provider || generation.watch_id !== state.watch_id || generation.generation_id !== state.generation_id) fail("E_MODEL_OPERATION_GENERATION_MISMATCH", "generation identityがoperationと一致しません");
    const reserved = await (dependencies.reserveGenerationInput ?? reserveGenerationInput)({ stateRoot: input.stateRoot, targetId: input.targetId, watchId: input.watchId, cycleId: input.cycleId, inputDigest: input.inputDigest, modelVisibleBytes: input.modelVisibleBytes }, dependencies.generationDependencies ?? {});
    if (reserved.outcome !== "reserved") return receipt(state, "rollover_required", "generation_rollover_planned");
    const next = state.status === "reserved" ? state : transition(state, { status: "reserved" }, dependencies);
    if (next !== state) await atomicReplacePrivateFile(journalPath, serialize(next));
    return receipt(next, "issue_once", "reservation_confirmed");
  });
}

export async function dispatchModelOperation({ stateRoot, targetId, operationId }, dependencies = {}) {
  return transaction(stateRoot, targetId, dependencies, async ({ journalPath }) => {
    const state = await requireJournal(journalPath); requireOperationId(state, operationId);
    if (state.status === "reserved") { const next = transition(state, { status: "dispatching" }, dependencies); await atomicReplacePrivateFile(journalPath, serialize(next)); return receipt(next, "issue_once", "dispatch_authorized"); }
    return receipt(state, "recover_only", "dispatch_not_repeatable");
  });
}

export async function acceptModelOperation({ stateRoot, targetId, operationId, providerOperationReceiptDigest }, dependencies = {}) {
  requireDigest(providerOperationReceiptDigest, "provider operation receipt digest");
  return transaction(stateRoot, targetId, dependencies, async ({ journalPath }) => {
    const state = await requireJournal(journalPath); requireOperationId(state, operationId);
    if (state.status === "accepted") { if (state.provider_operation_receipt_digest !== providerOperationReceiptDigest) fail("E_MODEL_OPERATION_RECEIPT_CONFLICT", "provider receipt digestが一致しません"); return receipt(state, "recover_only", "accepted"); }
    if (state.status !== "dispatching") fail("E_MODEL_OPERATION_TRANSITION_INVALID", "dispatchingだけをacceptedへ進められます");
    const next = transition(state, { status: "accepted", provider_operation_receipt_digest: providerOperationReceiptDigest }, dependencies); await atomicReplacePrivateFile(journalPath, serialize(next)); return receipt(next, "recover_only", "accepted");
  });
}

export async function completeModelOperation({ stateRoot, targetId, operationId, rawOutput }, dependencies = {}) {
  return transaction(stateRoot, targetId, dependencies, async ({ journalPath }) => {
    const state = await requireJournal(journalPath); requireOperationId(state, operationId);
    const output = parseObserverAiOutput(rawOutput); const outputDigest = `sha256:${observerAiOutputDigest(output)}`;
    if (state.status === "completed") { if (state.completed_output_digest !== outputDigest) fail("E_MODEL_OPERATION_OUTPUT_CONFLICT", "completed outputが一致しません"); return receipt(state, "recover_only", "completed"); }
    if (!new Set(["dispatching", "accepted"]).has(state.status)) fail("E_MODEL_OPERATION_TRANSITION_INVALID", "dispatchingまたはacceptedだけをcompletedへ進められます");
    const next = transition(state, { status: "completed", completed_output: output, completed_output_digest: outputDigest }, dependencies); await atomicReplacePrivateFile(journalPath, serialize(next)); return receipt(next, "apply_only", "completed");
  });
}

export async function applyModelOperation({ stateRoot, targetId, operationId, appliedResult }, dependencies = {}) {
  validateCycleResult(appliedResult);
  return transaction(stateRoot, targetId, dependencies, async ({ journalPath }) => {
    const state = await requireJournal(journalPath); requireOperationId(state, operationId);
    if (state.status === "applied") {
      if (!sameCycleResult(state.applied_result, appliedResult)) fail("E_MODEL_OPERATION_APPLY_CONFLICT", "applied resultが一致しません");
      return receipt(state, "recover_only", "applied");
    }
    if (state.status !== "completed") fail("E_MODEL_OPERATION_TRANSITION_INVALID", "completedだけをappliedへ進められます");
    const next = transition(state, { status: "applied", applied_result: structuredClone(appliedResult), applied_result_digest: appliedResult.result_digest }, dependencies);
    await atomicReplacePrivateFile(journalPath, serialize(next));
    return receipt(next, "applied", "applied");
  });
}

export async function readModelOperation({ stateRoot, targetId }) { const paths = await pathsFor(stateRoot, targetId); if (paths === null) return null; const state = await read(paths.journalPath); return state === null ? null : publicState(state); }
export async function cleanupAppliedModelOperation({ stateRoot, targetId, operationId }, dependencies = {}) { return cleanup(stateRoot, targetId, operationId, new Set(["applied"]), dependencies); }
export async function cleanupPreparedModelOperation({ stateRoot, targetId, operationId }, dependencies = {}) { return cleanup(stateRoot, targetId, operationId, new Set(["prepared"]), dependencies); }

async function cleanup(stateRoot, targetId, operationId, allowed, dependencies) { return transaction(stateRoot, targetId, dependencies, async ({ journalPath }) => { const state = await requireJournal(journalPath); requireOperationId(state, operationId); if (!allowed.has(state.status)) fail("E_MODEL_OPERATION_CLEANUP_FORBIDDEN", "このoperation statusはcleanupできません"); await removePrivateFile(journalPath); return { schema: MODEL_OPERATION_RECEIPT_SCHEMA, operation_id: state.operation_id, status: state.status, action: "cleaned", reason: "journal_removed" }; }); }
function create(input, timestamp) { const operationId = operationIdFor(input); return validate({ schema: MODEL_OPERATION_SCHEMA, provider: input.provider, target_id: input.targetId, watch_id: input.watchId, generation_id: input.generationId, cycle_id: input.cycleId, input_digest: input.inputDigest, model_visible_bytes: input.modelVisibleBytes, operation_id: operationId, status: "prepared", provider_operation_receipt_digest: null, completed_output: null, completed_output_digest: null, applied_result: null, applied_result_digest: null, created_at: timestamp, updated_at: timestamp }); }
function receipt(state, action, reason) { return { schema: MODEL_OPERATION_RECEIPT_SCHEMA, operation_id: state.operation_id, status: state.status, action, reason }; }
function transition(state, patch, dependencies) {
  const updatedAt = now(dependencies);
  if (Date.parse(updatedAt) < Date.parse(state.updated_at)) fail("E_MODEL_OPERATION_CLOCK_INVALID", "operation clockが後退しています");
  return validate({ ...state, ...patch, updated_at: updatedAt });
}
function operationIdFor(input) { return `sha256:${createHash("sha256").update(["observer.model_operation.v1", input.provider, input.targetId, input.watchId, input.generationId, input.cycleId, input.inputDigest, String(input.modelVisibleBytes)].join("\0"), "utf8").digest("hex")}`; }
async function pathsFor(stateRoot, targetId) { if (!isAbsolute(stateRoot)) fail("E_MODEL_OPERATION_PATH_INVALID", "state rootはabsolute pathが必要です"); const root = resolve(stateRoot); const watches = assertWithin(root, join(root, "watches")); const directory = assertWithin(root, join(watches, targetId)); try { await assertPrivateDirectory(root); await assertPrivateDirectory(watches); await assertPrivateDirectory(directory); } catch (error) { if (error instanceof ObserverError && error.code === "E_STATE_DIRECTORY_MISSING") return null; throw error; } return { journalPath: join(directory, "model-operation.json"), lockPath: join(directory, "model-operation.lock") }; }
async function transaction(stateRoot, targetId, dependencies, operation) { if (!TARGET.test(targetId)) fail("E_MODEL_OPERATION_IDENTITY_INVALID", "target IDが不正です"); const paths = await pathsFor(stateRoot, targetId); if (paths === null) fail("E_MODEL_OPERATION_NOT_FOUND", "target stateがありません"); const release = await acquirePrivateLock(paths.lockPath); try { return await operation(paths); } finally { await release(); } }
async function read(path) { try { return validate(await readPrivateJson(path)); } catch (error) { if (error?.code === "ENOENT") return null; throw error; } }
async function requireJournal(path) { const state = await read(path); if (state === null) fail("E_MODEL_OPERATION_NOT_FOUND", "model operationがありません"); return state; }
function validateIdentity(input) { if (!input || !TARGET.test(input.targetId) || !WATCH.test(input.watchId) || !DIGEST.test(input.generationId) || !CYCLE.test(input.cycleId) || !["claude", "codex"].includes(input.provider) || !isAbsolute(input.stateRoot)) fail("E_MODEL_OPERATION_IDENTITY_INVALID", "model operation identityが不正です"); }
function requireMatchesInput(state, input) { const expected = create(input, state.created_at); requireSameIdentity(state, expected); }
function requireSameIdentity(actual, expected) { for (const key of ["provider", "target_id", "watch_id", "generation_id", "cycle_id", "input_digest", "model_visible_bytes", "operation_id"]) if (actual[key] !== expected[key]) fail("E_MODEL_OPERATION_CONFLICT", "既存model operation identityが一致しません"); }
function requireOperationId(state, operationId) { requireDigest(operationId, "operation ID"); if (state.operation_id !== operationId) fail("E_MODEL_OPERATION_CONFLICT", "operation IDが一致しません"); }
function validate(value) {
  plain(value); exact(value, KEYS);
  if (value.schema !== MODEL_OPERATION_SCHEMA || !TARGET.test(value.target_id) || !WATCH.test(value.watch_id) || !DIGEST.test(value.generation_id) || !CYCLE.test(value.cycle_id) || !DIGEST.test(value.input_digest) || !DIGEST.test(value.operation_id) || !["claude", "codex"].includes(value.provider) || !STATUSES.has(value.status)) fail("E_MODEL_OPERATION_STATE_INVALID", "model operation schemaが不正です");
  requireBytes(value.model_visible_bytes); timestamp(value.created_at); timestamp(value.updated_at);
  if (Date.parse(value.updated_at) < Date.parse(value.created_at)) fail("E_MODEL_OPERATION_STATE_INVALID", "operation clockが後退しています");
  if (value.provider_operation_receipt_digest !== null) requireDigest(value.provider_operation_receipt_digest, "provider receipt digest");
  if (value.completed_output_digest !== null) requireDigest(value.completed_output_digest, "completed output digest");
  if (value.applied_result_digest !== null && !RESULT_DIGEST.test(value.applied_result_digest)) fail("E_MODEL_OPERATION_STATE_INVALID", "applied result digestが不正です");
  const completed = ["completed", "applied"].includes(value.status);
  if (completed !== (value.completed_output !== null && value.completed_output_digest !== null)) fail("E_MODEL_OPERATION_STATE_INVALID", "completed output relationshipが不正です");
  if (value.completed_output !== null) { const parsed = parseObserverAiOutput(JSON.stringify(value.completed_output)); if (`sha256:${observerAiOutputDigest(parsed)}` !== value.completed_output_digest) fail("E_MODEL_OPERATION_STATE_INVALID", "output digestが一致しません"); }
  const applied = value.status === "applied";
  if (applied !== (value.applied_result !== null && value.applied_result_digest !== null)) fail("E_MODEL_OPERATION_STATE_INVALID", "applied result relationshipが不正です");
  if (value.applied_result !== null) { validateCycleResult(value.applied_result); if (value.applied_result.result_digest !== value.applied_result_digest) fail("E_MODEL_OPERATION_STATE_INVALID", "applied result digestが一致しません"); }
  if (["prepared", "reserved", "dispatching"].includes(value.status) && value.provider_operation_receipt_digest !== null) fail("E_MODEL_OPERATION_STATE_INVALID", "pre-accepted receiptが不正です");
  if (value.status === "accepted" && value.provider_operation_receipt_digest === null) fail("E_MODEL_OPERATION_STATE_INVALID", "accepted receiptがありません");
  return value;
}
function publicState(state) { return structuredClone(state); }
function requireDigest(value, field) { if (typeof value !== "string" || !DIGEST.test(value)) fail("E_MODEL_OPERATION_STATE_INVALID", `${field}が不正です`); }
function requireBytes(value) { if (!Number.isSafeInteger(value) || value < 0 || value > 262144) fail("E_MODEL_OPERATION_STATE_INVALID", "model visible bytesが不正です"); }
function now(dependencies) { const value = (dependencies.now ?? (() => new Date()))(); if (!(value instanceof Date) || Number.isNaN(value.getTime())) fail("E_MODEL_OPERATION_CLOCK_INVALID", "clockが不正です"); return value.toISOString(); }
function timestamp(value) { if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail("E_MODEL_OPERATION_STATE_INVALID", "timestampが不正です"); }
function validateCycleResult(value) { plain(value); const keys = Object.keys(value).sort(); if (keys.length !== 2 || keys[0] !== "result_digest" || keys[1] !== "schema" || value.schema !== "observer.cycle_result.v1" || typeof value.result_digest !== "string" || !RESULT_DIGEST.test(value.result_digest)) fail("E_MODEL_OPERATION_APPLY_RESULT_INVALID", "cycle resultが不正です"); }
function sameCycleResult(left, right) { return left.schema === right.schema && left.result_digest === right.result_digest; }
function plain(value) { if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail("E_MODEL_OPERATION_STATE_INVALID", "stateはplain objectが必要です"); }
function exact(value, keys) { const actual = Object.keys(value).sort(); const wanted = [...keys].sort(); if (actual.length !== wanted.length || actual.some((key, i) => key !== wanted[i])) fail("E_MODEL_OPERATION_STATE_INVALID", "state fieldが不正です"); }
function serialize(value) { return `${JSON.stringify(value)}\n`; }
