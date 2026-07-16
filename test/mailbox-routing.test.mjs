import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { claimCurrentParentMessage } from "../src/mailbox-consumer.mjs";
import {
  hashParentThreadId,
  MAILBOX_ROUTE_SCHEMA,
  resolveAuthoritativeMailboxRoute,
} from "../src/mailbox-routing.mjs";
import { ensureMailbox, publishMessage } from "../src/mailbox-store.mjs";
import { sealMessage } from "../src/message-schema.mjs";

const NOW = new Date("2026-07-15T05:00:00.000Z");
const PROJECT = "/project";
const TARGET_ID = `p_${"a".repeat(64)}`;
const WATCH_ID = "w_11111111-1111-4111-8111-111111111111";
const CURRENT_RAW = "thread-current";
const CURRENT_SHA = hashParentThreadId(CURRENT_RAW);
const OLD_SHA = hashParentThreadId("thread-old");

function target() {
  return { schema: "observer.project_target.v1", targetId: TARGET_ID, projectRoot: PROJECT };
}

function watch(overrides = {}) {
  return {
    schema: "observer.watch_status.v1", watch_id: WATCH_ID, target_id: TARGET_ID, project_root: PROJECT,
    provider: "codex", status: "active", created_at: NOW.toISOString(), updated_at: NOW.toISOString(), fault_code: null,
    ...overrides,
  };
}

function parent(overrides = {}) {
  return {
    schema: "observer.parent_state.v1", target_id: TARGET_ID, project_root: PROJECT, status: "ready",
    host: "codex", thread_sha256: CURRENT_SHA, cursor: "tlc1.current", ...overrides,
  };
}

function route(status = "current", overrides = {}) {
  return {
    schema: MAILBOX_ROUTE_SCHEMA, status, target_id: TARGET_ID, project_root: PROJECT, provider: "codex",
    thread_sha256: CURRENT_SHA, watch_id: status === "unknown_target" ? null : WATCH_ID,
    parent_cursor: status === "current" || status === "stale_parent" ? "tlc1.current" : null,
    ...overrides,
  };
}

function message(messageId, threadSha256) {
  return sealMessage({
    schema_version: 1,
    message_id: messageId,
    producer: { producer_id: "observer", kind: "observer" },
    target: { project_target_id: TARGET_ID, thread_sha256: threadSha256 },
    created_at: NOW.toISOString(),
    expires_at: "2026-07-16T05:00:00.000Z",
    severity: "warning", category: "verification_gap", dedupe_key: messageId,
    title: "検証待ち", body: "検証証拠を確認してください。", evidence_refs: ["test:evidence"],
    suggested_action: "検証を確認する",
  }, { now: NOW });
}

async function stateRoot() {
  return join(await mkdtemp(join(tmpdir(), "observer-mailbox-route-")), "state");
}

test("raw thread IDをhash化しactive watchとcommitted parentが全一致した時だけcurrentにする", async () => {
  const dependencies = {
    resolveProjectTarget: async () => target(),
    readWatchStatus: async () => watch(),
    readCycleState: async () => ({ committed_state: parent(), pending_cycle: null }),
  };
  const current = await resolveAuthoritativeMailboxRoute({ stateRoot: "/state", projectRoot: PROJECT, parentProvider: "codex", threadId: CURRENT_RAW }, dependencies);
  assert.equal(current.status, "current");
  assert.equal(current.thread_sha256, CURRENT_SHA);
  assert.equal(JSON.stringify(current).includes(CURRENT_RAW), false);

  assert.equal((await resolveAuthoritativeMailboxRoute({ stateRoot: "/state", projectRoot: PROJECT, parentProvider: "claude", threadId: CURRENT_RAW }, dependencies)).status, "stale_parent");
  assert.equal((await resolveAuthoritativeMailboxRoute({ stateRoot: "/state", projectRoot: PROJECT, parentProvider: "codex", threadId: "thread-old" }, dependencies)).status, "stale_parent");
  assert.equal((await resolveAuthoritativeMailboxRoute({ stateRoot: "/state", projectRoot: PROJECT, parentProvider: "codex", threadId: CURRENT_RAW }, { ...dependencies, readWatchStatus: async () => null })).status, "unknown_target");
  assert.equal((await resolveAuthoritativeMailboxRoute({ stateRoot: "/state", projectRoot: PROJECT, parentProvider: "codex", threadId: CURRENT_RAW }, { ...dependencies, readWatchStatus: async () => watch({ status: "stopping" }) })).status, "watch_inactive");
});

test("authoritative current hookだけが旧threadをstale receiptへ変えてcurrentをclaimする", async () => {
  const root = await stateRoot();
  await publishMessage({ stateRoot: root, message: message("obs-old", OLD_SHA), now: NOW });
  await publishMessage({ stateRoot: root, message: message("obs-current", CURRENT_SHA), now: NOW });
  const result = await claimCurrentParentMessage({
    stateRoot: root, projectRoot: PROJECT, parentProvider: "codex", threadId: CURRENT_RAW,
    hookEventId: "stop-current", now: NOW,
  }, { resolveRoute: async () => route() });
  assert.equal(result.claim.message.message_id, "obs-current");
  assert.deepEqual(result.stale_receipts, ["obs-old"]);
  const paths = await ensureMailbox(root, TARGET_ID);
  const stale = JSON.parse(await readFile(join(paths.receipts, "obs-old.json"), "utf8"));
  assert.equal(stale.result, "stale_thread");
  assert.equal(stale.body_retained, false);
  assert.equal(Object.hasOwn(stale, "target_thread_id"), false);
  assert.equal(stale.target_thread_sha256, OLD_SHA);
});

test("lock取得後にrouteが変われば旧hookはinboxを変更しない", async () => {
  const root = await stateRoot();
  await publishMessage({ stateRoot: root, message: message("obs-current", CURRENT_SHA), now: NOW });
  let resolutions = 0;
  const result = await claimCurrentParentMessage({
    stateRoot: root, projectRoot: PROJECT, parentProvider: "codex", threadId: CURRENT_RAW,
    hookEventId: "stop-stale", now: NOW,
  }, { resolveRoute: async () => ++resolutions === 1 ? route() : route("stale_parent") });
  assert.equal(result.claim, null);
  assert.deepEqual(result.stale_receipts, []);
  const paths = await ensureMailbox(root, TARGET_ID);
  assert.deepEqual(await readdir(paths.inbox), ["obs-current.json"]);
  assert.deepEqual(await readdir(paths.receipts), []);
});
