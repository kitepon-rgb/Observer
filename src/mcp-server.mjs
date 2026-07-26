import { TextDecoder } from "node:util";

import { ObserverError } from "./observer-error.mjs";
import { defaultStateRoot } from "./private-state.mjs";
import { createThroughlineClient } from "./throughline-client.mjs";
import { readWatchStatus } from "./watch-store.mjs";

export const OBSERVER_MCP_PROTOCOL_VERSION = "2025-11-25";
export const OBSERVER_MCP_SERVER_VERSION = "0.1.2";
export const OBSERVER_MCP_MAX_MESSAGE_BYTES = 64 * 1024;
export const OBSERVER_MCP_DIAGNOSTICS_SCHEMA = "observer.mcp_diagnostics.v1";
export const OBSERVER_MCP_PROTOCOL_VERSIONS = Object.freeze([
  OBSERVER_MCP_PROTOCOL_VERSION,
  "2025-06-18",
]);

const SUPPORTED_PROTOCOL_VERSIONS = new Set(OBSERVER_MCP_PROTOCOL_VERSIONS);
const TARGET_ID_RE = /^p_[a-f0-9]{64}$/;
const WATCH_ID_RE = /^w_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CURSOR_MAX_BYTES = 4096;
const LIVE_TOOL_STATUSES = new Set(["launching", "active"]);

const IDENTITY_PROPERTIES = {
  provider: { type: "string", enum: ["claude", "codex"] },
  target_id: { type: "string", pattern: "^p_[a-f0-9]{64}$" },
  watch_id: { type: "string", pattern: "^w_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$" },
  project_root: { type: "string", minLength: 1, maxLength: 4096 },
};

const READ_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    schema: { type: "string", const: "throughline.observer_read.v1" },
    status: { type: "string", enum: ["snapshot", "delta", "thread_switched", "host_switched", "resync_required", "projection_pending", "ambiguous_parent"] },
    host: { anyOf: [{ type: "string", enum: ["claude", "codex"] }, { type: "null" }] },
    thread_sha256: { anyOf: [{ type: "string", pattern: "^[a-f0-9]{64}$" }, { type: "null" }] },
    afterCursor: { anyOf: [{ type: "string" }, { type: "null" }] },
    throughCursor: { anyOf: [{ type: "string" }, { type: "null" }] },
    turns: { type: "array", items: { type: "object" } },
    historyTruncated: { type: "boolean" },
    page: {
      type: "object",
      properties: { complete: { type: "boolean" }, nextToken: { anyOf: [{ type: "string" }, { type: "null" }] } },
      required: ["complete", "nextToken"],
      additionalProperties: false,
    },
  },
  required: ["schema", "status", "host", "thread_sha256", "afterCursor", "throughCursor", "turns", "historyTruncated", "page"],
  additionalProperties: false,
};

const WAIT_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    schema: { type: "string", const: "throughline.observer_wait.v1" },
    status: { type: "string", enum: ["changed", "timeout", "resync_required", "ambiguous_parent"] },
    afterCursor: { type: "string" },
    throughCursor: { anyOf: [{ type: "string" }, { type: "null" }] },
  },
  required: ["schema", "status", "afterCursor", "throughCursor"],
  additionalProperties: false,
};

const TOOL_ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export const OBSERVER_MCP_TOOLS = Object.freeze([
  {
    name: "observer_read",
    title: "Read completed Observer turns",
    description: "Read a bounded completed-turn page from the exact active Observer watch.",
    inputSchema: {
      type: "object",
      properties: {
        ...IDENTITY_PROPERTIES,
        after_cursor: { type: "string", minLength: 1, maxLength: CURSOR_MAX_BYTES },
        through_cursor: { type: "string", minLength: 1, maxLength: CURSOR_MAX_BYTES },
        page_token: { type: "string", minLength: 1, maxLength: CURSOR_MAX_BYTES },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      required: ["provider", "target_id", "watch_id", "project_root"],
      additionalProperties: false,
    },
    outputSchema: READ_OUTPUT_SCHEMA,
    annotations: TOOL_ANNOTATIONS,
    execution: { taskSupport: "forbidden" },
  },
  {
    name: "observer_wait",
    title: "Wait for a completed Observer turn",
    description: "Wait for the completed cursor of the exact active Observer watch to change.",
    inputSchema: {
      type: "object",
      properties: {
        ...IDENTITY_PROPERTIES,
        after_cursor: { type: "string", minLength: 1, maxLength: CURSOR_MAX_BYTES },
        timeout_seconds: { type: "integer", minimum: 1, maximum: 3600 },
      },
      required: ["provider", "target_id", "watch_id", "project_root", "after_cursor"],
      additionalProperties: false,
    },
    outputSchema: WAIT_OUTPUT_SCHEMA,
    annotations: TOOL_ANNOTATIONS,
    execution: { taskSupport: "forbidden" },
  },
]);

export function observerMcpDiagnostics() {
  return {
    schema: OBSERVER_MCP_DIAGNOSTICS_SCHEMA,
    status: "ready",
    server_version: OBSERVER_MCP_SERVER_VERSION,
    protocol_versions: [...OBSERVER_MCP_PROTOCOL_VERSIONS],
    tools: OBSERVER_MCP_TOOLS.map((tool) => tool.name),
    production_ai_surface: "disabled",
  };
}

class ProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function createObserverMcpSession({
  stateRoot = defaultStateRoot(),
  throughlineClient = createThroughlineClient(),
  readWatchStatusFn = readWatchStatus,
} = {}) {
  let phase = "new";
  let closed = false;
  const pending = new Map();

  const receive = async (message) => {
    const id = validRequestId(message?.id) ? message.id : null;
    try {
      validateMessageEnvelope(message);
      if (!Object.hasOwn(message, "id")) return handleNotification(message);
      const key = requestKey(message.id);
      if (pending.has(key)) throw new ProtocolError(-32600, "duplicate active request id");
      if (closed) throw new ProtocolError(-32600, "server is closed");
      const controller = new AbortController();
      pending.set(key, controller);
      try {
        const result = await handleRequest(message, controller.signal);
        return successResponse(message.id, result);
      } finally {
        pending.delete(key);
      }
    } catch (error) {
      const normalized = error instanceof ProtocolError ? error : new ProtocolError(-32603, "internal MCP error");
      return errorResponse(id, normalized.code, normalized.message);
    }
  };

  const handleRequest = async (message, signal) => {
    if (message.method === "ping") return {};
    if (message.method === "initialize") {
      if (phase !== "new") throw new ProtocolError(-32600, "initialize is only valid once");
      validateInitializeParams(message.params);
      phase = "initializing";
      const requested = message.params.protocolVersion;
      return {
        protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.has(requested) ? requested : OBSERVER_MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: {
          name: "observer",
          version: OBSERVER_MCP_SERVER_VERSION,
          description: "Read-only completed-turn compatibility and diagnostics adapter",
        },
      };
    }
    if (phase !== "ready") throw new ProtocolError(-32600, "MCP session is not initialized");
    if (message.method === "tools/list") {
      validateToolsListParams(message.params);
      return { tools: structuredClone(OBSERVER_MCP_TOOLS) };
    }
    if (message.method === "tools/call") return callTool(message.params, signal);
    throw new ProtocolError(-32601, "method not found");
  };

  const handleNotification = (message) => {
    if (message.method === "notifications/initialized") {
      if (phase !== "initializing") {
        close();
        return null;
      }
      phase = "ready";
      return null;
    }
    if (message.method === "notifications/cancelled") {
      const requestId = message.params?.requestId;
      if (validRequestId(requestId)) pending.get(requestKey(requestId))?.abort();
      return null;
    }
    return null;
  };

  const callTool = async (params, signal) => {
    if (!isPlainObject(params) || !hasExactKeys(params, ["name", "arguments"]) || typeof params.name !== "string" || !isPlainObject(params.arguments)) {
      throw new ProtocolError(-32602, "invalid tool call arguments");
    }
    if (params.name !== "observer_read" && params.name !== "observer_wait") throw new ProtocolError(-32602, "unknown tool");
    const args = validateToolArguments(params.name, params.arguments);
    try {
      const projectPath = await authorizeWatch(args);
      const result = params.name === "observer_read"
        ? await throughlineClient.read({
            projectPath,
            afterCursor: args.after_cursor,
            throughCursor: args.through_cursor,
            pageToken: args.page_token,
            limit: args.limit,
            signal,
          })
        : await throughlineClient.wait({ projectPath, afterCursor: args.after_cursor, timeoutSeconds: args.timeout_seconds, signal });
      return toolSuccess(result);
    } catch (error) {
      return toolFailure(error);
    }
  };

  const authorizeWatch = async (args) => {
    let status;
    try {
      status = await readWatchStatusFn({ stateRoot, targetId: args.target_id });
    } catch {
      throw new ObserverError("E_MCP_WATCH_UNAUTHORIZED", "Observer watch authorization failed");
    }
    if (status === null || status.target_id !== args.target_id || status.watch_id !== args.watch_id ||
        status.project_root !== args.project_root || status.provider !== args.provider || !LIVE_TOOL_STATUSES.has(status.status)) {
      throw new ObserverError("E_MCP_WATCH_UNAUTHORIZED", "Observer watch authorization failed");
    }
    return status.project_root;
  };

  const close = () => {
    if (closed) return;
    closed = true;
    for (const controller of pending.values()) controller.abort();
  };

  return { receive, close, get phase() { return phase; }, get pendingCount() { return pending.size; } };
}

export function runObserverMcpStdio({
  input = process.stdin,
  output = process.stdout,
  diagnostics = process.stderr,
  maxMessageBytes = OBSERVER_MCP_MAX_MESSAGE_BYTES,
  ...sessionOptions
} = {}) {
  if (!Number.isSafeInteger(maxMessageBytes) || maxMessageBytes < 1) throw new TypeError("invalid MCP message limit");
  const session = createObserverMcpSession(sessionOptions);
  let buffered = Buffer.alloc(0);
  let ended = false;
  const writeMessage = (message) => {
    if (!ended && message !== null) output.write(`${JSON.stringify(message)}\n`);
  };
  const failTransport = (message) => {
    if (ended) return;
    diagnostics.write(`${message}\n`);
    writeMessage(errorResponse(null, -32700, "invalid JSON-RPC message"));
    ended = true;
    session.close();
    input.pause?.();
  };
  const onData = (chunk) => {
    if (ended) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    buffered = Buffer.concat([buffered, bytes]);
    while (!ended) {
      const newline = buffered.indexOf(0x0a);
      if (newline === -1) {
        if (buffered.length > maxMessageBytes) failTransport("Observer MCP input exceeded the bounded message limit");
        return;
      }
      if (newline > maxMessageBytes) {
        failTransport("Observer MCP input exceeded the bounded message limit");
        return;
      }
      const line = buffered.subarray(0, newline);
      buffered = buffered.subarray(newline + 1);
      let message;
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(line);
        message = JSON.parse(text);
      } catch {
        failTransport("Observer MCP received invalid UTF-8 or JSON");
        return;
      }
      session.receive(message).then(writeMessage, () => writeMessage(errorResponse(null, -32603, "internal MCP error")));
    }
  };
  const onEnd = () => {
    if (ended) return;
    if (buffered.length !== 0) {
      failTransport("Observer MCP input ended with a partial message");
      return;
    }
    ended = true;
    session.close();
  };
  input.on("data", onData);
  input.once("end", onEnd);
  input.once("close", onEnd);
  return {
    session,
    close() {
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      input.removeListener("close", onEnd);
      ended = true;
      session.close();
    },
  };
}

function validateMessageEnvelope(value) {
  if (!isPlainObject(value) || value.jsonrpc !== "2.0" || typeof value.method !== "string" || value.method.length === 0 ||
      !hasExactKeys(value, Object.hasOwn(value, "id") ? ["jsonrpc", "id", "method", ...(Object.hasOwn(value, "params") ? ["params"] : [])] : ["jsonrpc", "method", ...(Object.hasOwn(value, "params") ? ["params"] : [])])) {
    throw new ProtocolError(-32600, "invalid JSON-RPC request");
  }
  if (Object.hasOwn(value, "id") && !validRequestId(value.id)) throw new ProtocolError(-32600, "invalid request id");
  if (Object.hasOwn(value, "params") && !isPlainObject(value.params)) throw new ProtocolError(-32602, "invalid params");
}

function validateInitializeParams(value) {
  if (!isPlainObject(value) || typeof value.protocolVersion !== "string" || !isPlainObject(value.capabilities) || !isPlainObject(value.clientInfo)) {
    throw new ProtocolError(-32602, "invalid initialize params");
  }
}

function validateToolsListParams(value) {
  if (value === undefined) return;
  if (!isPlainObject(value) || !hasExactKeys(value, []) ) throw new ProtocolError(-32602, "tools/list pagination is not supported");
}

function validateToolArguments(name, value) {
  const identityKeys = ["provider", "target_id", "watch_id", "project_root"];
  const optional = name === "observer_read" ? ["after_cursor", "through_cursor", "page_token", "limit"] : ["timeout_seconds"];
  const required = name === "observer_wait" ? [...identityKeys, "after_cursor"] : identityKeys;
  const allowed = new Set([...required, ...optional]);
  if (!hasOnlyKeys(value, allowed) || required.some((key) => !Object.hasOwn(value, key))) throw new ProtocolError(-32602, "invalid tool arguments");
  if (!["claude", "codex"].includes(value.provider) || !TARGET_ID_RE.test(value.target_id) || !WATCH_ID_RE.test(value.watch_id) || !validAbsolutePath(value.project_root)) {
    throw new ProtocolError(-32602, "invalid watch identity");
  }
  for (const key of ["after_cursor", "through_cursor", "page_token"]) if (Object.hasOwn(value, key) && !validCursor(value[key])) throw new ProtocolError(-32602, "invalid cursor");
  if (Object.hasOwn(value, "limit") && (!Number.isSafeInteger(value.limit) || value.limit < 1 || value.limit > 100)) throw new ProtocolError(-32602, "invalid limit");
  if (Object.hasOwn(value, "timeout_seconds") && (!Number.isSafeInteger(value.timeout_seconds) || value.timeout_seconds < 1 || value.timeout_seconds > 3600)) throw new ProtocolError(-32602, "invalid timeout");
  if (name === "observer_read" && Object.hasOwn(value, "page_token") && (!Object.hasOwn(value, "after_cursor") || !Object.hasOwn(value, "through_cursor"))) throw new ProtocolError(-32602, "invalid pagination relation");
  return value;
}

function toolSuccess(value) {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value, isError: false };
}

function toolFailure(error) {
  const code = error instanceof ObserverError && /^E_[A-Z0-9_]{1,127}$/.test(error.code) ? error.code : "E_OBSERVER_MCP_INTERNAL";
  const value = { schema: "observer.mcp_error.v1", status: "error", code, message: "Observer MCP tool execution failed" };
  return { content: [{ type: "text", text: JSON.stringify(value) }], isError: true };
}

function successResponse(id, result) { return { jsonrpc: "2.0", id, result }; }
function errorResponse(id, code, message) { return { jsonrpc: "2.0", id, error: { code, message } }; }
function requestKey(id) { return `${typeof id}:${String(id)}`; }
function validRequestId(value) { return typeof value === "string" && value.length > 0 && value.length <= 128 || typeof value === "number" && Number.isSafeInteger(value); }
function validCursor(value) { return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= CURSOR_MAX_BYTES; }
function validAbsolutePath(value) { return typeof value === "string" && value.startsWith("/") && value.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(value); }
function isPlainObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function hasOnlyKeys(value, allowed) { return Object.keys(value).every((key) => allowed.has(key)); }
function hasExactKeys(value, expected) { const actual = Object.keys(value).sort(); const sorted = [...expected].sort(); return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]); }
