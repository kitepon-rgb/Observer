import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";

import { AITERM_PROCESS_VERIFICATION_SCHEMA, AitermMcpTransport, startAitermMcpTransport, verifyAitermRuntime } from "../src/aiterm-process-transport.mjs";
import { ObserverError } from "../src/observer-error.mjs";

const ROOT = "/Users/kite/Developer/Observer";
const AITERM = "/opt/aiterm/bin/aiterm-mcp";
const IDENTITY = { candidate: AITERM, realpath: AITERM, uid: 501, gid: 20, mode: 0o755, dev: "1", ino: "2", size: "3", mtime_ns: "4", digest: "a".repeat(64) };
const expectCode = (code) => (error) => error instanceof ObserverError && error.code === code;

const tools = () => ({ tools: [
  { name: "claude_agent", inputSchema: { properties: { agent_done: { type: "boolean" } } }, outputSchema: { properties: { schema: { const: "aiterm.agent-launch-result.v1" }, provider: { const: "claude" }, session_id: { pattern: "^[A-Za-z0-9_-]{1,64}$" }, managed_completion: { type: "boolean" } } } },
  { name: "claude_turn", inputSchema: { properties: { action: { enum: ["issue", "recover"] }, session_id: { type: "string" }, operation_id: { pattern: "^sha256:[0-9a-f]{64}$" } } }, outputSchema: { properties: { schema: { const: "aiterm.claude-operation-result.v1" } } } },
  { name: "pty_close", inputSchema: { properties: { session_id: { type: "string" } } }, outputSchema: { properties: {} } },
] });

class FakeChild extends EventEmitter {
  constructor(handler = null) {
    super(); this.stdout = new PassThrough(); this.stderr = new PassThrough(); this.lines = []; this.signals = []; this.handler = handler;
    this.stdin = new Writable({ write: (chunk, _encoding, callback) => {
      const line = chunk.toString("utf8"); this.lines.push(line);
      try { this.handler?.(JSON.parse(line), this); callback(); } catch (error) { callback(error); }
    } });
  }
  kill(signal) { this.signals.push(signal); return true; }
  respond(message) { this.stdout.write(`${JSON.stringify(message)}\n`); }
}

function autoChild() {
  return new FakeChild((message, child) => {
    if (message.method === "initialize") child.respond({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-11-25", serverInfo: { name: "aiterm", version: "0.13.0" }, capabilities: {} } });
    if (message.method === "tools/list") child.respond({ jsonrpc: "2.0", id: message.id, result: tools() });
  });
}

async function initialized(child = autoChild()) { const transport = new AitermMcpTransport(child); await transport.initialize(); return { child, transport }; }

test("Aiterm executable identityとversionをObserver rootで再検証する", async () => {
  const calls = [];
  const verified = await verifyAitermRuntime({ runtimeRoot: ROOT, aitermCommand: AITERM }, {
    effectiveUid: 501, realpath: async (value) => value,
    inspectExecutable: async (input) => { calls.push(["inspect", input]); return IDENTITY; },
    recheckIdentity: async (identity) => { calls.push(["recheck", identity.realpath]); },
  });
  assert.deepEqual(verified, { schema: AITERM_PROCESS_VERIFICATION_SCHEMA, runtime_root: ROOT, aiterm: { ...IDENTITY, required_version: "0.13.0" } });
  assert.deepEqual(calls.map((value) => value[0]), ["inspect", "recheck"]);
});

test("Aiterm stdioはinitialize 2025-11-25、必須3 tools、structured launch receiptを固定する", async () => {
  const child = autoChild(); let invocation; let rechecks = 0;
  const transport = await startAitermMcpTransport({ verification: { schema: AITERM_PROCESS_VERIFICATION_SCHEMA, runtime_root: ROOT, aiterm: { ...IDENTITY, required_version: "0.13.0" } } }, {
    recheckIdentity: async () => { rechecks += 1; }, env: { HOME: "/home", PATH: "/bin", SECRET: "drop" },
    spawn: (command, args, options) => { invocation = { command, args, options }; return child; },
  });
  assert.ok(transport instanceof AitermMcpTransport);
  assert.deepEqual({ command: invocation.command, args: invocation.args }, { command: AITERM, args: [] });
  assert.equal(invocation.options.cwd, ROOT); assert.equal(invocation.options.shell, false);
  const structured = { schema: "aiterm.agent-launch-result.v1", provider: "claude", session_id: "claude_1", managed_completion: true };
  child.handler = (message, current) => {
    if (message.method === "tools/call") current.respond({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "session_id: claude_1" }], structuredContent: structured } });
  };
  assert.deepEqual(await transport.callTool("claude_agent", { session_name: "claude_1", agent_done: true }), structured);
  assert.equal(rechecks, 3, "spawn前・initialize後・公開operation前にidentityを再検証する");
  assert.deepEqual(child.lines.map((line) => JSON.parse(line)).slice(0, 3), [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "observer", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ]);
  transport.close();
});

test("Aiterm tool errorはsanitizedで、unknown/duplicate ID・malformed/oversize・exitをfail closedにする", async () => {
  const { child, transport } = await initialized();
  const failed = transport.callTool("claude_turn", {});
  child.respond({ jsonrpc: "2.0", id: 3, result: { isError: true, content: [{ type: "text", text: "secret provider detail" }] } });
  await assert.rejects(failed, (error) => expectCode("E_AITERM_TOOL_ERROR")(error) && !error.message.includes("secret"));
  const pending = transport.callTool("claude_turn", {}); child.respond({ jsonrpc: "2.0", id: 3, result: {} });
  await assert.rejects(pending, expectCode("E_AITERM_TRANSPORT_PROTOCOL"));

  const invalid = await initialized(); const invalidPending = invalid.transport.callTool("claude_turn", {}); invalid.child.stdout.write("{not-json}\n");
  await assert.rejects(invalidPending, expectCode("E_AITERM_TRANSPORT_PROTOCOL"));
  const stderr = await initialized(); const stderrPending = stderr.transport.callTool("claude_turn", {}); stderr.child.stderr.write(Buffer.alloc(1024 * 1024 + 1));
  await assert.rejects(stderrPending, expectCode("E_AITERM_TRANSPORT_PROTOCOL"));
  const exited = await initialized(); const exitedPending = exited.transport.callTool("claude_turn", {}); exited.child.emit("exit", 1, null);
  await assert.rejects(exitedPending, expectCode("E_AITERM_TRANSPORT_UNKNOWN")); assert.equal(exited.transport.terminationSignal.aborted, true);
});

test("Aiterm closeはSIGTERMからSIGKILLへ進め、terminal closeだけを成功にする", async () => {
  const child = autoChild(); child.kill = (signal) => { child.signals.push(signal); if (signal === "SIGKILL") queueMicrotask(() => child.emit("close", null, "SIGKILL")); return true; };
  const transport = new AitermMcpTransport(child); const terminal = await transport.closeAndWait({ terminateGraceMs: 0, killGraceMs: 20 });
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  assert.deepEqual(terminal, { schema: "observer.aiterm_process_terminal.v1", status: "closed", exit_code: null, signal: "SIGKILL" });
});
