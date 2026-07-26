import { createHash } from "node:crypto";

import { fail } from "./observer-error.mjs";

export const EVIDENCE_SNAPSHOT_SCHEMA = "observer.evidence_snapshot.v1";
export const EVIDENCE_SNAPSHOT_RECEIPT_SCHEMA = "observer.evidence_snapshot_receipt.v1";
export const EVIDENCE_SNAPSHOT_MAX_BYTES = 32 * 1024;
export const EVIDENCE_SECTION_MAX_BYTES = Object.freeze({
  turns: 12 * 1024,
  plan: 6 * 1024,
  git: 8 * 1024,
  tests: 4 * 1024,
});

const REDACTED_MARKER = "[REDACTED]";
const CONTEXT_KEYS = Object.freeze([
  "after_cursor_sha256",
  "cycle_id",
  "parent_host",
  "parent_thread_sha256",
  "target_id",
  "through_cursor_sha256",
  "watch_id",
]);
const INPUT_KEYS = Object.freeze(["context", "git", "plan", "tests", "turns"]);
const SNAPSHOT_KEYS = Object.freeze([
  "content_digest",
  "context",
  "flags",
  "git",
  "plan",
  "schema",
  "tests",
  "turns",
]);
const SECTION_KEYS = Object.freeze([
  "entries",
  "omitted_count",
  "redacted",
  "truncated",
  "unavailable",
]);
const FLAGS_KEYS = Object.freeze(["redacted", "truncated", "unavailable"]);
const TURN_INPUT_KEYS = Object.freeze([
  "assistant",
  "assistant_sha256",
  "completed_at",
  "host",
  "origin_sha256",
  "source_sha256",
  "thread_sha256",
  "truncated",
  "user",
  "user_sha256",
]);
const TURN_OUTPUT_KEYS = Object.freeze([
  "assistant",
  "available",
  "completed_at",
  "redacted",
  "ref",
  "source_digest",
  "truncated",
  "user",
]);
const CONTENT_INPUT_KEYS = Object.freeze([
  "available",
  "content",
  "ref",
  "source_digest",
  "unavailable_code",
]);
const CONTENT_OUTPUT_KEYS = Object.freeze([
  "available",
  "content",
  "redacted",
  "ref",
  "source_digest",
  "truncated",
  "unavailable_code",
]);
const TEST_INPUT_KEYS = Object.freeze([
  "available",
  "command_ref",
  "observed_at",
  "outcome",
  "ref",
  "source_digest",
  "unavailable_code",
]);
const TEST_OUTPUT_KEYS = Object.freeze([
  "available",
  "command_ref",
  "observed_at",
  "outcome",
  "redacted",
  "ref",
  "source_digest",
  "truncated",
  "unavailable_code",
]);

const HEX_64_RE = /^[a-f0-9]{64}$/;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const TARGET_ID_RE = /^p_[a-f0-9]{64}$/;
const CYCLE_ID_RE = /^c_[a-f0-9]{64}$/;
const WATCH_ID_RE = /^w_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UNAVAILABLE_CODE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const STABLE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const SECRET_PATTERNS = Object.freeze([
  /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----[\s\S]*?-----END \1-----/gu,
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/gu,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/gu,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/gu,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/gu,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/giu,
]);

export function buildEvidenceSnapshot(input) {
  const normalized = normalizeInput(input);
  const turns = buildSection({
    entries: normalized.turns,
    budget: EVIDENCE_SECTION_MAX_BYTES.turns,
    priority: "latest",
    truncateFields: ["user", "assistant"],
  });
  const plan = buildSection({
    entries: normalized.plan,
    budget: EVIDENCE_SECTION_MAX_BYTES.plan,
    limit: 4,
    truncateFields: ["content"],
  });
  const git = buildSection({
    entries: normalized.git,
    budget: EVIDENCE_SECTION_MAX_BYTES.git,
    truncateFields: ["content"],
  });
  const tests = buildSection({
    entries: normalized.tests,
    budget: EVIDENCE_SECTION_MAX_BYTES.tests,
    limit: 16,
    truncateFields: ["command_ref"],
  });

  const flags = aggregateTopFlags({ turns, plan, git, tests });
  const content = {
    schema: EVIDENCE_SNAPSHOT_SCHEMA,
    context: normalized.context,
    turns,
    plan,
    git,
    tests,
    flags,
  };
  const snapshot = {
    ...content,
    content_digest: digestValue(content),
  };

  validateEvidenceSnapshot(snapshot);
  return snapshot;
}

export function validateEvidenceSnapshot(snapshot) {
  requirePlainObject(snapshot, "snapshot");
  requireExactKeys(snapshot, SNAPSHOT_KEYS, "snapshot");

  const totalBytes = serializedBytes(snapshot);
  if (totalBytes > EVIDENCE_SNAPSHOT_MAX_BYTES) {
    limitFailure("evidence snapshotが32 KiB上限を超えています", {
      actual_bytes: totalBytes,
      max_bytes: EVIDENCE_SNAPSHOT_MAX_BYTES,
    });
  }

  if (snapshot.schema !== EVIDENCE_SNAPSHOT_SCHEMA) {
    invalid("evidence snapshot schemaが不正です");
  }
  validateContext(snapshot.context);

  validateSection("turns", snapshot.turns, (entry) => validateTurnOutput(entry));
  validateSection("plan", snapshot.plan, (entry) => validateContentOutput(entry, "plan"), 4);
  validateSection("git", snapshot.git, (entry) => validateContentOutput(entry, "git"));
  validateSection("tests", snapshot.tests, (entry) => validateTestOutput(entry), 16);

  validateFlags(snapshot.flags, "snapshot.flags");
  const expectedFlags = aggregateTopFlags(snapshot);
  if (!sameFlags(snapshot.flags, expectedFlags)) {
    invalid("snapshot flagsがsection flagsのORと一致しません");
  }

  if (typeof snapshot.content_digest !== "string" || !DIGEST_RE.test(snapshot.content_digest)) {
    invalid("snapshot content_digestが不正です");
  }
  const content = { ...snapshot };
  delete content.content_digest;
  if (snapshot.content_digest !== digestValue(content)) {
    invalid("snapshot content_digestがcanonical contentと一致しません");
  }

  return snapshot;
}

export function buildEvidenceSnapshotReceipt(snapshot) {
  validateEvidenceSnapshot(snapshot);
  return {
    schema: EVIDENCE_SNAPSHOT_RECEIPT_SCHEMA,
    target_id: snapshot.context.target_id,
    watch_id: snapshot.context.watch_id,
    cycle_id: snapshot.context.cycle_id,
    snapshot_digest: snapshot.content_digest,
    serialized_bytes: serializedBytes(snapshot),
    section_counts: {
      turns: snapshot.turns.entries.length,
      plan: snapshot.plan.entries.length,
      git: snapshot.git.entries.length,
      tests: snapshot.tests.entries.length,
    },
    omitted_counts: {
      turns: snapshot.turns.omitted_count,
      plan: snapshot.plan.omitted_count,
      git: snapshot.git.omitted_count,
      tests: snapshot.tests.omitted_count,
    },
    flags: { ...snapshot.flags },
  };
}

function normalizeInput(input) {
  requirePlainObject(input, "input");
  requireExactKeys(input, INPUT_KEYS, "input");
  validateContext(input.context);
  requireDenseArray(input.turns, "input.turns");
  requireDenseArray(input.plan, "input.plan");
  requireDenseArray(input.git, "input.git");
  requireDenseArray(input.tests, "input.tests");

  const turns = input.turns.map((entry) => normalizeTurn(entry, input.context));
  for (let index = 1; index < turns.length; index += 1) {
    if (Date.parse(turns[index - 1].completed_at) > Date.parse(turns[index].completed_at)) {
      invalid("input.turnsはcompleted_atの古い順である必要があります");
    }
  }
  const plan = input.plan.map((entry) => normalizeContentEntry(entry, "plan"));
  const git = input.git.map((entry) => normalizeContentEntry(entry, "git"));
  const tests = input.tests
    .map((entry, index) => ({ entry: normalizeTestEntry(entry), index }))
    .sort((left, right) => compareTestPriority(left, right))
    .map(({ entry }) => entry);

  return {
    context: { ...input.context },
    turns,
    plan,
    git,
    tests,
  };
}

function normalizeTurn(value, context) {
  requirePlainObject(value, "turn");
  requireExactKeys(value, TURN_INPUT_KEYS, "turn");
  requireString(value.user, "turn.user");
  requireString(value.assistant, "turn.assistant");
  requireHex64(value.user_sha256, "turn.user_sha256");
  requireHex64(value.assistant_sha256, "turn.assistant_sha256");
  requireHex64(value.origin_sha256, "turn.origin_sha256");
  requireHex64(value.source_sha256, "turn.source_sha256");
  requireHex64(value.thread_sha256, "turn.thread_sha256");
  requireCanonicalTimestamp(value.completed_at, "turn.completed_at");
  requireBoolean(value.truncated, "turn.truncated");
  if (value.host !== context.parent_host || value.thread_sha256 !== context.parent_thread_sha256) {
    invalid("turn host/threadがtrusted contextと一致しません");
  }
  if (!value.truncated &&
      (sha256(value.user) !== value.user_sha256 || sha256(value.assistant) !== value.assistant_sha256)) {
    invalid("turn本文digestが一致しません");
  }

  const user = redactText(value.user);
  const assistant = redactText(value.assistant);
  return {
    ref: `turn:${value.source_sha256}`,
    source_digest: `sha256:${value.source_sha256}`,
    available: true,
    truncated: value.truncated,
    redacted: user.redacted || assistant.redacted,
    completed_at: value.completed_at,
    user: user.text,
    assistant: assistant.text,
  };
}

function normalizeContentEntry(value, sectionName) {
  requirePlainObject(value, `${sectionName} entry`);
  requireExactKeys(value, CONTENT_INPUT_KEYS, `${sectionName} entry`);
  validateEvidenceRef(value.ref, sectionName);
  requireDigest(value.source_digest, `${sectionName}.source_digest`);
  requireBoolean(value.available, `${sectionName}.available`);

  if (value.available) {
    requireString(value.content, `${sectionName}.content`);
    if (value.unavailable_code !== null) {
      invalid(`${sectionName} available entryのunavailable_codeはnullである必要があります`);
    }
    const content = redactText(value.content);
    return {
      ref: value.ref,
      source_digest: value.source_digest,
      available: true,
      content: content.text,
      unavailable_code: null,
      truncated: false,
      redacted: content.redacted,
    };
  }

  if (value.content !== null) {
    invalid(`${sectionName} unavailable entryのcontentはnullである必要があります`);
  }
  requireUnavailableCode(value.unavailable_code, `${sectionName}.unavailable_code`);
  return {
    ref: value.ref,
    source_digest: value.source_digest,
    available: false,
    content: null,
    unavailable_code: value.unavailable_code,
    truncated: false,
    redacted: false,
  };
}

function normalizeTestEntry(value) {
  requirePlainObject(value, "test entry");
  requireExactKeys(value, TEST_INPUT_KEYS, "test entry");
  validateEvidenceRef(value.ref, "tests");
  requireDigest(value.source_digest, "test.source_digest");
  requireBoolean(value.available, "test.available");

  if (value.available) {
    requireString(value.command_ref, "test.command_ref");
    if (!new Set(["passed", "failed", "skipped"]).has(value.outcome)) {
      invalid("available test outcomeが不正です");
    }
    requireCanonicalTimestamp(value.observed_at, "test.observed_at");
    if (value.unavailable_code !== null) {
      invalid("available testのunavailable_codeはnullである必要があります");
    }
    const command = redactText(value.command_ref);
    return {
      ref: value.ref,
      source_digest: value.source_digest,
      available: true,
      command_ref: command.text,
      outcome: value.outcome,
      observed_at: value.observed_at,
      unavailable_code: null,
      truncated: false,
      redacted: command.redacted,
    };
  }

  if (value.command_ref !== null || value.outcome !== "unavailable" || value.observed_at !== null) {
    invalid("unavailable testのavailability matrixが不正です");
  }
  requireUnavailableCode(value.unavailable_code, "test.unavailable_code");
  return {
    ref: value.ref,
    source_digest: value.source_digest,
    available: false,
    command_ref: null,
    outcome: "unavailable",
    observed_at: null,
    unavailable_code: value.unavailable_code,
    truncated: false,
    redacted: false,
  };
}

function compareTestPriority(left, right) {
  const leftTime = left.entry.observed_at === null ? Number.NEGATIVE_INFINITY : Date.parse(left.entry.observed_at);
  const rightTime = right.entry.observed_at === null ? Number.NEGATIVE_INFINITY : Date.parse(right.entry.observed_at);
  return rightTime - leftTime || left.index - right.index;
}

function buildSection({ entries, budget, limit = Number.POSITIVE_INFINITY, priority = "first", truncateFields }) {
  const facts = {
    redacted: entries.some((entry) => entry.redacted),
    unavailable: entries.some((entry) => !entry.available),
  };
  const ordered = priority === "latest"
    ? entries.map((entry, index) => ({ entry, index })).reverse()
    : entries.map((entry, index) => ({ entry, index }));
  const selected = [];

  for (const candidate of ordered) {
    if (selected.length >= limit) continue;
    const fitted = fitCandidate({
      candidate: candidate.entry,
      selected: selected.map((item) => item.entry),
      totalCount: entries.length,
      facts,
      budget,
      truncateFields,
    });
    if (fitted !== null) selected.push({ entry: fitted, index: candidate.index });
  }

  if (priority === "latest") selected.sort((left, right) => left.index - right.index);
  return sectionValue(selected.map((item) => item.entry), entries.length, facts);
}

function fitCandidate({ candidate, selected, totalCount, facts, budget, truncateFields }) {
  const fits = (entry) => {
    const section = sectionValue([...selected, entry], totalCount, facts);
    return serializedBytes(section) <= budget;
  };
  if (fits(candidate)) return candidate;
  if (!candidate.available) return null;
  return truncateEntryToFit(candidate, truncateFields, fits);
}

function truncateEntryToFit(entry, fields, fits) {
  const lengths = fields.map((field) => Buffer.byteLength(entry[field], "utf8"));
  const totalBytes = lengths.reduce((sum, value) => sum + value, 0);
  let low = 0;
  let high = totalBytes;
  let best = null;

  while (low <= high) {
    const allowance = Math.floor((low + high) / 2);
    const budgets = allocateByteBudgets(lengths, allowance);
    const candidate = { ...entry, truncated: true };
    for (let index = 0; index < fields.length; index += 1) {
      candidate[fields[index]] = truncateUtf8(entry[fields[index]], budgets[index]);
    }
    if (fits(candidate)) {
      best = candidate;
      low = allowance + 1;
    } else {
      high = allowance - 1;
    }
  }
  return best;
}

function allocateByteBudgets(lengths, allowance) {
  const total = lengths.reduce((sum, value) => sum + value, 0);
  if (total === 0) return lengths.map(() => 0);
  const budgets = lengths.map((length) => Math.min(length, Math.floor((allowance * length) / total)));
  let remainder = allowance - budgets.reduce((sum, value) => sum + value, 0);
  for (let index = 0; remainder > 0 && index < budgets.length; index = (index + 1) % budgets.length) {
    if (budgets[index] < lengths[index]) {
      budgets[index] += 1;
      remainder -= 1;
    }
  }
  return budgets;
}

function truncateUtf8(value, maxBytes) {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let result = "";
  let bytes = 0;
  for (const codePoint of value) {
    const codePointBytes = Buffer.byteLength(codePoint, "utf8");
    if (bytes + codePointBytes > maxBytes) break;
    result += codePoint;
    bytes += codePointBytes;
  }
  return result;
}

function sectionValue(entries, totalCount, facts) {
  const omittedCount = totalCount - entries.length;
  return {
    entries,
    omitted_count: omittedCount,
    truncated: omittedCount > 0 || entries.some((entry) => entry.truncated),
    redacted: facts.redacted || entries.some((entry) => entry.redacted),
    unavailable: facts.unavailable || entries.some((entry) => !entry.available),
  };
}

function validateContext(value) {
  requirePlainObject(value, "context");
  requireExactKeys(value, CONTEXT_KEYS, "context");
  if (typeof value.target_id !== "string" || !TARGET_ID_RE.test(value.target_id)) invalid("context.target_idが不正です");
  if (typeof value.watch_id !== "string" || !WATCH_ID_RE.test(value.watch_id)) invalid("context.watch_idが不正です");
  if (!new Set(["claude", "codex"]).has(value.parent_host)) invalid("context.parent_hostが不正です");
  requireHex64(value.parent_thread_sha256, "context.parent_thread_sha256");
  if (typeof value.cycle_id !== "string" || !CYCLE_ID_RE.test(value.cycle_id)) invalid("context.cycle_idが不正です");
  if (value.after_cursor_sha256 !== null) requireHex64(value.after_cursor_sha256, "context.after_cursor_sha256");
  requireHex64(value.through_cursor_sha256, "context.through_cursor_sha256");
}

function validateSection(name, section, validateEntry, maximumEntries = Number.POSITIVE_INFINITY) {
  requirePlainObject(section, `${name} section`);
  requireExactKeys(section, SECTION_KEYS, `${name} section`);
  requireDenseArray(section.entries, `${name}.entries`);
  if (section.entries.length > maximumEntries) invalid(`${name} sectionのentry件数が上限を超えています`);
  if (!Number.isSafeInteger(section.omitted_count) || section.omitted_count < 0) invalid(`${name}.omitted_countが不正です`);
  requireBoolean(section.truncated, `${name}.truncated`);
  requireBoolean(section.redacted, `${name}.redacted`);
  requireBoolean(section.unavailable, `${name}.unavailable`);
  for (const entry of section.entries) validateEntry(entry);

  const derivedTruncated = section.omitted_count > 0 || section.entries.some((entry) => entry.truncated);
  if (section.truncated !== derivedTruncated) invalid(`${name}.truncatedがentry/omissionと一致しません`);
  if (section.entries.some((entry) => entry.redacted) && !section.redacted) invalid(`${name}.redactedがentryを集約していません`);
  if (section.entries.some((entry) => !entry.available) && !section.unavailable) invalid(`${name}.unavailableがentryを集約していません`);
  if (section.omitted_count === 0) {
    if (section.redacted !== section.entries.some((entry) => entry.redacted)) invalid(`${name}.redactedがentryと一致しません`);
    if (section.unavailable !== section.entries.some((entry) => !entry.available)) invalid(`${name}.unavailableがentryと一致しません`);
  }

  const bytes = serializedBytes(section);
  if (bytes > EVIDENCE_SECTION_MAX_BYTES[name]) {
    limitFailure(`${name} sectionがbyte上限を超えています`, {
      actual_bytes: bytes,
      max_bytes: EVIDENCE_SECTION_MAX_BYTES[name],
    });
  }
}

function validateTurnOutput(value) {
  requirePlainObject(value, "turn snapshot entry");
  requireExactKeys(value, TURN_OUTPUT_KEYS, "turn snapshot entry");
  const source = digestHex(value.source_digest, "turn.source_digest");
  if (value.ref !== `turn:${source}`) invalid("turn refとsource_digestが一致しません");
  if (value.available !== true) invalid("turn entryはavailable=trueである必要があります");
  requireBoolean(value.truncated, "turn.truncated");
  requireBoolean(value.redacted, "turn.redacted");
  requireCanonicalTimestamp(value.completed_at, "turn.completed_at");
  requireString(value.user, "turn.user");
  requireString(value.assistant, "turn.assistant");
  assertRedactedText(value.user, value.redacted, "turn.user");
  assertRedactedText(value.assistant, value.redacted, "turn.assistant");
}

function validateContentOutput(value, sectionName) {
  requirePlainObject(value, `${sectionName} snapshot entry`);
  requireExactKeys(value, CONTENT_OUTPUT_KEYS, `${sectionName} snapshot entry`);
  validateEvidenceRef(value.ref, sectionName);
  requireDigest(value.source_digest, `${sectionName}.source_digest`);
  requireBoolean(value.available, `${sectionName}.available`);
  requireBoolean(value.truncated, `${sectionName}.truncated`);
  requireBoolean(value.redacted, `${sectionName}.redacted`);
  if (value.available) {
    requireString(value.content, `${sectionName}.content`);
    if (value.unavailable_code !== null) invalid(`${sectionName} available entryのunavailable_codeが不正です`);
    assertRedactedText(value.content, value.redacted, `${sectionName}.content`);
  } else {
    if (value.content !== null || value.truncated || value.redacted) invalid(`${sectionName} unavailable entryが本文flagsを持っています`);
    requireUnavailableCode(value.unavailable_code, `${sectionName}.unavailable_code`);
  }
}

function validateTestOutput(value) {
  requirePlainObject(value, "test snapshot entry");
  requireExactKeys(value, TEST_OUTPUT_KEYS, "test snapshot entry");
  validateEvidenceRef(value.ref, "tests");
  requireDigest(value.source_digest, "test.source_digest");
  requireBoolean(value.available, "test.available");
  requireBoolean(value.truncated, "test.truncated");
  requireBoolean(value.redacted, "test.redacted");
  if (value.available) {
    requireString(value.command_ref, "test.command_ref");
    if (!new Set(["passed", "failed", "skipped"]).has(value.outcome)) invalid("test outcomeが不正です");
    requireCanonicalTimestamp(value.observed_at, "test.observed_at");
    if (value.unavailable_code !== null) invalid("available testのunavailable_codeが不正です");
    assertRedactedText(value.command_ref, value.redacted, "test.command_ref");
  } else {
    if (value.command_ref !== null || value.outcome !== "unavailable" || value.observed_at !== null || value.truncated || value.redacted) {
      invalid("unavailable testのavailability matrixが不正です");
    }
    requireUnavailableCode(value.unavailable_code, "test.unavailable_code");
  }
}

function validateEvidenceRef(value, sectionName) {
  requireBoundedString(value, `${sectionName}.ref`, 256);
  if (value.includes("tlc1:") || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
    invalid(`${sectionName}.refにraw cursorまたはraw pathを使用できません`);
  }
  if (sectionName === "plan") {
    if (!value.startsWith("file:")) invalid("plan refはfile: project-relative pathである必要があります");
    const path = value.slice("file:".length);
    const segments = path.split("/");
    if (path.length === 0 || /^[A-Za-z]:\//.test(path) || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
      invalid("plan refのproject-relative pathが不正です");
    }
    return;
  }
  const prefix = sectionName === "git" ? "git:" : "test:";
  if (!value.startsWith(prefix) || !STABLE_NAME_RE.test(value.slice(prefix.length))) {
    invalid(`${sectionName}.refがstable nameではありません`);
  }
}

function validateFlags(value, field) {
  requirePlainObject(value, field);
  requireExactKeys(value, FLAGS_KEYS, field);
  requireBoolean(value.truncated, `${field}.truncated`);
  requireBoolean(value.redacted, `${field}.redacted`);
  requireBoolean(value.unavailable, `${field}.unavailable`);
}

function aggregateTopFlags(snapshot) {
  const sections = [snapshot.turns, snapshot.plan, snapshot.git, snapshot.tests];
  return {
    truncated: sections.some((section) => section.truncated),
    redacted: sections.some((section) => section.redacted),
    unavailable: sections.some((section) => section.unavailable),
  };
}

function sameFlags(left, right) {
  return left.truncated === right.truncated && left.redacted === right.redacted && left.unavailable === right.unavailable;
}

function redactText(value) {
  let text = value;
  let redacted = text.includes(REDACTED_MARKER);
  for (const pattern of SECRET_PATTERNS) {
    const replaced = text.replace(pattern, REDACTED_MARKER);
    if (replaced !== text) redacted = true;
    text = replaced;
  }
  return { text, redacted };
}

function assertRedactedText(value, redacted, field) {
  if (containsSecret(value)) invalid(`${field}に未redactのsecretがあります`);
  if (value.includes(REDACTED_MARKER) && !redacted) invalid(`${field}のredaction flagが不正です`);
}

function containsSecret(value) {
  return SECRET_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(value);
  });
}

function requireCanonicalTimestamp(value, field) {
  if (typeof value !== "string" || !TIMESTAMP_RE.test(value)) invalid(`${field}はcanonical .sssZ timestampである必要があります`);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    invalid(`${field}は実在するcanonical timestampである必要があります`);
  }
}

function requireDigest(value, field) {
  if (typeof value !== "string" || !DIGEST_RE.test(value)) invalid(`${field}が不正です`);
}

function digestHex(value, field) {
  requireDigest(value, field);
  return value.slice("sha256:".length);
}

function requireHex64(value, field) {
  if (typeof value !== "string" || !HEX_64_RE.test(value)) invalid(`${field}が不正です`);
}

function requireUnavailableCode(value, field) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 64 || !UNAVAILABLE_CODE_RE.test(value)) {
    invalid(`${field}が不正です`);
  }
}

function requireBoundedString(value, field, maxBytes) {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > maxBytes) {
    invalid(`${field}が空またはbyte上限超過です`);
  }
}

function requireString(value, field) {
  if (typeof value !== "string") invalid(`${field}はstringである必要があります`);
}

function requireBoolean(value, field) {
  if (typeof value !== "boolean") invalid(`${field}はbooleanである必要があります`);
}

function requireDenseArray(value, field) {
  if (!Array.isArray(value)) invalid(`${field}はarrayである必要があります`);
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value)) invalid(`${field}はsparse arrayを使用できません`);
  }
}

function requirePlainObject(value, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    invalid(`${field}はplain objectである必要があります`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) invalid(`${field}にsymbol keyを使用できません`);
}

function requireExactKeys(value, expected, field) {
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    invalid(`${field}に未知または不足fieldがあります`, { actual, expected });
  }
}

function digestValue(value) {
  return `sha256:${sha256(canonicalJson(value))}`;
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function serializedBytes(value) {
  return Buffer.byteLength(canonicalJson(value), "utf8");
}

function canonicalJson(value, ancestors = new Set()) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid("canonical JSONに非有限numberを使用できません");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") invalid("canonical JSONに非JSON値を使用できません");
  if (ancestors.has(value)) invalid("canonical JSONに循環参照を使用できません");

  ancestors.add(value);
  let result;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) invalid("canonical JSONにsparse arrayを使用できません");
    }
    result = `[${value.map((item) => canonicalJson(item, ancestors)).join(",")}]`;
  } else {
    requirePlainObject(value, "canonical JSON object");
    result = `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], ancestors)}`).join(",")}}`;
  }
  ancestors.delete(value);
  return result;
}

function invalid(message, details = undefined) {
  fail("E_EVIDENCE_SNAPSHOT_INVALID", message, details);
}

function limitFailure(message, details = undefined) {
  fail("E_EVIDENCE_SNAPSHOT_LIMIT", message, details);
}
