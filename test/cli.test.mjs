import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  executeObserverCommand,
  formatObserverCliError,
  parseObserverArguments,
} from "../src/observer-cli.mjs";

const CLI = new URL("../bin/observer.mjs", import.meta.url).pathname;

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
