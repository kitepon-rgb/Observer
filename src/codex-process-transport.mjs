import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, lstat, open, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, normalize } from "node:path";

import { ObserverError, fail } from "./observer-error.mjs";

export const CODEX_PROCESS_VERIFICATION_SCHEMA = "observer.codex_process_verification.v1";
export const CODEX_PROCESS_TERMINAL_SCHEMA = "observer.codex_process_terminal.v1";
export const SUPPORTED_CODEX_VERSION = "codex-cli 0.144.3";

const MAX_LINE_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 1024 * 1024;
const VERSION_TIMEOUT_MS = 5_000;
const METHOD_RE = /^[A-Za-z][A-Za-z0-9]*(?:\/[A-Za-z][A-Za-z0-9]*)*$/;
const ENV_ALLOWLIST = Object.freeze([
  "CODEX_HOME", "HOME", "LANG", "LC_ALL", "PATH", "SHELL", "TMPDIR", "USER", "USERPROFILE",
  "XDG_CONFIG_HOME", "XDG_STATE_HOME",
]);

export async function verifyCodexAppServerRuntime({ runtimeRoot, codexCommand } = {}, dependencies = {}) {
  const canonicalRoot = await canonicalRuntimeRoot(runtimeRoot, dependencies);
  const effectiveUid = dependencies.effectiveUid ?? (typeof process.getuid === "function" ? process.getuid() : null);
  if (!Number.isInteger(effectiveUid)) fail("E_CODEX_RUNTIME_OWNER_UNAVAILABLE", "effective UIDを確認できません");
  const inspect = dependencies.inspectExecutable ?? inspectExecutable;
  const codex = await inspect({ candidate: codexCommand, effectiveUid }, dependencies);
  await recheckExecutableIdentity(codex, dependencies);
  const run = dependencies.runFile ?? runFile;
  const version = await run(codex.realpath, ["--version"], commandOptions(canonicalRoot), dependencies);
  if (version.exit_code !== 0 || version.stdout.trim() !== SUPPORTED_CODEX_VERSION || version.stderr !== "") {
    fail("E_CODEX_VERSION_UNSUPPORTED", "Codex CLI versionが固定契約と一致しません");
  }
  await recheckExecutableIdentity(codex, dependencies);
  return { schema: CODEX_PROCESS_VERIFICATION_SCHEMA, runtime_root: canonicalRoot, codex: { ...codex, version: SUPPORTED_CODEX_VERSION } };
}

export async function startCodexAppServerTransport({ verification, onNotification = null } = {}, dependencies = {}) {
  validateVerification(verification);
  await recheckExecutableIdentity(verification.codex, dependencies);
  if (onNotification !== null && typeof onNotification !== "function") fail("E_CODEX_NOTIFICATION_HANDLER_INVALID", "Codex notification handlerが不正です");
  const spawnProcess = dependencies.spawn ?? spawn;
  let child;
  try {
    child = spawnProcess(verification.codex.realpath, ["app-server"], {
      cwd: verification.runtime_root,
      env: boundedEnv(dependencies.env ?? process.env),
      detached: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch {
    fail("E_CODEX_PROCESS_START_FAILED", "Codex app-server processを起動できません");
  }
  return new CodexProcessTransport(child, {
    onNotification,
    signalProcessGroup: dependencies.signalProcessGroup,
    probeProcessGroup: dependencies.probeProcessGroup,
  });
}

export class CodexProcessTransport {
  #child;
  #closed = false;
  #nextId = 1;
  #pending = new Map();
  #stdout = Buffer.alloc(0);
  #stderrBytes = 0;
  #onNotification;
  #terminal = null;
  #resolveTerminal;
  #terminalPromise;
  #terminationController = new AbortController();
  #processGroupTarget;
  #signalProcessGroup;
  #probeProcessGroup;
  #sentSignals = new Set();
  #terminationFailure = null;

  constructor(child, {
    onNotification = null,
    signalProcessGroup = defaultSignalProcessGroup,
    probeProcessGroup = defaultProbeProcessGroup,
  } = {}) {
    validateChild(child);
    if (!Number.isSafeInteger(child.pid) || child.pid <= 0) throw terminationUnknown();
    if (onNotification !== null && typeof onNotification !== "function") fail("E_CODEX_NOTIFICATION_HANDLER_INVALID", "Codex notification handlerが不正です");
    if (typeof signalProcessGroup !== "function" || typeof probeProcessGroup !== "function") fail("E_CODEX_PROCESS_GROUP_INVALID", "Codex app-server process group操作が不正です");
    this.#child = child;
    this.#onNotification = onNotification;
    this.#processGroupTarget = -child.pid;
    this.#signalProcessGroup = signalProcessGroup;
    this.#probeProcessGroup = probeProcessGroup;
    this.#terminalPromise = new Promise((resolve) => { this.#resolveTerminal = resolve; });
    child.stdout.on("data", (chunk) => this.#consumeStdout(chunk));
    child.stdout.on("end", () => this.#abort("E_CODEX_TRANSPORT_UNKNOWN", "Codex app-server stdoutが終了しました"));
    child.stderr.on("data", (chunk) => this.#consumeStderr(chunk));
    child.on("error", () => this.#abort("E_CODEX_TRANSPORT_UNKNOWN", "Codex app-server process errorで結果が不明です"));
    child.on("exit", () => this.#abort("E_CODEX_TRANSPORT_UNKNOWN", "Codex app-server process終了で結果が不明です", false));
    child.on("close", (code, signal) => this.#recordTerminal(code, signal));
  }

  request(method, params) {
    this.#requireOpen();
    validateMethodAndParams(method, params);
    if (!Number.isSafeInteger(this.#nextId)) fail("E_CODEX_REQUEST_ID_EXHAUSTED", "Codex request IDを採番できません");
    const id = this.#nextId;
    this.#nextId += 1;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      void this.#write({ id, method, params }).catch(() => {});
    });
  }

  notify(method, params) {
    this.#requireOpen();
    validateMethodAndParams(method, params);
    return this.#write({ method, params });
  }

  close() {
    if (this.#closed) return;
    this.#abort("E_CODEX_TRANSPORT_CLOSED", "Codex app-server transportを明示終了しました");
  }

  get terminationSignal() {
    return this.#terminationController.signal;
  }

  async closeAndWait({ terminateGraceMs = 1_000, killGraceMs = 1_000 } = {}) {
    if (![terminateGraceMs, killGraceMs].every((value) => Number.isSafeInteger(value) && value >= 0 && value <= 60_000)) {
      fail("E_CODEX_PROCESS_TERMINATION_CONFIG", "Codex process終了待機設定が不正です");
    }
    this.close();
    this.#ensureProcessGroupSignal("SIGTERM");
    this.#throwTerminationFailure();
    const terminated = await this.#waitForTerminalAndGroupAbsence(terminateGraceMs);
    if (terminated !== null) return terminated;
    if (this.#probeGroupAlive()) this.#ensureProcessGroupSignal("SIGKILL");
    this.#throwTerminationFailure();
    const killed = await this.#waitForTerminalAndGroupAbsence(killGraceMs);
    if (killed !== null) return killed;
    throw terminationUnknown();
  }

  #write(message) {
    const line = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
      this.#abort("E_CODEX_TRANSPORT_PROTOCOL", "Codex app-server outbound lineが上限を超えました");
      return Promise.reject(new ObserverError("E_CODEX_TRANSPORT_PROTOCOL", "Codex app-server outbound lineが上限を超えました"));
    }
    return new Promise((resolve, reject) => {
      try {
        this.#child.stdin.write(line, "utf8", (error) => {
          if (error) {
            this.#abort("E_CODEX_TRANSPORT_UNKNOWN", "Codex app-server write結果が不明です");
            reject(new ObserverError("E_CODEX_TRANSPORT_UNKNOWN", "Codex app-server write結果が不明です"));
          } else resolve();
        });
      } catch {
        this.#abort("E_CODEX_TRANSPORT_UNKNOWN", "Codex app-server write結果が不明です");
        reject(new ObserverError("E_CODEX_TRANSPORT_UNKNOWN", "Codex app-server write結果が不明です"));
      }
    });
  }

  #consumeStdout(chunk) {
    if (this.#closed) return;
    if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) return this.#abort("E_CODEX_TRANSPORT_PROTOCOL", "Codex stdout chunkがbinaryではありません");
    if (chunk.length > MAX_LINE_BYTES * 2) return this.#abort("E_CODEX_TRANSPORT_PROTOCOL", "Codex app-server stdout chunkが上限を超えました");
    this.#stdout = Buffer.concat([this.#stdout, Buffer.from(chunk)]);
    if (this.#stdout.length > MAX_LINE_BYTES && !this.#stdout.includes(0x0a)) return this.#abort("E_CODEX_TRANSPORT_PROTOCOL", "Codex app-server lineが上限を超えました");
    while (!this.#closed) {
      const newline = this.#stdout.indexOf(0x0a);
      if (newline === -1) break;
      if (newline > MAX_LINE_BYTES) return this.#abort("E_CODEX_TRANSPORT_PROTOCOL", "Codex app-server lineが上限を超えました");
      const encoded = this.#stdout.subarray(0, newline);
      this.#stdout = this.#stdout.subarray(newline + 1);
      if (encoded.length === 0) return this.#abort("E_CODEX_TRANSPORT_PROTOCOL", "Codex app-serverが空lineを返しました");
      let message;
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(encoded);
        message = JSON.parse(text);
      } catch {
        return this.#abort("E_CODEX_TRANSPORT_PROTOCOL", "Codex app-server JSONLが不正です");
      }
      this.#consumeMessage(message);
    }
  }

  #consumeMessage(message) {
    if (!isPlainObject(message)) return this.#abort("E_CODEX_TRANSPORT_PROTOCOL", "Codex app-server messageがobjectではありません");
    if (Object.hasOwn(message, "id") && !Object.hasOwn(message, "method")) return this.#consumeResponse(message);
    if (!Object.hasOwn(message, "id") && Object.hasOwn(message, "method")) return this.#consumeNotification(message);
    this.#abort("E_CODEX_TRANSPORT_PROTOCOL", "Codex app-serverから未対応のserver requestを受信しました");
  }

  #consumeResponse(message) {
    const keys = Object.keys(message).sort();
    const success = keys.length === 2 && keys[0] === "id" && keys[1] === "result";
    const failure = keys.length === 2 && keys[0] === "error" && keys[1] === "id";
    if ((!success && !failure) || !Number.isSafeInteger(message.id) || message.id < 1) {
      return this.#abort("E_CODEX_TRANSPORT_PROTOCOL", "Codex app-server response schemaが不正です");
    }
    const pending = this.#pending.get(message.id);
    if (pending === undefined) return this.#abort("E_CODEX_TRANSPORT_PROTOCOL", "Codex app-server response IDが未知または重複です");
    this.#pending.delete(message.id);
    if (success) pending.resolve(message.result);
    else pending.reject(new ObserverError("E_CODEX_APP_SERVER_RESPONSE_ERROR", "Codex app-server requestがerror responseを返しました"));
  }

  #consumeNotification(message) {
    if (!hasExactKeys(message, ["method", "params"]) || !METHOD_RE.test(message.method) || !isPlainObject(message.params)) {
      return this.#abort("E_CODEX_TRANSPORT_PROTOCOL", "Codex app-server notification schemaが不正です");
    }
    if (this.#onNotification === null) return;
    try {
      this.#onNotification(structuredClone(message));
    } catch {
      this.#abort("E_CODEX_TRANSPORT_PROTOCOL", "Codex notification handlerが失敗しました");
    }
  }

  #consumeStderr(chunk) {
    if (this.#closed) return;
    if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) return this.#abort("E_CODEX_TRANSPORT_PROTOCOL", "Codex stderr chunkがbinaryではありません");
    this.#stderrBytes += chunk.length;
    if (this.#stderrBytes > MAX_STDERR_BYTES) this.#abort("E_CODEX_TRANSPORT_PROTOCOL", "Codex app-server stderrが上限を超えました");
  }

  #requireOpen() {
    if (this.#closed) fail("E_CODEX_TRANSPORT_CLOSED", "Codex app-server transportは終了済みです");
  }

  #abort(code, message, terminate = true) {
    if (this.#closed) {
      if (terminate) this.#ensureProcessGroupSignal("SIGTERM");
      return;
    }
    this.#closed = true;
    this.#terminationController.abort();
    const error = new ObserverError(code, message);
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    try { this.#child.stdin.end(); } catch {}
    if (terminate) this.#ensureProcessGroupSignal("SIGTERM");
  }

  #recordTerminal(exitCode, signal) {
    if (this.#terminal !== null) return;
    this.#abort("E_CODEX_TRANSPORT_UNKNOWN", "Codex app-server process終了で結果が不明です", false);
    const normalizedExitCode = Number.isInteger(exitCode) ? exitCode : null;
    const normalizedSignal = typeof signal === "string" && signal.length > 0 ? signal : null;
    this.#terminal = {
      schema: CODEX_PROCESS_TERMINAL_SCHEMA,
      status: "closed",
      exit_code: normalizedExitCode,
      signal: normalizedSignal,
    };
    this.#resolveTerminal(structuredClone(this.#terminal));
  }

  #ensureProcessGroupSignal(signal) {
    if (this.#sentSignals.has(signal) || this.#terminationFailure !== null) return;
    this.#sentSignals.add(signal);
    try {
      const delivered = this.#signalProcessGroup(this.#processGroupTarget, signal);
      if (typeof delivered !== "boolean") throw new TypeError("process group signal result must be boolean");
    } catch {
      this.#terminationFailure = terminationUnknown();
    }
  }

  #probeGroupAlive() {
    this.#throwTerminationFailure();
    try {
      const alive = this.#probeProcessGroup(this.#processGroupTarget);
      if (typeof alive !== "boolean") throw new TypeError("process group probe result must be boolean");
      return alive;
    } catch (error) {
      if (error?.code === "EPERM") return true;
      this.#terminationFailure = terminationUnknown();
      throw this.#terminationFailure;
    }
  }

  #throwTerminationFailure() {
    if (this.#terminationFailure !== null) throw this.#terminationFailure;
  }

  async #waitForTerminalAndGroupAbsence(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      this.#throwTerminationFailure();
      const groupAlive = this.#probeGroupAlive();
      if (this.#terminal !== null && !groupAlive) return structuredClone(this.#terminal);
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      const delay = new Promise((resolve) => setTimeout(resolve, Math.min(10, remaining)));
      if (this.#terminal === null) await Promise.race([this.#terminalPromise, delay]);
      else await delay;
    }
  }
}

async function canonicalRuntimeRoot(value, dependencies) {
  if (typeof value !== "string" || !isAbsolute(value) || normalize(value) !== value || hasControl(value)) fail("E_CODEX_RUNTIME_ROOT_INVALID", "Observer runtime rootが不正です");
  const canonical = await (dependencies.realpath ?? realpath)(value);
  if (canonical !== value) fail("E_CODEX_RUNTIME_ROOT_INVALID", "Observer runtime rootはcanonical pathである必要があります");
  return canonical;
}

async function inspectExecutable({ candidate, effectiveUid }, dependencies) {
  if (typeof candidate !== "string" || !isAbsolute(candidate) || normalize(candidate) !== candidate || hasControl(candidate)) fail("E_CODEX_RUNTIME_EXECUTABLE_INVALID", "Codex executable pathが不正です");
  const canonical = await (dependencies.realpath ?? realpath)(candidate);
  await verifyAncestors(canonical, effectiveUid, dependencies);
  const handle = await (dependencies.open ?? open)(canonical, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const info = await handle.stat({ bigint: true });
    if (!info.isFile() || (info.mode & 0o111n) === 0n || (info.mode & 0o022n) !== 0n || ![0, effectiveUid].includes(Number(info.uid))) fail("E_CODEX_RUNTIME_EXECUTABLE_INVALID", "Codex executableのownerまたはmodeが不正です");
    await (dependencies.access ?? access)(canonical, fsConstants.X_OK);
    return {
      candidate, realpath: canonical, uid: Number(info.uid), gid: Number(info.gid), mode: Number(info.mode & 0o7777n),
      dev: info.dev.toString(), ino: info.ino.toString(), size: info.size.toString(), mtime_ns: info.mtimeNs.toString(),
      digest: await digestOpenFile(handle),
    };
  } finally { await handle.close(); }
}

async function verifyAncestors(actual, effectiveUid, dependencies) {
  let current = dirname(actual);
  while (true) {
    const info = await (dependencies.lstat ?? lstat)(current, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o002n) !== 0n || ![0, effectiveUid].includes(Number(info.uid))) fail("E_CODEX_RUNTIME_ANCESTOR_INVALID", "Codex executable ancestorのownerまたはmodeが不正です");
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
  if (await (dependencies.realpath ?? realpath)(identity.candidate) !== identity.realpath) fail("E_CODEX_RUNTIME_IDENTITY_CHANGED", "Codex executable realpathがverification後に変わりました");
  const info = await (dependencies.stat ?? stat)(identity.realpath, { bigint: true });
  const current = { uid: Number(info.uid), gid: Number(info.gid), mode: Number(info.mode & 0o7777n), dev: info.dev.toString(), ino: info.ino.toString(), size: info.size.toString(), mtime_ns: info.mtimeNs.toString() };
  for (const key of Object.keys(current)) if (current[key] !== identity[key]) fail("E_CODEX_RUNTIME_IDENTITY_CHANGED", "Codex executable identityがverification後に変わりました");
}

function validateVerification(value) {
  if (!isPlainObject(value) || !hasExactKeys(value, ["codex", "runtime_root", "schema"]) ||
      value.schema !== CODEX_PROCESS_VERIFICATION_SCHEMA || typeof value.runtime_root !== "string" ||
      !isAbsolute(value.runtime_root) || normalize(value.runtime_root) !== value.runtime_root || hasControl(value.runtime_root) ||
      !isPlainObject(value.codex) || !hasExactKeys(value.codex, [
        "candidate", "dev", "digest", "gid", "ino", "mode", "mtime_ns", "realpath", "size", "uid", "version",
      ]) || value.codex.version !== SUPPORTED_CODEX_VERSION ||
      ![value.codex.candidate, value.codex.realpath].every((entry) => typeof entry === "string" && isAbsolute(entry) && normalize(entry) === entry && !hasControl(entry)) ||
      ![value.codex.uid, value.codex.gid, value.codex.mode].every(Number.isInteger) ||
      ![value.codex.dev, value.codex.ino, value.codex.size, value.codex.mtime_ns].every((entry) => typeof entry === "string" && /^\d+$/.test(entry)) ||
      typeof value.codex.digest !== "string" || !/^[a-f0-9]{64}$/.test(value.codex.digest)) {
    fail("E_CODEX_PROCESS_VERIFICATION_INVALID", "Codex process verificationが不正です");
  }
}

function validateChild(child) {
  if ((typeof child !== "object" && typeof child !== "function") || child === null || typeof child.on !== "function" || typeof child.kill !== "function" || typeof child.stdin?.write !== "function" || typeof child.stdin?.end !== "function" || typeof child.stdout?.on !== "function" || typeof child.stderr?.on !== "function") fail("E_CODEX_PROCESS_HANDLE_INVALID", "Codex app-server process handleが不正です");
}

function defaultSignalProcessGroup(target, signal) {
  try {
    process.kill(target, signal);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function defaultProbeProcessGroup(target) {
  try {
    process.kill(target, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function terminationUnknown() {
  return new ObserverError("E_CODEX_PROCESS_TERMINATION_UNKNOWN", "Codex app-server process groupの終了を確認できません");
}

function validateMethodAndParams(method, params) {
  if (typeof method !== "string" || !METHOD_RE.test(method) || !isPlainObject(params)) fail("E_CODEX_TRANSPORT_REQUEST_INVALID", "Codex app-server methodまたはparamsが不正です");
}

function commandOptions(cwd) {
  return { cwd, env: boundedEnv(), timeout: VERSION_TIMEOUT_MS, maxBuffer: MAX_LINE_BYTES };
}

function boundedEnv(source = process.env) {
  const result = { NO_COLOR: "1" };
  for (const key of ENV_ALLOWLIST) if (typeof source[key] === "string") result[key] = source[key];
  return result;
}

async function runFile(command, args, options) {
  return new Promise((resolveResult) => {
    execFile(command, args, { ...options, encoding: "utf8", windowsHide: true }, (error, stdout, stderr) => {
      resolveResult({ exit_code: error === null ? 0 : Number.isInteger(error.code) ? error.code : null, stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
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
