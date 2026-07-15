import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { PassThrough } from "node:stream";
import test from "node:test";

import { ObserverError } from "../src/observer-error.mjs";
import {
  createObserverMcpSession,
  OBSERVER_MCP_PROTOCOL_VERSION,
  OBSERVER_MCP_SERVER_VERSION,
  runObserverMcpStdio,
} from "../src/mcp-server.mjs";

const TARGET_ID = `p_${"a".repeat(64)}`;
const WATCH_ID = "w_11111111-1111-4111-8111-111111111111";
const IDENTITY = { provider: "claude", target_id: TARGET_ID, watch_id: WATCH_ID, project_root: "/project" };
const STATUS = {
  schema: "observer.watch_status.v1",
  watch_id: WATCH_ID,
  target_id: TARGET_ID,
  project_root: "/project",
  provider: "claude",
  status: "active",
  created_at: "2026-07-15T00:00:00.000Z",
  updated_at: "2026-07-15T00:01:00.000Z",
  fault_code: null,
};
const READ = {
  schema: "throughline.observer_read.v1",
  status: "snapshot",
  host: null,
  thread_sha256: null,
  afterCursor: null,
  throughCursor: "tlc1.snapshot",
  turns: [],
  historyTruncated: false,
  page: { complete: true, nextToken: null },
};

function request(id, method, params) {
  return { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) };
}

function notification(method, params) {
  return { jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) };
}

async function readySession(overrides = {}) {
  const session = createObserverMcpSession({
    stateRoot: "/state",
    throughlineClient: { read: async () => READ, wait: async () => ({ schema: "throughline.observer_wait.v1", status: "timeout", afterCursor: "tlc1.after", throughCursor: "tlc1.after" }) },
    readWatchStatusFn: async () => STATUS,
    ...overrides,
  });
  const initialized = await session.receive(request(1, "initialize", {
    protocolVersion: OBSERVER_MCP_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "test-client", version: "1.0.0" },
  }));
  assert.equal(initialized.result.protocolVersion, OBSERVER_MCP_PROTOCOL_VERSION);
  assert.deepEqual(initialized.result.capabilities, { tools: { listChanged: false } });
  assert.equal(await session.receive(notification("notifications/initialized")), null);
  return session;
}

test("MCP lifecycleはinitialize前toolを拒否し固定read/wait surfaceだけを公開する", async () => {
  const session = createObserverMcpSession({ stateRoot: "/state", readWatchStatusFn: async () => STATUS });
  const early = await session.receive(request(1, "tools/list", {}));
  assert.equal(early.error.code, -32600);

  const initialized = await session.receive(request(2, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test-client", version: "1.0.0" },
  }));
  assert.equal(initialized.result.protocolVersion, "2025-06-18");
  await session.receive(notification("notifications/initialized"));
  const listed = await session.receive(request(3, "tools/list", {}));
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), ["observer_read", "observer_wait"]);
  for (const tool of listed.result.tools) {
    assert.deepEqual(tool.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    assert.equal(tool.execution.taskSupport, "forbidden");
    assert.equal(tool.inputSchema.additionalProperties, false);
  }
  assert.equal((await session.receive(request(4, "initialize", { protocolVersion: OBSERVER_MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: {} }))).error.code, -32600);
  session.close();
});

test("MCP toolsはactive watch identityを照合してからThroughline wireをstructured/textで返す", async () => {
  const calls = [];
  const session = await readySession({
    throughlineClient: {
      async read(input) { calls.push(input); return READ; },
      async wait() { throw new Error("unused"); },
    },
  });
  const response = await session.receive(request(2, "tools/call", { name: "observer_read", arguments: { ...IDENTITY, limit: 10 } }));
  assert.equal(response.result.isError, false);
  assert.deepEqual(response.result.structuredContent, READ);
  assert.deepEqual(JSON.parse(response.result.content[0].text), READ);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].projectPath, "/project");
  assert.equal(calls[0].limit, 10);
  assert.equal(typeof calls[0].signal?.aborted, "boolean");

  const denied = await session.receive(request(3, "tools/call", { name: "observer_read", arguments: { ...IDENTITY, project_root: "/other" } }));
  assert.equal(denied.result.isError, true);
  assert.match(denied.result.content[0].text, /E_MCP_WATCH_UNAUTHORIZED/);
  assert.doesNotMatch(denied.result.content[0].text, /other|state|stack/i);
  assert.equal(calls.length, 1);
  assert.equal((await session.receive(request(4, "tools/call", { name: "unknown", arguments: {} }))).error.code, -32602);
  assert.equal((await session.receive(request(5, "tools/call", { name: "observer_wait", arguments: { ...IDENTITY, after_cursor: "tlc1.after", extra: true } }))).error.code, -32602);
  session.close();
});

test("notifications/cancelledとstdin shutdownはpending waitをAbortSignalで終了する", async () => {
  let waitSignal;
  const session = await readySession({
    throughlineClient: {
      async read() { throw new Error("unused"); },
      wait({ signal }) {
        waitSignal = signal;
        return new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(new ObserverError("E_THROUGHLINE_CANCELLED", "private path must not leak")), { once: true }));
      },
    },
  });
  const pending = session.receive(request("wait-1", "tools/call", { name: "observer_wait", arguments: { ...IDENTITY, after_cursor: "tlc1.after", timeout_seconds: 3600 } }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.pendingCount, 1);
  assert.equal(waitSignal.aborted, false);
  assert.equal(await session.receive(notification("notifications/cancelled", { requestId: "wait-1", reason: "parent stop" })), null);
  const cancelled = await pending;
  assert.equal(cancelled.result.isError, true);
  assert.match(cancelled.result.content[0].text, /E_THROUGHLINE_CANCELLED/);
  assert.doesNotMatch(cancelled.result.content[0].text, /private|path/i);
  assert.equal(session.pendingCount, 0);

  const pendingOnClose = session.receive(request("wait-2", "tools/call", { name: "observer_wait", arguments: { ...IDENTITY, after_cursor: "tlc1.after", timeout_seconds: 3600 } }));
  await new Promise((resolve) => setImmediate(resolve));
  session.close();
  assert.equal((await pendingOnClose).result.isError, true);
  assert.equal(session.pendingCount, 0);
});

test("stdio transportはnewline JSON-RPCだけをstdoutへ出し不正JSONで閉じる", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const diagnostics = new PassThrough();
  let stdout = "";
  let stderr = "";
  output.on("data", (chunk) => { stdout += chunk; });
  diagnostics.on("data", (chunk) => { stderr += chunk; });
  const server = runObserverMcpStdio({ input, output, diagnostics, stateRoot: "/state", readWatchStatusFn: async () => STATUS });
  input.write(`${JSON.stringify(request(1, "initialize", { protocolVersion: OBSERVER_MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "test", version: "1" } }))}\n`);
  await waitUntil(() => stdout.includes("\n"));
  const first = JSON.parse(stdout.trim());
  assert.equal(first.result.serverInfo.name, "observer");
  assert.equal(stderr, "");
  assert.equal(stdout.split("\n").filter(Boolean).length, 1);

  input.write("not-json\n");
  await waitUntil(() => stderr.length > 0);
  assert.equal(JSON.parse(stdout.trim().split("\n").at(-1)).error.code, -32700);
  server.close();
});

test("observer-mcp executableはversionと引数契約を固定する", () => {
  const version = spawnSync(process.execPath, ["bin/observer-mcp.mjs", "--version"], { encoding: "utf8" });
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), OBSERVER_MCP_SERVER_VERSION);
  const invalid = spawnSync(process.execPath, ["bin/observer-mcp.mjs"], { encoding: "utf8" });
  assert.equal(invalid.status, 2);
  assert.equal(invalid.stdout, "");
  assert.match(invalid.stderr, /^usage: observer-mcp/);
});

async function waitUntil(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for stream output");
}
