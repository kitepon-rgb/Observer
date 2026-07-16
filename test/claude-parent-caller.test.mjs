import assert from "node:assert/strict";
import test from "node:test";

import { runClaudeParentWatchProcess } from "../src/claude-parent-caller.mjs";
import { ObserverError } from "../src/observer-error.mjs";

const TARGET_ID = `p_${"a".repeat(64)}`;
const WATCH_ID = "w_11111111-1111-4111-8111-111111111111";
const SESSION_ID = "obs_aaaaaaaaaaaa_11111111111141118111111111111111";

function claudeInput() {
  return {
    stateRoot: "/state",
    projectRoot: "/project",
    runtimeRoot: "/observer",
    throughlineCommand: "/bin/throughline",
    aitermCommand: "/bin/aiterm",
    parentContext: {
      schema: "observer.parent_watch_context.v1",
      parent_provider: "claude",
      runtime_root: "/observer",
      expected_previous_watch_id: null,
      authorization: {
        schema: "observer.parent_authorization.v1",
        intent: "start_observer",
        parent_provider: "claude",
      },
    },
  };
}

function claudeRequest() {
  return {
    schema: "observer.parent_launch_request.v1",
    provider: "claude",
    watch_id: WATCH_ID,
    target_id: TARGET_ID,
    project_root: "/project",
    runtime_root: "/observer",
    required_handle_kind: "claude.session",
    host: { kind: "aiterm.claude_agent.v1", cwd: "/observer", agent_done: true, session_name: SESSION_ID },
    child_start: {
      schema: "observer.child_start.v1",
      mode: "observe",
      provider: "claude",
      watch_id: WATCH_ID,
      target_id: TARGET_ID,
      project_root: "/project",
      runtime_root: "/observer",
    },
  };
}

function claudeReceipt(outcome = "spawned") {
  return {
    schema: "observer.host_receipt.v1",
    provider: "claude",
    watch_id: WATCH_ID,
    target_id: TARGET_ID,
    outcome,
    handle: { kind: "claude.session", value: SESSION_ID },
  };
}

function claudeFailedLaunchStopRequest() {
  return {
    schema: "observer.parent_stop_request.v1",
    provider: "claude",
    watch_id: WATCH_ID,
    target_id: TARGET_ID,
    project_root: "/project",
    handle: { kind: "claude.session", value: SESSION_ID },
    terminal: "faulted",
    fault_code: "E_OBSERVER_LAUNCH_CONFIRM_FAILED",
  };
}

function claudeRuntime(close = async () => {}) {
  return {
    providerRuntime: {
      provider: "claude",
      runtime_root: "/observer",
      session_id: SESSION_ID,
      transport: { callTool: async () => {} },
    },
    providerSignal: new AbortController().signal,
    advanceGenerationRollover: async () => {},
    prepareGenerationParentRebind: async () => {},
    advanceGenerationParentRebind: async () => {},
    close,
  };
}

function claudeDependencies(overrides = {}) {
  return {
    runProductDiagnostics: async () => ({ schema: "observer.product_diagnostics.v1", status: "ready" }),
    verifyThroughlineRuntime: async () => ({ schema: "observer.throughline_process_verification.v1", runtime_root: "/observer" }),
    createVerifiedThroughlineClient: () => ({
      read: async () => ({ schema: "throughline.observer_read.v1", status: "snapshot", host: "claude", thread_sha256: "b".repeat(64) }),
      wait: async () => {},
    }),
    verifyAitermRuntime: async () => ({ schema: "observer.aiterm_process_verification.v1", runtime_root: "/observer" }),
    prepareAitermClaudeParentLaunch: async () => claudeRequest(),
    createClaudeSupervisorRuntime: async () => claudeRuntime(),
    spawnAitermClaudeObserver: async () => ({ receipt: claudeReceipt() }),
    activateAitermClaudeObserver: async () => ({
      ready_receipt: claudeReceipt("ready"),
      watch_status: { status: "active" },
      generation: { status: "active", provider: "claude", target_id: TARGET_ID, watch_id: WATCH_ID },
    }),
    attachClaudeSessionShutdown: (owned) => owned,
    runSupervisorProcess: async () => ({
      schema: "observer.supervisor_process_result.v1", status: "stopped", provider: "claude", cycle_id: null,
    }),
    ...overrides,
  };
}

test("Claude parent callerはdurable launch→active→generation後に一度だけSupervisorへruntime所有権を譲渡する", async () => {
  const calls = [];
  const runtime = { providerRuntime: { provider: "claude", runtime_root: "/observer", session_id: SESSION_ID, transport: { callTool: async () => {} } }, providerSignal: new AbortController().signal, advanceGenerationRollover: async () => {}, prepareGenerationParentRebind: async () => {}, advanceGenerationParentRebind: async () => {}, close: async () => { calls.push("close"); } };
  const result = await runClaudeParentWatchProcess({ stateRoot: "/state", projectRoot: "/project", runtimeRoot: "/observer", throughlineCommand: "/bin/throughline", aitermCommand: "/bin/aiterm", parentContext: { schema: "observer.parent_watch_context.v1", parent_provider: "claude", runtime_root: "/observer", expected_previous_watch_id: null, authorization: { schema: "observer.parent_authorization.v1", intent: "start_observer", parent_provider: "claude" } } }, {
    runProductDiagnostics: async () => { calls.push("product"); return { schema: "observer.product_diagnostics.v1", status: "ready" }; },
    verifyThroughlineRuntime: async () => { calls.push("throughline"); return { schema: "observer.throughline_process_verification.v1", runtime_root: "/observer" }; },
    createVerifiedThroughlineClient: () => ({ read: async () => ({ schema: "throughline.observer_read.v1", status: "snapshot", host: "claude", thread_sha256: "b".repeat(64) }), wait: async () => {} }),
    verifyAitermRuntime: async () => { calls.push("aiterm"); return { schema: "observer.aiterm_process_verification.v1", runtime_root: "/observer" }; },
    prepareAitermClaudeParentLaunch: async () => { calls.push("prepare"); return { schema: "observer.parent_launch_request.v1", provider: "claude", watch_id: WATCH_ID, target_id: TARGET_ID, project_root: "/project", runtime_root: "/observer", required_handle_kind: "claude.session", host: { kind: "aiterm.claude_agent.v1", cwd: "/observer", agent_done: true, session_name: SESSION_ID }, child_start: { schema: "observer.child_start.v1", mode: "observe", provider: "claude", watch_id: WATCH_ID, target_id: TARGET_ID, project_root: "/project", runtime_root: "/observer" } }; },
    createClaudeSupervisorRuntime: async () => { calls.push("runtime"); return runtime; },
    spawnAitermClaudeObserver: async () => { calls.push("spawn"); return { receipt: { schema: "observer.host_receipt.v1", provider: "claude", watch_id: WATCH_ID, target_id: TARGET_ID, outcome: "spawned", handle: { kind: "claude.session", value: SESSION_ID } } }; },
    attachClaudeSessionShutdown: (owned) => { calls.push("shutdown"); return owned; },
    activateAitermClaudeObserver: async () => { calls.push("activate"); return { ready_receipt: { schema: "observer.host_receipt.v1", provider: "claude", watch_id: WATCH_ID, target_id: TARGET_ID, outcome: "ready", handle: { kind: "claude.session", value: SESSION_ID } }, watch_status: { status: "active" }, generation: { schema: "observer.generation_state.v1", status: "active", provider: "claude", target_id: TARGET_ID, watch_id: WATCH_ID, generation_id: `sha256:${"c".repeat(64)}`, parent_epoch_id: `sha256:${"d".repeat(64)}` } }; },
    runSupervisorProcess: async ({ createProviderRuntime }) => { calls.push("supervisor"); assert.equal((await createProviderRuntime()).providerRuntime, runtime.providerRuntime); return { schema: "observer.supervisor_process_result.v1", status: "stopped", provider: "claude", cycle_id: null }; },
  });
  assert.deepEqual(calls, ["product", "throughline", "aiterm", "prepare", "runtime", "spawn", "activate", "shutdown", "supervisor"]);
  assert.deepEqual(result, { schema: "observer.claude_parent_caller_result.v1", status: "stopped", provider: "claude", cycle_id: null });
});

test("Claude parent contextとAiterm verificationの不一致はwatch予約前にfail loudする", async () => {
  const base = { stateRoot: "/state", projectRoot: "/project", runtimeRoot: "/observer", throughlineCommand: "/bin/throughline", aitermCommand: "/bin/aiterm" };
  const context = { schema: "observer.parent_watch_context.v1", parent_provider: "claude", runtime_root: "/observer", expected_previous_watch_id: null, authorization: { schema: "observer.parent_authorization.v1", intent: "start_observer", parent_provider: "claude" } };
  let touched = 0;
  await assert.rejects(runClaudeParentWatchProcess({ ...base, parentContext: { ...context, runtime_root: "/other" } }, {
    runProductDiagnostics: async () => { touched += 1; },
    prepareAitermClaudeParentLaunch: async () => { touched += 1; },
  }), { code: "E_CLAUDE_PARENT_CONTEXT_MISMATCH" });
  assert.equal(touched, 0);
  let reserved = 0;
  await assert.rejects(runClaudeParentWatchProcess({ ...base, parentContext: context }, {
    runProductDiagnostics: async () => ({ schema: "observer.product_diagnostics.v1", status: "ready" }),
    verifyThroughlineRuntime: async () => ({ schema: "observer.throughline_process_verification.v1", runtime_root: "/observer" }),
    createVerifiedThroughlineClient: () => ({ read: async () => assert.fail("parent read must not occur"), wait: async () => {} }),
    verifyAitermRuntime: async () => ({ schema: "observer.aiterm_process_verification.v1", runtime_root: "/other" }),
    prepareAitermClaudeParentLaunch: async () => { reserved += 1; },
  }), { code: "E_CLAUDE_PARENT_RUNTIME_INVALID" });
  assert.equal(reserved, 0);
});

test("Claude parent callerはlaunch response lossを同じsessionのexact recoveryで回収する", async () => {
  const calls = [];
  const request = { schema: "observer.parent_launch_request.v1", provider: "claude", watch_id: WATCH_ID, target_id: TARGET_ID, project_root: "/project", runtime_root: "/observer", required_handle_kind: "claude.session", host: { kind: "aiterm.claude_agent.v1", cwd: "/observer", agent_done: true, session_name: SESSION_ID }, child_start: { schema: "observer.child_start.v1", mode: "observe", provider: "claude", watch_id: WATCH_ID, target_id: TARGET_ID, project_root: "/project", runtime_root: "/observer" } };
  const receipt = { schema: "observer.host_receipt.v1", provider: "claude", watch_id: WATCH_ID, target_id: TARGET_ID, outcome: "spawned", handle: { kind: "claude.session", value: SESSION_ID } };
  const runtime = { providerRuntime: { provider: "claude", runtime_root: "/observer", session_id: SESSION_ID, transport: { callTool: async () => {} } }, providerSignal: new AbortController().signal, advanceGenerationRollover: async () => {}, prepareGenerationParentRebind: async () => {}, advanceGenerationParentRebind: async () => {}, close: async () => {} };
  await runClaudeParentWatchProcess({ stateRoot: "/state", projectRoot: "/project", runtimeRoot: "/observer", throughlineCommand: "/bin/throughline", aitermCommand: "/bin/aiterm", parentContext: { schema: "observer.parent_watch_context.v1", parent_provider: "claude", runtime_root: "/observer", expected_previous_watch_id: null, authorization: { schema: "observer.parent_authorization.v1", intent: "start_observer", parent_provider: "claude" } } }, {
    runProductDiagnostics: async () => ({ schema: "observer.product_diagnostics.v1", status: "ready" }),
    verifyThroughlineRuntime: async () => ({ schema: "observer.throughline_process_verification.v1", runtime_root: "/observer" }),
    createVerifiedThroughlineClient: () => ({ read: async () => ({ schema: "throughline.observer_read.v1", status: "snapshot", host: "claude", thread_sha256: "b".repeat(64) }), wait: async () => {} }),
    verifyAitermRuntime: async () => ({ schema: "observer.aiterm_process_verification.v1", runtime_root: "/observer" }),
    prepareAitermClaudeParentLaunch: async () => request,
    createClaudeSupervisorRuntime: async () => runtime,
    spawnAitermClaudeObserver: async () => { calls.push("spawn"); throw new ObserverError("E_AITERM_CLAUDE_LAUNCH_UNKNOWN", "unknown"); },
    recoverAitermClaudeSpawn: async () => { calls.push("recover"); return { schema: "observer.aiterm_claude_recovery_result.v1", outcome: "spawned", reason: null, receipt }; },
    attachClaudeSessionShutdown: (owned) => owned,
    activateAitermClaudeObserver: async () => ({ ready_receipt: { ...receipt, outcome: "ready" }, watch_status: { status: "active" }, generation: { schema: "observer.generation_state.v1", status: "active", provider: "claude", target_id: TARGET_ID, watch_id: WATCH_ID, generation_id: `sha256:${"c".repeat(64)}`, parent_epoch_id: `sha256:${"d".repeat(64)}` } }),
    runSupervisorProcess: async () => ({ schema: "observer.supervisor_process_result.v1", status: "stopped", provider: "claude", cycle_id: null }),
  });
  assert.deepEqual(calls, ["spawn", "recover"]);
});

test("Claude ready前失敗は同じsession terminal後にwatch faulted、MCP closeへ進む", async () => {
  const calls = [];
  const failure = new Error("ready failed");
  const runtime = claudeRuntime(async () => { calls.push("mcp-close"); });
  await assert.rejects(runClaudeParentWatchProcess(claudeInput(), claudeDependencies({
    createClaudeSupervisorRuntime: async () => runtime,
    attachClaudeSessionShutdown: () => { calls.push("attach-normal-shutdown"); return runtime; },
    activateAitermClaudeObserver: async () => { calls.push("ready-failed"); throw failure; },
    requestParentLaunchFailureCleanup: async ({ request, receipt, faultCode }) => {
      calls.push("cleanup-request");
      assert.deepEqual(request, claudeRequest());
      assert.deepEqual(receipt, claudeReceipt());
      assert.equal(faultCode, "E_OBSERVER_LAUNCH_CONFIRM_FAILED");
      return claudeFailedLaunchStopRequest();
    },
    stopAitermClaudeObserver: async ({ request, transport }) => {
      calls.push("session-terminal");
      assert.deepEqual(request, claudeFailedLaunchStopRequest());
      assert.equal(transport, runtime.providerRuntime.transport);
      return {
        schema: "observer.aiterm_claude_stop_result.v1",
        terminal_receipt: claudeReceipt("stopped"),
        stop_command_receipt: { schema: "aiterm.pty-close-result.v1" },
      };
    },
    completeParentStop: async ({ request, receipt }) => {
      calls.push("watch-faulted");
      assert.deepEqual(request, claudeFailedLaunchStopRequest());
      assert.deepEqual(receipt, claudeReceipt("stopped"));
    },
    runSupervisorProcess: async () => { assert.fail("Supervisorへ渡さない"); },
  })), (error) => error === failure);
  assert.deepEqual(calls, ["ready-failed", "cleanup-request", "session-terminal", "watch-faulted", "mcp-close"]);
});

test("Claude pre-ready terminal receiptのhandle不一致はwatch faultへ丸めない", async () => {
  const failure = new Error("ready failed");
  let completed = 0;
  let closes = 0;
  await assert.rejects(runClaudeParentWatchProcess(claudeInput(), claudeDependencies({
    createClaudeSupervisorRuntime: async () => claudeRuntime(async () => { closes += 1; }),
    activateAitermClaudeObserver: async () => { throw failure; },
    requestParentLaunchFailureCleanup: async () => claudeFailedLaunchStopRequest(),
    stopAitermClaudeObserver: async () => ({
      schema: "observer.aiterm_claude_stop_result.v1",
      terminal_receipt: {
        ...claudeReceipt("stopped"),
        handle: { kind: "claude.session", value: "obs_wrong_session" },
      },
      stop_command_receipt: { schema: "aiterm.pty-close-result.v1" },
    }),
    completeParentStop: async () => { completed += 1; },
  })), (error) => error instanceof AggregateError && error.errors[0] === failure &&
      error.errors[1]?.code === "E_CLAUDE_PARENT_STOP_RESULT_INVALID");
  assert.equal(completed, 0);
  assert.equal(closes, 1);
});
