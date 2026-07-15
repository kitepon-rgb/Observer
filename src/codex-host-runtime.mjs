import { join } from "node:path";

import {
  buildCodexInitializeParams,
  buildCodexThreadReadParams,
  buildCodexThreadResumeParams,
  buildCodexThreadStartParams,
  buildCodexTurnStartParams,
  CODEX_TURN_OPERATION_SCHEMA,
  parseCodexThreadReadResult,
  parseCodexThreadResumeResult,
  parseCodexThreadStartResult,
  parseCodexTurnStartResult,
  planCodexTurnStop,
  recordCodexInterruptResult,
  validateCodexInitializeResult,
  validateCodexStopRequest,
} from "./codex-host-adapter.mjs";
import { fail, ObserverError } from "./observer-error.mjs";
import {
  CODEX_TURN_TERMINAL_SCHEMA,
  confirmParentHostSpawn,
  confirmParentLaunch,
  HOST_RECEIPT_SCHEMA,
  validateParentLaunchRequest,
} from "./parent-launch.mjs";
import {
  acquirePrivateLock,
  atomicCreatePrivateFile,
  atomicReplacePrivateFile,
  ensureStatePath,
  readPrivateJson,
} from "./private-state.mjs";

export const CODEX_HOST_JOURNAL_SCHEMA = "observer.codex_host_journal.v1";
export const CODEX_HOST_SPAWN_RESULT_SCHEMA = "observer.codex_host_spawn_result.v1";
export const CODEX_HOST_ACTIVATION_RESULT_SCHEMA = "observer.codex_host_activation_result.v1";
export const CODEX_HOST_RESUME_RESULT_SCHEMA = "observer.codex_host_resume_result.v1";
export const CODEX_HOST_STOP_RESULT_SCHEMA = "observer.codex_host_stop_result.v1";
export const CODEX_GENERATION_ACTIVATION_RESULT_SCHEMA = "observer.codex_generation_activation_result.v1";
export const CODEX_GENERATION_RECOVERY_RESULT_SCHEMA = "observer.codex_generation_recovery_result.v1";
export const CODEX_GENERATION_TERMINAL_RESULT_SCHEMA = "observer.codex_generation_terminal_result.v1";

const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const JOURNAL_STATUSES = new Set([
  "thread_starting", "thread_start_unknown", "thread_created", "turn_prepared", "turn_start_unknown",
  "running", "stopping", "completed", "interrupted", "failed",
]);
const TERMINAL_STATUSES = new Set(["completed", "interrupted", "failed"]);
const GENERATION_TERMINAL_OBSERVATION_STATUSES = new Set(["running", "stopping", ...TERMINAL_STATUSES]);
const claimedSessions = new WeakSet();
const initializedSessions = new WeakSet();

export async function initializeCodexObserverSession({ session } = {}, dependencies = {}) {
  validateSession(session);
  if (claimedSessions.has(session)) fail("E_CODEX_CONNECTION_ALREADY_INITIALIZED", "Codex app-server connectionは既にinitializeを試行済みです");
  claimedSessions.add(session);
  let result;
  try {
    result = await session.request("initialize", buildCodexInitializeParams());
    await session.notify("initialized", {});
  } catch {
    fail("E_CODEX_CONNECTION_INITIALIZE_FAILED", "Codex app-server connectionをinitializeできません");
  }
  const verification = validateCodexInitializeResult(result, now(dependencies));
  initializedSessions.add(session);
  return verification;
}

export async function spawnCodexObserverThread({ stateRoot, request, session, generationId = null } = {}, dependencies = {}) {
  requireCodexLaunchRequest(request);
  requireInitializedSession(session);
  validateGenerationId(generationId);
  await createJournal({ stateRoot, request, generationId, timestamp: now(dependencies) });
  let result;
  try {
    result = await session.request("thread/start", buildCodexThreadStartParams(request));
    const observation = parseCodexThreadStartResult({ result, request, observedAt: now(dependencies) });
    const journal = await transitionJournal({
      stateRoot, request, generationId, expected: ["thread_starting"], status: "thread_created",
      threadId: observation.thread_id, turnId: null, cycleId: null, terminalStatus: null,
    }, dependencies);
    return {
      schema: CODEX_HOST_SPAWN_RESULT_SCHEMA,
      receipt: hostReceipt(request, "spawned", observation.thread_id),
      observation,
      journal: publicJournal(journal),
    };
  } catch (error) {
    await transitionJournal({
      stateRoot, request, generationId, expected: ["thread_starting"], status: "thread_start_unknown",
      threadId: null, turnId: null, cycleId: null, terminalStatus: null,
    }, dependencies);
    if (error instanceof ObserverError && error.code.startsWith("E_CODEX_")) throw error;
    fail("E_CODEX_THREAD_START_UNKNOWN", "Codex thread/start結果が不明です。同じwatchを再spawnしないでください");
  }
}

export async function spawnCodexGenerationObserverThread({ stateRoot, request, session, generationId } = {}, dependencies = {}) {
  requireGenerationId(generationId);
  return spawnCodexObserverThread({ stateRoot, request, session, generationId }, dependencies);
}

export async function activateCodexObserver({ stateRoot, request, spawnResult, session, cycleId = null, generationId = null } = {}, dependencies = {}) {
  requireCodexLaunchRequest(request);
  requireInitializedSession(session);
  validateSpawnResult(spawnResult, request);
  validateGenerationId(generationId);
  const effectiveCycleId = cycleId ?? request.watch_id;
  validateCycleId(effectiveCycleId);
  const confirmSpawn = dependencies.confirmParentHostSpawn ?? confirmParentHostSpawn;
  const launching = await confirmSpawn({ stateRoot, request, receipt: spawnResult.receipt }, dependencies.parentDependencies ?? {});
  if (launching?.status !== "launching") fail("E_CODEX_PARENT_LAUNCH_STATE_INVALID", "Codex thread handleがlaunchingへ耐久化されていません");
  await transitionJournal({
    stateRoot, request, generationId, expected: ["thread_created"], status: "turn_prepared",
    threadId: spawnResult.receipt.handle.value, turnId: null, cycleId: effectiveCycleId, terminalStatus: null,
  }, dependencies);
  let operation;
  try {
    const result = await session.request("turn/start", buildCodexTurnStartParams({ request, threadId: spawnResult.receipt.handle.value }));
    operation = parseCodexTurnStartResult({ result, threadId: spawnResult.receipt.handle.value, observedAt: now(dependencies) });
  } catch (error) {
    await transitionJournal({
      stateRoot, request, generationId, expected: ["turn_prepared"], status: "turn_start_unknown",
      threadId: spawnResult.receipt.handle.value, turnId: null, cycleId: effectiveCycleId, terminalStatus: null,
    }, dependencies);
    if (error instanceof ObserverError && error.code.startsWith("E_CODEX_")) throw error;
    fail("E_CODEX_TURN_START_UNKNOWN", "Codex turn/start結果が不明です。同じcycleを再実行しないでください");
  }
  const journal = await transitionJournal({
    stateRoot, request, generationId, expected: ["turn_prepared"], status: "running",
    threadId: operation.thread_id, turnId: operation.turn_id, cycleId: effectiveCycleId, terminalStatus: null,
  }, dependencies);
  const readyReceipt = hostReceipt(request, "ready", operation.thread_id);
  const confirmReady = dependencies.confirmParentLaunch ?? confirmParentLaunch;
  const active = await confirmReady({ stateRoot, request, receipt: readyReceipt }, dependencies.parentDependencies ?? {});
  if (active?.status !== "active") fail("E_CODEX_PARENT_LAUNCH_STATE_INVALID", "Codex watchがactiveへ遷移しませんでした");
  return {
    schema: CODEX_HOST_ACTIVATION_RESULT_SCHEMA,
    operation,
    ready_receipt: readyReceipt,
    journal: publicJournal(journal),
    watch_status: active,
  };
}

export async function activateCodexGenerationObserver({
  stateRoot,
  request,
  spawnResult,
  session,
  cycleId = null,
  generationId,
} = {}, dependencies = {}) {
  requireCodexLaunchRequest(request);
  requireInitializedSession(session);
  requireGenerationId(generationId);
  validateGenerationSpawnResult(spawnResult, request);
  const effectiveCycleId = cycleId ?? generationId;
  validateCycleId(effectiveCycleId);
  const threadId = spawnResult.receipt.handle.value;
  const durableSpawn = await readJournal({ stateRoot, request, generationId });
  if (durableSpawn.status !== "thread_created" || durableSpawn.thread_id !== threadId) {
    fail("E_CODEX_SPAWN_RESULT_INVALID", "Codex generation spawn receiptがdurable journalと一致しません");
  }
  await transitionJournal({
    stateRoot, request, generationId, expected: ["thread_created"], status: "turn_prepared",
    threadId, turnId: null, cycleId: effectiveCycleId, terminalStatus: null,
  }, dependencies);
  let operation;
  try {
    const result = await session.request("turn/start", buildCodexTurnStartParams({ request, threadId }));
    operation = parseCodexTurnStartResult({ result, threadId, observedAt: now(dependencies) });
  } catch (error) {
    await transitionJournal({
      stateRoot, request, generationId, expected: ["turn_prepared"], status: "turn_start_unknown",
      threadId, turnId: null, cycleId: effectiveCycleId, terminalStatus: null,
    }, dependencies);
    if (error instanceof ObserverError && error.code.startsWith("E_CODEX_")) throw error;
    fail("E_CODEX_TURN_START_UNKNOWN", "Codex turn/start結果が不明です。同じgenerationで別turnを開始しないでください");
  }
  const journal = await transitionJournal({
    stateRoot, request, generationId, expected: ["turn_prepared"], status: "running",
    threadId: operation.thread_id, turnId: operation.turn_id, cycleId: effectiveCycleId, terminalStatus: null,
  }, dependencies);
  return {
    schema: CODEX_GENERATION_ACTIVATION_RESULT_SCHEMA,
    operation,
    ready_receipt: hostReceipt(request, "ready", operation.thread_id),
    journal: publicJournal(journal),
  };
}

export async function recoverCodexGenerationSpawn({ stateRoot, request, generationId } = {}) {
  requireCodexLaunchRequest(request);
  requireGenerationId(generationId);
  let journal;
  try {
    journal = await readJournal({ stateRoot, request, generationId });
  } catch (error) {
    if (error instanceof ObserverError && error.code === "E_CODEX_JOURNAL_NOT_FOUND") {
      return generationRecovery("unknown", "journal_missing", null);
    }
    throw error;
  }
  if (["thread_starting", "thread_start_unknown"].includes(journal.status)) {
    return generationRecovery("unknown", journal.status, null);
  }
  if (journal.thread_id === null) return generationRecovery("unknown", "thread_handle_missing", null);
  return generationRecovery("spawned", null, hostReceipt(request, "spawned", journal.thread_id));
}

export async function recoverCodexGenerationReady({ stateRoot, request, session, generationId } = {}, dependencies = {}) {
  requireCodexLaunchRequest(request);
  requireInitializedSession(session);
  requireGenerationId(generationId);
  let journal;
  try {
    journal = await readJournal({ stateRoot, request, generationId });
  } catch (error) {
    if (error instanceof ObserverError && error.code === "E_CODEX_JOURNAL_NOT_FOUND") {
      return generationRecovery("unknown", "journal_missing", null);
    }
    throw error;
  }
  if (journal.status !== "running" || journal.thread_id === null || journal.turn_id === null) {
    return generationRecovery("unknown", journal.status, null);
  }
  const observation = await readCodexObserverThread({ request, threadId: journal.thread_id, session }, dependencies);
  const turn = observation.turns.find((entry) => entry.turn_id === journal.turn_id);
  if (turn?.status !== "inProgress") return generationRecovery("unknown", "turn_not_in_progress", null);
  return {
    ...generationRecovery("ready", null, hostReceipt(request, "ready", journal.thread_id)),
    operation: operationFromJournal(journal),
  };
}

export async function observeCodexGenerationTerminal({ stateRoot, request, session, generationId } = {}, dependencies = {}) {
  requireCodexLaunchRequest(request);
  requireInitializedSession(session);
  requireGenerationId(generationId);
  let journal;
  try {
    journal = await readJournal({ stateRoot, request, generationId });
  } catch (error) {
    if (error instanceof ObserverError && error.code === "E_CODEX_JOURNAL_NOT_FOUND") {
      return generationTerminalObservation(request, generationId, "unknown", "journal_missing", null);
    }
    return generationTerminalObservation(request, generationId, "unknown", "journal_unreadable", null);
  }
  if (!GENERATION_TERMINAL_OBSERVATION_STATUSES.has(journal.status)) {
    return generationTerminalObservation(request, generationId, "unknown", journal.status, null);
  }
  if (journal.thread_id === null || journal.turn_id === null) {
    return generationTerminalObservation(request, generationId, "unknown", "durable_handle_missing", null);
  }
  let observation;
  try {
    observation = await readCodexObserverThread({ request, threadId: journal.thread_id, session }, dependencies);
  } catch {
    return generationTerminalObservation(request, generationId, "unknown", "thread_read_failed", null);
  }
  const turn = observation.turns.find((entry) => entry.turn_id === journal.turn_id);
  if (!turn) return generationTerminalObservation(request, generationId, "unknown", "durable_turn_missing", null);
  if (TERMINAL_STATUSES.has(turn.status)) {
    if (journal.terminal_status !== null && journal.terminal_status !== turn.status) {
      return generationTerminalObservation(request, generationId, "unknown", "terminal_status_mismatch", null);
    }
    return generationTerminalObservation(request, generationId, "terminal", null, {
      schema: "observer.codex_generation_terminal_receipt.v1",
      provider: "codex",
      watch_id: request.watch_id,
      target_id: request.target_id,
      generation_id: generationId,
      terminal_status: turn.status,
      observed_at: observation.observed_at,
    });
  }
  if (turn.status === "inProgress") {
    if (journal.terminal_status !== null) {
      return generationTerminalObservation(request, generationId, "unknown", "terminal_status_mismatch", null);
    }
    return generationTerminalObservation(request, generationId, "pending", "turn_in_progress", null);
  }
  return generationTerminalObservation(request, generationId, "unknown", "turn_status_unknown", null);
}

export async function recoverCodexObserverReady({ stateRoot, request, session, generationId = null } = {}, dependencies = {}) {
  requireCodexLaunchRequest(request);
  requireInitializedSession(session);
  validateGenerationId(generationId);
  const journal = await readJournal({ stateRoot, request, generationId });
  if (journal.status !== "running" || journal.thread_id === null || journal.turn_id === null) {
    fail("E_CODEX_READY_RECOVERY_UNAVAILABLE", "ready回収に使えるdurable turn handleがありません");
  }
  const observation = await readCodexObserverThread({ request, threadId: journal.thread_id, session }, dependencies);
  const turn = observation.turns.find((entry) => entry.turn_id === journal.turn_id);
  if (turn?.status !== "inProgress") fail("E_CODEX_READY_RECOVERY_UNAVAILABLE", "保存済みCodex turnはrunningではありません");
  const receipt = hostReceipt(request, "ready", journal.thread_id);
  const confirmReady = dependencies.confirmParentLaunch ?? confirmParentLaunch;
  const active = await confirmReady({ stateRoot, request, receipt }, dependencies.parentDependencies ?? {});
  return { schema: CODEX_HOST_ACTIVATION_RESULT_SCHEMA, operation: operationFromJournal(journal), ready_receipt: receipt, journal: publicJournal(journal), watch_status: active };
}

export async function resumeCodexObserverThread({ request, threadId, session } = {}, dependencies = {}) {
  requireCodexLaunchRequest(request);
  requireInitializedSession(session);
  let result;
  try {
    result = await session.request("thread/resume", buildCodexThreadResumeParams({ request, threadId }));
  } catch {
    fail("E_CODEX_THREAD_RESUME_FAILED", "保存済みCodex threadをresumeできません");
  }
  const observation = parseCodexThreadResumeResult({ result, request, threadId, observedAt: now(dependencies) });
  return { schema: CODEX_HOST_RESUME_RESULT_SCHEMA, observation, subscribed: true };
}

export async function readCodexObserverThread({ request, threadId, session } = {}, dependencies = {}) {
  requireCodexLaunchRequest(request);
  requireInitializedSession(session);
  let result;
  try {
    result = await session.request("thread/read", buildCodexThreadReadParams(threadId));
  } catch {
    fail("E_CODEX_THREAD_READ_FAILED", "保存済みCodex threadをreadできません");
  }
  return parseCodexThreadReadResult({ result, expectedThreadId: threadId, expectedCwd: request.runtime_root, observedAt: now(dependencies) });
}

export async function stopCodexObserver({ stateRoot, request, launchRequest, session, previousInterruptReceipt = null, generationId = null } = {}, dependencies = {}) {
  validateCodexStopRequest(request);
  requireCodexLaunchRequest(launchRequest);
  requireInitializedSession(session);
  validateGenerationId(generationId);
  if (request.watch_id !== launchRequest.watch_id || request.target_id !== launchRequest.target_id || request.handle.value === null) {
    fail("E_CODEX_STOP_CORRELATION_FAILED", "Codex stop requestがlaunch requestと一致しません");
  }
  const journal = await readJournal({ stateRoot, request: launchRequest, generationId });
  if (journal.thread_id !== request.handle.value || journal.turn_id === null || ["thread_start_unknown", "turn_start_unknown"].includes(journal.status)) {
    fail("E_CODEX_STOP_CORRELATION_FAILED", "Codex stopに必要なdurable turn handleがありません");
  }
  const observation = await readCodexObserverThread({ request: launchRequest, threadId: journal.thread_id, session }, dependencies);
  const operation = operationFromJournal(journal);
  const plan = planCodexTurnStop({ operation, observation, previousInterruptReceipt });
  if (plan.action === "already_terminal") {
    const terminalJournal = TERMINAL_STATUSES.has(journal.status)
      ? journal
      : await transitionJournal({
          stateRoot, request: launchRequest, generationId, expected: ["running", "stopping"], status: plan.terminal_status,
          threadId: journal.thread_id, turnId: journal.turn_id, cycleId: journal.cycle_id, terminalStatus: plan.terminal_status,
        }, dependencies);
    return {
      schema: CODEX_HOST_STOP_RESULT_SCHEMA,
      command_receipt: previousInterruptReceipt,
      terminal_receipt: terminalHostReceipt(request, journal.thread_id, journal.turn_id, plan.terminal_status, observation.observed_at),
      terminal_status: plan.terminal_status,
      journal: publicJournal(terminalJournal),
    };
  }
  if (plan.action === "await_terminal_observation") {
    return { schema: CODEX_HOST_STOP_RESULT_SCHEMA, command_receipt: previousInterruptReceipt, terminal_receipt: null, terminal_status: null, journal: publicJournal(journal) };
  }
  if (journal.status === "stopping") {
    return { schema: CODEX_HOST_STOP_RESULT_SCHEMA, command_receipt: previousInterruptReceipt, terminal_receipt: null, terminal_status: null, journal: publicJournal(journal) };
  }
  const stopping = await transitionJournal({
    stateRoot, request: launchRequest, generationId, expected: ["running"], status: "stopping",
    threadId: journal.thread_id, turnId: journal.turn_id, cycleId: journal.cycle_id, terminalStatus: null,
  }, dependencies);
  let result;
  try {
    result = await session.request(plan.method, plan.params);
  } catch {
    fail("E_CODEX_INTERRUPT_RESULT_UNKNOWN", "Codex interrupt結果が不明です。terminalを再観測してください");
  }
  const commandReceipt = recordCodexInterruptResult({ result, operation, observedAt: now(dependencies) });
  return { schema: CODEX_HOST_STOP_RESULT_SCHEMA, command_receipt: commandReceipt, terminal_receipt: null, terminal_status: null, journal: publicJournal(stopping) };
}

async function createJournal({ stateRoot, request, generationId, timestamp }) {
  const paths = await journalPaths(stateRoot, request, generationId);
  return withLock(paths.lockPath, async () => {
    const journal = validateJournal({
      schema: CODEX_HOST_JOURNAL_SCHEMA,
      watch_id: request.watch_id,
      target_id: request.target_id,
      thread_id: null,
      turn_id: null,
      cycle_id: null,
      status: "thread_starting",
      terminal_status: null,
      created_at: timestamp,
      updated_at: timestamp,
    });
    try {
      await atomicCreatePrivateFile(paths.journalPath, serialize(journal));
    } catch (error) {
      if (["EEXIST", "E_ALREADY_EXISTS"].includes(error?.code)) fail("E_CODEX_LAUNCH_ALREADY_RECORDED", "同じwatchのCodex launchを再実行できません");
      throw error;
    }
    return journal;
  });
}

async function transitionJournal({ stateRoot, request, generationId = null, expected, status, threadId, turnId, cycleId, terminalStatus }, dependencies) {
  const paths = await journalPaths(stateRoot, request, generationId);
  return withLock(paths.lockPath, async () => {
    const current = validateJournal(await readPrivateJson(paths.journalPath));
    if (!expected.includes(current.status)) fail("E_CODEX_JOURNAL_TRANSITION_INVALID", "Codex host journalの状態遷移が不正です");
    const timestamp = now(dependencies);
    const next = validateJournal({
      ...current,
      thread_id: threadId,
      turn_id: turnId,
      cycle_id: cycleId,
      status,
      terminal_status: terminalStatus,
      updated_at: timestamp,
    });
    await atomicReplacePrivateFile(paths.journalPath, serialize(next));
    return next;
  });
}

async function readJournal({ stateRoot, request, generationId = null }) {
  const paths = await journalPaths(stateRoot, request, generationId);
  try {
    return validateJournal(await readPrivateJson(paths.journalPath));
  } catch (error) {
    if (error?.code === "ENOENT") fail("E_CODEX_JOURNAL_NOT_FOUND", "Codex host journalがありません");
    throw error;
  }
}

async function journalPaths(stateRoot, request, generationId = null) {
  validateGenerationId(generationId);
  const directory = await ensureStatePath(stateRoot, "codex-operations", request.target_id);
  const namespace = generationId === null ? request.watch_id : `${request.watch_id}.${generationId.slice("sha256:".length)}`;
  return { journalPath: join(directory, `${namespace}.json`), lockPath: join(directory, `${namespace}.lock`) };
}

async function withLock(lockPath, operation) {
  const release = await acquirePrivateLock(lockPath);
  let primary = null;
  try {
    return await operation();
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    try {
      await release();
    } catch (releaseError) {
      if (primary !== null) throw new AggregateError([primary, releaseError], "Codex journal操作とlock解放に失敗しました");
      throw releaseError;
    }
  }
}

function validateJournal(value) {
  if (!isPlainObject(value) || !hasExactKeys(value, [
    "created_at", "cycle_id", "schema", "status", "target_id", "terminal_status",
    "thread_id", "turn_id", "updated_at", "watch_id",
  ]) || value.schema !== CODEX_HOST_JOURNAL_SCHEMA || !JOURNAL_STATUSES.has(value.status)) {
    fail("E_CODEX_JOURNAL_INVALID", "Codex host journalが不正です");
  }
  if (value.thread_id !== null && !UUID_V7_RE.test(value.thread_id)) fail("E_CODEX_JOURNAL_INVALID", "Codex journal thread IDが不正です");
  if (value.turn_id !== null && !UUID_V7_RE.test(value.turn_id)) fail("E_CODEX_JOURNAL_INVALID", "Codex journal turn IDが不正です");
  if (value.cycle_id !== null) validateCycleId(value.cycle_id);
  if (value.terminal_status !== null && !TERMINAL_STATUSES.has(value.terminal_status)) fail("E_CODEX_JOURNAL_INVALID", "Codex journal terminalが不正です");
  validateTimestamp(value.created_at);
  validateTimestamp(value.updated_at);
  if (Date.parse(value.updated_at) < Date.parse(value.created_at)) fail("E_CODEX_JOURNAL_INVALID", "Codex journal timestamp順序が不正です");
  if (["thread_starting", "thread_start_unknown"].includes(value.status) && (value.thread_id !== null || value.turn_id !== null || value.cycle_id !== null)) fail("E_CODEX_JOURNAL_INVALID", "Codex thread unknown journalがhandleをclaimしています");
  if (["thread_created"].includes(value.status) && (value.thread_id === null || value.turn_id !== null || value.cycle_id !== null)) fail("E_CODEX_JOURNAL_INVALID", "Codex thread journal handleが不正です");
  if (["turn_prepared", "turn_start_unknown"].includes(value.status) && (value.thread_id === null || value.turn_id !== null || value.cycle_id === null)) fail("E_CODEX_JOURNAL_INVALID", "Codex turn unknown journalが不正です");
  if (["running", "stopping", ...TERMINAL_STATUSES].includes(value.status) && (value.thread_id === null || value.turn_id === null || value.cycle_id === null)) fail("E_CODEX_JOURNAL_INVALID", "Codex active journal handleが不正です");
  if (TERMINAL_STATUSES.has(value.status) !== (value.terminal_status !== null)) fail("E_CODEX_JOURNAL_INVALID", "Codex journal terminal statusが矛盾しています");
  return value;
}

function validateSpawnResult(value, request) {
  if (!isPlainObject(value) || value.schema !== CODEX_HOST_SPAWN_RESULT_SCHEMA || !isPlainObject(value.receipt) ||
      value.receipt.provider !== "codex" || value.receipt.watch_id !== request.watch_id || value.receipt.target_id !== request.target_id ||
      value.receipt.outcome !== "spawned" || value.receipt.handle?.kind !== "codex.thread" || !UUID_V7_RE.test(value.receipt.handle.value)) {
    fail("E_CODEX_SPAWN_RESULT_INVALID", "Codex host spawn resultがrequestと一致しません");
  }
}

function validateGenerationSpawnResult(value, request) {
  const receipt = value?.receipt;
  if (!isPlainObject(value) || !isPlainObject(receipt) ||
      ![CODEX_HOST_SPAWN_RESULT_SCHEMA, CODEX_GENERATION_RECOVERY_RESULT_SCHEMA].includes(value.schema) ||
      (value.schema === CODEX_GENERATION_RECOVERY_RESULT_SCHEMA && value.outcome !== "spawned") ||
      receipt.provider !== "codex" || receipt.watch_id !== request.watch_id || receipt.target_id !== request.target_id ||
      receipt.outcome !== "spawned" || receipt.handle?.kind !== "codex.thread" || !UUID_V7_RE.test(receipt.handle.value)) {
    fail("E_CODEX_SPAWN_RESULT_INVALID", "Codex generation spawn resultがrequestと一致しません");
  }
}

function operationFromJournal(journal) {
  if (journal.thread_id === null || journal.turn_id === null) fail("E_CODEX_TURN_OPERATION_INVALID", "Codex journalにturn handleがありません");
  const status = TERMINAL_STATUSES.has(journal.status) ? journal.status : "inProgress";
  return { schema: CODEX_TURN_OPERATION_SCHEMA, thread_id: journal.thread_id, turn_id: journal.turn_id, status, observed_at: journal.updated_at };
}

function hostReceipt(request, outcome, threadId) {
  return { schema: HOST_RECEIPT_SCHEMA, provider: "codex", watch_id: request.watch_id, target_id: request.target_id, outcome, handle: { kind: "codex.thread", value: threadId } };
}

function terminalHostReceipt(request, threadId, turnId, status, observedAt) {
  return {
    ...hostReceipt(request, "stopped", threadId),
    terminal: { schema: CODEX_TURN_TERMINAL_SCHEMA, thread_id: threadId, turn_id: turnId, status, observed_at: observedAt },
  };
}

function requireCodexLaunchRequest(request) {
  try {
    validateParentLaunchRequest(request);
  } catch {
    fail("E_CODEX_HOST_REQUEST_INVALID", "Codex parent launch requestが不正です");
  }
  if (request.provider !== "codex" || request.host.kind !== "codex.app_server_thread.v1") fail("E_CODEX_HOST_REQUEST_INVALID", "Codex app-server launch requestが必要です");
}

function validateSession(session) {
  if ((typeof session !== "object" && typeof session !== "function") || session === null || typeof session.request !== "function" || typeof session.notify !== "function") {
    fail("E_CODEX_SESSION_INVALID", "Codex app-server sessionが不正です");
  }
}

function requireInitializedSession(session) {
  validateSession(session);
  if (!initializedSessions.has(session)) fail("E_CODEX_CONNECTION_NOT_INITIALIZED", "Codex app-server connectionを先にinitializeしてください");
}

function publicJournal(value) {
  return structuredClone(value);
}

function validateCycleId(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 128 || /[\u0000-\u001f\u007f]/u.test(value)) fail("E_CODEX_CYCLE_ID_INVALID", "Codex cycle IDが不正です");
}

function validateGenerationId(value) {
  if (value !== null && (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value))) {
    fail("E_CODEX_GENERATION_ID_INVALID", "Codex generation IDが不正です");
  }
}

function requireGenerationId(value) {
  if (value === null || value === undefined) fail("E_CODEX_GENERATION_ID_REQUIRED", "Codex generation runtimeにはgeneration IDが必要です");
  validateGenerationId(value);
}

function generationRecovery(outcome, reason, receipt) {
  return { schema: CODEX_GENERATION_RECOVERY_RESULT_SCHEMA, outcome, reason, receipt };
}

function generationTerminalObservation(request, generationId, outcome, reason, receipt) {
  return {
    schema: CODEX_GENERATION_TERMINAL_RESULT_SCHEMA,
    provider: "codex",
    watch_id: request.watch_id,
    target_id: request.target_id,
    generation_id: generationId,
    outcome,
    reason,
    receipt,
  };
}

function validateTimestamp(value) {
  if (typeof value !== "string") fail("E_CODEX_JOURNAL_INVALID", "Codex journal timestampが不正です");
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) fail("E_CODEX_JOURNAL_INVALID", "Codex journal timestampが不正です");
}

function now(dependencies) {
  return (dependencies.now ?? (() => new Date().toISOString()))();
}

function serialize(value) {
  return `${JSON.stringify(value)}\n`;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function hasExactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}
