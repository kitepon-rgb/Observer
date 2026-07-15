import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { cleanupOperationPublishReceipt, ensureMailbox, operationMessageId, publishMessage, publishOperationMessage } from "../src/mailbox-store.mjs";
import { sealMessage } from "../src/message-schema.mjs";
import { ObserverError } from "../src/observer-error.mjs";
import { acceptModelOperation, applyModelOperation, completeModelOperation, dispatchModelOperation, prepareModelOperation, reserveModelOperation } from "../src/model-operation-store.mjs";
import { acquirePrivateLock, atomicCreatePrivateFile } from "../src/private-state.mjs";

const OPERATION_ID = `sha256:${"c".repeat(64)}`;

const NOW = new Date("2099-07-14T12:00:00Z");
const TARGET_ID = "p_" + "a".repeat(64);
const THREAD_SHA256 = "1".repeat(64);

function messageContent(overrides = {}) {
  return {
    schema_version: 1,
    message_id: "obs-20260714-0001",
    producer: { producer_id: "observer", kind: "observer" },
    target: { project_target_id: TARGET_ID, thread_sha256: THREAD_SHA256 },
    created_at: "2099-07-14T12:00:00Z",
    expires_at: "2099-07-15T12:00:00Z",
    severity: "warning",
    category: "stagnation",
    dedupe_key: "stagnation:failure-abc",
    title: "同一失敗経路を反復しています",
    body: "同一failure fingerprintを4回観測しました。",
    evidence_refs: ["test:fingerprint-abc"],
    suggested_action: "前提を独立に再検査する",
    ...overrides,
  };
}

async function stateRoot() {
  const parent = await mkdtemp(join(tmpdir(), "observer-mailbox-"));
  return join(parent, "state");
}

test("sealed messageをproject別inboxへ完全な0600 fileとしてpublishする", async () => {
  const root = await stateRoot();
  const message = sealMessage(messageContent());
  const published = await publishMessage({ stateRoot: root, message, now: NOW });

  assert.equal(published.messageId, message.message_id);
  assert.deepEqual(JSON.parse(await readFile(published.path, "utf8")), message);
  assert.equal((await lstat(published.path)).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(join(root, "mailboxes", TARGET_ID, "inbox"))).filter((name) => name.endsWith(".tmp")), []);
});

test("同じmessage IDを再利用しない", async () => {
  const root = await stateRoot();
  const message = sealMessage(messageContent());
  await publishMessage({ stateRoot: root, message, now: NOW });
  await assert.rejects(
    publishMessage({ stateRoot: root, message, now: NOW }),
    (error) => error instanceof ObserverError && error.code === "E_MESSAGE_ID_DUPLICATE",
  );
});

test("publishはconsumer lock中へ割り込まずfail closedにする", async () => {
  const root = await stateRoot();
  const paths = await ensureMailbox(root, TARGET_ID);
  const release = await acquirePrivateLock(join(paths.root, "consumer.lock"));
  await assert.rejects(
    publishMessage({ stateRoot: root, message: sealMessage(messageContent()), now: NOW }),
    (error) => error instanceof ObserverError && error.code === "E_CONSUMER_LOCKED",
  );
  await release();
  const published = await publishMessage({ stateRoot: root, message: sealMessage(messageContent()), now: NOW });
  assert.equal(published.messageId, "obs-20260714-0001");
});

test("digest不一致、期限切れ、secretらしき本文を拒否する", async () => {
  const root = await stateRoot();
  const digestMismatch = sealMessage(messageContent());
  digestMismatch.body = "改ざん";
  await assert.rejects(
    publishMessage({ stateRoot: root, message: digestMismatch, now: NOW }),
    (error) => error instanceof ObserverError && error.code === "E_MESSAGE_DIGEST_MISMATCH",
  );

  assert.throws(
    () => sealMessage(messageContent({ created_at: "2026-07-13T12:00:00Z", expires_at: "2026-07-14T11:59:59Z" })),
    (error) => error instanceof ObserverError && error.code === "E_MESSAGE_EXPIRED",
  );

  assert.throws(
    () => sealMessage(messageContent({ body: "-----BEGIN PRIVATE KEY-----" })),
    (error) => error instanceof ObserverError && error.code === "E_MESSAGE_SENSITIVE_CONTENT",
  );
});

function operationMessage(overrides = {}) {
  return sealMessage(messageContent({ message_id: operationMessageId(OPERATION_ID), ...overrides }));
}

async function durableAppliedOperation(stateRoot) {
  const watchId = "w_11111111-1111-4111-8111-111111111111";
  const input = {
    stateRoot, targetId: TARGET_ID, watchId, generationId: `sha256:${"b".repeat(64)}`,
    cycleId: `c_${"c".repeat(64)}`, inputDigest: `sha256:${"d".repeat(64)}`,
    modelVisibleBytes: 8, provider: "codex",
  };
  await mkdir(join(stateRoot, "watches", TARGET_ID), { recursive: true, mode: 0o700 });
  await chmod(join(stateRoot, "watches"), 0o700);
  await chmod(join(stateRoot, "watches", TARGET_ID), 0o700);
  const prepared = await prepareModelOperation(input, { now: () => NOW });
  const message = sealMessage(messageContent({ message_id: operationMessageId(prepared.operation_id) }));
  const dependencies = {
    now: () => NOW,
    readGenerationState: async () => ({ provider: "codex", watch_id: watchId, generation_id: input.generationId }),
    reserveGenerationInput: async () => ({ outcome: "reserved" }),
  };
  await reserveModelOperation(input, dependencies);
  await dispatchModelOperation({ stateRoot, targetId: TARGET_ID, operationId: prepared.operation_id }, { now: () => NOW });
  await acceptModelOperation({ stateRoot, targetId: TARGET_ID, operationId: prepared.operation_id, providerOperationReceiptDigest: `sha256:${"e".repeat(64)}` }, { now: () => NOW });
  await completeModelOperation({ stateRoot, targetId: TARGET_ID, operationId: prepared.operation_id, rawOutput: '{"schema":"observer.ai_output.v1","outcome":"no_advisory"}' }, { now: () => NOW });
  await applyModelOperation({ stateRoot, targetId: TARGET_ID, operationId: prepared.operation_id, appliedResult: { schema: "observer.cycle_result.v1", result_digest: message.content_digest.slice("sha256:".length) } }, { now: () => NOW });
  return { operationId: prepared.operation_id, message };
}

test("operation publishはpreparedから一度だけinboxへ公開し、同内容replayを回収する", async () => {
  const root = await stateRoot();
  const message = operationMessage();
  const first = await publishOperationMessage({ stateRoot: root, operationId: OPERATION_ID, message, now: NOW });
  const replay = await publishOperationMessage({ stateRoot: root, operationId: OPERATION_ID, message, now: NOW });
  assert.deepEqual(replay, first);
  const paths = await ensureMailbox(root, TARGET_ID);
  assert.deepEqual(await readdir(paths.inbox), [`${message.message_id}.json`]);
  const receipt = JSON.parse(await readFile(join(paths["publish-receipts"], `${message.message_id}.json`), "utf8"));
  assert.equal(receipt.status, "published");
  assert.equal(JSON.stringify(receipt).includes(message.body), false);
  await assert.rejects(
    publishOperationMessage({ stateRoot: root, operationId: OPERATION_ID, message: operationMessage({ body: "異なる内容" }), now: NOW }),
    (error) => error instanceof ObserverError && error.code === "E_OPERATION_PUBLISH_CONFLICT",
  );
});

test("prepared operation publishはprocessingとconsumer receiptのexact digestから回収する", async () => {
  const root = await stateRoot();
  const message = operationMessage();
  const paths = await ensureMailbox(root, TARGET_ID);
  const prepared = {
    schema: "observer.mailbox_publish_receipt.v1", operation_id: OPERATION_ID, message_id: message.message_id,
    target_id: TARGET_ID, content_digest: message.content_digest, status: "prepared",
    created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
  };
  await atomicCreatePrivateFile(join(paths["publish-receipts"], `${message.message_id}.json`), `${JSON.stringify(prepared)}\n`);
  await atomicCreatePrivateFile(join(paths.processing, `${message.message_id}.json`), `${JSON.stringify(message)}\n`);
  const recovered = await publishOperationMessage({ stateRoot: root, operationId: OPERATION_ID, message, now: NOW });
  assert.equal(recovered.status, "published");
  assert.deepEqual(await readdir(paths.inbox), []);

  const receiptOnlyRoot = await stateRoot();
  const receiptOnlyPaths = await ensureMailbox(receiptOnlyRoot, TARGET_ID);
  await atomicCreatePrivateFile(join(receiptOnlyPaths["publish-receipts"], `${message.message_id}.json`), `${JSON.stringify(prepared)}\n`);
  await atomicCreatePrivateFile(join(receiptOnlyPaths.receipts, `${message.message_id}.json`), `${JSON.stringify({
    schema: "observer.mailbox_receipt.v1", message_id: message.message_id, content_digest: message.content_digest,
    target_project_id: TARGET_ID, target_thread_sha256: THREAD_SHA256, producer_id: "観測者",
    claimed_at: NOW.toISOString(), finished_at: NOW.toISOString(), result: "emitted_unacked", hook_event_id: "stop-replay", body_retained: false,
  })}\n`);
  const receiptRecovered = await publishOperationMessage({ stateRoot: receiptOnlyRoot, operationId: OPERATION_ID, message, now: NOW });
  assert.equal(receiptRecovered.status, "published");
  assert.deepEqual(await readdir(receiptOnlyPaths.inbox), []);

  const incompleteRoot = await stateRoot();
  const incompletePaths = await ensureMailbox(incompleteRoot, TARGET_ID);
  await atomicCreatePrivateFile(join(incompletePaths["publish-receipts"], `${message.message_id}.json`), `${JSON.stringify(prepared)}\n`);
  await atomicCreatePrivateFile(join(incompletePaths.receipts, `${message.message_id}.json`), `${JSON.stringify({
    schema: "observer.mailbox_receipt.v1", message_id: message.message_id, content_digest: message.content_digest,
    target_project_id: TARGET_ID,
  })}\n`);
  await assert.rejects(
    publishOperationMessage({ stateRoot: incompleteRoot, operationId: OPERATION_ID, message, now: NOW }),
    (error) => error instanceof ObserverError && error.code === "E_OPERATION_PUBLISH_CONFLICT",
  );
});

test("operation publish receipt cleanupはdurable applied journalとdigest一致を要求し、cleanup後replayを回収する", async () => {
  const root = await stateRoot();
  const message = operationMessage();
  await publishOperationMessage({ stateRoot: root, operationId: OPERATION_ID, message, now: NOW });
  await assert.rejects(
    cleanupOperationPublishReceipt({ stateRoot: root, targetId: TARGET_ID, operationId: OPERATION_ID, messageId: message.message_id, contentDigest: message.content_digest }),
    (error) => error instanceof ObserverError && error.code === "E_OPERATION_PUBLISH_NOT_APPLIED",
  );
  const { operationId: durableOperationId, message: durableMessage } = await durableAppliedOperation(root);
  await publishOperationMessage({ stateRoot: root, operationId: durableOperationId, message: durableMessage, now: NOW });
  const cleaned = await cleanupOperationPublishReceipt({
    stateRoot: root, targetId: TARGET_ID, operationId: durableOperationId, messageId: durableMessage.message_id, contentDigest: durableMessage.content_digest,
  });
  assert.equal(cleaned.cleaned, true);
  const replay = await cleanupOperationPublishReceipt({
    stateRoot: root, targetId: TARGET_ID, operationId: durableOperationId, messageId: durableMessage.message_id, contentDigest: durableMessage.content_digest,
  });
  assert.deepEqual(replay, { operationId: durableOperationId, messageId: durableMessage.message_id, targetId: TARGET_ID, contentDigest: durableMessage.content_digest, cleaned: false, replayed: true });
});
