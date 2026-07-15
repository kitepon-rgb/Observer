import { access, lstat } from "node:fs/promises";
import { join } from "node:path";

import { ObserverError, fail } from "./observer-error.mjs";
import { readModelOperation } from "./model-operation-store.mjs";
import { acquirePrivateLock, atomicCreatePrivateFile, atomicReplacePrivateFile, ensureStatePath, readPrivateJson, removePrivateFile } from "./private-state.mjs";
import { validateMessage } from "./message-schema.mjs";

const TARGET_ID_PATTERN = /^p_[a-f0-9]{64}$/;
const OPERATION_ID_PATTERN = /^sha256:([a-f0-9]{64})$/;
const MAILBOX_DIRECTORIES = Object.freeze(["inbox", "processing", "failed", "receipts", "publish-receipts"]);
export const PUBLISH_RECEIPT_SCHEMA = "observer.mailbox_publish_receipt.v1";
export const CONSUMER_RECEIPT_SCHEMA = "observer.mailbox_receipt.v1";

function assertTargetId(targetId) {
  if (typeof targetId !== "string" || !TARGET_ID_PATTERN.test(targetId)) fail("E_TARGET_ID_INVALID", "target IDが不正です");
}

export async function ensureMailbox(stateRoot, targetId) {
  assertTargetId(targetId);
  const targetRoot = await ensureStatePath(stateRoot, "mailboxes", targetId);
  const paths = { root: targetRoot };
  for (const name of MAILBOX_DIRECTORIES) paths[name] = await ensureStatePath(stateRoot, "mailboxes", targetId, name);
  return paths;
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export async function publishMessage({ stateRoot, message, now = new Date() }) {
  validateMessage(message, { now });
  const targetId = message.target.project_target_id;
  const paths = await ensureMailbox(stateRoot, targetId);
  const release = await acquirePrivateLock(join(paths.root, "consumer.lock"));
  try {
    const fileName = `${message.message_id}.json`;
    for (const directory of MAILBOX_DIRECTORIES) {
      if (await exists(join(paths[directory], fileName))) {
        fail("E_MESSAGE_ID_DUPLICATE", "message IDは再利用できません", { messageId: message.message_id });
      }
    }
    const finalPath = join(paths.inbox, fileName);
    try {
      await atomicCreatePrivateFile(finalPath, `${JSON.stringify(message)}\n`);
    } catch (error) {
      if (error instanceof ObserverError && error.code === "E_ALREADY_EXISTS") {
        fail("E_MESSAGE_ID_DUPLICATE", "message IDは再利用できません", { messageId: message.message_id });
      }
      throw error;
    }
    return { messageId: message.message_id, targetId, path: finalPath, contentDigest: message.content_digest };
  } finally {
    await release();
  }
}

export function operationMessageId(operationId) {
  const match = OPERATION_ID_PATTERN.exec(operationId);
  if (!match) fail("E_OPERATION_PUBLISH_INPUT_INVALID", "operation IDが不正です");
  return `obs-${match[1]}`;
}

export async function publishOperationMessage({ stateRoot, operationId, message, now = new Date() }) {
  validateMessage(message, { now });
  const targetId = message.target.project_target_id;
  const messageId = operationMessageId(operationId);
  if (message.message_id !== messageId) fail("E_OPERATION_PUBLISH_MESSAGE_ID_INVALID", "operation message IDが一致しません");
  const paths = await ensureMailbox(stateRoot, targetId);
  const release = await acquirePrivateLock(join(paths.root, "consumer.lock"));
  try {
    const receiptPath = join(paths["publish-receipts"], `${messageId}.json`);
    let receipt;
    if (await privateFileExists(receiptPath)) {
      receipt = validatePublishReceipt(await readPrivateJson(receiptPath));
      assertReceiptMatches({ receipt, operationId, message, targetId, messageId });
      if (receipt.status === "published") return publicPublishResult(receipt);
    } else {
      receipt = publishReceipt({ operationId, message, targetId, messageId, status: "prepared", createdAt: now.toISOString(), updatedAt: now.toISOString() });
      try {
        await atomicCreatePrivateFile(receiptPath, `${JSON.stringify(receipt)}\n`);
      } catch (error) {
        if (error?.code !== "E_ALREADY_EXISTS") throw error;
        receipt = validatePublishReceipt(await readPrivateJson(receiptPath));
        assertReceiptMatches({ receipt, operationId, message, targetId, messageId });
        if (receipt.status === "published") return publicPublishResult(receipt);
      }
    }

    const evidence = await findOperationMessageEvidence({ paths, message, targetId, messageId });
    if (!evidence.found) {
      try {
        await atomicCreatePrivateFile(join(paths.inbox, `${messageId}.json`), `${JSON.stringify(message)}\n`);
      } catch (error) {
        if (error?.code !== "E_ALREADY_EXISTS") throw error;
        const raced = await findOperationMessageEvidence({ paths, message, targetId, messageId });
        if (!raced.found) throw error;
      }
    }
    const published = validatePublishReceipt({ ...receipt, status: "published", updated_at: now.toISOString() });
    await atomicReplacePrivateFile(receiptPath, `${JSON.stringify(published)}\n`);
    return publicPublishResult(published);
  } finally {
    await release();
  }
}

export async function cleanupOperationPublishReceipt({ stateRoot, targetId, operationId, messageId, contentDigest }) {
  if (messageId !== operationMessageId(operationId) || typeof contentDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(contentDigest)) {
    fail("E_OPERATION_PUBLISH_CLEANUP_INPUT_INVALID", "publish receipt cleanup入力が不正です");
  }
  assertTargetId(targetId);
  const operation = await readModelOperation({ stateRoot, targetId });
  if (
    operation === null
    || operation.schema !== "observer.model_operation.v1"
    || operation.status !== "applied"
    || operation.operation_id !== operationId
    || operation.target_id !== targetId
    || operation.applied_result?.schema !== "observer.cycle_result.v1"
    || operation.applied_result.result_digest !== contentDigest.slice("sha256:".length)
  ) {
    fail("E_OPERATION_PUBLISH_NOT_APPLIED", "model operationがappliedではないためpublish receiptをcleanupできません");
  }
  const paths = await ensureMailbox(stateRoot, targetId);
  const release = await acquirePrivateLock(join(paths.root, "consumer.lock"));
  try {
    const receiptPath = join(paths["publish-receipts"], `${messageId}.json`);
    if (!(await privateFileExists(receiptPath))) {
      return { operationId, messageId, targetId, contentDigest, cleaned: false, replayed: true };
    }
    const receipt = validatePublishReceipt(await readPrivateJson(receiptPath));
    if (receipt.status !== "published" || receipt.operation_id !== operationId || receipt.message_id !== messageId || receipt.target_id !== targetId || receipt.content_digest !== contentDigest) {
      fail("E_OPERATION_PUBLISH_CONFLICT", "publish receipt cleanup対象が一致しません");
    }
    await removePrivateFile(receiptPath);
    return { operationId, messageId, targetId, contentDigest, cleaned: true, replayed: false };
  } finally {
    await release();
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

function publishReceipt({ operationId, message, targetId, messageId, status, createdAt, updatedAt }) {
  return validatePublishReceipt({ schema: PUBLISH_RECEIPT_SCHEMA, operation_id: operationId, message_id: messageId, target_id: targetId, content_digest: message.content_digest, status, created_at: createdAt, updated_at: updatedAt });
}

export function validatePublishReceipt(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).sort().join(",") !== "content_digest,created_at,message_id,operation_id,schema,status,target_id,updated_at" ||
    value.schema !== PUBLISH_RECEIPT_SCHEMA || !OPERATION_ID_PATTERN.test(value.operation_id) || value.message_id !== operationMessageId(value.operation_id) ||
    !TARGET_ID_PATTERN.test(value.target_id) || !/^sha256:[a-f0-9]{64}$/.test(value.content_digest) || !["prepared", "published"].includes(value.status) ||
    !isTimestamp(value.created_at) || !isTimestamp(value.updated_at) || Date.parse(value.updated_at) < Date.parse(value.created_at)) {
    fail("E_OPERATION_PUBLISH_CONFLICT", "publish receiptが不正です");
  }
  return value;
}

function isTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

export function validateConsumerReceiptEvidence(value) {
  const keys = "body_retained,claimed_at,content_digest,finished_at,hook_event_id,message_id,producer_id,result,schema,target_project_id,target_thread_sha256";
  const finalResults = new Set(["emitted_unacked", "delivery_unknown", "expired", "rejected_security", "invalid", "stale_thread"]);
  if (
    !value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).sort().join(",") !== keys
    || value.schema !== CONSUMER_RECEIPT_SCHEMA
    || typeof value.message_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.message_id)
    || (value.content_digest !== null && (typeof value.content_digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.content_digest)))
    || !TARGET_ID_PATTERN.test(value.target_project_id)
    || (value.target_thread_sha256 !== null && (typeof value.target_thread_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.target_thread_sha256)))
    || (value.producer_id !== null && (typeof value.producer_id !== "string" || value.producer_id.length < 1 || Buffer.byteLength(value.producer_id, "utf8") > 128))
    || !isTimestamp(value.claimed_at)
    || (value.finished_at !== null && !isTimestamp(value.finished_at))
    || typeof value.hook_event_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value.hook_event_id)
    || typeof value.body_retained !== "boolean"
    || (value.result === "claimed" ? value.finished_at !== null || value.body_retained !== true : !finalResults.has(value.result) || value.finished_at === null || value.body_retained !== false)
    || (value.finished_at !== null && Date.parse(value.finished_at) < Date.parse(value.claimed_at))
  ) fail("E_OPERATION_PUBLISH_CONFLICT", "consumer receiptが不正です");
  return value;
}

function assertReceiptMatches({ receipt, operationId, message, targetId, messageId }) {
  if (receipt.operation_id !== operationId || receipt.message_id !== messageId || receipt.target_id !== targetId || receipt.content_digest !== message.content_digest) {
    fail("E_OPERATION_PUBLISH_CONFLICT", "operation publish receiptが既存messageと一致しません");
  }
}

async function findOperationMessageEvidence({ paths, message, targetId, messageId }) {
  for (const directory of ["inbox", "processing"]) {
    const path = join(paths[directory], `${messageId}.json`);
    if (!(await privateFileExists(path))) continue;
    let existing;
    try { existing = await readPrivateJson(path); validateMessage(existing, { now: new Date(Date.parse(existing.created_at)) }); } catch {
      fail("E_OPERATION_PUBLISH_CONFLICT", "既存operation messageを照合できません");
    }
    if (existing.message_id !== messageId || existing.target.project_target_id !== targetId || existing.content_digest !== message.content_digest) {
      fail("E_OPERATION_PUBLISH_CONFLICT", "既存operation messageが一致しません");
    }
    return { found: true, source: directory };
  }
  const receiptPath = join(paths.receipts, `${messageId}.json`);
  if (await privateFileExists(receiptPath)) {
    let receipt;
    try { receipt = await readPrivateJson(receiptPath); } catch { fail("E_OPERATION_PUBLISH_CONFLICT", "consumer receiptを照合できません"); }
    try { validateConsumerReceiptEvidence(receipt); } catch { fail("E_OPERATION_PUBLISH_CONFLICT", "consumer receiptを照合できません"); }
    if (receipt.message_id !== messageId || receipt.target_project_id !== targetId || receipt.content_digest !== message.content_digest) {
      fail("E_OPERATION_PUBLISH_CONFLICT", "consumer receiptが一致しません");
    }
    return { found: true, source: "consumer_receipt" };
  }
  if (await privateFileExists(join(paths.failed, `${messageId}.json`))) fail("E_OPERATION_PUBLISH_CONFLICT", "failed message IDを再利用できません");
  return { found: false };
}

function publicPublishResult(receipt) {
  return { operationId: receipt.operation_id, messageId: receipt.message_id, targetId: receipt.target_id, contentDigest: receipt.content_digest, status: receipt.status };
}
