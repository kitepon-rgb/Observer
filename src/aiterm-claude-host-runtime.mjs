import { createHash } from "node:crypto";
import { join } from "node:path";

import { fail, ObserverError } from "./observer-error.mjs";
import { initializeGeneration } from "./generation-store.mjs";
import {
  HOST_RECEIPT_SCHEMA,
  confirmParentHostSpawn,
  confirmParentLaunch,
  validateParentHostReceipt,
  validateParentLaunchRequest,
} from "./parent-launch.mjs";
import {
  acquirePrivateLock,
  assertPrivateDirectory,
  atomicCreatePrivateFile,
  atomicReplacePrivateFile,
  ensurePrivateDirectory,
  readPrivateJson,
} from "./private-state.mjs";
import { readWatchHostBinding, readWatchStatus } from "./watch-store.mjs";

export const AITERM_CLAUDE_LAUNCH_JOURNAL_SCHEMA = "observer.aiterm_claude_launch.v1";

const TARGET = /^p_[a-f0-9]{64}$/;
const WATCH = /^w_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SESSION = /^[A-Za-z0-9_-]{1,64}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const DEFINITE_REJECTION_CODES = new Set([
  "E_AITERM_CONNECTION_NOT_INITIALIZED",
  "E_AITERM_RUNTIME_IDENTITY_CHANGED",
  "E_AITERM_TOOL_ERROR",
  "E_AITERM_TOOL_INPUT_INVALID",
  "E_AITERM_TRANSPORT_CLOSED",
]);

export async function spawnAitermClaudeObserver({ stateRoot, request, transport } = {}, dependencies = {}) {
  validateRequest(request);
  validateTransport(transport);
  const paths = await pathsFor(stateRoot, request);
  const release = await acquirePrivateLock(paths.lock);
  let journal;
  try {
    const timestamp = currentTimestamp(dependencies.now);
    const prepared = validateJournal({
      schema: AITERM_CLAUDE_LAUNCH_JOURNAL_SCHEMA,
      provider: "claude",
      target_id: request.target_id,
      watch_id: request.watch_id,
      session_id: request.host.session_name,
      launch_request_digest: requestDigest(request),
      status: "launching",
      failure_code: null,
      created_at: timestamp,
      updated_at: timestamp,
    });
    try {
      await atomicCreatePrivateFile(paths.file, serialize(prepared));
      journal = prepared;
    } catch (error) {
      if (error?.code !== "E_ALREADY_EXISTS") throw error;
      journal = validateJournal(await readPrivateJson(paths.file));
      requireIdentity(journal, request);
      if (["spawned", "bound"].includes(journal.status)) return spawnResult(request, journal.session_id);
      if (journal.status === "rejected") launchRejected(journal.failure_code);
      fail("E_AITERM_CLAUDE_LAUNCH_UNKNOWN", "Claude session launch結果が不明です。recoverだけを実行してください");
    }
  } finally {
    await release();
  }

  let structured;
  try {
    structured = await transport.callTool("claude_agent", {
      cwd: request.runtime_root,
      session_name: request.host.session_name,
      agent_done: true,
    });
  } catch (error) {
    if (error instanceof ObserverError && DEFINITE_REJECTION_CODES.has(error.code)) {
      try {
        await markRejected({ paths, request, failureCode: error.code, dependencies });
      } catch (journalError) {
        throw new AggregateError([error, journalError], "Claude launch拒否とjournal記録の両方に失敗しました");
      }
    }
    throw error;
  }
  validateLaunchResult(structured, request);
  const completed = await markSpawned({ paths, request, dependencies });
  return spawnResult(request, completed.session_id);
}

export async function recoverAitermClaudeSpawn({ stateRoot, request, transport } = {}, dependencies = {}) {
  validateRequest(request);
  validateTransport(transport);
  const paths = await pathsFor(stateRoot, request);
  const initial = await readLaunchJournal(paths, request);
  if (["spawned", "bound"].includes(initial.status)) return recoveryResult("spawned", null, spawnReceipt(request, initial.session_id));
  if (initial.status === "rejected") launchRejected(initial.failure_code);
  if (initial.status !== "launching") fail("E_AITERM_CLAUDE_LAUNCH_STATE", "Claude launch journal statusが不正です");
  const operationId = launchProbeOperationId(request);
  const structured = await transport.callTool("claude_turn", {
    action: "recover",
    session_id: initial.session_id,
    operation_id: operationId,
  });
  validateProbeResult(structured, request, operationId);
  const completed = await markSpawned({ paths, request, dependencies });
  return recoveryResult("spawned", null, spawnReceipt(request, completed.session_id));
}

export async function activateAitermClaudeObserver({
  stateRoot,
  request,
  receipt,
  parentThreadSha256,
} = {}, dependencies = {}) {
  validateRequest(request);
  validateSpawnReceipt(receipt, request);
  if (typeof parentThreadSha256 !== "string" || !/^[a-f0-9]{64}$/.test(parentThreadSha256)) {
    fail("E_AITERM_CLAUDE_PARENT_DIGEST_INVALID", "Claude親thread digestが不正です");
  }

  let watch = await (dependencies.readWatchStatus ?? readWatchStatus)({
    stateRoot,
    targetId: request.target_id,
  });
  requireWatchIdentity(watch, request);
  if (["starting", "launching"].includes(watch.status)) {
    try {
      watch = await (dependencies.confirmParentHostSpawn ?? confirmParentHostSpawn)({
        stateRoot,
        request,
        receipt,
      }, dependencies.parentDependencies ?? {});
      if (watch?.status !== "launching") {
        fail("E_AITERM_CLAUDE_PARENT_STATE_INVALID", "Claude session handleがlaunchingへ耐久化されていません");
      }
    } catch (error) {
      if (!(error instanceof ObserverError) || error.code !== "E_WATCH_TRANSITION_INVALID") throw error;
      watch = await requireActiveBinding({ stateRoot, request, receipt, dependencies });
    }
  } else if (watch.status === "active") {
    watch = await requireActiveBinding({ stateRoot, request, receipt, dependencies });
  } else {
    fail("E_AITERM_CLAUDE_PARENT_STATE_INVALID", "Claude watchは初期launchを再開できない状態です");
  }

  const readyReceipt = await markBound({ stateRoot, request, dependencies });
  let active;
  if (watch.status === "active") {
    active = watch;
  } else {
    try {
      active = await (dependencies.confirmParentLaunch ?? confirmParentLaunch)({
        stateRoot,
        request,
        receipt: readyReceipt,
      }, dependencies.parentDependencies ?? {});
    } catch (error) {
      if (!(error instanceof ObserverError) || error.code !== "E_WATCH_TRANSITION_INVALID") throw error;
      active = await requireActiveBinding({ stateRoot, request, receipt, dependencies });
    }
  }
  if (active?.status !== "active") {
    fail("E_AITERM_CLAUDE_PARENT_STATE_INVALID", "Claude watchがactiveへ遷移していません");
  }

  const generation = await (dependencies.initializeGeneration ?? initializeGeneration)({
    stateRoot,
    targetId: request.target_id,
    watchId: request.watch_id,
    provider: "claude",
    parentThreadSha256,
    readyReceipt,
  }, dependencies.generationDependencies ?? {});

  return activationResult(request, readyReceipt, active, generation);
}

async function markBound({ stateRoot, request, dependencies }) {
  const paths = await pathsFor(stateRoot, request);
  const release = await acquirePrivateLock(paths.lock);
  try {
    const current = validateJournal(await readPrivateJson(paths.file));
    requireIdentity(current, request);
    if (current.status === "bound") return hostReceipt(request, "ready", current.session_id);
    if (current.status !== "spawned") fail("E_AITERM_CLAUDE_LAUNCH_STATE", "spawned Claude sessionだけをactivateできます");
    const next = validateJournal({ ...current, status: "bound", updated_at: currentTimestamp(dependencies.now) });
    await atomicReplacePrivateFile(paths.file, serialize(next));
    return hostReceipt(request, "ready", next.session_id);
  } finally {
    await release();
  }
}

export async function readAitermClaudeLaunchStatus({ stateRoot, request } = {}) {
  validateRequest(request);
  const paths = await pathsFor(stateRoot, request);
  const current = await readLaunchJournal(paths, request);
  return {
    schema: AITERM_CLAUDE_LAUNCH_JOURNAL_SCHEMA,
    provider: current.provider,
    target_id: current.target_id,
    watch_id: current.watch_id,
    session_id: current.session_id,
    status: current.status,
    failure_code: current.failure_code,
  };
}

async function markSpawned({ paths, request, dependencies }) {
  const release = await acquirePrivateLock(paths.lock);
  try {
    const current = validateJournal(await readPrivateJson(paths.file));
    requireIdentity(current, request);
    if (["spawned", "bound"].includes(current.status)) return current;
    if (current.status !== "launching") fail("E_AITERM_CLAUDE_LAUNCH_STATE", "Claude launch journal statusが不正です");
    const next = validateJournal({ ...current, status: "spawned", updated_at: currentTimestamp(dependencies.now) });
    await atomicReplacePrivateFile(paths.file, serialize(next));
    return next;
  } finally {
    await release();
  }
}

async function markRejected({ paths, request, failureCode, dependencies }) {
  const release = await acquirePrivateLock(paths.lock);
  try {
    const current = validateJournal(await readPrivateJson(paths.file));
    requireIdentity(current, request);
    if (current.status === "rejected" && current.failure_code === failureCode) return current;
    if (current.status !== "launching") fail("E_AITERM_CLAUDE_LAUNCH_STATE", "launching Claude sessionだけをrejectできます");
    const next = validateJournal({
      ...current,
      status: "rejected",
      failure_code: failureCode,
      updated_at: currentTimestamp(dependencies.now),
    });
    await atomicReplacePrivateFile(paths.file, serialize(next));
    return next;
  } finally {
    await release();
  }
}

async function readLaunchJournal(paths, request) {
  let current;
  try {
    current = validateJournal(await readPrivateJson(paths.file));
  } catch (error) {
    if (error?.code === "ENOENT") fail("E_AITERM_CLAUDE_LAUNCH_NOT_FOUND", "Claude launch journalがありません");
    throw error;
  }
  requireIdentity(current, request);
  return current;
}

function validateLaunchResult(value, request) {
  const keys = "managed_completion,provider,schema,session_id";
  if (!isPlainObject(value) || Object.keys(value).sort().join(",") !== keys ||
      value.schema !== "aiterm.agent-launch-result.v1" || value.provider !== "claude" ||
      value.session_id !== request.host.session_name || value.managed_completion !== true) {
    fail("E_AITERM_CLAUDE_LAUNCH_RESULT_MISMATCH", "Aiterm Claude launch receiptがrequestと一致しません");
  }
}

function validateProbeResult(value, request, operationId) {
  const keys = "action,operation_id,raw_output,reason,schema,session_id,status";
  if (!isPlainObject(value) || Object.keys(value).sort().join(",") !== keys ||
      value.schema !== "aiterm.claude-operation-result.v1" || value.action !== "recover" ||
      value.status !== "unknown" || value.session_id !== request.host.session_name ||
      value.operation_id !== operationId || value.raw_output !== null || value.reason !== "operation_not_found") {
    fail("E_AITERM_CLAUDE_LAUNCH_RECOVERY_MISMATCH", "Aiterm Claude session recovery probeが一致しません");
  }
}

function spawnResult(request, sessionId) {
  return {
    schema: "observer.aiterm_claude_spawn_result.v1",
    receipt: spawnReceipt(request, sessionId),
  };
}

function activationResult(request, readyReceipt, watchStatus, generation) {
  return {
    schema: "observer.aiterm_claude_activation_result.v1",
    ready_receipt: readyReceipt,
    watch_status: watchStatus,
    generation,
  };
}

function recoveryResult(outcome, reason, receipt) {
  return {
    schema: "observer.aiterm_claude_recovery_result.v1",
    outcome,
    reason,
    receipt,
  };
}

function spawnReceipt(request, sessionId) {
  return hostReceipt(request, "spawned", sessionId);
}

function validateSpawnReceipt(receipt, request) {
  validateParentHostReceipt(receipt, "spawned");
  if (receipt.provider !== "claude" || receipt.target_id !== request.target_id ||
      receipt.watch_id !== request.watch_id || receipt.handle.kind !== "claude.session" ||
      receipt.handle.value !== request.host.session_name) {
    fail("E_AITERM_CLAUDE_LAUNCH_RECEIPT_MISMATCH", "Claude session receiptがlaunch requestと一致しません");
  }
}

function requireWatchIdentity(watch, request) {
  if (!isPlainObject(watch) || watch.provider !== "claude" || watch.target_id !== request.target_id ||
      watch.watch_id !== request.watch_id || watch.project_root !== request.project_root) {
    fail("E_AITERM_CLAUDE_PARENT_STATE_INVALID", "Claude watchがlaunch requestと一致しません");
  }
}

async function requireActiveBinding({ stateRoot, request, receipt, dependencies }) {
  const binding = await (dependencies.readWatchHostBinding ?? readWatchHostBinding)({
    stateRoot,
    targetId: request.target_id,
    watchId: request.watch_id,
  });
  if (binding?.status !== "active" || binding.provider !== "claude" ||
      binding.target_id !== request.target_id || binding.watch_id !== request.watch_id ||
      binding.project_root !== request.project_root || binding.launch_handle?.kind !== "claude.session" ||
      binding.launch_handle.value !== receipt.handle.value) {
    fail("E_AITERM_CLAUDE_PARENT_STATE_INVALID", "active Claude watchのsession bindingが一致しません");
  }
  const watch = await (dependencies.readWatchStatus ?? readWatchStatus)({
    stateRoot,
    targetId: request.target_id,
  });
  requireWatchIdentity(watch, request);
  if (watch.status !== "active") {
    fail("E_AITERM_CLAUDE_PARENT_STATE_INVALID", "Claude watchはactiveではありません");
  }
  return watch;
}

function hostReceipt(request, outcome, sessionId) {
  return {
    schema: HOST_RECEIPT_SCHEMA,
    provider: "claude",
    watch_id: request.watch_id,
    target_id: request.target_id,
    outcome,
    handle: { kind: "claude.session", value: sessionId },
  };
}

async function pathsFor(stateRoot, request) {
  await assertPrivateDirectory(stateRoot);
  const watches = join(stateRoot, "watches");
  const target = join(watches, request.target_id);
  await assertPrivateDirectory(watches);
  await assertPrivateDirectory(target);
  const root = join(target, "host-operations");
  await ensurePrivateDirectory(root);
  const suffix = request.watch_id.slice(2);
  return {
    file: join(root, `aiterm-claude-${suffix}.json`),
    lock: join(root, `aiterm-claude-${suffix}.lock`),
  };
}

function validateRequest(request) {
  validateParentLaunchRequest(request);
  if (request.provider !== "claude" || request.required_handle_kind !== "claude.session" ||
      request.host?.kind !== "aiterm.claude_agent.v1" || request.host.agent_done !== true ||
      request.host.cwd !== request.runtime_root || !SESSION.test(request.host.session_name)) {
    fail("E_AITERM_CLAUDE_LAUNCH_REQUEST_INVALID", "Aiterm Claude launch requestが不正です");
  }
}

function validateTransport(value) {
  if (!value || typeof value.callTool !== "function") fail("E_AITERM_CLAUDE_TRANSPORT_INVALID", "Aiterm Claude transportが不正です");
}

function validateJournal(value) {
  const keys = "created_at,failure_code,launch_request_digest,provider,schema,session_id,status,target_id,updated_at,watch_id";
  const failureValid = value?.status === "rejected"
    ? DEFINITE_REJECTION_CODES.has(value.failure_code)
    : value?.failure_code === null;
  if (!isPlainObject(value) || Object.keys(value).sort().join(",") !== keys ||
      value.schema !== AITERM_CLAUDE_LAUNCH_JOURNAL_SCHEMA || value.provider !== "claude" ||
      !TARGET.test(value.target_id) || !WATCH.test(value.watch_id) || !SESSION.test(value.session_id) ||
      !DIGEST.test(value.launch_request_digest) || !["launching", "spawned", "bound", "rejected"].includes(value.status) ||
      !failureValid ||
      !timestamp(value.created_at) || !timestamp(value.updated_at) || Date.parse(value.updated_at) < Date.parse(value.created_at)) {
    fail("E_AITERM_CLAUDE_LAUNCH_STATE", "Aiterm Claude launch journalが不正です");
  }
  return value;
}

function launchRejected(failureCode) {
  fail("E_AITERM_CLAUDE_LAUNCH_REJECTED", `Aiterm Claude launchは明示拒否されました (${failureCode})`);
}

function requireIdentity(journal, request) {
  if (journal.target_id !== request.target_id || journal.watch_id !== request.watch_id ||
      journal.session_id !== request.host.session_name || journal.launch_request_digest !== requestDigest(request)) {
    fail("E_AITERM_CLAUDE_LAUNCH_CONFLICT", "Aiterm Claude launch identityが一致しません");
  }
}

function requestDigest(request) {
  return `sha256:${createHash("sha256").update(
    `${AITERM_CLAUDE_LAUNCH_JOURNAL_SCHEMA}\0${JSON.stringify(request)}`,
    "utf8",
  ).digest("hex")}`;
}

function launchProbeOperationId(request) {
  return `sha256:${createHash("sha256").update(
    `observer.aiterm_claude_launch_probe.v1\0${request.target_id}\0${request.watch_id}\0${request.host.session_name}`,
    "utf8",
  ).digest("hex")}`;
}

function currentTimestamp(now) {
  const value = (now ?? (() => new Date()))();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) fail("E_AITERM_CLAUDE_CLOCK", "Aiterm Claude launch clockが不正です");
  return value.toISOString();
}

function timestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function serialize(value) { return `${JSON.stringify(value)}\n`; }
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
