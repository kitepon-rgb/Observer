import { createHash } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";

import { fail, ObserverError } from "./observer-error.mjs";
import {
  acquirePrivateLock,
  assertPrivateDirectory,
  assertWithin,
  atomicCreatePrivateFile,
  atomicReplacePrivateFile,
  readPrivateJson,
} from "./private-state.mjs";
import { validateParentHostReceipt } from "./parent-launch.mjs";
import { readWatchStatus } from "./watch-store.mjs";

export const GENERATION_STATE_SCHEMA = "observer.generation_state.v1";
export const GENERATION_MAX_COMPLETED_CYCLES = 8;
export const GENERATION_MAX_MODEL_VISIBLE_BYTES = 262_144;

const TARGET_ID_RE = /^p_[a-f0-9]{64}$/;
const WATCH_ID_RE = /^w_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const HEX_RE = /^[a-f0-9]{64}$/;
const STATUS = new Set(["active", "rollover_requested", "rebind_required", "stopping", "terminal_confirmed", "starting"]);
const STATE_KEYS = Object.freeze([
  "activation_receipt_digest", "completed_cycles", "created_at", "generation_id", "host_handle_digest",
  "last_completed_cycle", "model_visible_bytes", "parent_epoch_id", "pending_reservation", "previous_terminal_receipt_digest",
  "provider", "rollover_reason", "schema", "sequence", "status", "target_id", "terminal_receipt_digest",
  "updated_at", "watch_id",
]);

export async function initializeGeneration({ stateRoot, targetId, watchId, provider, parentThreadSha256, readyReceipt }, dependencies = {}) {
  validateIdentity({ targetId, watchId, provider });
  requireHex(parentThreadSha256, "parent thread digest");
  validateReceipt(readyReceipt, "ready", { targetId, watchId, provider });
  const paths = await requirePaths(stateRoot, targetId);
  return withGenerationTransaction(paths, { stateRoot, targetId, watchId, provider }, dependencies, async () => {
    const existing = await readState(paths.statePath);
    const parentEpochId = parentEpoch(provider, parentThreadSha256);
    if (existing !== null) {
      if (existing.watch_id === watchId && existing.parent_epoch_id === parentEpochId && existing.sequence === 1 && existing.status === "active" && sameReady(existing, readyReceipt)) return publicState(existing);
      fail("E_GENERATION_ALREADY_EXISTS", "同じtargetには既存generation stateがあります");
    }
    const timestamp = now(dependencies.now);
    const state = validateGenerationState({
      schema: GENERATION_STATE_SCHEMA, watch_id: watchId, target_id: targetId, provider, parent_epoch_id: parentEpochId,
      generation_id: generationId(watchId, parentEpochId, 1), sequence: 1, status: "active", rollover_reason: null,
      host_handle_digest: digestValue(readyReceipt.handle), activation_receipt_digest: digestValue(readyReceipt), terminal_receipt_digest: null,
      previous_terminal_receipt_digest: null, completed_cycles: 0, model_visible_bytes: 0, pending_reservation: null,
      last_completed_cycle: null, created_at: timestamp, updated_at: timestamp,
    });
    await atomicCreatePrivateFile(paths.statePath, serialize(state));
    return publicState(state);
  });
}

export async function readGenerationState({ stateRoot, targetId }) {
  validateTargetId(targetId);
  const paths = await generationPaths(stateRoot, targetId);
  if (paths === null) return null;
  const state = await readState(paths.statePath);
  return state === null ? null : publicState(state);
}

export function generationParentEpochId(provider, parentThreadSha256) {
  if (!["claude", "codex"].includes(provider)) invalid("generation providerが不正です");
  requireHex(parentThreadSha256, "parent thread digest");
  return parentEpoch(provider, parentThreadSha256);
}

export async function reserveGenerationInput({ stateRoot, targetId, watchId, cycleId, inputDigest, modelVisibleBytes }, dependencies = {}) {
  validateTargetId(targetId); validateWatchId(watchId); validateCycleId(cycleId); requireDigest(inputDigest, "input digest"); validateInputBytes(modelVisibleBytes);
  const paths = await requirePaths(stateRoot, targetId);
  return withGenerationTransaction(paths, { stateRoot, targetId, watchId }, dependencies, async () => {
    const state = await requireState(paths.statePath);
    requireActive(state);
    const reservation = { cycle_id: cycleId, input_digest: inputDigest, model_visible_bytes: modelVisibleBytes };
    if (state.pending_reservation !== null) {
      if (sameReservation(state.pending_reservation, reservation)) return { outcome: "reserved", reservation: "existing", state: publicState(state) };
      fail("E_GENERATION_RESERVATION_CONFLICT", "別のpending reservationがあります");
    }
    if (modelVisibleBytes > GENERATION_MAX_MODEL_VISIBLE_BYTES) fail("E_GENERATION_INPUT_TOO_LARGE", "fresh generationでもinput上限を超えています");
    if (state.completed_cycles >= GENERATION_MAX_COMPLETED_CYCLES || state.model_visible_bytes + modelVisibleBytes > GENERATION_MAX_MODEL_VISIBLE_BYTES) {
      const next = transition(state, { status: "rollover_requested", rollover_reason: state.completed_cycles >= GENERATION_MAX_COMPLETED_CYCLES ? "completed_cycles" : "model_visible_bytes" }, dependencies.now);
      await atomicReplacePrivateFile(paths.statePath, serialize(next));
      return { outcome: "planned_rollover", state: publicState(next) };
    }
    const next = transition(state, { pending_reservation: reservation }, dependencies.now);
    await atomicReplacePrivateFile(paths.statePath, serialize(next));
    return { outcome: "reserved", reservation: "created", state: publicState(next) };
  });
}

export async function completeGenerationCycle({ stateRoot, targetId, watchId, cycleId, inputDigest, modelVisibleBytes, resultDigest }, dependencies = {}) {
  validateTargetId(targetId); validateWatchId(watchId); validateCycleId(cycleId); requireDigest(inputDigest, "input digest"); validateInputBytes(modelVisibleBytes); requireDigest(resultDigest, "result digest");
  const paths = await requirePaths(stateRoot, targetId);
  return withGenerationTransaction(paths, { stateRoot, targetId, watchId }, dependencies, async () => {
    const state = await requireState(paths.statePath);
    requireActive(state);
    const completed = { cycle_id: cycleId, input_digest: inputDigest, model_visible_bytes: modelVisibleBytes, result_digest: resultDigest };
    if (state.last_completed_cycle !== null && state.last_completed_cycle.cycle_id === cycleId) {
      if (sameCompleted(state.last_completed_cycle, completed)) return publicState(state);
      fail("E_GENERATION_COMPLETION_CONFLICT", "同じcycleのcompletionが一致しません");
    }
    if (state.pending_reservation === null || !sameReservation(state.pending_reservation, completed)) fail("E_GENERATION_RESERVATION_REQUIRED", "matching reservationが必要です");
    const next = completeGenerationState(state, completed, dependencies.now);
    await atomicReplacePrivateFile(paths.statePath, serialize(next));
    return publicState(next);
  });
}

export function completeGenerationState(state, completed, clock = undefined) {
  validateGenerationState(state); validateCompleted(completed, false);
  requireActive(state);
  if (state.last_completed_cycle !== null && state.last_completed_cycle.cycle_id === completed.cycle_id) {
    if (sameCompleted(state.last_completed_cycle, completed)) return structuredClone(state);
    fail("E_GENERATION_COMPLETION_CONFLICT", "同じcycleのcompletionが一致しません");
  }
  if (state.pending_reservation === null || !sameReservation(state.pending_reservation, completed)) fail("E_GENERATION_RESERVATION_REQUIRED", "matching reservationが必要です");
  return transition(state, { completed_cycles: state.completed_cycles + 1, model_visible_bytes: state.model_visible_bytes + completed.model_visible_bytes, pending_reservation: null, last_completed_cycle: structuredClone(completed) }, clock);
}

export async function requestGenerationStop({ stateRoot, targetId, watchId }, dependencies = {}) {
  validateTargetId(targetId); validateWatchId(watchId);
  const paths = await requirePaths(stateRoot, targetId);
  return withGenerationTransaction(paths, { stateRoot, targetId, watchId }, dependencies, async () => {
    const state = await requireState(paths.statePath);
    requireWatch(state, watchId);
    if (state.status === "stopping") return publicState(state);
    if (state.status !== "rollover_requested") fail("E_GENERATION_TRANSITION_INVALID", "rollover requestedだけをstoppingへ進められます");
    const next = transition(state, { status: "stopping" }, dependencies.now);
    await atomicReplacePrivateFile(paths.statePath, serialize(next));
    return publicState(next);
  });
}

export async function authorizeGenerationRebind({ stateRoot, targetId, watchId, expectedGenerationId }, dependencies = {}) {
  validateTargetId(targetId); validateWatchId(watchId); requireDigest(expectedGenerationId, "expected generation ID");
  const paths = await requirePaths(stateRoot, targetId);
  return withGenerationTransaction(paths, { stateRoot, targetId, watchId }, dependencies, async () => {
    const state = await requireState(paths.statePath);
    requireWatch(state, watchId);
    if (state.generation_id !== expectedGenerationId) fail("E_GENERATION_REBIND_IDENTITY_CHANGED", "rebind対象generationが変化しました");
    if (state.status === "rebind_required") return publicState(state);
    if (state.status !== "active") fail("E_GENERATION_REBIND_TRANSITION_INVALID", "active generationだけをrebind認可できます");
    if (state.pending_reservation !== null) fail("E_GENERATION_REBIND_OPERATION_PENDING", "pending model reservationがあるgenerationはrebindできません");
    const next = transition(state, { status: "rebind_required", rollover_reason: "parent_rebind" }, dependencies.now);
    await atomicReplacePrivateFile(paths.statePath, serialize(next));
    return publicState(next);
  });
}

export async function requestGenerationRebindStop({ stateRoot, targetId, watchId, expectedGenerationId }, dependencies = {}) {
  validateTargetId(targetId); validateWatchId(watchId); requireDigest(expectedGenerationId, "expected generation ID");
  const paths = await requirePaths(stateRoot, targetId);
  return withGenerationTransaction(paths, { stateRoot, targetId, watchId }, dependencies, async () => {
    const state = await requireState(paths.statePath);
    requireWatch(state, watchId);
    if (state.generation_id !== expectedGenerationId) fail("E_GENERATION_REBIND_IDENTITY_CHANGED", "rebind停止対象generationが変化しました");
    if (state.status === "stopping" && state.rollover_reason === "parent_rebind") return publicState(state);
    if (state.status !== "rebind_required") fail("E_GENERATION_REBIND_TRANSITION_INVALID", "rebind requiredだけをstoppingへ進められます");
    const next = transition(state, { status: "stopping" }, dependencies.now);
    await atomicReplacePrivateFile(paths.statePath, serialize(next));
    return publicState(next);
  });
}

export async function confirmGenerationTerminal({ stateRoot, targetId, watchId, terminalReceipt }, dependencies = {}) {
  validateTargetId(targetId); validateWatchId(watchId);
  const paths = await requirePaths(stateRoot, targetId);
  return withGenerationTransaction(paths, { stateRoot, targetId, watchId }, dependencies, async () => {
    const state = await requireState(paths.statePath);
    requireWatch(state, watchId);
    validateReceipt(terminalReceipt, "stopped", state);
    if (state.status === "terminal_confirmed" && state.terminal_receipt_digest === digestValue(terminalReceipt)) return publicState(state);
    if (state.status !== "stopping") fail("E_GENERATION_TRANSITION_INVALID", "stoppingだけをterminal confirmedへ進められます");
    if (state.host_handle_digest !== digestValue(terminalReceipt.handle)) fail("E_GENERATION_TERMINAL_HANDLE_MISMATCH", "terminal receipt handleが保存済みgenerationと一致しません");
    const next = transition(state, { status: "terminal_confirmed", terminal_receipt_digest: digestValue(terminalReceipt) }, dependencies.now);
    await atomicReplacePrivateFile(paths.statePath, serialize(next));
    return publicState(next);
  });
}

export async function beginNextGeneration({ stateRoot, targetId, watchId }, dependencies = {}) {
  validateTargetId(targetId); validateWatchId(watchId);
  const paths = await requirePaths(stateRoot, targetId);
  return withGenerationTransaction(paths, { stateRoot, targetId, watchId }, dependencies, async () => {
    const state = await requireState(paths.statePath);
    requireWatch(state, watchId);
    if (state.status === "starting") {
      if (state.sequence > 1) return publicState(state);
      fail("E_GENERATION_TRANSITION_INVALID", "parent rebind startingをplanned rolloverとして回収できません");
    }
    if (state.status !== "terminal_confirmed" || !["completed_cycles", "model_visible_bytes"].includes(state.rollover_reason)) fail("E_GENERATION_TRANSITION_INVALID", "planned rolloverのterminal confirmed前に次generationを開始できません");
    const sequence = state.sequence + 1;
    const next = validateGenerationState({
      ...state, generation_id: generationId(state.watch_id, state.parent_epoch_id, sequence), sequence, status: "starting", rollover_reason: null,
      host_handle_digest: null, activation_receipt_digest: null, previous_terminal_receipt_digest: state.terminal_receipt_digest,
      terminal_receipt_digest: null, completed_cycles: 0, model_visible_bytes: 0, pending_reservation: null, last_completed_cycle: null,
      updated_at: nextTime(state, dependencies.now),
    });
    await atomicReplacePrivateFile(paths.statePath, serialize(next));
    return publicState(next);
  });
}

export async function beginReboundGeneration({
  stateRoot,
  targetId,
  watchId,
  nextProvider,
  parentThreadSha256,
  expectedFromProvider,
  expectedFromGenerationId,
  expectedFromParentEpochId,
}, dependencies = {}) {
  validateTargetId(targetId); validateWatchId(watchId); validateIdentity({ targetId, watchId, provider: nextProvider });
  validateIdentity({ targetId, watchId, provider: expectedFromProvider });
  requireHex(parentThreadSha256, "parent thread digest");
  requireDigest(expectedFromGenerationId, "expected generation ID");
  requireDigest(expectedFromParentEpochId, "expected parent epoch ID");
  const paths = await requirePaths(stateRoot, targetId);
  return withGenerationTransaction(paths, { stateRoot, targetId, watchId, provider: expectedFromProvider }, dependencies, async () => {
    const state = await requireState(paths.statePath);
    requireWatch(state, watchId);
    const nextParentEpochId = parentEpoch(nextProvider, parentThreadSha256);
    if (state.status === "starting" && state.sequence === 1 && state.provider === nextProvider &&
        state.parent_epoch_id === nextParentEpochId && state.previous_terminal_receipt_digest !== null) return publicState(state);
    if (state.generation_id !== expectedFromGenerationId || state.parent_epoch_id !== expectedFromParentEpochId || state.provider !== expectedFromProvider) {
      fail("E_GENERATION_REBIND_IDENTITY_CHANGED", "rebind元generation identityが変化しました");
    }
    if (state.status !== "terminal_confirmed" || state.rollover_reason !== "parent_rebind") {
      fail("E_GENERATION_REBIND_TRANSITION_INVALID", "rebind terminal confirmed前にnew epochを開始できません");
    }
    if (nextParentEpochId === state.parent_epoch_id) fail("E_GENERATION_REBIND_EPOCH_UNCHANGED", "同じparent epochへrebindできません");
    const next = validateGenerationState({
      ...state,
      provider: nextProvider,
      parent_epoch_id: nextParentEpochId,
      generation_id: generationId(state.watch_id, nextParentEpochId, 1),
      sequence: 1,
      status: "starting",
      rollover_reason: null,
      host_handle_digest: null,
      activation_receipt_digest: null,
      previous_terminal_receipt_digest: state.terminal_receipt_digest,
      terminal_receipt_digest: null,
      completed_cycles: 0,
      model_visible_bytes: 0,
      pending_reservation: null,
      last_completed_cycle: null,
      updated_at: nextTime(state, dependencies.now),
    });
    await atomicReplacePrivateFile(paths.statePath, serialize(next));
    return publicState(next);
  });
}

export async function activateGeneration({ stateRoot, targetId, watchId, readyReceipt }, dependencies = {}) {
  validateTargetId(targetId); validateWatchId(watchId);
  const paths = await requirePaths(stateRoot, targetId);
  return withGenerationTransaction(paths, { stateRoot, targetId, watchId }, dependencies, async () => {
    const state = await requireState(paths.statePath);
    requireWatch(state, watchId);
    validateReceipt(readyReceipt, "ready", state);
    if (state.status === "active") {
      if (sameReady(state, readyReceipt)) return publicState(state);
      fail("E_GENERATION_ACTIVATION_CONFLICT", "active generationのready receiptが一致しません");
    }
    if (state.status !== "starting") fail("E_GENERATION_TRANSITION_INVALID", "startingだけをactiveへ進められます");
    const next = transition(state, { status: "active", host_handle_digest: digestValue(readyReceipt.handle), activation_receipt_digest: digestValue(readyReceipt) }, dependencies.now);
    await atomicReplacePrivateFile(paths.statePath, serialize(next));
    return publicState(next);
  });
}

export function validateGenerationState(state) {
  plain(state, "generation state"); exact(state, STATE_KEYS, "generation state");
  if (state.schema !== GENERATION_STATE_SCHEMA) invalid("generation schemaが不正です");
  validateIdentity(state); requireDigest(state.parent_epoch_id, "parent epoch ID"); requireDigest(state.generation_id, "generation ID");
  if (!Number.isSafeInteger(state.sequence) || state.sequence < 1 || !STATUS.has(state.status)) invalid("generation lifecycleが不正です");
  if (state.generation_id !== generationId(state.watch_id, state.parent_epoch_id, state.sequence)) invalid("generation IDがidentityと一致しません");
  if (state.rollover_reason !== null && !["completed_cycles", "model_visible_bytes", "parent_rebind"].includes(state.rollover_reason)) invalid("rollover reasonが不正です");
  for (const field of ["activation_receipt_digest", "terminal_receipt_digest", "previous_terminal_receipt_digest", "host_handle_digest"]) if (state[field] !== null) requireDigest(state[field], field);
  if (!Number.isSafeInteger(state.completed_cycles) || state.completed_cycles < 0 || state.completed_cycles > GENERATION_MAX_COMPLETED_CYCLES) invalid("completed cyclesが不正です");
  validateBytes(state.model_visible_bytes);
  validateReservation(state.pending_reservation, true); validateCompleted(state.last_completed_cycle, true);
  timestamp(state.created_at); timestamp(state.updated_at); if (Date.parse(state.updated_at) < Date.parse(state.created_at)) invalid("generation clockが後退しています");
  if (state.sequence > 1 && state.previous_terminal_receipt_digest === null) invalid("generation sequenceとprevious terminalが一致しません");
  if (state.completed_cycles === 0 ? state.last_completed_cycle !== null || state.model_visible_bytes !== 0 : state.last_completed_cycle === null) invalid("completed cyclesとbudget receiptが一致しません");
  if (state.last_completed_cycle !== null && state.last_completed_cycle.model_visible_bytes > state.model_visible_bytes) invalid("last completed cycleが累積budgetを超えています");
  if (state.pending_reservation !== null && state.model_visible_bytes + state.pending_reservation.model_visible_bytes > GENERATION_MAX_MODEL_VISIBLE_BYTES) invalid("pending reservationが累積budgetを超えています");
  if (state.pending_reservation !== null && state.status !== "active") invalid("pending reservationはactiveだけに保存できます");
  if (state.status === "active") {
    if (state.rollover_reason !== null || state.host_handle_digest === null || state.activation_receipt_digest === null || state.terminal_receipt_digest !== null) invalid("active generation relationshipが不正です");
  } else if (state.status === "rollover_requested") {
    if (!["completed_cycles", "model_visible_bytes"].includes(state.rollover_reason) || state.host_handle_digest === null || state.activation_receipt_digest === null || state.terminal_receipt_digest !== null || state.pending_reservation !== null) invalid("rollover generation relationshipが不正です");
  } else if (state.status === "rebind_required") {
    if (state.rollover_reason !== "parent_rebind" || state.host_handle_digest === null || state.activation_receipt_digest === null || state.terminal_receipt_digest !== null || state.pending_reservation !== null) invalid("rebind generation relationshipが不正です");
  } else if (state.status === "stopping") {
    if (state.rollover_reason === null || state.host_handle_digest === null || state.activation_receipt_digest === null || state.terminal_receipt_digest !== null || state.pending_reservation !== null) invalid("stopping generation relationshipが不正です");
  } else if (state.status === "terminal_confirmed") {
    if (state.rollover_reason === null || state.host_handle_digest === null || state.activation_receipt_digest === null || state.terminal_receipt_digest === null || state.pending_reservation !== null) invalid("terminal generation relationshipが不正です");
  } else if (state.rollover_reason !== null || state.host_handle_digest !== null || state.activation_receipt_digest !== null || state.terminal_receipt_digest !== null || state.previous_terminal_receipt_digest === null || state.completed_cycles !== 0 || state.model_visible_bytes !== 0 || state.pending_reservation !== null || state.last_completed_cycle !== null) {
    invalid("starting generation relationshipが不正です");
  }
  return state;
}

function validateReceipt(receipt, expectedOutcome, identity) {
  validateParentHostReceipt(receipt, expectedOutcome);
  const targetId = identity.target_id ?? identity.targetId;
  const watchId = identity.watch_id ?? identity.watchId;
  if (receipt.provider !== identity.provider || receipt.target_id !== targetId || receipt.watch_id !== watchId) fail("E_GENERATION_RECEIPT_MISMATCH", "host receiptがgeneration identityと一致しません");
}

async function generationPaths(stateRoot, targetId) {
  if (!isAbsolute(stateRoot)) invalid("state rootはabsolute pathである必要があります");
  const root = resolve(stateRoot); const watches = assertWithin(root, join(root, "watches")); const directory = assertWithin(root, join(watches, targetId));
  try { await assertPrivateDirectory(root); await assertPrivateDirectory(watches); await assertPrivateDirectory(directory); } catch (error) { if (error instanceof ObserverError && error.code === "E_STATE_DIRECTORY_MISSING") return null; throw error; }
  return { directory, statePath: join(directory, "generation.json"), lockPath: join(directory, "transaction.lock") };
}
async function requirePaths(root, targetId) { const paths = await generationPaths(root, targetId); if (paths === null) fail("E_GENERATION_NOT_FOUND", "generation stateがありません"); return paths; }
async function readState(file) { try { return validateGenerationState(await readPrivateJson(file)); } catch (error) { if (error?.code === "ENOENT") return null; throw error; } }
async function requireState(file) { const state = await readState(file); if (state === null) fail("E_GENERATION_NOT_FOUND", "generation stateがありません"); return state; }
async function withGenerationTransaction(paths, identity, dependencies, operation) {
  let release; try { release = await acquirePrivateLock(paths.lockPath); } catch (error) { if (error instanceof ObserverError && error.code === "E_CONSUMER_LOCKED") fail("E_WATCH_TRANSACTION_LOCKED", "別のtarget transactionが進行中です"); throw error; }
  let primary = null;
  try {
    const watch = await (dependencies.readWatchStatus ?? readWatchStatus)({ stateRoot: identity.stateRoot, targetId: identity.targetId });
    const existing = await readState(paths.statePath);
    const provider = identity.provider ?? existing?.provider;
    if (watch === null || watch.watch_id !== identity.watchId || watch.provider !== provider || watch.status !== "active") fail("E_GENERATION_WATCH_MISMATCH", "active watchがgeneration identityと一致しません");
    return await operation();
  }
  catch (error) { primary = error; throw error; }
  finally { try { await release(); } catch (error) { if (primary) throw new AggregateError([primary, error], "generation transactionとlock解放が失敗しました"); throw error; } }
}
function transition(state, patch, clock) { return validateGenerationState({ ...state, ...patch, updated_at: nextTime(state, clock) }); }
function requireActive(state) { if (state.status !== "active") fail("E_GENERATION_TRANSITION_INVALID", "active generationが必要です"); }
function requireWatch(state, watchId) { if (state.watch_id !== watchId) fail("E_GENERATION_WATCH_MISMATCH", "watch IDが一致しません"); }
function publicState(state) { validateGenerationState(state); return structuredClone(state); }
function parentEpoch(provider, thread) { return digestParts("observer.parent_epoch.v1", provider, thread); }
function generationId(watch, epoch, sequence) { return digestParts("observer.generation.v1", watch, epoch, String(sequence)); }
function digestValue(value) { return `sha256:${createHash("sha256").update(canonical(value), "utf8").digest("hex")}`; }
function digestParts(domain, ...parts) { const hash = createHash("sha256").update(`${domain}\0`, "utf8"); for (const part of parts) hash.update(`${part}\0`, "utf8"); return `sha256:${hash.digest("hex")}`; }
function sameReady(state, receipt) { return state.host_handle_digest === digestValue(receipt.handle) && state.activation_receipt_digest === digestValue(receipt); }
function sameReservation(left, right) { return left.cycle_id === right.cycle_id && left.input_digest === right.input_digest && left.model_visible_bytes === right.model_visible_bytes; }
function sameCompleted(left, right) { return sameReservation(left, right) && left.result_digest === right.result_digest; }
function validateReservation(value, nullable) { if (value === null && nullable) return; plain(value, "reservation"); exact(value, ["cycle_id", "input_digest", "model_visible_bytes"], "reservation"); validateCycleId(value.cycle_id); requireDigest(value.input_digest, "reservation digest"); validateBytes(value.model_visible_bytes); }
function validateCompleted(value, nullable) { if (value === null && nullable) return; plain(value, "completed cycle"); exact(value, ["cycle_id", "input_digest", "model_visible_bytes", "result_digest"], "completed cycle"); validateCycleId(value.cycle_id); requireDigest(value.input_digest, "completed input digest"); validateBytes(value.model_visible_bytes); requireDigest(value.result_digest, "completed result digest"); }
function validateIdentity(value) { validateTargetId(value.target_id ?? value.targetId); validateWatchId(value.watch_id ?? value.watchId); if (!["codex", "claude"].includes(value.provider)) invalid("providerが不正です"); }
function validateTargetId(value) { if (typeof value !== "string" || !TARGET_ID_RE.test(value)) invalid("target IDが不正です"); }
function validateWatchId(value) { if (typeof value !== "string" || !WATCH_ID_RE.test(value)) invalid("watch IDが不正です"); }
function validateCycleId(value) { if (typeof value !== "string" || !/^c_[a-f0-9]{64}$/.test(value)) invalid("cycle IDが不正です"); }
function requireDigest(value, field) { if (typeof value !== "string" || !DIGEST_RE.test(value)) invalid(`${field}が不正です`); }
function requireHex(value, field) { if (typeof value !== "string" || !HEX_RE.test(value)) invalid(`${field}が不正です`); }
function validateBytes(value) { if (!Number.isSafeInteger(value) || value < 0 || value > GENERATION_MAX_MODEL_VISIBLE_BYTES) invalid("model visible bytesが不正です"); }
function validateInputBytes(value) { if (!Number.isSafeInteger(value) || value < 0) invalid("model visible input bytesが不正です"); }
function now(clock) { const value = (clock ?? (() => new Date()))(); if (!(value instanceof Date) || Number.isNaN(value.getTime())) invalid("clockが不正です"); return value.toISOString(); }
function nextTime(state, clock) { const value = now(clock); if (Date.parse(value) < Date.parse(state.updated_at)) invalid("clockが後退しています"); return value; }
function timestamp(value) { if (typeof value !== "string") invalid("timestampが不正です"); const parsed = Date.parse(value); if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) invalid("timestampが不正です"); }
function plain(value, field) { if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length) invalid(`${field}はplain objectである必要があります`); }
function exact(value, expected, field) { const actual = Object.keys(value).sort(); const wanted = [...expected].sort(); if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) invalid(`${field}に未知または不足fieldがあります`); }
function canonical(value) { if (value === null || typeof value !== "object") return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`; }
function serialize(value) { return `${JSON.stringify(value)}\n`; }
function invalid(message) { fail("E_GENERATION_STATE_INVALID", message); }
