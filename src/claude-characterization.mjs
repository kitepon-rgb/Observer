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

export const CLAUDE_CHARACTERIZATION_PREPARE_SCHEMA = "observer.claude_characterization_prepare.v1";
export const CLAUDE_CHARACTERIZATION_CAPTURE_SCHEMA = "observer.claude_characterization_capture.v1";
export const CLAUDE_CHARACTERIZATION_VERIFICATION_SCHEMA = "observer.claude_characterization_verification.v1";
export const CLAUDE_CHARACTERIZATION_READINESS_SCHEMA = "observer.claude_characterization_readiness.v1";
export const CLAUDE_CHARACTERIZATION_CLEANUP_SCHEMA = "observer.claude_characterization_cleanup.v1";
export const SUPPORTED_CHARACTERIZATION_CLAUDE_VERSION = "2.1.210";

const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/u;
const INVALID_COMMAND_PATH = /[\s\u0000-\u001f\u007f'"]/u;
const MAX_AGENTS_BYTES = 1024 * 1024;
const MAX_OPAQUE_ID_BYTES = 256;
const SETTINGS_NAME = "settings.json";
const CAPTURE_NAME = "capture.json";
const CAPTURE_KEYS = Object.freeze([
  "campaign_id",
  "captured_at",
  "hook_event_digest",
  "result_digest",
  "schema",
  "session_digest",
  "stop_hook_active",
]);

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
  const command = [
    hookExecutable,
    "hook",
    "--campaign-id", campaignId,
    "--capture-path", capturePath,
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
  agentsStdout,
  expected,
  replySurface,
  terminalResult = null,
} = {}) {
  validateCampaignId(campaignId);
  validateCapturePath(capturePath);
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
  const capture = validateCapture(await readPrivateJson(capturePath));
  if (capture.campaign_id !== campaignId) {
    fail("E_CLAUDE_CHARACTERIZATION_CAMPAIGN_MISMATCH", "characterization campaignが一致しません");
  }
  const sessionDigest = identityDigest("session", agent.sessionId);
  if (capture.session_digest !== sessionDigest) {
    fail("E_CLAUDE_CHARACTERIZATION_SESSION_MISMATCH", "Claude job sessionとStop sessionが一致しません");
  }

  let terminalExactResult = "unsupported";
  if (terminalResult !== null) {
    const terminalDigest = `sha256:${observerAiOutputDigest(parseObserverAiOutput(terminalResult))}`;
    if (terminalDigest !== capture.result_digest) {
      fail("E_CLAUDE_CHARACTERIZATION_RESULT_MISMATCH", "terminal resultとStop captureが一致しません");
    }
    terminalExactResult = "confirmed";
  }
  const status = [replySurface, terminalExactResult].includes("blocked")
    ? "blocked"
    : [replySurface, terminalExactResult].includes("unsupported") ? "unsupported" : "confirmed";
  return {
    schema: CLAUDE_CHARACTERIZATION_VERIFICATION_SCHEMA,
    status,
    campaign_id: campaignId,
    job_digest: identityDigest("job", expected.jobId),
    session_digest: sessionDigest,
    result_digest: capture.result_digest,
    reply_surface: replySurface,
    job_session_correlation: "confirmed",
    stop_capture: "confirmed",
    terminal_exact_result: terminalExactResult,
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
  if (entries.some((entry) => entry !== SETTINGS_NAME && entry !== CAPTURE_NAME)) {
    fail("E_CLAUDE_CHARACTERIZATION_CLEANUP_UNSAFE", "未知fileを含むcharacterization rootを削除しません");
  }
  const settingsPath = join(root, SETTINGS_NAME);
  const capturePath = join(root, CAPTURE_NAME);
  if (entries.includes(SETTINGS_NAME)) {
    const settings = await readPrivateJson(settingsPath);
    const command = settings?.hooks?.Stop?.[0]?.hooks?.[0]?.command;
    if (typeof command !== "string" || !command.includes(`--campaign-id ${campaignId} `) ||
        !command.includes(`--capture-path ${capturePath} `)) {
      fail("E_CLAUDE_CHARACTERIZATION_CLEANUP_UNSAFE", "characterization settingsの所有相関が不正です");
    }
  }
  if (entries.includes(CAPTURE_NAME)) {
    const capture = validateCapture(await readPrivateJson(capturePath));
    if (capture.campaign_id !== campaignId) {
      fail("E_CLAUDE_CHARACTERIZATION_CLEANUP_UNSAFE", "characterization captureの所有相関が不正です");
    }
  }
  if (entries.includes(CAPTURE_NAME)) await removePrivateFile(capturePath);
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
