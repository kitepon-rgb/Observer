import assert from "node:assert/strict";
import test from "node:test";

import { advanceGenerationFaultProviderBinding } from "../src/generation-fault-provider-binding.mjs";
import { buildGenerationLaunchRequest } from "../src/parent-launch.mjs";

const TARGET = { schema: "observer.project_target.v1", targetId: `p_${"a".repeat(64)}`, projectRoot: "/project" };
const WATCH_ID = "w_11111111-1111-4111-8111-111111111111";
const CODEX_HANDLE = { kind: "codex.thread", value: "019f671e-87a6-7fb3-a6e7-8c800908206d" };
const CLAUDE_HANDLE = { kind: "claude.job", value: "raw-fault-job" };
const REQUEST = buildGenerationLaunchRequest({ target: TARGET, watchId: WATCH_ID, provider: "codex", runtimeRoot: "/observer" });
const CLAUDE_REQUEST = buildGenerationLaunchRequest({ target: TARGET, watchId: WATCH_ID, provider: "claude", runtimeRoot: "/observer" });

function faultStatus({ provider = "codex", action = "authorize_stop", status = "fault_recorded" } = {}) {
  return {
    schema: "observer.generation_fault_status.v1", provider, target_id: TARGET.targetId, watch_id: WATCH_ID,
    generation_id: `sha256:${"b".repeat(64)}`, parent_epoch_id: `sha256:${"c".repeat(64)}`,
    source_generation_status: "active", status, action, fault_code: "E_OBSERVER_PROVIDER_TERMINATED",
  };
}

function terminalReceipt(provider, handle) {
  return { schema: "observer.host_receipt.v1", provider, target_id: TARGET.targetId, watch_id: WATCH_ID, outcome: "stopped", handle };
}

function fixture(status = faultStatus()) {
  const calls = [];
  const handle = status.provider === "claude" ? CLAUDE_HANDLE : CODEX_HANDLE;
  const core = {
    readGenerationFaultStatus: async () => { calls.push("status"); return status; },
    prepareGenerationFaultStop: async () => {
      calls.push("prepare");
      return {
        schema: "observer.generation_fault_result.v1",
        action: status.action === "authorize_stop" ? "issue_once" : "observe_only",
        status,
        stop_request: {
          schema: "observer.parent_stop_request.v1", provider: status.provider, target_id: TARGET.targetId,
          watch_id: WATCH_ID, project_root: TARGET.projectRoot, handle, terminal: "faulted", fault_code: status.fault_code,
        },
      };
    },
    confirmGenerationFaultTerminal: async (input) => { calls.push("confirm"); core.confirmed = input; },
  };
  const codexRuntime = {
    observeCodexGenerationTerminal: async () => { calls.push("codex-observe"); return { outcome: "pending", receipt: null }; },
    stopCodexObserver: async () => { calls.push("codex-stop"); return { terminal_receipt: null }; },
  };
  const claudeRuntime = {
    observeClaudeObserver: async () => { calls.push("claude-observe"); return { observation: { state: "working" }, ready_receipt: null }; },
    stopClaudeObserver: async () => { calls.push("claude-stop"); },
  };
  return { calls, core, codexRuntime, claudeRuntime, handle };
}

function input(overrides = {}) {
  return { stateRoot: "/state", target: TARGET, watchId: WATCH_ID, launchRequest: REQUEST, session: {}, verification: null, ...overrides };
}

test("Codexはissue_onceで一度だけstopし、pending再開はobserve_onlyとしてstopを再送しない", async () => {
  const f = fixture();
  const first = await advanceGenerationFaultProviderBinding(input(), { fault: f.core, codexRuntime: f.codexRuntime, claudeRuntime: f.claudeRuntime });
  assert.deepEqual(f.calls, ["status", "prepare", "codex-observe", "codex-stop"]);
  assert.equal(first.outcome, "progressed");
  assert.equal(JSON.stringify(first).includes(CODEX_HANDLE.value), false);

  const pendingStatus = faultStatus({ action: "observe_terminal", status: "stop_authorized" });
  f.core.readGenerationFaultStatus = async () => { f.calls.push("status"); return pendingStatus; };
  f.core.prepareGenerationFaultStop = async () => {
    f.calls.push("prepare");
    return {
      schema: "observer.generation_fault_result.v1", action: "observe_only", status: pendingStatus,
      stop_request: {
        schema: "observer.parent_stop_request.v1", provider: "codex", target_id: TARGET.targetId,
        watch_id: WATCH_ID, project_root: TARGET.projectRoot, handle: CODEX_HANDLE, terminal: "faulted", fault_code: pendingStatus.fault_code,
      },
    };
  };
  const second = await advanceGenerationFaultProviderBinding(input(), { fault: f.core, codexRuntime: f.codexRuntime, claudeRuntime: f.claudeRuntime });
  assert.deepEqual(f.calls.slice(-3), ["status", "prepare", "codex-observe"]);
  assert.equal(second.outcome, "pending");
  assert.equal(f.calls.filter((call) => call === "codex-stop").length, 1);
});

test("Claude terminalは同じhandleのreceiptだけをcoreへ渡し、unknownは非terminalのまま返す", async () => {
  const f = fixture(faultStatus({ provider: "claude" }));
  f.claudeRuntime.observeClaudeObserver = async () => { f.calls.push("claude-observe"); return { observation: { state: "stopped" }, ready_receipt: null }; };
  const result = await advanceGenerationFaultProviderBinding(input({ launchRequest: CLAUDE_REQUEST, session: null, verification: {} }), {
    fault: f.core, codexRuntime: f.codexRuntime, claudeRuntime: f.claudeRuntime,
  });
  assert.deepEqual(f.calls, ["status", "prepare", "claude-observe", "confirm"]);
  assert.deepEqual(f.core.confirmed.terminalReceipt, terminalReceipt("claude", CLAUDE_HANDLE));
  assert.equal(result.phase, "faulted");
  assert.equal(result.outcome, "faulted");

  const unknown = fixture();
  unknown.codexRuntime.observeCodexGenerationTerminal = async () => { unknown.calls.push("codex-observe"); return { outcome: "unknown", receipt: null, reason: "handle_unknown" }; };
  const unknownResult = await advanceGenerationFaultProviderBinding(input(), { fault: unknown.core, codexRuntime: unknown.codexRuntime, claudeRuntime: unknown.claudeRuntime });
  assert.deepEqual(unknown.calls, ["status", "prepare", "codex-observe"]);
  assert.equal(unknownResult.outcome, "unknown");
  assert.equal(unknown.calls.includes("codex-stop"), false);
});

test("Codex terminal観測はalready-terminal stop経路のexact receiptだけをcoreへ渡す", async () => {
  const status = faultStatus({ action: "observe_terminal", status: "stop_authorized" });
  const f = fixture(status);
  const exact = {
    ...terminalReceipt("codex", CODEX_HANDLE),
    terminal: {
      schema: "observer.codex_turn_terminal.v1",
      thread_id: CODEX_HANDLE.value,
      turn_id: "019f671e-87a6-7fb3-a6e7-8c800908206e",
      status: "failed",
      observed_at: "2026-07-16T00:00:00.000Z",
    },
  };
  f.codexRuntime.observeCodexGenerationTerminal = async () => { f.calls.push("codex-observe"); return { outcome: "terminal", receipt: { terminal_status: "failed" } }; };
  f.codexRuntime.stopCodexObserver = async () => { f.calls.push("codex-stop"); return { terminal_receipt: exact }; };
  await advanceGenerationFaultProviderBinding(input(), { fault: f.core, codexRuntime: f.codexRuntime, claudeRuntime: f.claudeRuntime });
  assert.deepEqual(f.calls, ["status", "prepare", "codex-observe", "codex-stop", "confirm"]);
  assert.deepEqual(f.core.confirmed.terminalReceipt, exact);
});
