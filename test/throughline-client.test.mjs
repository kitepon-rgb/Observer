import assert from "node:assert/strict";
import { EventEmitter, getEventListeners } from "node:events";
import test from "node:test";

import { createThroughlineClient } from "../src/throughline-client.mjs";

const READ = {
  schema: "throughline.observer_read.v1", status: "snapshot", afterCursor: null, throughCursor: "tlc1.snapshot",
  host: null, thread_sha256: null, turns: [], historyTruncated: false, page: { complete: true, nextToken: null },
};

function fakeSpawn({ stdout = "", stdoutChunks = null, stderr = "", code = 0, signalName = null, close = true } = {}) {
  const calls = [];
  let child;
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = (signal) => { child.killedWith = [...(child.killedWith ?? []), signal]; };
    if (close) queueMicrotask(() => {
      for (const chunk of stdoutChunks ?? (stdout ? [stdout] : [])) child.stdout.emit("data", Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      if (stderr) child.stderr.emit("data", Buffer.from(stderr));
      child.emit("close", code, signalName);
    });
    return child;
  };
  return { spawn, calls, child: () => child };
}

test("Throughline client runs observer-read with an argument array and validates JSON wire", async () => {
  const fake = fakeSpawn({ stdout: `${JSON.stringify(READ)}\n` });
  const client = createThroughlineClient({ command: "/tool/throughline", spawn: fake.spawn });
  assert.deepEqual(await client.read({ projectPath: "/project", afterCursor: "tlc1.after", throughCursor: "tlc1.through", pageToken: "tlp1.page", limit: 10 }), READ);
  assert.deepEqual(fake.calls, [{
    command: "/tool/throughline",
    args: ["observer-read", "--project", "/project", "--after-cursor", "tlc1.after", "--through-cursor", "tlc1.through", "--page-token", "tlp1.page", "--limit", "10", "--json"],
    options: { shell: false, stdio: ["ignore", "pipe", "pipe"] },
  }]);
});

test("Throughline client rejects nonzero, non-single JSON, oversized stderr, and schema failures without copying stderr", async () => {
  for (const fake of [
    fakeSpawn({ stdout: "{}\n", stderr: "secret /db/path", code: 1 }),
    fakeSpawn({ stdout: "{}\n{}\n" }),
    fakeSpawn({ stdout: "{}\n", stderr: "x".repeat(20) }),
    fakeSpawn({ stdout: `${JSON.stringify({ ...READ, schema: "wrong" })}\n` }),
  ]) {
    const client = createThroughlineClient({ spawn: fake.spawn, maxStderrBytes: 10 });
    await assert.rejects(client.read({ projectPath: "/project" }), (error) => {
      assert.match(error.code, /^E_THROUGHLINE_(EXEC|PROTOCOL|SCHEMA)$/);
      assert.doesNotMatch(error.message, /secret|path|db/i);
      return true;
    });
  }
});

test("Throughline client propagates abort to observer-wait and releases the signal listener", async () => {
  const timers = [];
  let child;
  const spawn = () => {
    child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killedWith = [];
    child.kill = (signal) => {
      child.killedWith.push(signal);
      if (signal === "SIGKILL") queueMicrotask(() => child.emit("close", null, "SIGKILL"));
    };
    return child;
  };
  const client = createThroughlineClient({
    spawn,
    setTimeoutFn(callback) { timers.push(callback); return { unref() {} }; },
    clearTimeoutFn() {},
  });
  const controller = new AbortController();
  const pending = client.wait({ projectPath: "/project", afterCursor: "tlc1.after", signal: controller.signal });
  assert.equal(getEventListeners(controller.signal, "abort").length, 1);
  controller.abort();
  assert.deepEqual(child.killedWith, ["SIGTERM"]);
  timers[0]();
  await assert.rejects(pending, { code: "E_THROUGHLINE_CANCELLED" });
  assert.deepEqual(child.killedWith, ["SIGTERM", "SIGKILL"]);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("Throughline client validates observer-wait's fixed cursor relation", async () => {
  const fake = fakeSpawn({ stdout: `${JSON.stringify({ schema: "throughline.observer_wait.v1", status: "timeout", afterCursor: "tlc1.after", throughCursor: "tlc1.other" })}\n` });
  const client = createThroughlineClient({ spawn: fake.spawn });
  await assert.rejects(client.wait({ projectPath: "/project", afterCursor: "tlc1.after", timeoutSeconds: 3600 }), { code: "E_THROUGHLINE_SCHEMA" });
});

test("Throughline client preserves split UTF-8 stdout bytes and rejects relative projects", async () => {
  const expected = { ...READ, turns: [{ body: "あ" }] };
  const bytes = Buffer.from(`${JSON.stringify(expected)}\n`);
  const splitAt = bytes.indexOf(Buffer.from("あ")) + 1;
  const fake = fakeSpawn({ stdoutChunks: [bytes.subarray(0, splitAt), bytes.subarray(splitAt)] });
  const client = createThroughlineClient({ spawn: fake.spawn });
  assert.deepEqual(await client.read({ projectPath: "/project" }), expected);
  assert.throws(() => client.read({ projectPath: "relative" }), { code: "E_THROUGHLINE_INPUT" });
  assert.throws(() => client.wait({ projectPath: "relative", afterCursor: "tlc1.after" }), { code: "E_THROUGHLINE_INPUT" });
});
