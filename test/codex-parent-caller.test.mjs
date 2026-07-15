import assert from "node:assert/strict";
import test from "node:test";

import { runCodexParentWatchProcess } from "../src/codex-parent-caller.mjs";

const STATE_ROOT = "/state";
const PROJECT_ROOT = "/project";
const RUNTIME_ROOT = "/observer";
const THROUGHLINE_COMMAND = "/bin/throughline";
const CODEX_COMMAND = "/bin/codex";
const TARGET_ID = `p_${"a".repeat(64)}`;
const WATCH_ID = "w_11111111-1111-4111-8111-111111111111";
const THREAD_ID = "019f62a1-1111-7111-8111-111111111111";
const THREAD_SHA = "b".repeat(64);

function input(overrides = {}) {
  return {
    stateRoot: STATE_ROOT,
    projectRoot: PROJECT_ROOT,
    runtimeRoot: RUNTIME_ROOT,
    throughlineCommand: THROUGHLINE_COMMAND,
    codexCommand: CODEX_COMMAND,
    parentContext: {
      schema: "observer.parent_watch_context.v1",
      parent_provider: "codex",
      runtime_root: RUNTIME_ROOT,
      expected_previous_watch_id: null,
      authorization: {
        schema: "observer.parent_authorization.v1",
        intent: "start_observer",
        parent_provider: "codex",
      },
    },
    ...overrides,
  };
}

function request() {
  return {
    schema: "observer.parent_launch_request.v1",
    provider: "codex",
    watch_id: WATCH_ID,
    target_id: TARGET_ID,
    project_root: PROJECT_ROOT,
    runtime_root: RUNTIME_ROOT,
    required_handle_kind: "codex.thread",
    child_start: {
      schema: "observer.child_start.v1",
      mode: "observe",
      provider: "codex",
      watch_id: WATCH_ID,
      target_id: TARGET_ID,
      project_root: PROJECT_ROOT,
      runtime_root: RUNTIME_ROOT,
    },
    host: {
      kind: "codex.app_server_thread.v1",
      cwd: RUNTIME_ROOT,
      approval_policy: "never",
      sandbox: "read-only",
      ephemeral: false,
      service_name: "observer",
    },
  };
}

function receipt(outcome) {
  return {
    schema: "observer.host_receipt.v1",
    outcome,
    provider: "codex",
    watch_id: WATCH_ID,
    target_id: TARGET_ID,
    handle: { kind: "codex.thread", value: THREAD_ID },
  };
}

function terminalReceipt() {
  return {
    ...receipt("stopped"),
    terminal: {
      schema: "observer.codex_turn_terminal.v1",
      status: "interrupted",
      thread_id: THREAD_ID,
      turn_id: THREAD_ID,
      observed_at: "2026-07-16T00:00:00.000Z",
    },
  };
}

function stopRequest() {
  return {
    schema: "observer.parent_stop_request.v1",
    provider: "codex",
    watch_id: WATCH_ID,
    target_id: TARGET_ID,
    project_root: PROJECT_ROOT,
    handle: { kind: "codex.thread", value: THREAD_ID },
    terminal: "stopped",
    fault_code: null,
  };
}

function stopResult({ commandReceipt = null, terminal = null } = {}) {
  return {
    schema: "observer.codex_host_stop_result.v1",
    command_receipt: commandReceipt,
    terminal_receipt: terminal,
    terminal_status: terminal === null ? null : terminal.terminal.status,
    journal: {},
  };
}

function currentParent() {
  return {
    schema: "throughline.observer_read.v1",
    status: "snapshot",
    host: "codex",
    thread_sha256: THREAD_SHA,
  };
}

function ownedRuntime(close = async () => {}) {
  const session = { request: async () => {} };
  return {
    providerRuntime: { provider: "codex", runtime_root: RUNTIME_ROOT, session },
    providerSignal: new AbortController().signal,
    advanceGenerationRollover: async () => {},
    prepareGenerationParentRebind: async () => {},
    advanceGenerationParentRebind: async () => {},
    close,
  };
}

function dependencies(overrides = {}) {
  const client = { read: async () => currentParent(), wait: async () => {} };
  return {
    runProductDiagnostics: async () => ({ schema: "observer.product_diagnostics.v1", status: "ready" }),
    verifyThroughlineRuntime: async () => ({ schema: "observer.throughline_process_verification.v1", runtime_root: RUNTIME_ROOT }),
    createVerifiedThroughlineClient: () => client,
    verifyCodexAppServerRuntime: async () => ({ schema: "observer.codex_process_verification.v1", runtime_root: RUNTIME_ROOT }),
    prepareParentLaunch: async () => request(),
    createCodexSupervisorRuntime: async () => ownedRuntime(),
    spawnCodexObserverThread: async () => ({ receipt: receipt("spawned") }),
    activateCodexObserver: async () => ({ watch_status: { status: "active" }, ready_receipt: receipt("ready") }),
    initializeGeneration: async () => {},
    readWatchStatus: async () => ({ watch_id: WATCH_ID, provider: "codex", status: "active" }),
    requestParentStop: async () => stopRequest(),
    stopCodexObserver: async () => stopResult({ terminal: terminalReceipt() }),
    completeParentStop: async () => {},
    runSupervisorProcess: async () => ({
      schema: "observer.supervisor_process_result.v1", status: "stopped", provider: "codex", cycle_id: null,
    }),
    ...overrides,
  };
}

test("Codex parent callerは検証からSupervisorまでを同じclient/session/ready receiptで固定順に進め、terminalをsanitizeする", async () => {
  const calls = [];
  const runtime = ownedRuntime();
  const client = { read: async () => { calls.push("parent"); return currentParent(); }, wait: async () => {} };
  const ready = receipt("ready");
  const result = await runCodexParentWatchProcess(input(), dependencies({
    runProductDiagnostics: async () => { calls.push("product"); return { schema: "observer.product_diagnostics.v1", status: "ready" }; },
    verifyThroughlineRuntime: async () => { calls.push("throughline"); return { schema: "observer.throughline_process_verification.v1", runtime_root: RUNTIME_ROOT }; },
    createVerifiedThroughlineClient: () => { calls.push("client"); return client; },
    verifyCodexAppServerRuntime: async () => { calls.push("codex"); return { schema: "observer.codex_process_verification.v1", runtime_root: RUNTIME_ROOT }; },
    prepareParentLaunch: async () => { calls.push("prepare"); return request(); },
    createCodexSupervisorRuntime: async () => { calls.push("runtime"); return runtime; },
    spawnCodexObserverThread: async ({ session }) => {
      calls.push("spawn"); assert.equal(session, runtime.providerRuntime.session); return { receipt: receipt("spawned") };
    },
    activateCodexObserver: async ({ session, spawnResult }) => {
      calls.push("activate"); assert.equal(session, runtime.providerRuntime.session); assert.equal(spawnResult.receipt.outcome, "spawned");
      return { watch_status: { status: "active" }, ready_receipt: ready };
    },
    initializeGeneration: async ({ parentThreadSha256, readyReceipt }) => {
      calls.push("generation"); assert.equal(parentThreadSha256, THREAD_SHA); assert.equal(readyReceipt, ready);
    },
    runSupervisorProcess: async ({ client: receivedClient, createProviderRuntime }) => {
      calls.push("supervisor");
      assert.equal(receivedClient, client);
      const managed = await createProviderRuntime();
      assert.notEqual(managed, runtime);
      assert.equal(managed.providerRuntime, runtime.providerRuntime);
      assert.equal(managed.providerRuntime.session, runtime.providerRuntime.session);
      return { schema: "observer.supervisor_process_result.v1", status: "stopped", provider: "codex", cycle_id: null, secret: "omit" };
    },
  }));
  assert.deepEqual(calls, ["product", "throughline", "client", "codex", "parent", "prepare", "runtime", "spawn", "activate", "generation", "supervisor"]);
  assert.deepEqual(result, { schema: "observer.codex_parent_caller_result.v1", status: "stopped", provider: "codex", cycle_id: null });
});

test("Codex以外の親contextはproduct検証・watch予約より前にfail loudする", async () => {
  let touched = 0;
  await assert.rejects(runCodexParentWatchProcess(input({ parentContext: { ...input().parentContext, parent_provider: "claude", authorization: { ...input().parentContext.authorization, parent_provider: "claude" } } }), dependencies({
    runProductDiagnostics: async () => { touched += 1; },
    prepareParentLaunch: async () => { touched += 1; },
  })), { code: "E_CODEX_PARENT_CONTEXT_MISMATCH" });
  assert.equal(touched, 0);
});

test("Codex runtime verificationのidentity不一致はparent read・watch予約より前にfail loudする", async () => {
  let parentReads = 0;
  let reservations = 0;
  await assert.rejects(runCodexParentWatchProcess(input(), dependencies({
    createVerifiedThroughlineClient: () => ({
      read: async () => { parentReads += 1; return currentParent(); },
      wait: async () => {},
    }),
    verifyCodexAppServerRuntime: async () => ({
      schema: "observer.codex_process_verification.v1",
      runtime_root: "/different-observer",
    }),
    prepareParentLaunch: async () => { reservations += 1; return request(); },
  })), { code: "E_CODEX_PARENT_RUNTIME_INVALID" });
  assert.equal(parentReads, 0);
  assert.equal(reservations, 0);
});

test("spawn unknownは別runtime・別spawnへretryせず、予約済みwatchを成功扱いしない", async () => {
  const unknown = Object.assign(new Error("spawn unknown"), { code: "E_CODEX_THREAD_START_UNKNOWN" });
  let runtimes = 0;
  let spawns = 0;
  let activations = 0;
  let generations = 0;
  let closes = 0;
  await assert.rejects(runCodexParentWatchProcess(input(), dependencies({
    createCodexSupervisorRuntime: async () => {
      runtimes += 1;
      return ownedRuntime(async () => { closes += 1; });
    },
    spawnCodexObserverThread: async () => { spawns += 1; throw unknown; },
    activateCodexObserver: async () => { activations += 1; },
    initializeGeneration: async () => { generations += 1; },
  })), (error) => error === unknown);
  assert.deepEqual({ runtimes, spawns, activations, generations, closes }, {
    runtimes: 1, spawns: 1, activations: 0, generations: 0, closes: 1,
  });
});

test("ready unknownは別runtime・別turnへretryせず、generationを作らない", async () => {
  const unknown = Object.assign(new Error("ready unknown"), { code: "E_CODEX_TURN_START_UNKNOWN" });
  let runtimes = 0;
  let spawns = 0;
  let activations = 0;
  let generations = 0;
  let closes = 0;
  await assert.rejects(runCodexParentWatchProcess(input(), dependencies({
    createCodexSupervisorRuntime: async () => {
      runtimes += 1;
      return ownedRuntime(async () => { closes += 1; });
    },
    spawnCodexObserverThread: async () => { spawns += 1; return { receipt: receipt("spawned") }; },
    activateCodexObserver: async () => { activations += 1; throw unknown; },
    initializeGeneration: async () => { generations += 1; },
  })), (error) => error === unknown);
  assert.deepEqual({ runtimes, spawns, activations, generations, closes }, {
    runtimes: 1, spawns: 1, activations: 1, generations: 0, closes: 1,
  });
});

test("generation conflictは再試行・別runtime・別spawnへ丸めず、所有runtimeを一度だけ閉じる", async () => {
  let runtimes = 0;
  let spawns = 0;
  let closes = 0;
  const conflict = Object.assign(new Error("generation conflict"), { code: "E_GENERATION_ALREADY_EXISTS" });
  await assert.rejects(runCodexParentWatchProcess(input(), dependencies({
    createCodexSupervisorRuntime: async () => { runtimes += 1; return ownedRuntime(async () => { closes += 1; }); },
    spawnCodexObserverThread: async () => { spawns += 1; return { receipt: receipt("spawned") }; },
    initializeGeneration: async () => { throw conflict; },
  })), (error) => error === conflict);
  assert.equal(runtimes, 1);
  assert.equal(spawns, 1);
  assert.equal(closes, 1);
});

test("Supervisorがownershipをclaimする前の失敗だけcallerがcloseし、claim後は二重closeしない", async () => {
  let preClaimCloses = 0;
  await assert.rejects(runCodexParentWatchProcess(input(), dependencies({
    createCodexSupervisorRuntime: async () => ownedRuntime(async () => { preClaimCloses += 1; }),
    runSupervisorProcess: async () => { throw new Error("before claim"); },
  })), /before claim/);
  assert.equal(preClaimCloses, 1);

  let claimedCloses = 0;
  await assert.rejects(runCodexParentWatchProcess(input(), dependencies({
    createCodexSupervisorRuntime: async () => ownedRuntime(async () => { claimedCloses += 1; }),
    runSupervisorProcess: async ({ createProviderRuntime }) => {
      await createProviderRuntime();
      throw new Error("after claim");
    },
  })), /after claim/);
  assert.equal(claimedCloses, 0);
});

test("Supervisorのmanaged closeは同一transportでstop commandからterminal確認、watch完了、base closeまでを固定順に進める", async () => {
  const calls = [];
  const runtime = ownedRuntime(async () => { calls.push("base-close"); });
  const commandReceipt = { schema: "observer.codex_interrupt_receipt.v1", marker: "interrupt" };
  const terminal = terminalReceipt();
  await runCodexParentWatchProcess(input({ stopAttempts: 2, stopPollIntervalMs: 100 }), dependencies({
    createCodexSupervisorRuntime: async () => runtime,
    readWatchStatus: async () => { calls.push("read-watch"); return { watch_id: WATCH_ID, provider: "codex", status: "active" }; },
    requestParentStop: async () => { calls.push("request-stop"); return stopRequest(); },
    stopCodexObserver: async ({ session, previousInterruptReceipt }) => {
      assert.equal(session, runtime.providerRuntime.session);
      if (previousInterruptReceipt === null) {
        calls.push("interrupt-command");
        return stopResult({ commandReceipt });
      }
      calls.push("terminal-receipt");
      assert.equal(previousInterruptReceipt, commandReceipt);
      return stopResult({ commandReceipt, terminal });
    },
    waitForStopPoll: async (milliseconds) => { calls.push(`poll:${milliseconds}`); },
    completeParentStop: async ({ request: receivedRequest, receipt: receivedReceipt }) => {
      calls.push("complete");
      assert.deepEqual(receivedRequest, stopRequest());
      assert.equal(receivedReceipt, terminal);
    },
    runSupervisorProcess: async ({ createProviderRuntime }) => {
      await (await createProviderRuntime()).close();
      return { schema: "observer.supervisor_process_result.v1", status: "stopped", provider: "codex", cycle_id: null };
    },
  }));
  assert.deepEqual(calls, ["read-watch", "request-stop", "interrupt-command", "poll:100", "terminal-receipt", "complete", "base-close"]);
});

test("bounded attempts内にterminalが無ければcompleteせずbase transportを閉じてunknownを返す", async () => {
  const calls = [];
  const runtime = ownedRuntime(async () => { calls.push("base-close"); });
  const commandReceipt = { schema: "observer.codex_interrupt_receipt.v1", marker: "interrupt" };
  await assert.rejects(runCodexParentWatchProcess(input({ stopAttempts: 2, stopPollIntervalMs: 100 }), dependencies({
    createCodexSupervisorRuntime: async () => runtime,
    readWatchStatus: async () => ({ watch_id: WATCH_ID, provider: "codex", status: "active" }),
    requestParentStop: async () => { calls.push("request-stop"); return stopRequest(); },
    stopCodexObserver: async ({ previousInterruptReceipt }) => {
      calls.push(previousInterruptReceipt === null ? "interrupt-command" : "terminal-pending");
      return stopResult({ commandReceipt });
    },
    waitForStopPoll: async (milliseconds) => { calls.push(`poll:${milliseconds}`); },
    completeParentStop: async () => { calls.push("complete"); },
    runSupervisorProcess: async ({ createProviderRuntime }) => {
      await (await createProviderRuntime()).close();
      return { schema: "observer.supervisor_process_result.v1", status: "stopped", provider: "codex", cycle_id: null };
    },
  })), { code: "E_CODEX_PARENT_STOP_TERMINAL_UNKNOWN" });
  assert.deepEqual(calls, ["request-stop", "interrupt-command", "poll:100", "terminal-pending", "base-close"]);
});
