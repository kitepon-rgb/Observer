import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import {
  CLAUDE_HOST_RUNTIME_VERIFICATION_SCHEMA,
  SUPPORTED_CLAUDE_VERSION,
  verifyClaudeHostRuntime,
} from "./claude-host-runtime.mjs";
import {
  CODEX_PROCESS_VERIFICATION_SCHEMA,
  SUPPORTED_CODEX_VERSION,
  verifyCodexAppServerRuntime,
} from "./codex-process-transport.mjs";
import { OBSERVER_MCP_SERVER_VERSION } from "./mcp-server.mjs";
import { ObserverError, fail } from "./observer-error.mjs";
import { buildParentStopHookFragment } from "./parent-stop-hook-config.mjs";
import {
  OBSERVER_PRODUCT_DIAGNOSTICS_SCHEMA,
  OBSERVER_PRODUCT_VERSION,
  runObserverProductDiagnostics,
} from "./product-diagnostics.mjs";

export const LIVE_CAMPAIGN_PREFLIGHT_SCHEMA = "observer.live_campaign_preflight.v1";

const PACKAGE_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const MCP_TOOLS = Object.freeze(["observer_read", "observer_wait"]);
const CHECK_NAMES = Object.freeze([
  "product",
  "claude_runtime",
  "codex_runtime",
  "hook_candidates",
  "canonical_cwd",
  "claude_public_surface",
  "codex_public_surface",
]);
const REQUIRED_EVIDENCE = Object.freeze([
  "claude.completed_turn_receipt",
  "claude.job_session_correlation",
  "claude.stop_hook_capture",
  "claude.wait_over_65s",
  "claude.explicit_stop_terminal",
  "codex.task_complete_receipt",
  "codex.thread_turn_cwd_correlation",
  "codex.stop_hook_capture",
  "codex.wait_over_65s",
  "codex.interrupt_stop_terminal",
  "parent.continuation_delivery",
  "project.fingerprint_unchanged",
]);
const H_ACTIONS = Object.freeze([
  "host_config_apply",
  "hook_trust",
  "claude_background_launch",
  "codex_app_server_launch",
  "model_request",
  "wait_over_65s",
  "explicit_stop",
  "optional_fault_tranche",
]);
const NOT_PERFORMED = Object.freeze([
  "provider_launch",
  "model_request",
  "host_config_read",
  "host_config_write",
  "hook_trust",
  "credential_access",
  "intentional_fault",
]);
const PROHIBITED_CAPTURE = Object.freeze([
  "raw_host_log",
  "prompt_body",
  "host_config_body",
  "raw_session_id",
  "raw_thread_id",
  "raw_job_id",
  "token",
  "cookie",
  "credential",
]);

export async function runObserverLiveCampaignPreflight(
  { claudeCommand, codexCommand } = {},
  dependencies = {},
) {
  const checks = CHECK_NAMES.map((name) => ({ name, status: "not_checked" }));
  const runtimeRoot = PACKAGE_ROOT;
  let product;
  let claude;
  let codex;

  let blocked = await attempt(checks, 0, async () => {
    const run = dependencies.runProductDiagnostics ?? runObserverProductDiagnostics;
    product = await run({ packageRoot: runtimeRoot }, dependencies.productDependencies);
    validateProduct(product);
  });
  if (blocked !== null) return blockedReceipt(checks, blocked);

  blocked = await attempt(checks, 1, async () => {
    const verify = dependencies.verifyClaudeRuntime ?? verifyClaudeHostRuntime;
    claude = await verify(
      { runtimeRoot, claudeCommand },
      dependencies.claudeDependencies,
    );
    validateClaude(claude);
  });
  if (blocked !== null) return blockedReceipt(checks, blocked);

  blocked = await attempt(checks, 2, async () => {
    const verify = dependencies.verifyCodexRuntime ?? verifyCodexAppServerRuntime;
    codex = await verify(
      { runtimeRoot, codexCommand },
      dependencies.codexDependencies,
    );
    validateCodex(codex);
  });
  if (blocked !== null) return blockedReceipt(checks, blocked);

  blocked = await attempt(checks, 3, async () => {
    const build = dependencies.buildHookFragment ?? buildParentStopHookFragment;
    const executablePath = resolve(runtimeRoot, "bin/observer-parent-stop-hook.mjs");
    validateHookFragment(build({ provider: "claude", executablePath }), "claude");
    validateHookFragment(build({ provider: "codex", executablePath }), "codex");
  });
  if (blocked !== null) return blockedReceipt(checks, blocked);

  blocked = await attempt(checks, 4, async () => {
    if (claude.runtime_root !== runtimeRoot || codex.runtime_root !== runtimeRoot) {
      fail("E_LIVE_PREFLIGHT_CWD_MISMATCH", "host runtimeのcanonical cwdがObserver packageと一致しません");
    }
  });
  if (blocked !== null) return blockedReceipt(checks, blocked);

  checks[5].status = "h_required";
  checks[6].status = "h_required";
  return receipt("h_required", checks, null);
}

async function attempt(checks, index, action) {
  try {
    await action();
    checks[index].status = "ready";
    return null;
  } catch (error) {
    if (!(error instanceof ObserverError)) throw error;
    checks[index].status = "blocked";
    return { check: checks[index].name, code: error.code };
  }
}

function blockedReceipt(checks, blocked) {
  return receipt("blocked", checks, blocked);
}

function receipt(status, checks, blocked) {
  return {
    schema: LIVE_CAMPAIGN_PREFLIGHT_SCHEMA,
    status,
    product_version: OBSERVER_PRODUCT_VERSION,
    checks: checks.map((check) => ({ ...check })),
    blocked,
    required_evidence: [...REQUIRED_EVIDENCE],
    h_actions: [...H_ACTIONS],
    not_performed: [...NOT_PERFORMED],
    prohibited_capture: [...PROHIBITED_CAPTURE],
  };
}

function validateProduct(value) {
  if (!isPlainObject(value) || value.schema !== OBSERVER_PRODUCT_DIAGNOSTICS_SCHEMA) {
    fail("E_LIVE_PREFLIGHT_PRODUCT_INVALID", "Observer product diagnostics resultが不正です");
  }
  if (value.status === "unsupported_platform") {
    fail("E_LIVE_PREFLIGHT_PLATFORM_UNSUPPORTED", "live campaignに対応しないplatformです");
  }
  if (value.status !== "ready" || !isPlainObject(value.manifest) ||
      value.manifest.version !== OBSERVER_PRODUCT_VERSION) {
    fail("E_LIVE_PREFLIGHT_PRODUCT_INVALID", "Observer product diagnostics resultが不正です");
  }
}

function validateClaude(value) {
  if (!isPlainObject(value) || value.schema !== CLAUDE_HOST_RUNTIME_VERIFICATION_SCHEMA ||
      typeof value.runtime_root !== "string" || value.claude?.version !== SUPPORTED_CLAUDE_VERSION ||
      value.observer_mcp?.version !== OBSERVER_MCP_SERVER_VERSION ||
      !sameArray(value.observer_mcp?.tools, MCP_TOOLS)) {
    fail("E_LIVE_PREFLIGHT_CLAUDE_RUNTIME_INVALID", "Claude runtime verification resultが不正です");
  }
}

function validateCodex(value) {
  if (!isPlainObject(value) || value.schema !== CODEX_PROCESS_VERIFICATION_SCHEMA ||
      typeof value.runtime_root !== "string" || value.codex?.version !== SUPPORTED_CODEX_VERSION) {
    fail("E_LIVE_PREFLIGHT_CODEX_RUNTIME_INVALID", "Codex runtime verification resultが不正です");
  }
}

function validateHookFragment(value, provider) {
  if (!isPlainObject(value) || value.schema !== "observer.parent_stop_hook_fragment.v1" ||
      value.provider !== provider || value.event !== "Stop" || !isPlainObject(value.entry)) {
    fail("E_LIVE_PREFLIGHT_HOOK_CANDIDATE_INVALID", "parent Stop hook fragmentが不正です");
  }
}

function sameArray(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length &&
    actual.every((value, index) => value === expected[index]);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}
