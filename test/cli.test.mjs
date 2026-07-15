import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  executeObserverCommand,
  formatObserverCliError,
  parseObserverArguments,
} from "../src/observer-cli.mjs";
import { defaultStateRoot } from "../src/private-state.mjs";

const CLI = new URL("../bin/observer.mjs", import.meta.url).pathname;

test("diagnostics CLIは引数とready／unsupported exitを固定する", async () => {
  assert.deepEqual(parseObserverArguments(["diagnostics"]), { kind: "diagnostics" });
  assert.throws(() => parseObserverArguments(["diagnostics", "extra"]), { code: "E_USAGE" });
  const ready = await executeObserverCommand(["diagnostics"], {}, {
    runObserverProductDiagnostics: async () => ({ schema: "observer.product_diagnostics.v1", status: "ready" }),
  });
  assert.equal(ready.exitCode, 0);
  const unsupported = await executeObserverCommand(["diagnostics"], {}, {
    runObserverProductDiagnostics: async () => ({
      schema: "observer.product_diagnostics.v1", status: "unsupported_platform",
    }),
  });
  assert.equal(unsupported.exitCode, 1);
});

test("campaign preflight CLIはabsolute host commandとh_required／blocked exitを固定する", async () => {
  const argv = [
    "campaign", "preflight",
    "--claude-command", "/bin/claude",
    "--codex-command", "/bin/codex",
  ];
  assert.deepEqual(parseObserverArguments(argv), {
    kind: "campaign_preflight",
    claudeCommand: "/bin/claude",
    codexCommand: "/bin/codex",
  });
  const calls = [];
  const hRequired = await executeObserverCommand(argv, {}, {
    runObserverLiveCampaignPreflight: async (input) => {
      calls.push(input);
      return { schema: "observer.live_campaign_preflight.v1", status: "h_required" };
    },
  });
  assert.equal(hRequired.exitCode, 0);
  assert.deepEqual(calls, [{ claudeCommand: "/bin/claude", codexCommand: "/bin/codex" }]);
  const blocked = await executeObserverCommand(argv, {}, {
    runObserverLiveCampaignPreflight: async () => ({
      schema: "observer.live_campaign_preflight.v1", status: "blocked",
    }),
  });
  assert.equal(blocked.exitCode, 1);
  assert.throws(() => parseObserverArguments([
    ...argv, "--claude-command", "/other/claude",
  ]), { code: "E_USAGE" });
  assert.throws(() => parseObserverArguments([
    "campaign", "preflight", "--claude-command", "relative", "--codex-command", "/bin/codex",
  ]), { code: "E_USAGE" });
  assert.throws(() => parseObserverArguments([
    "campaign", "preflight", "--claude-command", "/bin/claude",
  ]), { code: "E_USAGE" });
});

test("target register CLIは同じprojectを同じtargetへ登録する", async () => {
  const root = await mkdtemp(join(tmpdir(), "observer-cli-"));
  const project = join(root, "project");
  const state = join(root, "state");
  await mkdir(project);

  const first = spawnSync(process.execPath, [CLI, "target", "register", project, "--state-root", state], { encoding: "utf8" });
  const second = spawnSync(process.execPath, [CLI, "target", "register", project, "--state-root", state], { encoding: "utf8" });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  const created = JSON.parse(first.stdout);
  const existing = JSON.parse(second.stdout);
  assert.equal(created.status, "created");
  assert.equal(existing.status, "existing");
  assert.equal(created.target_id, existing.target_id);

  const status = spawnSync(process.execPath, [CLI, "watch", "status", project, "--state-root", state], { encoding: "utf8" });
  assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout), {
    schema: "observer.watch_command_result.v1",
    action: "status",
    status: "not_started",
    provider: null,
    watch: null,
  });

  const start = spawnSync(process.execPath, [CLI, "watch", project, "--state-root", state], { encoding: "utf8" });
  assert.equal(start.status, 1);
  assert.equal(JSON.parse(start.stderr).code, "E_PARENT_WATCH_CONTEXT_REQUIRED");
});

test("watch CLIはproduct aliasとstart/status/stopをabsolute pathへexact parseする", () => {
  assert.deepEqual(parseObserverArguments(["watch", "/project", "--state-root", "/state"]), {
    kind: "watch_start", projectRoot: "/project", stateRoot: "/state",
  });
  assert.deepEqual(parseObserverArguments(["watch", "start", "/project"]), {
    kind: "watch_start", projectRoot: "/project", stateRoot: defaultStateRoot(),
  });
  assert.deepEqual(parseObserverArguments(["watch", "status", "/project", "--state-root", "/state"]), {
    kind: "watch_status", projectRoot: "/project", stateRoot: "/state",
  });
  assert.deepEqual(parseObserverArguments(["watch", "stop", "/project", "--state-root", "/state"]), {
    kind: "watch_stop", projectRoot: "/project", stateRoot: "/state",
  });
  assert.throws(() => parseObserverArguments(["watch", "relative"]), { code: "E_PROJECT_PATH_NOT_ABSOLUTE" });
  assert.throws(() => parseObserverArguments(["watch", "stop", "/project", "--unknown", "x"]), { code: "E_USAGE" });
});

test("watch dispatcherは親contextをstart/stopだけへ渡し、provider_unavailableを非0にする", async () => {
  const parentContext = { marker: "parent" };
  const calls = [];
  const result = {
    schema: "observer.watch_command_result.v1",
    action: "start",
    status: "provider_unavailable",
    provider: "codex",
    watch: null,
  };
  const outcome = await executeObserverCommand([
    "watch", "/project", "--state-root", "/state",
  ], { parentContext }, {
    startObserverWatch: async (input) => { calls.push(input); return result; },
  });
  assert.deepEqual(calls, [{ stateRoot: "/state", projectRoot: "/project", parentContext }]);
  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.result.status, "provider_unavailable");
});

test("parent codex run CLIはabsolute入力だけをparseし、runtime root引数を受け付けない", () => {
  const parsed = parseObserverArguments([
    "parent", "codex", "run", "/project",
    "--throughline-command", "/bin/throughline",
    "--codex-command", "/bin/codex",
    "--state-root", "/state",
    "--expected-previous-watch-id", "w_11111111-1111-4111-8111-111111111111",
    "--timeout-seconds", "120",
    "--poll-interval-ms", "250",
    "--plan-ref", "file:docs/plan.md",
  ]);
  assert.deepEqual(parsed, {
    kind: "parent_codex_run",
    projectRoot: "/project",
    stateRoot: "/state",
    throughlineCommand: "/bin/throughline",
    codexCommand: "/bin/codex",
    expectedPreviousWatchId: "w_11111111-1111-4111-8111-111111111111",
    timeoutSeconds: 120,
    pollIntervalMs: 250,
    planRefs: ["file:docs/plan.md"],
  });
  assert.throws(() => parseObserverArguments([
    "parent", "codex", "run", "/project",
    "--throughline-command", "relative",
    "--codex-command", "/bin/codex",
  ]), { code: "E_USAGE" });
  assert.throws(() => parseObserverArguments([
    "parent", "codex", "run", "/project",
    "--throughline-command", "/bin/throughline",
    "--codex-command", "/bin/codex",
    "--runtime-root", "/forbidden",
  ]), { code: "E_USAGE" });
  assert.throws(() => parseObserverArguments([
    "parent", "codex", "run", "/project",
    "--throughline-command", "/bin/throughline",
    "--codex-command", "/bin/codex",
    "--expected-previous-watch-id", "not-a-watch",
  ]), { code: "E_USAGE" });
});

test("parent codex runはinstalled package rootとexact context、signalをcallerへ渡しsanitized resultを既存exit契約へ写像する", async () => {
  const controller = new AbortController();
  controller.abort();
  const expectedRuntimeRoot = fileURLToPath(new URL("../", new URL("../src/observer-cli.mjs", import.meta.url)));
  const outcome = await executeObserverCommand([
    "parent", "codex", "run", "/project",
    "--throughline-command", "/bin/throughline",
    "--codex-command", "/bin/codex",
    "--state-root", "/state",
    "--expected-previous-watch-id", "w_11111111-1111-4111-8111-111111111111",
    "--plan-ref", "file:docs/plan.md",
  ], { signal: controller.signal }, {
    runCodexParentWatchProcess: async (received) => {
      assert.equal(received.runtimeRoot, expectedRuntimeRoot);
      assert.equal(received.signal, controller.signal);
      assert.deepEqual(received.parentContext, {
        schema: "observer.parent_watch_context.v1",
        parent_provider: "codex",
        runtime_root: expectedRuntimeRoot,
        expected_previous_watch_id: "w_11111111-1111-4111-8111-111111111111",
        authorization: {
          schema: "observer.parent_authorization.v1",
          intent: "start_observer",
          parent_provider: "codex",
        },
      });
      assert.deepEqual(received.planRefs, ["file:docs/plan.md"]);
      assert.deepEqual(received.testReceipts, []);
      return {
        schema: "observer.codex_parent_caller_result.v1",
        status: "cancelled",
        provider: "codex",
        cycle_id: null,
      };
    },
  });
  assert.deepEqual(outcome, {
    result: {
      schema: "observer.codex_parent_caller_result.v1",
      status: "cancelled",
      provider: "codex",
      cycle_id: null,
    },
    exitCode: 130,
  });
});

test("parent codex runはknown faultを非0へ写像し、unsanitized caller resultを拒否する", async () => {
  const argv = [
    "parent", "codex", "run", "/project",
    "--throughline-command", "/bin/throughline",
    "--codex-command", "/bin/codex",
  ];
  const faulted = await executeObserverCommand(argv, {}, {
    runCodexParentWatchProcess: async () => ({
      schema: "observer.codex_parent_caller_result.v1",
      status: "faulted",
      provider: "codex",
      cycle_id: null,
    }),
  });
  assert.equal(faulted.exitCode, 1);
  await assert.rejects(executeObserverCommand(argv, {}, {
    runCodexParentWatchProcess: async () => ({
      schema: "observer.codex_parent_caller_result.v1",
      status: "stopped",
      provider: "codex",
      cycle_id: null,
      secret: "must-not-pass",
    }),
  }), { code: "E_CODEX_PARENT_CLI_RESULT_INVALID" });
});

test("supervisor run CLIはabsolute runtimeとwatch identityをexact parseする", () => {
  const parsed = parseObserverArguments([
    "supervisor", "run", "/project",
    "--watch-id", "w_11111111-1111-4111-8111-111111111111",
    "--runtime-root", "/observer",
    "--throughline-command", "/bin/throughline",
    "--codex-command", "/bin/codex",
    "--state-root", "/state",
    "--timeout-seconds", "120",
    "--poll-interval-ms", "250",
    "--plan-ref", "file:docs/plan.md",
  ]);
  assert.deepEqual(parsed, {
    kind: "supervisor_run",
    projectRoot: "/project",
    stateRoot: "/state",
    watchId: "w_11111111-1111-4111-8111-111111111111",
    runtimeRoot: "/observer",
    throughlineCommand: "/bin/throughline",
    codexCommand: "/bin/codex",
    timeoutSeconds: 120,
    pollIntervalMs: 250,
    planRefs: ["file:docs/plan.md"],
  });
  assert.throws(() => parseObserverArguments([
    "supervisor", "run", "/project",
    "--watch-id", "w_11111111-1111-4111-8111-111111111111",
    "--runtime-root", "relative",
    "--throughline-command", "/bin/throughline",
    "--codex-command", "/bin/codex",
  ]), { code: "E_USAGE" });
});

test("supervisor runはregistered targetだけを使い、terminal statusをexit codeへ分離する", async () => {
  const target = {
    schema: "observer.project_target.v1",
    targetId: `p_${"a".repeat(64)}`,
    projectRoot: "/project",
    statePath: "/state/targets/target.json",
  };
  const calls = [];
  const outcome = await executeObserverCommand([
    "supervisor", "run", "/project",
    "--watch-id", "w_11111111-1111-4111-8111-111111111111",
    "--runtime-root", "/observer",
    "--throughline-command", "/bin/throughline",
    "--codex-command", "/bin/codex",
    "--state-root", "/state",
  ], {}, {
    readRegisteredProjectTarget: async (input) => { calls.push(["target", input]); return target; },
    runCodexSupervisorProcess: async (input) => {
      calls.push(["run", input]);
      return {
        schema: "observer.supervisor_process_result.v1",
        status: "provider_unavailable",
        provider: "codex",
        cycle_id: null,
      };
    },
  });
  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.result.status, "provider_unavailable");
  assert.deepEqual(calls[0][1], { stateRoot: "/state", projectRoot: "/project" });
  assert.equal(calls[1][1].target.targetId, target.targetId);
  assert.equal(calls[1][1].timeoutSeconds, 3600);
  assert.equal(calls[1][1].pollIntervalMs, 1000);
});

test("signal cancelとcleanup failureは別のsanitized exit contractを持つ", async () => {
  const controller = new AbortController();
  controller.abort();
  const cancelled = await executeObserverCommand([
    "supervisor", "run", "/project",
    "--watch-id", "w_11111111-1111-4111-8111-111111111111",
    "--runtime-root", "/observer",
    "--throughline-command", "/bin/throughline",
    "--codex-command", "/bin/codex",
    "--state-root", "/state",
  ], { signal: controller.signal }, {
    readRegisteredProjectTarget: async () => ({
      schema: "observer.project_target.v1",
      targetId: `p_${"a".repeat(64)}`,
      projectRoot: "/project",
    }),
    runCodexSupervisorProcess: async ({ signal }) => {
      assert.equal(signal.aborted, true);
      return {
        schema: "observer.supervisor_process_result.v1",
        status: "cancelled",
        provider: "codex",
        cycle_id: null,
      };
    },
  });
  assert.equal(cancelled.exitCode, 130);
  const formatted = formatObserverCliError(new AggregateError([new Error("secret")], "raw secret"));
  assert.deepEqual(formatted, {
    result: {
      schema: "observer.cli_error.v1",
      code: "E_SUPERVISOR_PROCESS_CLEANUP_FAILED",
      message: "Supervisor processまたはcleanupが失敗しました",
    },
    exitCode: 1,
  });
  assert.equal(JSON.stringify(formatted).includes("secret"), false);
});

test("supervisor CLIは内部rollover_requiredをterminal結果として受理しない", async () => {
  await assert.rejects(executeObserverCommand([
    "supervisor", "run", "/project",
    "--watch-id", "w_11111111-1111-4111-8111-111111111111",
    "--runtime-root", "/observer",
    "--throughline-command", "/bin/throughline",
    "--codex-command", "/bin/codex",
    "--state-root", "/state",
  ], {}, {
    readRegisteredProjectTarget: async () => ({
      schema: "observer.project_target.v1",
      targetId: `p_${"a".repeat(64)}`,
      projectRoot: "/project",
    }),
    runCodexSupervisorProcess: async () => ({
      schema: "observer.supervisor_process_result.v1",
      status: "rollover_required",
      provider: "codex",
      cycle_id: `c_${"b".repeat(64)}`,
    }),
  }), { code: "E_SUPERVISOR_CLI_RESULT_INVALID" });
});
