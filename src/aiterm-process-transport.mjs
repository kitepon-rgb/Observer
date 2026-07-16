import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, lstat, open, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, normalize } from "node:path";

import { ObserverError, fail } from "./observer-error.mjs";

export const AITERM_PROCESS_VERIFICATION_SCHEMA = "observer.aiterm_process_verification.v1";
export const AITERM_PROCESS_TERMINAL_SCHEMA = "observer.aiterm_process_terminal.v1";
export const SUPPORTED_AITERM_VERSION = "0.13.0";

const MCP_PROTOCOL_VERSION = "2025-11-25";
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 1024 * 1024;
const METHOD_RE = /^[A-Za-z][A-Za-z0-9]*(?:\/[A-Za-z][A-Za-z0-9]*)*$/;
const SESSION_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TOOL_ALLOWLIST = new Set(["claude_agent", "claude_turn", "pty_close"]);
const ENV_ALLOWLIST = Object.freeze([
  "AITERM_HOME", "CLAUDE_BIN", "HOME", "LANG", "LC_ALL", "PATH", "SHELL", "TMPDIR", "USER",
  "USERPROFILE", "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR", "XDG_STATE_HOME",
]);

export async function verifyAitermRuntime({ runtimeRoot, aitermCommand } = {}, dependencies = {}) {
  const canonicalRoot = await canonicalRuntimeRoot(runtimeRoot, dependencies);
  const effectiveUid = dependencies.effectiveUid ?? (typeof process.getuid === "function" ? process.getuid() : null);
  if (!Number.isInteger(effectiveUid)) fail("E_AITERM_RUNTIME_OWNER_UNAVAILABLE", "effective UIDを確認できません");
  const inspect = dependencies.inspectExecutable ?? inspectExecutable;
  const aiterm = await inspect({ candidate: aitermCommand, effectiveUid }, dependencies);
  await recheckExecutableIdentity(aiterm, dependencies);
  return {
    schema: AITERM_PROCESS_VERIFICATION_SCHEMA,
    runtime_root: canonicalRoot,
    aiterm: { ...aiterm, required_version: SUPPORTED_AITERM_VERSION },
  };
}

export async function startAitermMcpTransport({ verification } = {}, dependencies = {}) {
  validateVerification(verification);
  await recheckExecutableIdentity(verification.aiterm, dependencies);
  const spawnProcess = dependencies.spawn ?? spawn;
  let child;
  try {
    child = spawnProcess(verification.aiterm.realpath, [], {
      cwd: verification.runtime_root,
      env: boundedEnv(dependencies.env ?? process.env),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch {
    fail("E_AITERM_PROCESS_START_FAILED", "Aiterm MCP processを起動できません");
  }
  const transport = new AitermMcpTransport(child, {
    beforeCall: () => recheckExecutableIdentity(verification.aiterm, dependencies),
  });
  try {
    await transport.initialize();
    await recheckExecutableIdentity(verification.aiterm, dependencies);
    return transport;
  } catch (error) {
    try {
      await transport.closeAndWait();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Aiterm MCP初期化とcleanupが失敗しました");
    }
    throw error;
  }
}

export class AitermMcpTransport {
  #child;
  #closed = false;
  #initialized = false;
  #initializing = false;
  #nextId = 1;
  #pending = new Map();
  #stdout = Buffer.alloc(0);
  #stderrBytes = 0;
  #terminal = null;
  #resolveTerminal;
  #terminalPromise;
  #terminationController = new AbortController();
  #beforeCall;

  constructor(child, { beforeCall = null } = {}) {
    validateChild(child);
    if (beforeCall !== null && typeof beforeCall !== "function") {
      fail("E_AITERM_PROCESS_HANDLE_INVALID", "Aiterm MCP operation identity callbackが不正です");
    }
    this.#child = child;
    this.#beforeCall = beforeCall;
    this.#terminalPromise = new Promise((resolve) => { this.#resolveTerminal = resolve; });
    child.stdout.on("data", (chunk) => this.#consumeStdout(chunk));
    child.stdout.on("end", () => this.#abort("E_AITERM_TRANSPORT_UNKNOWN", "Aiterm MCP stdoutが終了しました"));
    child.stderr.on("data", (chunk) => this.#consumeStderr(chunk));
    child.on("error", () => this.#abort("E_AITERM_TRANSPORT_UNKNOWN", "Aiterm MCP process errorで結果が不明です"));
    child.on("exit", () => this.#abort("E_AITERM_TRANSPORT_UNKNOWN", "Aiterm MCP process終了で結果が不明です", false));
    child.on("close", (code, signal) => this.#recordTerminal(code, signal));
  }

  async initialize() {
    this.#requireOpen();
    if (this.#initialized || this.#initializing) fail("E_AITERM_CONNECTION_ALREADY_INITIALIZED", "Aiterm MCP initializeは一度だけ実行できます");
    this.#initializing = true;
    try {
      const initialized = await this.#request("initialize", {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "observer", version: "1" },
      });
      validateInitializeResult(initialized);
      await this.#notify("notifications/initialized", {});
      const listed = await this.#request("tools/list", {});
      validateRequiredTools(listed);
      this.#initialized = true;
    } catch (error) {
      this.#abort("E_AITERM_INITIALIZE_FAILED", "Aiterm MCP公開契約をinitializeできません");
      throw error instanceof ObserverError
        ? error
        : new ObserverError("E_AITERM_INITIALIZE_FAILED", "Aiterm MCP公開契約をinitializeできません");
    } finally {
      this.#initializing = false;
    }
  }

  async callTool(name, args) {
    this.#requireInitialized();
    if (!TOOL_ALLOWLIST.has(name) || !isPlainObject(args)) {
      fail("E_AITERM_TOOL_INPUT_INVALID", "Aiterm tool名またはargumentsが不正です");
    }
    if (this.#beforeCall !== null) await this.#beforeCall();
    const result = await this.#request("tools/call", { name, arguments: structuredClone(args) });
    if (!isPlainObject(result) || !Array.isArray(result.content) ||
        result.content.some((item) => !isPlainObject(item) || item.type !== "text" || typeof item.text !== "string")) {
      fail("E_AITERM_TOOL_RESULT_INVALID", "Aiterm tool result schemaが不正です");
    }
    if (result.isError === true) {
      throw new ObserverError("E_AITERM_TOOL_ERROR", "Aiterm toolが明示errorを返しました");
    }
    if (Object.hasOwn(result, "isError") && result.isError !== false) {
      fail("E_AITERM_TOOL_RESULT_INVALID", "Aiterm tool error flagが不正です");
    }
    const allowed = new Set(["content", "structuredContent", ...(Object.hasOwn(result, "isError") ? ["isError"] : [])]);
    if (Object.keys(result).some((key) => !allowed.has(key))) {
      fail("E_AITERM_TOOL_RESULT_INVALID", "Aiterm tool resultに未対応fieldがあります");
    }
    if (result.structuredContent !== undefined && !isPlainObject(result.structuredContent)) {
      fail("E_AITERM_TOOL_RESULT_INVALID", "Aiterm structuredContentが不正です");
    }
    return result.structuredContent === undefined ? null : structuredClone(result.structuredContent);
  }

  get terminationSignal() {
    return this.#terminationController.signal;
  }

  close() {
    if (this.#closed) return;
    this.#abort("E_AITERM_TRANSPORT_CLOSED", "Aiterm MCP transportを明示終了しました");
  }

  async closeAndWait({ terminateGraceMs = 1_000, killGraceMs = 1_000 } = {}) {
    if (![terminateGraceMs, killGraceMs].every((value) => Number.isSafeInteger(value) && value >= 0 && value <= 60_000)) {
      fail("E_AITERM_PROCESS_TERMINATION_CONFIG", "Aiterm process終了待機設定が不正です");
    }
    this.close();
    if (this.#terminal !== null) return structuredClone(this.#terminal);
    let killTimer;
    let unknownTimer;
    const unknown = new Promise((_resolve, reject) => {
      killTimer = setTimeout(() => {
        if (this.#terminal === null) {
          try { this.#child.kill("SIGKILL"); } catch {}
        }
      }, terminateGraceMs);
      unknownTimer = setTimeout(() => {
        if (this.#terminal === null) {
          reject(new ObserverError("E_AITERM_PROCESS_TERMINATION_UNKNOWN", "Aiterm MCP processの終了を確認できません"));
        }
      }, terminateGraceMs + killGraceMs);
    });
    try {
      return await Promise.race([this.#terminalPromise, unknown]);
    } finally {
      clearTimeout(killTimer);
      clearTimeout(unknownTimer);
    }
  }

  #request(method, params) {
    this.#requireOpen();
    validateMethodAndParams(method, params);
    if (!Number.isSafeInteger(this.#nextId)) fail("E_AITERM_REQUEST_ID_EXHAUSTED", "Aiterm request IDを採番できません");
    const id = this.#nextId;
    this.#nextId += 1;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      void this.#write({ jsonrpc: "2.0", id, method, params }).catch(() => {});
    });
  }

  #notify(method, params) {
    this.#requireOpen();
    validateMethodAndParams(method, params);
    return this.#write({ jsonrpc: "2.0", method, params });
  }

  #write(message) {
    const line = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
      this.#abort("E_AITERM_TRANSPORT_PROTOCOL", "Aiterm MCP outbound lineが上限を超えました");
      return Promise.reject(new ObserverError("E_AITERM_TRANSPORT_PROTOCOL", "Aiterm MCP outbound lineが上限を超えました"));
    }
    return new Promise((resolve, reject) => {
      try {
        this.#child.stdin.write(line, "utf8", (error) => {
          if (error) {
            this.#abort("E_AITERM_TRANSPORT_UNKNOWN", "Aiterm MCP write結果が不明です");
            reject(new ObserverError("E_AITERM_TRANSPORT_UNKNOWN", "Aiterm MCP write結果が不明です"));
          } else resolve();
        });
      } catch {
        this.#abort("E_AITERM_TRANSPORT_UNKNOWN", "Aiterm MCP write結果が不明です");
        reject(new ObserverError("E_AITERM_TRANSPORT_UNKNOWN", "Aiterm MCP write結果が不明です"));
      }
    });
  }

  #consumeStdout(chunk) {
    if (this.#closed) return;
    if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) {
      return this.#abort("E_AITERM_TRANSPORT_PROTOCOL", "Aiterm stdout chunkがbinaryではありません");
    }
    if (chunk.length > MAX_LINE_BYTES * 2) return this.#abort("E_AITERM_TRANSPORT_PROTOCOL", "Aiterm stdout chunkが上限を超えました");
    this.#stdout = Buffer.concat([this.#stdout, Buffer.from(chunk)]);
    if (this.#stdout.length > MAX_LINE_BYTES && !this.#stdout.includes(0x0a)) {
      return this.#abort("E_AITERM_TRANSPORT_PROTOCOL", "Aiterm MCP lineが上限を超えました");
    }
    while (!this.#closed) {
      const newline = this.#stdout.indexOf(0x0a);
      if (newline === -1) break;
      if (newline > MAX_LINE_BYTES) return this.#abort("E_AITERM_TRANSPORT_PROTOCOL", "Aiterm MCP lineが上限を超えました");
      const encoded = this.#stdout.subarray(0, newline);
      this.#stdout = this.#stdout.subarray(newline + 1);
      if (encoded.length === 0) return this.#abort("E_AITERM_TRANSPORT_PROTOCOL", "Aiterm MCPが空lineを返しました");
      let message;
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(encoded);
        message = JSON.parse(text);
      } catch {
        return this.#abort("E_AITERM_TRANSPORT_PROTOCOL", "Aiterm MCP JSONLが不正です");
      }
      this.#consumeMessage(message);
    }
  }

  #consumeMessage(message) {
    if (!isPlainObject(message) || message.jsonrpc !== "2.0") {
      return this.#abort("E_AITERM_TRANSPORT_PROTOCOL", "Aiterm MCP messageがJSON-RPC 2.0ではありません");
    }
    if (Object.hasOwn(message, "id") && !Object.hasOwn(message, "method")) return this.#consumeResponse(message);
    if (!Object.hasOwn(message, "id") && Object.hasOwn(message, "method")) return this.#consumeNotification(message);
    this.#abort("E_AITERM_TRANSPORT_PROTOCOL", "Aiterm MCPから未対応server requestを受信しました");
  }

  #consumeResponse(message) {
    const keys = Object.keys(message).sort().join(",");
    const success = keys === "id,jsonrpc,result";
    const failure = keys === "error,id,jsonrpc";
    if ((!success && !failure) || !Number.isSafeInteger(message.id) || message.id < 1) {
      return this.#abort("E_AITERM_TRANSPORT_PROTOCOL", "Aiterm MCP response schemaが不正です");
    }
    const pending = this.#pending.get(message.id);
    if (pending === undefined) return this.#abort("E_AITERM_TRANSPORT_PROTOCOL", "Aiterm MCP response IDが未知または重複です");
    this.#pending.delete(message.id);
    if (success) pending.resolve(message.result);
    else pending.reject(new ObserverError("E_AITERM_MCP_RESPONSE_ERROR", "Aiterm MCP requestがerror responseを返しました"));
  }

  #consumeNotification(message) {
    if (!hasExactKeys(message, ["jsonrpc", "method", "params"]) || !METHOD_RE.test(message.method) || !isPlainObject(message.params)) {
      return this.#abort("E_AITERM_TRANSPORT_PROTOCOL", "Aiterm MCP notification schemaが不正です");
    }
  }

  #consumeStderr(chunk) {
    if (this.#closed) return;
    if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) {
      return this.#abort("E_AITERM_TRANSPORT_PROTOCOL", "Aiterm stderr chunkがbinaryではありません");
    }
    this.#stderrBytes += chunk.length;
    if (this.#stderrBytes > MAX_STDERR_BYTES) this.#abort("E_AITERM_TRANSPORT_PROTOCOL", "Aiterm MCP stderrが上限を超えました");
  }

  #requireOpen() {
    if (this.#closed) fail("E_AITERM_TRANSPORT_CLOSED", "Aiterm MCP transportは終了済みです");
  }

  #requireInitialized() {
    this.#requireOpen();
    if (!this.#initialized) fail("E_AITERM_CONNECTION_NOT_INITIALIZED", "Aiterm MCP initializeが完了していません");
  }

  #abort(code, message, terminate = true) {
    if (this.#closed) return;
    this.#closed = true;
    this.#terminationController.abort();
    const error = new ObserverError(code, message);
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    try { this.#child.stdin.end(); } catch {}
    if (terminate) {
      try { this.#child.kill("SIGTERM"); } catch {}
    }
  }

  #recordTerminal(exitCode, signal) {
    if (this.#terminal !== null) return;
    this.#abort("E_AITERM_TRANSPORT_UNKNOWN", "Aiterm MCP process終了で結果が不明です", false);
    this.#terminal = {
      schema: AITERM_PROCESS_TERMINAL_SCHEMA,
      status: "closed",
      exit_code: Number.isInteger(exitCode) ? exitCode : null,
      signal: typeof signal === "string" && signal.length > 0 ? signal : null,
    };
    this.#resolveTerminal(structuredClone(this.#terminal));
  }
}

function validateInitializeResult(value) {
  if (!isPlainObject(value) || value.protocolVersion !== MCP_PROTOCOL_VERSION ||
      !isPlainObject(value.serverInfo) || value.serverInfo.name !== "aiterm" ||
      value.serverInfo.version !== SUPPORTED_AITERM_VERSION || !isPlainObject(value.capabilities)) {
    fail("E_AITERM_VERSION_UNSUPPORTED", "Aiterm MCP initialize結果が固定version／protocolと一致しません");
  }
}

function validateRequiredTools(value) {
  if (!isPlainObject(value) || !Array.isArray(value.tools) ||
      (Object.hasOwn(value, "nextCursor") && value.nextCursor !== null)) {
    fail("E_AITERM_TOOL_SCHEMA_MISMATCH", "Aiterm MCP tools/listが不正です");
  }
  const names = value.tools.map((tool) => tool?.name);
  if (names.some((name) => typeof name !== "string") || new Set(names).size !== names.length) {
    fail("E_AITERM_TOOL_SCHEMA_MISMATCH", "Aiterm MCP tool名が不正です");
  }
  const claudeAgent = value.tools.find((tool) => tool.name === "claude_agent");
  const claudeTurn = value.tools.find((tool) => tool.name === "claude_turn");
  const close = value.tools.find((tool) => tool.name === "pty_close");
  if (!claudeAgent || !claudeTurn || !close ||
      claudeAgent.outputSchema?.properties?.schema?.const !== "aiterm.agent-launch-result.v1" ||
      claudeAgent.outputSchema?.properties?.provider?.const !== "claude" ||
      claudeAgent.outputSchema?.properties?.session_id?.pattern !== "^[A-Za-z0-9_-]{1,64}$" ||
      claudeAgent.outputSchema?.properties?.managed_completion?.type !== "boolean" ||
      claudeAgent.inputSchema?.properties?.agent_done?.type !== "boolean" ||
      claudeTurn.outputSchema?.properties?.schema?.const !== "aiterm.claude-operation-result.v1" ||
      claudeTurn.inputSchema?.properties?.operation_id?.pattern !== "^sha256:[0-9a-f]{64}$" ||
      claudeTurn.inputSchema?.properties?.session_id?.type !== "string" ||
      !Array.isArray(claudeTurn.inputSchema?.properties?.action?.enum) ||
      claudeTurn.inputSchema.properties.action.enum.join(",") !== "issue,recover" ||
      close.inputSchema?.properties?.session_id?.type !== "string") {
    fail("E_AITERM_TOOL_SCHEMA_MISMATCH", "Aiterm Claude公開tool schemaが固定契約と一致しません");
  }
}

async function canonicalRuntimeRoot(value, dependencies) {
  if (typeof value !== "string" || !isAbsolute(value) || normalize(value) !== value || hasControl(value)) {
    fail("E_AITERM_RUNTIME_ROOT_INVALID", "Observer runtime rootが不正です");
  }
  const canonical = await (dependencies.realpath ?? realpath)(value);
  if (canonical !== value) fail("E_AITERM_RUNTIME_ROOT_INVALID", "Observer runtime rootはcanonical pathである必要があります");
  return canonical;
}

async function inspectExecutable({ candidate, effectiveUid }, dependencies) {
  if (typeof candidate !== "string" || !isAbsolute(candidate) || normalize(candidate) !== candidate || hasControl(candidate)) {
    fail("E_AITERM_RUNTIME_EXECUTABLE_INVALID", "Aiterm executable pathが不正です");
  }
  const canonical = await (dependencies.realpath ?? realpath)(candidate);
  await verifyAncestors(canonical, effectiveUid, dependencies);
  const handle = await (dependencies.open ?? open)(canonical, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const info = await handle.stat({ bigint: true });
    if (!info.isFile() || (info.mode & 0o111n) === 0n || (info.mode & 0o022n) !== 0n || ![0, effectiveUid].includes(Number(info.uid))) {
      fail("E_AITERM_RUNTIME_EXECUTABLE_INVALID", "Aiterm executableのownerまたはmodeが不正です");
    }
    await (dependencies.access ?? access)(canonical, fsConstants.X_OK);
    return {
      candidate, realpath: canonical, uid: Number(info.uid), gid: Number(info.gid), mode: Number(info.mode & 0o7777n),
      dev: info.dev.toString(), ino: info.ino.toString(), size: info.size.toString(), mtime_ns: info.mtimeNs.toString(),
      digest: await digestOpenFile(handle),
    };
  } finally {
    await handle.close();
  }
}

async function verifyAncestors(actual, effectiveUid, dependencies) {
  let current = dirname(actual);
  while (true) {
    const info = await (dependencies.lstat ?? lstat)(current, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o002n) !== 0n || ![0, effectiveUid].includes(Number(info.uid))) {
      fail("E_AITERM_RUNTIME_ANCESTOR_INVALID", "Aiterm executable ancestorのownerまたはmodeが不正です");
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

async function digestOpenFile(handle) {
  const hash = createHash("sha256");
  for await (const chunk of handle.createReadStream({ autoClose: false, start: 0 })) hash.update(chunk);
  return hash.digest("hex");
}

async function recheckExecutableIdentity(identity, dependencies) {
  const check = dependencies.recheckIdentity ?? recheckIdentity;
  await check(identity, dependencies);
}

async function recheckIdentity(identity, dependencies) {
  if (await (dependencies.realpath ?? realpath)(identity.candidate) !== identity.realpath) {
    fail("E_AITERM_RUNTIME_IDENTITY_CHANGED", "Aiterm executable realpathがverification後に変わりました");
  }
  const info = await (dependencies.stat ?? stat)(identity.realpath, { bigint: true });
  const current = {
    uid: Number(info.uid), gid: Number(info.gid), mode: Number(info.mode & 0o7777n), dev: info.dev.toString(),
    ino: info.ino.toString(), size: info.size.toString(), mtime_ns: info.mtimeNs.toString(),
  };
  for (const key of Object.keys(current)) {
    if (current[key] !== identity[key]) fail("E_AITERM_RUNTIME_IDENTITY_CHANGED", "Aiterm executable identityがverification後に変わりました");
  }
}

function validateVerification(value) {
  if (!isPlainObject(value) || !hasExactKeys(value, ["aiterm", "runtime_root", "schema"]) ||
      value.schema !== AITERM_PROCESS_VERIFICATION_SCHEMA || typeof value.runtime_root !== "string" ||
      !isAbsolute(value.runtime_root) || normalize(value.runtime_root) !== value.runtime_root || hasControl(value.runtime_root) ||
      !isPlainObject(value.aiterm) || !hasExactKeys(value.aiterm, [
        "candidate", "dev", "digest", "gid", "ino", "mode", "mtime_ns", "realpath", "required_version", "size", "uid",
      ]) || value.aiterm.required_version !== SUPPORTED_AITERM_VERSION ||
      ![value.aiterm.candidate, value.aiterm.realpath].every((entry) =>
        typeof entry === "string" && isAbsolute(entry) && normalize(entry) === entry && !hasControl(entry)) ||
      ![value.aiterm.uid, value.aiterm.gid, value.aiterm.mode].every(Number.isInteger) ||
      ![value.aiterm.dev, value.aiterm.ino, value.aiterm.size, value.aiterm.mtime_ns]
        .every((entry) => typeof entry === "string" && /^\d+$/.test(entry)) ||
      typeof value.aiterm.digest !== "string" || !/^[a-f0-9]{64}$/.test(value.aiterm.digest)) {
    fail("E_AITERM_PROCESS_VERIFICATION_INVALID", "Aiterm process verificationが不正です");
  }
}

function validateChild(child) {
  if ((typeof child !== "object" && typeof child !== "function") || child === null ||
      typeof child.on !== "function" || typeof child.kill !== "function" ||
      typeof child.stdin?.write !== "function" || typeof child.stdin?.end !== "function" ||
      typeof child.stdout?.on !== "function" || typeof child.stderr?.on !== "function") {
    fail("E_AITERM_PROCESS_HANDLE_INVALID", "Aiterm MCP process handleが不正です");
  }
}

function validateMethodAndParams(method, params) {
  if (typeof method !== "string" || !METHOD_RE.test(method) || !isPlainObject(params)) {
    fail("E_AITERM_TRANSPORT_REQUEST_INVALID", "Aiterm MCP methodまたはparamsが不正です");
  }
}

function boundedEnv(source = process.env) {
  const result = { NO_COLOR: "1" };
  for (const key of ENV_ALLOWLIST) if (typeof source[key] === "string") result[key] = source[key];
  return result;
}

function hasControl(value) {
  return /[\u0000-\u001f\u007f]/u.test(value);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function hasExactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

export function validateClaudeSessionId(value) {
  if (typeof value !== "string" || !SESSION_RE.test(value)) fail("E_AITERM_SESSION_ID_INVALID", "Aiterm Claude session IDが不正です");
  return value;
}
