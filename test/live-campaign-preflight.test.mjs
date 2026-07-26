import assert from "node:assert/strict";
import test from "node:test";

import { SUPPORTED_AITERM_VERSION } from "../src/aiterm-process-transport.mjs";
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
    verifyThroughlineRuntime: async ({ runtimeRoot }) => {
      calls.push("throughline");
      return {
        schema: "observer.throughline_process_verification.v1",
        runtime_root: runtimeRoot,
        throughline: { version: "0.9.1" },
      };
    },
    createThroughlineClient: () => ({
      read: async () => {
        calls.push("throughline:read");
        return { schema: "throughline.observer_read.v1", status: "snapshot" };
      },
    }),
    verifyAitermRuntime: async ({ runtimeRoot }) => {
      calls.push("aiterm");
      return {
        schema: "observer.aiterm_process_verification.v1",
        runtime_root: runtimeRoot,
        aiterm: { required_version: SUPPORTED_AITERM_VERSION },
      };
    },
    startAitermTransport: async () => {
      calls.push("aiterm:start");
      return {
        closeAndWait: async () => {
          calls.push("aiterm:close");
          return { schema: "observer.aiterm_process_terminal.v1", status: "closed", exit_code: 0, signal: null };
        },
      };
    },
    verifyCodexRuntime: async ({ runtimeRoot }) => {
      calls.push("codex");
      return {
        schema: "observer.codex_process_verification.v1",
        runtime_root: runtimeRoot,
        codex: { realpath: "/secret/codex", version: "codex-cli 0.145.0" },
      };
    },
    buildHookFragment: ({ provider, stateRoot }) => {
      calls.push(`hook:${provider}`);
      const command = `/secret/hook --provider ${provider} --state-root ${stateRoot}`;
      return {
        schema: "observer.parent_stop_hook_fragment.v1",
        provider,
        event: "Stop",
        entry: provider === "claude" ? { hooks: [{ command }] } : { command },
      };
    },
  };
}

test("preflightは固定順でread-only prerequisiteだけを確認しh_requiredを返す", async () => {
  const calls = [];
  const result = await runObserverLiveCampaignPreflight({
    throughlineCommand: "/secret/throughline",
    aitermCommand: "/secret/aiterm",
    codexCommand: "/secret/codex",
    stateRoot: "/secret/state",
  }, dependencies(calls));

  assert.equal(result.schema, LIVE_CAMPAIGN_PREFLIGHT_SCHEMA);
  assert.equal(result.status, "h_required");
  assert.equal(result.product_version, "0.1.1");
  assert.equal(result.blocked, null);
  assert.deepEqual(calls, ["product", "throughline", "throughline:read", "aiterm", "aiterm:start", "aiterm:close", "codex", "hook:claude", "hook:codex"]);
  assert.deepEqual(result.checks, [
    { name: "product", status: "ready" },
    { name: "throughline_runtime", status: "ready" },
    { name: "aiterm_runtime", status: "ready" },
    { name: "codex_runtime", status: "ready" },
    { name: "hook_candidates", status: "ready" },
    { name: "canonical_cwd", status: "ready" },
    { name: "claude_public_surface", status: "h_required" },
    { name: "codex_public_surface", status: "h_required" },
  ]);
  assert.deepEqual(result.required_evidence, [
    "claude.completed_turn_receipt",
    "claude.session_generation_correlation",
    "claude.initial_exact_result",
    "claude.follow_up_exact_result",
    "claude.stop_hook_capture",
    "claude.wait_over_65s",
    "claude.session_close_terminal",
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
      manifest: { version: "0.1.1" },
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

test("known Aiterm failureはsanitized blockedとなりCodexへ進まない", async () => {
  const calls = [];
  const deps = dependencies(calls);
  deps.verifyAitermRuntime = async () => {
    calls.push("aiterm");
    throw new ObserverError("E_AITERM_VERSION_UNSUPPORTED", "raw /secret/path");
  };
  const result = await runObserverLiveCampaignPreflight({}, deps);
  assert.equal(result.status, "blocked");
  assert.deepEqual(result.blocked, {
    check: "aiterm_runtime",
    code: "E_AITERM_VERSION_UNSUPPORTED",
  });
  assert.deepEqual(calls, ["product", "throughline", "throughline:read", "aiterm"]);
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("Throughline observer-read欠落はversion一致でもblockedとなり後続へ進まない", async () => {
  const calls = [];
  const deps = dependencies(calls);
  deps.createThroughlineClient = () => ({
    read: async () => {
      calls.push("throughline:read");
      throw new ObserverError("E_THROUGHLINE_EXEC", "raw /secret/path");
    },
  });
  const result = await runObserverLiveCampaignPreflight({}, deps);
  assert.equal(result.status, "blocked");
  assert.deepEqual(result.blocked, {
    check: "throughline_runtime",
    code: "E_THROUGHLINE_EXEC",
  });
  assert.deepEqual(calls, ["product", "throughline", "throughline:read"]);
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("unknown failureはblockedへ偽装せずfail loudにする", async () => {
  await assert.rejects(runObserverLiveCampaignPreflight({}, {
    runProductDiagnostics: async () => { throw new Error("unknown secret"); },
  }), /unknown secret/);
});
