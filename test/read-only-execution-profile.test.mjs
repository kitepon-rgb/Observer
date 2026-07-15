import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile as execFileCallback } from "node:child_process";
import test from "node:test";

import { buildClaudeBackgroundInvocation } from "../src/claude-host-adapter.mjs";
import { buildCodexThreadStartParams, buildCodexTurnStartParams } from "../src/codex-host-adapter.mjs";
import { applyCycleOutput } from "../src/cycle-application.mjs";
import { buildCycleInput } from "../src/cycle-input.mjs";
import { buildEvidenceSnapshot } from "../src/evidence-snapshot.mjs";
import { ensureMailbox, operationMessageId } from "../src/mailbox-store.mjs";
import {
  acceptModelOperation, completeModelOperation, dispatchModelOperation, prepareModelOperation,
  readModelOperation, reserveModelOperation,
} from "../src/model-operation-store.mjs";

const execFile = promisify(execFileCallback);
const TARGET_ID = `p_${"a".repeat(64)}`;
const WATCH_ID = "w_11111111-1111-4111-8111-111111111111";
const GENERATION_ID = `sha256:${"b".repeat(64)}`;
const CYCLE_ID = `c_${"c".repeat(64)}`;
const NOW = new Date("2099-07-16T00:00:00.000Z");
const RUNTIME_ROOT = "/observer/runtime";

function request(provider, projectRoot) {
  const common = {
    schema: "observer.parent_launch_request.v1", provider, target_id: TARGET_ID, watch_id: WATCH_ID,
    project_root: projectRoot, runtime_root: RUNTIME_ROOT, required_handle_kind: provider === "claude" ? "claude.job" : "codex.thread",
    child_start: { schema: "observer.child_start.v1", mode: "observe", provider, target_id: TARGET_ID, watch_id: WATCH_ID, project_root: projectRoot, runtime_root: RUNTIME_ROOT },
  };
  return provider === "claude"
    ? { ...common, host: { kind: "claude.background_agent.v1", agent: "observer", name: "observer-aaaaaaaaaaaa-11111111-1111-4111-8111-111111111111", cwd: RUNTIME_ROOT } }
    : { ...common, host: { kind: "codex.app_server_thread.v1", cwd: RUNTIME_ROOT, approval_policy: "never", sandbox: "read-only", ephemeral: false, service_name: "observer" } };
}

async function git(cwd, args) { return execFile("git", args, { cwd, encoding: "utf8" }); }

async function fingerprint(projectRoot, run = git) {
  const invoke = async (args) => {
    try { return (await run(projectRoot, args)).stdout; }
    catch (error) { throw new Error(`fingerprint git command failed: ${args.join(" ")}`, { cause: error }); }
  };
  const [head, index, status, paths] = await Promise.all([
    invoke(["rev-parse", "HEAD"]), invoke(["ls-files", "-s"]), invoke(["status", "--porcelain=v1", "--untracked-files=all"]),
    invoke(["ls-files", "--cached", "--others", "--exclude-standard"]),
  ]);
  const entries = await Promise.all(paths.trim().split("\n").filter(Boolean).sort().map(async (path) => {
    const absolute = join(projectRoot, path); const info = await stat(absolute);
    return { path, mode: info.mode & 0o777, content: createHash("sha256").update(await readFile(absolute)).digest("hex") };
  }));
  return JSON.stringify({ head: head.trim(), index, status, entries });
}

async function projectFixture() {
  const projectRoot = await mkdtemp(join(tmpdir(), "observer-read-only-project-"));
  await git(projectRoot, ["init", "-q"]); await git(projectRoot, ["config", "user.email", "fixture@example.invalid"]); await git(projectRoot, ["config", "user.name", "Fixture"]);
  await writeFile(join(projectRoot, "tracked.txt"), "tracked\n"); await writeFile(join(projectRoot, "staged.txt"), "staged\n");
  await git(projectRoot, ["add", "tracked.txt", "staged.txt"]); await git(projectRoot, ["commit", "-qm", "fixture"]);
  await writeFile(join(projectRoot, "staged.txt"), "staged next\n"); await git(projectRoot, ["add", "staged.txt"]);
  await writeFile(join(projectRoot, "untracked.sh"), "#!/bin/sh\necho fixture\n"); await chmod(join(projectRoot, "untracked.sh"), 0o755);
  return projectRoot;
}

test("Claude/Codex read-only envelopeはruntime rootとempty AI tool surfaceを同一fixtureで固定する", () => {
  const projectRoot = "/monitored/project";
  const claudeRequest = request("claude", projectRoot);
  const claude = buildClaudeBackgroundInvocation({
    request: claudeRequest, claudeCommand: "/usr/local/bin/claude",
    mcpConfig: { mcpServers: { observer: { command: `${RUNTIME_ROOT}/bin/observer-mcp.mjs`, args: ["--stdio"] } } }, observerTools: [],
  });
  assert.equal(claudeRequest.host.cwd, RUNTIME_ROOT);
  assert.deepEqual(claude.args.slice(7, 11), ["--setting-sources", "", "--disable-slash-commands", "--no-chrome"]);
  assert.equal(claude.args.includes("--strict-mcp-config"), true);
  assert.equal(claude.args[claude.args.indexOf("--tools") + 1], "");
  assert.equal(claude.args[claude.args.indexOf("--allowedTools") + 1], "");
  const codexRequest = request("codex", projectRoot);
  assert.deepEqual(buildCodexThreadStartParams(codexRequest), {
    cwd: RUNTIME_ROOT, approvalPolicy: "never", sandbox: "read-only", ephemeral: false, serviceName: "observer",
    developerInstructions: "Observer rootのAGENTS.mdを静的契約とし、turn inputのobserver.child_start.v1をexact検証してください。",
  });
  const turn = buildCodexTurnStartParams({ request: codexRequest, threadId: "019f62a1-1111-7111-8111-111111111111" });
  assert.equal(turn.cwd, RUNTIME_ROOT); assert.equal(turn.approvalPolicy, "never");
  assert.deepEqual(turn.sandboxPolicy, { type: "readOnly", networkAccess: false });
});

test("外部Supervisor所有のdurable cycle applicationはprojectを変えずstate root Mailboxへpublishする", async () => {
  const projectRoot = await projectFixture(); const before = await fingerprint(projectRoot);
  const stateRoot = await mkdtemp(join(tmpdir(), "observer-read-only-state-")); const targetRoot = join(stateRoot, "watches", TARGET_ID);
  await mkdir(targetRoot, { recursive: true, mode: 0o700 }); await chmod(stateRoot, 0o700); await chmod(join(stateRoot, "watches"), 0o700); await chmod(targetRoot, 0o700);
  const cycleInput = buildCycleInput(buildEvidenceSnapshot({
    context: { after_cursor_sha256: "1".repeat(64), cycle_id: CYCLE_ID, parent_host: "codex", parent_thread_sha256: "2".repeat(64), target_id: TARGET_ID, through_cursor_sha256: "3".repeat(64), watch_id: WATCH_ID },
    turns: [],
    plan: [],
    git: [],
    tests: [{
      ref: "test:readonly",
      source_digest: `sha256:${"4".repeat(64)}`,
      available: true,
      command_ref: "git status --porcelain=v1",
      outcome: "passed",
      observed_at: NOW.toISOString(),
      unavailable_code: null,
    }],
  }));
  const identity = { stateRoot, targetId: TARGET_ID, watchId: WATCH_ID, generationId: GENERATION_ID, cycleId: CYCLE_ID, inputDigest: cycleInput.input_digest, modelVisibleBytes: cycleInput.model_visible_bytes, provider: "codex" };
  const clock = { now: () => NOW };
  const prepared = await prepareModelOperation(identity, clock);
  await reserveModelOperation(identity, { ...clock, readGenerationState: async () => ({ provider: "codex", watch_id: WATCH_ID, generation_id: GENERATION_ID, status: "active", pending_reservation: null }), reserveGenerationInput: async () => ({ outcome: "reserved" }) });
  await dispatchModelOperation({ stateRoot, targetId: TARGET_ID, operationId: prepared.operation_id }, clock);
  await acceptModelOperation({ stateRoot, targetId: TARGET_ID, operationId: prepared.operation_id, providerOperationReceiptDigest: `sha256:${"d".repeat(64)}` }, clock);
  const output = { schema: "observer.ai_output.v1", outcome: "advisory", proposal: { title: "観測結果", body: "外部Supervisorが配送します。", category: "stagnation", severity: "info", dedupe_key: "readonly:fixture", evidence_refs: ["test:readonly"], suggested_action: "確認する" } };
  await completeModelOperation({ stateRoot, targetId: TARGET_ID, operationId: prepared.operation_id, rawOutput: JSON.stringify(output) }, clock);
  const durable = await readModelOperation({ stateRoot, targetId: TARGET_ID });
  const operation = { schema: "observer.model_operation_receipt.v1", action: "recover_only", provider: durable.provider, operation_id: durable.operation_id, target_id: durable.target_id, watch_id: durable.watch_id, generation_id: durable.generation_id, cycle_id: durable.cycle_id, input_digest: durable.input_digest, model_visible_bytes: durable.model_visible_bytes, status: durable.status, provider_operation_receipt_digest: durable.provider_operation_receipt_digest };
  const application = await applyCycleOutput({ stateRoot, operation, output, cycleInput, now: NOW });
  assert.equal(await fingerprint(projectRoot), before);
  const mailbox = await ensureMailbox(stateRoot, TARGET_ID);
  const messageId = operationMessageId(operation.operation_id);
  assert.equal(mailbox.root, join(stateRoot, "mailboxes", TARGET_ID));
  assert.deepEqual(await readdir(mailbox.inbox), [`${messageId}.json`]);
  assert.deepEqual(await readdir(mailbox["publish-receipts"]), [`${messageId}.json`]);
  const message = JSON.parse(await readFile(join(mailbox.inbox, `${messageId}.json`), "utf8"));
  const receipt = JSON.parse(await readFile(join(mailbox["publish-receipts"], `${messageId}.json`), "utf8"));
  assert.equal(message.message_id, messageId);
  assert.equal(message.target.project_target_id, TARGET_ID);
  assert.equal(message.body, output.proposal.body);
  assert.equal(message.content_digest, `sha256:${application.result_digest}`);
  assert.deepEqual({
    schema: receipt.schema,
    operation_id: receipt.operation_id,
    message_id: receipt.message_id,
    target_id: receipt.target_id,
    content_digest: receipt.content_digest,
    status: receipt.status,
  }, {
    schema: "observer.mailbox_publish_receipt.v1",
    operation_id: operation.operation_id,
    message_id: messageId,
    target_id: TARGET_ID,
    content_digest: message.content_digest,
    status: "published",
  });
});

test("fingerprint command failureを成功扱いしない", async () => {
  const projectRoot = await projectFixture();
  await assert.rejects(fingerprint(projectRoot, async () => { throw new Error("git unavailable"); }), /fingerprint git command failed/);
});
