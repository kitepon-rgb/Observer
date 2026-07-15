import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";

import {
  CODEX_PROCESS_VERIFICATION_SCHEMA,
  CodexProcessTransport,
  startCodexAppServerTransport,
  SUPPORTED_CODEX_VERSION,
  verifyCodexAppServerRuntime,
} from "../src/codex-process-transport.mjs";
import { ObserverError } from "../src/observer-error.mjs";

const ROOT = "/Users/kite/Developer/Observer";
const CODEX = "/opt/codex/bin/codex";
const IDENTITY = {
  candidate: CODEX, realpath: CODEX, uid: 501, gid: 20, mode: 0o755,
  dev: "1", ino: "2", size: "3", mtime_ns: "4", digest: "a".repeat(64),
};

function verification() {
  return { schema: CODEX_PROCESS_VERIFICATION_SCHEMA, runtime_root: ROOT, codex: { ...IDENTITY, version: SUPPORTED_CODEX_VERSION } };
}

class FakeChild extends EventEmitter {
  constructor() {
    super();
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

function expectCode(code) {
  return (error) => error instanceof ObserverError && error.code === code;
}

test("Codex executable identityとversionをObserver rootで二重確認する", async () => {
  const calls = [];
  const result = await verifyCodexAppServerRuntime({ runtimeRoot: ROOT, codexCommand: CODEX }, {
    effectiveUid: 501,
    realpath: async (value) => value,
    inspectExecutable: async (input) => { calls.push(["inspect", input]); return IDENTITY; },
    recheckIdentity: async (identity) => { calls.push(["recheck", identity.realpath]); },
    runFile: async (command, args, options) => { calls.push(["run", command, args, options]); return { exit_code: 0, stdout: `${SUPPORTED_CODEX_VERSION}\n`, stderr: "" }; },
  });
  assert.equal(result.codex.version, SUPPORTED_CODEX_VERSION);
  assert.deepEqual(calls.map((entry) => entry[0]), ["inspect", "recheck", "run", "recheck"]);
  assert.deepEqual(calls[2].slice(1, 3), [CODEX, ["--version"]]);
  assert.equal(calls[2][3].cwd, ROOT);
});

test("app-serverをshellなし・Observer cwd・環境allowlistで生成する", async () => {
  const child = new FakeChild();
  let invocation;
  const transport = await startCodexAppServerTransport({ verification: verification() }, {
    recheckIdentity: async () => {},
    env: { HOME: "/home", PATH: "/bin", SECRET_TOKEN: "no" },
    spawn: (command, args, options) => { invocation = { command, args, options }; return child; },
  });
  assert.ok(transport instanceof CodexProcessTransport);
  assert.deepEqual({ command: invocation.command, args: invocation.args }, { command: CODEX, args: ["app-server"] });
  assert.equal(invocation.options.cwd, ROOT);
  assert.equal(invocation.options.shell, false);
  assert.deepEqual(invocation.options.env, { NO_COLOR: "1", HOME: "/home", PATH: "/bin" });
  transport.close();
  await assert.rejects(
    startCodexAppServerTransport({ verification: { ...verification(), runtime_root: "relative" } }),
    expectCode("E_CODEX_PROCESS_VERIFICATION_INVALID"),
  );
});

test("JSONL request IDをout-of-order responseへexact相関しjsonrpc headerを送らない", async () => {
  const child = new FakeChild();
  const transport = new CodexProcessTransport(child);
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
  const notifications = [];
  const transport = new CodexProcessTransport(child, { onNotification: (message) => notifications.push(message) });
  child.respond({ method: "turn/completed", params: { turn: { id: "turn" } } });
  assert.deepEqual(notifications, [{ method: "turn/completed", params: { turn: { id: "turn" } } }]);
  const pending = transport.request("thread/read", {});
  child.respond({ id: 99, method: "item/commandExecution/requestApproval", params: {} });
  await assert.rejects(pending, expectCode("E_CODEX_TRANSPORT_PROTOCOL"));
  assert.equal(child.killed, "SIGTERM");
});

test("error responseはraw payloadを露出せず未知または重複response IDはfail closedにする", async () => {
  const child = new FakeChild();
  const transport = new CodexProcessTransport(child);
  const failed = transport.request("thread/read", {});
  child.respond({ id: 1, error: { code: -1, message: "secret raw detail" } });
  await assert.rejects(failed, (error) => expectCode("E_CODEX_APP_SERVER_RESPONSE_ERROR")(error) && !error.message.includes("secret"));
  const pending = transport.request("thread/read", {});
  child.respond({ id: 1, result: {} });
  await assert.rejects(pending, expectCode("E_CODEX_TRANSPORT_PROTOCOL"));
  assert.equal(child.killed, "SIGTERM");
});

test("process切断はpendingをunknownにしてtransport内で再送しない", async () => {
  const child = new FakeChild();
  const transport = new CodexProcessTransport(child);
  const pending = transport.request("turn/start", { threadId: "one" });
  child.emit("exit", 1, null);
  await assert.rejects(pending, expectCode("E_CODEX_TRANSPORT_UNKNOWN"));
  assert.equal(transport.terminationSignal.aborted, true);
  assert.equal(child.lines.length, 1);
  assert.throws(() => transport.request("turn/start", { threadId: "one" }), expectCode("E_CODEX_TRANSPORT_CLOSED"));
});

test("terminal closeを待ち、grace超過ではSIGKILL後のcloseだけを成功にする", async () => {
  const child = new FakeChild();
  const originalKill = child.kill.bind(child);
  child.kill = (signal) => {
    const result = originalKill(signal);
    if (signal === "SIGKILL") queueMicrotask(() => child.emit("close", null, "SIGKILL"));
    return result;
  };
  const transport = new CodexProcessTransport(child);
  const terminal = await transport.closeAndWait({ terminateGraceMs: 0, killGraceMs: 20 });
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  assert.deepEqual(terminal, {
    schema: "observer.codex_process_terminal.v1",
    status: "closed",
    exit_code: null,
    signal: "SIGKILL",
  });
});

test("SIGKILL後もcloseを確認できなければ終了不明をfail loudにする", async () => {
  const child = new FakeChild();
  const transport = new CodexProcessTransport(child);
  await assert.rejects(
    transport.closeAndWait({ terminateGraceMs: 0, killGraceMs: 0 }),
    expectCode("E_CODEX_PROCESS_TERMINATION_UNKNOWN"),
  );
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
});

test("不正JSONLとoversize stderrはpendingをfail closedにする", async () => {
  const invalidChild = new FakeChild();
  const invalidTransport = new CodexProcessTransport(invalidChild);
  const invalidPending = invalidTransport.request("thread/read", {});
  invalidChild.stdout.write("{not-json}\n");
  await assert.rejects(invalidPending, expectCode("E_CODEX_TRANSPORT_PROTOCOL"));

  const stderrChild = new FakeChild();
  const stderrTransport = new CodexProcessTransport(stderrChild);
  const stderrPending = stderrTransport.request("thread/read", {});
  stderrChild.stderr.write(Buffer.alloc(1024 * 1024 + 1));
  await assert.rejects(stderrPending, expectCode("E_CODEX_TRANSPORT_PROTOCOL"));
  assert.equal(stderrChild.killed, "SIGTERM");
});
