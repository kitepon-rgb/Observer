import assert from "node:assert/strict";
import { spawn as spawnChild } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import test from "node:test";

import { createThroughlineClient } from "../src/throughline-client.mjs";

const THROUGHLINE_BIN = process.env.OBSERVER_THROUGHLINE_BIN;

if (typeof THROUGHLINE_BIN !== "string" || !isAbsolute(THROUGHLINE_BIN)) {
  throw new Error("OBSERVER_THROUGHLINE_BIN must be an absolute Throughline CLI path");
}

function event(type, message, timestamp) {
  return { type: "event_msg", timestamp, payload: { type, ...(message === undefined ? {} : { message }) } };
}

function completedTurn(index) {
  const minute = String(index).padStart(2, "0");
  return [
    event("user_message", `request ${index}`, `2026-07-15T00:${minute}:01.000Z`),
    event("task_started", undefined, `2026-07-15T00:${minute}:02.000Z`),
    event("agent_message", `answer ${index}`, `2026-07-15T00:${minute}:03.000Z`),
    event("task_complete", undefined, `2026-07-15T00:${minute}:04.000Z`),
  ];
}

async function writeRollout(codexHome, project, id, events) {
  const directory = join(codexHome, "sessions", "2026", "07", "15");
  await mkdir(directory, { recursive: true });
  const path = join(directory, `rollout-2026-07-15T00-00-00-${id}.jsonl`);
  const rows = [{ type: "session_meta", timestamp: "2026-07-15T00:00:00.000Z", payload: { id, cwd: project } }, ...events];
  await writeFile(path, `${rows.map(JSON.stringify).join("\n")}\n`);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function runProcessTurn({ env, project, sessionId, transcriptPath }) {
  return new Promise((resolve, reject) => {
    const child = spawnChild(THROUGHLINE_BIN, ["process-turn"], {
      cwd: project,
      env: { ...process.env, ...env, THROUGHLINE_NO_VSCODE: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0 && signal === null) resolve();
      else reject(new Error(`throughline process-turn failed: code=${code} signal=${signal} stderr=${stderr}`));
    });
    child.stdin.end(JSON.stringify({ session_id: sessionId, cwd: project, transcript_path: transcriptPath }));
  });
}

test("実Throughline CLIはcompleted-only cursor、wait、projection pendingをObserver client経由で守る", async () => {
  const root = await mkdtemp(join(tmpdir(), "observer-throughline-black-box-"));
  const project = join(root, "project");
  const home = join(root, "home");
  const state = join(root, "state");
  const codexHome = join(root, "codex");
  const isolatedEnv = { HOME: home, USERPROFILE: home, XDG_STATE_HOME: state, CODEX_HOME: codexHome };
  const spawnCalls = [];
  const client = createThroughlineClient({
    command: THROUGHLINE_BIN,
    spawn(command, args, options) {
      spawnCalls.push({ command, args, options });
      return spawnChild(command, args, { ...options, env: { ...process.env, ...isolatedEnv } });
    },
  });
  const id = "019dfaba-f87e-7f41-a144-d5ca7c6dd7f9";

  try {
    await Promise.all([mkdir(project), mkdir(home), mkdir(state), mkdir(codexHome)]);

    const initial = await client.read({ projectPath: project });
    assert.equal(initial.status, "snapshot");
    assert.equal(initial.host, null);
    assert.equal(initial.throughCursor.startsWith("tlc1."), true);

    const waitingForFirst = client.wait({ projectPath: project, afterCursor: initial.throughCursor, timeoutSeconds: 2 });
    await sleep(300);
    await writeRollout(codexHome, project, id, completedTurn(1));
    const firstChange = await waitingForFirst;
    assert.equal(firstChange.status, "changed");
    assert.notEqual(firstChange.throughCursor, initial.throughCursor);

    const timeout = await client.wait({ projectPath: project, afterCursor: firstChange.throughCursor, timeoutSeconds: 1 });
    assert.equal(timeout.status, "timeout");
    assert.equal(timeout.throughCursor, firstChange.throughCursor);

    await writeRollout(codexHome, project, id, [...completedTurn(1), ...completedTurn(2)]);
    const missedWakeup = await client.wait({ projectPath: project, afterCursor: firstChange.throughCursor, timeoutSeconds: 1 });
    assert.equal(missedWakeup.status, "changed");
    assert.notEqual(missedWakeup.throughCursor, firstChange.throughCursor);

    const pendingProjection = await client.read({
      projectPath: project, afterCursor: firstChange.throughCursor, throughCursor: missedWakeup.throughCursor,
    });
    assert.equal(pendingProjection.status, "projection_pending");
    assert.deepEqual(pendingProjection.turns, []);
    assert.equal(pendingProjection.throughCursor, null);
    assert.deepEqual(pendingProjection.page, { complete: false, nextToken: null });

    assert.deepEqual(spawnCalls.map(({ command, args, options }) => ({ command, args, options })), [
      { command: THROUGHLINE_BIN, args: ["observer-read", "--project", project, "--json"], options: { shell: false, stdio: ["ignore", "pipe", "pipe"] } },
      { command: THROUGHLINE_BIN, args: ["observer-wait", "--project", project, "--after-cursor", initial.throughCursor, "--timeout-seconds", "2", "--json"], options: { shell: false, stdio: ["ignore", "pipe", "pipe"] } },
      { command: THROUGHLINE_BIN, args: ["observer-wait", "--project", project, "--after-cursor", firstChange.throughCursor, "--timeout-seconds", "1", "--json"], options: { shell: false, stdio: ["ignore", "pipe", "pipe"] } },
      { command: THROUGHLINE_BIN, args: ["observer-wait", "--project", project, "--after-cursor", firstChange.throughCursor, "--timeout-seconds", "1", "--json"], options: { shell: false, stdio: ["ignore", "pipe", "pipe"] } },
      { command: THROUGHLINE_BIN, args: ["observer-read", "--project", project, "--after-cursor", firstChange.throughCursor, "--through-cursor", missedWakeup.throughCursor, "--json"], options: { shell: false, stdio: ["ignore", "pipe", "pipe"] } },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("実Throughline CLIはClaude process-turnとCodex task_completeを65秒超の並列waitで検知する", async () => {
  const root = await mkdtemp(join(tmpdir(), "observer-throughline-dual-host-"));
  const claudeProject = join(root, "claude-project");
  const codexProject = join(root, "codex-project");
  const home = join(root, "home");
  const state = join(root, "state");
  const codexHome = join(root, "codex");
  const isolatedEnv = { HOME: home, USERPROFILE: home, XDG_STATE_HOME: state, CODEX_HOME: codexHome };
  const claudeSpawnCalls = [];
  const codexSpawnCalls = [];
  const makeClient = (spawnCalls) => createThroughlineClient({
    command: THROUGHLINE_BIN,
    spawn(command, args, options) {
      spawnCalls.push({ command, args, options });
      return spawnChild(command, args, { ...options, env: { ...process.env, ...isolatedEnv } });
    },
  });
  const claudeClient = makeClient(claudeSpawnCalls);
  const codexClient = makeClient(codexSpawnCalls);
  const transcriptPath = join(claudeProject, "transcript.jsonl");
  const codexThreadId = "019dfaba-f87e-7f41-a144-d5ca7c6dd7fa";

  try {
    await Promise.all([mkdir(claudeProject), mkdir(codexProject), mkdir(home), mkdir(state), mkdir(codexHome)]);
    await writeFile(transcriptPath, [
      { type: "user", message: { role: "user", content: [{ type: "text", text: "Claude fixture request" }] } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Claude fixture answer" }] } },
    ].map(JSON.stringify).join("\n"));

    const [claudeInitial, codexInitial] = await Promise.all([
      claudeClient.read({ projectPath: claudeProject }),
      codexClient.read({ projectPath: codexProject }),
    ]);
    assert.equal(claudeInitial.status, "snapshot");
    assert.equal(codexInitial.status, "snapshot");

    const startedAt = Date.now();
    const claudeWaiting = claudeClient.wait({ projectPath: claudeProject, afterCursor: claudeInitial.throughCursor, timeoutSeconds: 3600 });
    const codexWaiting = codexClient.wait({ projectPath: codexProject, afterCursor: codexInitial.throughCursor, timeoutSeconds: 3600 });
    await sleep(65_100);
    assert.ok(Date.now() - startedAt > 65_000, "両hostのfixture投入前に65秒超待機する");

    await Promise.all([
      runProcessTurn({ env: isolatedEnv, project: claudeProject, sessionId: "claude-fixture-session", transcriptPath }),
      writeRollout(codexHome, codexProject, codexThreadId, completedTurn(1)),
    ]);
    const [claudeChanged, codexChanged] = await Promise.all([claudeWaiting, codexWaiting]);
    assert.equal(claudeChanged.status, "changed");
    assert.equal(codexChanged.status, "changed");

    assert.deepEqual(claudeSpawnCalls.at(-1), {
      command: THROUGHLINE_BIN,
      args: ["observer-wait", "--project", claudeProject, "--after-cursor", claudeInitial.throughCursor, "--timeout-seconds", "3600", "--json"],
      options: { shell: false, stdio: ["ignore", "pipe", "pipe"] },
    });
    assert.deepEqual(codexSpawnCalls.at(-1), {
      command: THROUGHLINE_BIN,
      args: ["observer-wait", "--project", codexProject, "--after-cursor", codexInitial.throughCursor, "--timeout-seconds", "3600", "--json"],
      options: { shell: false, stdio: ["ignore", "pipe", "pipe"] },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
