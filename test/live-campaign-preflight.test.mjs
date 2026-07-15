import assert from "node:assert/strict";
import test from "node:test";

import { SUPPORTED_CLAUDE_VERSION } from "../src/claude-host-runtime.mjs";
import { SUPPORTED_CODEX_VERSION } from "../src/codex-process-transport.mjs";
import {
  LIVE_CAMPAIGN_PREFLIGHT_SCHEMA,
  runObserverLiveCampaignPreflight,
} from "../src/live-campaign-preflight.mjs";
import { OBSERVER_MCP_SERVER_VERSION } from "../src/mcp-server.mjs";
import { ObserverError } from "../src/observer-error.mjs";

function readyProduct() {
  return {
    schema: "observer.product_diagnostics.v1",
    status: "ready",
    manifest: { version: OBSERVER_MCP_SERVER_VERSION },
  };
}

function dependencies(calls) {
  return {
    runProductDiagnostics: async ({ packageRoot }) => {
      calls.push("product");
      return readyProduct(packageRoot);
    },
    verifyClaudeRuntime: async ({ runtimeRoot }) => {
      calls.push("claude");
      return {
        schema: "observer.claude_host_runtime_verification.v1",
        runtime_root: runtimeRoot,
        claude: { realpath: "/secret/claude", version: SUPPORTED_CLAUDE_VERSION },
        observer_mcp: {
          realpath: "/secret/observer-mcp",
          version: OBSERVER_MCP_SERVER_VERSION,
          tools: ["observer_read", "observer_wait"],
        },
      };
    },
    verifyCodexRuntime: async ({ runtimeRoot }) => {
      calls.push("codex");
      return {
        schema: "observer.codex_process_verification.v1",
        runtime_root: runtimeRoot,
        codex: { realpath: "/secret/codex", version: SUPPORTED_CODEX_VERSION },
      };
    },
    buildHookFragment: ({ provider }) => {
      calls.push(`hook:${provider}`);
      return {
        schema: "observer.parent_stop_hook_fragment.v1",
        provider,
        event: "Stop",
        entry: { command: `/secret/hook --provider ${provider}` },
      };
    },
  };
}

test("preflightは固定順でread-only prerequisiteだけを確認しh_requiredを返す", async () => {
  const calls = [];
  const result = await runObserverLiveCampaignPreflight({
    claudeCommand: "/secret/claude",
    codexCommand: "/secret/codex",
  }, dependencies(calls));

  assert.equal(result.schema, LIVE_CAMPAIGN_PREFLIGHT_SCHEMA);
  assert.equal(result.status, "h_required");
  assert.equal(result.product_version, "0.0.0");
  assert.equal(result.blocked, null);
  assert.deepEqual(calls, ["product", "claude", "codex", "hook:claude", "hook:codex"]);
  assert.deepEqual(result.checks, [
    { name: "product", status: "ready" },
    { name: "claude_runtime", status: "ready" },
    { name: "codex_runtime", status: "ready" },
    { name: "hook_candidates", status: "ready" },
    { name: "canonical_cwd", status: "ready" },
    { name: "claude_public_surface", status: "h_required" },
    { name: "codex_public_surface", status: "h_required" },
  ]);
  assert.deepEqual(result.required_evidence, [
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
  assert.equal(JSON.stringify(result).includes("/secret"), false);
});

test("unsupported platformはproductでblockedとなり後続を実行しない", async () => {
  const touched = [];
  const result = await runObserverLiveCampaignPreflight({}, {
    runProductDiagnostics: async () => ({
      schema: "observer.product_diagnostics.v1",
      status: "unsupported_platform",
      manifest: { version: "0.0.0" },
    }),
    verifyClaudeRuntime: async () => { touched.push("claude"); },
    verifyCodexRuntime: async () => { touched.push("codex"); },
  });
  assert.equal(result.status, "blocked");
  assert.deepEqual(result.blocked, {
    check: "product",
    code: "E_LIVE_PREFLIGHT_PLATFORM_UNSUPPORTED",
  });
  assert.equal(result.checks[0].status, "blocked");
  assert.equal(result.checks.slice(1).every(({ status }) => status === "not_checked"), true);
  assert.deepEqual(touched, []);
});

test("known Claude failureはsanitized blockedとなりCodexへ進まない", async () => {
  const calls = [];
  const deps = dependencies(calls);
  deps.verifyClaudeRuntime = async () => {
    calls.push("claude");
    throw new ObserverError("E_CLAUDE_VERSION_UNSUPPORTED", "raw /secret/path");
  };
  const result = await runObserverLiveCampaignPreflight({}, deps);
  assert.equal(result.status, "blocked");
  assert.deepEqual(result.blocked, {
    check: "claude_runtime",
    code: "E_CLAUDE_VERSION_UNSUPPORTED",
  });
  assert.deepEqual(calls, ["product", "claude"]);
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("unknown failureはblockedへ偽装せずfail loudにする", async () => {
  await assert.rejects(runObserverLiveCampaignPreflight({}, {
    runProductDiagnostics: async () => { throw new Error("unknown secret"); },
  }), /unknown secret/);
});
