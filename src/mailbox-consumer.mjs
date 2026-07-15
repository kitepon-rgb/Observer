import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

import { fail } from "./observer-error.mjs";
import { ensureMailbox } from "./mailbox-store.mjs";
import { resolveAuthoritativeMailboxRoute, validateMailboxRoute } from "./mailbox-routing.mjs";
import { validateMessage } from "./message-schema.mjs";
import {
  acquirePrivateLock,
  atomicCreatePrivateFile,
  atomicReplacePrivateFile,
  inspectPrivateLock,
  movePrivateFileNoReplace,
  readPrivateJson,
  recoverPrivateLock,
  removePrivateFile,
} from "./private-state.mjs";

export const RECEIPT_SCHEMA = "observer.mailbox_receipt.v1";
export const FINAL_RESULTS = Object.freeze(["emitted_unacked", "delivery_unknown"]);
export const DEFAULT_RECEIPT_MAX_COUNT = 1000;
export const DEFAULT_RECEIPT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function receiptForClaim(message, claimedAt, hookEventId) {
  return {
    schema: RECEIPT_SCHEMA,
    message_id: message.message_id,
    content_digest: message.content_digest,
    target_project_id: message.target.project_target_id,
    target_thread_sha256: message.target.thread_sha256,
    producer_id: message.producer.producer_id,
    claimed_at: claimedAt,
    finished_at: null,
    result: "claimed",
    hook_event_id: hookEventId,
    body_retained: true,
  };
}

function receiptForRejected({ messageId, message, targetId, claimedAt, finishedAt, hookEventId, result }) {
  return {
    schema: RECEIPT_SCHEMA,
    message_id: messageId,
    content_digest: typeof message?.content_digest === "string" ? message.content_digest : null,
    target_project_id: targetId,
    target_thread_sha256: typeof message?.target?.thread_sha256 === "string" ? message.target.thread_sha256 : null,
    producer_id: typeof message?.producer?.producer_id === "string" ? message.producer.producer_id : null,
    claimed_at: claimedAt,
    finished_at: finishedAt,
    result,
    hook_event_id: hookEventId,
    body_retained: false,
  };
}

function assertIdentifier(value, field) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)) {
    fail("E_CONSUME_INPUT_INVALID", `${field}が不正です`);
  }
}

function assertMessageId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    fail("E_CONSUME_INPUT_INVALID", "messageIdが不正です");
  }
}

async function privateFileExists(target) {
  try {
    const stat = await lstat(target);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function rejectionResult(error) {
  if (error?.code === "E_MESSAGE_EXPIRED") return "expired";
  if (error?.code === "E_MESSAGE_SENSITIVE_CONTENT") return "rejected_security";
  return "invalid";
}

async function rejectInboxEntry({ paths, fileName, message, targetId, hookEventId, now, result }) {
  const messageId = fileName.slice(0, -".json".length);
  const inboxPath = join(paths.inbox, fileName);
  const processingPath = join(paths.processing, fileName);
  const receiptPath = join(paths.receipts, fileName);
  if (await privateFileExists(receiptPath)) fail("E_RECEIPT_ALREADY_EXISTS", "既存receiptを上書きしません");
  await movePrivateFileNoReplace(inboxPath, processingPath);
  const timestamp = now.toISOString();
  const receipt = receiptForRejected({ messageId, message, targetId, claimedAt: timestamp, finishedAt: timestamp, hookEventId, result });
  await atomicCreatePrivateFile(receiptPath, `${JSON.stringify({ ...receipt, finished_at: null, result: "claimed", body_retained: true })}\n`);
  await removePrivateFile(processingPath);
  await atomicReplacePrivateFile(receiptPath, `${JSON.stringify(receipt)}\n`);
}

export async function claimNextMessage({ stateRoot, targetId, threadSha256, hookEventId, now = new Date() }) {
  assertThreadSha256(threadSha256);
  assertIdentifier(hookEventId, "hookEventId");
  const paths = await ensureMailbox(stateRoot, targetId);
  const release = await acquirePrivateLock(join(paths.root, "consumer.lock"));
  try {
    return claimNextMessageLocked({ paths, targetId, threadSha256, hookEventId, now, expireStale: false });
  } finally {
    await release();
  }
}

export async function claimCurrentParentMessage({ stateRoot, projectRoot, parentProvider, threadId, hookEventId, now = new Date() }, dependencies = {}) {
  assertIdentifier(hookEventId, "hookEventId");
  const resolveRoute = dependencies.resolveRoute ?? resolveAuthoritativeMailboxRoute;
  const input = { stateRoot, projectRoot, parentProvider, threadId };
  const initial = validateMailboxRoute(await resolveRoute(input, dependencies));
  if (initial.status !== "current") return { route: initial, claim: null, stale_receipts: [] };
  const paths = await ensureMailbox(stateRoot, initial.target_id);
  const release = await acquirePrivateLock(join(paths.root, "consumer.lock"));
  try {
    const route = validateMailboxRoute(await resolveRoute(input, dependencies));
    if (route.status !== "current" || route.target_id !== initial.target_id || route.thread_sha256 !== initial.thread_sha256 || route.watch_id !== initial.watch_id) {
      return { route, claim: null, stale_receipts: [] };
    }
    const result = await claimNextMessageLocked({
      paths, targetId: route.target_id, threadSha256: route.thread_sha256, hookEventId, now, expireStale: true,
    });
    return { route, claim: result.claim, stale_receipts: result.staleReceipts };
  } finally {
    await release();
  }
}

async function claimNextMessageLocked({ paths, targetId, threadSha256, hookEventId, now, expireStale }) {
  const staleReceipts = [];
  let currentCandidate = null;
  const candidates = (await readdir(paths.inbox))
    .filter((name) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/.test(name))
    .sort();
  for (const fileName of candidates) {
    const inboxPath = join(paths.inbox, fileName);
    let message;
    try {
      message = await readPrivateJson(inboxPath);
    } catch {
      await rejectInboxEntry({ paths, fileName, message: null, targetId, hookEventId, now, result: "invalid" });
      continue;
    }
    try {
      validateMessage(message, { now });
      if (fileName !== `${message.message_id}.json`) fail("E_MESSAGE_FILENAME_MISMATCH", "filenameとmessage IDが一致しません");
    } catch (error) {
      await rejectInboxEntry({ paths, fileName, message, targetId, hookEventId, now, result: rejectionResult(error) });
      continue;
    }
    if (message.target.project_target_id !== targetId) {
      await rejectInboxEntry({ paths, fileName, message, targetId, hookEventId, now, result: "invalid" });
      continue;
    }
    if (message.target.thread_sha256 !== threadSha256) {
      if (expireStale) {
        await rejectInboxEntry({ paths, fileName, message, targetId, hookEventId, now, result: "stale_thread" });
        staleReceipts.push(message.message_id);
      }
      continue;
    }
    if (currentCandidate === null) currentCandidate = { fileName, message };
    if (!expireStale) break;
  }
  const claimed = currentCandidate === null ? null : await claimInboxEntry({
    paths, fileName: currentCandidate.fileName, message: currentCandidate.message,
    targetId, threadSha256, hookEventId, now,
  });
  return expireStale ? { claim: claimed, staleReceipts } : claimed;
}

async function claimInboxEntry({ paths, fileName, message, targetId, threadSha256, hookEventId, now }) {
  const inboxPath = join(paths.inbox, fileName);
  const processingPath = join(paths.processing, fileName);
  const receiptPath = join(paths.receipts, fileName);
  if (await privateFileExists(receiptPath)) fail("E_RECEIPT_ALREADY_EXISTS", "claim済みmessage IDを再利用できません");
  await movePrivateFileNoReplace(inboxPath, processingPath);
  const claimedAt = now.toISOString();
  await atomicCreatePrivateFile(receiptPath, `${JSON.stringify(receiptForClaim(message, claimedAt, hookEventId))}\n`);
  return {
    message,
    processingPath,
    receiptPath,
    claim: {
      messageId: message.message_id,
      contentDigest: message.content_digest,
      targetId,
      threadSha256,
      hookEventId,
      claimedAt,
    },
  };
}

export async function finishClaim({ claim, stateRoot, result, now = new Date() }) {
  if (!FINAL_RESULTS.includes(result)) fail("E_RECEIPT_RESULT_INVALID", "final receipt resultが不正です");
  if (claim === null || typeof claim !== "object" || Array.isArray(claim)) fail("E_CONSUME_INPUT_INVALID", "claimが不正です");
  assertMessageId(claim.messageId);
  assertThreadSha256(claim.threadSha256);
  assertIdentifier(claim.hookEventId, "claim.hookEventId");
  const paths = await ensureMailbox(stateRoot, claim.targetId);
  const fileName = `${claim.messageId}.json`;
  const processingPath = join(paths.processing, fileName);
  const receiptPath = join(paths.receipts, fileName);
  const message = await readPrivateJson(processingPath);
  validateMessage(message, { now: new Date(Date.parse(message.created_at)) });
  if (
    message.content_digest !== claim.contentDigest
    || message.target.project_target_id !== claim.targetId
    || message.target.thread_sha256 !== claim.threadSha256
  ) {
    fail("E_CLAIM_STATE_MISMATCH", "processing messageとclaimが一致しません");
  }
  const receipt = await readPrivateJson(receiptPath);
  if (
    receipt.schema !== RECEIPT_SCHEMA
    || receipt.result !== "claimed"
    || receipt.message_id !== claim.messageId
    || receipt.content_digest !== claim.contentDigest
    || receipt.hook_event_id !== claim.hookEventId
  ) {
    fail("E_RECEIPT_STATE_MISMATCH", "claimed receiptとclaimが一致しません");
  }

  await removePrivateFile(processingPath);
  const finalReceipt = {
    ...receipt,
    finished_at: now.toISOString(),
    result,
    body_retained: false,
  };
  await atomicReplacePrivateFile(receiptPath, `${JSON.stringify(finalReceipt)}\n`);
  return finalReceipt;
}

function assertThreadSha256(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) fail("E_CONSUME_INPUT_INVALID", "threadSha256が不正です");
}

export async function recoverClaimAsDeliveryUnknown({ stateRoot, targetId, messageId, now = new Date() }) {
  assertMessageId(messageId);
  const paths = await ensureMailbox(stateRoot, targetId);
  const release = await acquirePrivateLock(join(paths.root, "consumer.lock"));
  try {
    const processingPath = join(paths.processing, `${messageId}.json`);
    const receiptPath = join(paths.receipts, `${messageId}.json`);
    const receipt = await readPrivateJson(receiptPath);
    if (receipt.schema !== RECEIPT_SCHEMA || receipt.result !== "claimed" || receipt.message_id !== messageId) {
      fail("E_RECEIPT_STATE_MISMATCH", "recovery対象がclaimed receiptではありません");
    }
    if (await privateFileExists(processingPath)) await removePrivateFile(processingPath);
    const recovered = {
      ...receipt,
      finished_at: now.toISOString(),
      result: "delivery_unknown",
      body_retained: false,
    };
    await atomicReplacePrivateFile(receiptPath, `${JSON.stringify(recovered)}\n`);
    return recovered;
  } finally {
    await release();
  }
}

export async function inspectConsumerLock({ stateRoot, targetId }) {
  const paths = await ensureMailbox(stateRoot, targetId);
  return inspectPrivateLock(join(paths.root, "consumer.lock"));
}

export async function recoverConsumerLock({ stateRoot, targetId, expectedNonce }) {
  const paths = await ensureMailbox(stateRoot, targetId);
  return recoverPrivateLock(join(paths.root, "consumer.lock"), expectedNonce);
}

export async function cleanupReceipts({
  stateRoot,
  targetId,
  now = new Date(),
  maxCount = DEFAULT_RECEIPT_MAX_COUNT,
  maxAgeMs = DEFAULT_RECEIPT_MAX_AGE_MS,
}) {
  if (!Number.isInteger(maxCount) || maxCount < 0 || !Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
    fail("E_RETENTION_INPUT_INVALID", "receipt retention指定が不正です");
  }
  const paths = await ensureMailbox(stateRoot, targetId);
  const release = await acquirePrivateLock(join(paths.root, "consumer.lock"));
  try {
    const completed = [];
    for (const fileName of (await readdir(paths.receipts)).filter((name) => name.endsWith(".json"))) {
      const path = join(paths.receipts, fileName);
      const receipt = await readPrivateJson(path);
      if (receipt.schema !== RECEIPT_SCHEMA) fail("E_RECEIPT_STATE_MISMATCH", "未知schemaのreceiptを自動削除しません");
      if (receipt.result === "claimed") continue;
      if (typeof receipt.finished_at !== "string" || !Number.isFinite(Date.parse(receipt.finished_at))) {
        fail("E_RECEIPT_STATE_MISMATCH", "完了receiptのfinished_atが不正です");
      }
      completed.push({ path, fileName, finishedAt: Date.parse(receipt.finished_at) });
    }
    completed.sort((left, right) => left.finishedAt - right.finishedAt || left.fileName.localeCompare(right.fileName));
    const expired = completed.filter((entry) => now.getTime() - entry.finishedAt > maxAgeMs);
    const expiredNames = new Set(expired.map((entry) => entry.fileName));
    const retained = completed.filter((entry) => !expiredNames.has(entry.fileName));
    const overCount = retained.slice(0, Math.max(0, retained.length - maxCount));
    const removed = [...expired, ...overCount];
    for (const entry of removed) await removePrivateFile(entry.path);
    return removed.map((entry) => entry.fileName);
  } finally {
    await release();
  }
}
