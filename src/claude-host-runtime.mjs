import { execFile, spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, lstat, open, readFile, realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

import {
  buildClaudeBackgroundInvocation,
  CLAUDE_OBSERVER_TOOLS,
  observeClaudeAgentList,
  parseClaudeBackgroundSpawn,
  planClaudeStop,
  recordClaudeStopCommandResult,
  recoverClaudeSpawnFromAgentList,
} from "./claude-host-adapter.mjs";
import { OBSERVER_MCP_SERVER_VERSION } from "./mcp-server.mjs";
import { ObserverError, fail } from "./observer-error.mjs";
import {
  claudeJobNameFor,
  HOST_RECEIPT_SCHEMA,
  validateParentLaunchRequest,
  validateParentStopRequest,
} from "./parent-launch.mjs";

export const CLAUDE_HOST_RUNTIME_VERIFICATION_SCHEMA = "observer.claude_host_runtime_verification.v1";
export const CLAUDE_HOST_SPAWN_RESULT_SCHEMA = "observer.claude_host_spawn_result.v1";
export const CLAUDE_HOST_OBSERVE_RESULT_SCHEMA = "observer.claude_host_observe_result.v1";
export const CLAUDE_HOST_STOP_RESULT_SCHEMA = "observer.claude_host_stop_result.v1";
export const SUPPORTED_CLAUDE_VERSION = "2.1.210 (Claude Code)";

const MAX_OUTPUT_BYTES = 1024 * 1024;
const VERSION_TIMEOUT_MS = 5_000;
const HOST_COMMAND_TIMEOUT_MS = 15_000;
const MCP_PROBE_TIMEOUT_MS = 5_000;
const MCP_TOOL_NAMES = Object.freeze(["observer_read", "observer_wait"]);
const ENV_ALLOWLIST = Object.freeze([
  "CLAUDE_CONFIG_DIR", "HOME", "LANG", "LC_ALL", "PATH", "SHELL", "TMPDIR", "USER", "USERPROFILE",
  "XDG_CONFIG_HOME", "XDG_STATE_HOME",
]);

export async function verifyClaudeHostRuntime({ runtimeRoot, claudeCommand } = {}, dependencies = {}) {
  const canonicalRoot = await canonicalRuntimeRoot(runtimeRoot, dependencies);
  const effectiveUid = dependencies.effectiveUid ?? (typeof process.getuid === "function" ? process.getuid() : null);
  if (!Number.isInteger(effectiveUid)) fail("E_CLAUDE_RUNTIME_OWNER_UNAVAILABLE", "effective UIDを確認できません");
  const manifest = await readRuntimeManifest(canonicalRoot, effectiveUid, dependencies);
  const mcpCandidate = resolve(canonicalRoot, manifest.bin["observer-mcp"]);
  if (!pathInside(canonicalRoot, mcpCandidate)) fail("E_CLAUDE_RUNTIME_MANIFEST_INVALID", "Observer MCP binがruntime root外です");
  const inspect = dependencies.inspectExecutable ?? inspectExecutable;
  const claude = await inspect({ candidate: claudeCommand, effectiveUid, kind: "claude" }, dependencies);
  const observerMcp = await inspect({ candidate: mcpCandidate, effectiveUid, kind: "observer-mcp", requiredRoot: canonicalRoot }, dependencies);
  const run = dependencies.runFile ?? runFile;
  await recheckExecutableIdentity(claude, dependencies);
  const claudeVersionResult = await run(claude.realpath, ["--version"], commandOptions(canonicalRoot, VERSION_TIMEOUT_MS), dependencies);
  requireExactVersion(claudeVersionResult, SUPPORTED_CLAUDE_VERSION, "E_CLAUDE_VERSION_UNSUPPORTED");
  await recheckExecutableIdentity(claude, dependencies);
  await recheckExecutableIdentity(observerMcp, dependencies);
  const mcpVersionResult = await run(observerMcp.realpath, ["--version"], commandOptions(canonicalRoot, VERSION_TIMEOUT_MS), dependencies);
  requireExactVersion(mcpVersionResult, manifest.version, "E_OBSERVER_MCP_VERSION_MISMATCH");
  if (manifest.version !== OBSERVER_MCP_SERVER_VERSION) fail("E_OBSERVER_MCP_VERSION_MISMATCH", "packageとObserver MCP server versionが一致しません");
  await recheckExecutableIdentity(observerMcp, dependencies);
  const probe = dependencies.probeMcp ?? probeObserverMcp;
  const tools = await probe({ command: observerMcp.realpath, cwd: canonicalRoot, env: boundedEnv() }, dependencies);
  if (!Array.isArray(tools) || tools.length !== MCP_TOOL_NAMES.length || tools.some((name, index) => name !== MCP_TOOL_NAMES[index])) {
    fail("E_OBSERVER_MCP_SURFACE_MISMATCH", "Observer MCP tool surfaceが固定契約と一致しません");
  }
  return {
    schema: CLAUDE_HOST_RUNTIME_VERIFICATION_SCHEMA,
    runtime_root: canonicalRoot,
    claude: { ...claude, version: SUPPORTED_CLAUDE_VERSION },
    observer_mcp: { ...observerMcp, version: OBSERVER_MCP_SERVER_VERSION, tools: [...tools] },
  };
}

export async function spawnClaudeObserver({ request, verification } = {}, dependencies = {}) {
  requireClaudeLaunchRequest(request);
  validateVerification(verification, request.runtime_root);
  await recheckVerification(verification, dependencies);
  const invocation = buildClaudeBackgroundInvocation({
    request,
    claudeCommand: verification.claude.realpath,
    mcpConfig: { mcpServers: { observer: { command: verification.observer_mcp.realpath, args: ["--stdio"] } } },
    observerTools: CLAUDE_OBSERVER_TOOLS,
  });
  const run = dependencies.runFile ?? runFile;
  const result = await run(invocation.command, invocation.args, commandOptions(request.host.cwd, HOST_COMMAND_TIMEOUT_MS), dependencies);
  let spawnReceipt;
  try {
    spawnReceipt = parseClaudeBackgroundSpawn({ stdout: result.stdout, expectedName: request.host.name });
  } catch (error) {
    if (error instanceof ObserverError && error.code === "E_CLAUDE_SPAWN_RECEIPT_INVALID") {
      fail("E_CLAUDE_SPAWN_UNKNOWN", "Claude spawn結果を相関できません。同じwatchを再spawnせず回収してください");
    }
    throw error;
  }
  return {
    schema: CLAUDE_HOST_SPAWN_RESULT_SCHEMA,
    receipt: hostReceipt(request, "spawned", spawnReceipt.job_id),
  };
}

export async function recoverClaudeSpawn({ request, verification, attempts = 3 } = {}, dependencies = {}) {
  requireClaudeLaunchRequest(request);
  validateVerification(verification, request.runtime_root);
  validateAttempts(attempts);
  await recheckVerification(verification, dependencies);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const listed = await listClaudeAgents(verification, dependencies);
    const recovered = recoverClaudeSpawnFromAgentList({
      stdout: listed.stdout,
      expected: { name: request.host.name, cwd: request.host.cwd },
      observedAt: now(dependencies),
    });
    if (recovered.status === "found") {
      return {
        schema: CLAUDE_HOST_SPAWN_RESULT_SCHEMA,
        receipt: hostReceipt(request, "spawned", recovered.observation.job_id),
        observation: recovered.observation,
      };
    }
    if (attempt + 1 < attempts) await delay(dependencies);
  }
  return { schema: CLAUDE_HOST_SPAWN_RESULT_SCHEMA, receipt: null, observation: null };
}

export async function observeClaudeObserver({ request, receipt, verification, attempts = 3 } = {}, dependencies = {}) {
  requireClaudeLaunchRequest(request);
  validateVerification(verification, request.runtime_root);
  validateHostReceiptForRequest(receipt, request, "spawned");
  validateAttempts(attempts);
  await recheckVerification(verification, dependencies);
  const expected = { jobId: receipt.handle.value, name: request.host.name, cwd: request.host.cwd };
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const listed = await listClaudeAgents(verification, dependencies);
    try {
      const observation = observeClaudeAgentList({ stdout: listed.stdout, expected, observedAt: now(dependencies) });
      return {
        schema: CLAUDE_HOST_OBSERVE_RESULT_SCHEMA,
        observation,
        ready_receipt: ["working", "blocked"].includes(observation.state) ? hostReceipt(request, "ready", observation.job_id) : null,
      };
    } catch (error) {
      if (!(error instanceof ObserverError) || error.code !== "E_CLAUDE_JOB_NOT_FOUND") throw error;
      if (attempt + 1 < attempts) await delay(dependencies);
    }
  }
  return { schema: CLAUDE_HOST_OBSERVE_RESULT_SCHEMA, observation: null, ready_receipt: null };
}

export async function stopClaudeObserver({ request, observation, verification, previousCommandReceipt = null } = {}, dependencies = {}) {
  validateParentStopRequest(request);
  validateVerification(verification);
  const expectedName = claudeJobNameFor(request.target_id, request.watch_id);
  if (observation?.job_id !== request.handle.value || observation?.name !== expectedName || observation?.cwd !== verification.runtime_root) {
    fail("E_CLAUDE_STOP_CORRELATION_FAILED", "Claude stop対象がparent stop requestと一致しません");
  }
  await recheckVerification(verification, dependencies);
  const plan = planClaudeStop(observation, { claudeCommand: verification.claude.realpath, previousCommandReceipt });
  if (plan.action === "already_terminal") {
    return {
      schema: CLAUDE_HOST_STOP_RESULT_SCHEMA,
      command_receipt: null,
      terminal_receipt: hostReceipt(request, "stopped", observation.job_id),
      terminal_state: observation.state,
    };
  }
  if (plan.action === "await_terminal_observation") {
    return { schema: CLAUDE_HOST_STOP_RESULT_SCHEMA, command_receipt: previousCommandReceipt, terminal_receipt: null, terminal_state: null };
  }
  const run = dependencies.runFile ?? runFile;
  const result = await run(plan.command, plan.args, commandOptions(verification.runtime_root, HOST_COMMAND_TIMEOUT_MS), dependencies);
  return {
    schema: CLAUDE_HOST_STOP_RESULT_SCHEMA,
    command_receipt: recordClaudeStopCommandResult({
      jobId: observation.job_id,
      exitCode: result.exit_code,
      stdout: result.stdout,
      stderr: result.stderr,
      observedAt: now(dependencies),
    }),
    terminal_receipt: null,
    terminal_state: null,
  };
}

async function canonicalRuntimeRoot(value, dependencies) {
  if (typeof value !== "string" || !isAbsolute(value) || normalize(value) !== value || hasControl(value)) {
    fail("E_CLAUDE_RUNTIME_ROOT_INVALID", "Observer runtime rootが不正です");
  }
  const resolveRealpath = dependencies.realpath ?? realpath;
  const canonical = await resolveRealpath(value);
  if (canonical !== value) fail("E_CLAUDE_RUNTIME_ROOT_INVALID", "Observer runtime rootはcanonical pathである必要があります");
  return canonical;
}

async function readRuntimeManifest(root, effectiveUid, dependencies) {
  const read = dependencies.readFile ?? readFile;
  const resolveRealpath = dependencies.realpath ?? realpath;
  const packagePath = join(root, "package.json");
  if (await resolveRealpath(packagePath) !== packagePath) fail("E_CLAUDE_RUNTIME_MANIFEST_INVALID", "package.json symlinkは許可されません");
  const packageInfo = await (dependencies.stat ?? stat)(packagePath, { bigint: true });
  if (!packageInfo.isFile() || (packageInfo.mode & 0o022n) !== 0n || ![0, effectiveUid].includes(Number(packageInfo.uid))) {
    fail("E_CLAUDE_RUNTIME_MANIFEST_INVALID", "package.jsonのownerまたはmodeが不正です");
  }
  let value;
  try {
    value = JSON.parse(await read(packagePath, "utf8"));
  } catch {
    fail("E_CLAUDE_RUNTIME_MANIFEST_INVALID", "Observer package manifestを読めません");
  }
  if (!isPlainObject(value) || !isPlainObject(value.bin) || typeof value.bin["observer-mcp"] !== "string" ||
      typeof value.version !== "string" || value.version !== OBSERVER_MCP_SERVER_VERSION ||
      isAbsolute(value.bin["observer-mcp"]) || hasControl(value.bin["observer-mcp"])) {
    fail("E_CLAUDE_RUNTIME_MANIFEST_INVALID", "Observer package manifestが固定契約と一致しません");
  }
  return { bin: { "observer-mcp": value.bin["observer-mcp"] }, version: value.version };
}

async function inspectExecutable({ candidate, effectiveUid, kind, requiredRoot = null }, dependencies) {
  if (typeof candidate !== "string" || !isAbsolute(candidate) || normalize(candidate) !== candidate || hasControl(candidate)) {
    fail("E_CLAUDE_RUNTIME_EXECUTABLE_INVALID", `${kind} executable pathが不正です`);
  }
  const resolveRealpath = dependencies.realpath ?? realpath;
  const actual = await resolveRealpath(candidate);
  if (requiredRoot !== null && !pathInside(requiredRoot, actual)) fail("E_CLAUDE_RUNTIME_EXECUTABLE_INVALID", `${kind} executableがruntime root外です`);
  await verifyAncestors(actual, effectiveUid, dependencies);
  const openFile = dependencies.open ?? open;
  const handle = await openFile(actual, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const info = await handle.stat({ bigint: true });
    if (!info.isFile() || (info.mode & 0o111n) === 0n || (info.mode & 0o022n) !== 0n ||
        ![0, effectiveUid].includes(Number(info.uid))) {
      fail("E_CLAUDE_RUNTIME_EXECUTABLE_INVALID", `${kind} executableのownerまたはmodeが不正です`);
    }
    await (dependencies.access ?? access)(actual, fsConstants.X_OK);
    const digest = await digestOpenFile(handle);
    return {
      candidate,
      realpath: actual,
      uid: Number(info.uid),
      gid: Number(info.gid),
      mode: Number(info.mode & 0o7777n),
      dev: info.dev.toString(),
      ino: info.ino.toString(),
      size: info.size.toString(),
      mtime_ns: info.mtimeNs.toString(),
      digest,
    };
  } finally {
    await handle.close();
  }
}

async function verifyAncestors(actual, effectiveUid, dependencies) {
  const inspectLink = dependencies.lstat ?? lstat;
  let current = dirname(actual);
  while (true) {
    const info = await inspectLink(current, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o002n) !== 0n || ![0, effectiveUid].includes(Number(info.uid))) {
      fail("E_CLAUDE_RUNTIME_ANCESTOR_INVALID", "executable ancestorのownerまたはmodeが不正です");
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

async function digestOpenFile(handle) {
  const hash = createHash("sha256");
  const stream = handle.createReadStream({ autoClose: false, start: 0 });
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

async function recheckIdentity(identity, dependencies) {
  const resolveRealpath = dependencies.realpath ?? realpath;
  if (await resolveRealpath(identity.candidate) !== identity.realpath) fail("E_CLAUDE_RUNTIME_IDENTITY_CHANGED", "executable realpathがverification後に変わりました");
  const info = await (dependencies.stat ?? stat)(identity.realpath, { bigint: true });
  const current = {
    uid: Number(info.uid), gid: Number(info.gid), mode: Number(info.mode & 0o7777n),
    dev: info.dev.toString(), ino: info.ino.toString(), size: info.size.toString(), mtime_ns: info.mtimeNs.toString(),
  };
  for (const key of Object.keys(current)) {
    if (current[key] !== identity[key]) fail("E_CLAUDE_RUNTIME_IDENTITY_CHANGED", "executable identityがverification後に変わりました");
  }
}

async function recheckVerification(value, dependencies) {
  await recheckExecutableIdentity(value.claude, dependencies);
  await recheckExecutableIdentity(value.observer_mcp, dependencies);
}

async function recheckExecutableIdentity(identity, dependencies) {
  const check = dependencies.recheckIdentity ?? recheckIdentity;
  await check(identity, dependencies);
}

function validateVerification(value, expectedRoot = null) {
  if (!isPlainObject(value) || value.schema !== CLAUDE_HOST_RUNTIME_VERIFICATION_SCHEMA ||
      typeof value.runtime_root !== "string" || (expectedRoot !== null && value.runtime_root !== expectedRoot) ||
      !isPlainObject(value.claude) || !isPlainObject(value.observer_mcp) ||
      value.claude.version !== SUPPORTED_CLAUDE_VERSION || value.observer_mcp.version !== OBSERVER_MCP_SERVER_VERSION ||
      JSON.stringify(value.observer_mcp.tools) !== JSON.stringify(MCP_TOOL_NAMES)) {
    fail("E_CLAUDE_RUNTIME_VERIFICATION_INVALID", "Claude host runtime verificationが不正です");
  }
  validateIdentityShape(value.claude);
  validateIdentityShape(value.observer_mcp);
}

function validateIdentityShape(value) {
  const strings = ["candidate", "realpath", "dev", "ino", "size", "mtime_ns", "digest"];
  if (strings.some((key) => typeof value[key] !== "string") || !/^[a-f0-9]{64}$/u.test(value.digest) ||
      !Number.isInteger(value.uid) || !Number.isInteger(value.gid) || !Number.isInteger(value.mode)) {
    fail("E_CLAUDE_RUNTIME_VERIFICATION_INVALID", "executable identity snapshotが不正です");
  }
}

function requireClaudeLaunchRequest(request) {
  try {
    validateParentLaunchRequest(request);
  } catch {
    fail("E_CLAUDE_HOST_REQUEST_INVALID", "Claude parent launch requestが不正です");
  }
  if (request.provider !== "claude" || request.host.kind !== "claude.background_agent.v1") {
    fail("E_CLAUDE_HOST_REQUEST_INVALID", "Claude parent launch requestが必要です");
  }
}

function validateHostReceiptForRequest(receipt, request, outcome) {
  if (!isPlainObject(receipt) || receipt.schema !== HOST_RECEIPT_SCHEMA || receipt.outcome !== outcome ||
      receipt.provider !== "claude" || receipt.watch_id !== request.watch_id || receipt.target_id !== request.target_id ||
      !isPlainObject(receipt.handle) || receipt.handle.kind !== "claude.job" || typeof receipt.handle.value !== "string") {
    fail("E_CLAUDE_HOST_RECEIPT_INVALID", "Claude host receiptがrequestと一致しません");
  }
}

function hostReceipt(request, outcome, jobId) {
  return {
    schema: HOST_RECEIPT_SCHEMA,
    provider: "claude",
    watch_id: request.watch_id,
    target_id: request.target_id,
    outcome,
    handle: { kind: "claude.job", value: jobId },
  };
}

async function listClaudeAgents(verification, dependencies) {
  await recheckExecutableIdentity(verification.claude, dependencies);
  const run = dependencies.runFile ?? runFile;
  const result = await run(verification.claude.realpath, ["agents", "--json", "--all", "--cwd", verification.runtime_root], commandOptions(verification.runtime_root, HOST_COMMAND_TIMEOUT_MS), dependencies);
  if (result.exit_code !== 0) fail("E_CLAUDE_AGENT_LIST_FAILED", "Claude agent listを取得できません");
  return result;
}

function commandOptions(cwd, timeout) {
  return { cwd, env: boundedEnv(), timeout, maxBuffer: MAX_OUTPUT_BYTES };
}

function boundedEnv(source = process.env) {
  const result = { NO_COLOR: "1" };
  for (const key of ENV_ALLOWLIST) if (typeof source[key] === "string") result[key] = source[key];
  return result;
}

async function runFile(command, args, options) {
  return new Promise((resolveResult) => {
    execFile(command, args, { ...options, encoding: "utf8", windowsHide: true }, (error, stdout, stderr) => {
      const exitCode = error === null ? 0 : Number.isInteger(error.code) ? error.code : null;
      resolveResult({ exit_code: exitCode, stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}

async function probeObserverMcp({ command, cwd, env }, dependencies = {}) {
  const spawnProcess = dependencies.spawn ?? spawn;
  const child = spawnProcess(command, ["--stdio"], { cwd, env, shell: false, stdio: ["pipe", "pipe", "pipe"] });
  return new Promise((resolveTools, rejectTools) => {
    let stdout = "";
    let stderrBytes = 0;
    let initializeSeen = false;
    let settled = false;
    const timer = setTimeout(() => finish(new Error("MCP probe timeout")), MCP_PROBE_TIMEOUT_MS);
    const finish = (error, tools = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      if (!child.killed) child.kill("SIGTERM");
      if (error) rejectTools(error);
      else resolveTools(tools);
    };
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_OUTPUT_BYTES) finish(new Error("MCP stderr overflow"));
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (Buffer.byteLength(stdout, "utf8") > MAX_OUTPUT_BYTES) return finish(new Error("MCP stdout overflow"));
      while (stdout.includes("\n")) {
        const index = stdout.indexOf("\n");
        const line = stdout.slice(0, index);
        stdout = stdout.slice(index + 1);
        let message;
        try { message = JSON.parse(line); } catch { return finish(new Error("MCP invalid JSON")); }
        if (message.id === 1 && message.result?.serverInfo?.version === OBSERVER_MCP_SERVER_VERSION) initializeSeen = true;
        if (message.id === 2) {
          if (!initializeSeen || !Array.isArray(message.result?.tools)) return finish(new Error("MCP invalid tools response"));
          return finish(null, message.result.tools.map((tool) => tool.name).sort());
        }
      }
    });
    child.on("error", finish);
    child.on("exit", (code) => { if (!settled) finish(new Error(`MCP exited ${code}`)); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "observer-verifier", version: "1" } } })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
  }).catch(() => fail("E_OBSERVER_MCP_PROBE_FAILED", "Observer MCP initialize/tools listを検証できません"));
}

function requireExactVersion(result, expected, code) {
  if (!isPlainObject(result) || result.exit_code !== 0 || typeof result.stdout !== "string" || typeof result.stderr !== "string" ||
      result.stderr !== "" || result.stdout.trim() !== expected) fail(code, "executable versionがsupported contractと一致しません");
}

function validateAttempts(value) {
  if (!Number.isInteger(value) || value < 1 || value > 10) fail("E_CLAUDE_OBSERVE_ATTEMPTS_INVALID", "observe attemptsが不正です");
}

async function delay(dependencies) {
  const wait = dependencies.delay ?? ((milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds)));
  await wait(100);
}

function now(dependencies) {
  return (dependencies.now ?? (() => new Date().toISOString()))();
}

function pathInside(root, candidate) {
  const path = relative(root, candidate);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function hasControl(value) {
  return /[\u0000-\u001f\u007f]/u.test(value);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
