import { isAbsolute, normalize, relative, sep } from "node:path";

import { buildObserverAiPrompt } from "./observer-ai-contract.mjs";
import { fail } from "./observer-error.mjs";
import { validateParentLaunchRequest } from "./parent-launch.mjs";

export const CLAUDE_JOB_OBSERVATION_SCHEMA = "observer.claude_job_observation.v1";
export const CLAUDE_STOP_COMMAND_RECEIPT_SCHEMA = "observer.claude_stop_command_receipt.v1";
export const CLAUDE_OBSERVER_TOOLS = Object.freeze([]);

const CLAUDE_JOB_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const CLAUDE_NAME_RE = /^[A-Za-z0-9_-]{1,128}$/;
const KNOWN_STATES = new Set(["working", "blocked", "done", "stopped", "failed"]);
const TERMINAL_STATES = new Set(["done", "stopped", "failed"]);
const MAX_AGENT_LIST_BYTES = 1024 * 1024;

export function buildClaudeBackgroundInvocation({ request, claudeCommand, mcpConfig, observerTools = CLAUDE_OBSERVER_TOOLS } = {}) {
  if (request?.provider !== "claude" || request?.host?.kind !== "claude.background_agent.v1") {
    fail("E_CLAUDE_HOST_REQUEST_INVALID", "Claude background launch requestが必要です");
  }
  validateClaudeCommand(claudeCommand);
  try {
    validateParentLaunchRequest(request);
  } catch {
    fail("E_CLAUDE_HOST_REQUEST_INVALID", "Claude background launch requestが不正です");
  }
  validateMcpConfig(mcpConfig, request.runtime_root);
  const sortedTools = validateObserverTools(observerTools);
  const prompt = buildObserverAiPrompt(request.child_start);
  const availableTools = sortedTools.join(",");
  const allowedTools = sortedTools.join(",");
  const args = [
    "--bg",
    "--name", request.host.name,
    "--agent", request.host.agent,
    "--permission-mode", "dontAsk",
    "--setting-sources", "",
    "--disable-slash-commands",
    "--no-chrome",
    prompt,
    "--strict-mcp-config",
    "--mcp-config", JSON.stringify(mcpConfig),
    "--tools", availableTools,
    "--allowedTools", allowedTools,
  ];
  return { command: claudeCommand, args };
}

export function parseClaudeBackgroundSpawn({ stdout, expectedName } = {}) {
  if (typeof stdout !== "string" || Buffer.byteLength(stdout, "utf8") > MAX_AGENT_LIST_BYTES ||
      typeof expectedName !== "string" || !CLAUDE_NAME_RE.test(expectedName)) {
    fail("E_CLAUDE_SPAWN_RECEIPT_INVALID", "Claude background spawn receiptが不正です");
  }
  const matches = [...stdout.matchAll(/^backgrounded · ([A-Za-z0-9_-]{1,128})(?: · ([A-Za-z0-9_-]{1,128}))?\r?$/gmu)];
  if (matches.length !== 1 || matches[0][2] !== expectedName) {
    fail("E_CLAUDE_SPAWN_RECEIPT_INVALID", "Claude background spawn receiptを一意に相関できません");
  }
  return { job_id: matches[0][1], name: expectedName };
}

export function recoverClaudeSpawnFromAgentList({ stdout, expected, observedAt } = {}) {
  if (typeof stdout !== "string" || Buffer.byteLength(stdout, "utf8") > MAX_AGENT_LIST_BYTES) {
    fail("E_CLAUDE_AGENT_LIST_INVALID", "Claude agent listが不正です");
  }
  if (!isPlainObject(expected) || !hasExactKeys(expected, ["cwd", "name"]) ||
      typeof expected.name !== "string" || !CLAUDE_NAME_RE.test(expected.name) || !isSafeAbsolutePath(expected.cwd)) {
    fail("E_CLAUDE_JOB_CORRELATION_FAILED", "Claude job recovery identityが不正です");
  }
  validateObservedAt(observedAt);
  let entries;
  try {
    entries = JSON.parse(stdout);
  } catch {
    fail("E_CLAUDE_AGENT_LIST_INVALID", "Claude agent listがJSONではありません");
  }
  if (!Array.isArray(entries) || entries.some((entry) => !isPlainObject(entry))) {
    fail("E_CLAUDE_AGENT_LIST_INVALID", "Claude agent list schemaが不正です");
  }
  const matchingHistory = entries.filter((entry) => entry.name === expected.name && entry.cwd === expected.cwd && entry.kind === "background");
  for (const entry of matchingHistory) {
    validateJobId(entry.id, "E_CLAUDE_JOB_CORRELATION_FAILED");
    if (typeof entry.state !== "string" || !KNOWN_STATES.has(entry.state)) fail("E_CLAUDE_JOB_STATE_UNKNOWN", "Claude job stateが未知です");
  }
  const liveMatches = matchingHistory.filter((entry) => entry.state === "working" || entry.state === "blocked");
  if (liveMatches.length === 0) return { status: "not_visible" };
  if (liveMatches.length !== 1) fail("E_CLAUDE_JOB_CORRELATION_FAILED", "Claude live job recovery identityが重複しています");
  const entry = liveMatches[0];
  return {
    status: "found",
    observation: {
      schema: CLAUDE_JOB_OBSERVATION_SCHEMA,
      job_id: entry.id,
      name: expected.name,
      cwd: expected.cwd,
      state: entry.state,
      observed_at: observedAt,
    },
  };
}

export function observeClaudeAgentList({ stdout, expected, observedAt } = {}) {
  if (typeof stdout !== "string" || Buffer.byteLength(stdout, "utf8") > MAX_AGENT_LIST_BYTES) {
    fail("E_CLAUDE_AGENT_LIST_INVALID", "Claude agent listが不正です");
  }
  validateExpectedIdentity(expected);
  validateObservedAt(observedAt);
  let entries;
  try {
    entries = JSON.parse(stdout);
  } catch {
    fail("E_CLAUDE_AGENT_LIST_INVALID", "Claude agent listがJSONではありません");
  }
  if (!Array.isArray(entries) || entries.some((entry) => !isPlainObject(entry))) {
    fail("E_CLAUDE_AGENT_LIST_INVALID", "Claude agent list schemaが不正です");
  }
  const matches = entries.filter((entry) => entry.id === expected.jobId);
  if (matches.length === 0) fail("E_CLAUDE_JOB_NOT_FOUND", "Claude jobが公開一覧にありません");
  if (matches.length !== 1) fail("E_CLAUDE_AGENT_LIST_INVALID", "Claude job IDが公開一覧で重複しています");
  const entry = matches[0];
  if (entry.name !== expected.name || entry.cwd !== expected.cwd || entry.kind !== "background") {
    fail("E_CLAUDE_JOB_CORRELATION_FAILED", "Claude job identityがlaunch requestと一致しません");
  }
  if (typeof entry.state !== "string" || !KNOWN_STATES.has(entry.state)) {
    fail("E_CLAUDE_JOB_STATE_UNKNOWN", "Claude job stateが未知です");
  }
  return {
    schema: CLAUDE_JOB_OBSERVATION_SCHEMA,
    job_id: expected.jobId,
    name: expected.name,
    cwd: expected.cwd,
    state: entry.state,
    observed_at: observedAt,
  };
}

export function planClaudeStop(observation, { claudeCommand, previousCommandReceipt = null } = {}) {
  validateObservation(observation);
  validateClaudeCommand(claudeCommand);
  if (TERMINAL_STATES.has(observation.state)) {
    return { action: "already_terminal", terminal_state: observation.state, job_id: observation.job_id };
  }
  if (previousCommandReceipt !== null) {
    validateStopCommandReceipt(previousCommandReceipt, observation.job_id);
    return {
      action: "await_terminal_observation",
      job_id: observation.job_id,
      command_outcome: previousCommandReceipt.outcome,
    };
  }
  return { action: "issue_stop", command: claudeCommand, args: ["stop", observation.job_id] };
}

export function recordClaudeStopCommandResult({ jobId, exitCode, stdout, stderr, observedAt } = {}) {
  validateJobId(jobId, "E_CLAUDE_STOP_RESULT_INVALID");
  validateObservedAt(observedAt);
  if (!Number.isInteger(exitCode) || typeof stdout !== "string" || typeof stderr !== "string") {
    fail("E_CLAUDE_STOP_RESULT_INVALID", "Claude stop command resultが不正です");
  }
  const confirmed = exitCode === 0 && stdout.trim() === `stopped ${jobId}`;
  return {
    schema: CLAUDE_STOP_COMMAND_RECEIPT_SCHEMA,
    job_id: jobId,
    outcome: confirmed ? "command_confirmed" : "command_unknown",
    observed_at: observedAt,
  };
}

function validateMcpConfig(value, runtimeRoot) {
  if (!isPlainObject(value) || !hasExactKeys(value, ["mcpServers"]) ||
      !isPlainObject(value.mcpServers) || !hasExactKeys(value.mcpServers, ["observer"])) {
    fail("E_CLAUDE_HOST_MCP_INVALID", "Observer MCP configが不正です");
  }
  const server = value.mcpServers.observer;
  if (!isPlainObject(server) || !hasExactKeys(server, ["args", "command"]) ||
      typeof server.command !== "string" || !isAbsolute(server.command) || hasControl(server.command) ||
      normalize(server.command) !== server.command || !isPathInside(runtimeRoot, server.command) ||
      !Array.isArray(server.args) || server.args.length !== 1 || server.args[0] !== "--stdio") {
    fail("E_CLAUDE_HOST_MCP_INVALID", "Observer MCP server定義が不正です");
  }
}

function validateClaudeCommand(value) {
  if (typeof value !== "string" || !isAbsolute(value) || normalize(value) !== value || hasControl(value)) {
    fail("E_CLAUDE_HOST_COMMAND_INVALID", "Claude CLI command pathが不正です");
  }
}

function isPathInside(root, candidate) {
  const path = relative(root, candidate);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function validateObserverTools(value) {
  if (!Array.isArray(value) || value.length !== CLAUDE_OBSERVER_TOOLS.length || value.some((tool) => typeof tool !== "string")) {
    fail("E_CLAUDE_HOST_TOOL_INVALID", "Observer MCP tool allowlistが不正です");
  }
  const unique = [...new Set(value)];
  if (unique.length !== value.length) fail("E_CLAUDE_HOST_TOOL_INVALID", "Observer MCP tool allowlistが重複しています");
  const sorted = unique.sort();
  if (sorted.some((tool, index) => tool !== CLAUDE_OBSERVER_TOOLS[index])) {
    fail("E_CLAUDE_HOST_TOOL_INVALID", "Observer MCP tool allowlistが固定surfaceと一致しません");
  }
  return sorted;
}

function validateExpectedIdentity(value) {
  if (!isPlainObject(value) || !hasExactKeys(value, ["cwd", "jobId", "name"])) {
    fail("E_CLAUDE_JOB_CORRELATION_FAILED", "Claude job expected identityが不正です");
  }
  validateJobId(value.jobId, "E_CLAUDE_JOB_CORRELATION_FAILED");
  if (typeof value.name !== "string" || !CLAUDE_NAME_RE.test(value.name) || !isSafeAbsolutePath(value.cwd)) {
    fail("E_CLAUDE_JOB_CORRELATION_FAILED", "Claude job expected identityが不正です");
  }
}

function validateObservation(value) {
  if (!isPlainObject(value) || !hasExactKeys(value, ["cwd", "job_id", "name", "observed_at", "schema", "state"]) ||
      value.schema !== CLAUDE_JOB_OBSERVATION_SCHEMA) {
    fail("E_CLAUDE_JOB_OBSERVATION_INVALID", "Claude job observationが不正です");
  }
  validateJobId(value.job_id, "E_CLAUDE_JOB_OBSERVATION_INVALID");
  if (typeof value.name !== "string" || !CLAUDE_NAME_RE.test(value.name) || !isSafeAbsolutePath(value.cwd) ||
      typeof value.state !== "string" || !KNOWN_STATES.has(value.state)) {
    fail("E_CLAUDE_JOB_OBSERVATION_INVALID", "Claude job observationが不正です");
  }
  validateObservedAt(value.observed_at);
}

function validateStopCommandReceipt(value, expectedJobId) {
  if (!isPlainObject(value) || !hasExactKeys(value, ["job_id", "observed_at", "outcome", "schema"]) ||
      value.schema !== CLAUDE_STOP_COMMAND_RECEIPT_SCHEMA || value.job_id !== expectedJobId ||
      !["command_confirmed", "command_unknown"].includes(value.outcome)) {
    fail("E_CLAUDE_STOP_RECEIPT_INVALID", "Claude stop command receiptが不正です");
  }
  validateObservedAt(value.observed_at);
}

function validateJobId(value, code) {
  if (typeof value !== "string" || !CLAUDE_JOB_ID_RE.test(value)) fail(code, "Claude job IDが不正です");
}

function validateObservedAt(value) {
  if (typeof value !== "string") fail("E_CLAUDE_OBSERVED_AT_INVALID", "observed_atが不正です");
  const date = new Date(value);
  if (Number.isNaN(date.valueOf()) || date.toISOString() !== value) fail("E_CLAUDE_OBSERVED_AT_INVALID", "observed_atが不正です");
}

function isSafeAbsolutePath(value) {
  return typeof value === "string" && isAbsolute(value) && !hasControl(value);
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
