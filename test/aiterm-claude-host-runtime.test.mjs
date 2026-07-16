import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  activateAitermClaudeObserver,
  closeAitermClaudeSession,
  readAitermClaudeLaunchStatus,
  recoverAitermClaudeSpawn,
  spawnAitermClaudeObserver,
} from "../src/aiterm-claude-host-runtime.mjs";
import { ObserverError } from "../src/observer-error.mjs";
import { buildAitermClaudeGenerationLaunchRequest } from "../src/parent-launch.mjs";
import { reserveActiveWatch } from "../src/watch-store.mjs";

const TARGET = { schema: "observer.project_target.v1", targetId: `p_${"a".repeat(64)}`, projectRoot: "/project" };
const UUID = "11111111-1111-4111-8111-111111111111";
const T0 = new Date("2026-07-16T00:00:00.000Z");
const T1 = new Date("2026-07-16T00:01:00.000Z");
const T2 = new Date("2026-07-16T00:02:00.000Z");

function expectCode(code) {
  return (error) => error instanceof ObserverError && error.code === code;
}

async function launchFixture() {
  const stateRoot = await mkdtemp(join(tmpdir(), "observer-aiterm-claude-"));
  const starting = await reserveActiveWatch({ stateRoot, target: TARGET, provider: "claude" }, { randomUUID: () => UUID, now: () => T0 });
  const request = buildAitermClaudeGenerationLaunchRequest({
    target: TARGET,
    watchId: starting.watch_id,
    runtimeRoot: "/observer",
  });
  return { stateRoot, starting, request };
}

test("Aiterm Claude spawnはrecord-first journal後に構造化claude_agent receiptだけを受け入れる", async () => {
  const { stateRoot, request } = await launchFixture();
  const calls = [];
  const result = await spawnAitermClaudeObserver({
    stateRoot,
    request,
    transport: {
      callTool: async (name, input) => {
        calls.push([name, input]);
        return {
          schema: "aiterm.agent-launch-result.v1",
          provider: "claude",
          session_id: request.host.session_name,
          managed_completion: true,
        };
      },
    },
  }, { now: () => T1 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "claude_agent");
  assert.deepEqual(calls[0][1], {
    cwd: "/observer",
    session_name: request.host.session_name,
    agent_done: true,
    launch_operation_id: calls[0][1].launch_operation_id,
  });
  assert.match(calls[0][1].launch_operation_id, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(result.receipt, {
    schema: "observer.host_receipt.v1",
    provider: "claude",
    watch_id: request.watch_id,
    target_id: TARGET.targetId,
    outcome: "spawned",
    handle: { kind: "claude.session", value: request.host.session_name },
  });
  assert.equal((await readAitermClaudeLaunchStatus({ stateRoot, request })).status, "spawned");
});

test("launch未知時は同じ相関済みclaude_agentだけをreplayしてjournalを回復する", async () => {
  const { stateRoot, request } = await launchFixture();
  const initialCalls = [];
  let initialInput;
  await assert.rejects(spawnAitermClaudeObserver({
    stateRoot,
    request,
    transport: { callTool: async (name, input) => { initialCalls.push(name); initialInput = input; throw new Error("transport disconnected"); } },
  }, { now: () => T1 }));
  assert.deepEqual(initialCalls, ["claude_agent"]);
  const retryCalls = [];
  await assert.rejects(spawnAitermClaudeObserver({
    stateRoot,
    request,
    transport: { callTool: async (name) => { retryCalls.push(name); throw new Error("must not run"); } },
  }, { now: () => T1 }), expectCode("E_AITERM_CLAUDE_LAUNCH_UNKNOWN"));
  assert.deepEqual(retryCalls, []);
  const recoveryCalls = [];
  const recovered = await recoverAitermClaudeSpawn({
    stateRoot,
    request,
    transport: {
      callTool: async (name, input) => {
        recoveryCalls.push([name, input]);
        return {
          schema: "aiterm.agent-launch-result.v1",
          provider: "claude",
          session_id: request.host.session_name,
          managed_completion: true,
        };
      },
    },
  }, { now: () => T2 });
  assert.equal(recovered.outcome, "spawned");
  assert.deepEqual(recoveryCalls, [["claude_agent", initialInput]]);
  assert.equal((await readAitermClaudeLaunchStatus({ stateRoot, request })).status, "spawned");
});

test("launch replayのidentity不一致receiptをspawnedへ降格しない", async () => {
  const { stateRoot, request } = await launchFixture();
  await assert.rejects(spawnAitermClaudeObserver({
    stateRoot,
    request,
    transport: { callTool: async () => { throw new Error("transport disconnected"); } },
  }, { now: () => T1 }));
  await assert.rejects(recoverAitermClaudeSpawn({
    stateRoot,
    request,
    transport: { callTool: async () => ({
      schema: "aiterm.agent-launch-result.v1",
      provider: "claude",
      session_id: "different_session",
      managed_completion: true,
    }) },
  }, { now: () => T2 }), expectCode("E_AITERM_CLAUDE_LAUNCH_RESULT_MISMATCH"));
  assert.equal((await readAitermClaudeLaunchStatus({ stateRoot, request })).status, "launching");
});

test("Aitermの明示launch拒否はunknownへ丸めずrecoverによる別session採用を禁止する", async () => {
  const { stateRoot, request } = await launchFixture();
  await assert.rejects(spawnAitermClaudeObserver({
    stateRoot,
    request,
    transport: {
      callTool: async () => { throw new ObserverError("E_AITERM_TOOL_ERROR", "explicit rejection"); },
    },
  }, { now: () => T1 }), expectCode("E_AITERM_TOOL_ERROR"));
  assert.deepEqual(await readAitermClaudeLaunchStatus({ stateRoot, request }), {
    schema: "observer.aiterm_claude_launch.v1",
    provider: "claude",
    target_id: request.target_id,
    watch_id: request.watch_id,
    session_id: request.host.session_name,
    status: "rejected",
    failure_code: "E_AITERM_TOOL_ERROR",
  });
  let calls = 0;
  await assert.rejects(recoverAitermClaudeSpawn({
    stateRoot,
    request,
    transport: { callTool: async () => { calls += 1; } },
  }), expectCode("E_AITERM_CLAUDE_LAUNCH_REJECTED"));
  assert.equal(calls, 0);
});

test("terminal済みsessionのreceiptは再利用せず、次generationの別sessionだけをlaunchできる", async () => {
  const { stateRoot, request } = await launchFixture();
  await spawnAitermClaudeObserver({
    stateRoot,
    request,
    transport: { callTool: async () => ({ schema: "aiterm.agent-launch-result.v1", provider: "claude", session_id: request.host.session_name, managed_completion: true }) },
  }, { now: () => T1 });
  const calls = [];
  const closed = await closeAitermClaudeSession({
    stateRoot,
    targetId: request.target_id,
    watchId: request.watch_id,
    sessionId: request.host.session_name,
    transport: { callTool: async (name, input) => {
      calls.push([name, input]);
      return { schema: "aiterm.pty-close-result.v1", session_id: request.host.session_name, outcome: "closed" };
    } },
  });
  assert.deepEqual(closed, { schema: "aiterm.pty-close-result.v1", session_id: request.host.session_name, outcome: "closed" });
  assert.deepEqual(calls, [["pty_close", { session_id: request.host.session_name }]]);
  await assert.rejects(spawnAitermClaudeObserver({ stateRoot, request, transport: { callTool: async () => null } }), expectCode("E_AITERM_CLAUDE_SESSION_TERMINAL"));
  const nextRequest = buildAitermClaudeGenerationLaunchRequest({
    target: TARGET, watchId: request.watch_id, runtimeRoot: "/observer", sessionInstanceId: `sha256:${"b".repeat(64)}`,
  });
  assert.notEqual(nextRequest.host.session_name, request.host.session_name);
  const next = await spawnAitermClaudeObserver({
    stateRoot,
    request: nextRequest,
    transport: { callTool: async () => ({ schema: "aiterm.agent-launch-result.v1", provider: "claude", session_id: nextRequest.host.session_name, managed_completion: true }) },
  }, { now: () => T1 });
  assert.equal(next.receipt.handle.value, nextRequest.host.session_name);
});

test("session handle耐久化後にactiveへ進め、active再開ではexact bindingを要求してgenerationを初期化する", async () => {
  const { stateRoot, request } = await launchFixture();
  const spawned = await spawnAitermClaudeObserver({
    stateRoot,
    request,
    transport: {
      callTool: async () => ({
        schema: "aiterm.agent-launch-result.v1",
        provider: "claude",
        session_id: request.host.session_name,
        managed_completion: true,
      }),
    },
  }, { now: () => T1 });
  const dependencies = {
    now: () => T2,
    parentDependencies: { now: () => T2 },
    generationDependencies: { now: () => T2 },
  };
  const active = await activateAitermClaudeObserver({
    stateRoot,
    request,
    receipt: spawned.receipt,
    parentThreadSha256: "b".repeat(64),
  }, dependencies);
  assert.equal(active.watch_status.status, "active");
  assert.equal(active.ready_receipt.handle.value, request.host.session_name);
  assert.equal(active.generation.status, "active");
  assert.equal(active.generation.provider, "claude");
  assert.equal((await readAitermClaudeLaunchStatus({ stateRoot, request })).status, "bound");
  const resumed = await activateAitermClaudeObserver({
    stateRoot,
    request,
    receipt: spawned.receipt,
    parentThreadSha256: "b".repeat(64),
  }, dependencies);
  assert.equal(resumed.watch_status.status, "active");
  assert.equal(resumed.generation.generation_id, active.generation.generation_id);
  await assert.rejects(activateAitermClaudeObserver({
    stateRoot,
    request,
    receipt: { ...spawned.receipt, handle: { kind: "claude.session", value: "other-session" } },
    parentThreadSha256: "b".repeat(64),
  }, dependencies), expectCode("E_AITERM_CLAUDE_LAUNCH_RECEIPT_MISMATCH"));
});
