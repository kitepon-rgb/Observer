import assert from "node:assert/strict";
import test from "node:test";

import { advanceGenerationHostProviderRollover } from "../src/generation-host-provider-binding.mjs";
import { validateParentHostReceipt } from "../src/parent-launch.mjs";

const TARGET = `p_${"a".repeat(64)}`;
const WATCH = "w_11111111-1111-4111-8111-111111111111";
const REQUEST = { provider: "codex", target_id: TARGET, watch_id: WATCH };
const HANDLE = { kind: "codex.thread", value: "019f671e-87a6-7fb3-a6e7-8c800908206d" };
const receipt = (outcome) => ({
  schema: "observer.host_receipt.v1", provider: "codex", target_id: TARGET, watch_id: WATCH, outcome, handle: HANDLE,
  ...(outcome === "stopped" ? { terminal: {
    schema: "observer.codex_turn_terminal.v1", thread_id: HANDLE.value,
    turn_id: "019f671e-87a6-7fb3-a6e7-8c800908206e", status: "completed", observed_at: "2026-07-16T00:00:00.000Z",
  } } : {}),
});

function fixture(action, { journal = true, terminal = "pending" } = {}) {
  const calls = [];
  const context = { schema: "observer.generation_host_recovery_context.v1", provider: "codex", target_id: TARGET, watch_id: WATCH, status: action === "observe_terminal" ? "stop_authorized" : action === "authorize_start" ? "terminal_observed" : action === "recover_spawn" ? "spawn_authorized" : "spawn_observed", to_generation_id: "sha256:next", action };
  const core = {
    readGenerationHostRecoveryContext: async () => { calls.push("context"); if (!journal) { const error = new Error("missing"); error.code = "E_GENERATION_HOST_JOURNAL_NOT_FOUND"; error.constructor = { name: "ObserverError" }; throw error; } return context; },
    prepareGenerationHostStop: async () => { calls.push("prepare"); return { action: "observe_only", stop_request: { handle: HANDLE }, from_generation_id: "sha256:old" }; },
    confirmGenerationHostTerminal: async (input) => { calls.push("confirm-terminal"); core.confirmed = input; },
    authorizeNextGenerationHostStart: async () => { calls.push("authorize"); return { action: "issue_once", generation_id: "sha256:next" }; },
    recordNextGenerationHostSpawn: async () => calls.push("record-spawn"),
    activateNextGenerationHost: async () => calls.push("activate"),
  };
  const codexRuntime = {
    observeCodexGenerationTerminal: async (input) => { calls.push("observe-terminal"); codexRuntime.observedRequest = input.request; return { outcome: terminal, receipt: terminal === "terminal" ? { schema: "observer.codex_generation_terminal.v1" } : null, reason: terminal === "terminal" ? null : "turn_in_progress" }; },
    stopCodexObserver: async (input) => { calls.push("stop"); codexRuntime.stopped = input; return { terminal_receipt: terminal === "terminal" ? receipt("stopped") : null }; },
    spawnCodexGenerationObserverThread: async () => calls.push("spawn"),
    recoverCodexGenerationSpawn: async () => ({ outcome: "spawned", reason: null, receipt: receipt("spawned") }),
    activateCodexGenerationObserver: async () => { calls.push("ready-command"); return { ready_receipt: receipt("ready") }; },
    recoverCodexGenerationReady: async () => ({ outcome: "ready", reason: null, receipt: receipt("ready") }),
  };
  return { calls, options: { lifecycle: core, codexRuntime } };
}

test("spawn_authorizedはready command一件後にspawn/readyを連続でcoreへ適用し公開値にrawを残さない", async () => {
  const { calls, options } = fixture("recover_spawn");
  const result = await advanceGenerationHostProviderRollover({ stateRoot: "/state", targetId: TARGET, watchId: WATCH, launchRequest: REQUEST }, options);
  assert.deepEqual(calls, ["context", "ready-command", "record-spawn", "activate"]);
  assert.equal(result.outcome, "activated");
  assert.equal(JSON.stringify(result).includes("raw-thread-handle"), false);
});

test("stop_authorized再開のpendingはstopを再送せずterminal readだけを行う", async () => {
  const { calls, options } = fixture("observe_terminal");
  const result = await advanceGenerationHostProviderRollover({ stateRoot: "/state", targetId: TARGET, watchId: WATCH, launchRequest: REQUEST }, options);
  assert.deepEqual(calls, ["context", "prepare", "observe-terminal"]);
  assert.equal(result.outcome, "pending");
  assert.equal(calls.includes("stop"), false);
  assert.equal(options.codexRuntime.observedRequest, REQUEST);
});

test("Codex terminal成功時はalready-terminal stop経路のexact receiptだけをcoreへ渡す", async () => {
  const { calls, options } = fixture("observe_terminal", { terminal: "terminal" });
  options.lifecycle.confirmGenerationHostTerminal = async (input) => {
    validateParentHostReceipt(input.terminalReceipt, "stopped");
    calls.push("confirm-terminal");
    options.lifecycle.confirmed = input;
  };
  const result = await advanceGenerationHostProviderRollover({ stateRoot: "/state", targetId: TARGET, watchId: WATCH, launchRequest: REQUEST }, options);
  assert.deepEqual(calls, ["context", "prepare", "observe-terminal", "stop", "confirm-terminal"]);
  assert.equal(options.codexRuntime.stopped.generationId, "sha256:old");
  assert.equal(result.phase, "terminal_observed");
  assert.deepEqual(options.lifecycle.confirmed.terminalReceipt, receipt("stopped"));
  assert.equal(JSON.stringify(result).includes("raw-thread-handle"), false);
});

test("Codex terminal観測後もexact receipt欠損ならunknownを維持する", async () => {
  const { calls, options } = fixture("observe_terminal", { terminal: "terminal" });
  options.codexRuntime.stopCodexObserver = async () => { calls.push("stop"); return { terminal_receipt: null }; };
  const result = await advanceGenerationHostProviderRollover({ stateRoot: "/state", targetId: TARGET, watchId: WATCH, launchRequest: REQUEST }, options);
  assert.deepEqual(calls, ["context", "prepare", "observe-terminal", "stop"]);
  assert.equal(result.outcome, "unknown");
  assert.equal(result.reason, "terminal_receipt_unavailable");
});

test("authorize_startのspawn発行後は実core phase spawn_authorizedを返す", async () => {
  const { calls, options } = fixture("authorize_start");
  const result = await advanceGenerationHostProviderRollover({ stateRoot: "/state", targetId: TARGET, watchId: WATCH, launchRequest: REQUEST }, options);
  assert.deepEqual(calls, ["context", "authorize", "spawn"]);
  assert.equal(result.phase, "spawn_authorized");
  assert.equal(result.outcome, "progressed");
});

test("provider journal欠損のspawn recoveryはunknownでfail closedしmutating commandを出さない", async () => {
  const { calls, options } = fixture("recover_spawn");
  options.codexRuntime.recoverCodexGenerationSpawn = async () => ({ outcome: "unknown", reason: "journal_missing", receipt: null });
  const result = await advanceGenerationHostProviderRollover({ stateRoot: "/state", targetId: TARGET, watchId: WATCH, launchRequest: REQUEST }, options);
  assert.equal(result.outcome, "unknown");
  assert.deepEqual(calls, ["context"]);
});
