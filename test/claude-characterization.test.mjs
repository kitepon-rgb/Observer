import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  captureClaudeCharacterizationStopInput,
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
  const command = process.platform === "win32" ? process.execPath : HOOK;
  const commandArgs = process.platform === "win32" ? [HOOK, ...args] : args;
  return spawnSync(command, commandArgs, {
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

  assert.equal(prepared.schema, "observer.claude_characterization_prepare.v2");
  assert.equal(prepared.status, "ready_for_h");
  assert.equal((await stat(prepared.settings_path)).mode & 0o777, 0o600);
  const settings = JSON.parse(await readFile(prepared.settings_path, "utf8"));
  assert.deepEqual(Object.keys(settings), ["hooks"]);
  assert.equal(settings.hooks.Stop.length, 1);
  const command = settings.hooks.Stop[0].hooks[0].command;
  assert.match(command, /\/bin\/observer-claude-characterization\.mjs hook /u);
  assert.match(command, /--campaign-id sha256:[a-f0-9]{64}/u);
  assert.match(command, /--hook-receipt-path .*\/hook-receipt\.json/u);
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
  const first = await captureClaudeCharacterizationStopInput({
    campaignId: CAMPAIGN,
    capturePath: prepared.capture_path,
    hookReceiptPath: prepared.hook_receipt_path,
    expectedCwd: CWD,
    stdin: JSON.stringify(payload()),
    now: NOW,
  });
  const replay = await captureClaudeCharacterizationStopInput({
    campaignId: CAMPAIGN,
    capturePath: prepared.capture_path,
    hookReceiptPath: prepared.hook_receipt_path,
    expectedCwd: CWD,
    stdin: JSON.stringify(payload()),
    now: NOW,
  });

  assert.deepEqual(replay, first);
  assert.equal((await stat(prepared.capture_path)).mode & 0o777, 0o600);
  const serialized = await readFile(prepared.capture_path, "utf8");
  assert.equal(serialized.includes(SESSION), false);
  assert.equal(serialized.includes(RESULT), false);
  assert.equal(serialized.includes("last_assistant_message"), false);

  await assert.rejects(captureClaudeCharacterizationStopInput({
    campaignId: CAMPAIGN,
    capturePath: prepared.capture_path,
    hookReceiptPath: prepared.hook_receipt_path,
    expectedCwd: CWD,
    stdin: JSON.stringify(payload({ session_id: "different-session" })),
    now: NOW,
  }), { code: "E_CLAUDE_CHARACTERIZATION_HOOK_RECEIPT_CONFLICT" });
});

test("hook診断receiptはinvalid resultをStop未発火へ丸めずrawを保存しない", async () => {
  const root = await workRoot();
  const prepared = await prepareClaudeCharacterization({
    workRoot: root,
    hookExecutable: HOOK,
    expectedCwd: CWD,
    campaignId: CAMPAIGN,
  });
  const invalidResult = "not canonical observer output";
  const receipt = await captureClaudeCharacterizationStopInput({
    campaignId: CAMPAIGN,
    capturePath: prepared.capture_path,
    hookReceiptPath: prepared.hook_receipt_path,
    expectedCwd: CWD,
    stdin: JSON.stringify(payload({ last_assistant_message: invalidResult })),
    now: NOW,
  });

  assert.equal(receipt.hook_invocation, "confirmed");
  assert.equal(receipt.stop_payload, "confirmed");
  assert.equal(receipt.result_capture, "blocked");
  assert.equal(receipt.failure_code, "E_CLAUDE_CHARACTERIZATION_RESULT_INVALID");
  assert.equal((await stat(prepared.hook_receipt_path)).mode & 0o777, 0o600);
  const serialized = await readFile(prepared.hook_receipt_path, "utf8");
  for (const raw of [SESSION, invalidResult, CWD]) assert.equal(serialized.includes(raw), false);
  await assert.rejects(stat(prepared.capture_path), { code: "ENOENT" });

  const verified = await verifyClaudeCharacterization({
    campaignId: CAMPAIGN,
    capturePath: prepared.capture_path,
    hookReceiptPath: prepared.hook_receipt_path,
    agentsStdout: agents(),
    expected: { jobId: JOB, name: NAME, cwd: CWD },
    replySurface: "unsupported",
  });
  assert.equal(verified.status, "blocked");
  assert.equal(verified.schema, "observer.claude_characterization_verification.v2");
  assert.equal(verified.hook_invocation, "confirmed");
  assert.equal(verified.job_session_correlation, "confirmed");
  assert.equal(verified.stop_capture, "confirmed");
  assert.equal(verified.result_capture, "blocked");
  assert.equal(verified.result_digest, null);
});

test("hook診断receiptはinvalid UTF-8とJSONをbounded failureへ分類する", async () => {
  for (const [input, failureCode] of [
    [Buffer.from([0xff]), "E_CLAUDE_CHARACTERIZATION_STOP_UTF8_INVALID"],
    [Buffer.from("{"), "E_CLAUDE_CHARACTERIZATION_STOP_JSON_INVALID"],
  ]) {
    const root = await workRoot();
    const prepared = await prepareClaudeCharacterization({
      workRoot: root,
      hookExecutable: HOOK,
      expectedCwd: CWD,
      campaignId: CAMPAIGN,
    });
    const receipt = await captureClaudeCharacterizationStopInput({
      campaignId: CAMPAIGN,
      capturePath: prepared.capture_path,
      hookReceiptPath: prepared.hook_receipt_path,
      expectedCwd: CWD,
      stdin: input,
      now: NOW,
    });
    assert.equal(receipt.hook_invocation, "confirmed");
    assert.equal(receipt.stop_payload, "blocked");
    assert.equal(receipt.failure_code, failureCode);
    await cleanupClaudeCharacterization({ workRoot: root, campaignId: CAMPAIGN });
  }

  const root = await workRoot();
  const prepared = await prepareClaudeCharacterization({
    workRoot: root,
    hookExecutable: HOOK,
    expectedCwd: CWD,
    campaignId: CAMPAIGN,
  });
  const limited = await captureClaudeCharacterizationStopInput({
    campaignId: CAMPAIGN,
    capturePath: prepared.capture_path,
    hookReceiptPath: prepared.hook_receipt_path,
    expectedCwd: CWD,
    stdin: null,
    stdinFailureCode: "E_CLAUDE_CHARACTERIZATION_STOP_STDIN_LIMIT",
    now: NOW,
  });
  assert.equal(limited.failure_code, "E_CLAUDE_CHARACTERIZATION_STOP_STDIN_LIMIT");
  await cleanupClaudeCharacterization({ workRoot: root, campaignId: CAMPAIGN });
});

test("verifyはagent sessionとStop digest、公開terminal resultをexact照合する", async () => {
  const root = await workRoot();
  const prepared = await prepareClaudeCharacterization({
    workRoot: root,
    hookExecutable: HOOK,
    expectedCwd: CWD,
    campaignId: CAMPAIGN,
  });
  await captureClaudeCharacterizationStopInput({
    campaignId: CAMPAIGN,
    capturePath: prepared.capture_path,
    hookReceiptPath: prepared.hook_receipt_path,
    expectedCwd: CWD,
    stdin: JSON.stringify(payload()),
    now: NOW,
  });
  const verified = await verifyClaudeCharacterization({
    campaignId: CAMPAIGN,
    capturePath: prepared.capture_path,
    hookReceiptPath: prepared.hook_receipt_path,
    agentsStdout: agents(),
    expected: { jobId: JOB, name: NAME, cwd: CWD },
    replySurface: "unsupported",
    terminalResult: RESULT,
  });

  assert.deepEqual({
    reply_surface: verified.reply_surface,
    job_session_correlation: verified.job_session_correlation,
    hook_invocation: verified.hook_invocation,
    stop_capture: verified.stop_capture,
    result_capture: verified.result_capture,
    terminal_exact_result: verified.terminal_exact_result,
    cleanup: verified.cleanup,
  }, {
    reply_surface: "unsupported",
    job_session_correlation: "confirmed",
    hook_invocation: "confirmed",
    stop_capture: "confirmed",
    result_capture: "confirmed",
    terminal_exact_result: "confirmed",
    cleanup: "pending",
  });
  const serialized = JSON.stringify(verified);
  for (const raw of [JOB, SESSION, RESULT, "must-not-persist"]) assert.equal(serialized.includes(raw), false);

  await assert.rejects(verifyClaudeCharacterization({
    campaignId: CAMPAIGN,
    capturePath: prepared.capture_path,
    hookReceiptPath: prepared.hook_receipt_path,
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
    "--hook-receipt-path", prepared.hook_receipt_path,
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
    "--hook-receipt-path", prepared.hook_receipt_path,
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

test("公開CLI hookはmalformed JSONでも成功終了してsanitized診断receiptを残す", async () => {
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
    "--hook-receipt-path", prepared.hook_receipt_path,
    "--expected-cwd", CWD,
  ], "{");
  assert.equal(hook.status, 0, hook.stderr);
  assert.equal(hook.stdout, "");
  const receipt = JSON.parse(await readFile(prepared.hook_receipt_path, "utf8"));
  assert.equal(receipt.schema, "observer.claude_characterization_hook_receipt.v1");
  assert.equal(receipt.hook_invocation, "confirmed");
  assert.equal(receipt.failure_code, "E_CLAUDE_CHARACTERIZATION_STOP_JSON_INVALID");
  await assert.rejects(stat(prepared.capture_path), { code: "ENOENT" });

  const cleanup = runCli([
    "cleanup",
    "--work-root", root,
    "--campaign-id", CAMPAIGN,
  ]);
  assert.equal(cleanup.status, 0, cleanup.stderr);
  assert.equal(JSON.parse(cleanup.stdout).schema, "observer.claude_characterization_cleanup.v2");
});
