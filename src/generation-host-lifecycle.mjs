import { createHash } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";

import {
  activateGeneration,
  beginNextGeneration,
  confirmGenerationTerminal,
  readGenerationState,
  requestGenerationStop,
} from "./generation-store.mjs";
import { fail, ObserverError } from "./observer-error.mjs";
import {
  HOST_RECEIPT_SCHEMA,
  PARENT_STOP_REQUEST_SCHEMA,
  validateParentHostReceipt,
  validateParentLaunchRequest,
  validateParentStopRequest,
} from "./parent-launch.mjs";
import {
  acquirePrivateLock,
  assertPrivateDirectory,
  assertWithin,
  atomicCreatePrivateFile,
  atomicReplacePrivateFile,
  readPrivateJson,
  removePrivateFile,
} from "./private-state.mjs";
import {
  compareAndSwapWatchLaunchHandle,
  readWatchHostBinding,
} from "./watch-store.mjs";

export const GENERATION_HOST_ROLLOVER_SCHEMA = "observer.generation_host_rollover.v1";
export const GENERATION_HOST_LIFECYCLE_RESULT_SCHEMA = "observer.generation_host_lifecycle_result.v1";

const TARGET_ID_RE = /^p_[a-f0-9]{64}$/;
const WATCH_ID_RE = /^w_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const STATUSES = new Set(["stop_authorized", "terminal_observed", "spawn_authorized", "spawn_observed", "ready_observed"]);
const JOURNAL_KEYS = Object.freeze([
  "created_at", "from_generation_id", "from_sequence", "next_handle", "previous_handle", "provider",
  "launch_request_digest", "ready_receipt_digest", "schema", "spawn_receipt_digest", "status", "stop_command_receipt_digest",
  "target_id", "terminal_receipt_digest", "to_generation_id", "to_sequence", "updated_at", "watch_id",
]);

export async function prepareGenerationHostStop({ stateRoot, targetId, watchId } = {}, dependencies = {}) {
  validateIdentity(targetId, watchId);
  return withRolloverLock(stateRoot, targetId, async (paths) => {
    const generation = await requireGeneration(stateRoot, targetId, watchId);
    const binding = await readBinding({ stateRoot, targetId, watchId }, dependencies);
    let journal = await readJournal(paths.journalPath);
    let action = "observe_only";
    if (journal === null) {
      if (generation.status !== "rollover_requested") fail("E_GENERATION_HOST_STOP_NOT_REQUESTED", "rollover requested generationが必要です");
      journal = createJournal({ generation, binding, timestamp: currentTimestamp(dependencies.now) });
      await atomicCreatePrivateFile(paths.journalPath, serialize(journal));
      action = "issue_once";
    } else {
      requireJournalIdentity(journal, { targetId, watchId, provider: generation.provider });
      if (journal.status !== "stop_authorized") fail("E_GENERATION_HOST_TRANSITION_INVALID", "stop authorizationは既に完了しています");
      requireSameHandle(journal.previous_handle, binding.launch_handle, "E_GENERATION_HOST_WATCH_HANDLE_MISMATCH");
    }
    await (dependencies.requestGenerationStop ?? requestGenerationStop)(
      { stateRoot, targetId, watchId },
      generationDependencies(dependencies),
    );
    return result(action, {
      stop_request: stopRequest(binding, journal.previous_handle),
      from_generation_id: journal.from_generation_id,
    });
  });
}

export async function confirmGenerationHostTerminal({
  stateRoot,
  targetId,
  watchId,
  terminalReceipt,
  stopCommandReceipt = null,
} = {}, dependencies = {}) {
  validateIdentity(targetId, watchId);
  return withRolloverLock(stateRoot, targetId, async (paths) => {
    const journal = await requireJournal(paths.journalPath);
    requireJournalIdentity(journal, { targetId, watchId });
    validateHostReceipt(terminalReceipt, "stopped", journal);
    requireSameHandle(terminalReceipt.handle, journal.previous_handle, "E_GENERATION_HOST_TERMINAL_HANDLE_MISMATCH");
    const terminalDigest = digestValue(terminalReceipt);
    const commandDigest = stopCommandReceipt === null ? null : digestBoundedReceipt(stopCommandReceipt);
    if (journal.status === "terminal_observed") {
      requireDigestMatch(journal.terminal_receipt_digest, terminalDigest, "terminal receipt");
      requireDigestMatch(journal.stop_command_receipt_digest, commandDigest, "stop command receipt");
    } else if (journal.status !== "stop_authorized") {
      fail("E_GENERATION_HOST_TRANSITION_INVALID", "terminal observationを適用できないjournal statusです");
    }
    const generation = await (dependencies.confirmGenerationTerminal ?? confirmGenerationTerminal)(
      { stateRoot, targetId, watchId, terminalReceipt },
      generationDependencies(dependencies),
    );
    let next = journal;
    if (journal.status === "stop_authorized") {
      next = transition(journal, {
        status: "terminal_observed",
        stop_command_receipt_digest: commandDigest,
        terminal_receipt_digest: terminalDigest,
      }, dependencies.now);
      await atomicReplacePrivateFile(paths.journalPath, serialize(next));
    }
    return result("terminal_observed", {
      from_generation_id: next.from_generation_id,
      generation_status: generation.status,
    });
  });
}

export async function authorizeNextGenerationHostStart({ stateRoot, targetId, watchId, launchRequest } = {}, dependencies = {}) {
  validateIdentity(targetId, watchId);
  validateLaunch(launchRequest, { targetId, watchId });
  return withRolloverLock(stateRoot, targetId, async (paths) => {
    let journal = await requireJournal(paths.journalPath);
    requireJournalIdentity(journal, { targetId, watchId, provider: launchRequest.provider });
    const binding = await readBinding({ stateRoot, targetId, watchId }, dependencies);
    requireSameHandle(binding.launch_handle, journal.previous_handle, "E_GENERATION_HOST_WATCH_HANDLE_MISMATCH");
    if (binding.project_root !== launchRequest.project_root || launchRequest.runtime_root !== launchRequest.host.cwd) {
      fail("E_GENERATION_HOST_LAUNCH_MISMATCH", "next host launch requestがwatch identityと一致しません");
    }
    const generation = await requireGeneration(stateRoot, targetId, watchId);
    const expected = nextGenerationIdentity(generation, journal);
    const launchRequestDigest = digestBoundedLaunchRequest(launchRequest);
    let action = "recover_only";
    if (journal.status === "terminal_observed") {
      journal = transition(journal, {
        status: "spawn_authorized",
        to_generation_id: expected.generationId,
        to_sequence: expected.sequence,
        launch_request_digest: launchRequestDigest,
      }, dependencies.now);
      await atomicReplacePrivateFile(paths.journalPath, serialize(journal));
      action = "issue_once";
    } else if (journal.status !== "spawn_authorized") {
      fail("E_GENERATION_HOST_TRANSITION_INVALID", "next host startをauthorizeできないjournal statusです");
    } else if (journal.launch_request_digest !== launchRequestDigest) {
      fail("E_GENERATION_HOST_LAUNCH_REQUEST_CONFLICT", "next host launch requestが初回authorizationと一致しません");
    } else if (journal.to_generation_id !== expected.generationId || journal.to_sequence !== expected.sequence) {
      fail("E_GENERATION_HOST_NEXT_IDENTITY_MISMATCH", "next generation identityがjournalと一致しません");
    }
    const starting = await (dependencies.beginNextGeneration ?? beginNextGeneration)(
      { stateRoot, targetId, watchId },
      generationDependencies(dependencies),
    );
    if (starting.generation_id !== journal.to_generation_id || starting.sequence !== journal.to_sequence || starting.status !== "starting") {
      fail("E_GENERATION_HOST_NEXT_IDENTITY_MISMATCH", "starting generationがauthorizationと一致しません");
    }
    return result(action, {
      generation_id: journal.to_generation_id,
      sequence: journal.to_sequence,
      launch_request: structuredClone(launchRequest),
    });
  });
}

export async function recordNextGenerationHostSpawn({ stateRoot, targetId, watchId, spawnReceipt } = {}, dependencies = {}) {
  validateIdentity(targetId, watchId);
  return withRolloverLock(stateRoot, targetId, async (paths) => {
    let journal = await requireJournal(paths.journalPath);
    requireJournalIdentity(journal, { targetId, watchId });
    validateHostReceipt(spawnReceipt, "spawned", journal);
    const spawnDigest = digestValue(spawnReceipt);
    if (journal.status === "spawn_authorized") {
      journal = transition(journal, {
        status: "spawn_observed",
        next_handle: structuredClone(spawnReceipt.handle),
        spawn_receipt_digest: spawnDigest,
      }, dependencies.now);
      await atomicReplacePrivateFile(paths.journalPath, serialize(journal));
    } else if (journal.status === "spawn_observed") {
      requireDigestMatch(journal.spawn_receipt_digest, spawnDigest, "spawn receipt");
      requireSameHandle(journal.next_handle, spawnReceipt.handle, "E_GENERATION_HOST_SPAWN_HANDLE_MISMATCH");
    } else {
      fail("E_GENERATION_HOST_TRANSITION_INVALID", "spawn receiptを適用できないjournal statusです");
    }
    const cas = await (dependencies.compareAndSwapWatchLaunchHandle ?? compareAndSwapWatchLaunchHandle)({
      stateRoot,
      targetId,
      watchId,
      expectedLaunchHandle: structuredClone(journal.previous_handle),
      nextLaunchHandle: structuredClone(journal.next_handle),
    }, watchDependencies(dependencies));
    return result(cas.outcome === "swapped" ? "spawn_observed" : "spawn_recovered", {
      generation_id: journal.to_generation_id,
      watch_status: cas.status,
    });
  });
}

export async function activateNextGenerationHost({ stateRoot, targetId, watchId, readyReceipt } = {}, dependencies = {}) {
  validateIdentity(targetId, watchId);
  return withRolloverLock(stateRoot, targetId, async (paths) => {
    let journal = await requireJournal(paths.journalPath);
    requireJournalIdentity(journal, { targetId, watchId });
    if (!["spawn_observed", "ready_observed"].includes(journal.status)) {
      fail("E_GENERATION_HOST_TRANSITION_INVALID", "ready receiptを適用できないjournal statusです");
    }
    validateHostReceipt(readyReceipt, "ready", journal);
    requireSameHandle(journal.next_handle, readyReceipt.handle, "E_GENERATION_HOST_READY_HANDLE_MISMATCH");
    const readyDigest = digestValue(readyReceipt);
    if (journal.status === "ready_observed") requireDigestMatch(journal.ready_receipt_digest, readyDigest, "ready receipt");
    await (dependencies.compareAndSwapWatchLaunchHandle ?? compareAndSwapWatchLaunchHandle)({
      stateRoot,
      targetId,
      watchId,
      expectedLaunchHandle: structuredClone(journal.previous_handle),
      nextLaunchHandle: structuredClone(journal.next_handle),
    }, watchDependencies(dependencies));
    const generation = await (dependencies.activateGeneration ?? activateGeneration)(
      { stateRoot, targetId, watchId, readyReceipt },
      generationDependencies(dependencies),
    );
    if (generation.status !== "active" || generation.generation_id !== journal.to_generation_id || generation.sequence !== journal.to_sequence) {
      fail("E_GENERATION_HOST_ACTIVATION_MISMATCH", "activated generationがrollover journalと一致しません");
    }
    if (journal.status === "spawn_observed") {
      journal = transition(journal, { status: "ready_observed", ready_receipt_digest: readyDigest }, dependencies.now);
      await atomicReplacePrivateFile(paths.journalPath, serialize(journal));
    }
    await removePrivateFile(paths.journalPath);
    return result("activated", { generation });
  });
}

function createJournal({ generation, binding, timestamp }) {
  if (generation.status !== "rollover_requested" || binding.status !== "active" || generation.provider !== binding.provider ||
      generation.watch_id !== binding.watch_id || generation.target_id !== binding.target_id) {
    fail("E_GENERATION_HOST_IDENTITY_MISMATCH", "generationとactive watchが一致しません");
  }
  return validateJournal({
    schema: GENERATION_HOST_ROLLOVER_SCHEMA,
    watch_id: generation.watch_id,
    target_id: generation.target_id,
    provider: generation.provider,
    from_generation_id: generation.generation_id,
    from_sequence: generation.sequence,
    to_generation_id: null,
    to_sequence: null,
    status: "stop_authorized",
    previous_handle: structuredClone(binding.launch_handle),
    next_handle: null,
    launch_request_digest: null,
    stop_command_receipt_digest: null,
    terminal_receipt_digest: null,
    spawn_receipt_digest: null,
    ready_receipt_digest: null,
    created_at: timestamp,
    updated_at: timestamp,
  });
}

function stopRequest(binding, handle) {
  const request = {
    schema: PARENT_STOP_REQUEST_SCHEMA,
    provider: binding.provider,
    watch_id: binding.watch_id,
    target_id: binding.target_id,
    project_root: binding.project_root,
    handle: structuredClone(handle),
    terminal: "stopped",
    fault_code: null,
  };
  validateParentStopRequest(request);
  return request;
}

function validateLaunch(request, identity) {
  try { validateParentLaunchRequest(request); } catch { fail("E_GENERATION_HOST_LAUNCH_MISMATCH", "next host launch requestが不正です"); }
  if (request.target_id !== identity.targetId || request.watch_id !== identity.watchId) {
    fail("E_GENERATION_HOST_LAUNCH_MISMATCH", "next host launch requestがrollover identityと一致しません");
  }
}

function validateHostReceipt(receipt, outcome, identity) {
  validateParentHostReceipt(receipt, outcome);
  if (receipt.provider !== identity.provider || receipt.watch_id !== identity.watch_id || receipt.target_id !== identity.target_id) {
    fail("E_GENERATION_HOST_RECEIPT_MISMATCH", "host receiptがrollover identityと一致しません");
  }
}

function nextGenerationIdentity(generation, journal) {
  if (generation.status === "terminal_confirmed") {
    const sequence = generation.sequence + 1;
    return { sequence, generationId: generationId(generation.watch_id, generation.parent_epoch_id, sequence) };
  }
  if (generation.status === "starting" && generation.sequence === journal.from_sequence + 1) {
    return { sequence: generation.sequence, generationId: generation.generation_id };
  }
  fail("E_GENERATION_HOST_NEXT_IDENTITY_MISMATCH", "terminal confirmedまたは対応するstarting generationが必要です");
}

async function requireGeneration(stateRoot, targetId, watchId) {
  const state = await readGenerationState({ stateRoot, targetId });
  if (state === null || state.watch_id !== watchId) fail("E_GENERATION_HOST_IDENTITY_MISMATCH", "generation stateがrollover identityと一致しません");
  return state;
}

async function readBinding(args, dependencies) {
  return (dependencies.readWatchHostBinding ?? readWatchHostBinding)(args);
}

async function rolloverPaths(stateRoot, targetId) {
  if (!isAbsolute(stateRoot)) fail("E_GENERATION_HOST_STATE_INVALID", "state rootはabsolute pathである必要があります");
  const root = resolve(stateRoot);
  const watches = assertWithin(root, join(root, "watches"));
  const directory = assertWithin(root, join(watches, targetId));
  try {
    await assertPrivateDirectory(root);
    await assertPrivateDirectory(watches);
    await assertPrivateDirectory(directory);
  } catch (error) {
    if (error instanceof ObserverError && error.code === "E_STATE_DIRECTORY_MISSING") fail("E_GENERATION_HOST_NOT_FOUND", "rollover対象watchがありません");
    throw error;
  }
  return {
    journalPath: join(directory, "generation-host-rollover.json"),
    lockPath: join(directory, "generation-host-rollover.lock"),
  };
}

async function withRolloverLock(stateRoot, targetId, operation) {
  const paths = await rolloverPaths(stateRoot, targetId);
  let release;
  try { release = await acquirePrivateLock(paths.lockPath); }
  catch (error) {
    if (error instanceof ObserverError && error.code === "E_CONSUMER_LOCKED") fail("E_GENERATION_HOST_LOCKED", "別のgeneration host rolloverが進行中です");
    throw error;
  }
  let primary = null;
  try { return await operation(paths); }
  catch (error) { primary = error; throw error; }
  finally {
    try { await release(); }
    catch (error) {
      if (primary) throw new AggregateError([primary, error], "generation host rolloverとlock解放が失敗しました");
      throw error;
    }
  }
}

async function readJournal(path) {
  try { return validateJournal(await readPrivateJson(path)); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

async function requireJournal(path) {
  const journal = await readJournal(path);
  if (journal === null) fail("E_GENERATION_HOST_JOURNAL_NOT_FOUND", "generation host rollover journalがありません");
  return journal;
}

function validateJournal(value) {
  plain(value, "rollover journal");
  exact(value, JOURNAL_KEYS, "rollover journal");
  if (value.schema !== GENERATION_HOST_ROLLOVER_SCHEMA || !STATUSES.has(value.status)) invalid("rollover journal schemaまたはstatusが不正です");
  validateIdentity(value.target_id, value.watch_id);
  if (!["claude", "codex"].includes(value.provider)) invalid("rollover providerが不正です");
  requireDigest(value.from_generation_id, "from generation ID");
  if (!Number.isSafeInteger(value.from_sequence) || value.from_sequence < 1) invalid("from sequenceが不正です");
  validateHandle(value.previous_handle, value.provider);
  if (value.to_generation_id !== null) requireDigest(value.to_generation_id, "to generation ID");
  if (value.to_sequence !== null && (!Number.isSafeInteger(value.to_sequence) || value.to_sequence !== value.from_sequence + 1)) invalid("to sequenceが不正です");
  if ((value.to_generation_id === null) !== (value.to_sequence === null)) invalid("next generation identityが不完全です");
  if (value.next_handle !== null) validateHandle(value.next_handle, value.provider);
  for (const field of ["launch_request_digest", "stop_command_receipt_digest", "terminal_receipt_digest", "spawn_receipt_digest", "ready_receipt_digest"]) {
    if (value[field] !== null) requireDigest(value[field], field);
  }
  timestamp(value.created_at); timestamp(value.updated_at);
  if (Date.parse(value.updated_at) < Date.parse(value.created_at)) invalid("rollover journal clockが後退しています");
  if (value.status === "stop_authorized") {
    if (value.to_generation_id !== null || value.next_handle !== null || value.launch_request_digest !== null || value.terminal_receipt_digest !== null || value.spawn_receipt_digest !== null || value.ready_receipt_digest !== null) invalid("stop authorization relationshipが不正です");
  } else if (value.status === "terminal_observed") {
    if (value.to_generation_id !== null || value.next_handle !== null || value.launch_request_digest !== null || value.terminal_receipt_digest === null || value.spawn_receipt_digest !== null || value.ready_receipt_digest !== null) invalid("terminal observation relationshipが不正です");
  } else if (value.status === "spawn_authorized") {
    if (value.to_generation_id === null || value.next_handle !== null || value.launch_request_digest === null || value.terminal_receipt_digest === null || value.spawn_receipt_digest !== null || value.ready_receipt_digest !== null) invalid("spawn authorization relationshipが不正です");
  } else if (value.status === "spawn_observed") {
    if (value.to_generation_id === null || value.next_handle === null || value.launch_request_digest === null || value.terminal_receipt_digest === null || value.spawn_receipt_digest === null || value.ready_receipt_digest !== null) invalid("spawn observation relationshipが不正です");
  } else if (value.to_generation_id === null || value.next_handle === null || value.launch_request_digest === null || value.terminal_receipt_digest === null || value.spawn_receipt_digest === null || value.ready_receipt_digest === null) {
    invalid("ready observation relationshipが不正です");
  }
  return value;
}

function transition(journal, patch, clock) {
  return validateJournal({ ...journal, ...patch, updated_at: nextTimestamp(journal, clock) });
}

function requireJournalIdentity(journal, { targetId, watchId, provider = journal.provider }) {
  if (journal.target_id !== targetId || journal.watch_id !== watchId || journal.provider !== provider) {
    fail("E_GENERATION_HOST_IDENTITY_MISMATCH", "rollover journal identityが一致しません");
  }
}

function validateHandle(handle, provider) {
  validateParentHostReceipt({
    schema: HOST_RECEIPT_SCHEMA,
    provider,
    watch_id: "w_00000000-0000-4000-8000-000000000000",
    target_id: `p_${"0".repeat(64)}`,
    outcome: "spawned",
    handle,
  }, "spawned");
}

function requireSameHandle(left, right, code) {
  if (left?.kind !== right?.kind || left?.value !== right?.value) fail(code, "provider handleが一致しません");
}

function requireDigestMatch(actual, expected, field) {
  if (actual !== expected) fail("E_GENERATION_HOST_RECEIPT_CONFLICT", `${field}が既存journalと一致しません`);
}

function digestBoundedReceipt(value) {
  plain(value, "command receipt");
  const encoded = canonical(value);
  if (Buffer.byteLength(encoded, "utf8") > 16 * 1024) fail("E_GENERATION_HOST_RECEIPT_INVALID", "command receiptが大きすぎます");
  return digestText(encoded);
}

function digestBoundedLaunchRequest(value) {
  const encoded = canonical(value);
  if (Buffer.byteLength(encoded, "utf8") > 16 * 1024) fail("E_GENERATION_HOST_LAUNCH_REQUEST_TOO_LARGE", "next host launch requestが大きすぎます");
  return digestText(encoded);
}

function digestValue(value) { return digestText(canonical(value)); }
function digestText(value) { return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`; }
function generationId(watchId, parentEpochId, sequence) {
  const hash = createHash("sha256").update("observer.generation.v1\0", "utf8");
  for (const part of [watchId, parentEpochId, String(sequence)]) hash.update(`${part}\0`, "utf8");
  return `sha256:${hash.digest("hex")}`;
}

function result(action, fields) {
  return { schema: GENERATION_HOST_LIFECYCLE_RESULT_SCHEMA, action, ...fields };
}

function validateIdentity(targetId, watchId) {
  if (typeof targetId !== "string" || !TARGET_ID_RE.test(targetId) || typeof watchId !== "string" || !WATCH_ID_RE.test(watchId)) {
    invalid("rollover identityが不正です");
  }
}

function generationDependencies(dependencies) { return dependencies.now ? { now: dependencies.now } : {}; }
function watchDependencies(dependencies) { return dependencies.now ? { now: dependencies.now } : {}; }
function currentTimestamp(clock) {
  const value = (clock ?? (() => new Date()))();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) invalid("rollover clockが不正です");
  return value.toISOString();
}
function nextTimestamp(journal, clock) {
  const value = currentTimestamp(clock);
  if (Date.parse(value) < Date.parse(journal.updated_at)) invalid("rollover clockが後退しています");
  return value;
}
function timestamp(value) {
  const parsed = typeof value === "string" ? new Date(value) : null;
  if (parsed === null || Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) invalid("rollover timestampが不正です");
}
function requireDigest(value, field) { if (typeof value !== "string" || !DIGEST_RE.test(value)) invalid(`${field}が不正です`); }
function plain(value, field) { if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) invalid(`${field}はplain objectである必要があります`); }
function exact(value, expected, field) { const actual = Object.keys(value).sort(); const wanted = [...expected].sort(); if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) invalid(`${field}に未知または不足fieldがあります`); }
function canonical(value) { if (value === null || typeof value !== "object") return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`; }
function serialize(value) { return `${JSON.stringify(value)}\n`; }
function invalid(message) { fail("E_GENERATION_HOST_STATE_INVALID", message); }
