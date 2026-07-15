import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  captureClaudeCharacterizationStop,
  cleanupClaudeCharacterization,
  inspectClaudeCharacterizationReadiness,
  prepareClaudeCharacterization,
  verifyClaudeCharacterization,
} from "../src/claude-characterization.mjs";

const CAMPAIGN = `sha256:${"a".repeat(64)}`;
const JOB = "job-secret-1";
const SESSION = "session-secret-1";
const CWD = "/Users/kite/Developer/Observer";
const NAME = "observer-characterization";
const RESULT = '{"schema":"observer.ai_output.v1","outcome":"no_advisory"}';
const NOW = new Date("2026-07-16T00:00:00.000Z");
const HOOK = fileURLToPath(new URL("../bin/observer-claude-characterization.mjs", import.meta.url));

function runCli(args, input = undefined) {
  return spawnSync(process.execPath, [HOOK, ...args], {
    encoding: "utf8",
    input,
  });
}

async function workRoot() {
  const parent = await mkdtemp(join(tmpdir(), "observer-claude-characterization-"));
  const root = join(parent, "campaign");
  await mkdir(root, { mode: 0o700 });
  await chmod(root, 0o700);
  return root;
}

function payload(patch = {}) {
  return {
    hook_event_name: "Stop",
    session_id: SESSION,
    cwd: CWD,
    stop_hook_active: false,
    last_assistant_message: RESULT,
    ...patch,
  };
}

function agents(patch = {}) {
  return JSON.stringify([{
    id: JOB,
    sessionId: SESSION,
    cwd: CWD,
    name: NAME,
    kind: "background",
    state: "done",
    account: "must-not-persist",
    ...patch,
  }]);
}

test("prepareは隔離settingsだけを0600で生成しraw host identityを含めない", async () => {
  const root = await workRoot();
  const prepared = await prepareClaudeCharacterization({
    workRoot: root,
    hookExecutable: HOOK,
    expectedCwd: CWD,
    campaignId: CAMPAIGN,
  });

  assert.equal(prepared.schema, "observer.claude_characterization_prepare.v1");
  assert.equal(prepared.status, "ready_for_h");
  assert.equal((await stat(prepared.settings_path)).mode & 0o777, 0o600);
  const settings = JSON.parse(await readFile(prepared.settings_path, "utf8"));
  assert.deepEqual(Object.keys(settings), ["hooks"]);
  assert.equal(settings.hooks.Stop.length, 1);
  const command = settings.hooks.Stop[0].hooks[0].command;
  assert.match(command, /\/bin\/observer-claude-characterization\.mjs hook /u);
  assert.match(command, /--campaign-id sha256:[a-f0-9]{64}/u);
  assert.equal(JSON.stringify(prepared).includes(JOB), false);
  assert.equal(JSON.stringify(prepared).includes(SESSION), false);
});

test("Stop captureはsessionとexact resultをdigest化し同一replayだけ冪等にする", async () => {
  const root = await workRoot();
  const prepared = await prepareClaudeCharacterization({
    workRoot: root,
    hookExecutable: HOOK,
    expectedCwd: CWD,
    campaignId: CAMPAIGN,
  });
  const first = await captureClaudeCharacterizationStop({
    campaignId: CAMPAIGN,
    capturePath: prepared.capture_path,
    expectedCwd: CWD,
    payload: payload(),
    now: NOW,
  });
  const replay = await captureClaudeCharacterizationStop({
    campaignId: CAMPAIGN,
    capturePath: prepared.capture_path,
    expectedCwd: CWD,
    payload: payload(),
    now: NOW,
  });

  assert.deepEqual(replay, first);
  assert.equal((await stat(prepared.capture_path)).mode & 0o777, 0o600);
  const serialized = await readFile(prepared.capture_path, "utf8");
  assert.equal(serialized.includes(SESSION), false);
  assert.equal(serialized.includes(RESULT), false);
  assert.equal(serialized.includes("last_assistant_message"), false);

  await assert.rejects(captureClaudeCharacterizationStop({
    campaignId: CAMPAIGN,
    capturePath: prepared.capture_path,
    expectedCwd: CWD,
    payload: payload({ session_id: "different-session" }),
    now: NOW,
  }), { code: "E_CLAUDE_CHARACTERIZATION_CAPTURE_CONFLICT" });
});

test("verifyはagent sessionとStop digest、公開terminal resultをexact照合する", async () => {
  const root = await workRoot();
  const prepared = await prepareClaudeCharacterization({
    workRoot: root,
    hookExecutable: HOOK,
    expectedCwd: CWD,
    campaignId: CAMPAIGN,
  });
  await captureClaudeCharacterizationStop({
    campaignId: CAMPAIGN,
    capturePath: prepared.capture_path,
    expectedCwd: CWD,
    payload: payload(),
    now: NOW,
  });
  const verified = await verifyClaudeCharacterization({
    campaignId: CAMPAIGN,
    capturePath: prepared.capture_path,
    agentsStdout: agents(),
    expected: { jobId: JOB, name: NAME, cwd: CWD },
    replySurface: "unsupported",
    terminalResult: RESULT,
  });

  assert.deepEqual({
    reply_surface: verified.reply_surface,
    job_session_correlation: verified.job_session_correlation,
    stop_capture: verified.stop_capture,
    terminal_exact_result: verified.terminal_exact_result,
    cleanup: verified.cleanup,
  }, {
    reply_surface: "unsupported",
    job_session_correlation: "confirmed",
    stop_capture: "confirmed",
    terminal_exact_result: "confirmed",
    cleanup: "pending",
  });
  const serialized = JSON.stringify(verified);
  for (const raw of [JOB, SESSION, RESULT, "must-not-persist"]) assert.equal(serialized.includes(raw), false);

  await assert.rejects(verifyClaudeCharacterization({
    campaignId: CAMPAIGN,
    capturePath: prepared.capture_path,
    agentsStdout: agents({ sessionId: "different-session" }),
    expected: { jobId: JOB, name: NAME, cwd: CWD },
    replySurface: "unsupported",
    terminalResult: RESULT,
  }), { code: "E_CLAUDE_CHARACTERIZATION_SESSION_MISMATCH" });
});

test("readinessは固定versionと公開helpだけからreply surface不在を確定する", () => {
  const readiness = inspectClaudeCharacterizationReadiness({
    versionStdout: "2.1.210 (Claude Code)\n",
    rootHelp: "--bg --settings --setting-sources --strict-mcp-config --tools --allowedTools",
    agentsHelp: "--json --all --cwd --settings",
  });
  assert.deepEqual(readiness, {
    schema: "observer.claude_characterization_readiness.v1",
    status: "ready_for_h",
    claude_version: "2.1.210",
    reply_surface: "unsupported",
  });
  assert.throws(() => inspectClaudeCharacterizationReadiness({
    versionStdout: "2.1.211 (Claude Code)\n",
    rootHelp: "--bg --settings --setting-sources --strict-mcp-config --tools --allowedTools",
    agentsHelp: "--json --all",
  }), { code: "E_CLAUDE_CHARACTERIZATION_VERSION_UNSUPPORTED" });
});

test("cleanupは既知fileだけを削除し未知fileを含むwork rootを拒否する", async () => {
  const root = await workRoot();
  await prepareClaudeCharacterization({
    workRoot: root,
    hookExecutable: HOOK,
    expectedCwd: CWD,
    campaignId: CAMPAIGN,
  });
  await writeFile(join(root, "unknown.txt"), "preserve\n", { mode: 0o600 });
  await assert.rejects(cleanupClaudeCharacterization({ workRoot: root, campaignId: CAMPAIGN }), {
    code: "E_CLAUDE_CHARACTERIZATION_CLEANUP_UNSAFE",
  });
  assert.deepEqual((await readdir(root)).sort(), ["settings.json", "unknown.txt"]);
});

test("公開CLIはprepareからhook、verify、cleanupまでraw identityを出力しない", async () => {
  const root = await workRoot();
  const prepare = runCli([
    "prepare",
    "--work-root", root,
    "--expected-cwd", CWD,
    "--campaign-id", CAMPAIGN,
  ]);
  assert.equal(prepare.status, 0, prepare.stderr);
  const prepared = JSON.parse(prepare.stdout);

  const hook = runCli([
    "hook",
    "--campaign-id", CAMPAIGN,
    "--capture-path", prepared.capture_path,
    "--expected-cwd", CWD,
  ], JSON.stringify(payload()));
  assert.equal(hook.status, 0, hook.stderr);
  assert.equal(hook.stdout, "");

  const verifyInput = {
    agents: JSON.parse(agents()),
    expected: { jobId: JOB, name: NAME, cwd: CWD },
    reply_surface: "unsupported",
    terminal_result: RESULT,
  };
  const verify = runCli([
    "verify",
    "--campaign-id", CAMPAIGN,
    "--capture-path", prepared.capture_path,
  ], JSON.stringify(verifyInput));
  assert.equal(verify.status, 0, verify.stderr);
  const verified = JSON.parse(verify.stdout);
  assert.equal(verified.job_session_correlation, "confirmed");
  for (const raw of [JOB, SESSION, RESULT, "must-not-persist"]) {
    assert.equal(verify.stdout.includes(raw), false);
  }

  const cleanup = runCli([
    "cleanup",
    "--work-root", root,
    "--campaign-id", CAMPAIGN,
  ]);
  assert.equal(cleanup.status, 0, cleanup.stderr);
  assert.equal(JSON.parse(cleanup.stdout).cleanup, "confirmed");
  await assert.rejects(stat(root), { code: "ENOENT" });
});
