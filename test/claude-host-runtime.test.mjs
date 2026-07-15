import assert from "node:assert/strict";
import test from "node:test";

import {
  CLAUDE_HOST_RUNTIME_VERIFICATION_SCHEMA,
  observeClaudeObserver,
  recoverClaudeSpawn,
  spawnClaudeObserver,
  stopClaudeObserver,
  SUPPORTED_CLAUDE_VERSION,
  verifyClaudeHostRuntime,
} from "../src/claude-host-runtime.mjs";
import { ObserverError } from "../src/observer-error.mjs";
import { completeParentStop, confirmParentHostSpawn, confirmParentLaunch } from "../src/parent-launch.mjs";

const ROOT = "/Users/kite/Developer/Observer";
const TARGET_ID = `p_${"a".repeat(64)}`;
const WATCH_ID = "w_11111111-1111-4111-8111-111111111111";
const NAME = "observer-aaaaaaaaaaaa-11111111-1111-4111-8111-111111111111";

function identity(candidate, actual = candidate) {
  return {
    candidate,
    realpath: actual,
    uid: 501,
    gid: 20,
    mode: 0o755,
    dev: "1",
    ino: actual.endsWith("claude") ? "2" : "3",
    size: "100",
    mtime_ns: "1000",
    digest: "d".repeat(64),
  };
}

function verification() {
  return {
    schema: CLAUDE_HOST_RUNTIME_VERIFICATION_SCHEMA,
    runtime_root: ROOT,
    claude: { ...identity("/opt/homebrew/bin/claude", "/opt/homebrew/bin/claude"), version: SUPPORTED_CLAUDE_VERSION },
    observer_mcp: { ...identity(`${ROOT}/bin/observer-mcp.mjs`), version: "0.0.0", tools: ["observer_read", "observer_wait"] },
  };
}

function launchRequest() {
  return {
    schema: "observer.parent_launch_request.v1",
    provider: "claude",
    watch_id: WATCH_ID,
    target_id: TARGET_ID,
    project_root: "/project",
    runtime_root: ROOT,
    required_handle_kind: "claude.job",
    host: { kind: "claude.background_agent.v1", agent: "observer", name: NAME, cwd: ROOT },
    child_start: {
      schema: "observer.child_start.v1", mode: "observe", provider: "claude", watch_id: WATCH_ID,
      target_id: TARGET_ID, project_root: "/project", runtime_root: ROOT,
    },
  };
}

function hostReceipt(outcome = "spawned") {
  return {
    schema: "observer.host_receipt.v1", provider: "claude", watch_id: WATCH_ID, target_id: TARGET_ID,
    outcome, handle: { kind: "claude.job", value: "job-1" },
  };
}

function observation(state = "working") {
  return {
    schema: "observer.claude_job_observation.v1", job_id: "job-1", name: NAME, cwd: ROOT,
    state, observed_at: "2026-07-15T04:00:00.000Z",
  };
}

function stopRequest() {
  return {
    schema: "observer.parent_stop_request.v1", provider: "claude", watch_id: WATCH_ID, target_id: TARGET_ID,
    project_root: "/project", handle: { kind: "claude.job", value: "job-1" }, terminal: "stopped", fault_code: null,
  };
}

function expectCode(code) {
  return (error) => error instanceof ObserverError && error.code === code;
}

test("runtime verificationはmanifest固定MCP、exact version、exact tool surfaceを束縛する", async () => {
  const inspected = [];
  const result = await verifyClaudeHostRuntime({ runtimeRoot: ROOT, claudeCommand: "/opt/homebrew/bin/claude" }, {
    effectiveUid: 501,
    realpath: async (path) => path,
    inspectExecutable: async ({ candidate, kind }) => {
      inspected.push([candidate, kind]);
      return identity(candidate);
    },
    recheckIdentity: async () => {},
    runFile: async (command) => ({ exit_code: 0, stdout: command.endsWith("observer-mcp.mjs") ? "0.0.0\n" : `${SUPPORTED_CLAUDE_VERSION}\n`, stderr: "" }),
    probeMcp: async () => ["observer_read", "observer_wait"],
  });
  assert.equal(result.schema, CLAUDE_HOST_RUNTIME_VERIFICATION_SCHEMA);
  assert.deepEqual(inspected, [
    ["/opt/homebrew/bin/claude", "claude"],
    [`${ROOT}/bin/observer-mcp.mjs`, "observer-mcp"],
  ]);
  await assert.rejects(
    verifyClaudeHostRuntime({ runtimeRoot: ROOT, claudeCommand: "/opt/homebrew/bin/claude" }, {
      effectiveUid: 501,
      realpath: async (path) => path,
      inspectExecutable: async ({ candidate }) => identity(candidate),
      recheckIdentity: async () => {},
      runFile: async (command) => ({ exit_code: 0, stdout: command.endsWith("observer-mcp.mjs") ? "0.0.0\n" : `${SUPPORTED_CLAUDE_VERSION}\n`, stderr: "" }),
      probeMcp: async () => ["observer_read", "observer_write"],
    }),
    expectCode("E_OBSERVER_MCP_SURFACE_MISMATCH"),
  );
});

test("spawnはshort ID receiptだけを返しcwdとbounded envを固定する", async () => {
  const calls = [];
  const result = await spawnClaudeObserver({ request: launchRequest(), verification: verification() }, {
    recheckIdentity: async () => {},
    runFile: async (command, args, options) => {
      calls.push({ command, args, options });
      return { exit_code: 0, stdout: `Starting background service…\nbackgrounded · job-1 · ${NAME}\n`, stderr: "account text must not persist" };
    },
  });
  assert.deepEqual(result.receipt, hostReceipt("spawned"));
  assert.equal(result.observation, undefined);
  assert.equal(calls[0].options.cwd, ROOT);
  assert.equal(calls[0].options.env.SECRET, undefined);
  assert.equal(calls[0].args.includes("mcp__observer__observer_read,mcp__observer__observer_wait"), true);
  assert.equal(JSON.stringify(result).includes("account text"), false);
});

test("spawn stdout不明は成功やfaultへ丸めず同watch回収を要求する", async () => {
  await assert.rejects(spawnClaudeObserver({ request: launchRequest(), verification: verification() }, {
    recheckIdentity: async () => {},
    runFile: async () => ({ exit_code: 1, stdout: "", stderr: "private failure" }),
  }), expectCode("E_CLAUDE_SPAWN_UNKNOWN"));
});

test("spawn回収は固有nameとcwdをbounded pollし別jobへfallbackしない", async () => {
  let calls = 0;
  const recovered = await recoverClaudeSpawn({ request: launchRequest(), verification: verification(), attempts: 2 }, {
    recheckIdentity: async () => {},
    delay: async () => {},
    now: () => "2026-07-15T04:00:00.000Z",
    runFile: async () => {
      calls += 1;
      const entries = calls === 1 ? [] : [{ id: "job-1", name: NAME, cwd: ROOT, kind: "background", state: "working" }];
      return { exit_code: 0, stdout: JSON.stringify(entries), stderr: "" };
    },
  });
  assert.equal(calls, 2);
  assert.deepEqual(recovered.receipt, hostReceipt("spawned"));
  assert.equal(recovered.observation.job_id, "job-1");
});

test("observeは保存済みjob IDだけをreadyへ変換し未可視ならlaunching材料を返さない", async () => {
  let calls = 0;
  const result = await observeClaudeObserver({ request: launchRequest(), receipt: hostReceipt(), verification: verification(), attempts: 2 }, {
    recheckIdentity: async () => {},
    delay: async () => {},
    now: () => "2026-07-15T04:00:00.000Z",
    runFile: async () => {
      calls += 1;
      return { exit_code: 0, stdout: JSON.stringify(calls === 1 ? [] : [{ id: "job-1", name: NAME, cwd: ROOT, kind: "background", state: "working" }]), stderr: "" };
    },
  });
  assert.equal(result.observation.state, "working");
  assert.deepEqual(result.ready_receipt, hostReceipt("ready"));
  const missing = await observeClaudeObserver({ request: launchRequest(), receipt: hostReceipt(), verification: verification(), attempts: 1 }, {
    recheckIdentity: async () => {},
    runFile: async () => ({ exit_code: 0, stdout: "[]", stderr: "" }),
    now: () => "2026-07-15T04:00:00.000Z",
  });
  assert.deepEqual(missing, { schema: "observer.claude_host_observe_result.v1", observation: null, ready_receipt: null });
});

test("stopはcommand receiptとterminal observationを分離しdoneを結果回収済みにしない", async () => {
  const issued = await stopClaudeObserver({ request: stopRequest(), observation: observation("working"), verification: verification() }, {
    recheckIdentity: async () => {},
    now: () => "2026-07-15T04:00:01.000Z",
    runFile: async () => ({ exit_code: 0, stdout: "stopped job-1\n", stderr: "" }),
  });
  assert.equal(issued.command_receipt.outcome, "command_confirmed");
  assert.equal(issued.terminal_receipt, null);
  const terminal = await stopClaudeObserver({ request: stopRequest(), observation: observation("done"), verification: verification() }, { recheckIdentity: async () => {} });
  assert.deepEqual(terminal.terminal_receipt, hostReceipt("stopped"));
  assert.equal(terminal.terminal_state, "done");
  assert.equal("result" in terminal, false);
});

test("spawn ready terminal receiptsはparent-launchの二相transactionへそのまま接続できる", async () => {
  const launched = await spawnClaudeObserver({ request: launchRequest(), verification: verification() }, {
    recheckIdentity: async () => {},
    runFile: async () => ({ exit_code: 0, stdout: `backgrounded · job-1 · ${NAME}\n`, stderr: "" }),
  });
  let attached = null;
  await confirmParentHostSpawn({ stateRoot: "/state", request: launchRequest(), receipt: launched.receipt }, {
    attachWatchLaunchHandle: async (input) => { attached = input; return { status: "launching" }; },
  });
  assert.deepEqual(attached.launchHandle, { kind: "claude.job", value: "job-1" });

  const observed = await observeClaudeObserver({ request: launchRequest(), receipt: launched.receipt, verification: verification(), attempts: 1 }, {
    recheckIdentity: async () => {},
    now: () => "2026-07-15T04:00:00.000Z",
    runFile: async () => ({ exit_code: 0, stdout: JSON.stringify([{ id: "job-1", name: NAME, cwd: ROOT, kind: "background", state: "working" }]), stderr: "" }),
  });
  let activated = null;
  await confirmParentLaunch({ stateRoot: "/state", request: launchRequest(), receipt: observed.ready_receipt }, {
    activateWatch: async (input) => { activated = input; return { status: "active" }; },
  });
  assert.deepEqual(activated.launchHandle, attached.launchHandle);

  const stopped = await stopClaudeObserver({ request: stopRequest(), observation: observation("stopped"), verification: verification() }, { recheckIdentity: async () => {} });
  let completed = false;
  await completeParentStop({ stateRoot: "/state", request: stopRequest(), receipt: stopped.terminal_receipt }, {
    requestWatchStop: async () => ({ status: { provider: "claude", target_id: TARGET_ID, watch_id: WATCH_ID, project_root: "/project" }, launchHandle: stopRequest().handle }),
    completeWatchStop: async () => { completed = true; return { status: "stopped" }; },
  });
  assert.equal(completed, true);
});
