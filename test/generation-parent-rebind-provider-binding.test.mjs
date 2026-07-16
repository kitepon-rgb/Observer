import assert from "node:assert/strict";
import test from "node:test";

import { advanceGenerationParentRebindProviderBinding } from "../src/generation-parent-rebind-provider-binding.mjs";

const TARGET = { schema: "observer.project_target.v1", targetId: `p_${"a".repeat(64)}`, projectRoot: "/monitored/project" };
const WATCH = "w_11111111-1111-4111-8111-111111111111";
const AUTHORIZATION = { opaque: "core-validates-this" };
const REQUEST = { provider: "codex", target_id: TARGET.targetId, watch_id: WATCH, runtime_root: "/observer" };
const HANDLE = { kind: "codex.thread", value: "raw-thread-handle" };
const receipt = (provider, outcome) => ({ schema: "observer.host_receipt.v1", provider, target_id: TARGET.targetId, watch_id: WATCH, outcome, handle: HANDLE });
const ACTION_STATUS = {
  authorize_stop: "rebind_required",
  observe_terminal: "stop_authorized",
  authorize_start: "terminal_observed",
  recover_spawn: "spawn_authorized",
  recover_ready: "spawn_observed",
  finish_activation: "ready_observed",
};

function fixture({ action, from = "codex", to = "codex", status = null } = {}) {
  const calls = [];
  const effectiveStatus = status ?? ACTION_STATUS[action];
  const context = {
    schema: "observer.generation_parent_rebind_status.v1",
    target_id: TARGET.targetId,
    watch_id: WATCH,
    from_provider: from,
    to_provider: to,
    from_parent_epoch_id: `sha256:${"a".repeat(64)}`,
    to_parent_epoch_id: `sha256:${"b".repeat(64)}`,
    from_generation_id: `sha256:${"c".repeat(64)}`,
    to_generation_id: ["spawn_authorized", "spawn_observed", "ready_observed"].includes(effectiveStatus)
      ? `sha256:${"d".repeat(64)}`
      : null,
    status: effectiveStatus,
    action,
  };
  const core = {
    readGenerationParentRebindRecoveryContext: async (input) => {
      calls.push("status");
      core.recovery = input;
      return context;
    },
    prepareGenerationParentRebindStop: async () => { calls.push("prepare-stop"); return { outcome: action === "authorize_stop" ? "issue_once" : "observe_only", from_provider: from, stop_request: { handle: HANDLE } }; },
    confirmGenerationParentRebindTerminal: async () => calls.push("confirm-terminal"),
    authorizeReboundGenerationStart: async (input) => { calls.push("authorize-start"); core.authorized = input; return { outcome: "issue_once", generation_id: "sha256:next" }; },
    recordReboundGenerationSpawn: async () => calls.push("record-spawn"),
    activateReboundGeneration: async () => calls.push("activate"),
  };
  const codexRuntime = {
    stopCodexObserver: async (input) => {
      calls.push("codex-stop");
      codexRuntime.stop = input;
      return { terminal_receipt: receipt("codex", "stopped") };
    },
    spawnCodexGenerationObserverThread: async () => calls.push("codex-spawn"),
    recoverCodexGenerationSpawn: async () => { calls.push("recover-spawn"); return { outcome: "spawned", receipt: receipt("codex", "spawned") }; },
    activateCodexGenerationObserver: async () => { calls.push("codex-ready-command"); return { ready_receipt: receipt("codex", "ready") }; },
    recoverCodexGenerationReady: async () => { calls.push("recover-ready"); return { outcome: "ready", receipt: receipt("codex", "ready") }; },
  };
  const claudeRuntime = {
    observeClaudeObserver: async (input) => { calls.push("claude-observe"); claudeRuntime.observed = input; return { observation: { state: "working", job_id: HANDLE.value }, ready_receipt: receipt("claude", "ready") }; },
    stopClaudeObserver: async () => calls.push("claude-stop"),
    spawnClaudeObserver: async () => calls.push("claude-spawn"),
    recoverClaudeSpawn: async () => { calls.push("claude-recover-spawn"); return { receipt: receipt("claude", "spawned") }; },
  };
  core.context = context;
  return { calls, core, codexRuntime, claudeRuntime };
}

function input(overrides = {}) {
  return {
    stateRoot: "/state", target: TARGET, watchId: WATCH, authorization: AUTHORIZATION, launchRequest: REQUEST,
    oldVerification: null, oldSession: {}, newVerification: null, newSession: {}, ...overrides,
  };
}

test("cross-provider old Codex terminalはold provider用に再構成したrequestだけを使い、terminal前にspawnしない", async () => {
  const f = fixture({ action: "observe_terminal", from: "codex", to: "claude" });
  const result = await advanceGenerationParentRebindProviderBinding(input({ launchRequest: { ...REQUEST, provider: "claude" }, oldSession: {}, newVerification: {}, newSession: null }), {
    rebind: f.core, codexRuntime: f.codexRuntime, claudeRuntime: f.claudeRuntime,
  });
  assert.deepEqual(f.calls, ["status", "prepare-stop", "codex-stop", "confirm-terminal"]);
  assert.equal(f.codexRuntime.stop.launchRequest.provider, "codex");
  assert.equal(f.core.recovery.authorization, AUTHORIZATION);
  assert.equal(f.core.recovery.launchRequest.provider, "claude");
  assert.equal(result.phase, "terminal_observed");
  assert.equal(JSON.stringify(result).includes("raw-thread-handle"), false);
});

test("new Codex spawn recoveryはreceiptを先にrecordして、turn/startは次actionで一度だけ発行する", async () => {
  const f = fixture({ action: "recover_spawn" });
  const first = await advanceGenerationParentRebindProviderBinding(input(), { rebind: f.core, codexRuntime: f.codexRuntime, claudeRuntime: f.claudeRuntime });
  assert.deepEqual(f.calls, ["status", "recover-spawn", "record-spawn"]);
  assert.equal(first.phase, "spawn_observed");

  f.core.readGenerationParentRebindRecoveryContext = async () => ({
    ...f.core.context,
    status: "spawn_observed",
    action: "recover_ready",
  });
  const second = await advanceGenerationParentRebindProviderBinding(input(), { rebind: f.core, codexRuntime: f.codexRuntime, claudeRuntime: f.claudeRuntime });
  assert.deepEqual(f.calls.slice(-2), ["recover-ready", "activate"]);
  assert.equal(second.outcome, "activated");
});

test("Codex thread_createdだけは保存済みthreadを回収してturn/startを一度だけ発行する", async () => {
  const f = fixture({ action: "recover_ready" });
  f.codexRuntime.recoverCodexGenerationReady = async () => {
    f.calls.push("recover-ready");
    return { outcome: "unknown", reason: "thread_created", receipt: null };
  };
  const result = await advanceGenerationParentRebindProviderBinding(input(), {
    rebind: f.core, codexRuntime: f.codexRuntime, claudeRuntime: f.claudeRuntime,
  });
  assert.deepEqual(f.calls, ["status", "recover-ready", "recover-spawn", "codex-ready-command", "activate"]);
  assert.equal(result.outcome, "activated");
});

test("Codex turn_start_unknownは別turnを発行せずunknownのまま返す", async () => {
  const f = fixture({ action: "recover_ready" });
  f.codexRuntime.recoverCodexGenerationReady = async () => {
    f.calls.push("recover-ready");
    return { outcome: "unknown", reason: "turn_start_unknown", receipt: null };
  };
  const result = await advanceGenerationParentRebindProviderBinding(input(), {
    rebind: f.core, codexRuntime: f.codexRuntime, claudeRuntime: f.claudeRuntime,
  });
  assert.deepEqual(f.calls, ["status", "recover-ready"]);
  assert.equal(result.outcome, "unknown");
  assert.equal(result.reason, "turn_start_unknown");
});

test("same-provider Claudeはauthorizationをcoreで照合してspawn一件だけを発行する", async () => {
  const f = fixture({ action: "authorize_start", from: "claude", to: "claude", status: "terminal_observed" });
  const request = { ...REQUEST, provider: "claude" };
  const result = await advanceGenerationParentRebindProviderBinding(input({ launchRequest: request, oldVerification: null, oldSession: null, newVerification: {}, newSession: null }), {
    rebind: f.core, codexRuntime: f.codexRuntime, claudeRuntime: f.claudeRuntime,
  });
  assert.deepEqual(f.calls, ["status", "authorize-start", "claude-spawn"]);
  assert.equal(f.core.authorized.authorization, AUTHORIZATION);
  assert.equal(result.phase, "spawn_authorized");
});

test("same-provider Claude Aiterm rebindは新generation sessionだけをspawnし、旧receiptを渡さない", async () => {
  const f = fixture({ action: "authorize_start", from: "claude", to: "claude", status: "terminal_observed" });
  const request = { ...REQUEST, provider: "claude", required_handle_kind: "claude.session", host: { session_name: "claude_next_generation" } };
  const aitermClaudeRuntime = {
    spawnAitermClaudeObserver: async (input) => { f.calls.push("aiterm-spawn"); aitermClaudeRuntime.input = input; },
  };
  const result = await advanceGenerationParentRebindProviderBinding(input({
    launchRequest: request, oldVerification: null, oldSession: { id: "old" }, newVerification: null, newSession: { id: "next" },
  }), { rebind: f.core, codexRuntime: f.codexRuntime, claudeRuntime: f.claudeRuntime, aitermClaudeRuntime });
  assert.deepEqual(f.calls, ["status", "authorize-start", "aiterm-spawn"]);
  assert.equal(aitermClaudeRuntime.input.request, request);
  assert.equal(aitermClaudeRuntime.input.transport.id, "next");
  assert.equal(JSON.stringify(aitermClaudeRuntime.input).includes("old"), false);
  assert.equal(result.phase, "spawn_authorized");
});

test("same-provider Claude Aiterm rebindはstructured close receiptをcore terminalへ渡す", async () => {
  const f = fixture({ action: "observe_terminal", from: "claude", to: "claude" });
  const closeReceipt = { schema: "aiterm.pty-close-result.v1", session_id: "claude_old_generation", outcome: "closed" };
  const terminalReceipt = { ...receipt("claude", "stopped"), handle: { kind: "claude.session", value: "claude_old_generation" } };
  f.core.prepareGenerationParentRebindStop = async () => {
    f.calls.push("prepare-stop");
    return { outcome: "observe_only", from_provider: "claude", stop_request: { handle: terminalReceipt.handle } };
  };
  f.core.confirmGenerationParentRebindTerminal = async (input) => {
    f.calls.push("confirm-terminal");
    f.core.terminal = input;
  };
  const aitermClaudeRuntime = {
    stopAitermClaudeObserver: async () => {
      f.calls.push("aiterm-close");
      return { terminal_receipt: terminalReceipt, stop_command_receipt: closeReceipt };
    },
  };
  const request = { ...REQUEST, provider: "claude", required_handle_kind: "claude.session", host: { session_name: "claude_next_generation" } };
  const result = await advanceGenerationParentRebindProviderBinding(input({
    launchRequest: request, oldVerification: null, oldSession: { id: "aiterm" }, newVerification: null, newSession: { id: "aiterm" },
  }), { rebind: f.core, codexRuntime: f.codexRuntime, claudeRuntime: f.claudeRuntime, aitermClaudeRuntime });
  assert.deepEqual(f.calls, ["status", "prepare-stop", "aiterm-close", "confirm-terminal"]);
  assert.equal(f.core.terminal.terminalReceipt, terminalReceipt);
  assert.equal(f.core.terminal.stopCommandReceipt, closeReceipt);
  assert.equal(result.phase, "terminal_observed");
});

test("不足provider sessionを成功扱いせず、provider commandを出さない", async () => {
  const f = fixture({ action: "recover_spawn" });
  await assert.rejects(
    advanceGenerationParentRebindProviderBinding(input({ newSession: null }), { rebind: f.core, codexRuntime: f.codexRuntime, claudeRuntime: f.claudeRuntime }),
    { code: "E_PARENT_REBIND_PROVIDER_RUNTIME_INVALID" },
  );
  assert.deepEqual(f.calls, ["status"]);
});
