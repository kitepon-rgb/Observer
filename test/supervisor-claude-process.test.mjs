import assert from "node:assert/strict";
import test from "node:test";

import { attachClaudeSessionShutdown, createClaudeSupervisorRuntime, runClaudeSupervisorProcess } from "../src/supervisor-claude-process.mjs";
import { claudeSessionNameFor } from "../src/parent-launch.mjs";

const TARGET = { schema: "observer.project_target.v1", targetId: `p_${"a".repeat(64)}`, projectRoot: "/project" };
const WATCH_ID = "w_11111111-1111-4111-8111-111111111111";
const SESSION_ID = "obs_aaaaaaaaaaaa_11111111111141118111111111111111";

test("Claude Supervisor processはverified Throughlineと一つのAiterm runtimeをSupervisorへ譲渡する", async () => {
  const calls = [];
  const result = await runClaudeSupervisorProcess({ stateRoot: "/state", target: TARGET, watchId: WATCH_ID, runtimeRoot: "/observer", throughlineCommand: "/bin/throughline", aitermCommand: "/bin/aiterm" }, {
    verifyThroughlineRuntime: async () => ({ schema: "observer.throughline_process_verification.v1", runtime_root: "/observer" }),
    createVerifiedThroughlineClient: () => ({ read: async () => {}, wait: async () => {} }),
    runSupervisorProcess: async ({ createProviderRuntime }) => {
      const runtime = await createProviderRuntime();
      calls.push(runtime.providerRuntime);
      return { schema: "observer.supervisor_process_result.v1", status: "stopped", provider: "claude", cycle_id: null };
    },
    createClaudeSupervisorRuntime: async () => ({ providerRuntime: { provider: "claude", runtime_root: "/observer", session_id: SESSION_ID, transport: { callTool: async () => {} } }, providerSignal: new AbortController().signal, advanceGenerationRollover: async () => {}, prepareGenerationParentRebind: async () => {}, advanceGenerationParentRebind: async () => {}, close: async () => {} }),
  });
  assert.equal(result.provider, "claude");
  assert.equal(calls[0].session_id, SESSION_ID);
});

test("Claude runtimeは同一transport/sessionを所有し、session shutdown有効時にpty_close→MCP closeで閉じる", async () => {
  const calls = [];
  const transport = { terminationSignal: new AbortController().signal, callTool: async (name, input) => { calls.push([name, input]); return { schema: "aiterm.pty-close-result.v1", session_id: SESSION_ID, closed: true }; }, closeAndWait: async () => { calls.push(["mcp-close"]); } };
  const runtime = await createClaudeSupervisorRuntime({ stateRoot: "/state", target: TARGET, watchId: WATCH_ID, runtimeRoot: "/observer", aitermCommand: "/bin/aiterm", sessionLifecycle: "launching" }, {
    buildAitermClaudeGenerationLaunchRequest: () => ({ provider: "claude", watch_id: WATCH_ID, target_id: TARGET.targetId, project_root: "/project", runtime_root: "/observer", required_handle_kind: "claude.session", host: { kind: "aiterm.claude_agent.v1", cwd: "/observer", agent_done: true, session_name: SESSION_ID }, child_start: { schema: "observer.child_start.v1", mode: "observe", provider: "claude", watch_id: WATCH_ID, target_id: TARGET.targetId, project_root: "/project", runtime_root: "/observer" }, schema: "observer.parent_launch_request.v1" }),
    verifyAitermRuntime: async () => ({ schema: "observer.aiterm_process_verification.v1", runtime_root: "/observer" }),
    startAitermMcpTransport: async () => transport,
    closeAitermClaudeSession: async ({ sessionId }) => transport.callTool("pty_close", { session_id: sessionId }),
    spawnAitermClaudeObserver: async () => ({ receipt: { schema: "observer.host_receipt.v1", provider: "claude", watch_id: WATCH_ID, target_id: TARGET.targetId, outcome: "spawned", handle: { kind: "claude.session", value: SESSION_ID } } }),
    activateAitermClaudeObserver: async () => ({ ready_receipt: { schema: "observer.host_receipt.v1", provider: "claude", watch_id: WATCH_ID, target_id: TARGET.targetId, outcome: "ready", handle: { kind: "claude.session", value: SESSION_ID } }, watch_status: { status: "active" } }),
  });
  assert.equal(runtime.providerRuntime.transport, transport);
  assert.equal(runtime.providerRuntime.session_id, SESSION_ID);
  attachClaudeSessionShutdown(runtime);
  await runtime.close();
  assert.deepEqual(calls.map(([name]) => name), ["pty_close", "mcp-close"]);
});

test("pty_close失敗後もMCP closeを必ず試行し、両方の失敗はAggregateErrorで保持する", async () => {
  async function runtimeFor({ sessionFailure, transportFailure }) {
    const calls = [];
    const transport = {
      terminationSignal: new AbortController().signal,
      callTool: async (name) => { calls.push(name); throw sessionFailure; },
      closeAndWait: async () => { calls.push("mcp-close"); if (transportFailure) throw transportFailure; },
    };
    const runtime = await createClaudeSupervisorRuntime({ stateRoot: "/state", target: TARGET, watchId: WATCH_ID, runtimeRoot: "/observer", aitermCommand: "/bin/aiterm", sessionLifecycle: "launching" }, {
      buildAitermClaudeGenerationLaunchRequest: () => ({ schema: "observer.parent_launch_request.v1", provider: "claude", watch_id: WATCH_ID, target_id: TARGET.targetId, project_root: "/project", runtime_root: "/observer", required_handle_kind: "claude.session", host: { kind: "aiterm.claude_agent.v1", cwd: "/observer", agent_done: true, session_name: SESSION_ID }, child_start: { schema: "observer.child_start.v1", mode: "observe", provider: "claude", watch_id: WATCH_ID, target_id: TARGET.targetId, project_root: "/project", runtime_root: "/observer" } }),
      verifyAitermRuntime: async () => ({ schema: "observer.aiterm_process_verification.v1", runtime_root: "/observer" }),
      startAitermMcpTransport: async () => transport,
      closeAitermClaudeSession: async ({ sessionId }) => transport.callTool("pty_close", { session_id: sessionId }),
    });
    return { runtime: attachClaudeSessionShutdown(runtime), calls };
  }
  const sessionFailure = new Error("pty close failed");
  const oneFailure = await runtimeFor({ sessionFailure, transportFailure: null });
  await assert.rejects(oneFailure.runtime.close(), (error) => error === sessionFailure);
  assert.deepEqual(oneFailure.calls, ["pty_close", "mcp-close"]);
  const transportFailure = new Error("mcp close failed");
  const bothFailures = await runtimeFor({ sessionFailure, transportFailure });
  await assert.rejects(bothFailures.runtime.close(), (error) => error instanceof AggregateError && error.errors[0] === sessionFailure && error.errors[1] === transportFailure);
  assert.deepEqual(bothFailures.calls, ["pty_close", "mcp-close"]);
});

test("active bindingのsessionを同generationで再利用し、terminal次generationでのみ新しいsessionへ切り替える", async () => {
  const initialSession = claudeSessionNameFor(TARGET.targetId, WATCH_ID);
  const captured = [];
  const transport = { terminationSignal: new AbortController().signal, callTool: async () => null, closeAndWait: async () => {} };
  const runtime = await createClaudeSupervisorRuntime({ stateRoot: "/state", target: TARGET, watchId: WATCH_ID, runtimeRoot: "/observer", aitermCommand: "/bin/aiterm" }, {
    verifyAitermRuntime: async () => ({ schema: "observer.aiterm_process_verification.v1", runtime_root: "/observer" }),
    startAitermMcpTransport: async () => transport,
    readWatchHostBinding: async () => ({ status: "active", provider: "claude", target_id: TARGET.targetId, watch_id: WATCH_ID, project_root: TARGET.projectRoot, launch_handle: { kind: "claude.session", value: initialSession } }),
    readGenerationState: async () => ({ provider: "claude", target_id: TARGET.targetId, watch_id: WATCH_ID, status: "terminal_confirmed", sequence: 1, parent_epoch_id: `sha256:${"c".repeat(64)}` }),
    advanceGenerationHostProviderRollover: async (input) => { captured.push(input.launchRequest); return { outcome: "activated", reason: "provider_ready_recovered" }; },
    closeAitermClaudeSession: async () => ({ schema: "aiterm.pty-close-result.v1", session_id: initialSession, outcome: "closed" }),
  });
  assert.equal(runtime.providerRuntime.session_id, initialSession);
  await runtime.advanceGenerationRollover();
  assert.notEqual(captured[0].host.session_name, initialSession);
  assert.equal(runtime.providerRuntime.session_id, captured[0].host.session_name);
  await runtime.close();
});
