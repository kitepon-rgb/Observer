import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ensureMailbox, publishMessage } from "../src/mailbox-store.mjs";
import { sealMessage } from "../src/message-schema.mjs";
import { ObserverError } from "../src/observer-error.mjs";
import { acquirePrivateLock } from "../src/private-state.mjs";

const NOW = new Date("2026-07-14T12:00:00Z");
const TARGET_ID = "p_" + "a".repeat(64);
const THREAD_SHA256 = "1".repeat(64);

function messageContent(overrides = {}) {
  return {
    schema_version: 1,
    message_id: "obs-20260714-0001",
    producer: { producer_id: "observer", kind: "observer" },
    target: { project_target_id: TARGET_ID, thread_sha256: THREAD_SHA256 },
    created_at: "2026-07-14T12:00:00Z",
    expires_at: "2026-07-15T12:00:00Z",
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
