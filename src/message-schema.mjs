import { createHash } from "node:crypto";

import { fail } from "./observer-error.mjs";

export const MESSAGE_SCHEMA_VERSION = 1;
export const SEVERITIES = Object.freeze(["info", "warning", "review_required"]);
export const CATEGORIES = Object.freeze([
  "stagnation",
  "scope_drift",
  "repeated_failure",
  "verification_gap",
  "unknown_run",
  "plan_drift",
  "overengineering",
  "acceptance_mismatch",
  "context_drift",
]);

const TOP_LEVEL_KEYS = Object.freeze([
  "body",
  "category",
  "content_digest",
  "created_at",
  "dedupe_key",
  "evidence_refs",
  "expires_at",
  "message_id",
  "producer",
  "schema_version",
  "severity",
  "suggested_action",
  "target",
  "title",
]);
const PRODUCER_KEYS = Object.freeze(["kind", "producer_id"]);
const TARGET_KEYS = Object.freeze(["project_target_id", "thread_id"]);
const TARGET_ID_PATTERN = /^p_[a-f0-9]{64}$/;
const MESSAGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SENSITIVE_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/i,
];

function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

function requirePlainObject(value, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail("E_MESSAGE_SCHEMA", `${field}はobjectである必要があります`);
  }
}

function requireExactKeys(value, expected, field) {
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail("E_MESSAGE_SCHEMA", `${field}に未知または不足fieldがあります`, { actual, expected });
  }
}

function requireString(value, field, { min = 1, maxBytes }) {
  if (typeof value !== "string" || value.length < min || byteLength(value) > maxBytes) {
    fail("E_MESSAGE_SCHEMA", `${field}の長さが不正です`, { maxBytes });
  }
}

function requireTimestamp(value, field) {
  requireString(value, field, { maxBytes: 64 });
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) {
    fail("E_MESSAGE_SCHEMA", `${field}はUTC ISO timestampである必要があります`);
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function computeMessageDigest(message) {
  requirePlainObject(message, "message");
  const content = { ...message };
  delete content.content_digest;
  return `sha256:${createHash("sha256").update(canonicalize(content), "utf8").digest("hex")}`;
}

function assertNoSensitiveContent(message) {
  const text = [message.title, message.body, message.suggested_action, ...message.evidence_refs].join("\n");
  if (SENSITIVE_PATTERNS.some((pattern) => pattern.test(text))) {
    fail("E_MESSAGE_SENSITIVE_CONTENT", "手紙へsecretまたはcredentialらしき内容を保存できません");
  }
}

export function validateMessage(message, { now = new Date() } = {}) {
  requirePlainObject(message, "message");
  requireExactKeys(message, TOP_LEVEL_KEYS, "message");
  if (message.schema_version !== MESSAGE_SCHEMA_VERSION) fail("E_MESSAGE_SCHEMA_VERSION", "未対応のmessage schemaです");
  if (typeof message.message_id !== "string" || !MESSAGE_ID_PATTERN.test(message.message_id)) fail("E_MESSAGE_SCHEMA", "message_idが不正です");

  requirePlainObject(message.producer, "producer");
  requireExactKeys(message.producer, PRODUCER_KEYS, "producer");
  requireString(message.producer.producer_id, "producer.producer_id", { maxBytes: 128 });
  if (message.producer.kind !== "observer") fail("E_MESSAGE_SCHEMA", "producer.kindはobserverである必要があります");

  requirePlainObject(message.target, "target");
  requireExactKeys(message.target, TARGET_KEYS, "target");
  if (typeof message.target.project_target_id !== "string" || !TARGET_ID_PATTERN.test(message.target.project_target_id)) fail("E_MESSAGE_SCHEMA", "project_target_idが不正です");
  requireString(message.target.thread_id, "target.thread_id", { maxBytes: 256 });

  requireTimestamp(message.created_at, "created_at");
  requireTimestamp(message.expires_at, "expires_at");
  if (Date.parse(message.expires_at) <= Date.parse(message.created_at)) fail("E_MESSAGE_SCHEMA", "expires_atはcreated_atより後である必要があります");
  if (Date.parse(message.expires_at) <= now.getTime()) fail("E_MESSAGE_EXPIRED", "期限切れmessageです");

  if (!SEVERITIES.includes(message.severity)) fail("E_MESSAGE_SCHEMA", "severityが不正です");
  if (!CATEGORIES.includes(message.category)) fail("E_MESSAGE_SCHEMA", "categoryが不正です");
  requireString(message.dedupe_key, "dedupe_key", { maxBytes: 256 });
  requireString(message.title, "title", { maxBytes: 512 });
  requireString(message.body, "body", { maxBytes: 8192 });
  requireString(message.suggested_action, "suggested_action", { maxBytes: 2048 });
  if (!Array.isArray(message.evidence_refs) || message.evidence_refs.length > 16) fail("E_MESSAGE_SCHEMA", "evidence_refsは最大16件です");
  for (const ref of message.evidence_refs) requireString(ref, "evidence_refs[]", { maxBytes: 512 });

  if (typeof message.content_digest !== "string" || !DIGEST_PATTERN.test(message.content_digest)) fail("E_MESSAGE_SCHEMA", "content_digestが不正です");
  const expectedDigest = computeMessageDigest(message);
  if (message.content_digest !== expectedDigest) fail("E_MESSAGE_DIGEST_MISMATCH", "message digestが一致しません");
  assertNoSensitiveContent(message);
  return message;
}

export function sealMessage(content) {
  const message = { ...content, content_digest: "sha256:" + "0".repeat(64) };
  message.content_digest = computeMessageDigest(message);
  return validateMessage(message);
}
