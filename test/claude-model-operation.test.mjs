import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { cleanupClaudeModelOperation, issueClaudeModelOperation, recoverClaudeModelOperation } from "../src/claude-model-operation.mjs";
import { buildCycleInput } from "../src/cycle-input.mjs";
import { buildEvidenceSnapshot } from "../src/evidence-snapshot.mjs";
import { observerAiOutputDigest, parseObserverAiOutput } from "../src/observer-ai-contract.mjs";
import { ObserverError } from "../src/observer-error.mjs";

const targetId = `p_${"a".repeat(64)}`;
const operationId = `sha256:${"b".repeat(64)}`;
const generationId = `sha256:${"c".repeat(64)}`;
const sessionId = "claude-session-1";
const rawOutput = '{"schema":"observer.ai_output.v1","outcome":"no_advisory"}';
const alternateRawOutput = JSON.stringify({
  schema: "observer.ai_output.v1", outcome: "advisory",
  proposal: { title: "t", body: "b", suggested_action: "a", dedupe_key: "d", evidence_refs: ["e"], severity: "warning", category: "scope_drift" },
});
const expectCode = (code) => (error) => error instanceof ObserverError && error.code === code;

const input = buildCycleInput(buildEvidenceSnapshot({
  context: {
    after_cursor_sha256: "1".repeat(64), cycle_id: `c_${"2".repeat(64)}`, parent_host: "claude",
    parent_thread_sha256: "3".repeat(64), target_id: targetId,
    through_cursor_sha256: "4".repeat(64), watch_id: "w_11111111-1111-4111-8111-111111111111",
  },
  turns: [], plan: [], git: [], tests: [],
}));
const dispatching = {
  operation_id: operationId, target_id: targetId, generation_id: generationId, provider: "claude",
  action: "issue_once", status: "dispatching", input_digest: input.input_digest,
  model_visible_bytes: input.model_visible_bytes,
};
const recovering = { ...dispatching, action: "recover_only", status: "accepted" };

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "claude-operation-"));
  await chmod(root, 0o700);
  await mkdir(join(root, "watches", targetId), { recursive: true, mode: 0o700 });
  await chmod(join(root, "watches"), 0o700);
  await chmod(join(root, "watches", targetId), 0o700);
  return root;
}

function result(action, status, { raw = null, reason = null, operation = operationId } = {}) {
  return {
    schema: "aiterm.claude-operation-result.v1", action, status, session_id: sessionId,
    operation_id: operation, raw_output: raw, reason,
  };
}

test("Aiterm Claude issue acceptedとrecover pending/completedを同じoperationへ束縛し、prompt/output本文をjournalへ複製しない", async () => {
  const stateRoot = await setup(); const calls = [];
  const accepted = await issueClaudeModelOperation({
    stateRoot, operation: dispatching, value: input.value, runtime: { session_id: sessionId },
  }, { callTool: async (name, args) => { calls.push([name, args]); return result("issue", "accepted"); } });
  assert.equal(accepted.outcome, "accepted");
  assert.deepEqual(calls, [["claude_turn", { action: "issue", session_id: sessionId, operation_id: operationId, text: input.value }]]);
  const pending = await recoverClaudeModelOperation({
    stateRoot, operation: recovering, runtime: { session_id: sessionId },
  }, { callTool: async (name, args) => { calls.push([name, args]); return result("recover", "pending"); } });
  assert.deepEqual(pending, { schema: "observer.model_operation_callback.v1", outcome: "pending" });
  const completed = await recoverClaudeModelOperation({
    stateRoot, operation: recovering, runtime: { session_id: sessionId },
  }, { callTool: async (name, args) => { calls.push([name, args]); return result("recover", "completed", { raw: rawOutput }); } });
  assert.equal(completed.outcome, "completed"); assert.equal(completed.raw_output, rawOutput);
  assert.deepEqual(calls.slice(1), [
    ["claude_turn", { action: "recover", session_id: sessionId, operation_id: operationId }],
    ["claude_turn", { action: "recover", session_id: sessionId, operation_id: operationId }],
  ]);
  const journalPath = join(stateRoot, "watches", targetId, "provider-operations", `claude-${operationId.slice(7)}.json`);
  const journal = await readFile(journalPath, "utf8");
  assert.equal((await stat(journalPath)).mode & 0o777, 0o600);
  assert.equal(journal.includes(input.value), false); assert.equal(journal.includes(rawOutput), false);
});

test("Aiterm Claude unknown二種は固定変換し、tool errorとresponse shape mismatchを隠さない", async () => {
  const stateRoot = await setup();
  assert.deepEqual(await recoverClaudeModelOperation({ stateRoot, operation: { ...recovering, status: "dispatching" }, runtime: { session_id: sessionId } }, {
    callTool: async () => result("recover", "unknown", { reason: "operation_not_found" }),
  }), { schema: "observer.model_operation_callback.v1", outcome: "unknown", reason: "provider_operation_missing" });
  await issueClaudeModelOperation({ stateRoot, operation: dispatching, value: input.value, runtime: { session_id: sessionId } }, { callTool: async () => result("issue", "accepted") });
  assert.deepEqual(await recoverClaudeModelOperation({ stateRoot, operation: recovering, runtime: { session_id: sessionId } }, {
    callTool: async () => result("recover", "unknown", { reason: "result_unknown" }),
  }), { schema: "observer.model_operation_callback.v1", outcome: "unknown", reason: "provider_result_unknown" });
  await assert.rejects(recoverClaudeModelOperation({ stateRoot, operation: recovering, runtime: { session_id: sessionId } }, {
    callTool: async () => { throw new ObserverError("E_AITERM_TOOL_ERROR", "sanitized"); },
  }), expectCode("E_AITERM_TOOL_ERROR"));
  await assert.rejects(recoverClaudeModelOperation({ stateRoot, operation: recovering, runtime: { session_id: sessionId } }, {
    callTool: async () => result("recover", "completed", { raw: rawOutput, operation: `sha256:${"d".repeat(64)}` }),
  }), expectCode("E_CLAUDE_AITERM_RESULT_MISMATCH"));
});

test("Aiterm Claudeはinput digest/bytes mismatchをtool call前に拒否し、completed replay digestを固定する", async () => {
  const stateRoot = await setup(); let calls = 0;
  await assert.rejects(issueClaudeModelOperation({
    stateRoot, operation: { ...dispatching, input_digest: `sha256:${"e".repeat(64)}` }, value: input.value, runtime: { session_id: sessionId },
  }, { callTool: async () => { calls += 1; return result("issue", "accepted"); } }), expectCode("E_CYCLE_INPUT_RECEIPT_MISMATCH"));
  await assert.rejects(issueClaudeModelOperation({
    stateRoot, operation: { ...dispatching, model_visible_bytes: input.model_visible_bytes + 1 }, value: input.value, runtime: { session_id: sessionId },
  }, { callTool: async () => { calls += 1; return result("issue", "accepted"); } }), expectCode("E_CYCLE_INPUT_RECEIPT_MISMATCH"));
  assert.equal(calls, 0);
  await issueClaudeModelOperation({ stateRoot, operation: dispatching, value: input.value, runtime: { session_id: sessionId } }, { callTool: async () => result("issue", "accepted") });
  await recoverClaudeModelOperation({ stateRoot, operation: recovering, runtime: { session_id: sessionId } }, { callTool: async () => result("recover", "completed", { raw: rawOutput }) });
  await assert.rejects(recoverClaudeModelOperation({ stateRoot, operation: recovering, runtime: { session_id: sessionId } }, {
    callTool: async () => result("recover", "completed", { raw: alternateRawOutput }),
  }), expectCode("E_CLAUDE_RESULT_MISMATCH"));
  await assert.rejects(recoverClaudeModelOperation({ stateRoot, operation: recovering, runtime: { session_id: sessionId } }, {
    callTool: async () => result("recover", "pending"),
  }), expectCode("E_CLAUDE_RESULT_MISMATCH"));
  await assert.rejects(recoverClaudeModelOperation({ stateRoot, operation: recovering, runtime: { session_id: sessionId } }, {
    callTool: async () => result("recover", "unknown", { reason: "operation_not_found" }),
  }), expectCode("E_CLAUDE_RESULT_MISMATCH"));
});

test("Aiterm Claude cleanupはgeneric completed証拠と一致した後だけ許可し、precomplete cleanupを拒否する", async () => {
  const stateRoot = await setup();
  await issueClaudeModelOperation({ stateRoot, operation: dispatching, value: input.value, runtime: { session_id: sessionId } }, { callTool: async () => result("issue", "accepted") });
  await assert.rejects(cleanupClaudeModelOperation({ stateRoot, operation: dispatching }, { readModelOperation: async () => null }), expectCode("E_CLAUDE_CLEANUP_FORBIDDEN"));
  const accepted = await recoverClaudeModelOperation({ stateRoot, operation: recovering, runtime: { session_id: sessionId } }, { callTool: async () => result("recover", "completed", { raw: rawOutput }) });
  const evidence = {
    provider_operation_receipt_digest: accepted.provider_operation_receipt_digest,
    completed_output_digest: `sha256:${observerAiOutputDigest(parseObserverAiOutput(rawOutput))}`,
  };
  assert.deepEqual(await cleanupClaudeModelOperation({ stateRoot, operation: dispatching }, {
    readModelOperation: async () => ({ status: "completed", operation_id: operationId, ...evidence }),
  }), { schema: "observer.model_operation_cleanup.v1", outcome: "cleaned" });
});
