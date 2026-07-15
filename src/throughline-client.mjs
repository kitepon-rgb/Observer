import { spawn as spawnChild } from "node:child_process";
import { isAbsolute } from "node:path";

import { ObserverError, fail } from "./observer-error.mjs";

export const THROUGHLINE_READ_SCHEMA = "throughline.observer_read.v1";
export const THROUGHLINE_WAIT_SCHEMA = "throughline.observer_wait.v1";
export const MAX_THROUGHLINE_STDOUT_BYTES = 1024 * 1024;
export const MAX_THROUGHLINE_STDERR_BYTES = 64 * 1024;
export const TERMINATE_GRACE_MS = 1000;

export function createThroughlineClient({
  command = "throughline",
  spawn = spawnChild,
  maxStdoutBytes = MAX_THROUGHLINE_STDOUT_BYTES,
  maxStderrBytes = MAX_THROUGHLINE_STDERR_BYTES,
  terminateGraceMs = TERMINATE_GRACE_MS,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  return {
    read(input) {
      const args = readArgs(input);
      return runJsonCommand({ command, args, spawn, maxStdoutBytes, maxStderrBytes, terminateGraceMs, setTimeoutFn, clearTimeoutFn, signal: input?.signal })
        .then((value) => validateReadWire(value));
    },
    wait(input) {
      const args = waitArgs(input);
      return runJsonCommand({ command, args, spawn, maxStdoutBytes, maxStderrBytes, terminateGraceMs, setTimeoutFn, clearTimeoutFn, signal: input?.signal })
        .then((value) => validateWaitWire(value, input.afterCursor));
    },
  };
}

export function runJsonCommand({ command, args, spawn = spawnChild, signal, maxStdoutBytes = MAX_THROUGHLINE_STDOUT_BYTES, maxStderrBytes = MAX_THROUGHLINE_STDERR_BYTES, terminateGraceMs = TERMINATE_GRACE_MS, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout }) {
  if (signal?.aborted) return Promise.reject(cancelledError());
  if (!Number.isSafeInteger(maxStdoutBytes) || maxStdoutBytes < 1 || !Number.isSafeInteger(maxStderrBytes) || maxStderrBytes < 1 || !Number.isSafeInteger(terminateGraceMs) || terminateGraceMs < 0) {
    return Promise.reject(new ObserverError("E_THROUGHLINE_CLIENT_CONFIG", "Throughline client設定が不正です"));
  }
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      reject(new ObserverError("E_THROUGHLINE_EXEC", "Throughline CLIを起動できません"));
      return;
    }
    if (!child?.stdout || !child?.stderr || typeof child.once !== "function" || typeof child.on !== "function" || typeof child.removeListener !== "function" ||
      typeof child.stdout.on !== "function" || typeof child.stdout.removeListener !== "function" || typeof child.stderr.on !== "function" || typeof child.stderr.removeListener !== "function") {
      terminateChild(child, "SIGTERM");
      reject(new ObserverError("E_THROUGHLINE_EXEC", "Throughline CLIを起動できません"));
      return;
    }

    const stdoutChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let terminalFailure = null;
    let terminateTimer = null;
    const cleanup = () => {
      child.stdout.removeListener("data", onStdout);
      child.stderr.removeListener("data", onStderr);
      child.removeListener("error", onError);
      child.removeListener("close", onClose);
      signal?.removeEventListener("abort", onAbort);
      if (terminateTimer !== null) clearTimeoutFn(terminateTimer);
    };
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const beginTermination = (failure) => {
      if (terminalFailure || settled) return;
      terminalFailure = failure;
      terminateTimer = setTimeoutFn(() => {
        if (!settled) terminateChild(child, "SIGKILL");
      }, terminateGraceMs);
      terminateTimer?.unref?.();
      terminateChild(child, "SIGTERM");
    };
    const onAbort = () => {
      beginTermination(cancelledError());
    };
    const onStdout = (chunk) => {
      if (terminalFailure) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes += bytes.length;
      if (stdoutBytes > maxStdoutBytes) {
        beginTermination(new ObserverError("E_THROUGHLINE_PROTOCOL", "Throughline CLI応答が不正です"));
      } else {
        stdoutChunks.push(bytes);
      }
    };
    const onStderr = (chunk) => {
      if (terminalFailure) return;
      stderrBytes += Buffer.byteLength(chunk);
      if (stderrBytes > maxStderrBytes) {
        beginTermination(new ObserverError("E_THROUGHLINE_PROTOCOL", "Throughline CLI応答が不正です"));
      }
    };
    const onError = () => finish(() => reject(terminalFailure ?? new ObserverError("E_THROUGHLINE_EXEC", "Throughline CLIを実行できません")));
    const onClose = (code, signalName) => {
      if (terminalFailure) {
        finish(() => reject(terminalFailure));
        return;
      }
      if (code !== 0 || signalName) {
        finish(() => reject(new ObserverError("E_THROUGHLINE_EXEC", "Throughline CLIが正常終了しませんでした")));
        return;
      }
      let value;
      try { value = parseSingleJson(Buffer.concat(stdoutChunks).toString("utf8")); } catch {
        finish(() => reject(new ObserverError("E_THROUGHLINE_PROTOCOL", "Throughline CLI応答が不正です")));
        return;
      }
      finish(() => resolve(value));
    };

    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("error", onError);
    child.once("close", onClose);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

export function validateReadWire(value) {
  requireExactKeys(value, ["afterCursor", "historyTruncated", "host", "page", "schema", "status", "thread_sha256", "throughCursor", "turns"]);
  if (value.schema !== THROUGHLINE_READ_SCHEMA || !["snapshot", "delta", "thread_switched", "host_switched", "resync_required", "projection_pending", "ambiguous_parent"].includes(value.status)) {
    fail("E_THROUGHLINE_SCHEMA", "Throughline read wireが不正です");
  }
  if (!Array.isArray(value.turns) || value.turns.length > 100 || typeof value.historyTruncated !== "boolean" || !isCursor(value.afterCursor, true) || !isCursor(value.throughCursor, true)) {
    fail("E_THROUGHLINE_SCHEMA", "Throughline read wireが不正です");
  }
  requireExactKeys(value.page, ["complete", "nextToken"]);
  if (typeof value.page.complete !== "boolean" || !isCursor(value.page.nextToken, true)) fail("E_THROUGHLINE_SCHEMA", "Throughline read wireが不正です");
  if (value.host === null ? value.thread_sha256 !== null : !["claude", "codex"].includes(value.host) || !/^[a-f0-9]{64}$/.test(value.thread_sha256)) {
    fail("E_THROUGHLINE_SCHEMA", "Throughline read wireが不正です");
  }
  return value;
}

export function validateWaitWire(value, afterCursor) {
  requireExactKeys(value, ["afterCursor", "schema", "status", "throughCursor"]);
  if (value.schema !== THROUGHLINE_WAIT_SCHEMA || !["changed", "timeout", "resync_required", "ambiguous_parent"].includes(value.status) || value.afterCursor !== afterCursor) {
    fail("E_THROUGHLINE_SCHEMA", "Throughline wait wireが不正です");
  }
  if ((["changed", "timeout"].includes(value.status) && !isCursor(value.throughCursor)) ||
    (value.status === "timeout" && value.throughCursor !== afterCursor) ||
    (["resync_required", "ambiguous_parent"].includes(value.status) && value.throughCursor !== null)) {
    fail("E_THROUGHLINE_SCHEMA", "Throughline wait wireが不正です");
  }
  return value;
}

function readArgs(input) {
  if (!input || typeof input.projectPath !== "string" || !isAbsolute(input.projectPath)) fail("E_THROUGHLINE_INPUT", "Throughline read入力が不正です");
  if (![input.afterCursor, input.throughCursor, input.pageToken].every((value) => value === undefined || value === null || isCursor(value))) {
    fail("E_THROUGHLINE_INPUT", "Throughline read入力が不正です");
  }
  if (input.pageToken != null && (input.afterCursor == null || input.throughCursor == null)) {
    fail("E_THROUGHLINE_INPUT", "Throughline read入力が不正です");
  }
  if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100)) {
    fail("E_THROUGHLINE_INPUT", "Throughline read入力が不正です");
  }
  const args = ["observer-read", "--project", input.projectPath];
  for (const [key, option] of [["afterCursor", "--after-cursor"], ["throughCursor", "--through-cursor"], ["pageToken", "--page-token"], ["limit", "--limit"]]) {
    if (input[key] !== undefined && input[key] !== null) args.push(option, String(input[key]));
  }
  args.push("--json");
  return args;
}

function waitArgs(input) {
  if (!input || typeof input.projectPath !== "string" || !isAbsolute(input.projectPath) || !isCursor(input.afterCursor)) fail("E_THROUGHLINE_INPUT", "Throughline wait入力が不正です");
  if (input.timeoutSeconds !== undefined && (!Number.isSafeInteger(input.timeoutSeconds) || input.timeoutSeconds < 1 || input.timeoutSeconds > 3600)) {
    fail("E_THROUGHLINE_INPUT", "Throughline wait入力が不正です");
  }
  const args = ["observer-wait", "--project", input.projectPath, "--after-cursor", input.afterCursor];
  if (input.timeoutSeconds !== undefined) args.push("--timeout-seconds", String(input.timeoutSeconds));
  args.push("--json");
  return args;
}

function parseSingleJson(stdout) {
  if (typeof stdout !== "string" || stdout.length === 0) throw new TypeError("empty stdout");
  return JSON.parse(stdout);
}

function requireExactKeys(value, expected) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail("E_THROUGHLINE_SCHEMA", "Throughline wireが不正です");
  }
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) {
    fail("E_THROUGHLINE_SCHEMA", "Throughline wireが不正です");
  }
}

function isCursor(value, nullable = false) {
  return (nullable && value === null) || typeof value === "string" && value.length > 0 && value.length <= 4096;
}

function cancelledError() { return new ObserverError("E_THROUGHLINE_CANCELLED", "Throughline待機が取消されました"); }

function terminateChild(child, signal) {
  try { child?.kill?.(signal); } catch { /* terminal result is normalized by close/error */ }
}
