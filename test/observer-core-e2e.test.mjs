import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readCycleState } from "../src/cycle-store.mjs";
import { applyCycleOutput } from "../src/cycle-application.mjs";
import { readAdvisoryDecisionHistory } from "../src/advisory-semantic-decision.mjs";
import { initializeGeneration } from "../src/generation-store.mjs";
import {
  confirmParentHostSpawn,
  confirmParentLaunch,
  prepareParentLaunch,
} from "../src/parent-launch.mjs";
import { runParentStopHook } from "../src/parent-stop-hook.mjs";
import { runSupervisorProductionStep } from "../src/supervisor-production-step.mjs";

const NOW = new Date(Date.now() + 60_000);
const THREAD_ID = "019f62a1-1111-7111-8111-111111111111";
const TURN_ID = "019f62a2-2222-7222-8222-222222222222";
const TURN_ID_2 = "019f62a4-4444-7444-8444-444444444444";
const SESSION_ID = "019f62a3-3333-7333-8333-333333333333";
const PARENT_SESSION_ID = "parent-codex-session";
const PARENT_THREAD_SHA = sha256(PARENT_SESSION_ID);
const SOURCE_SHA = sha256("completed turn source");
const SOURCE_SHA_2 = sha256("second completed turn source");
const THROUGH_CURSOR = "tlc1.observer-core-e2e";
const THROUGH_CURSOR_2 = "tlc1.observer-core-e2e-second";

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function completedTurn(sourceSha = SOURCE_SHA, completedAt = Date.parse("2099-07-15T23:59:00.000Z")) {
  const user = "Observer core E2Eを完成して";
  const assistant = "transaction接続を実装しました";
  return {
    assistant,
    assistant_sha256: sha256(assistant),
    completed_at: completedAt,
    host: "codex",
    origin_sha256: sha256("origin"),
    source_sha256: sourceSha,
    thread_sha256: PARENT_THREAD_SHA,
    truncated: false,
    user,
    user_sha256: sha256(user),
  };
}

function advisoryOutput(evidenceRefs = [`turn:${SOURCE_SHA}`]) {
  return JSON.stringify({
    schema: "observer.ai_output.v1",
    outcome: "advisory",
    proposal: {
      title: "transaction接続を確認してください",
      body: "completed cycleの接続に確認が必要です。",
      suggested_action: "関連するreceiptを確認する",
      dedupe_key: "core-e2e:transaction",
      evidence_refs: evidenceRefs,
      severity: "warning",
      category: "verification_gap",
    },
  });
}

async function setupWatch(provider = "codex") {
  const root = await mkdtemp(join(tmpdir(), "observer-core-e2e-"));
  const stateRoot = join(root, "state");
  const projectRoot = join(root, "project");
  const runtimeRoot = join(root, "observer-runtime");
  await Promise.all([
    mkdir(projectRoot, { mode: 0o700 }),
    mkdir(runtimeRoot, { mode: 0o700 }),
  ]);
  await chmod(root, 0o700);
  const request = await prepareParentLaunch({
    stateRoot,
    projectRoot,
    runtimeRoot,
    authorization: {
      schema: "observer.parent_authorization.v1",
      intent: "start_observer",
      parent_provider: provider,
    },
  });
  const handle = provider === "codex"
    ? { kind: "codex.thread", value: THREAD_ID }
    : { kind: "claude.job", value: "job-1" };
  const receipt = (outcome) => ({
    schema: "observer.host_receipt.v1",
    provider,
    watch_id: request.watch_id,
    target_id: request.target_id,
    outcome,
    handle,
  });
  await confirmParentHostSpawn({ stateRoot, request, receipt: receipt("spawned") });
  await confirmParentLaunch({ stateRoot, request, receipt: receipt("ready") });
  await initializeGeneration({
    stateRoot,
    targetId: request.target_id,
    watchId: request.watch_id,
    provider,
    parentThreadSha256: PARENT_THREAD_SHA,
    readyReceipt: receipt("ready"),
  });
  return {
    stateRoot,
    projectRoot: request.project_root,
    runtimeRoot: request.runtime_root,
    request,
    target: {
      schema: "observer.project_target.v1",
      targetId: request.target_id,
      projectRoot: request.project_root,
    },
  };
}

function throughlineClient(target) {
  return {
    wait: async ({ afterCursor }) => ({
      schema: "throughline.observer_wait.v1",
      status: "timeout",
      afterCursor,
      throughCursor: afterCursor,
    }),
    read: async ({ throughCursor } = {}) => ({
      schema: "throughline.observer_read.v1",
      status: "snapshot",
      afterCursor: null,
      throughCursor: throughCursor ?? THROUGH_CURSOR,
      host: "codex",
      thread_sha256: PARENT_THREAD_SHA,
      turns: [completedTurn()],
      historyTruncated: false,
      page: { complete: true, nextToken: null },
    }),
  };
}

function codexSession(output, runtimeRoot) {
  return sequencedCodexSession([output], runtimeRoot);
}

function sequencedCodexSession(outputs, runtimeRoot) {
  const turns = [];
  const turnIds = [TURN_ID, TURN_ID_2];
  return {
    request: async (method) => {
      if (method === "turn/start") {
        const index = turns.length;
        assert.ok(index < outputs.length, "同じlogical cycleを再送してはいけません");
        const id = turnIds[index];
        turns.push({ id, output: outputs[index] });
        return { turn: { id, status: "inProgress", items: [] } };
      }
      assert.equal(method, "thread/read");
      return {
        thread: {
          id: THREAD_ID,
          sessionId: SESSION_ID,
          cwd: runtimeRoot,
          turns: turns.map(({ id, output: text }) => ({
            id,
            status: "completed",
            items: [{ id: `final-${id}`, type: "agentMessage", phase: "final_answer", text }],
          })),
        },
      };
    },
  };
}

function twoCycleThroughlineClient() {
  return {
    wait: async ({ afterCursor }) => afterCursor === THROUGH_CURSOR
      ? {
          schema: "throughline.observer_wait.v1",
          status: "changed",
          afterCursor,
          throughCursor: THROUGH_CURSOR_2,
        }
      : {
          schema: "throughline.observer_wait.v1",
          status: "timeout",
          afterCursor,
          throughCursor: afterCursor,
        },
    read: async ({ afterCursor = null, throughCursor } = {}) => afterCursor === null
      ? {
          schema: "throughline.observer_read.v1",
          status: "snapshot",
          afterCursor: null,
          throughCursor: throughCursor ?? THROUGH_CURSOR,
          host: "codex",
          thread_sha256: PARENT_THREAD_SHA,
          turns: [completedTurn()],
          historyTruncated: false,
          page: { complete: true, nextToken: null },
        }
      : {
          schema: "throughline.observer_read.v1",
          status: "delta",
          afterCursor,
          throughCursor: THROUGH_CURSOR_2,
          host: "codex",
          thread_sha256: PARENT_THREAD_SHA,
          turns: [completedTurn(SOURCE_SHA_2, Date.parse("2099-07-15T23:59:30.000Z"))],
          historyTruncated: false,
          page: { complete: true, nextToken: null },
        },
  };
}

function supervisorInput(fixture, session, client = throughlineClient(fixture.target)) {
  return {
    stateRoot: fixture.stateRoot,
    target: fixture.target,
    watchId: fixture.request.watch_id,
    client,
    providerRuntime: { provider: "codex", runtime_root: fixture.runtimeRoot, session },
    planRefs: [],
    testReceipts: [],
  };
}

async function runCodexCycle(output) {
  const fixture = await setupWatch("codex");
  const session = codexSession(output, fixture.runtimeRoot);
  const input = supervisorInput(fixture, session);
  assert.equal((await runSupervisorProductionStep(input, { now: () => NOW })).status, "model_pending");
  assert.equal((await runSupervisorProductionStep(input, { now: () => NOW })).status, "committed");
  return { fixture, input };
}

test("Codex completed cycleは実transactionを貫通し親Stopへ一度だけ配送する", async () => {
  const fixture = await setupWatch("codex");
  const input = supervisorInput(fixture, codexSession(advisoryOutput(), fixture.runtimeRoot));

  const pending = await runSupervisorProductionStep(input, { now: () => NOW });
  assert.equal(pending.status, "model_pending");
  const committed = await runSupervisorProductionStep(input, { now: () => NOW });
  assert.equal(committed.status, "committed");
  assert.equal((await readCycleState({
    stateRoot: fixture.stateRoot,
    targetId: fixture.target.targetId,
  })).committed_state.cursor, THROUGH_CURSOR);

  const emitted = [];
  const payload = {
    hook_event_name: "Stop",
    session_id: PARENT_SESSION_ID,
    turn_id: "parent-turn-1",
    cwd: fixture.projectRoot,
    stop_hook_active: false,
  };
  const first = await runParentStopHook({
    provider: "codex",
    payload,
    stateRoot: fixture.stateRoot,
    now: NOW,
  }, { emitHookOutput: async (value) => emitted.push(value) });
  assert.equal(first.status, "emitted_unacked");
  assert.equal(emitted.length, 1);
  assert.equal(JSON.parse(emitted[0]).decision, "block");

  const second = await runParentStopHook({
    provider: "codex",
    payload: { ...payload, turn_id: "parent-turn-2" },
    stateRoot: fixture.stateRoot,
    now: NOW,
  }, { emitHookOutput: async (value) => emitted.push(value) });
  assert.equal(second.status, "no_message");
  assert.equal(emitted.length, 1);

  const timeout = await runSupervisorProductionStep(input, { now: () => NOW });
  assert.equal(timeout.status, "timeout");
});

test("no_advisoryとevidence不適格suppressionはcursorだけをcommitしMailboxへ配送しない", async () => {
  for (const output of [
    JSON.stringify({ schema: "observer.ai_output.v1", outcome: "no_advisory" }),
    advisoryOutput(["turn:missing"]),
  ]) {
    const { fixture } = await runCodexCycle(output);
    const emitted = [];
    const result = await runParentStopHook({
      provider: "codex",
      payload: {
        hook_event_name: "Stop",
        session_id: PARENT_SESSION_ID,
        turn_id: "parent-silence-turn",
        cwd: fixture.projectRoot,
        stop_hook_active: false,
      },
      stateRoot: fixture.stateRoot,
      now: NOW,
    }, { emitHookOutput: async (value) => emitted.push(value) });
    assert.equal(result.status, "no_message");
    assert.deepEqual(emitted, []);
    assert.equal((await readCycleState({
      stateRoot: fixture.stateRoot,
      targetId: fixture.target.targetId,
    })).committed_state.cursor, THROUGH_CURSOR);
  }
});

test("Mailbox publish直後のcrashは同じoperation replayで一件へ収束する", async () => {
  const fixture = await setupWatch("codex");
  const input = supervisorInput(fixture, codexSession(advisoryOutput(), fixture.runtimeRoot));
  assert.equal((await runSupervisorProductionStep(input, { now: () => NOW })).status, "model_pending");
  let injected = false;
  await assert.rejects(runSupervisorProductionStep(input, {
    now: () => NOW,
    applyCycleOutput: async (request) => {
      const result = await applyCycleOutput(request);
      injected = true;
      throw new Error("crash after Mailbox publish");
    },
  }), /crash after Mailbox publish/);
  assert.equal(injected, true);
  assert.equal((await runSupervisorProductionStep(input, { now: () => NOW })).status, "committed");

  const emitted = [];
  const payload = {
    hook_event_name: "Stop",
    session_id: PARENT_SESSION_ID,
    turn_id: "parent-replay-turn",
    cwd: fixture.projectRoot,
    stop_hook_active: false,
  };
  assert.equal((await runParentStopHook({
    provider: "codex", payload, stateRoot: fixture.stateRoot, now: NOW,
  }, { emitHookOutput: async (value) => emitted.push(value) })).status, "emitted_unacked");
  assert.equal((await runParentStopHook({
    provider: "codex",
    payload: { ...payload, turn_id: "parent-replay-turn-2" },
    stateRoot: fixture.stateRoot,
    now: NOW,
  }, { emitHookOutput: async (value) => emitted.push(value) })).status, "no_message");
  assert.equal(emitted.length, 1);
});

test("60分内の同一dedupeと同severityは第二cycleをsuppressedにし親配送を一件へ保つ", async () => {
  const fixture = await setupWatch("codex");
  const session = sequencedCodexSession([
    advisoryOutput([`turn:${SOURCE_SHA}`]),
    advisoryOutput([`turn:${SOURCE_SHA_2}`]),
  ], fixture.runtimeRoot);
  const input = supervisorInput(fixture, session, twoCycleThroughlineClient());
  assert.equal((await runSupervisorProductionStep(input, { now: () => NOW })).status, "model_pending");
  assert.equal((await runSupervisorProductionStep(input, { now: () => NOW })).status, "committed");
  const firstHistory = await readAdvisoryDecisionHistory({
    stateRoot: fixture.stateRoot,
    targetId: fixture.target.targetId,
  });
  assert.deepEqual(firstHistory.entries.map(({ decision }) => decision), ["accepted"]);
  assert.equal((await runSupervisorProductionStep(input, { now: () => NOW })).status, "model_pending");
  assert.equal((await runSupervisorProductionStep(input, { now: () => NOW })).status, "committed");

  const history = await readAdvisoryDecisionHistory({
    stateRoot: fixture.stateRoot,
    targetId: fixture.target.targetId,
  });
  assert.deepEqual(history.entries.map(({ decision }) => decision).sort(), ["accepted", "suppressed"]);
  assert.equal((await readCycleState({
    stateRoot: fixture.stateRoot,
    targetId: fixture.target.targetId,
  })).committed_state.cursor, THROUGH_CURSOR_2);

  const emitted = [];
  const payload = {
    hook_event_name: "Stop",
    session_id: PARENT_SESSION_ID,
    turn_id: "cooldown-parent-turn",
    cwd: fixture.projectRoot,
    stop_hook_active: false,
  };
  assert.equal((await runParentStopHook({
    provider: "codex", payload, stateRoot: fixture.stateRoot, now: NOW,
  }, { emitHookOutput: async (value) => emitted.push(value) })).status, "emitted_unacked");
  assert.equal((await runParentStopHook({
    provider: "codex",
    payload: { ...payload, turn_id: "cooldown-parent-turn-2" },
    stateRoot: fixture.stateRoot,
    now: NOW,
  }, { emitHookOutput: async (value) => emitted.push(value) })).status, "no_message");
  assert.equal(emitted.length, 1);
});

test("誤providerはclaimせず、claim後emit失敗はdelivery_unknownとして再配送しない", async () => {
  const wrongRoute = await runCodexCycle(advisoryOutput());
  const wrong = await runParentStopHook({
    provider: "claude",
    payload: {
      hook_event_name: "Stop",
      session_id: PARENT_SESSION_ID,
      cwd: wrongRoute.fixture.projectRoot,
      stop_hook_active: false,
    },
    stateRoot: wrongRoute.fixture.stateRoot,
    now: NOW,
  }, { emitHookOutput: async () => assert.fail("誤providerはemitしてはいけません") });
  assert.equal(wrong.status, "no_message");
  const delivered = [];
  assert.equal((await runParentStopHook({
    provider: "codex",
    payload: {
      hook_event_name: "Stop",
      session_id: PARENT_SESSION_ID,
      turn_id: "correct-parent-turn",
      cwd: wrongRoute.fixture.projectRoot,
      stop_hook_active: false,
    },
    stateRoot: wrongRoute.fixture.stateRoot,
    now: NOW,
  }, { emitHookOutput: async (value) => delivered.push(value) })).status, "emitted_unacked");
  assert.equal(delivered.length, 1);

  const failedDelivery = await runCodexCycle(advisoryOutput());
  const failurePayload = {
    hook_event_name: "Stop",
    session_id: PARENT_SESSION_ID,
    turn_id: "failing-parent-turn",
    cwd: failedDelivery.fixture.projectRoot,
    stop_hook_active: false,
  };
  await assert.rejects(runParentStopHook({
    provider: "codex",
    payload: failurePayload,
    stateRoot: failedDelivery.fixture.stateRoot,
    now: NOW,
  }, { emitHookOutput: async () => { throw new Error("stdout closed"); } }), /stdout closed/);
  const retry = await runParentStopHook({
    provider: "codex",
    payload: { ...failurePayload, turn_id: "retry-parent-turn" },
    stateRoot: failedDelivery.fixture.stateRoot,
    now: NOW,
  }, { emitHookOutput: async () => assert.fail("delivery_unknown本文は再配送してはいけません") });
  assert.equal(retry.status, "no_message");
});

test("Claude runtime未実証はcycle state変更前にprovider_unavailableを返す", async () => {
  const fixture = await setupWatch("claude");
  let reads = 0;
  const result = await runSupervisorProductionStep({
    stateRoot: fixture.stateRoot,
    target: fixture.target,
    watchId: fixture.request.watch_id,
    client: {
      read: async () => { reads += 1; },
      wait: async () => { reads += 1; },
    },
    providerRuntime: null,
    planRefs: [],
    testReceipts: [],
  }, { now: () => NOW });
  assert.deepEqual(result, {
    schema: "observer.supervisor_production_result.v1",
    status: "provider_unavailable",
    provider: "claude",
    cycle_id: null,
  });
  assert.equal(reads, 0);
  assert.deepEqual(await readCycleState({
    stateRoot: fixture.stateRoot,
    targetId: fixture.target.targetId,
  }), { committed_state: null, pending_cycle: null });
});
