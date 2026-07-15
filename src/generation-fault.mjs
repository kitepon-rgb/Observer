import { createHash } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";

import {
  completeGenerationFault,
  confirmGenerationFaultTerminal as confirmGenerationFaultTerminalState,
  readGenerationState,
  requestGenerationFault,
  requestGenerationFaultStop,
} from "./generation-store.mjs";
import { fail, ObserverError } from "./observer-error.mjs";
import {
  isObserverFaultCode,
  validateParentHostReceipt,
  validateParentStopRequest,
} from "./parent-launch.mjs";
import {
  acquirePrivateLock,
  assertPrivateDirectory,
  assertWithin,
  atomicCreatePrivateFile,
  atomicReplacePrivateFile,
  readPrivateJson,
} from "./private-state.mjs";
import {
  readWatchHostBinding,
  readWatchStatus,
  recordWatchFaultAfterChildExit,
} from "./watch-store.mjs";

export const GENERATION_FAULT_SCHEMA = "observer.generation_fault.v1";
export const GENERATION_FAULT_STATUS_SCHEMA = "observer.generation_fault_status.v1";
export const GENERATION_FAULT_RESULT_SCHEMA = "observer.generation_fault_result.v1";

const TARGET = /^p_[a-f0-9]{64}$/;
const WATCH = /^w_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const SOURCE_STATUSES = new Set([
  "active", "rollover_requested", "rebind_required", "stopping", "terminal_confirmed", "starting",
]);
const STATUSES = new Set(["fault_recorded", "stop_authorized", "terminal_observed", "faulted"]);
const ACTIONS = Object.freeze({
  fault_recorded: "authorize_stop",
  stop_authorized: "observe_terminal",
  terminal_observed: "finalize_fault",
  faulted: "faulted",
});
const JOURNAL_KEYS = Object.freeze([
  "created_at", "fault_code", "generation_id", "handle", "parent_epoch_id", "provider", "schema",
  "source_generation_status", "status", "target_id", "terminal_receipt_digest", "updated_at", "watch_id",
]);

export async function recordGenerationFault({ stateRoot, target, watchId, faultCode } = {}, dependencies = {}) {
  validateTarget(target); validateWatchId(watchId); validateFaultCode(faultCode);
  return withFaultLock(stateRoot, target.targetId, async (paths) => {
    const generation = await (dependencies.readGenerationState ?? readGenerationState)({ stateRoot, targetId: target.targetId });
    const binding = await (dependencies.readWatchHostBinding ?? readWatchHostBinding)({ stateRoot, targetId: target.targetId, watchId });
    requireCurrentIdentity(generation, binding, target, watchId);
    let journal = await readJournal(paths.journalPath);
    if (journal === null) {
      if (!SOURCE_STATUSES.has(generation.status)) fail("E_GENERATION_FAULT_SOURCE_INVALID", "fault記録元generation statusが不正です");
      const timestamp = currentTimestamp(dependencies.now);
      journal = validateJournal({
        schema: GENERATION_FAULT_SCHEMA,
        target_id: target.targetId,
        watch_id: watchId,
        provider: generation.provider,
        generation_id: generation.generation_id,
        parent_epoch_id: generation.parent_epoch_id,
        fault_code: faultCode,
        source_generation_status: generation.status,
        status: ["stopping", "terminal_confirmed"].includes(generation.status) ? "stop_authorized" : "fault_recorded",
        handle: structuredClone(binding.launch_handle),
        terminal_receipt_digest: null,
        created_at: timestamp,
        updated_at: timestamp,
      });
      await atomicCreatePrivateFile(paths.journalPath, serialize(journal));
    } else {
      requireJournalIdentity(journal, { targetId: target.targetId, watchId, provider: generation.provider });
      if (journal.generation_id !== generation.generation_id || journal.parent_epoch_id !== generation.parent_epoch_id ||
          journal.fault_code !== faultCode || !sameHandle(journal.handle, binding.launch_handle)) {
        fail("E_GENERATION_FAULT_CONFLICT", "記録済みfault journalがcurrent generationと一致しません");
      }
    }
    if (journal.status !== "faulted") {
      await (dependencies.requestGenerationFault ?? requestGenerationFault)({
        stateRoot,
        targetId: target.targetId,
        watchId,
        expectedGenerationId: journal.generation_id,
        faultCode: journal.fault_code,
        faultHandle: structuredClone(journal.handle),
        stopAlreadyAuthorized: journal.status !== "fault_recorded",
      }, generationDependencies(dependencies));
    }
    return publicStatus(journal);
  });
}

export async function readGenerationFaultStatus({ stateRoot, targetId, watchId } = {}) {
  validateTargetId(targetId); validateWatchId(watchId);
  return withFaultLock(stateRoot, targetId, async (paths) => {
    const journal = await readJournal(paths.journalPath);
    if (journal === null) return null;
    requireJournalIdentity(journal, { targetId, watchId });
    return publicStatus(journal);
  });
}

export async function prepareGenerationFaultStop({ stateRoot, targetId, watchId } = {}, dependencies = {}) {
  validateTargetId(targetId); validateWatchId(watchId);
  return withFaultLock(stateRoot, targetId, async (paths) => {
    let journal = await requireJournal(paths.journalPath);
    requireJournalIdentity(journal, { targetId, watchId });
    if (!["fault_recorded", "stop_authorized", "terminal_observed"].includes(journal.status)) {
      fail("E_GENERATION_FAULT_TRANSITION_INVALID", "fault stopを準備できないjournal statusです");
    }
    const binding = await (dependencies.readWatchHostBinding ?? readWatchHostBinding)({ stateRoot, targetId, watchId });
    requireBinding(binding, journal);
    let action = "observe_only";
    if (journal.status === "fault_recorded") {
      journal = transition(journal, { status: "stop_authorized" }, dependencies.now);
      await atomicReplacePrivateFile(paths.journalPath, serialize(journal));
      action = "issue_once";
    }
    if (journal.status !== "terminal_observed") {
      await (dependencies.requestGenerationFault ?? requestGenerationFault)({
        stateRoot,
        targetId,
        watchId,
        expectedGenerationId: journal.generation_id,
        faultCode: journal.fault_code,
        faultHandle: structuredClone(journal.handle),
        stopAlreadyAuthorized: true,
      }, generationDependencies(dependencies));
      const stopping = await (dependencies.requestGenerationFaultStop ?? requestGenerationFaultStop)({
        stateRoot, targetId, watchId, expectedGenerationId: journal.generation_id, faultCode: journal.fault_code,
      }, generationDependencies(dependencies));
      if (stopping.status !== "fault_stopping") fail("E_GENERATION_FAULT_STATE_MISMATCH", "generation fault stoppingを確認できません");
    }
    const stopRequest = {
      schema: "observer.parent_stop_request.v1",
      provider: journal.provider,
      watch_id: journal.watch_id,
      target_id: journal.target_id,
      project_root: binding.project_root,
      handle: structuredClone(journal.handle),
      terminal: "faulted",
      fault_code: journal.fault_code,
    };
    validateParentStopRequest(stopRequest);
    return result(action, journal, { stop_request: stopRequest });
  });
}

export async function confirmGenerationFaultTerminal({ stateRoot, targetId, watchId, terminalReceipt } = {}, dependencies = {}) {
  validateTargetId(targetId); validateWatchId(watchId); validateParentHostReceipt(terminalReceipt, "stopped");
  return withFaultLock(stateRoot, targetId, async (paths) => {
    let journal = await requireJournal(paths.journalPath);
    requireJournalIdentity(journal, { targetId, watchId });
    requireReceipt(terminalReceipt, journal);
    const receiptDigest = digestValue(terminalReceipt);
    if (journal.status === "faulted") {
      requireDigestMatch(journal.terminal_receipt_digest, receiptDigest);
      await requireFinalStates({ stateRoot, journal }, dependencies);
      return result("faulted", journal);
    }
    if (!["stop_authorized", "terminal_observed"].includes(journal.status)) {
      fail("E_GENERATION_FAULT_TRANSITION_INVALID", "fault terminal receiptを適用できないjournal statusです");
    }
    if (journal.status === "stop_authorized") {
      const generation = await (dependencies.confirmGenerationFaultTerminalState ?? confirmGenerationFaultTerminalState)({
        stateRoot,
        targetId,
        watchId,
        expectedGenerationId: journal.generation_id,
        faultCode: journal.fault_code,
        terminalReceipt,
      }, generationDependencies(dependencies));
      if (generation.status !== "fault_terminal_confirmed") {
        fail("E_GENERATION_FAULT_STATE_MISMATCH", "generation fault terminalを確認できません");
      }
      journal = transition(journal, { status: "terminal_observed", terminal_receipt_digest: receiptDigest }, dependencies.now);
      await atomicReplacePrivateFile(paths.journalPath, serialize(journal));
    } else requireDigestMatch(journal.terminal_receipt_digest, receiptDigest);

    let generation = await (dependencies.readGenerationState ?? readGenerationState)({ stateRoot, targetId });
    if (generation?.status === "fault_terminal_confirmed") {
      generation = await (dependencies.completeGenerationFault ?? completeGenerationFault)({
        stateRoot, targetId, watchId, expectedGenerationId: journal.generation_id, faultCode: journal.fault_code,
      }, generationDependencies(dependencies));
    }
    if (generation?.status !== "faulted" || generation.generation_id !== journal.generation_id || generation.fault_code !== journal.fault_code) {
      fail("E_GENERATION_FAULT_STATE_MISMATCH", "generationをfaultedへ閉じられません");
    }
    const watch = await (dependencies.readWatchStatus ?? readWatchStatus)({ stateRoot, targetId });
    if (watch?.status === "faulted") {
      if (watch.watch_id !== watchId || watch.provider !== journal.provider || watch.fault_code !== journal.fault_code) {
        fail("E_GENERATION_FAULT_WATCH_MISMATCH", "faulted watchがjournalと一致しません");
      }
    } else {
      const faulted = await (dependencies.recordWatchFaultAfterChildExit ?? recordWatchFaultAfterChildExit)({
        stateRoot, targetId, watchId, faultCode: journal.fault_code,
      }, watchDependencies(dependencies));
      if (faulted.status !== "faulted" || faulted.fault_code !== journal.fault_code) {
        fail("E_GENERATION_FAULT_WATCH_MISMATCH", "watchをfaultedへ閉じられません");
      }
    }
    journal = transition(journal, { status: "faulted" }, dependencies.now);
    await atomicReplacePrivateFile(paths.journalPath, serialize(journal));
    return result("faulted", journal);
  });
}

async function requireFinalStates({ stateRoot, journal }, dependencies) {
  const generation = await (dependencies.readGenerationState ?? readGenerationState)({ stateRoot, targetId: journal.target_id });
  const watch = await (dependencies.readWatchStatus ?? readWatchStatus)({ stateRoot, targetId: journal.target_id });
  if (generation?.generation_id !== journal.generation_id || generation.status !== "faulted" || generation.fault_code !== journal.fault_code ||
      watch?.watch_id !== journal.watch_id || watch.status !== "faulted" || watch.fault_code !== journal.fault_code) {
    fail("E_GENERATION_FAULT_STATE_MISMATCH", "fault final stateがjournalと一致しません");
  }
}

function requireCurrentIdentity(generation, binding, target, watchId) {
  if (!isPlain(generation) || !isPlain(binding) || generation.target_id !== target.targetId || generation.watch_id !== watchId ||
      generation.provider !== binding.provider || binding.target_id !== target.targetId || binding.watch_id !== watchId ||
      binding.project_root !== target.projectRoot || binding.status !== "active" || generation.status === "faulted") {
    fail("E_GENERATION_FAULT_IDENTITY_MISMATCH", "generationとactive watch bindingが一致しません");
  }
}

function requireBinding(binding, journal) {
  if (!isPlain(binding) || binding.target_id !== journal.target_id || binding.watch_id !== journal.watch_id ||
      binding.provider !== journal.provider || binding.status !== "active" || !sameHandle(binding.launch_handle, journal.handle)) {
    fail("E_GENERATION_FAULT_IDENTITY_MISMATCH", "fault stop対象bindingがjournalと一致しません");
  }
}

function requireReceipt(receipt, journal) {
  if (receipt.provider !== journal.provider || receipt.target_id !== journal.target_id || receipt.watch_id !== journal.watch_id ||
      !sameHandle(receipt.handle, journal.handle)) {
    fail("E_GENERATION_FAULT_RECEIPT_MISMATCH", "fault terminal receiptがjournal identityと一致しません");
  }
}

async function faultPaths(stateRoot, targetId) {
  if (typeof stateRoot !== "string" || !isAbsolute(stateRoot)) fail("E_GENERATION_FAULT_STATE_INVALID", "state rootが不正です");
  const root = resolve(stateRoot);
  const watches = assertWithin(root, join(root, "watches"));
  const directory = assertWithin(root, join(watches, targetId));
  try {
    await assertPrivateDirectory(root); await assertPrivateDirectory(watches); await assertPrivateDirectory(directory);
  } catch (error) {
    if (error instanceof ObserverError && error.code === "E_STATE_DIRECTORY_MISSING") fail("E_GENERATION_FAULT_NOT_FOUND", "fault対象watchがありません");
    throw error;
  }
  return { journalPath: join(directory, "generation-fault.json"), lockPath: join(directory, "generation-fault.lock") };
}

async function withFaultLock(stateRoot, targetId, operation) {
  const paths = await faultPaths(stateRoot, targetId);
  let release;
  try { release = await acquirePrivateLock(paths.lockPath); }
  catch (error) {
    if (error instanceof ObserverError && error.code === "E_CONSUMER_LOCKED") fail("E_GENERATION_FAULT_LOCKED", "別のgeneration fault transactionが進行中です");
    throw error;
  }
  let primary = null;
  try { return await operation(paths); }
  catch (error) { primary = error; throw error; }
  finally {
    try { await release(); }
    catch (error) {
      if (primary) throw new AggregateError([primary, error], "generation fault transactionとlock解放が失敗しました");
      throw error;
    }
  }
}

async function readJournal(path) {
  try { return validateJournal(await readPrivateJson(path)); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}
async function requireJournal(path) { const value = await readJournal(path); if (value === null) fail("E_GENERATION_FAULT_JOURNAL_NOT_FOUND", "generation fault journalがありません"); return value; }

function validateJournal(value) {
  plain(value, "fault journal"); exact(value, JOURNAL_KEYS, "fault journal");
  if (value.schema !== GENERATION_FAULT_SCHEMA || !STATUSES.has(value.status) || !TARGET.test(value.target_id) || !WATCH.test(value.watch_id) ||
      !["claude", "codex"].includes(value.provider) || !DIGEST.test(value.generation_id) || !DIGEST.test(value.parent_epoch_id) ||
      !isObserverFaultCode(value.fault_code) || !SOURCE_STATUSES.has(value.source_generation_status)) invalid("fault journal identityが不正です");
  validateHandle(value.handle, value.provider);
  if (value.terminal_receipt_digest !== null && !DIGEST.test(value.terminal_receipt_digest)) invalid("fault terminal digestが不正です");
  timestamp(value.created_at); timestamp(value.updated_at);
  if (Date.parse(value.updated_at) < Date.parse(value.created_at)) invalid("fault journal clockが後退しています");
  if (["fault_recorded", "stop_authorized"].includes(value.status) ? value.terminal_receipt_digest !== null : value.terminal_receipt_digest === null) {
    invalid("fault journal statusとterminal receiptが一致しません");
  }
  if (value.status === "fault_recorded" && ["stopping", "terminal_confirmed"].includes(value.source_generation_status)) {
    invalid("既存stop済みfaultを未認可へ戻せません");
  }
  return value;
}

function publicStatus(journal) {
  return {
    schema: GENERATION_FAULT_STATUS_SCHEMA,
    provider: journal.provider,
    target_id: journal.target_id,
    watch_id: journal.watch_id,
    generation_id: journal.generation_id,
    parent_epoch_id: journal.parent_epoch_id,
    fault_code: journal.fault_code,
    source_generation_status: journal.source_generation_status,
    status: journal.status,
    action: ACTIONS[journal.status],
  };
}

function result(action, journal, fields = {}) {
  return { schema: GENERATION_FAULT_RESULT_SCHEMA, action, status: publicStatus(journal), ...fields };
}
function transition(journal, patch, clock) { return validateJournal({ ...journal, ...patch, updated_at: nextTimestamp(journal, clock) }); }
function requireJournalIdentity(journal, { targetId, watchId, provider = journal.provider }) { if (journal.target_id !== targetId || journal.watch_id !== watchId || journal.provider !== provider) fail("E_GENERATION_FAULT_IDENTITY_MISMATCH", "fault journal identityが一致しません"); }
function requireDigestMatch(actual, expected) { if (actual !== expected) fail("E_GENERATION_FAULT_RECEIPT_CONFLICT", "fault terminal receiptが記録済みdigestと一致しません"); }
function validateHandle(handle, provider) { validateParentHostReceipt({ schema: "observer.host_receipt.v1", provider, watch_id: "w_00000000-0000-4000-8000-000000000000", target_id: `p_${"0".repeat(64)}`, outcome: "spawned", handle }, "spawned"); }
function sameHandle(left, right) { return left?.kind === right?.kind && left?.value === right?.value; }
function digestValue(value) { return `sha256:${createHash("sha256").update(canonical(value), "utf8").digest("hex")}`; }
function generationDependencies(dependencies) { return dependencies.now ? { now: dependencies.now } : {}; }
function watchDependencies(dependencies) { return dependencies.now ? { now: dependencies.now } : {}; }
function validateTarget(value) { if (!isPlain(value) || Object.keys(value).sort().join(",") !== "projectRoot,schema,targetId" || value.schema !== "observer.project_target.v1" || !TARGET.test(value.targetId) || typeof value.projectRoot !== "string" || !isAbsolute(value.projectRoot)) invalid("project targetが不正です"); }
function validateTargetId(value) { if (typeof value !== "string" || !TARGET.test(value)) invalid("target IDが不正です"); }
function validateWatchId(value) { if (typeof value !== "string" || !WATCH.test(value)) invalid("watch IDが不正です"); }
function validateFaultCode(value) { if (!isObserverFaultCode(value)) invalid("fault codeが不正です"); }
function currentTimestamp(clock) { const value = (clock ?? (() => new Date()))(); if (!(value instanceof Date) || Number.isNaN(value.valueOf())) invalid("fault clockが不正です"); return value.toISOString(); }
function nextTimestamp(journal, clock) { const value = currentTimestamp(clock); if (Date.parse(value) < Date.parse(journal.updated_at)) invalid("fault clockが後退しています"); return value; }
function timestamp(value) { const parsed = typeof value === "string" ? new Date(value) : null; if (parsed === null || Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) invalid("fault timestampが不正です"); }
function isPlain(value) { return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function plain(value, field) { if (!isPlain(value)) invalid(`${field}はplain objectである必要があります`); }
function exact(value, expected, field) { const actual = Object.keys(value).sort(); const wanted = [...expected].sort(); if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) invalid(`${field}に未知または不足fieldがあります`); }
function canonical(value) { if (value === null || typeof value !== "object") return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`; }
function serialize(value) { return `${JSON.stringify(value)}\n`; }
function invalid(message) { fail("E_GENERATION_FAULT_STATE_INVALID", message); }
