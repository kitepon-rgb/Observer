import { createHash } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";

import { observerAiOutputDigest, parseObserverAiOutput } from "./observer-ai-contract.mjs";
import { fail, ObserverError } from "./observer-error.mjs";
import { acquirePrivateLock, assertPrivateDirectory, assertWithin, atomicCreatePrivateFile, atomicReplacePrivateFile, readPrivateJson, removePrivateFile } from "./private-state.mjs";
import { readModelOperation } from "./model-operation-store.mjs";

export const CLAUDE_MODEL_OPERATION_SCHEMA = "observer.claude_model_operation.v1";
export const MODEL_OPERATION_CALLBACK_SCHEMA = "observer.model_operation_callback.v1";
export const MODEL_OPERATION_CLEANUP_SCHEMA = "observer.model_operation_cleanup.v1";
const KEYS = ["canonical_output", "canonical_output_digest", "created_at", "cwd", "generation_id", "job_id", "name", "operation_id", "provider", "receipt_digest", "schema", "session_id", "status", "target_id", "updated_at"];
const TARGET = /^p_[a-f0-9]{64}$/; const DIGEST = /^sha256:[a-f0-9]{64}$/;

export async function acceptClaudeModelOperation({ stateRoot, targetId, operationId, generationId, expected, agentsStdout } = {}, dependencies = {}) {
  validateInput({ stateRoot, targetId, operationId, generationId, expected });
  const agents = parseAgents(agentsStdout);
  const matches = agents.filter((entry) => entry.id === expected.job_id && entry.sessionId === expected.session_id && entry.cwd === expected.cwd && entry.name === expected.name && entry.kind === "background" && ["working", "blocked"].includes(entry.state));
  if (matches.length !== 1) return callback("unknown", { reason: "provider_operation_missing" });
  return transaction(stateRoot, targetId, dependencies, async ({ journalPath }) => {
    const receiptDigest = digestReceipt(operationId, generationId, expected.job_id, expected.session_id);
    const existing = await read(journalPath);
    if (existing === null) {
      const state = validate({ schema: CLAUDE_MODEL_OPERATION_SCHEMA, provider: "claude", target_id: targetId, operation_id: operationId, generation_id: generationId, job_id: expected.job_id, session_id: expected.session_id, cwd: expected.cwd, name: expected.name, receipt_digest: receiptDigest, status: "accepted", canonical_output: null, canonical_output_digest: null, created_at: now(dependencies), updated_at: now(dependencies) });
      await atomicCreatePrivateFile(journalPath, serialize(state));
      return callback("accepted", { receiptDigest });
    }
    sameIdentity(existing, { targetId, operationId, generationId, expected, receiptDigest });
    return existing.status === "completed"
      ? callback("completed", { receiptDigest: existing.receipt_digest, rawOutput: canonicalRaw(existing) })
      : callback("accepted", { receiptDigest: existing.receipt_digest });
  });
}

export async function captureClaudeModelOperationStop({ stateRoot, targetId, operationId, payload } = {}, dependencies = {}) {
  return transaction(stateRoot, targetId, dependencies, async ({ journalPath }) => {
    const state = await requireState(journalPath); requireOperation(state, operationId);
    if (!payload || payload.hook_event_name !== "Stop" || payload.session_id !== state.session_id || payload.cwd !== state.cwd) return callback("unknown", { reason: "provider_result_unknown" });
    if (typeof payload.last_assistant_message !== "string") return callback("unknown", { reason: "provider_result_unknown" });
    let output;
    try { output = parseObserverAiOutput(payload.last_assistant_message); } catch { return callback("unknown", { reason: "provider_result_unknown" }); }
    const outputDigest = `sha256:${observerAiOutputDigest(output)}`;
    if (state.status === "completed") {
      if (state.canonical_output_digest !== outputDigest) fail("E_CLAUDE_OPERATION_OUTPUT_CONFLICT", "Stop outputが既存canonical outputと一致しません");
      return callback("completed", { receiptDigest: state.receipt_digest, rawOutput: canonicalRaw(state) });
    }
    const next = validate({ ...state, status: "completed", canonical_output: output, canonical_output_digest: outputDigest, updated_at: nextTime(state, dependencies) });
    await atomicReplacePrivateFile(journalPath, serialize(next));
    return callback("completed", { receiptDigest: next.receipt_digest, rawOutput: canonicalRaw(next) });
  });
}

export async function recoverClaudeModelOperation({ stateRoot, targetId, operationId } = {}, dependencies = {}) {
  try {
    return await transaction(stateRoot, targetId, dependencies, async ({ journalPath }) => {
      const state = await requireState(journalPath); requireOperation(state, operationId);
      if (state.status === "accepted") return callback("accepted", { receiptDigest: state.receipt_digest });
      const output = parseObserverAiOutput(JSON.stringify(state.canonical_output));
      const digest = `sha256:${observerAiOutputDigest(output)}`;
      if (digest !== state.canonical_output_digest) fail("E_CLAUDE_OPERATION_OUTPUT_CONFLICT", "canonical output digestが一致しません");
      return callback("completed", { receiptDigest: state.receipt_digest, rawOutput: canonicalRaw(state) });
    });
  } catch (error) {
    if (error instanceof ObserverError && error.code === "E_CLAUDE_OPERATION_NOT_FOUND") {
      return callback("unknown", { reason: "provider_operation_missing" });
    }
    throw error;
  }
}

export async function cleanupClaudeModelOperation({ stateRoot, targetId, operationId, cleanupEvidence = null } = {}, dependencies = {}) {
  return transaction(stateRoot, targetId, dependencies, async ({ journalPath }) => {
    const state = await read(journalPath);
    if (state === null) {
      const generic = await (dependencies.readModelOperation ?? readModelOperation)({ stateRoot, targetId });
      if (generic?.status === "completed" && generic.operation_id === operationId && generic.provider === "claude" && cleanupEvidence?.provider_operation_receipt_digest === generic.provider_operation_receipt_digest && cleanupEvidence?.completed_output_digest === generic.completed_output_digest) return cleanupResult();
      fail("E_CLAUDE_OPERATION_CLEANUP_FORBIDDEN", "generic completed証拠なしに欠損journalをcleanup成功にできません");
    }
    requireOperation(state, operationId);
    if (state.status !== "completed") fail("E_CLAUDE_OPERATION_CLEANUP_FORBIDDEN", "completed provider operationだけをcleanupできます");
    const generic = await (dependencies.readModelOperation ?? readModelOperation)({ stateRoot, targetId });
    if (generic === null || generic.status !== "completed" || generic.operation_id !== state.operation_id || generic.provider_operation_receipt_digest !== state.receipt_digest || generic.completed_output_digest !== state.canonical_output_digest) fail("E_CLAUDE_OPERATION_CLEANUP_FORBIDDEN", "generic completed operationがprovider journalと一致しません");
    await removePrivateFile(journalPath);
    return cleanupResult();
  });
}

function callback(outcome, { receiptDigest, rawOutput, reason } = {}) { if (outcome === "accepted") return { schema: MODEL_OPERATION_CALLBACK_SCHEMA, outcome, provider_operation_receipt_digest: receiptDigest }; if (outcome === "pending") return { schema: MODEL_OPERATION_CALLBACK_SCHEMA, outcome }; if (outcome === "completed") return { schema: MODEL_OPERATION_CALLBACK_SCHEMA, outcome, provider_operation_receipt_digest: receiptDigest, raw_output: rawOutput }; return { schema: MODEL_OPERATION_CALLBACK_SCHEMA, outcome: "unknown", reason }; }
function cleanupResult() { return { schema: MODEL_OPERATION_CLEANUP_SCHEMA, outcome: "cleaned" }; }
function parseAgents(stdout) { try { const value = JSON.parse(stdout); if (!Array.isArray(value) || value.some((entry) => !plainAgent(entry))) throw new Error(); return value; } catch { fail("E_CLAUDE_OPERATION_AGENTS_INVALID", "agents JSONが不正です"); } }
async function paths(stateRoot, targetId) { if (!isAbsolute(stateRoot) || !TARGET.test(targetId)) fail("E_CLAUDE_OPERATION_IDENTITY_INVALID", "state rootまたはtarget IDが不正です"); const root = resolve(stateRoot); const directory = assertWithin(root, join(root, "watches", targetId)); try { await assertPrivateDirectory(root); await assertPrivateDirectory(assertWithin(root, join(root, "watches"))); await assertPrivateDirectory(directory); } catch (error) { if (error instanceof ObserverError && error.code === "E_STATE_DIRECTORY_MISSING") return null; throw error; } const providers = join(directory, "provider-operations"); return { providers, journalPath: join(providers, "claude-model-operation.json"), lockPath: join(providers, "claude-model-operation.lock") }; }
async function transaction(stateRoot, targetId, dependencies, operation) { const p = await paths(stateRoot, targetId); if (p === null) fail("E_CLAUDE_OPERATION_NOT_FOUND", "target stateがありません"); try { await assertPrivateDirectory(p.providers); } catch (error) { if (error instanceof ObserverError && error.code === "E_STATE_DIRECTORY_MISSING") { const { mkdir } = await import("node:fs/promises"); await mkdir(p.providers, { mode: 0o700 }).catch((cause) => { if (cause.code !== "EEXIST") throw cause; }); await assertPrivateDirectory(p.providers); } else throw error; } const release = await acquirePrivateLock(p.lockPath); try { return await operation(p); } finally { await release(); } }
async function read(path) { try { return validate(await readPrivateJson(path)); } catch (error) { if (error?.code === "ENOENT") return null; throw error; } }
async function requireState(path) { const state = await read(path); if (state === null) fail("E_CLAUDE_OPERATION_NOT_FOUND", "Claude provider operationがありません"); return state; }
function validateInput({ stateRoot, targetId, operationId, generationId, expected }) { if (!isAbsolute(stateRoot) || !TARGET.test(targetId) || !DIGEST.test(operationId) || !DIGEST.test(generationId) || !expected || ![expected.job_id, expected.session_id, expected.name].every((x) => typeof x === "string" && x.length > 0) || typeof expected.cwd !== "string" || !isAbsolute(expected.cwd)) fail("E_CLAUDE_OPERATION_IDENTITY_INVALID", "Claude operation identityが不正です"); }
function validate(value) { if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).sort().join("|") !== [...KEYS].sort().join("|")) fail("E_CLAUDE_OPERATION_STATE_INVALID", "Claude operation schemaが不正です"); if (value.schema !== CLAUDE_MODEL_OPERATION_SCHEMA || value.provider !== "claude" || !TARGET.test(value.target_id) || !DIGEST.test(value.operation_id) || !DIGEST.test(value.generation_id) || !DIGEST.test(value.receipt_digest) || !["accepted", "completed"].includes(value.status)) fail("E_CLAUDE_OPERATION_STATE_INVALID", "Claude operation identityが不正です"); if (![value.job_id, value.session_id, value.name].every((x) => typeof x === "string" && x.length > 0) || typeof value.cwd !== "string" || !isAbsolute(value.cwd)) fail("E_CLAUDE_OPERATION_STATE_INVALID", "Claude handleが不正です"); timestamp(value.created_at); timestamp(value.updated_at); if (Date.parse(value.updated_at) < Date.parse(value.created_at)) fail("E_CLAUDE_OPERATION_STATE_INVALID", "timestampが後退しています"); if (value.status === "accepted" && (value.canonical_output !== null || value.canonical_output_digest !== null)) fail("E_CLAUDE_OPERATION_STATE_INVALID", "accepted output relationshipが不正です"); if (value.status === "completed") { const output = parseObserverAiOutput(JSON.stringify(value.canonical_output)); if (`sha256:${observerAiOutputDigest(output)}` !== value.canonical_output_digest) fail("E_CLAUDE_OPERATION_STATE_INVALID", "canonical output digestが不正です"); } return value; }
function sameIdentity(state, input) { if (state.target_id !== input.targetId || state.operation_id !== input.operationId || state.generation_id !== input.generationId || state.job_id !== input.expected.job_id || state.session_id !== input.expected.session_id || state.cwd !== input.expected.cwd || state.name !== input.expected.name || state.receipt_digest !== input.receiptDigest) fail("E_CLAUDE_OPERATION_CONFLICT", "Claude operation identityが一致しません"); }
function requireOperation(state, operationId) { if (!DIGEST.test(operationId) || state.operation_id !== operationId) fail("E_CLAUDE_OPERATION_CONFLICT", "operation IDが一致しません"); }
function digestReceipt(operationId, generationId, jobId, sessionId) { return `sha256:${createHash("sha256").update(`observer.claude.operation.receipt.v1\0${operationId}\0${generationId}\0${jobId}\0${sessionId}\0`, "utf8").digest("hex")}`; }
function now(dependencies) { return (dependencies.now ?? (() => new Date()))().toISOString(); }
function nextTime(state, dependencies) { const value = now(dependencies); if (Date.parse(value) < Date.parse(state.updated_at)) fail("E_CLAUDE_OPERATION_CLOCK_INVALID", "clockが後退しています"); return value; }
function serialize(value) { return `${JSON.stringify(value)}\n`; }
function canonicalRaw(state) { return JSON.stringify(parseObserverAiOutput(JSON.stringify(state.canonical_output))); }
function timestamp(value) { if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail("E_CLAUDE_OPERATION_STATE_INVALID", "timestampが不正です"); }
function plainAgent(value) { return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype && typeof value.id === "string" && typeof value.sessionId === "string" && typeof value.cwd === "string" && typeof value.name === "string" && typeof value.kind === "string" && typeof value.state === "string"; }
