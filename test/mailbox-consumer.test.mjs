import assert from "node:assert/strict";
import { access, mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  claimNextMessage,
  cleanupReceipts,
  finishClaim,
  inspectConsumerLock,
  recoverClaimAsDeliveryUnknown,
  recoverConsumerLock,
} from "../src/mailbox-consumer.mjs";
import { ensureMailbox, operationMessageId, publishMessage } from "../src/mailbox-store.mjs";
import { sealMessage } from "../src/message-schema.mjs";
import { acquirePrivateLock, atomicCreatePrivateFile, removePrivateFile } from "../src/private-state.mjs";

const NOW = new Date("2099-07-14T12:00:00Z");
const TARGET_ID = "p_" + "b".repeat(64);
const CURRENT_THREAD = "1".repeat(64);
const OLD_THREAD = "2".repeat(64);
const OPERATION_ID = `sha256:${"d".repeat(64)}`;

async function stateRoot() {
  const parent = await mkdtemp(join(tmpdir(), "observer-consume-"));
  return join(parent, "state");
}

function message(messageId, threadSha256 = CURRENT_THREAD, producerId = "observer") {
  return sealMessage({
    schema_version: 1,
    message_id: messageId,
    producer: { producer_id: producerId, kind: "observer" },
    target: { project_target_id: TARGET_ID, thread_sha256: threadSha256 },
    created_at: "2099-07-14T12:00:00Z",
    expires_at: "2099-07-15T12:00:00Z",
    severity: "review_required",
    category: "verification_gap",
    dedupe_key: `verification:${messageId}`,
    title: "検証証拠がありません",
    body: "完了主張に対応するtest evidenceが確認できません。",
    evidence_refs: ["turn:claim-001"],
    suggested_action: "次の変更前に受入testを確認する",
  });
}

test("対象threadの手紙だけをclaimし、finish後は本文なしreceiptだけ残す", async () => {
  const root = await stateRoot();
  await publishMessage({ stateRoot: root, message: message("obs-old", OLD_THREAD), now: NOW });
  await publishMessage({ stateRoot: root, message: message("obs-current"), now: NOW });

  const claimed = await claimNextMessage({
    stateRoot: root,
    targetId: TARGET_ID,
    threadSha256: CURRENT_THREAD,
    hookEventId: "stop-001",
    now: NOW,
  });
  assert.equal(claimed.message.message_id, "obs-current");
  assert.deepEqual(await readdir(join(root, "mailboxes", TARGET_ID, "inbox")), ["obs-old.json"]);

  const receipt = await finishClaim({ claim: claimed.claim, stateRoot: root, result: "emitted_unacked", now: new Date("2099-07-14T12:00:01Z") });
  assert.equal(receipt.result, "emitted_unacked");
  assert.equal(receipt.body_retained, false);
  assert.equal(Object.hasOwn(receipt, "body"), false);
  await assert.rejects(access(claimed.processingPath), { code: "ENOENT" });
  const storedReceipt = JSON.parse(await readFile(claimed.receiptPath, "utf8"));
  assert.equal(JSON.stringify(storedReceipt).includes("完了主張"), false);
});

test("claim後はfinish前でも同じ本文を再claimしない", async () => {
  const root = await stateRoot();
  await publishMessage({ stateRoot: root, message: message("obs-unknown"), now: NOW });
  const first = await claimNextMessage({ stateRoot: root, targetId: TARGET_ID, threadSha256: CURRENT_THREAD, hookEventId: "stop-002", now: NOW });
  const second = await claimNextMessage({ stateRoot: root, targetId: TARGET_ID, threadSha256: CURRENT_THREAD, hookEventId: "stop-003", now: NOW });
  assert.equal(second, null);

  const receipt = await finishClaim({ claim: first.claim, stateRoot: root, result: "delivery_unknown", now: new Date("2099-07-14T12:00:02Z") });
  assert.equal(receipt.result, "delivery_unknown");
  assert.equal(receipt.body_retained, false);
});

test("malformed messageは注入せず本文を削除してinvalid receiptへ変える", async () => {
  const root = await stateRoot();
  const paths = await ensureMailbox(root, TARGET_ID);
  await atomicCreatePrivateFile(join(paths.inbox, "obs-malformed.json"), "{not-json}\n");

  const claimed = await claimNextMessage({ stateRoot: root, targetId: TARGET_ID, threadSha256: CURRENT_THREAD, hookEventId: "stop-004", now: NOW });
  assert.equal(claimed, null);
  await assert.rejects(access(join(paths.processing, "obs-malformed.json")), { code: "ENOENT" });
  const receipt = JSON.parse(await readFile(join(paths.receipts, "obs-malformed.json"), "utf8"));
  assert.equal(receipt.result, "invalid");
  assert.equal(receipt.body_retained, false);
  assert.equal(JSON.stringify(receipt).includes("not-json"), false);
});

test("claim後のcrash相当状態を明示recoveryし、本文を再配送しない", async () => {
  const root = await stateRoot();
  await publishMessage({ stateRoot: root, message: message("obs-crashed"), now: NOW });
  const first = await claimNextMessage({ stateRoot: root, targetId: TARGET_ID, threadSha256: CURRENT_THREAD, hookEventId: "stop-crashed", now: NOW });

  const recovered = await recoverClaimAsDeliveryUnknown({ stateRoot: root, targetId: TARGET_ID, messageId: first.claim.messageId, now: new Date("2026-07-14T12:00:03Z") });
  assert.equal(recovered.result, "delivery_unknown");
  assert.equal(recovered.body_retained, false);
  const next = await claimNextMessage({ stateRoot: root, targetId: TARGET_ID, threadSha256: CURRENT_THREAD, hookEventId: "stop-after-recovery", now: NOW });
  assert.equal(next, null);
});

test("同時consumerでも一つのmessageを高々一回だけclaimする", async () => {
  const root = await stateRoot();
  await publishMessage({ stateRoot: root, message: message("obs-concurrent"), now: NOW });
  const attempts = await Promise.allSettled([
    claimNextMessage({ stateRoot: root, targetId: TARGET_ID, threadSha256: CURRENT_THREAD, hookEventId: "stop-concurrent-a", now: NOW }),
    claimNextMessage({ stateRoot: root, targetId: TARGET_ID, threadSha256: CURRENT_THREAD, hookEventId: "stop-concurrent-b", now: NOW }),
  ]);
  const claimed = attempts.filter((entry) => entry.status === "fulfilled" && entry.value !== null);
  assert.equal(claimed.length, 1);
});

test("完了receiptを件数上限で削除するがclaimed receiptは残す", async () => {
  const root = await stateRoot();
  for (const [index, messageId] of ["obs-retain-old", "obs-retain-new"].entries()) {
    await publishMessage({ stateRoot: root, message: message(messageId), now: NOW });
    const claimed = await claimNextMessage({ stateRoot: root, targetId: TARGET_ID, threadSha256: CURRENT_THREAD, hookEventId: `stop-retain-${index}`, now: NOW });
    await finishClaim({ claim: claimed.claim, stateRoot: root, result: "emitted_unacked", now: new Date(NOW.getTime() + index * 1000) });
  }
  await publishMessage({ stateRoot: root, message: message("obs-still-claimed"), now: NOW });
  await claimNextMessage({ stateRoot: root, targetId: TARGET_ID, threadSha256: CURRENT_THREAD, hookEventId: "stop-still-claimed", now: NOW });

  const removed = await cleanupReceipts({ stateRoot: root, targetId: TARGET_ID, now: NOW, maxCount: 1, maxAgeMs: 24 * 60 * 60 * 1000 });
  assert.deepEqual(removed, ["obs-retain-old.json"]);
  const receiptNames = await readdir(join(root, "mailboxes", TARGET_ID, "receipts"));
  assert.deepEqual(receiptNames.sort(), ["obs-retain-new.json", "obs-still-claimed.json"]);
});

test("残留lockはnonce確認付きの明示操作だけで回復する", async () => {
  const root = await stateRoot();
  const paths = await ensureMailbox(root, TARGET_ID);
  await acquirePrivateLock(join(paths.root, "consumer.lock"));
  const observed = await inspectConsumerLock({ stateRoot: root, targetId: TARGET_ID });
  await assert.rejects(
    recoverConsumerLock({ stateRoot: root, targetId: TARGET_ID, expectedNonce: "wrong-nonce" }),
    { code: "E_LOCK_OWNERSHIP_MISMATCH" },
  );
  assert.equal(await recoverConsumerLock({ stateRoot: root, targetId: TARGET_ID, expectedNonce: observed.nonce }), true);
  assert.equal(await inspectConsumerLock({ stateRoot: root, targetId: TARGET_ID }), null);
});

test("prepared publish receiptが参照するconsumer receiptはretention cleanupで削除しない", async () => {
  const root = await stateRoot();
  const messageId = operationMessageId(OPERATION_ID);
  await publishMessage({ stateRoot: root, message: message(messageId, CURRENT_THREAD, "観測者"), now: NOW });
  const claimed = await claimNextMessage({ stateRoot: root, targetId: TARGET_ID, threadSha256: CURRENT_THREAD, hookEventId: "stop-operation", now: NOW });
  await finishClaim({ claim: claimed.claim, stateRoot: root, result: "emitted_unacked", now: NOW });
  const paths = await ensureMailbox(root, TARGET_ID);
  await atomicCreatePrivateFile(join(paths["publish-receipts"], `${messageId}.json`), `${JSON.stringify({
    schema: "observer.mailbox_publish_receipt.v1", operation_id: OPERATION_ID, message_id: messageId,
    target_id: TARGET_ID, content_digest: claimed.claim.contentDigest, status: "prepared",
    created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
  })}\n`);
  const removed = await cleanupReceipts({ stateRoot: root, targetId: TARGET_ID, now: new Date(NOW.getTime() + 10_000), maxCount: 0, maxAgeMs: 0 });
  assert.deepEqual(removed, []);
  assert.deepEqual(await readdir(paths.receipts), [`${messageId}.json`]);
});

test("default retentionはold completedだけを削除し保護集合を維持する", async () => {
  const root = await stateRoot();
  const cleanupAt = new Date(NOW.getTime() + 31 * 24 * 60 * 60 * 1000);
  for (const [messageId, finishedAt] of [
    ["obs-default-old", NOW],
    ["obs-default-recent", new Date(cleanupAt.getTime() - 24 * 60 * 60 * 1000)],
    [operationMessageId(OPERATION_ID), NOW],
  ]) {
    await publishMessage({ stateRoot: root, message: message(messageId), now: NOW });
    const claimed = await claimNextMessage({
      stateRoot: root, targetId: TARGET_ID, threadSha256: CURRENT_THREAD,
      hookEventId: `stop-${messageId}`, now: NOW,
    });
    await finishClaim({ claim: claimed.claim, stateRoot: root, result: "emitted_unacked", now: finishedAt });
  }
  await publishMessage({ stateRoot: root, message: message("obs-default-claimed"), now: NOW });
  await claimNextMessage({
    stateRoot: root, targetId: TARGET_ID, threadSha256: CURRENT_THREAD,
    hookEventId: "stop-default-claimed", now: NOW,
  });
  const paths = await ensureMailbox(root, TARGET_ID);
  const protectedMessageId = operationMessageId(OPERATION_ID);
  const protectedReceipt = JSON.parse(await readFile(join(paths.receipts, `${protectedMessageId}.json`), "utf8"));
  await atomicCreatePrivateFile(join(paths["publish-receipts"], `${protectedMessageId}.json`), `${JSON.stringify({
    schema: "observer.mailbox_publish_receipt.v1",
    operation_id: OPERATION_ID,
    message_id: protectedMessageId,
    target_id: TARGET_ID,
    content_digest: protectedReceipt.content_digest,
    status: "prepared",
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  })}\n`);

  assert.deepEqual(await cleanupReceipts({ stateRoot: root, targetId: TARGET_ID, now: cleanupAt }), [
    "obs-default-old.json",
  ]);
  assert.deepEqual((await readdir(paths.receipts)).sort(), [
    `${protectedMessageId}.json`,
    "obs-default-claimed.json",
    "obs-default-recent.json",
  ].sort());
});

test("cleanup途中失敗は固定errorを返し再実行で同じ最終集合へ収束する", async () => {
  const root = await stateRoot();
  for (const messageId of ["obs-retry-a", "obs-retry-b"]) {
    await publishMessage({ stateRoot: root, message: message(messageId), now: NOW });
    const claimed = await claimNextMessage({
      stateRoot: root, targetId: TARGET_ID, threadSha256: CURRENT_THREAD,
      hookEventId: `stop-${messageId}`, now: NOW,
    });
    await finishClaim({ claim: claimed.claim, stateRoot: root, result: "delivery_unknown", now: NOW });
  }
  await publishMessage({ stateRoot: root, message: message("obs-retry-claimed"), now: NOW });
  await claimNextMessage({
    stateRoot: root, targetId: TARGET_ID, threadSha256: CURRENT_THREAD,
    hookEventId: "stop-retry-claimed", now: NOW,
  });
  let removals = 0;
  await assert.rejects(cleanupReceipts({
    stateRoot: root,
    targetId: TARGET_ID,
    now: new Date(NOW.getTime() + 31 * 24 * 60 * 60 * 1000),
  }, {
    removePrivateFile: async (path) => {
      removals += 1;
      if (removals === 2) throw new Error("private path must not escape");
      return removePrivateFile(path);
    },
  }), { code: "E_RECEIPT_CLEANUP_FAILED", message: "receipt cleanupが失敗しました" });

  const paths = await ensureMailbox(root, TARGET_ID);
  assert.deepEqual((await readdir(paths.receipts)).sort(), [
    "obs-retry-b.json",
    "obs-retry-claimed.json",
  ]);
  assert.deepEqual(await cleanupReceipts({
    stateRoot: root,
    targetId: TARGET_ID,
    now: new Date(NOW.getTime() + 31 * 24 * 60 * 60 * 1000),
  }), ["obs-retry-b.json"]);
  assert.deepEqual(await readdir(paths.receipts), ["obs-retry-claimed.json"]);
});
