import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  EVIDENCE_SECTION_MAX_BYTES,
  EVIDENCE_SNAPSHOT_MAX_BYTES,
  EVIDENCE_SNAPSHOT_RECEIPT_SCHEMA,
  EVIDENCE_SNAPSHOT_SCHEMA,
  buildEvidenceSnapshot,
  buildEvidenceSnapshotReceipt,
  validateEvidenceSnapshot,
} from "../src/evidence-snapshot.mjs";
import { ObserverError } from "../src/observer-error.mjs";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const SHA_D = "d".repeat(64);
const CONTEXT = Object.freeze({
  target_id: `p_${SHA_A}`,
  watch_id: "w_11111111-1111-4111-8111-111111111111",
  parent_host: "codex",
  parent_thread_sha256: SHA_B,
  cycle_id: `c_${SHA_C}`,
  after_cursor_sha256: null,
  through_cursor_sha256: SHA_D,
});

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sourceFor(label) {
  return sha256(`source:${label}`);
}

function digestFor(label) {
  return `sha256:${sha256(`digest:${label}`)}`;
}

function makeTurn(index, overrides = {}) {
  const user = overrides.user ?? `user ${index}`;
  const assistant = overrides.assistant ?? `assistant ${index}`;
  return {
    assistant,
    assistant_sha256: sha256(assistant),
    completed_at: `2026-07-15T00:00:${String(index).padStart(2, "0")}.000Z`,
    host: CONTEXT.parent_host,
    origin_sha256: sourceFor(`origin-${index}`),
    source_sha256: sourceFor(`turn-${index}`),
    thread_sha256: CONTEXT.parent_thread_sha256,
    truncated: false,
    user,
    user_sha256: sha256(user),
    ...overrides,
  };
}

function makeContent(section, index, overrides = {}) {
  return {
    ref: section === "plan" ? `file:docs/plan-${index}.md` : `git:item-${index}`,
    source_digest: digestFor(`${section}-${index}`),
    available: true,
    content: `${section} content ${index}`,
    unavailable_code: null,
    ...overrides,
  };
}

function makeTest(index, overrides = {}) {
  return {
    ref: `test:gate-${index}`,
    source_digest: digestFor(`test-${index}`),
    available: true,
    command_ref: `node --test gate-${index}`,
    outcome: "passed",
    observed_at: `2026-07-15T00:${String(index).padStart(2, "0")}:00.000Z`,
    unavailable_code: null,
    ...overrides,
  };
}

function makeInput(overrides = {}) {
  return {
    context: { ...CONTEXT },
    turns: [makeTurn(1)],
    plan: [makeContent("plan", 1)],
    git: [makeContent("git", 1)],
    tests: [makeTest(1)],
    ...overrides,
  };
}

function expectCode(code) {
  return (error) => error instanceof ObserverError && error.code === code;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function canonicalBytes(value) {
  return Buffer.byteLength(canonical(value), "utf8");
}

function reseal(snapshot) {
  const content = structuredClone(snapshot);
  delete content.content_digest;
  snapshot.content_digest = `sha256:${sha256(canonical(content))}`;
  return snapshot;
}

test("happy pathはexact snapshotを作り、本文なしのbounded receiptを返す", () => {
  const snapshot = buildEvidenceSnapshot(makeInput());
  assert.equal(snapshot.schema, EVIDENCE_SNAPSHOT_SCHEMA);
  assert.deepEqual(Object.keys(snapshot).sort(), [
    "content_digest",
    "context",
    "flags",
    "git",
    "plan",
    "schema",
    "tests",
    "turns",
  ]);
  assert.equal(validateEvidenceSnapshot(snapshot), snapshot);
  assert.ok(canonicalBytes(snapshot) <= EVIDENCE_SNAPSHOT_MAX_BYTES);

  const receipt = buildEvidenceSnapshotReceipt(snapshot);
  assert.equal(receipt.schema, EVIDENCE_SNAPSHOT_RECEIPT_SCHEMA);
  assert.equal(receipt.snapshot_digest, snapshot.content_digest);
  assert.equal(receipt.serialized_bytes, canonicalBytes(snapshot));
  assert.deepEqual(receipt.section_counts, { turns: 1, plan: 1, git: 1, tests: 1 });
  assert.deepEqual(receipt.omitted_counts, { turns: 0, plan: 0, git: 0, tests: 0 });
  assert.deepEqual(Object.keys(receipt).sort(), [
    "cycle_id",
    "flags",
    "omitted_counts",
    "schema",
    "section_counts",
    "serialized_bytes",
    "snapshot_digest",
    "target_id",
    "watch_id",
  ]);
  const serializedReceipt = JSON.stringify(receipt);
  assert.doesNotMatch(serializedReceipt, /user 1|assistant 1|docs\/plan|git:item|test:gate/);
});

test("content_digestはcontent_digest keyを完全に除外したcanonical JSONへ束縛される", () => {
  const snapshot = buildEvidenceSnapshot(makeInput());
  const content = structuredClone(snapshot);
  delete content.content_digest;
  assert.equal(snapshot.content_digest, `sha256:${sha256(canonical(content))}`);

  const reordered = {
    tests: snapshot.tests,
    schema: snapshot.schema,
    plan: snapshot.plan,
    turns: snapshot.turns,
    flags: snapshot.flags,
    context: snapshot.context,
    git: snapshot.git,
    content_digest: snapshot.content_digest,
  };
  assert.equal(validateEvidenceSnapshot(reordered), reordered);
});

test("UUIDv4 variantとcanonical .sssZ timestampをfail closedで検証する", () => {
  for (const watchId of [
    "w_11111111-1111-3111-8111-111111111111",
    "w_11111111-1111-4111-7111-111111111111",
    "w_11111111-1111-4111-C111-111111111111",
  ]) {
    assert.throws(
      () => buildEvidenceSnapshot(makeInput({ context: { ...CONTEXT, watch_id: watchId } })),
      expectCode("E_EVIDENCE_SNAPSHOT_INVALID"),
    );
  }
  assert.throws(
    () => buildEvidenceSnapshot(makeInput({ turns: [makeTurn(1, { completed_at: "2026-07-15T00:00:01Z" })] })),
    expectCode("E_EVIDENCE_SNAPSHOT_INVALID"),
  );
  assert.throws(
    () => buildEvidenceSnapshot(makeInput({ tests: [makeTest(1, { observed_at: "2026-02-30T00:00:00.000Z" })] })),
    expectCode("E_EVIDENCE_SNAPSHOT_INVALID"),
  );
  assert.throws(
    () => buildEvidenceSnapshot(makeInput({ turns: [makeTurn(2), makeTurn(1)] })),
    expectCode("E_EVIDENCE_SNAPSHOT_INVALID"),
  );
});

test("top、context、entryのunknown/extra keyと非JSON値を拒否する", () => {
  assert.throws(
    () => buildEvidenceSnapshot({ ...makeInput(), extra: true }),
    expectCode("E_EVIDENCE_SNAPSHOT_INVALID"),
  );
  assert.throws(
    () => buildEvidenceSnapshot(makeInput({ context: { ...CONTEXT, raw_cursor: "tlc1:secret" } })),
    expectCode("E_EVIDENCE_SNAPSHOT_INVALID"),
  );
  assert.throws(
    () => buildEvidenceSnapshot(makeInput({ turns: [{ ...makeTurn(1), session_id: "raw" }] })),
    expectCode("E_EVIDENCE_SNAPSHOT_INVALID"),
  );
  assert.throws(
    () => buildEvidenceSnapshot(makeInput({ plan: [makeContent("plan", 1, { content: undefined })] })),
    expectCode("E_EVIDENCE_SNAPSHOT_INVALID"),
  );

  const snapshot = buildEvidenceSnapshot(makeInput());
  snapshot.plan.omitted_count = Number.NaN;
  assert.throws(() => validateEvidenceSnapshot(snapshot), expectCode("E_EVIDENCE_SNAPSHOT_INVALID"));
});

test("tampered snapshotはdigestとentry relationshipの両方を再検証する", () => {
  const staleDigest = buildEvidenceSnapshot(makeInput());
  staleDigest.turns.entries[0].assistant = "tampered";
  assert.throws(() => validateEvidenceSnapshot(staleDigest), expectCode("E_EVIDENCE_SNAPSHOT_INVALID"));

  const badRelationship = buildEvidenceSnapshot(makeInput());
  badRelationship.turns.entries[0].ref = `turn:${"f".repeat(64)}`;
  reseal(badRelationship);
  assert.throws(() => validateEvidenceSnapshot(badRelationship), expectCode("E_EVIDENCE_SNAPSHOT_INVALID"));
});

test("truncated turnは元全文digestを保持してorientationへ通し完全な根拠にしない", () => {
  const snapshot = buildEvidenceSnapshot(makeInput({
    turns: [makeTurn(1, {
      user: "truncated user",
      user_sha256: sha256("original full user"),
      assistant: "truncated assistant",
      assistant_sha256: sha256("original full assistant"),
      truncated: true,
    })],
  }));
  assert.equal(snapshot.turns.entries[0].truncated, true);
  assert.equal(snapshot.turns.truncated, true);
  assert.equal(snapshot.flags.truncated, true);

  assert.throws(
    () => buildEvidenceSnapshot(makeInput({
      turns: [makeTurn(1, {
        assistant: "tampered",
        assistant_sha256: sha256("original"),
        truncated: false,
      })],
    })),
    expectCode("E_EVIDENCE_SNAPSHOT_INVALID"),
  );
});

test("test availability matrixはavailableとunavailableのexact組合せだけを許す", () => {
  const unavailable = makeTest(2, {
    available: false,
    command_ref: null,
    outcome: "unavailable",
    observed_at: null,
    unavailable_code: "COLLECTOR_UNAVAILABLE",
  });
  const snapshot = buildEvidenceSnapshot(makeInput({ tests: [makeTest(1), unavailable] }));
  assert.equal(snapshot.tests.entries[1].available, false);
  assert.equal(snapshot.tests.unavailable, true);
  assert.equal(snapshot.flags.unavailable, true);

  for (const invalidEntry of [
    { ...unavailable, command_ref: "node --test" },
    { ...unavailable, outcome: "failed" },
    { ...unavailable, observed_at: "2026-07-15T00:00:00.000Z" },
    makeTest(1, { unavailable_code: "SHOULD_BE_NULL" }),
  ]) {
    assert.throws(
      () => buildEvidenceSnapshot(makeInput({ tests: [invalidEntry] })),
      expectCode("E_EVIDENCE_SNAPSHOT_INVALID"),
    );
  }
});

test("plan refはproject-relative pathだけを許し、本文中のslashは拒否しない", () => {
  for (const ref of [
    "file:/absolute.md",
    "file:../escape.md",
    "file:docs/../escape.md",
    "file:docs\\plan.md",
    "file:C:/absolute.md",
    "file:docs//plan.md",
  ]) {
    assert.throws(
      () => buildEvidenceSnapshot(makeInput({ plan: [makeContent("plan", 1, { ref })] })),
      expectCode("E_EVIDENCE_SNAPSHOT_INVALID"),
    );
  }
  const snapshot = buildEvidenceSnapshot(makeInput({
    plan: [makeContent("plan", 1, { content: "通常本文 /tmp/example と src/file.mjs は許可される" })],
  }));
  assert.match(snapshot.plan.entries[0].content, /\/tmp\/example/);
});

test("private key、OpenAI key、GitHub token、Bearerを固定markerへredactする", () => {
  const privateKey = "-----BEGIN PRIVATE KEY-----\nvery-secret-material\n-----END PRIVATE KEY-----";
  const openAiKey = `sk-${"x".repeat(24)}`;
  const githubToken = `ghp_${"y".repeat(24)}`;
  const fineGrainedGithubToken = `github_pat_${"f".repeat(24)}`;
  const bearer = `Bearer ${"z".repeat(24)}`;
  const snapshot = buildEvidenceSnapshot(makeInput({
    turns: [makeTurn(1, { user: `credential ${privateKey}`, assistant: "safe" })],
    plan: [makeContent("plan", 1, { content: githubToken })],
    git: [makeContent("git", 1, { content: bearer })],
    tests: [makeTest(1, { command_ref: `run --token ${openAiKey} ${fineGrainedGithubToken}` })],
  }));

  const serialized = canonical(snapshot);
  for (const secret of ["very-secret-material", openAiKey, githubToken, fineGrainedGithubToken, bearer]) {
    assert.equal(serialized.includes(secret), false);
  }
  assert.match(serialized, /\[REDACTED\]/);
  assert.equal(snapshot.flags.redacted, true);
  assert.equal(snapshot.turns.entries[0].available, true);
  assert.equal(snapshot.plan.entries[0].available, true);
  assert.equal(snapshot.git.entries[0].available, true);
  assert.equal(snapshot.tests.entries[0].available, true);
  assert.equal(JSON.stringify(buildEvidenceSnapshotReceipt(snapshot)).includes("REDACTED"), false);
});

test("Unicode本文をcode point境界でtruncateし、大きい最新turnを即dropしない", () => {
  const huge = "観測🙂".repeat(8000);
  const snapshot = buildEvidenceSnapshot(makeInput({
    turns: [makeTurn(1, { user: huge, assistant: huge })],
    plan: [],
    git: [],
    tests: [],
  }));
  const entry = snapshot.turns.entries[0];
  assert.equal(entry.truncated, true);
  assert.equal(entry.available, true);
  assert.ok(entry.user.length > 0);
  assert.ok(entry.assistant.length > 0);
  assert.equal(/[\uD800-\uDBFF]$/.test(entry.user), false);
  assert.equal(/[\uD800-\uDBFF]$/.test(entry.assistant), false);
  assert.ok(canonicalBytes(snapshot.turns) <= EVIDENCE_SECTION_MAX_BYTES.turns);
  validateEvidenceSnapshot(snapshot);
});

test("turnsは入力順を保ちつつ最新側を優先保持する", () => {
  const turns = Array.from({ length: 8 }, (_, index) => makeTurn(index + 1, {
    user: `user-${index + 1}-` + "u".repeat(3500),
    assistant: `assistant-${index + 1}-` + "a".repeat(3500),
  }));
  const snapshot = buildEvidenceSnapshot(makeInput({ turns, plan: [], git: [], tests: [] }));
  const refs = snapshot.turns.entries.map((entry) => entry.ref);
  const sourceIndexes = refs.map((ref) => turns.findIndex((turn) => ref === `turn:${turn.source_sha256}`));
  assert.ok(snapshot.turns.omitted_count > 0);
  assert.equal(refs.includes(`turn:${turns.at(-1).source_sha256}`), true);
  assert.equal(refs.includes(`turn:${turns[0].source_sha256}`), false);
  assert.deepEqual(sourceIndexes, [...sourceIndexes].sort((left, right) => left - right));
});

test("planは先頭4件、gitは入力先頭を優先し、本文truncate後にtailをomitする", () => {
  const plans = Array.from({ length: 6 }, (_, index) => makeContent("plan", index + 1));
  const git = Array.from({ length: 3 }, (_, index) => makeContent("git", index + 1, {
    content: `git-${index + 1}-` + "g".repeat(9000),
  }));
  const snapshot = buildEvidenceSnapshot(makeInput({ turns: [], plan: plans, git, tests: [] }));
  assert.deepEqual(snapshot.plan.entries.map((entry) => entry.ref), plans.slice(0, 4).map((entry) => entry.ref));
  assert.equal(snapshot.plan.omitted_count, 2);
  assert.equal(snapshot.git.entries[0].ref, git[0].ref);
  assert.equal(snapshot.git.entries[0].truncated, true);
  assert.ok(snapshot.git.omitted_count > 0);
  assert.ok(canonicalBytes(snapshot.git) <= EVIDENCE_SECTION_MAX_BYTES.git);
});

test("testsはobserved_at最新順を優先して最大16件へboundする", () => {
  const datedTests = Array.from({ length: 5 }, (_, index) => makeTest(index));
  const latestFirst = buildEvidenceSnapshot(makeInput({ turns: [], plan: [], git: [], tests: datedTests }));
  assert.deepEqual(
    latestFirst.tests.entries.map((entry) => entry.ref),
    datedTests.toReversed().map((entry) => entry.ref),
  );

  const compactUnavailable = Array.from({ length: 20 }, (_, index) => makeTest(index, {
    ref: `test:${String.fromCharCode(97 + index)}`,
    source_digest: digestFor("compact"),
    available: false,
    command_ref: null,
    outcome: "unavailable",
    observed_at: null,
    unavailable_code: "X",
  }));
  const bounded = buildEvidenceSnapshot(makeInput({ turns: [], plan: [], git: [], tests: compactUnavailable }));
  assert.equal(bounded.tests.entries.length, 16);
  assert.equal(bounded.tests.omitted_count, 4);
  assert.deepEqual(
    bounded.tests.entries.map((entry) => entry.ref),
    compactUnavailable.slice(0, 16).map((entry) => entry.ref),
  );
});

test("各sectionはmetadata込みcanonical bytesでhard gateされる", () => {
  const snapshot = buildEvidenceSnapshot(makeInput());
  snapshot.plan.entries[0].content = "p".repeat(EVIDENCE_SECTION_MAX_BYTES.plan + 100);
  reseal(snapshot);
  assert.ok(canonicalBytes(snapshot) < EVIDENCE_SNAPSHOT_MAX_BYTES);
  assert.throws(() => validateEvidenceSnapshot(snapshot), expectCode("E_EVIDENCE_SNAPSHOT_LIMIT"));
});

test("snapshot全体の32 KiB final hard gateはsection検証より先にfail closedする", () => {
  const snapshot = buildEvidenceSnapshot(makeInput());
  snapshot.turns.entries[0].user = "t".repeat(EVIDENCE_SNAPSHOT_MAX_BYTES);
  snapshot.plan.entries[0].content = "p".repeat(EVIDENCE_SNAPSHOT_MAX_BYTES);
  assert.ok(canonicalBytes(snapshot) > EVIDENCE_SNAPSHOT_MAX_BYTES);
  assert.throws(() => validateEvidenceSnapshot(snapshot), expectCode("E_EVIDENCE_SNAPSHOT_LIMIT"));
});

test("section flagsはomission/upstream/redaction/unavailableを集約し、top flagsは4 sectionのORと一致する", () => {
  const secret = `ghp_${"q".repeat(24)}`;
  const unavailableGit = makeContent("git", 1, {
    available: false,
    content: null,
    unavailable_code: "GIT_UNAVAILABLE",
  });
  const snapshot = buildEvidenceSnapshot(makeInput({
    turns: [makeTurn(1, { truncated: true })],
    plan: [makeContent("plan", 1, { content: secret })],
    git: [unavailableGit],
    tests: [],
  }));
  assert.deepEqual(snapshot.flags, { truncated: true, redacted: true, unavailable: true });
  assert.equal(snapshot.turns.truncated, true);
  assert.equal(snapshot.plan.redacted, true);
  assert.equal(snapshot.git.unavailable, true);

  snapshot.flags.redacted = false;
  reseal(snapshot);
  assert.throws(() => validateEvidenceSnapshot(snapshot), expectCode("E_EVIDENCE_SNAPSHOT_INVALID"));
});
