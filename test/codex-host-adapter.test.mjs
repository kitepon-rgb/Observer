import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildObserverAiPrompt } from "../src/observer-ai-contract.mjs";
import {
  buildCodexCycleTurnStartParams,
  buildCodexInitializeParams,
  buildCodexThreadReadParams,
  buildCodexThreadResumeParams,
  buildCodexThreadStartParams,
  buildCodexTurnStartParams,
  parseCodexCycleThreadContext,
  parseCodexCycleTurnStartResult,
  parseCodexThreadReadResult,
  parseCodexThreadResumeResult,
  parseCodexThreadStartResult,
  parseCodexTurnStartResult,
  planCodexTurnStop,
  recordCodexInterruptResult,
} from "../src/codex-host-adapter.mjs";
import { buildCycleInput } from "../src/cycle-input.mjs";
import { buildEvidenceSnapshot } from "../src/evidence-snapshot.mjs";
import { ObserverError } from "../src/observer-error.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const THREAD_ID = "019f62a1-1111-7111-8111-111111111111";
const TURN_ID = "019f62a2-2222-7222-8222-222222222222";
const TARGET_ID = `p_${"a".repeat(64)}`;
const WATCH_ID = "w_11111111-1111-4111-8111-111111111111";
const OBSERVED_AT = "2026-07-15T05:00:00.000Z";
const SESSION_ID = "019f62a3-3333-7333-8333-333333333333";

const cycleInput = buildCycleInput(buildEvidenceSnapshot({
  context: {
    after_cursor_sha256: "1".repeat(64), cycle_id: `c_${"2".repeat(64)}`, parent_host: "codex",
    parent_thread_sha256: "3".repeat(64), target_id: TARGET_ID, through_cursor_sha256: "4".repeat(64), watch_id: WATCH_ID,
  },
  turns: [], plan: [], git: [], tests: [],
}));

function request(overrides = {}) {
  return {
    schema: "observer.parent_launch_request.v1",
    provider: "codex",
    watch_id: WATCH_ID,
    target_id: TARGET_ID,
    project_root: "/monitored/project",
    runtime_root: ROOT,
    required_handle_kind: "codex.thread",
    host: {
      kind: "codex.app_server_thread.v1", cwd: ROOT, approval_policy: "never",
      sandbox: "read-only", ephemeral: false, service_name: "observer",
    },
    child_start: {
      schema: "observer.child_start.v1", mode: "observe", provider: "codex", watch_id: WATCH_ID,
      target_id: TARGET_ID, project_root: "/monitored/project", runtime_root: ROOT,
    },
    ...overrides,
  };
}

function threadResult(overrides = {}) {
  return {
    cwd: ROOT,
    approvalPolicy: "never",
    sandbox: { type: "readOnly", networkAccess: false },
    instructionSources: [`${ROOT}/AGENTS.md`],
    thread: { id: THREAD_ID, cwd: ROOT, ephemeral: false, modelProvider: "openai", turns: [] },
    ...overrides,
  };
}

function expectCode(code) {
  return (error) => error instanceof ObserverError && error.code === code;
}

test("connection handshakeはstable APIのbounded client identityだけを送る", () => {
  assert.deepEqual(buildCodexInitializeParams(), {
    clientInfo: { name: "observer", title: "Observer", version: "0.1.3" },
    capabilities: { optOutNotificationMethods: ["item/agentMessage/delta", "turn/diff/updated", "turn/plan/updated"] },
  });
});

test("thread start/resumeと全turn cwdをObserver rootへ固定しtargetはenvelopeだけへ残す", () => {
  const start = buildCodexThreadStartParams(request());
  assert.equal(start.cwd, ROOT);
  assert.equal(start.approvalPolicy, "never");
  assert.equal(start.sandbox, "read-only");
  assert.equal(start.ephemeral, false);
  assert.equal(JSON.stringify(start).includes("/monitored/project"), false);

  const resume = buildCodexThreadResumeParams({ request: request(), threadId: THREAD_ID });
  assert.deepEqual({ threadId: resume.threadId, cwd: resume.cwd, approvalPolicy: resume.approvalPolicy, sandbox: resume.sandbox }, {
    threadId: THREAD_ID, cwd: ROOT, approvalPolicy: "never", sandbox: "read-only",
  });

  const turn = buildCodexTurnStartParams({ request: request(), threadId: THREAD_ID });
  assert.equal(turn.cwd, ROOT);
  assert.deepEqual(turn.sandboxPolicy, { type: "readOnly", networkAccess: false });
  assert.equal(turn.approvalPolicy, "never");
  assert.equal(turn.input.length, 1);
  assert.equal(turn.input[0].text, buildObserverAiPrompt(request().child_start));
  assert.equal(turn.input[0].text.includes("/monitored/project"), true);
});

test("thread resultはObserver cwd、read-only、OpenAI、AGENTS sourceを全て照合する", () => {
  const observation = parseCodexThreadStartResult({ result: threadResult(), request: request(), observedAt: OBSERVED_AT });
  assert.equal(observation.thread_id, THREAD_ID);
  assert.equal(observation.cwd, ROOT);
  assert.deepEqual(observation.turns, []);
  assert.equal(parseCodexThreadStartResult({ result: threadResult({ sandbox: { type: "readOnly" } }), request: request(), observedAt: OBSERVED_AT }).thread_id, THREAD_ID);
  assert.equal(parseCodexThreadResumeResult({ result: threadResult(), request: request(), threadId: THREAD_ID, observedAt: OBSERVED_AT }).thread_id, THREAD_ID);
  assert.throws(
    () => parseCodexThreadStartResult({ result: threadResult({ cwd: "/monitored/project" }), request: request(), observedAt: OBSERVED_AT }),
    expectCode("E_CODEX_THREAD_POLICY_MISMATCH"),
  );
  assert.throws(
    () => parseCodexThreadStartResult({ result: threadResult({ instructionSources: [] }), request: request(), observedAt: OBSERVED_AT }),
    expectCode("E_CODEX_INSTRUCTION_SOURCE_MISSING"),
  );
  assert.throws(
    () => parseCodexThreadStartResult({ result: threadResult({ sandbox: { type: "readOnly", networkAccess: true } }), request: request(), observedAt: OBSERVED_AT }),
    expectCode("E_CODEX_THREAD_POLICY_MISMATCH"),
  );
});

test("turn IDはthread handleへ潰さず別operationとして返す", () => {
  const operation = parseCodexTurnStartResult({ result: { turn: { id: TURN_ID, status: "inProgress", items: [] } }, threadId: THREAD_ID, observedAt: OBSERVED_AT });
  assert.deepEqual(operation, {
    schema: "observer.codex_turn_operation.v1", thread_id: THREAD_ID, turn_id: TURN_ID,
    status: "inProgress", observed_at: OBSERVED_AT,
  });
  assert.notEqual(operation.thread_id, operation.turn_id);
});

test("thread/readだけをterminal照合に使いcwd不一致や重複turnを拒否する", () => {
  assert.deepEqual(buildCodexThreadReadParams(THREAD_ID), { threadId: THREAD_ID, includeTurns: true });
  const result = { thread: { id: THREAD_ID, cwd: ROOT, turns: [{ id: TURN_ID, status: "inProgress", items: [] }] } };
  const observation = parseCodexThreadReadResult({ result, expectedThreadId: THREAD_ID, expectedCwd: ROOT, observedAt: OBSERVED_AT });
  assert.deepEqual(observation.turns, [{ turn_id: TURN_ID, status: "inProgress" }]);
  assert.throws(
    () => parseCodexThreadReadResult({ result: { thread: { ...result.thread, cwd: "/monitored/project" } }, expectedThreadId: THREAD_ID, expectedCwd: ROOT, observedAt: OBSERVED_AT }),
    expectCode("E_CODEX_THREAD_READ_MISMATCH"),
  );
  assert.throws(
    () => parseCodexThreadReadResult({ result: { thread: { ...result.thread, turns: [...result.thread.turns, ...result.thread.turns] } }, expectedThreadId: THREAD_ID, expectedCwd: ROOT, observedAt: OBSERVED_AT }),
    expectCode("E_CODEX_THREAD_READ_INVALID"),
  );
});

test("cycle request前にthread/session/cwdを束縛しactive turnの並走を拒否する", () => {
  const result = { thread: { id: THREAD_ID, sessionId: SESSION_ID, cwd: ROOT, turns: [{
    id: TURN_ID, status: "completed", items: [],
  }] } };
  assert.deepEqual(parseCodexCycleThreadContext({ result, expectedThreadId: THREAD_ID, expectedCwd: ROOT }), {
    thread_id: THREAD_ID, session_id: SESSION_ID, cwd: ROOT,
  });
  assert.throws(() => parseCodexCycleThreadContext({
    result: { thread: { ...result.thread, sessionId: "" } }, expectedThreadId: THREAD_ID, expectedCwd: ROOT,
  }), expectCode("E_CODEX_CYCLE_THREAD_MISMATCH"));
  assert.throws(() => parseCodexCycleThreadContext({
    result: { thread: { ...result.thread, turns: [{ ...result.thread.turns[0], status: "inProgress" }] } },
    expectedThreadId: THREAD_ID, expectedCwd: ROOT,
  }), expectCode("E_CODEX_CYCLE_TURN_ACTIVE"));
});

test("cycle turn/startはcanonical inputを同じthreadの新しいturnへ一回だけ送る", () => {
  const context = { thread_id: THREAD_ID, session_id: SESSION_ID, cwd: ROOT };
  const operation = { provider: "codex", input_digest: cycleInput.input_digest, model_visible_bytes: cycleInput.model_visible_bytes };
  assert.deepEqual(buildCodexCycleTurnStartParams({ operation, value: cycleInput.value, context }), {
    threadId: THREAD_ID, input: [{ type: "text", text: cycleInput.value }], cwd: ROOT,
    approvalPolicy: "never", sandboxPolicy: { type: "readOnly", networkAccess: false },
  });
  assert.deepEqual(parseCodexCycleTurnStartResult({ result: { turn: { id: TURN_ID, status: "inProgress", items: [] } }, context }), {
    thread_id: THREAD_ID, session_id: SESSION_ID, turn_id: TURN_ID, cwd: ROOT,
  });
  assert.throws(() => buildCodexCycleTurnStartParams({
    operation: { ...operation, input_digest: `sha256:${"f".repeat(64)}` }, value: cycleInput.value, context,
  }), expectCode("E_CYCLE_INPUT_RECEIPT_MISMATCH"));
  assert.throws(() => parseCodexCycleTurnStartResult({ result: { turn: { id: TURN_ID, status: "completed", items: [] } }, context }), expectCode("E_CODEX_CYCLE_ACK_INVALID"));
});

test("interrupt ACKと同一turn terminalを分離する", () => {
  const operation = { schema: "observer.codex_turn_operation.v1", thread_id: THREAD_ID, turn_id: TURN_ID, status: "inProgress", observed_at: OBSERVED_AT };
  const observation = (status) => ({ schema: "observer.codex_thread_observation.v1", thread_id: THREAD_ID, cwd: ROOT, turns: [{ turn_id: TURN_ID, status }], observed_at: OBSERVED_AT });
  const plan = planCodexTurnStop({ operation, observation: observation("inProgress") });
  assert.equal(plan.action, "issue_interrupt");
  const receipt = recordCodexInterruptResult({ result: {}, operation, observedAt: OBSERVED_AT });
  assert.equal(receipt.outcome, "acknowledged");
  assert.equal(planCodexTurnStop({ operation, observation: observation("inProgress"), previousInterruptReceipt: receipt }).action, "await_terminal_observation");
  assert.deepEqual(planCodexTurnStop({ operation, observation: observation("interrupted"), previousInterruptReceipt: receipt }), {
    action: "already_terminal", thread_id: THREAD_ID, turn_id: TURN_ID, terminal_status: "interrupted",
  });
  assert.throws(() => recordCodexInterruptResult({ result: { accepted: true }, operation, observedAt: OBSERVED_AT }), expectCode("E_CODEX_INTERRUPT_RESULT_INVALID"));
});
