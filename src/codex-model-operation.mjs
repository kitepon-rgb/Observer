import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";

import {
  buildCodexCycleTurnStartParams,
  buildCodexThreadReadParams,
  parseCodexCycleThreadContext,
  parseCodexCycleTurnStartResult,
} from "./codex-host-adapter.mjs";
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

export const CODEX_MODEL_OPERATION_SCHEMA = "observer.codex_model_operation.v2";
export const MODEL_OPERATION_CALLBACK_SCHEMA = "observer.model_operation_callback.v1";
export const MODEL_OPERATION_CLEANUP_SCHEMA = "observer.model_operation_cleanup.v1";

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const TARGET = /^p_[a-f0-9]{64}$/;
const TERMINAL_FAILURES = new Set(["failed", "interrupted"]);

export async function issueCodexModelOperation({ stateRoot, operation, value, runtime } = {}, dependencies = {}) {
  validateIssueOperation(operation);
  validateRuntime(runtime);
  if (typeof dependencies.threadRead !== "function" || typeof dependencies.turnStart !== "function") {
    fail("E_CODEX_PROVIDER_INPUT", "Codex issueにはthreadReadとturnStartが必要です");
  }
  const threadResult = await dependencies.threadRead(buildCodexThreadReadParams(runtime.thread_id));
  const context = parseCodexCycleThreadContext({
    result: threadResult,
    expectedThreadId: runtime.thread_id,
    expectedCwd: runtime.cwd,
  });
  const params = buildCodexCycleTurnStartParams({ operation, value, context });
  const result = await dependencies.turnStart(params);
  const handle = parseCodexCycleTurnStartResult({ result, context });
  return acceptCodexModelOperation({ stateRoot, operation, handle });
}

export async function acceptCodexModelOperation({ stateRoot, operation, handle }) {
  validateOperation(operation);
  validateHandle(handle);
  const paths = await pathsFor(stateRoot, operation.target_id, operation.operation_id);
  const release = await acquirePrivateLock(paths.lock);
  try {
    const receipt = receiptDigest(operation, handle);
    const now = new Date().toISOString();
    const next = validateJournal({
      schema: CODEX_MODEL_OPERATION_SCHEMA,
      provider: "codex",
      operation_id: operation.operation_id,
      target_id: operation.target_id,
      generation_id: operation.generation_id,
      receipt_digest: receipt,
      handle,
      status: "accepted",
      item_id: null,
      output_digest: null,
      created_at: now,
      updated_at: now,
    });
    try {
      await atomicCreatePrivateFile(paths.file, serialize(next));
    } catch (error) {
      if (error?.code !== "E_ALREADY_EXISTS") throw error;
      const existing = validateJournal(await readPrivateJson(paths.file));
      if (!sameAccepted(existing, next)) fail("E_CODEX_PROVIDER_CONFLICT", "既存Codex operationが一致しません");
    }
    return accepted(receipt);
  } finally {
    await release();
  }
}

export async function recoverCodexModelOperation({ stateRoot, operation, threadRead } = {}) {
  validateRecoveryOperation(operation);
  if (typeof threadRead !== "function") fail("E_CODEX_PROVIDER_INPUT", "threadReadが必要です");
  const paths = await pathsFor(stateRoot, operation.target_id, operation.operation_id);
  const release = await acquirePrivateLock(paths.lock);
  try {
    let current;
    try {
      current = validateJournal(await readPrivateJson(paths.file));
    } catch (error) {
      if (error?.code === "ENOENT") return unknown("provider_operation_missing");
      throw error;
    }
    requireIdentity(current, operation);
    if (operation.status === "dispatching") return accepted(current.receipt_digest);

    const result = await threadRead({ threadId: current.handle.thread_id, includeTurns: true });
    const turn = matchingTurn(result, current);
    if (current.status === "completed" && turn.status !== "completed") {
      fail("E_CODEX_RESULT_MISMATCH", "completed Codex cycle turnの状態が後退しました");
    }
    if (turn.status === "inProgress") return pending();
    if (TERMINAL_FAILURES.has(turn.status)) return unknown("provider_result_unknown");
    if (turn.status !== "completed") fail("E_CODEX_RESULT_MISMATCH", "Codex cycle turn statusが不正です");

    const item = current.status === "completed" ? readStoredItem(turn.items, current) : selectItem(turn.items);
    const raw = item.text;
    const digest = `sha256:${observerAiOutputDigest(parseObserverAiOutput(raw))}`;
    if (current.status === "completed") {
      if (current.item_id !== item.id || current.output_digest !== digest) {
        fail("E_CODEX_RESULT_MISMATCH", "Codex completed resultが変化しました");
      }
      return completed(current.receipt_digest, raw);
    }
    const next = validateJournal({
      ...current,
      status: "completed",
      item_id: item.id,
      output_digest: digest,
      updated_at: new Date().toISOString(),
    });
    await atomicReplacePrivateFile(paths.file, serialize(next));
    return completed(next.receipt_digest, raw);
  } finally {
    await release();
  }
}

export async function cleanupCodexModelOperation({ stateRoot, operation, cleanupEvidence = null }, dependencies = {}) {
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
      fail("E_CODEX_CLEANUP_FORBIDDEN", "pre-complete provider journal欠損をcleanupできません");
    }
    requireIdentity(current, operation);
    if (current.status !== "completed") fail("E_CODEX_CLEANUP_FORBIDDEN", "completed provider operationだけをcleanupできます");
    const generic = await (dependencies.readModelOperation ?? readModelOperation)({ stateRoot, targetId: operation.target_id });
    if (generic?.status !== "completed" || generic.operation_id !== operation.operation_id ||
        generic.provider_operation_receipt_digest !== current.receipt_digest ||
        generic.completed_output_digest !== current.output_digest) {
      fail("E_CODEX_CLEANUP_FORBIDDEN", "generic completed operationが一致しません");
    }
    await removePrivateFile(paths.file);
    return cleanupResult();
  } finally {
    await release();
  }
}

function accepted(receipt) { return { schema: MODEL_OPERATION_CALLBACK_SCHEMA, outcome: "accepted", provider_operation_receipt_digest: receipt }; }
function pending() { return { schema: MODEL_OPERATION_CALLBACK_SCHEMA, outcome: "pending" }; }
function completed(receipt, raw) { return { schema: MODEL_OPERATION_CALLBACK_SCHEMA, outcome: "completed", provider_operation_receipt_digest: receipt, raw_output: raw }; }
function unknown(reason) { return { schema: MODEL_OPERATION_CALLBACK_SCHEMA, outcome: "unknown", reason }; }
function cleanupResult() { return { schema: MODEL_OPERATION_CLEANUP_SCHEMA, outcome: "cleaned" }; }
function serialize(value) { return `${JSON.stringify(value)}\n`; }

async function pathsFor(stateRoot, targetId, operationId) {
  if (!TARGET.test(targetId) || !DIGEST.test(operationId)) fail("E_CODEX_PROVIDER_INPUT", "Codex operation identityが不正です");
  await assertPrivateDirectory(stateRoot);
  const watches = join(stateRoot, "watches");
  const target = join(watches, targetId);
  await assertPrivateDirectory(watches);
  await assertPrivateDirectory(target);
  const root = join(target, "provider-operations");
  await ensurePrivateDirectory(root);
  return { file: join(root, `codex-${operationId.slice(7)}.json`), lock: join(root, `codex-${operationId.slice(7)}.lock`) };
}

function receiptDigest(operation, handle) {
  return `sha256:${createHash("sha256").update([
    CODEX_MODEL_OPERATION_SCHEMA,
    operation.operation_id,
    operation.generation_id,
    handle.thread_id,
    handle.session_id,
    handle.turn_id,
    handle.cwd,
  ].join("\0"), "utf8").digest("hex")}`;
}

function validateOperation(value) {
  if (!value || typeof value !== "object" || !DIGEST.test(value.operation_id) ||
      !TARGET.test(value.target_id) || !DIGEST.test(value.generation_id)) {
    fail("E_CODEX_PROVIDER_INPUT", "operationが不正です");
  }
}

function validateIssueOperation(value) {
  validateOperation(value);
  if (value.provider !== "codex" || value.action !== "issue_once" || value.status !== "dispatching" ||
      !DIGEST.test(value.input_digest) || !Number.isSafeInteger(value.model_visible_bytes) || value.model_visible_bytes < 0) {
    fail("E_CODEX_PROVIDER_INPUT", "Codex issue operationが不正です");
  }
}

function validateRecoveryOperation(value) {
  validateOperation(value);
  if (!new Set(["dispatching", "accepted"]).has(value.status)) fail("E_CODEX_PROVIDER_INPUT", "Codex recovery statusが不正です");
}

function validateRuntime(value) {
  if (!value || typeof value !== "object" || Object.keys(value).sort().join(",") !== "cwd,thread_id" ||
      typeof value.thread_id !== "string" || typeof value.cwd !== "string" || !isAbsolute(value.cwd)) {
    fail("E_CODEX_PROVIDER_INPUT", "Codex generation runtimeが不正です");
  }
}

function validateHandle(value) {
  if (!value || typeof value !== "object" || Object.keys(value).sort().join(",") !== "cwd,session_id,thread_id,turn_id" ||
      [value.thread_id, value.session_id, value.turn_id].some((item) => typeof item !== "string" || item.length === 0) ||
      typeof value.cwd !== "string" || !isAbsolute(value.cwd)) {
    fail("E_CODEX_PROVIDER_INPUT", "Codex handleが不正です");
  }
}

function validateJournal(value) {
  const keys = "created_at,generation_id,handle,item_id,operation_id,output_digest,provider,receipt_digest,schema,status,target_id,updated_at";
  if (!value || typeof value !== "object" || Object.keys(value).sort().join(",") !== keys ||
      value.schema !== CODEX_MODEL_OPERATION_SCHEMA || value.provider !== "codex" ||
      !DIGEST.test(value.operation_id) || !TARGET.test(value.target_id) || !DIGEST.test(value.generation_id) ||
      !DIGEST.test(value.receipt_digest) || !new Set(["accepted", "completed"]).has(value.status) ||
      !timestamp(value.created_at) || !timestamp(value.updated_at) || Date.parse(value.updated_at) < Date.parse(value.created_at)) {
    fail("E_CODEX_PROVIDER_STATE", "Codex journalが不正です");
  }
  validateHandle(value.handle);
  const complete = value.status === "completed";
  if (complete !== (typeof value.item_id === "string" && value.item_id.length > 0 && DIGEST.test(value.output_digest))) {
    fail("E_CODEX_PROVIDER_STATE", "Codex result locatorが不正です");
  }
  if (!complete && (value.item_id !== null || value.output_digest !== null)) {
    fail("E_CODEX_PROVIDER_STATE", "Codex pre-complete resultが不正です");
  }
  return value;
}

function sameAccepted(left, right) {
  return left.operation_id === right.operation_id && left.target_id === right.target_id &&
    left.generation_id === right.generation_id && left.receipt_digest === right.receipt_digest &&
    JSON.stringify(left.handle) === JSON.stringify(right.handle);
}

function requireIdentity(journal, operation) {
  if (journal.operation_id !== operation.operation_id || journal.target_id !== operation.target_id ||
      journal.generation_id !== operation.generation_id) {
    fail("E_CODEX_PROVIDER_CONFLICT", "Codex operation identityが一致しません");
  }
}

function matchingTurn(result, journal) {
  const thread = result?.thread;
  if (!thread || thread.id !== journal.handle.thread_id || thread.sessionId !== journal.handle.session_id ||
      thread.cwd !== journal.handle.cwd || !Array.isArray(thread.turns)) {
    fail("E_CODEX_RESULT_MISMATCH", "Codex thread/readが一致しません");
  }
  const matches = thread.turns.filter((turn) => turn?.id === journal.handle.turn_id);
  if (matches.length !== 1 || !Array.isArray(matches[0].items)) fail("E_CODEX_RESULT_MISMATCH", "Codex cycle turnが一致しません");
  return matches[0];
}

function selectItem(items) {
  const candidates = items.filter((item) => item?.type === "agentMessage");
  if (candidates.some((item) => typeof item.id !== "string" || typeof item.text !== "string" ||
      (Object.hasOwn(item, "phase") && ![null, "final_answer", "commentary"].includes(item.phase)))) {
    fail("E_CODEX_RESULT_MISMATCH", "Codex item shapeが不正です");
  }
  const finals = candidates.filter((item) => item.phase === "final_answer");
  if (candidates.length === 1 && [undefined, null, "final_answer"].includes(candidates[0].phase)) return candidates[0];
  if (finals.length === 1 && candidates.every((item) => item === finals[0] || item.phase === "commentary")) return finals[0];
  fail("E_CODEX_RESULT_MISMATCH", "Codex result候補が一意ではありません");
}

function readStoredItem(items, journal) {
  const matches = items.filter((item) => item?.id === journal.item_id);
  if (matches.length !== 1 || matches[0].type !== "agentMessage" || typeof matches[0].text !== "string" ||
      (Object.hasOwn(matches[0], "phase") && ![null, "final_answer", "commentary"].includes(matches[0].phase))) {
    fail("E_CODEX_RESULT_MISMATCH", "保存済みCodex itemが一致しません");
  }
  return matches[0];
}

function timestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
