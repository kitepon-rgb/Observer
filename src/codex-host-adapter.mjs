import { join } from "node:path";

import { validateCycleInputReceipt } from "./cycle-input.mjs";
import { buildObserverAiPrompt } from "./observer-ai-contract.mjs";
import { fail } from "./observer-error.mjs";
import { validateParentLaunchRequest, validateParentStopRequest } from "./parent-launch.mjs";

export const CODEX_CONNECTION_VERIFICATION_SCHEMA = "observer.codex_connection_verification.v1";
export const CODEX_THREAD_OBSERVATION_SCHEMA = "observer.codex_thread_observation.v1";
export const CODEX_TURN_OPERATION_SCHEMA = "observer.codex_turn_operation.v1";
export const CODEX_INTERRUPT_RECEIPT_SCHEMA = "observer.codex_interrupt_receipt.v1";

const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TURN_STATUSES = new Set(["inProgress", "completed", "interrupted", "failed"]);
const TERMINAL_TURN_STATUSES = new Set(["completed", "interrupted", "failed"]);

export function buildCodexInitializeParams() {
  return {
    clientInfo: { name: "observer", title: "Observer", version: "0.1.2" },
    capabilities: {
      optOutNotificationMethods: ["item/agentMessage/delta", "turn/diff/updated", "turn/plan/updated"],
    },
  };
}

export function validateCodexInitializeResult(value, observedAt) {
  if (!isPlainObject(value) || !hasStrings(value, ["codexHome", "platformFamily", "platformOs", "userAgent"])) {
    fail("E_CODEX_INITIALIZE_RESULT_INVALID", "Codex app-server initialize結果が不正です");
  }
  validateObservedAt(observedAt);
  return {
    schema: CODEX_CONNECTION_VERIFICATION_SCHEMA,
    user_agent: value.userAgent,
    platform_family: value.platformFamily,
    platform_os: value.platformOs,
    observed_at: observedAt,
  };
}

export function buildCodexThreadStartParams(request) {
  requireCodexLaunchRequest(request);
  return {
    cwd: request.runtime_root,
    approvalPolicy: "never",
    sandbox: "read-only",
    ephemeral: false,
    serviceName: "observer",
    developerInstructions: "Observer rootのAGENTS.mdを静的契約とし、turn inputのobserver.child_start.v1をexact検証してください。",
  };
}

export function buildCodexThreadResumeParams({ request, threadId } = {}) {
  requireCodexLaunchRequest(request);
  validateThreadId(threadId, "E_CODEX_THREAD_HANDLE_INVALID");
  return {
    threadId,
    cwd: request.runtime_root,
    approvalPolicy: "never",
    sandbox: "read-only",
    developerInstructions: "Observer rootのAGENTS.mdを静的契約とし、turn inputのobserver.child_start.v1をexact検証してください。",
  };
}

export function buildCodexTurnStartParams({ request, threadId } = {}) {
  requireCodexLaunchRequest(request);
  validateThreadId(threadId, "E_CODEX_THREAD_HANDLE_INVALID");
  return {
    threadId,
    input: [{ type: "text", text: buildObserverAiPrompt(request.child_start) }],
    cwd: request.runtime_root,
    approvalPolicy: "never",
    sandboxPolicy: { type: "readOnly", networkAccess: false },
  };
}

export function buildCodexThreadReadParams(threadId) {
  validateThreadId(threadId, "E_CODEX_THREAD_HANDLE_INVALID");
  return { threadId, includeTurns: true };
}

export function parseCodexCycleThreadContext({ result, expectedThreadId, expectedCwd } = {}) {
  validateThreadId(expectedThreadId, "E_CODEX_CYCLE_THREAD_INVALID");
  if (typeof expectedCwd !== "string" || expectedCwd.length === 0) {
    fail("E_CODEX_CYCLE_THREAD_INVALID", "Codex cycle thread cwdが不正です");
  }
  const thread = result?.thread;
  if (!isPlainObject(thread) || thread.id !== expectedThreadId || thread.cwd !== expectedCwd ||
      typeof thread.sessionId !== "string" || thread.sessionId.length === 0 || !Array.isArray(thread.turns)) {
    fail("E_CODEX_CYCLE_THREAD_MISMATCH", "Codex cycle thread identityが一致しません");
  }
  for (const turn of thread.turns) validateTurn(turn, "E_CODEX_CYCLE_THREAD_INVALID");
  if (new Set(thread.turns.map((turn) => turn.id)).size !== thread.turns.length) {
    fail("E_CODEX_CYCLE_THREAD_INVALID", "Codex cycle threadに重複turnがあります");
  }
  if (thread.turns.some((turn) => turn.status === "inProgress")) {
    fail("E_CODEX_CYCLE_TURN_ACTIVE", "前のCodex cycle turnがまだ完了していません");
  }
  return {
    thread_id: expectedThreadId,
    session_id: thread.sessionId,
    cwd: expectedCwd,
  };
}

export function buildCodexCycleTurnStartParams({ operation, value, context } = {}) {
  validateCycleThreadContext(context);
  if (!isPlainObject(operation) || operation.provider !== "codex" ||
      typeof operation.input_digest !== "string" || !Number.isSafeInteger(operation.model_visible_bytes)) {
    fail("E_CODEX_CYCLE_REQUEST_INVALID", "Codex cycle operationが不正です");
  }
  validateCycleInputReceipt({
    value,
    inputDigest: operation.input_digest,
    modelVisibleBytes: operation.model_visible_bytes,
  });
  return {
    threadId: context.thread_id,
    input: [{ type: "text", text: value }],
    cwd: context.cwd,
    approvalPolicy: "never",
    sandboxPolicy: { type: "readOnly", networkAccess: false },
  };
}

export function parseCodexCycleTurnStartResult({ result, context } = {}) {
  validateCycleThreadContext(context);
  const turn = result?.turn;
  validateTurn(turn, "E_CODEX_CYCLE_ACK_INVALID");
  if (turn.status !== "inProgress") fail("E_CODEX_CYCLE_ACK_INVALID", "Codex cycle turnがinProgressで開始されませんでした");
  return { thread_id: context.thread_id, session_id: context.session_id, turn_id: turn.id, cwd: context.cwd };
}

export function buildCodexTurnInterruptParams({ threadId, turnId } = {}) {
  validateThreadId(threadId, "E_CODEX_THREAD_HANDLE_INVALID");
  validateTurnId(turnId, "E_CODEX_TURN_HANDLE_INVALID");
  return { threadId, turnId };
}

export function parseCodexThreadStartResult({ result, request, observedAt } = {}) {
  requireCodexLaunchRequest(request);
  validateObservedAt(observedAt);
  const thread = validateThreadResult(result, request.runtime_root);
  if (result.cwd !== request.runtime_root || result.approvalPolicy !== "never" ||
      result.sandbox?.type !== "readOnly" || ![undefined, false].includes(result.sandbox?.networkAccess)) {
    fail("E_CODEX_THREAD_POLICY_MISMATCH", "Codex threadのcwdまたはread-only policyがrequestと一致しません");
  }
  requireObserverInstructionSource(result.instructionSources, request.runtime_root);
  return threadObservation(thread, observedAt);
}

export function parseCodexThreadResumeResult({ result, request, threadId, observedAt } = {}) {
  requireCodexLaunchRequest(request);
  validateThreadId(threadId, "E_CODEX_THREAD_HANDLE_INVALID");
  validateObservedAt(observedAt);
  const thread = validateThreadResult(result, request.runtime_root);
  if (thread.id !== threadId || result.cwd !== request.runtime_root || result.approvalPolicy !== "never" ||
      result.sandbox?.type !== "readOnly" || ![undefined, false].includes(result.sandbox?.networkAccess)) {
    fail("E_CODEX_THREAD_POLICY_MISMATCH", "Codex resume結果が保存済みthread policyと一致しません");
  }
  requireObserverInstructionSource(result.instructionSources, request.runtime_root);
  return threadObservation(thread, observedAt);
}

export function parseCodexTurnStartResult({ result, threadId, observedAt } = {}) {
  validateThreadId(threadId, "E_CODEX_THREAD_HANDLE_INVALID");
  validateObservedAt(observedAt);
  const turn = result?.turn;
  validateTurn(turn, "E_CODEX_TURN_START_RESULT_INVALID");
  if (turn.status !== "inProgress") fail("E_CODEX_TURN_NOT_RUNNING", "Codex turnはrunningとして開始されませんでした");
  return {
    schema: CODEX_TURN_OPERATION_SCHEMA,
    thread_id: threadId,
    turn_id: turn.id,
    status: turn.status,
    observed_at: observedAt,
  };
}

export function parseCodexThreadReadResult({ result, expectedThreadId, expectedCwd, observedAt } = {}) {
  validateThreadId(expectedThreadId, "E_CODEX_THREAD_HANDLE_INVALID");
  validateObservedAt(observedAt);
  const thread = result?.thread;
  if (!isPlainObject(thread) || thread.id !== expectedThreadId || thread.cwd !== expectedCwd || !Array.isArray(thread.turns)) {
    fail("E_CODEX_THREAD_READ_MISMATCH", "Codex thread/readが保存済みthreadと一致しません");
  }
  const turns = thread.turns.map((turn) => {
    validateTurn(turn, "E_CODEX_THREAD_READ_INVALID");
    return { turn_id: turn.id, status: turn.status };
  });
  if (new Set(turns.map((turn) => turn.turn_id)).size !== turns.length) {
    fail("E_CODEX_THREAD_READ_INVALID", "Codex thread/readに重複turnがあります");
  }
  return {
    schema: CODEX_THREAD_OBSERVATION_SCHEMA,
    thread_id: thread.id,
    cwd: thread.cwd,
    turns,
    observed_at: observedAt,
  };
}

export function planCodexTurnStop({ operation, observation, previousInterruptReceipt = null } = {}) {
  validateOperation(operation);
  validateThreadObservation(observation);
  if (operation.thread_id !== observation.thread_id) fail("E_CODEX_STOP_CORRELATION_FAILED", "stop対象threadが一致しません");
  const turn = observation.turns.find((entry) => entry.turn_id === operation.turn_id);
  if (!turn) fail("E_CODEX_TURN_NOT_FOUND", "保存済みCodex turnをthread/readで回収できません");
  if (TERMINAL_TURN_STATUSES.has(turn.status)) {
    return { action: "already_terminal", thread_id: operation.thread_id, turn_id: operation.turn_id, terminal_status: turn.status };
  }
  if (turn.status !== "inProgress") fail("E_CODEX_TURN_STATE_UNKNOWN", "Codex turn stateが未知です");
  if (previousInterruptReceipt !== null) {
    validateInterruptReceipt(previousInterruptReceipt, operation);
    return { action: "await_terminal_observation", thread_id: operation.thread_id, turn_id: operation.turn_id };
  }
  return {
    action: "issue_interrupt",
    method: "turn/interrupt",
    params: buildCodexTurnInterruptParams({ threadId: operation.thread_id, turnId: operation.turn_id }),
  };
}

export function recordCodexInterruptResult({ result, operation, observedAt } = {}) {
  validateOperation(operation);
  validateObservedAt(observedAt);
  if (!isPlainObject(result) || Object.keys(result).length !== 0) {
    fail("E_CODEX_INTERRUPT_RESULT_INVALID", "Codex interrupt ACKが空objectではありません");
  }
  return {
    schema: CODEX_INTERRUPT_RECEIPT_SCHEMA,
    thread_id: operation.thread_id,
    turn_id: operation.turn_id,
    outcome: "acknowledged",
    observed_at: observedAt,
  };
}

export function validateCodexStopRequest(request) {
  try {
    validateParentStopRequest(request);
  } catch {
    fail("E_CODEX_STOP_REQUEST_INVALID", "Codex parent stop requestが不正です");
  }
  if (request.provider !== "codex" || request.handle.kind !== "codex.thread") {
    fail("E_CODEX_STOP_REQUEST_INVALID", "Codex thread stop requestが必要です");
  }
  return request;
}

function validateThreadResult(result, runtimeRoot) {
  const thread = result?.thread;
  if (!isPlainObject(result) || !isPlainObject(thread) || thread.cwd !== runtimeRoot || thread.ephemeral !== false ||
      thread.modelProvider !== "openai" || !Array.isArray(thread.turns)) {
    fail("E_CODEX_THREAD_RESULT_INVALID", "Codex thread resultが不正です");
  }
  validateThreadId(thread.id, "E_CODEX_THREAD_RESULT_INVALID");
  return thread;
}

function threadObservation(thread, observedAt) {
  return {
    schema: CODEX_THREAD_OBSERVATION_SCHEMA,
    thread_id: thread.id,
    cwd: thread.cwd,
    turns: [],
    observed_at: observedAt,
  };
}

function requireObserverInstructionSource(value, runtimeRoot) {
  const expected = join(runtimeRoot, "AGENTS.md");
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string") || !value.includes(expected)) {
    fail("E_CODEX_INSTRUCTION_SOURCE_MISSING", "Observer AGENTS.mdがCodex threadへloadされていません");
  }
}

function requireCodexLaunchRequest(request) {
  try {
    validateParentLaunchRequest(request);
  } catch {
    fail("E_CODEX_HOST_REQUEST_INVALID", "Codex parent launch requestが不正です");
  }
  if (request.provider !== "codex" || request.host.kind !== "codex.app_server_thread.v1") {
    fail("E_CODEX_HOST_REQUEST_INVALID", "Codex app-server launch requestが必要です");
  }
}

function validateOperation(value) {
  if (!isPlainObject(value) || value.schema !== CODEX_TURN_OPERATION_SCHEMA ||
      !hasExactKeys(value, ["observed_at", "schema", "status", "thread_id", "turn_id"])) {
    fail("E_CODEX_TURN_OPERATION_INVALID", "Codex turn operationが不正です");
  }
  validateThreadId(value.thread_id, "E_CODEX_TURN_OPERATION_INVALID");
  validateTurnId(value.turn_id, "E_CODEX_TURN_OPERATION_INVALID");
  if (!TURN_STATUSES.has(value.status)) fail("E_CODEX_TURN_OPERATION_INVALID", "Codex turn operation statusが不正です");
  validateObservedAt(value.observed_at);
}

function validateThreadObservation(value) {
  if (!isPlainObject(value) || !hasExactKeys(value, ["cwd", "observed_at", "schema", "thread_id", "turns"]) ||
      value.schema !== CODEX_THREAD_OBSERVATION_SCHEMA || typeof value.cwd !== "string" || !Array.isArray(value.turns)) {
    fail("E_CODEX_THREAD_OBSERVATION_INVALID", "Codex thread observationが不正です");
  }
  validateThreadId(value.thread_id, "E_CODEX_THREAD_OBSERVATION_INVALID");
  for (const turn of value.turns) {
    if (!isPlainObject(turn) || !hasExactKeys(turn, ["status", "turn_id"]) || !UUID_V7_RE.test(turn.turn_id) || !TURN_STATUSES.has(turn.status)) {
      fail("E_CODEX_THREAD_OBSERVATION_INVALID", "Codex thread observationのturnが不正です");
    }
  }
  validateObservedAt(value.observed_at);
}

function validateInterruptReceipt(value, operation) {
  if (!isPlainObject(value) || !hasExactKeys(value, ["observed_at", "outcome", "schema", "thread_id", "turn_id"]) ||
      value.schema !== CODEX_INTERRUPT_RECEIPT_SCHEMA || value.thread_id !== operation.thread_id ||
      value.turn_id !== operation.turn_id || value.outcome !== "acknowledged") {
    fail("E_CODEX_INTERRUPT_RECEIPT_INVALID", "Codex interrupt receiptがoperationと一致しません");
  }
  validateObservedAt(value.observed_at);
}

function validateCycleThreadContext(value) {
  if (!isPlainObject(value) || !hasExactKeys(value, ["cwd", "session_id", "thread_id"]) ||
      typeof value.session_id !== "string" || value.session_id.length === 0 || typeof value.cwd !== "string" || value.cwd.length === 0) {
    fail("E_CODEX_CYCLE_REQUEST_INVALID", "Codex cycle thread contextが不正です");
  }
  validateThreadId(value.thread_id, "E_CODEX_CYCLE_REQUEST_INVALID");
}

function validateTurn(value, code) {
  if (!isPlainObject(value) || !UUID_V7_RE.test(value.id) || !TURN_STATUSES.has(value.status)) fail(code, "Codex turnが不正です");
}

function validateThreadId(value, code) {
  if (typeof value !== "string" || !UUID_V7_RE.test(value)) fail(code, "Codex thread IDが不正です");
}

function validateTurnId(value, code) {
  if (typeof value !== "string" || !UUID_V7_RE.test(value)) fail(code, "Codex turn IDが不正です");
}

function validateObservedAt(value) {
  if (typeof value !== "string") fail("E_CODEX_OBSERVED_AT_INVALID", "observed_atが不正です");
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) fail("E_CODEX_OBSERVED_AT_INVALID", "observed_atが不正です");
}

function hasStrings(value, keys) {
  return keys.every((key) => typeof value[key] === "string" && value[key].length > 0);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function hasExactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}
