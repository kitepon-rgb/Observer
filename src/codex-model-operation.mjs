import { createHash } from "node:crypto";
import { join } from "node:path";
import { isAbsolute } from "node:path";

import { observerAiOutputDigest, parseObserverAiOutput } from "./observer-ai-contract.mjs";
import { fail } from "./observer-error.mjs";
import { acquirePrivateLock, assertPrivateDirectory, atomicCreatePrivateFile, atomicReplacePrivateFile, ensurePrivateDirectory, readPrivateJson, removePrivateFile } from "./private-state.mjs";
import { readModelOperation } from "./model-operation-store.mjs";

export const CODEX_MODEL_OPERATION_SCHEMA = "observer.codex_model_operation.v1";
export const MODEL_OPERATION_CALLBACK_SCHEMA = "observer.model_operation_callback.v1";
export const MODEL_OPERATION_CLEANUP_SCHEMA = "observer.model_operation_cleanup.v1";
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const TARGET = /^p_[a-f0-9]{64}$/;

export async function acceptCodexModelOperation({ stateRoot, operation, handle }) {
  validateOperation(operation); validateHandle(handle);
  const paths = await pathsFor(stateRoot, operation.target_id, operation.operation_id);
  const release = await acquirePrivateLock(paths.lock);
  try {
    const receipt = receiptDigest(operation, handle);
    const now = new Date().toISOString();
    const next = journal({ operation, handle, receipt, status: "accepted", stopSeal: null, itemId: null, outputDigest: null, createdAt: now, updatedAt: now });
    try { await atomicCreatePrivateFile(paths.file, `${JSON.stringify(next)}\n`); }
    catch (error) {
      if (error?.code !== "E_ALREADY_EXISTS") throw error;
      const existing = validateJournal(await readPrivateJson(paths.file));
      if (!sameAccepted(existing, next)) fail("E_CODEX_PROVIDER_CONFLICT", "既存Codex operationが一致しません");
    }
    return accepted(receipt);
  } finally { await release(); }
}

export async function sealCodexModelOperationStop({ stateRoot, operation, stop }) {
  validateOperation(operation); validateStop(stop);
  const paths = await pathsFor(stateRoot, operation.target_id, operation.operation_id);
  const release = await acquirePrivateLock(paths.lock);
  try {
    const current = validateJournal(await readPrivateJson(paths.file));
    requireIdentity(current, operation);
    if (current.handle.session_id !== stop.session_id || current.handle.turn_id !== stop.turn_id) fail("E_CODEX_STOP_HANDLE_MISMATCH", "Codex Stopが保存済みhandleと一致しません");
    const seal = { session_id: stop.session_id, turn_id: stop.turn_id };
    if (current.stop_seal !== null && JSON.stringify(current.stop_seal) !== JSON.stringify(seal)) fail("E_CODEX_STOP_HANDLE_MISMATCH", "Codex Stop sealが一致しません");
    if (current.stop_seal === null) await atomicReplacePrivateFile(paths.file, `${JSON.stringify(validateJournal({ ...current, status: "sealed", stop_seal: seal, updated_at: new Date().toISOString() }))}\n`);
    return { schema: MODEL_OPERATION_CALLBACK_SCHEMA, outcome: "pending" };
  } finally { await release(); }
}

export async function recoverCodexModelOperation({ stateRoot, operation, threadRead }) {
  validateOperation(operation); if (typeof threadRead !== "function") fail("E_CODEX_PROVIDER_INPUT", "threadReadが必要です");
  const paths = await pathsFor(stateRoot, operation.target_id, operation.operation_id);
  const release = await acquirePrivateLock(paths.lock);
  try {
    const current = validateJournal(await readPrivateJson(paths.file)); requireIdentity(current, operation);
    if (current.status === "accepted") return { schema: MODEL_OPERATION_CALLBACK_SCHEMA, outcome: "pending" };
    const result = await threadRead({ threadId: current.handle.thread_id, includeTurns: true });
    const item = current.status === "completed" ? readStoredItem(result, current) : selectItem(result, current);
    const raw = item.text;
    const digest = `sha256:${observerAiOutputDigest(parseObserverAiOutput(raw))}`;
    if (current.status === "completed") {
      if (current.item_id !== item.id || current.output_digest !== digest) fail("E_CODEX_RESULT_MISMATCH", "Codex completed resultが変化しました");
      return completed(current.receipt_digest, raw);
    }
    const next = validateJournal({ ...current, status: "completed", item_id: item.id, output_digest: digest, updated_at: new Date().toISOString() });
    await atomicReplacePrivateFile(paths.file, `${JSON.stringify(next)}\n`);
    return completed(next.receipt_digest, raw);
  } finally { await release(); }
}

export async function cleanupCodexModelOperation({ stateRoot, operation, cleanupEvidence = null }, dependencies = {}) {
  validateOperation(operation);
  const paths = await pathsFor(stateRoot, operation.target_id, operation.operation_id);
  const release = await acquirePrivateLock(paths.lock);
  try {
    let current;
    try { current = validateJournal(await readPrivateJson(paths.file)); } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const generic = await (dependencies.readModelOperation ?? readModelOperation)({ stateRoot, targetId: operation.target_id });
      if (generic?.status === "completed" && generic.operation_id === operation.operation_id && cleanupEvidence?.provider_operation_receipt_digest === generic.provider_operation_receipt_digest && cleanupEvidence?.completed_output_digest === generic.completed_output_digest) return cleanupResult();
      fail("E_CODEX_CLEANUP_FORBIDDEN", "pre-complete provider journal欠損をcleanupできません");
    }
    requireIdentity(current, operation);
    if (current.status !== "completed") fail("E_CODEX_CLEANUP_FORBIDDEN", "completed provider operationだけをcleanupできます");
    const generic = await (dependencies.readModelOperation ?? readModelOperation)({ stateRoot, targetId: operation.target_id });
    if (generic?.status !== "completed" || generic.operation_id !== operation.operation_id || generic.provider_operation_receipt_digest !== current.receipt_digest || generic.completed_output_digest !== current.output_digest) fail("E_CODEX_CLEANUP_FORBIDDEN", "generic completed operationが一致しません");
    await removePrivateFile(paths.file);
    return cleanupResult();
  } finally { await release(); }
}

function accepted(receipt) { return { schema: MODEL_OPERATION_CALLBACK_SCHEMA, outcome: "accepted", provider_operation_receipt_digest: receipt }; }
function completed(receipt, raw) { return { schema: MODEL_OPERATION_CALLBACK_SCHEMA, outcome: "completed", provider_operation_receipt_digest: receipt, raw_output: raw }; }
function cleanupResult() { return { schema: MODEL_OPERATION_CLEANUP_SCHEMA, outcome: "cleaned" }; }
async function pathsFor(stateRoot, targetId, operationId) { if (!TARGET.test(targetId) || !DIGEST.test(operationId)) fail("E_CODEX_PROVIDER_INPUT", "Codex operation identityが不正です"); await assertPrivateDirectory(stateRoot); const watches = join(stateRoot, "watches"); const target = join(watches, targetId); await assertPrivateDirectory(watches); await assertPrivateDirectory(target); const root = join(target, "provider-operations"); await ensurePrivateDirectory(root); return { file: join(root, `codex-${operationId.slice(7)}.json`), lock: join(root, `codex-${operationId.slice(7)}.lock`) }; }
function receiptDigest(operation, handle) { return `sha256:${createHash("sha256").update(["observer.codex_model_operation.v1", operation.operation_id, operation.generation_id, handle.thread_id, handle.session_id, handle.turn_id, handle.after_item_id ?? "", handle.cwd].join("\0"), "utf8").digest("hex")}`; }
function journal({ operation, handle, receipt, status, stopSeal, itemId, outputDigest, createdAt, updatedAt }) { return validateJournal({ schema: CODEX_MODEL_OPERATION_SCHEMA, provider: "codex", operation_id: operation.operation_id, target_id: operation.target_id, generation_id: operation.generation_id, receipt_digest: receipt, handle, status, stop_seal: stopSeal, item_id: itemId, output_digest: outputDigest, created_at: createdAt, updated_at: updatedAt }); }
function validateOperation(value) { if (!value || typeof value !== "object" || !DIGEST.test(value.operation_id) || !TARGET.test(value.target_id) || !DIGEST.test(value.generation_id)) fail("E_CODEX_PROVIDER_INPUT", "operationが不正です"); }
function validateHandle(value) { if (!value || typeof value !== "object" || Object.keys(value).sort().join(",") !== "after_item_id,cwd,session_id,thread_id,turn_id" || [value.thread_id, value.session_id, value.turn_id].some((v) => typeof v !== "string" || v.length === 0) || typeof value.cwd !== "string" || !isAbsolute(value.cwd) || (value.after_item_id !== null && (typeof value.after_item_id !== "string" || value.after_item_id.length === 0))) fail("E_CODEX_PROVIDER_INPUT", "Codex handleが不正です"); }
function validateStop(value) { if (!value || typeof value !== "object" || typeof value.session_id !== "string" || typeof value.turn_id !== "string") fail("E_CODEX_STOP_HANDLE_MISMATCH", "Codex Stopが不正です"); }
function validateJournal(value) { const keys = "created_at,generation_id,handle,item_id,operation_id,output_digest,provider,receipt_digest,schema,status,stop_seal,target_id,updated_at"; if (!value || typeof value !== "object" || Object.keys(value).sort().join(",") !== keys || value.schema !== CODEX_MODEL_OPERATION_SCHEMA || value.provider !== "codex" || !DIGEST.test(value.operation_id) || !TARGET.test(value.target_id) || !DIGEST.test(value.generation_id) || !DIGEST.test(value.receipt_digest) || !["accepted", "sealed", "completed"].includes(value.status) || !timestamp(value.created_at) || !timestamp(value.updated_at) || Date.parse(value.updated_at) < Date.parse(value.created_at)) fail("E_CODEX_PROVIDER_STATE", "Codex journalが不正です"); validateHandle(value.handle); if (value.stop_seal !== null) validateStop(value.stop_seal); const sealed = value.status !== "accepted"; if (sealed !== (value.stop_seal !== null)) fail("E_CODEX_PROVIDER_STATE", "Codex Stop seal状態が不正です"); const complete = value.status === "completed"; if (complete !== (typeof value.item_id === "string" && value.item_id.length > 0 && DIGEST.test(value.output_digest))) fail("E_CODEX_PROVIDER_STATE", "Codex result locatorが不正です"); if (!complete && (value.item_id !== null || value.output_digest !== null)) fail("E_CODEX_PROVIDER_STATE", "Codex pre-complete resultが不正です"); return value; }
function sameAccepted(left, right) { return left.operation_id === right.operation_id && left.target_id === right.target_id && left.generation_id === right.generation_id && left.receipt_digest === right.receipt_digest && JSON.stringify(left.handle) === JSON.stringify(right.handle); }
function requireIdentity(journal, operation) { if (journal.operation_id !== operation.operation_id || journal.target_id !== operation.target_id || journal.generation_id !== operation.generation_id) fail("E_CODEX_PROVIDER_CONFLICT", "Codex operation identityが一致しません"); }
function threadItems(result, journal) { const thread = result?.thread; if (!thread || thread.id !== journal.handle.thread_id || thread.sessionId !== journal.handle.session_id || thread.cwd !== journal.handle.cwd || !Array.isArray(thread.turns)) fail("E_CODEX_RESULT_MISMATCH", "Codex thread/readが一致しません"); const turn = thread.turns.filter((value) => value?.id === journal.handle.turn_id); if (turn.length !== 1 || !Array.isArray(turn[0].items)) fail("E_CODEX_RESULT_MISMATCH", "Codex turnが一致しません"); return turn[0].items; }
function selectItem(result, journal) { const items = threadItems(result, journal); let start = 0; if (journal.handle.after_item_id !== null) { start = items.findIndex((value) => value?.id === journal.handle.after_item_id); if (start < 0) fail("E_CODEX_RESULT_MISMATCH", "Codex baseline itemがありません"); start++; }
  const candidates = items.slice(start).filter((value) => value?.type === "agentMessage"); if (candidates.some((value) => typeof value.id !== "string" || typeof value.text !== "string" || (Object.hasOwn(value, "phase") && ![null, "final_answer", "commentary"].includes(value.phase)))) fail("E_CODEX_RESULT_MISMATCH", "Codex item shapeが不正です"); const finals = candidates.filter((value) => value.phase === "final_answer"); if (candidates.length === 1 && (candidates[0].phase === null || candidates[0].phase === undefined || candidates[0].phase === "final_answer")) return candidates[0]; if (finals.length === 1 && candidates.every((value) => value === finals[0] || value.phase === "commentary")) return finals[0]; fail("E_CODEX_RESULT_MISMATCH", "Codex result候補が一意ではありません"); }
function readStoredItem(result, journal) { const item = threadItems(result, journal).filter((value) => value?.id === journal.item_id); if (item.length !== 1 || item[0].type !== "agentMessage" || typeof item[0].text !== "string" || (Object.hasOwn(item[0], "phase") && ![null, "final_answer", "commentary"].includes(item[0].phase))) fail("E_CODEX_RESULT_MISMATCH", "保存済みCodex itemが一致しません"); return item[0]; }
function timestamp(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
