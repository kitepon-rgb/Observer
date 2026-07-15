import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  acceptCodexModelOperation,
  cleanupCodexModelOperation,
  issueCodexModelOperation,
  recoverCodexModelOperation,
} from "../src/codex-model-operation.mjs";
import { buildCycleInput } from "../src/cycle-input.mjs";
import { buildEvidenceSnapshot } from "../src/evidence-snapshot.mjs";
import { observerAiOutputDigest, parseObserverAiOutput } from "../src/observer-ai-contract.mjs";

const threadId = "019f62a1-1111-7111-8111-111111111111";
const turnId = "019f62a2-2222-7222-8222-222222222222";
const sessionId = "019f62a3-3333-7333-8333-333333333333";
const baseOperation = {
  operation_id: `sha256:${"a".repeat(64)}`,
  target_id: `p_${"b".repeat(64)}`,
  generation_id: `sha256:${"c".repeat(64)}`,
};
const handle = { thread_id: threadId, session_id: sessionId, turn_id: turnId, cwd: "/observer" };
const raw = '{"schema":"observer.ai_output.v1","outcome":"no_advisory"}';
const cycleInput = buildCycleInput(buildEvidenceSnapshot({
  context: {
    after_cursor_sha256: "1".repeat(64), cycle_id: `c_${"2".repeat(64)}`, parent_host: "codex",
    parent_thread_sha256: "3".repeat(64), target_id: baseOperation.target_id,
    through_cursor_sha256: "4".repeat(64), watch_id: "w_11111111-1111-4111-8111-111111111111",
  },
  turns: [], plan: [], git: [], tests: [],
}));
const dispatching = {
  ...baseOperation,
  provider: "codex",
  action: "issue_once",
  status: "dispatching",
  input_digest: cycleInput.input_digest,
  model_visible_bytes: cycleInput.model_visible_bytes,
};
const acceptedOperation = { ...dispatching, action: "recover_only", status: "accepted" };

async function root() {
  const path = await mkdtemp(join(tmpdir(), "codex-result-"));
  await chmod(path, 0o700);
  await mkdir(join(path, "watches", baseOperation.target_id), { recursive: true, mode: 0o700 });
  await chmod(join(path, "watches"), 0o700);
  await chmod(join(path, "watches", baseOperation.target_id), 0o700);
  return path;
}

function threadRead(status, items = [], overrides = {}) {
  return async (params) => {
    assert.deepEqual(params, { threadId, includeTurns: true });
    return {
      thread: {
        id: threadId,
        sessionId,
        cwd: "/observer",
        turns: [{ id: turnId, status, items }],
        ...overrides,
      },
    };
  };
}

test("provider acceptedはdispatchingへreceiptを再提示しgeneric acceptedではpendingを観測する", async () => {
  const stateRoot = await root();
  const accepted = await acceptCodexModelOperation({ stateRoot, operation: dispatching, handle });
  assert.deepEqual(await recoverCodexModelOperation({ stateRoot, operation: dispatching, threadRead: async () => assert.fail() }), accepted);
  assert.deepEqual(await recoverCodexModelOperation({ stateRoot, operation: acceptedOperation, threadRead: threadRead("inProgress") }), {
    schema: "observer.model_operation_callback.v1", outcome: "pending",
  });
  assert.deepEqual(await acceptCodexModelOperation({ stateRoot, operation: dispatching, handle }), accepted);
  await assert.rejects(acceptCodexModelOperation({ stateRoot, operation: dispatching, handle: { ...handle, turn_id: threadId } }), { code: "E_CODEX_PROVIDER_CONFLICT" });
});

test("thread確認後のturn/start ACKだけをrequest固有handleへaccepted保存する", async () => {
  const stateRoot = await root(); const calls = [];
  const accepted = await issueCodexModelOperation({
    stateRoot, operation: dispatching, value: cycleInput.value, runtime: { thread_id: threadId, cwd: "/observer" },
  }, {
    threadRead: async (params) => {
      calls.push("read"); assert.deepEqual(params, { threadId, includeTurns: true });
      return { thread: { id: threadId, sessionId, cwd: "/observer", turns: [] } };
    },
    turnStart: async (params) => {
      calls.push("start");
      assert.deepEqual(params, {
        threadId, input: [{ type: "text", text: cycleInput.value }], cwd: "/observer",
        approvalPolicy: "never", sandboxPolicy: { type: "readOnly", networkAccess: false },
      });
      return { turn: { id: turnId, status: "inProgress", items: [] } };
    },
  });
  assert.equal(accepted.outcome, "accepted");
  assert.deepEqual(calls, ["read", "start"]);

  const activeRoot = await root(); let starts = 0;
  await assert.rejects(issueCodexModelOperation({
    stateRoot: activeRoot, operation: dispatching, value: cycleInput.value, runtime: { thread_id: threadId, cwd: "/observer" },
  }, {
    threadRead: threadRead("inProgress"), turnStart: async () => { starts += 1; },
  }), { code: "E_CODEX_CYCLE_TURN_ACTIVE" });
  assert.equal(starts, 0);
});

test("turn/start結果不明ではjournalを作らずrecoverはprovider_operation_missingを返す", async () => {
  const stateRoot = await root();
  await assert.rejects(issueCodexModelOperation({
    stateRoot, operation: dispatching, value: cycleInput.value, runtime: { thread_id: threadId, cwd: "/observer" },
  }, {
    threadRead: async () => ({ thread: { id: threadId, sessionId, cwd: "/observer", turns: [] } }),
    turnStart: async () => ({ turn: { id: turnId, status: "completed", items: [] } }),
  }), { code: "E_CODEX_CYCLE_ACK_INVALID" });
  assert.deepEqual(await recoverCodexModelOperation({ stateRoot, operation: dispatching, threadRead: async () => assert.fail() }), {
    schema: "observer.model_operation_callback.v1", outcome: "unknown", reason: "provider_operation_missing",
  });
});

test("completed cycle turnの単一finalだけをcompletedへ束縛する", async () => {
  const stateRoot = await root();
  const accepted = await acceptCodexModelOperation({ stateRoot, operation: dispatching, handle });
  const result = await recoverCodexModelOperation({
    stateRoot,
    operation: acceptedOperation,
    threadRead: threadRead("completed", [
      { id: "comment", type: "agentMessage", phase: "commentary", text: "bounded status" },
      { id: "final", type: "agentMessage", phase: "final_answer", text: raw },
    ]),
  });
  assert.equal(result.outcome, "completed");
  assert.equal(result.provider_operation_receipt_digest, accepted.provider_operation_receipt_digest);
  assert.equal(result.raw_output, raw);
});

test("terminal failure、複数final、thread identity mismatchをfail closedにする", async () => {
  const stateRoot = await root();
  await acceptCodexModelOperation({ stateRoot, operation: dispatching, handle });
  assert.deepEqual(await recoverCodexModelOperation({ stateRoot, operation: acceptedOperation, threadRead: threadRead("failed") }), {
    schema: "observer.model_operation_callback.v1", outcome: "unknown", reason: "provider_result_unknown",
  });
  await assert.rejects(recoverCodexModelOperation({
    stateRoot, operation: acceptedOperation,
    threadRead: threadRead("completed", [
      { id: "a", type: "agentMessage", phase: "final_answer", text: raw },
      { id: "b", type: "agentMessage", phase: "final_answer", text: raw },
    ]),
  }), { code: "E_CODEX_RESULT_MISMATCH" });
  await assert.rejects(recoverCodexModelOperation({
    stateRoot, operation: acceptedOperation, threadRead: threadRead("completed", [], { sessionId: "other" }),
  }), { code: "E_CODEX_RESULT_MISMATCH" });
});

test("completed recoveryは同一item/digestを再読しgeneric completed一致後だけcleanupする", async () => {
  const stateRoot = await root();
  const accepted = await acceptCodexModelOperation({ stateRoot, operation: dispatching, handle });
  const read = threadRead("completed", [{ id: "item", type: "agentMessage", phase: null, text: raw }]);
  await recoverCodexModelOperation({ stateRoot, operation: acceptedOperation, threadRead: read });
  await recoverCodexModelOperation({ stateRoot, operation: acceptedOperation, threadRead: read });
  await assert.rejects(cleanupCodexModelOperation({ stateRoot, operation: baseOperation }, { readModelOperation: async () => null }), { code: "E_CODEX_CLEANUP_FORBIDDEN" });
  const evidence = {
    provider_operation_receipt_digest: accepted.provider_operation_receipt_digest,
    completed_output_digest: `sha256:${observerAiOutputDigest(parseObserverAiOutput(raw))}`,
  };
  const generic = { status: "completed", operation_id: baseOperation.operation_id, ...evidence };
  assert.deepEqual(await cleanupCodexModelOperation({ stateRoot, operation: baseOperation }, { readModelOperation: async () => generic }), {
    schema: "observer.model_operation_cleanup.v1", outcome: "cleaned",
  });
  assert.deepEqual(await cleanupCodexModelOperation({ stateRoot, operation: baseOperation, cleanupEvidence: evidence }, { readModelOperation: async () => generic }), {
    schema: "observer.model_operation_cleanup.v1", outcome: "cleaned",
  });
});

test("completed item変造は保存済みdigestと一致しない", async () => {
  const stateRoot = await root();
  await acceptCodexModelOperation({ stateRoot, operation: dispatching, handle });
  await recoverCodexModelOperation({ stateRoot, operation: acceptedOperation, threadRead: threadRead("completed", [{ id: "item", type: "agentMessage", text: raw }]) });
  await assert.rejects(recoverCodexModelOperation({
    stateRoot,
    operation: acceptedOperation,
    threadRead: threadRead("completed", [{ id: "item", type: "agentMessage", text: '{"schema":"observer.ai_output.v1","outcome":"advisory"}' }]),
  }), { code: "E_OBSERVER_AI_OUTPUT_INVALID" });
  await assert.rejects(recoverCodexModelOperation({
    stateRoot, operation: acceptedOperation, threadRead: threadRead("inProgress"),
  }), { code: "E_CODEX_RESULT_MISMATCH" });
});
