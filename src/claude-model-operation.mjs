import { createHash } from "node:crypto";
import { join } from "node:path";

import { validateClaudeSessionId } from "./aiterm-process-transport.mjs";
import { validateCycleInputReceipt } from "./cycle-input.mjs";
import { observerAiOutputDigest, parseObserverAiOutput } from "./observer-ai-contract.mjs";
import { fail } from "./observer-error.mjs";
import {
  acquirePrivateLock,
  assertPrivateDirectory,
  atomicCreatePrivateFile,
  atomicReplacePrivateFile,
  ensurePrivateDirectory,
  readPrivateJson,
  removePrivateFile,
} from "./private-state.mjs";
import { readModelOperation } from "./model-operation-store.mjs";

export const CLAUDE_MODEL_OPERATION_SCHEMA = "observer.claude_model_operation.v1";
export const MODEL_OPERATION_CALLBACK_SCHEMA = "observer.model_operation_callback.v1";
export const MODEL_OPERATION_CLEANUP_SCHEMA = "observer.model_operation_cleanup.v1";

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const TARGET = /^p_[a-f0-9]{64}$/;
const AITERM_RESULT_SCHEMA = "aiterm.claude-operation-result.v1";
const MAX_RAW_OUTPUT_BYTES = 16_384;

export async function issueClaudeModelOperation({ stateRoot, operation, value, runtime } = {}, dependencies = {}) {
  validateIssueOperation(operation);
  const sessionId = validateRuntime(runtime);
  validateCycleInputReceipt({
    value,
    inputDigest: operation.input_digest,
    modelVisibleBytes: operation.model_visible_bytes,
  });
  const callTool = requireCallTool(dependencies);
  const result = validateAitermResult(await callTool("claude_turn", {
    action: "issue",
    session_id: sessionId,
    operation_id: operation.operation_id,
    text: value,
  }), { action: "issue", operationId: operation.operation_id, sessionId });
  return applyAitermResult({ stateRoot, operation, sessionId, result, dependencies });
}

export async function recoverClaudeModelOperation({ stateRoot, operation, runtime } = {}, dependencies = {}) {
  validateRecoveryOperation(operation);
  const sessionId = validateRuntime(runtime);
  const callTool = requireCallTool(dependencies);
  const result = validateAitermResult(await callTool("claude_turn", {
    action: "recover",
    session_id: sessionId,
    operation_id: operation.operation_id,
  }), { action: "recover", operationId: operation.operation_id, sessionId });
  return applyAitermResult({ stateRoot, operation, sessionId, result, dependencies });
}

export async function cleanupClaudeModelOperation({ stateRoot, operation, cleanupEvidence = null } = {}, dependencies = {}) {
  validateOperation(operation);
  const paths = await pathsFor(stateRoot, operation.target_id, operation.operation_id);
  const release = await acquirePrivateLock(paths.lock);
  try {
    let current;
    try {
      current = validateJournal(await readPrivateJson(paths.file));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const generic = await (dependencies.readModelOperation ?? readModelOperation)({ stateRoot, targetId: operation.target_id });
      if (generic?.status === "completed" && generic.operation_id === operation.operation_id &&
          cleanupEvidence?.provider_operation_receipt_digest === generic.provider_operation_receipt_digest &&
          cleanupEvidence?.completed_output_digest === generic.completed_output_digest) return cleanupResult();
      fail("E_CLAUDE_CLEANUP_FORBIDDEN", "pre-complete Claude provider journal欠損をcleanupできません");
    }
    requireIdentity(current, operation);
    if (current.status !== "completed") fail("E_CLAUDE_CLEANUP_FORBIDDEN", "completed Claude provider operationだけをcleanupできます");
    const generic = await (dependencies.readModelOperation ?? readModelOperation)({ stateRoot, targetId: operation.target_id });
    if (generic?.status !== "completed" || generic.operation_id !== operation.operation_id ||
        generic.provider_operation_receipt_digest !== current.receipt_digest ||
        generic.completed_output_digest !== current.output_digest) {
      fail("E_CLAUDE_CLEANUP_FORBIDDEN", "generic completed operationがClaude journalと一致しません");
    }
    await removePrivateFile(paths.file);
    return cleanupResult();
  } finally {
    await release();
  }
}

async function applyAitermResult({ stateRoot, operation, sessionId, result, dependencies }) {
  const existing = await readExistingJournal({ stateRoot, operation, sessionId });
  if (existing?.status === "completed" && result.status !== "completed") {
    fail("E_CLAUDE_RESULT_MISMATCH", "completed Claude operationの状態が後退しました");
  }
  if (existing !== null && result.status === "unknown" && result.reason === "operation_not_found") {
    fail("E_CLAUDE_RESULT_MISMATCH", "保存済みClaude dispatch receiptがAitermから消失しました");
  }
  if (result.status === "unknown") {
    if (result.reason === "result_unknown") {
      await ensureAcceptedJournal({ stateRoot, operation, sessionId, dependencies });
      return unknown("provider_result_unknown");
    }
    return unknown("provider_operation_missing");
  }
  if (result.status === "accepted") {
    const journal = await ensureAcceptedJournal({ stateRoot, operation, sessionId, dependencies });
    return accepted(journal.receipt_digest);
  }
  if (result.status === "pending") {
    const journal = await ensureAcceptedJournal({ stateRoot, operation, sessionId, dependencies });
    return operation.status === "dispatching" ? accepted(journal.receipt_digest) : pending();
  }
  const journal = await recordCompletedJournal({
    stateRoot,
    operation,
    sessionId,
    rawOutput: result.raw_output,
    dependencies,
  });
  return completed(journal.receipt_digest, result.raw_output);
}

async function readExistingJournal({ stateRoot, operation, sessionId }) {
  const paths = await pathsFor(stateRoot, operation.target_id, operation.operation_id);
  const release = await acquirePrivateLock(paths.lock);
  try {
    let current;
    try {
      current = validateJournal(await readPrivateJson(paths.file));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
    requireIdentity(current, operation, sessionId);
    return current;
  } finally {
    await release();
  }
}

async function ensureAcceptedJournal({ stateRoot, operation, sessionId, dependencies }) {
  const paths = await pathsFor(stateRoot, operation.target_id, operation.operation_id);
  const release = await acquirePrivateLock(paths.lock);
  try {
    const timestamp = currentTimestamp(dependencies.now);
    const next = validateJournal({
      schema: CLAUDE_MODEL_OPERATION_SCHEMA,
      provider: "claude",
      operation_id: operation.operation_id,
      target_id: operation.target_id,
      generation_id: operation.generation_id,
      session_id: sessionId,
      receipt_digest: receiptDigest(operation, sessionId),
      status: "accepted",
      output_digest: null,
      created_at: timestamp,
      updated_at: timestamp,
    });
    try {
      await atomicCreatePrivateFile(paths.file, serialize(next));
      return next;
    } catch (error) {
      if (error?.code !== "E_ALREADY_EXISTS") throw error;
      const current = validateJournal(await readPrivateJson(paths.file));
      requireIdentity(current, operation, sessionId);
      return current;
    }
  } finally {
    await release();
  }
}

async function recordCompletedJournal({ stateRoot, operation, sessionId, rawOutput, dependencies }) {
  if (typeof rawOutput !== "string" || Buffer.byteLength(rawOutput, "utf8") > MAX_RAW_OUTPUT_BYTES) {
    fail("E_CLAUDE_RESULT_INVALID", "Claude exact resultが不正または上限超過です");
  }
  const outputDigest = `sha256:${observerAiOutputDigest(parseObserverAiOutput(rawOutput))}`;
  const acceptedJournal = await ensureAcceptedJournal({ stateRoot, operation, sessionId, dependencies });
  const paths = await pathsFor(stateRoot, operation.target_id, operation.operation_id);
  const release = await acquirePrivateLock(paths.lock);
  try {
    const current = validateJournal(await readPrivateJson(paths.file));
    requireIdentity(current, operation, sessionId);
    if (current.status === "completed") {
      if (current.output_digest !== outputDigest) fail("E_CLAUDE_RESULT_MISMATCH", "Claude completed resultが変化しました");
      return current;
    }
    if (current.receipt_digest !== acceptedJournal.receipt_digest) {
      fail("E_CLAUDE_PROVIDER_CONFLICT", "Claude provider receiptが変化しました");
    }
    const next = validateJournal({
      ...current,
      status: "completed",
      output_digest: outputDigest,
      updated_at: currentTimestamp(dependencies.now),
    });
    await atomicReplacePrivateFile(paths.file, serialize(next));
    return next;
  } finally {
    await release();
  }
}

function validateAitermResult(value, { action, operationId, sessionId }) {
  const keys = "action,operation_id,raw_output,reason,schema,session_id,status";
  if (!isPlainObject(value) || Object.keys(value).sort().join(",") !== keys ||
      value.schema !== AITERM_RESULT_SCHEMA || value.action !== action ||
      value.operation_id !== operationId || value.session_id !== sessionId ||
      !["accepted", "pending", "completed", "unknown"].includes(value.status)) {
    fail("E_CLAUDE_AITERM_RESULT_MISMATCH", "Aiterm Claude operation resultが一致しません");
  }
  if ((action === "issue" && value.status === "pending") || (action === "recover" && value.status === "accepted")) {
    fail("E_CLAUDE_AITERM_RESULT_MISMATCH", "Aiterm Claude operation statusがactionと一致しません");
  }
  if (value.status === "completed") {
    if (typeof value.raw_output !== "string" || value.reason !== null) {
      fail("E_CLAUDE_AITERM_RESULT_MISMATCH", "Aiterm completed resultが不正です");
    }
  } else if (value.status === "unknown") {
    if (value.raw_output !== null || !["operation_not_found", "result_unknown"].includes(value.reason)) {
      fail("E_CLAUDE_AITERM_RESULT_MISMATCH", "Aiterm unknown resultが不正です");
    }
  } else if (value.raw_output !== null || value.reason !== null) {
    fail("E_CLAUDE_AITERM_RESULT_MISMATCH", "Aiterm pre-complete resultが不正です");
  }
  return value;
}

function requireCallTool(dependencies) {
  if (typeof dependencies.callTool !== "function") fail("E_CLAUDE_PROVIDER_INPUT", "Claude operationにはAiterm callToolが必要です");
  return dependencies.callTool;
}

async function pathsFor(stateRoot, targetId, operationId) {
  if (!TARGET.test(targetId) || !DIGEST.test(operationId)) fail("E_CLAUDE_PROVIDER_INPUT", "Claude operation identityが不正です");
  await assertPrivateDirectory(stateRoot);
  const watches = join(stateRoot, "watches");
  const target = join(watches, targetId);
  await assertPrivateDirectory(watches);
  await assertPrivateDirectory(target);
  const root = join(target, "provider-operations");
  await ensurePrivateDirectory(root);
  return {
    file: join(root, `claude-${operationId.slice(7)}.json`),
    lock: join(root, `claude-${operationId.slice(7)}.lock`),
  };
}

function receiptDigest(operation, sessionId) {
  return `sha256:${createHash("sha256").update([
    CLAUDE_MODEL_OPERATION_SCHEMA,
    operation.operation_id,
    operation.generation_id,
    sessionId,
  ].join("\0"), "utf8").digest("hex")}`;
}

function validateOperation(value) {
  if (!isPlainObject(value) || !DIGEST.test(value.operation_id) || !TARGET.test(value.target_id) ||
      !DIGEST.test(value.generation_id)) fail("E_CLAUDE_PROVIDER_INPUT", "Claude operationが不正です");
}

function validateIssueOperation(value) {
  validateOperation(value);
  if (value.provider !== "claude" || value.action !== "issue_once" || value.status !== "dispatching" ||
      !DIGEST.test(value.input_digest) || !Number.isSafeInteger(value.model_visible_bytes) || value.model_visible_bytes < 0) {
    fail("E_CLAUDE_PROVIDER_INPUT", "Claude issue operationが不正です");
  }
}

function validateRecoveryOperation(value) {
  validateOperation(value);
  if (value.provider !== "claude" || value.action !== "recover_only" ||
      !new Set(["dispatching", "accepted"]).has(value.status)) {
    fail("E_CLAUDE_PROVIDER_INPUT", "Claude recovery operationが不正です");
  }
}

function validateRuntime(value) {
  if (!isPlainObject(value) || Object.keys(value).sort().join(",") !== "session_id") {
    fail("E_CLAUDE_PROVIDER_INPUT", "Claude generation runtimeが不正です");
  }
  return validateClaudeSessionId(value.session_id);
}

function validateJournal(value) {
  const keys = "created_at,generation_id,operation_id,output_digest,provider,receipt_digest,schema,session_id,status,target_id,updated_at";
  if (!isPlainObject(value) || Object.keys(value).sort().join(",") !== keys ||
      value.schema !== CLAUDE_MODEL_OPERATION_SCHEMA || value.provider !== "claude" ||
      !DIGEST.test(value.operation_id) || !TARGET.test(value.target_id) || !DIGEST.test(value.generation_id) ||
      !DIGEST.test(value.receipt_digest) || !["accepted", "completed"].includes(value.status) ||
      !timestamp(value.created_at) || !timestamp(value.updated_at) || Date.parse(value.updated_at) < Date.parse(value.created_at)) {
    fail("E_CLAUDE_PROVIDER_STATE", "Claude provider journalが不正です");
  }
  validateClaudeSessionId(value.session_id);
  if ((value.status === "completed") !== DIGEST.test(value.output_digest) ||
      (value.status === "accepted" && value.output_digest !== null)) {
    fail("E_CLAUDE_PROVIDER_STATE", "Claude provider result locatorが不正です");
  }
  return value;
}

function requireIdentity(journal, operation, sessionId = journal.session_id) {
  if (journal.operation_id !== operation.operation_id || journal.target_id !== operation.target_id ||
      journal.generation_id !== operation.generation_id || journal.session_id !== sessionId ||
      journal.receipt_digest !== receiptDigest(operation, sessionId)) {
    fail("E_CLAUDE_PROVIDER_CONFLICT", "Claude operation identityが一致しません");
  }
}

function accepted(receipt) {
  return { schema: MODEL_OPERATION_CALLBACK_SCHEMA, outcome: "accepted", provider_operation_receipt_digest: receipt };
}
function pending() { return { schema: MODEL_OPERATION_CALLBACK_SCHEMA, outcome: "pending" }; }
function completed(receipt, rawOutput) {
  return { schema: MODEL_OPERATION_CALLBACK_SCHEMA, outcome: "completed", provider_operation_receipt_digest: receipt, raw_output: rawOutput };
}
function unknown(reason) { return { schema: MODEL_OPERATION_CALLBACK_SCHEMA, outcome: "unknown", reason }; }
function cleanupResult() { return { schema: MODEL_OPERATION_CLEANUP_SCHEMA, outcome: "cleaned" }; }
function serialize(value) { return `${JSON.stringify(value)}\n`; }

function currentTimestamp(now) {
  const value = (now ?? (() => new Date()))();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) fail("E_CLAUDE_PROVIDER_CLOCK", "Claude provider clockが不正です");
  return value.toISOString();
}

function timestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
