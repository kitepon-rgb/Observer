import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CODEX_PROCESS_VERIFICATION_SCHEMA,
  CodexProcessTransport,
  isSupportedCodexVersion,
  MINIMUM_CODEX_VERSION,
  startCodexAppServerTransport,
  verifyCodexAppServerRuntime,
} from "../src/codex-process-transport.mjs";
import { ObserverError } from "../src/observer-error.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const CODEX = "/opt/codex/bin/codex";
const THREAD_ID = "019f62a1-1111-7111-8111-111111111111";
const TURN_ID = "019f62a2-2222-7222-8222-222222222222";
const IDENTITY = {
  candidate: CODEX, realpath: CODEX, uid: 501, gid: 20, mode: 0o755,
  dev: "1", ino: "2", size: "3", mtime_ns: "4", digest: "a".repeat(64),
};

function verification() {
  return { schema: CODEX_PROCESS_VERIFICATION_SCHEMA, runtime_root: ROOT, codex: { ...IDENTITY, version: "codex-cli 0.144.6" } };
}

class FakeChild extends EventEmitter {
  constructor({ pid = 4242 } = {}) {
    super();
    this.pid = pid;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.lines = [];
    this.killed = false;
    this.signals = [];
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        this.lines.push(chunk.toString("utf8"));
        callback();
      },
    });
  }

  kill(signal) {
    this.killed = signal;
    this.signals.push(signal);
    return true;
  }

  respond(message) {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }
}

function processGroupHarness({ alive = true, signalFailure = null, probeFailure = null } = {}) {
  const state = { alive, probes: [], signals: [] };
  return {
    state,
    options: {
      signalProcessGroup: (target, signal) => {
        state.signals.push([target, signal]);
        if (signalFailure?.signal === signal) throw signalFailure.error;
        return state.alive;
      },
      probeProcessGroup: (target) => {
        state.probes.push(target);
        if (probeFailure !== null) throw probeFailure;
        return state.alive;
      },
    },
  };
}

function transportFor(child, harness = processGroupHarness(), options = {}) {
  return {
    harness,
    transport: new CodexProcessTransport(child, { ...harness.options, ...options }),
  };
}

function expectCode(code) {
  return (error) => error instanceof ObserverError && error.code === code;
}

test("Codex executable identityと上位互換versionをObserver rootで二重確認する", async () => {
  const calls = [];
  const result = await verifyCodexAppServerRuntime({ runtimeRoot: ROOT, codexCommand: CODEX }, {
    effectiveUid: 501,
    realpath: async (value) => value,
    inspectExecutable: async (input) => { calls.push(["inspect", input]); return IDENTITY; },
    recheckIdentity: async (identity) => { calls.push(["recheck", identity.realpath]); },
    runFile: async (command, args, options) => { calls.push(["run", command, args, options]); return { exit_code: 0, stdout: "codex-cli 0.144.6\n", stderr: "" }; },
  });
  assert.equal(result.codex.version, "codex-cli 0.144.6");
  assert.deepEqual(calls.map((entry) => entry[0]), ["inspect", "recheck", "run", "recheck"]);
  assert.deepEqual(calls[2].slice(1, 3), [CODEX, ["--version"]]);
  assert.equal(calls[2][3].cwd, ROOT);
});

test("Codex最低版以上だけを受理し旧版・prerelease・不正表現を拒否する", async () => {
  assert.equal(MINIMUM_CODEX_VERSION, "0.144.3");
  assert.equal(isSupportedCodexVersion("codex-cli 0.144.3"), true);
  assert.equal(isSupportedCodexVersion("codex-cli 0.144.6"), true);
  assert.equal(isSupportedCodexVersion("codex-cli 0.145.0"), true);
  assert.equal(isSupportedCodexVersion("codex-cli 1.0.0"), true);
  assert.equal(isSupportedCodexVersion("codex-cli 0.144.2"), false);
  assert.equal(isSupportedCodexVersion("codex-cli 0.145.0-beta.1"), false);
  assert.equal(isSupportedCodexVersion("0.145.0"), false);
  assert.equal(isSupportedCodexVersion("codex-cli v0.145.0"), false);

  for (const candidate of ["codex-cli 0.144.2", "codex-cli 0.145.0-beta.1", "not-codex"]) {
    await assert.rejects(
      verifyCodexAppServerRuntime({ runtimeRoot: ROOT, codexCommand: CODEX }, {
        effectiveUid: 501,
        realpath: async (value) => value,
        inspectExecutable: async () => IDENTITY,
        recheckIdentity: async () => {},
        runFile: async () => ({ exit_code: 0, stdout: `${candidate}\n`, stderr: "" }),
      }),
      expectCode("E_CODEX_VERSION_UNSUPPORTED"),
    );
  }
  await assert.rejects(
    startCodexAppServerTransport({
      verification: {
        ...verification(),
        codex: { ...verification().codex, version: "codex-cli 0.144.2" },
      },
    }),
    expectCode("E_CODEX_PROCESS_VERIFICATION_INVALID"),
  );
});

test("app-serverをshellなし・Observer cwd・環境allowlist・hook/plugin無効で生成する", async () => {
  const child = new FakeChild();
  const harness = processGroupHarness();
  let invocation;
  const transport = await startCodexAppServerTransport({ verification: verification(), stateRoot: "/state" }, {
    recheckIdentity: async () => {},
    env: { HOME: "/home", PATH: "/bin", SECRET_TOKEN: "no" },
    prepareIsolatedCodexHome: async () => "/state/codex-runtime/home",
    spawn: (command, args, options) => { invocation = { command, args, options }; return child; },
    ...harness.options,
  });
  assert.ok(transport instanceof CodexProcessTransport);
  assert.deepEqual({ command: invocation.command, args: invocation.args }, {
    command: CODEX,
    args: [
      "app-server",
      "--disable", "apps",
      "--disable", "browser_use",
      "--disable", "browser_use_external",
      "--disable", "code_mode_host",
      "--disable", "computer_use",
      "--disable", "hooks",
      "--disable", "image_generation",
      "--disable", "in_app_browser",
      "--disable", "multi_agent",
      "--disable", "plugins",
      "--disable", "remote_plugin",
      "--disable", "request_permissions_tool",
      "--disable", "shell_tool",
      "--disable", "skill_mcp_dependency_install",
      "--disable", "tool_call_mcp_elicitation",
      "--disable", "tool_suggest",
      "--disable", "unified_exec",
      "--disable", "workspace_dependencies",
    ],
  });
  assert.equal(invocation.options.detached, true, "親terminal signalをCodex app-server childへ直接配送しない");
  assert.equal(invocation.options.cwd, ROOT);
  assert.equal(invocation.options.shell, false);
  assert.deepEqual(invocation.options.env, {
    NO_COLOR: "1",
    HOME: "/home",
    PATH: "/bin",
    CODEX_HOME: "/state/codex-runtime/home",
  });
  transport.close();
  assert.deepEqual(harness.state.signals, [[-child.pid, "SIGTERM"]]);
  await assert.rejects(
    startCodexAppServerTransport({ verification: { ...verification(), runtime_root: "relative" } }),
    expectCode("E_CODEX_PROCESS_VERIFICATION_INVALID"),
  );
});

test("隔離CODEX_HOMEは0600認証元へのsymlinkだけを接続する", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "observer-codex-home-"));
  const root = await realpath(temporary);
  const sourceHome = join(root, "source");
  const stateRoot = join(root, "state");
  await mkdir(sourceHome, { mode: 0o700 });
  await chmod(sourceHome, 0o700);
  const authSource = join(sourceHome, "auth.json");
  await writeFile(authSource, "{}\n", { mode: 0o600 });
  await chmod(authSource, 0o600);
  t.after(() => rm(root, { recursive: true, force: true }));

  const child = new FakeChild();
  const harness = processGroupHarness();
  const transport = await startCodexAppServerTransport({
    verification: verification(),
    stateRoot,
  }, {
    recheckIdentity: async () => {},
    effectiveUid: process.getuid(),
    env: { CODEX_HOME: sourceHome, HOME: "/ignored", PATH: "/bin" },
    spawn: (_command, _args, options) => {
      assert.equal(options.env.CODEX_HOME, join(stateRoot, "codex-runtime", "home"));
      return child;
    },
    ...harness.options,
  });
  assert.equal(
    await readlink(join(stateRoot, "codex-runtime", "home", "auth.json")),
    authSource,
  );
  transport.close();
});

test("残存MCP startup notificationをfail loudにする", async () => {
  const child = new FakeChild();
  const { transport } = transportFor(child);
  const pending = transport.request("thread/read", {});
  child.respond({
    method: "mcpServer/startupStatus/updated",
    params: { threadId: THREAD_ID, name: "unexpected", status: "starting", error: null, failureReason: null },
  });
  await assert.rejects(pending, expectCode("E_CODEX_MCP_SURFACE_EXPOSED"));
  assert.equal(transport.terminationSignal.aborted, true);
});

test("JSONL request IDをout-of-order responseへexact相関しjsonrpc headerを送らない", async () => {
  const child = new FakeChild();
  const { transport } = transportFor(child);
  const first = transport.request("thread/read", { threadId: "one" });
  const second = transport.request("thread/read", { threadId: "two" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(child.lines.map((line) => JSON.parse(line)), [
    { id: 1, method: "thread/read", params: { threadId: "one" } },
    { id: 2, method: "thread/read", params: { threadId: "two" } },
  ]);
  child.respond({ id: 2, result: { value: "second" } });
  child.respond({ id: 1, result: { value: "first" } });
  assert.deepEqual(await Promise.all([first, second]), [{ value: "first" }, { value: "second" }]);
  transport.close();
});

test("notificationをbounded callbackへ渡しserver requestをprotocol違反にする", async () => {
  const child = new FakeChild();
  const harness = processGroupHarness();
  const notifications = [];
  const { transport } = transportFor(child, harness, { onNotification: (message) => notifications.push(message) });
  child.respond({ method: "turn/completed", params: { threadId: THREAD_ID, turn: { id: TURN_ID, status: "completed" } } });
  assert.deepEqual(notifications, [{ method: "turn/completed", params: { threadId: THREAD_ID, turn: { id: TURN_ID, status: "completed" } } }]);
  const pending = transport.request("thread/read", {});
  child.respond({ id: 99, method: "item/commandExecution/requestApproval", params: {} });
  await assert.rejects(pending, expectCode("E_CODEX_TRANSPORT_PROTOCOL"));
  assert.deepEqual(harness.state.signals, [[-child.pid, "SIGTERM"]]);
});

test("turn/completedをexact相関しread前のterminal gateとして保持する", async () => {
  const child = new FakeChild();
  const { transport } = transportFor(child);
  const waiting = transport.waitForTurnTerminal({ threadId: THREAD_ID, turnId: TURN_ID, timeoutMs: 1_000 });
  child.respond({
    method: "turn/completed",
    params: { threadId: THREAD_ID, turn: { id: TURN_ID, status: "completed" } },
  });
  assert.deepEqual(await waiting, {
    schema: "observer.codex_turn_terminal_notification.v1",
    thread_id: THREAD_ID,
    turn_id: TURN_ID,
    status: "completed",
  });
  assert.equal((await transport.waitForTurnTerminal({ threadId: THREAD_ID, turnId: TURN_ID, timeoutMs: 1_000 })).status, "completed");
  await assert.rejects(
    transport.waitForTurnTerminal({
      threadId: THREAD_ID,
      turnId: "019f62a3-3333-7333-8333-333333333333",
      timeoutMs: 1,
    }),
    expectCode("E_CODEX_TURN_TERMINAL_TIMEOUT"),
  );
  transport.close();
});

test("error responseはraw payloadを露出せず未知または重複response IDはfail closedにする", async () => {
  const child = new FakeChild();
  const { harness, transport } = transportFor(child);
  const failed = transport.request("thread/read", {});
  child.respond({ id: 1, error: { code: -1, message: "secret raw detail" } });
  await assert.rejects(failed, (error) => expectCode("E_CODEX_APP_SERVER_RESPONSE_ERROR")(error) && !error.message.includes("secret"));
  const pending = transport.request("thread/read", {});
  child.respond({ id: 1, result: {} });
  await assert.rejects(pending, expectCode("E_CODEX_TRANSPORT_PROTOCOL"));
  assert.deepEqual(harness.state.signals, [[-child.pid, "SIGTERM"]]);
});

test("process切断はpendingをunknownにしてtransport内で再送しない", async () => {
  const child = new FakeChild();
  const { transport } = transportFor(child);
  const pending = transport.request("turn/start", { threadId: "one" });
  child.emit("exit", 1, null);
  await assert.rejects(pending, expectCode("E_CODEX_TRANSPORT_UNKNOWN"));
  assert.equal(transport.terminationSignal.aborted, true);
  assert.equal(child.lines.length, 1);
  assert.throws(() => transport.request("turn/start", { threadId: "one" }), expectCode("E_CODEX_TRANSPORT_CLOSED"));
});

test("固有process groupへSIGTERMからSIGKILLを送り、leader closeとgroup消滅後だけ成功する", async () => {
  const child = new FakeChild();
  const harness = processGroupHarness();
  harness.options.signalProcessGroup = (target, signal) => {
    harness.state.signals.push([target, signal]);
    if (signal === "SIGKILL") {
      harness.state.alive = false;
      queueMicrotask(() => child.emit("close", null, "SIGKILL"));
    }
    return true;
  };
  const { transport } = transportFor(child, harness);
  const terminal = await transport.closeAndWait({ terminateGraceMs: 0, killGraceMs: 20 });
  assert.deepEqual(harness.state.signals, [[-child.pid, "SIGTERM"], [-child.pid, "SIGKILL"]]);
  assert.ok(harness.state.probes.length > 0);
  assert.ok(harness.state.probes.every((target) => target === -child.pid));
  assert.deepEqual(terminal, {
    schema: "observer.codex_process_terminal.v1",
    status: "closed",
    exit_code: null,
    signal: "SIGKILL",
  });
});

test("leader close後もgroup aliveなら未完了で、group消滅後だけterminal receiptを返す", async () => {
  const child = new FakeChild();
  const { harness, transport } = transportFor(child);
  let settled = false;
  const closing = transport.closeAndWait({ terminateGraceMs: 100, killGraceMs: 100 }).then((value) => {
    settled = true;
    return value;
  });
  child.emit("close", 0, null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  harness.state.alive = false;
  assert.equal((await closing).status, "closed");
});

test("group消滅後もleader closeが無ければ成功にしない", async () => {
  const child = new FakeChild();
  const harness = processGroupHarness({ alive: false });
  const { transport } = transportFor(child, harness);
  await assert.rejects(
    transport.closeAndWait({ terminateGraceMs: 0, killGraceMs: 0 }),
    expectCode("E_CODEX_PROCESS_TERMINATION_UNKNOWN"),
  );
});

test("SIGKILL後もgroupが残る場合は終了不明をfail loudにする", async () => {
  const child = new FakeChild();
  const { harness, transport } = transportFor(child);
  child.emit("close", null, "SIGTERM");
  await assert.rejects(
    transport.closeAndWait({ terminateGraceMs: 0, killGraceMs: 0 }),
    expectCode("E_CODEX_PROCESS_TERMINATION_UNKNOWN"),
  );
  assert.deepEqual(harness.state.signals, [[-child.pid, "SIGTERM"], [-child.pid, "SIGKILL"]]);
});

test("process group probeのEPERMは存在確認として待機を継続する", async () => {
  const child = new FakeChild();
  const harness = processGroupHarness();
  let probes = 0;
  const { transport } = transportFor(child, harness, {
    probeProcessGroup: () => {
      probes += 1;
      if (probes === 1) throw Object.assign(new Error("permission denied"), { code: "EPERM" });
      return false;
    },
  });
  child.emit("close", 0, null);
  const terminal = await transport.closeAndWait({ terminateGraceMs: 50, killGraceMs: 50 });
  assert.equal(terminal.status, "closed");
  assert.equal(probes, 2);
  assert.deepEqual(harness.state.signals, [[-child.pid, "SIGTERM"]]);
});

test("process group ID欠損とsignal・probe異常をleader-only fallbackへ丸めない", async (t) => {
  assert.throws(
    () => new CodexProcessTransport(new FakeChild({ pid: null })),
    expectCode("E_CODEX_PROCESS_TERMINATION_UNKNOWN"),
  );

  await t.test("SIGTERM failure", async () => {
    const child = new FakeChild();
    const harness = processGroupHarness({ signalFailure: { signal: "SIGTERM", error: new Error("denied") } });
    const { transport } = transportFor(child, harness);
    await assert.rejects(
      transport.closeAndWait({ terminateGraceMs: 20, killGraceMs: 20 }),
      expectCode("E_CODEX_PROCESS_TERMINATION_UNKNOWN"),
    );
    assert.deepEqual(child.signals, []);
  });

  await t.test("SIGKILL failure", async () => {
    const child = new FakeChild();
    const harness = processGroupHarness({ signalFailure: { signal: "SIGKILL", error: new Error("denied") } });
    const { transport } = transportFor(child, harness);
    child.emit("close", null, "SIGTERM");
    await assert.rejects(
      transport.closeAndWait({ terminateGraceMs: 0, killGraceMs: 20 }),
      expectCode("E_CODEX_PROCESS_TERMINATION_UNKNOWN"),
    );
    assert.deepEqual(harness.state.signals, [[-child.pid, "SIGTERM"], [-child.pid, "SIGKILL"]]);
  });

  await t.test("probe failure", async () => {
    const child = new FakeChild();
    const harness = processGroupHarness({ probeFailure: new Error("probe denied") });
    const { transport } = transportFor(child, harness);
    child.emit("close", 0, null);
    await assert.rejects(
      transport.closeAndWait({ terminateGraceMs: 20, killGraceMs: 20 }),
      expectCode("E_CODEX_PROCESS_TERMINATION_UNKNOWN"),
    );
  });
});

test("不正JSONLとoversize stderrはpendingをfail closedにする", async () => {
  const invalidChild = new FakeChild();
  const { transport: invalidTransport } = transportFor(invalidChild);
  const invalidPending = invalidTransport.request("thread/read", {});
  invalidChild.stdout.write("{not-json}\n");
  await assert.rejects(invalidPending, expectCode("E_CODEX_TRANSPORT_PROTOCOL"));

  const stderrChild = new FakeChild();
  const { harness, transport: stderrTransport } = transportFor(stderrChild);
  const stderrPending = stderrTransport.request("thread/read", {});
  stderrChild.stderr.write(Buffer.alloc(1024 * 1024 + 1));
  await assert.rejects(stderrPending, expectCode("E_CODEX_TRANSPORT_PROTOCOL"));
  assert.deepEqual(harness.state.signals, [[-stderrChild.pid, "SIGTERM"]]);
});

test("実OS fixtureでleader終了後の子processをgroupごと回収する", {
  skip: process.platform === "win32" ? "POSIX process group fixture" : false,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "observer-codex-process-group-"));
  const pidFile = join(root, "survivor.pid");
  const fixture = fileURLToPath(new URL("./fixtures/codex-process-group-leader.mjs", import.meta.url));
  const leader = spawn(process.execPath, [fixture, pidFile], {
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const leaderClosed = new Promise((resolve) => leader.once("close", resolve));
  t.after(async () => {
    try { process.kill(-leader.pid, "SIGKILL"); } catch {}
    await rm(root, { recursive: true, force: true });
  });
  const transport = new CodexProcessTransport(leader);
  let survivorPid = null;
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    try {
      const candidate = Number.parseInt(await readFile(pidFile, "utf8"), 10);
      if (Number.isSafeInteger(candidate) && candidate > 0) {
        survivorPid = candidate;
        break;
      }
    } catch {
      // PID fileが作成されるまでboundedに待つ。
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(Number.isSafeInteger(survivorPid) && survivorPid > 0, "survivor PIDを取得する");
  await leaderClosed;
  const terminal = await transport.closeAndWait({ terminateGraceMs: 25, killGraceMs: 2_000 });
  assert.equal(terminal.status, "closed");
  assert.throws(() => process.kill(-leader.pid, 0), (error) => error?.code === "ESRCH");
  assert.throws(() => process.kill(survivorPid, 0), (error) => error?.code === "ESRCH");
});
