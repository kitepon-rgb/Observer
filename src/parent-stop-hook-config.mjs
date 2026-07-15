import { accessSync, constants, statSync } from "node:fs";
import { isAbsolute } from "node:path";

import { fail } from "./observer-error.mjs";

export const PARENT_STOP_HOOK_TIMEOUT_SECONDS = 5;

const PROVIDERS = new Set(["claude", "codex"]);
const FRAGMENT_SCHEMA = "observer.parent_stop_hook_fragment.v1";
const VERIFICATION_SCHEMA = "observer.parent_stop_hook_verification.v1";
const INVALID_PATH_CHARACTERS = /[\s\u0000-\u001f\u007f'"]/u;

function assertProvider(provider) {
  if (!PROVIDERS.has(provider)) fail("E_PARENT_STOP_HOOK_PROVIDER_INVALID", "parent Stop hook providerが不正です");
}

function assertExecutablePath(executablePath) {
  if (typeof executablePath !== "string"
    || !isAbsolute(executablePath)
    || executablePath.length === 0
    || INVALID_PATH_CHARACTERS.test(executablePath)) {
    fail("E_PARENT_STOP_HOOK_EXECUTABLE_INVALID", "parent Stop hook executable pathが不正です");
  }
  try {
    if (!statSync(executablePath).isFile()) throw new Error("not a regular file");
    accessSync(executablePath, constants.X_OK);
  } catch {
    fail("E_PARENT_STOP_HOOK_EXECUTABLE_UNAVAILABLE", "parent Stop hook executableが存在しないか実行できません");
  }
}

function commandFor(provider, executablePath) {
  return `${executablePath} --provider ${provider}`;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function exactObject(value, expected) {
  if (!isPlainObject(value)) return false;
  const valueKeys = Object.keys(value).sort();
  const expectedKeys = Object.keys(expected).sort();
  if (valueKeys.length !== expectedKeys.length || valueKeys.some((key, index) => key !== expectedKeys[index])) return false;
  return expectedKeys.every((key) => exactValue(value[key], expected[key]));
}

function exactValue(value, expected) {
  if (Array.isArray(expected)) {
    return Array.isArray(value)
      && value.length === expected.length
      && value.every((item, index) => exactValue(item, expected[index]));
  }
  if (isPlainObject(expected)) return exactObject(value, expected);
  return value === expected;
}

function isTargetCommand(value, provider, executablePath) {
  if (!isPlainObject(value) || typeof value.command !== "string") return false;
  if (!value.command.startsWith(`${executablePath} `)) return false;
  return new RegExp(`(?:^|\\s)--provider\\s+${provider}(?:\\s|$)`, "u").test(value.command);
}

function stopEntries(candidate) {
  if (!isPlainObject(candidate) || (candidate.hooks !== undefined && !isPlainObject(candidate.hooks))) {
    fail("E_PARENT_STOP_HOOK_CANDIDATE_INVALID", "hook candidate JSONが不正です");
  }
  if (candidate.hooks?.Stop === undefined) return [];
  if (!Array.isArray(candidate.hooks.Stop)) fail("E_PARENT_STOP_HOOK_CANDIDATE_INVALID", "hook candidate JSONが不正です");
  return candidate.hooks.Stop;
}

function verification(provider, status, targetCount) {
  return {
    schema: VERIFICATION_SCHEMA,
    provider,
    event: "Stop",
    status,
    target_count: targetCount,
  };
}

export function buildParentStopHookFragment({ provider, executablePath } = {}) {
  assertProvider(provider);
  assertExecutablePath(executablePath);

  const command = commandFor(provider, executablePath);
  const entry = provider === "claude"
    ? { hooks: [{ type: "command", command, timeout: PARENT_STOP_HOOK_TIMEOUT_SECONDS }] }
    : {
      type: "command",
      command,
      timeoutSec: PARENT_STOP_HOOK_TIMEOUT_SECONDS,
      async: false,
      statusMessage: null,
    };

  return { schema: FRAGMENT_SCHEMA, provider, event: "Stop", entry };
}

export function verifyParentStopHookConfig({ provider, executablePath, candidate } = {}) {
  assertProvider(provider);
  assertExecutablePath(executablePath);
  const entries = stopEntries(candidate);
  const canonical = buildParentStopHookFragment({ provider, executablePath }).entry;

  if (provider === "claude") {
    const targets = [];
    for (const entry of entries) {
      if (!isPlainObject(entry) || !Array.isArray(entry.hooks)) continue;
      for (const hook of entry.hooks) {
        if (isTargetCommand(hook, provider, executablePath)) targets.push({ entry, hook });
      }
    }
    if (targets.length === 0) return verification(provider, "missing", 0);
    if (targets.length > 1) return verification(provider, "duplicate", targets.length);
    return verification(provider, exactObject(targets[0].entry, canonical) && exactObject(targets[0].hook, canonical.hooks[0]) ? "canonical" : "noncanonical", 1);
  }

  const targets = entries.filter((entry) => isTargetCommand(entry, provider, executablePath));
  if (targets.length === 0) return verification(provider, "missing", 0);
  if (targets.length > 1) return verification(provider, "duplicate", targets.length);
  return verification(provider, exactObject(targets[0], canonical) ? "canonical" : "noncanonical", 1);
}
