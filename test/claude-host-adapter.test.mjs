import assert from "node:assert/strict";
import test from "node:test";

import { ObserverError } from "../src/observer-error.mjs";
import {
  buildClaudeBackgroundInvocation,
  observeClaudeAgentList,
  planClaudeStop,
  recordClaudeStopCommandResult,
} from "../src/claude-host-adapter.mjs";

const TARGET_ID = `p_${"a".repeat(64)}`;
const WATCH_ID = "w_11111111-1111-4111-8111-111111111111";

function request(overrides = {}) {
  return {
    schema: "observer.parent_launch_request.v1",
    provider: "claude",
    watch_id: WATCH_ID,
    target_id: TARGET_ID,
    project_root: "/project",
    runtime_root: "/observer",
    required_handle_kind: "claude.job",
    host: {
      kind: "claude.background_agent.v1",
      agent: "observer",
      name: "observer-aaaaaaaaaaaa",
      cwd: "/observer",
    },
    child_start: {
      schema: "observer.child_start.v1",
      mode: "observe",
      provider: "claude",
      watch_id: WATCH_ID,
      target_id: TARGET_ID,
      project_root: "/project",
      runtime_root: "/observer",
    },
    ...overrides,
  };
}

function mcpConfig(overrides = {}) {
  return {
    mcpServers: {
      observer: {
        command: "/observer/bin/observer-mcp.mjs",
        args: ["--stdio"],
        ...overrides,
      },
    },
  };
}

function expectCode(code) {
  return (error) => error instanceof ObserverError && error.code === code;
}

test("Claude background argvは固定promptを可変長flagより前へ置きtool公開と無人許可を分離する", () => {
  const result = buildClaudeBackgroundInvocation({
    request: request(),
    claudeCommand: "/usr/local/bin/claude",
    mcpConfig: mcpConfig(),
    observerTools: ["mcp__observer__wait", "mcp__observer__publish"],
  });
  assert.equal(result.command, "/usr/local/bin/claude");
  const prompt = result.args[11];
  assert.deepEqual(result.args.slice(0, 12), [
    "--bg", "--name", "observer-aaaaaaaaaaaa", "--agent", "observer",
    "--permission-mode", "dontAsk", "--setting-sources", "",
    "--disable-slash-commands", "--no-chrome", prompt,
  ]);
  assert.ok(prompt.includes('"schema":"observer.child_start.v1"'));
  const mcpIndex = result.args.indexOf("--mcp-config");
  const toolsIndex = result.args.indexOf("--tools");
  const allowedIndex = result.args.indexOf("--allowedTools");
  assert.ok(result.args.indexOf(prompt) < mcpIndex);
  assert.ok(mcpIndex < toolsIndex && toolsIndex < allowedIndex);
  assert.equal(result.args[mcpIndex + 1], JSON.stringify(mcpConfig()));
  assert.equal(result.args[toolsIndex + 1], "Read,Grep,Glob,mcp__observer__publish,mcp__observer__wait");
  assert.equal(result.args[allowedIndex + 1], "mcp__observer__publish,mcp__observer__wait");
  assert.deepEqual(Object.keys(result).sort(), ["args", "command"]);
});

test("Claude invocationは非Claude request、非Observer MCP、env付きconfigを拒否する", () => {
  assert.throws(
    () => buildClaudeBackgroundInvocation({ request: request({ provider: "codex" }), claudeCommand: "/usr/local/bin/claude", mcpConfig: mcpConfig(), observerTools: ["mcp__observer__wait"] }),
    expectCode("E_CLAUDE_HOST_REQUEST_INVALID"),
  );
  assert.throws(
    () => buildClaudeBackgroundInvocation({ request: request(), claudeCommand: "/usr/local/bin/claude", mcpConfig: mcpConfig(), observerTools: ["mcp__other__wait"] }),
    expectCode("E_CLAUDE_HOST_TOOL_INVALID"),
  );
  assert.throws(
    () => buildClaudeBackgroundInvocation({ request: request(), claudeCommand: "/usr/local/bin/claude", mcpConfig: mcpConfig({ env: { TOKEN: "secret" } }), observerTools: ["mcp__observer__wait"] }),
    expectCode("E_CLAUDE_HOST_MCP_INVALID"),
  );
  assert.throws(
    () => buildClaudeBackgroundInvocation({ request: request(), claudeCommand: "/usr/local/bin/claude", mcpConfig: mcpConfig({ command: "/usr/local/bin/observer-mcp" }), observerTools: ["mcp__observer__wait"] }),
    expectCode("E_CLAUDE_HOST_MCP_INVALID"),
  );
  assert.throws(
    () => buildClaudeBackgroundInvocation({ request: request(), claudeCommand: "/usr/local/bin/claude", mcpConfig: mcpConfig({ args: ["--stdio", "--unsafe"] }), observerTools: ["mcp__observer__wait"] }),
    expectCode("E_CLAUDE_HOST_MCP_INVALID"),
  );
  assert.throws(
    () => buildClaudeBackgroundInvocation({ request: request(), claudeCommand: "claude", mcpConfig: mcpConfig(), observerTools: ["mcp__observer__wait"] }),
    expectCode("E_CLAUDE_HOST_COMMAND_INVALID"),
  );
});

test("agents JSONはjob identityを相関しallowlist fieldだけへ縮約する", () => {
  const stdout = JSON.stringify([{ id: "job-1", name: "observer-aaaaaaaaaaaa", cwd: "/observer", kind: "background", state: "working", sessionId: "private-session", startedAt: 123, extra: "drop" }]);
  const observation = observeClaudeAgentList({
    stdout,
    expected: { jobId: "job-1", name: "observer-aaaaaaaaaaaa", cwd: "/observer" },
    observedAt: "2026-07-15T02:00:00.000Z",
  });
  assert.deepEqual(observation, {
    schema: "observer.claude_job_observation.v1",
    job_id: "job-1",
    name: "observer-aaaaaaaaaaaa",
    cwd: "/observer",
    state: "working",
    observed_at: "2026-07-15T02:00:00.000Z",
  });
  assert.equal(JSON.stringify(observation).includes("private-session"), false);
});

test("agents JSONはmissing、identity mismatch、未知stateをfail loudにする", () => {
  const base = { id: "job-1", name: "observer-aaaaaaaaaaaa", cwd: "/observer", kind: "background", state: "working" };
  const input = (entry) => ({ stdout: JSON.stringify(entry ? [entry] : []), expected: { jobId: "job-1", name: "observer-aaaaaaaaaaaa", cwd: "/observer" }, observedAt: "2026-07-15T02:00:00.000Z" });
  assert.throws(() => observeClaudeAgentList(input(null)), expectCode("E_CLAUDE_JOB_NOT_FOUND"));
  assert.throws(() => observeClaudeAgentList(input({ ...base, cwd: "/other" })), expectCode("E_CLAUDE_JOB_CORRELATION_FAILED"));
  assert.throws(() => observeClaudeAgentList(input({ ...base, state: "mystery" })), expectCode("E_CLAUDE_JOB_STATE_UNKNOWN"));
  assert.throws(() => observeClaudeAgentList({ ...input(base), stdout: "not-json" }), expectCode("E_CLAUDE_AGENT_LIST_INVALID"));
});

test("stop計画は非terminalだけへcommandを発行しterminalへ再stopしない", () => {
  const observation = (state) => ({ schema: "observer.claude_job_observation.v1", job_id: "job-1", name: "observer-aaaaaaaaaaaa", cwd: "/observer", state, observed_at: "2026-07-15T02:00:00.000Z" });
  assert.deepEqual(planClaudeStop(observation("working"), { claudeCommand: "/usr/local/bin/claude" }), { action: "issue_stop", command: "/usr/local/bin/claude", args: ["stop", "job-1"] });
  assert.deepEqual(planClaudeStop(observation("blocked"), { claudeCommand: "/usr/local/bin/claude" }), { action: "issue_stop", command: "/usr/local/bin/claude", args: ["stop", "job-1"] });
  for (const outcome of ["command_confirmed", "command_unknown"]) {
    const previousCommandReceipt = { schema: "observer.claude_stop_command_receipt.v1", job_id: "job-1", outcome, observed_at: "2026-07-15T02:00:01.000Z" };
    assert.deepEqual(planClaudeStop(observation("working"), { claudeCommand: "/usr/local/bin/claude", previousCommandReceipt }), {
      action: "await_terminal_observation", job_id: "job-1", command_outcome: outcome,
    });
  }
  for (const state of ["done", "stopped", "failed"]) {
    assert.deepEqual(planClaudeStop(observation(state), { claudeCommand: "/usr/local/bin/claude" }), { action: "already_terminal", terminal_state: state, job_id: "job-1" });
  }
  assert.throws(
    () => planClaudeStop(observation("working"), { claudeCommand: "/usr/local/bin/claude", previousCommandReceipt: { schema: "observer.claude_stop_command_receipt.v1", job_id: "other", outcome: "command_confirmed", observed_at: "2026-07-15T02:00:01.000Z" } }),
    expectCode("E_CLAUDE_STOP_RECEIPT_INVALID"),
  );
});

test("stop command resultはexact成功だけをconfirmedにしraw出力を保持しない", () => {
  assert.deepEqual(recordClaudeStopCommandResult({ jobId: "job-1", exitCode: 0, stdout: "stopped job-1\n", stderr: "", observedAt: "2026-07-15T02:00:01.000Z" }), {
    schema: "observer.claude_stop_command_receipt.v1",
    job_id: "job-1",
    outcome: "command_confirmed",
    observed_at: "2026-07-15T02:00:01.000Z",
  });
  const unknown = recordClaudeStopCommandResult({ jobId: "job-1", exitCode: 1, stdout: "", stderr: "account text must not persist", observedAt: "2026-07-15T02:00:02.000Z" });
  assert.deepEqual(unknown, {
    schema: "observer.claude_stop_command_receipt.v1",
    job_id: "job-1",
    outcome: "command_unknown",
    observed_at: "2026-07-15T02:00:02.000Z",
  });
  assert.equal(JSON.stringify(unknown).includes("account text"), false);
});
