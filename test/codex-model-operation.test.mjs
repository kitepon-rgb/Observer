import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acceptCodexModelOperation, cleanupCodexModelOperation, recoverCodexModelOperation, sealCodexModelOperationStop } from "../src/codex-model-operation.mjs";
import { observerAiOutputDigest, parseObserverAiOutput } from "../src/observer-ai-contract.mjs";

const operation = { operation_id: `sha256:${"a".repeat(64)}`, target_id: `p_${"b".repeat(64)}`, generation_id: `sha256:${"c".repeat(64)}` };
const handle = { thread_id: "thread", session_id: "session", turn_id: "turn", after_item_id: null, cwd: "/observer" };
async function root() { const path = await mkdtemp(join(tmpdir(), "codex-result-")); await chmod(path, 0o700); await mkdir(join(path, "watches", operation.target_id), { recursive: true, mode: 0o700 }); await chmod(join(path, "watches"), 0o700); await chmod(join(path, "watches", operation.target_id), 0o700); return path; }
function read(items) { return async (params) => { assert.deepEqual(params, { threadId: "thread", includeTurns: true }); return { thread: { id: "thread", sessionId: "session", cwd: "/observer", turns: [{ id: "turn", status: "inProgress", items }] } }; }; }
const raw = '{"schema":"observer.ai_output.v1","outcome":"no_advisory"}';

test("accepted receiptはexact handleで不変に保存され、Stop seal前はpending", async () => {
  const stateRoot = await root(); const accepted = await acceptCodexModelOperation({ stateRoot, operation, handle });
  assert.equal(accepted.outcome, "accepted"); assert.deepEqual(await recoverCodexModelOperation({ stateRoot, operation, threadRead: async () => assert.fail("sealed前にreadしない") }), { schema: "observer.model_operation_callback.v1", outcome: "pending" });
  assert.deepEqual(await acceptCodexModelOperation({ stateRoot, operation, handle }), accepted);
  await assert.rejects(acceptCodexModelOperation({ stateRoot, operation, handle: { ...handle, turn_id: "other" } }), { code: "E_CODEX_PROVIDER_CONFLICT" });
  await assert.rejects(acceptCodexModelOperation({ stateRoot, operation, handle: { ...handle, cwd: "relative" } }), { code: "E_CODEX_PROVIDER_INPUT" });
});

test("inProgress turnでもseal後はbaseline以後のsingle finalだけをcompletedへ束縛する", async () => {
  const stateRoot = await root(); await acceptCodexModelOperation({ stateRoot, operation, handle }); await sealCodexModelOperationStop({ stateRoot, operation, stop: { session_id: "session", turn_id: "turn", stop_hook_active: true } });
  const result = await recoverCodexModelOperation({ stateRoot, operation, threadRead: read([{ id: "item", type: "agentMessage", phase: "final_answer", text: raw }]) });
  assert.equal(result.outcome, "completed"); assert.equal(result.raw_output, raw);
});

test("commentaryと単一finalを許し、baseline欠損・複数final・handle mismatchを拒否する", async () => {
  const stateRoot = await root(); await acceptCodexModelOperation({ stateRoot, operation, handle: { ...handle, after_item_id: "base" } }); await sealCodexModelOperationStop({ stateRoot, operation, stop: { session_id: "session", turn_id: "turn" } });
  const result = await recoverCodexModelOperation({ stateRoot, operation, threadRead: read([{ id: "base", type: "agentMessage", phase: "commentary", text: "x" }, { id: "comment", type: "agentMessage", phase: "commentary", text: "x" }, { id: "final", type: "agentMessage", phase: "final_answer", text: raw }]) }); assert.equal(result.outcome, "completed");
  const second = await root(); await acceptCodexModelOperation({ stateRoot: second, operation, handle }); await sealCodexModelOperationStop({ stateRoot: second, operation, stop: { session_id: "session", turn_id: "turn" } });
  await assert.rejects(recoverCodexModelOperation({ stateRoot: second, operation, threadRead: read([{ id: "a", type: "agentMessage", phase: "final_answer", text: raw }, { id: "b", type: "agentMessage", phase: "final_answer", text: raw }]) }), { code: "E_CODEX_RESULT_MISMATCH" });
  await assert.rejects(sealCodexModelOperationStop({ stateRoot: second, operation, stop: { session_id: "bad", turn_id: "turn" } }), { code: "E_CODEX_STOP_HANDLE_MISMATCH" });
});

test("completed recoveryは同一itemとdigestを再読し、generic completed照合後だけcleanupする", async () => {
  const stateRoot = await root(); const accepted = await acceptCodexModelOperation({ stateRoot, operation, handle }); await sealCodexModelOperationStop({ stateRoot, operation, stop: { session_id: "session", turn_id: "turn" } }); const threadRead = read([{ id: "item", type: "agentMessage", phase: null, text: raw }]); await recoverCodexModelOperation({ stateRoot, operation, threadRead }); await recoverCodexModelOperation({ stateRoot, operation, threadRead });
  await assert.rejects(cleanupCodexModelOperation({ stateRoot, operation }, { readModelOperation: async () => null }), { code: "E_CODEX_CLEANUP_FORBIDDEN" });
  const evidence = { provider_operation_receipt_digest: accepted.provider_operation_receipt_digest, completed_output_digest: `sha256:${observerAiOutputDigest(parseObserverAiOutput(raw))}` };
  const generic = { status: "completed", operation_id: operation.operation_id, ...evidence };
  await cleanupCodexModelOperation({ stateRoot, operation }, { readModelOperation: async () => generic });
  await assert.rejects(cleanupCodexModelOperation({ stateRoot, operation }, { readModelOperation: async () => generic }), { code: "E_CODEX_CLEANUP_FORBIDDEN" });
  assert.deepEqual(await cleanupCodexModelOperation({ stateRoot, operation, cleanupEvidence: evidence }, { readModelOperation: async () => generic }), { cleaned: true, replayed: true });
});

test("phase欠損、baseline欠損、session/cwd mismatch、completed本文変造をfail closedにする", async () => {
  const stateRoot = await root(); await acceptCodexModelOperation({ stateRoot, operation, handle }); await sealCodexModelOperationStop({ stateRoot, operation, stop: { session_id: "session", turn_id: "turn" } });
  const missingPhase = read([{ id: "item", type: "agentMessage", text: raw }]); assert.equal((await recoverCodexModelOperation({ stateRoot, operation, threadRead: missingPhase })).outcome, "completed");
  await assert.rejects(recoverCodexModelOperation({ stateRoot, operation, threadRead: read([{ id: "item", type: "agentMessage", text: '{"schema":"observer.ai_output.v1","outcome":"advisory"}' }]) }), { code: "E_OBSERVER_AI_OUTPUT_INVALID" });
  const other = await root(); await acceptCodexModelOperation({ stateRoot: other, operation, handle: { ...handle, after_item_id: "base" } }); await sealCodexModelOperationStop({ stateRoot: other, operation, stop: { session_id: "session", turn_id: "turn" } });
  await assert.rejects(recoverCodexModelOperation({ stateRoot: other, operation, threadRead: read([{ id: "item", type: "agentMessage", phase: null, text: raw }]) }), { code: "E_CODEX_RESULT_MISMATCH" });
});
