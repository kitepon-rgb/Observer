import { createHash, randomUUID } from "node:crypto";
import { constants, access, lstat, readdir, rmdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";

import { observerAiOutputDigest, parseObserverAiOutput } from "./observer-ai-contract.mjs";
import { fail, ObserverError } from "./observer-error.mjs";
import {
  assertPrivateDirectory,
  atomicCreatePrivateFile,
  ensurePrivateDirectory,
  readPrivateJson,
  removePrivateFile,
  syncPrivateDirectory,
} from "./private-state.mjs";

export const CLAUDE_CHARACTERIZATION_PREPARE_SCHEMA = "observer.claude_characterization_prepare.v2";
export const CLAUDE_CHARACTERIZATION_CAPTURE_SCHEMA = "observer.claude_characterization_capture.v1";
export const CLAUDE_CHARACTERIZATION_HOOK_RECEIPT_SCHEMA = "observer.claude_characterization_hook_receipt.v1";
export const CLAUDE_CHARACTERIZATION_VERIFICATION_SCHEMA = "observer.claude_characterization_verification.v2";
export const CLAUDE_CHARACTERIZATION_READINESS_SCHEMA = "observer.claude_characterization_readiness.v1";
export const CLAUDE_CHARACTERIZATION_CLEANUP_SCHEMA = "observer.claude_characterization_cleanup.v2";
export const SUPPORTED_CHARACTERIZATION_CLAUDE_VERSION = "2.1.210";

const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/u;
const INVALID_COMMAND_PATH = /[\s\u0000-\u001f\u007f'"]/u;
const MAX_AGENTS_BYTES = 1024 * 1024;
const MAX_HOOK_STDIN_BYTES = 1024 * 1024;
const MAX_OPAQUE_ID_BYTES = 256;
const SETTINGS_NAME = "settings.json";
const CAPTURE_NAME = "capture.json";
const HOOK_RECEIPT_NAME = "hook-receipt.json";
const CAPTURE_KEYS = Object.freeze([
  "campaign_id",
  "captured_at",
  "hook_event_digest",
  "result_digest",
  "schema",
  "session_digest",
  "stop_hook_active",
]);
const HOOK_RECEIPT_KEYS = Object.freeze([
  "campaign_id",
  "captured_at",
  "cwd_match",
  "failure_code",
  "hook_invocation",
  "result_capture",
  "schema",
  "session_digest",
  "stop_payload",
]);
const STOP_INPUT_FAILURE_CODES = new Set([
  "E_CLAUDE_CHARACTERIZATION_STOP_STDIN_LIMIT",
  "E_CLAUDE_CHARACTERIZATION_STOP_UTF8_INVALID",
  "E_CLAUDE_CHARACTERIZATION_STOP_JSON_INVALID",
  "E_CLAUDE_CHARACTERIZATION_STOP_INVALID",
]);
const RESULT_FAILURE_CODE = "E_CLAUDE_CHARACTERIZATION_RESULT_INVALID";

export async function prepareClaudeCharacterization({
  workRoot,
  hookExecutable,
  expectedCwd,
  campaignId = generatedCampaignId(),
} = {}) {
  validateCampaignId(campaignId);
  validateCommandPath(hookExecutable, "E_CLAUDE_CHARACTERIZATION_HOOK_INVALID");
  validateCommandPath(expectedCwd, "E_CLAUDE_CHARACTERIZATION_CWD_INVALID");
  await requireExecutable(hookExecutable);
  const root = requireAbsoluteRoot(workRoot);
  await assertPrivateDirectory(dirname(root));
  await ensurePrivateDirectory(root);
  const entries = await readdir(root);
  if (entries.length !== 0) {
    fail("E_CLAUDE_CHARACTERIZATION_WORK_ROOT_NOT_EMPTY", "characterization work rootが空ではありません");
  }

  const settingsPath = join(root, SETTINGS_NAME);
  const capturePath = join(root, CAPTURE_NAME);
  const hookReceiptPath = join(root, HOOK_RECEIPT_NAME);
  const command = [
    hookExecutable,
    "hook",
    "--campaign-id", campaignId,
    "--capture-path", capturePath,
    "--hook-receipt-path", hookReceiptPath,
    "--expected-cwd", expectedCwd,
  ].join(" ");
  const settings = {
    hooks: {
      Stop: [{
        hooks: [{ type: "command", command, timeout: 5 }],
      }],
    },
  };
  await atomicCreatePrivateFile(settingsPath, `${JSON.stringify(settings)}\n`);
  return {
    schema: CLAUDE_CHARACTERIZATION_PREPARE_SCHEMA,
    status: "ready_for_h",
    campaign_id: campaignId,
    settings_path: settingsPath,
    capture_path: capturePath,
    hook_receipt_path: hookReceiptPath,
  };
}

export async function captureClaudeCharacterizationStopInput({
  campaignId,
  capturePath,
  hookReceiptPath,
  expectedCwd,
  stdin,
  stdinFailureCode = null,
  now = new Date(),
} = {}) {
  validateCampaignId(campaignId);
  validateCapturePath(capturePath);
  validateHookReceiptPath(hookReceiptPath);
  validateCommandPath(expectedCwd, "E_CLAUDE_CHARACTERIZATION_CWD_INVALID");
  await assertPrivateDirectory(dirname(capturePath));
  if (dirname(capturePath) !== dirname(hookReceiptPath)) {
    fail("E_CLAUDE_CHARACTERIZATION_HOOK_RECEIPT_PATH_INVALID", "hook receiptとcaptureのrootが一致しません");
  }

  const capturedAt = timestamp(now, "E_CLAUDE_CHARACTERIZATION_HOOK_RECEIPT_INVALID");
  if (stdinFailureCode !== null) {
    if (stdinFailureCode !== "E_CLAUDE_CHARACTERIZATION_STOP_STDIN_LIMIT") {
      fail("E_CLAUDE_CHARACTERIZATION_STOP_STDIN_INVALID", "characterization hook stdin failure codeが不正です");
    }
    return writeHookReceipt(hookReceiptPath, blockedHookReceipt({
      campaignId,
      capturedAt,
      failureCode: stdinFailureCode,
    }));
  }

  let source;
  try {
    if (Buffer.isBuffer(stdin)) {
      if (stdin.length > MAX_HOOK_STDIN_BYTES) throw new Error("stdin limit");
      source = new TextDecoder("utf-8", { fatal: true }).decode(stdin);
    } else if (typeof stdin === "string" && Buffer.byteLength(stdin, "utf8") <= MAX_HOOK_STDIN_BYTES) {
      source = stdin;
    } else {
      throw new Error("stdin invalid");
    }
  } catch {
    return writeHookReceipt(hookReceiptPath, blockedHookReceipt({
      campaignId,
      capturedAt,
      failureCode: "E_CLAUDE_CHARACTERIZATION_STOP_UTF8_INVALID",
    }));
  }

  let payload;
  try {
    payload = JSON.parse(source);
  } catch {
    return writeHookReceipt(hookReceiptPath, blockedHookReceipt({
      campaignId,
      capturedAt,
      failureCode: "E_CLAUDE_CHARACTERIZATION_STOP_JSON_INVALID",
    }));
  }

  const envelope = inspectStopEnvelope(payload, expectedCwd);
  if (envelope.stopPayload === "blocked") {
    return writeHookReceipt(hookReceiptPath, {
      schema: CLAUDE_CHARACTERIZATION_HOOK_RECEIPT_SCHEMA,
      campaign_id: campaignId,
      hook_invocation: "confirmed",
      stop_payload: "blocked",
      cwd_match: envelope.cwdMatch,
      session_digest: envelope.sessionDigest,
      result_capture: "blocked",
      failure_code: "E_CLAUDE_CHARACTERIZATION_STOP_INVALID",
      captured_at: capturedAt,
    });
  }

  try {
    parseObserverAiOutput(payload.last_assistant_message);
  } catch {
    return writeHookReceipt(hookReceiptPath, {
      schema: CLAUDE_CHARACTERIZATION_HOOK_RECEIPT_SCHEMA,
      campaign_id: campaignId,
      hook_invocation: "confirmed",
      stop_payload: "confirmed",
      cwd_match: "confirmed",
      session_digest: envelope.sessionDigest,
      result_capture: "blocked",
      failure_code: RESULT_FAILURE_CODE,
      captured_at: capturedAt,
    });
  }

  const successReceipt = {
    schema: CLAUDE_CHARACTERIZATION_HOOK_RECEIPT_SCHEMA,
    campaign_id: campaignId,
    hook_invocation: "confirmed",
    stop_payload: "confirmed",
    cwd_match: "confirmed",
    session_digest: envelope.sessionDigest,
    result_capture: "confirmed",
    failure_code: null,
    captured_at: capturedAt,
  };
  await assertHookReceiptCompatible(hookReceiptPath, successReceipt);
  const capture = await captureClaudeCharacterizationStop({
    campaignId,
    capturePath,
    expectedCwd,
    payload,
    now,
  });
  const hookReceipt = await writeHookReceipt(hookReceiptPath, successReceipt);
  return { hook_receipt: hookReceipt, capture };
}

function blockedHookReceipt({ campaignId, capturedAt, failureCode }) {
  return {
    schema: CLAUDE_CHARACTERIZATION_HOOK_RECEIPT_SCHEMA,
    campaign_id: campaignId,
    hook_invocation: "confirmed",
    stop_payload: "blocked",
    cwd_match: "blocked",
    session_digest: null,
    result_capture: "blocked",
    failure_code: failureCode,
    captured_at: capturedAt,
  };
}

export async function captureClaudeCharacterizationStop({
  campaignId,
  capturePath,
  expectedCwd,
  payload,
  now = new Date(),
} = {}) {
  validateCampaignId(campaignId);
  validateCapturePath(capturePath);
  validateCommandPath(expectedCwd, "E_CLAUDE_CHARACTERIZATION_CWD_INVALID");
  await assertPrivateDirectory(dirname(capturePath));
  const normalized = parseStopPayload(payload, expectedCwd);
  const sessionDigest = identityDigest("session", normalized.sessionId);
  const resultDigest = `sha256:${observerAiOutputDigest(normalized.output)}`;
  const receipt = {
    schema: CLAUDE_CHARACTERIZATION_CAPTURE_SCHEMA,
    campaign_id: campaignId,
    session_digest: sessionDigest,
    result_digest: resultDigest,
    hook_event_digest: identityDigest(
      "hook-event",
      `${sessionDigest}\0${resultDigest}\0${normalized.stopHookActive ? "1" : "0"}`,
    ),
    stop_hook_active: normalized.stopHookActive,
    captured_at: timestamp(now, "E_CLAUDE_CHARACTERIZATION_CAPTURE_INVALID"),
  };
  try {
    await atomicCreatePrivateFile(capturePath, `${JSON.stringify(receipt)}\n`);
    return receipt;
  } catch (error) {
    if (!(error instanceof ObserverError) || error.code !== "E_ALREADY_EXISTS") throw error;
    const existing = validateCapture(await readPrivateJson(capturePath));
    if (!sameCaptureEvent(existing, receipt)) {
      fail("E_CLAUDE_CHARACTERIZATION_CAPTURE_CONFLICT", "characterization Stop captureが競合しました");
    }
    return existing;
  }
}

export async function verifyClaudeCharacterization({
  campaignId,
  capturePath,
  hookReceiptPath,
  agentsStdout,
  expected,
  replySurface,
  terminalResult = null,
} = {}) {
  validateCampaignId(campaignId);
  validateCapturePath(capturePath);
  validateHookReceiptPath(hookReceiptPath);
  validateExpectedAgent(expected);
  validateSurfaceStatus(replySurface, "E_CLAUDE_CHARACTERIZATION_REPLY_STATUS_INVALID");
  const entries = parseAgents(agentsStdout);
  const matches = entries.filter((entry) => entry.id === expected.jobId);
  if (matches.length !== 1) {
    fail("E_CLAUDE_CHARACTERIZATION_JOB_CORRELATION_FAILED", "Claude jobを一意に相関できません");
  }
  const agent = matches[0];
  if (agent.name !== expected.name || agent.cwd !== expected.cwd || agent.kind !== "background" ||
      !validOpaqueIdentity(agent.sessionId) ||
      typeof agent.state !== "string" || agent.state.length === 0) {
    fail("E_CLAUDE_CHARACTERIZATION_JOB_CORRELATION_FAILED", "Claude job identityが一致しません");
  }
  const hookReceipt = await readHookReceipt(hookReceiptPath);
  if (hookReceipt.campaign_id !== campaignId) {
    fail("E_CLAUDE_CHARACTERIZATION_CAMPAIGN_MISMATCH", "characterization campaignが一致しません");
  }
  const sessionDigest = identityDigest("session", agent.sessionId);
  if (hookReceipt.session_digest !== null && hookReceipt.session_digest !== sessionDigest) {
    fail("E_CLAUDE_CHARACTERIZATION_SESSION_MISMATCH", "Claude job sessionとStop sessionが一致しません");
  }

  const jobSessionCorrelation = hookReceipt.session_digest === sessionDigest ? "confirmed" : "blocked";
  let capture = null;
  if (hookReceipt.result_capture === "confirmed") {
    capture = await readCapture(capturePath);
    if (capture.campaign_id !== campaignId || capture.session_digest !== sessionDigest) {
      fail("E_CLAUDE_CHARACTERIZATION_SESSION_MISMATCH", "Claude captureとjob sessionが一致しません");
    }
  }

  let terminalExactResult = "unsupported";
  if (terminalResult !== null) {
    if (capture === null) {
      fail("E_CLAUDE_CHARACTERIZATION_RESULT_MISMATCH", "result captureなしにterminal resultを照合できません");
    }
    const terminalDigest = `sha256:${observerAiOutputDigest(parseObserverAiOutput(terminalResult))}`;
    if (terminalDigest !== capture.result_digest) {
      fail("E_CLAUDE_CHARACTERIZATION_RESULT_MISMATCH", "terminal resultとStop captureが一致しません");
    }
    terminalExactResult = "confirmed";
  }
  const statuses = [
    replySurface,
    jobSessionCorrelation,
    hookReceipt.stop_payload,
    hookReceipt.result_capture,
    terminalExactResult,
  ];
  const status = statuses.includes("blocked")
    ? "blocked"
    : statuses.includes("unsupported") ? "unsupported" : "confirmed";
  return {
    schema: CLAUDE_CHARACTERIZATION_VERIFICATION_SCHEMA,
    status,
    campaign_id: campaignId,
    job_digest: identityDigest("job", expected.jobId),
    session_digest: hookReceipt.session_digest,
    result_digest: capture?.result_digest ?? null,
    reply_surface: replySurface,
    job_session_correlation: jobSessionCorrelation,
    hook_invocation: hookReceipt.hook_invocation,
    stop_capture: hookReceipt.stop_payload,
    result_capture: hookReceipt.result_capture,
    terminal_exact_result: terminalExactResult,
    failure_code: hookReceipt.failure_code,
    cleanup: "pending",
  };
}

export function inspectClaudeCharacterizationReadiness({ versionStdout, rootHelp, agentsHelp } = {}) {
  if (typeof versionStdout !== "string" ||
      !versionStdout.trim().startsWith(`${SUPPORTED_CHARACTERIZATION_CLAUDE_VERSION} `)) {
    fail("E_CLAUDE_CHARACTERIZATION_VERSION_UNSUPPORTED", "Claude Code versionがcharacterization対象外です");
  }
  requireHelpTokens(rootHelp, [
    "--bg",
    "--settings",
    "--setting-sources",
    "--strict-mcp-config",
    "--tools",
    "--allowedTools",
  ]);
  requireHelpTokens(agentsHelp, ["--json", "--all"]);
  const replySurface = /(?:^|\n)\s*(?:send|reply)(?:\s|\[|$)/iu.test(agentsHelp)
    ? "confirmed"
    : "unsupported";
  return {
    schema: CLAUDE_CHARACTERIZATION_READINESS_SCHEMA,
    status: "ready_for_h",
    claude_version: SUPPORTED_CHARACTERIZATION_CLAUDE_VERSION,
    reply_surface: replySurface,
  };
}

export async function cleanupClaudeCharacterization({ workRoot, campaignId } = {}) {
  validateCampaignId(campaignId);
  const root = requireAbsoluteRoot(workRoot);
  await assertPrivateDirectory(dirname(root));
  await assertPrivateDirectory(root);
  const entries = await readdir(root);
  if (entries.some((entry) => ![SETTINGS_NAME, CAPTURE_NAME, HOOK_RECEIPT_NAME].includes(entry))) {
    fail("E_CLAUDE_CHARACTERIZATION_CLEANUP_UNSAFE", "未知fileを含むcharacterization rootを削除しません");
  }
  const settingsPath = join(root, SETTINGS_NAME);
  const capturePath = join(root, CAPTURE_NAME);
  const hookReceiptPath = join(root, HOOK_RECEIPT_NAME);
  if (entries.includes(SETTINGS_NAME)) {
    const settings = await readPrivateJson(settingsPath);
    const command = settings?.hooks?.Stop?.[0]?.hooks?.[0]?.command;
    if (typeof command !== "string" || !command.includes(`--campaign-id ${campaignId} `) ||
        !command.includes(`--capture-path ${capturePath} `) ||
        !command.includes(`--hook-receipt-path ${hookReceiptPath} `)) {
      fail("E_CLAUDE_CHARACTERIZATION_CLEANUP_UNSAFE", "characterization settingsの所有相関が不正です");
    }
  }
  if (entries.includes(CAPTURE_NAME)) {
    const capture = validateCapture(await readPrivateJson(capturePath));
    if (capture.campaign_id !== campaignId) {
      fail("E_CLAUDE_CHARACTERIZATION_CLEANUP_UNSAFE", "characterization captureの所有相関が不正です");
    }
  }
  if (entries.includes(HOOK_RECEIPT_NAME)) {
    const hookReceipt = validateHookReceipt(await readPrivateJson(hookReceiptPath));
    if (hookReceipt.campaign_id !== campaignId) {
      fail("E_CLAUDE_CHARACTERIZATION_CLEANUP_UNSAFE", "characterization hook receiptの所有相関が不正です");
    }
  }
  if (entries.includes(CAPTURE_NAME)) await removePrivateFile(capturePath);
  if (entries.includes(HOOK_RECEIPT_NAME)) await removePrivateFile(hookReceiptPath);
  if (entries.includes(SETTINGS_NAME)) await removePrivateFile(settingsPath);
  await rmdir(root);
  await syncPrivateDirectory(dirname(root));
  return {
    schema: CLAUDE_CHARACTERIZATION_CLEANUP_SCHEMA,
    campaign_id: campaignId,
    cleanup: "confirmed",
  };
}

function parseStopPayload(payload, expectedCwd) {
  if (!isPlainObject(payload) || payload.hook_event_name !== "Stop" ||
      !validOpaqueIdentity(payload.session_id) ||
      payload.cwd !== expectedCwd || typeof payload.stop_hook_active !== "boolean" ||
      typeof payload.last_assistant_message !== "string") {
    fail("E_CLAUDE_CHARACTERIZATION_STOP_INVALID", "Claude Stop payloadがcharacterization契約と一致しません");
  }
  return {
    sessionId: payload.session_id,
    stopHookActive: payload.stop_hook_active,
    output: parseObserverAiOutput(payload.last_assistant_message),
  };
}

function inspectStopEnvelope(payload, expectedCwd) {
  const plain = isPlainObject(payload);
  const sessionDigest = plain && validOpaqueIdentity(payload.session_id)
    ? identityDigest("session", payload.session_id)
    : null;
  const cwdMatch = plain && payload.cwd === expectedCwd ? "confirmed" : "blocked";
  const valid = plain && payload.hook_event_name === "Stop" && sessionDigest !== null &&
    cwdMatch === "confirmed" && typeof payload.stop_hook_active === "boolean" &&
    typeof payload.last_assistant_message === "string";
  return { stopPayload: valid ? "confirmed" : "blocked", cwdMatch, sessionDigest };
}

function parseAgents(stdout) {
  if (typeof stdout !== "string" || Buffer.byteLength(stdout, "utf8") > MAX_AGENTS_BYTES) {
    fail("E_CLAUDE_CHARACTERIZATION_AGENTS_INVALID", "Claude agents JSONが不正です");
  }
  let entries;
  try {
    entries = JSON.parse(stdout);
  } catch {
    fail("E_CLAUDE_CHARACTERIZATION_AGENTS_INVALID", "Claude agents JSONを解析できません");
  }
  if (!Array.isArray(entries) || entries.some((entry) => !isPlainObject(entry))) {
    fail("E_CLAUDE_CHARACTERIZATION_AGENTS_INVALID", "Claude agents JSON schemaが不正です");
  }
  return entries;
}

function validateExpectedAgent(value) {
  if (!isPlainObject(value) || Object.keys(value).sort().join("|") !== "cwd|jobId|name" ||
      !IDENTIFIER.test(value.jobId ?? "") || !IDENTIFIER.test(value.name ?? "") ||
      typeof value.cwd !== "string" || !isAbsolute(value.cwd)) {
    fail("E_CLAUDE_CHARACTERIZATION_JOB_CORRELATION_FAILED", "Claude expected job identityが不正です");
  }
}

function validateCapture(value) {
  if (!isPlainObject(value) || Object.keys(value).sort().join("|") !== [...CAPTURE_KEYS].sort().join("|") ||
      value.schema !== CLAUDE_CHARACTERIZATION_CAPTURE_SCHEMA || !DIGEST.test(value.campaign_id) ||
      !DIGEST.test(value.session_digest) || !DIGEST.test(value.result_digest) ||
      !DIGEST.test(value.hook_event_digest) || typeof value.stop_hook_active !== "boolean") {
    fail("E_CLAUDE_CHARACTERIZATION_CAPTURE_INVALID", "characterization capture schemaが不正です");
  }
  timestamp(new Date(value.captured_at), "E_CLAUDE_CHARACTERIZATION_CAPTURE_INVALID", value.captured_at);
  return value;
}

function validateHookReceipt(value) {
  if (!isPlainObject(value) || Object.keys(value).sort().join("|") !== [...HOOK_RECEIPT_KEYS].sort().join("|") ||
      value.schema !== CLAUDE_CHARACTERIZATION_HOOK_RECEIPT_SCHEMA || !DIGEST.test(value.campaign_id) ||
      value.hook_invocation !== "confirmed" || !new Set(["confirmed", "blocked"]).has(value.stop_payload) ||
      !new Set(["confirmed", "blocked"]).has(value.cwd_match) ||
      (value.session_digest !== null && !DIGEST.test(value.session_digest)) ||
      !new Set(["confirmed", "blocked"]).has(value.result_capture) ||
      (value.failure_code !== null && !STOP_INPUT_FAILURE_CODES.has(value.failure_code) &&
        value.failure_code !== RESULT_FAILURE_CODE)) {
    fail("E_CLAUDE_CHARACTERIZATION_HOOK_RECEIPT_INVALID", "characterization hook receipt schemaが不正です");
  }
  const success = value.result_capture === "confirmed" && value.failure_code === null &&
    value.stop_payload === "confirmed" && value.cwd_match === "confirmed" && value.session_digest !== null;
  const resultBlocked = value.result_capture === "blocked" && value.failure_code === RESULT_FAILURE_CODE &&
    value.stop_payload === "confirmed" && value.cwd_match === "confirmed" && value.session_digest !== null;
  const inputBlocked = value.result_capture === "blocked" && STOP_INPUT_FAILURE_CODES.has(value.failure_code) &&
    value.stop_payload === "blocked";
  if (!success && !resultBlocked && !inputBlocked) {
    fail("E_CLAUDE_CHARACTERIZATION_HOOK_RECEIPT_INVALID", "characterization hook receipt relationshipが不正です");
  }
  timestamp(new Date(value.captured_at), "E_CLAUDE_CHARACTERIZATION_HOOK_RECEIPT_INVALID", value.captured_at);
  return value;
}

async function writeHookReceipt(path, receipt) {
  const validated = validateHookReceipt(receipt);
  try {
    await atomicCreatePrivateFile(path, `${JSON.stringify(validated)}\n`);
    return validated;
  } catch (error) {
    if (!(error instanceof ObserverError) || error.code !== "E_ALREADY_EXISTS") throw error;
    const existing = validateHookReceipt(await readPrivateJson(path));
    if (!HOOK_RECEIPT_KEYS.filter((key) => key !== "captured_at").every((key) => existing[key] === validated[key])) {
      fail("E_CLAUDE_CHARACTERIZATION_HOOK_RECEIPT_CONFLICT", "characterization hook receiptが競合しました");
    }
    return existing;
  }
}

async function assertHookReceiptCompatible(path, receipt) {
  const validated = validateHookReceipt(receipt);
  try {
    const existing = validateHookReceipt(await readPrivateJson(path));
    if (!HOOK_RECEIPT_KEYS.filter((key) => key !== "captured_at").every((key) => existing[key] === validated[key])) {
      fail("E_CLAUDE_CHARACTERIZATION_HOOK_RECEIPT_CONFLICT", "characterization hook receiptが競合しました");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function readCapture(path) {
  try {
    return validateCapture(await readPrivateJson(path));
  } catch (error) {
    if (error?.code === "ENOENT") {
      fail("E_CLAUDE_CHARACTERIZATION_CAPTURE_MISSING", "characterization result captureがありません");
    }
    throw error;
  }
}

async function readHookReceipt(path) {
  try {
    return validateHookReceipt(await readPrivateJson(path));
  } catch (error) {
    if (error?.code === "ENOENT") {
      fail("E_CLAUDE_CHARACTERIZATION_HOOK_RECEIPT_MISSING", "characterization hook receiptがありません");
    }
    throw error;
  }
}

function sameCaptureEvent(left, right) {
  return CAPTURE_KEYS.filter((key) => key !== "captured_at").every((key) => left[key] === right[key]);
}

function validateSurfaceStatus(value, code) {
  if (!new Set(["confirmed", "unsupported", "blocked"]).has(value)) {
    fail(code, "characterization surface statusが不正です");
  }
}

function requireHelpTokens(value, tokens) {
  if (typeof value !== "string" || tokens.some((token) => !value.includes(token))) {
    fail("E_CLAUDE_CHARACTERIZATION_SURFACE_MISSING", "Claude公開help surfaceが不足しています");
  }
}

function generatedCampaignId() {
  return identityDigest("campaign", randomUUID());
}

function identityDigest(kind, value) {
  return `sha256:${createHash("sha256")
    .update(`observer.claude.characterization.${kind}.v1\0${value}\0`, "utf8")
    .digest("hex")}`;
}

function validateCampaignId(value) {
  if (!DIGEST.test(value ?? "")) {
    fail("E_CLAUDE_CHARACTERIZATION_CAMPAIGN_INVALID", "characterization campaign IDが不正です");
  }
}

function validateCapturePath(value) {
  if (typeof value !== "string" || !isAbsolute(value) || normalize(value) !== value ||
      basename(value) !== CAPTURE_NAME || INVALID_COMMAND_PATH.test(value)) {
    fail("E_CLAUDE_CHARACTERIZATION_CAPTURE_PATH_INVALID", "characterization capture pathが不正です");
  }
}

function validateHookReceiptPath(value) {
  if (typeof value !== "string" || !isAbsolute(value) || normalize(value) !== value ||
      basename(value) !== HOOK_RECEIPT_NAME || INVALID_COMMAND_PATH.test(value)) {
    fail("E_CLAUDE_CHARACTERIZATION_HOOK_RECEIPT_PATH_INVALID", "characterization hook receipt pathが不正です");
  }
}

function validateCommandPath(value, code) {
  if (typeof value !== "string" || !isAbsolute(value) || normalize(value) !== value ||
      INVALID_COMMAND_PATH.test(value)) {
    fail(code, "characterization command pathが不正です");
  }
}

function requireAbsoluteRoot(value) {
  if (typeof value !== "string" || !isAbsolute(value) || normalize(value) !== value) {
    fail("E_CLAUDE_CHARACTERIZATION_WORK_ROOT_INVALID", "characterization work rootが不正です");
  }
  return resolve(value);
}

async function requireExecutable(value) {
  try {
    const info = await lstat(value);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("not regular");
    await access(value, constants.X_OK);
  } catch {
    fail("E_CLAUDE_CHARACTERIZATION_HOOK_INVALID", "characterization hookが実行できません");
  }
}

function timestamp(value, code, original = undefined) {
  const date = value instanceof Date ? value : new Date(value);
  const serialized = original ?? (Number.isFinite(date.getTime()) ? date.toISOString() : null);
  if (!Number.isFinite(date.getTime()) || serialized !== date.toISOString()) {
    fail(code, "characterization timestampが不正です");
  }
  return serialized;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function validOpaqueIdentity(value) {
  return typeof value === "string" && value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= MAX_OPAQUE_ID_BYTES &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}
