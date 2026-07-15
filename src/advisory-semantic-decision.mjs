import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";

import { buildCycleInput } from "./cycle-input.mjs";
import { validateEvidenceSnapshot } from "./evidence-snapshot.mjs";
import { CATEGORIES } from "./message-schema.mjs";
import { observerAiOutputDigest, parseObserverAiOutput } from "./observer-ai-contract.mjs";
import { fail } from "./observer-error.mjs";
import {
  acquirePrivateLock,
  atomicCreatePrivateFile,
  atomicReplacePrivateFile,
  ensureStatePath,
  inspectPrivateLock,
  readPrivateJson,
  recoverPrivateLock,
  removePrivateFile,
} from "./private-state.mjs";

export const ADVISORY_DECISION_SCHEMA = "observer.advisory_semantic_decision.v1";
export const ADVISORY_HISTORY_SCHEMA = "observer.advisory_semantic_history.v1";
export const ADVISORY_COOLDOWN_MS = 60 * 60 * 1000;
export const ADVISORY_HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const ADVISORY_HISTORY_MAX_ENTRIES = 1000;

const HISTORY_MAX_BYTES = 1024 * 1024;
const TARGET = /^p_[a-f0-9]{64}$/;
const WATCH = /^w_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const HEX = /^[a-f0-9]{64}$/;
const CYCLE = /^c_[a-f0-9]{64}$/;
const STATUSES = new Set(["accepted_pending_publish", "accepted_published", "suppressed"]);
const DECISIONS = new Set(["accepted", "suppressed"]);
const REASONS = new Set(["eligible", "evidence_ineligible", "cooldown_active"]);
const SEVERITY_RANK = Object.freeze({ info: 0, warning: 1, review_required: 2 });
const CATEGORY_SET = new Set(CATEGORIES);
const OPERATION_KEYS = Object.freeze([
  "cycle_id",
  "generation_id",
  "input_digest",
  "operation_id",
  "output_digest",
  "target_id",
  "watch_id",
]);
const CURRENT_KEYS = Object.freeze([
  ...OPERATION_KEYS,
  "basis_digest",
  "category",
  "cooldown_until",
  "decided_at",
  "decision",
  "decision_digest",
  "dedupe_key_digest",
  "evidence_fingerprint",
  "proposal_digest",
  "reason",
  "result_digest",
  "schema",
  "severity",
  "status",
  "updated_at",
]);
const HISTORY_ENTRY_KEYS = Object.freeze([
  ...CURRENT_KEYS.filter((key) => !["schema", "status", "updated_at"].includes(key)),
  "finalized_at",
]);

export async function prepareAdvisoryDecision({
  stateRoot,
  operation,
  proposal,
  snapshot,
  candidateResultDigest,
  now = new Date(),
} = {}, dependencies = {}) {
  const input = normalizePreparation({ stateRoot, operation, proposal, snapshot, candidateResultDigest, now });
  const paths = await pathsFor(stateRoot, operation.target_id);
  return transaction(paths, dependencies, async () => {
    const current = await readCurrent(paths.current, dependencies);
    const history = await readHistory(paths.history, dependencies);
    requireClockNotBefore(input.now, current, history.entries);

    if (current !== null) {
      requireCurrentReplay(current, input);
      return publicCurrent(current);
    }

    const prior = latestAccepted(history.entries, input.dedupeKeyDigest);
    const activeCooldown = prior !== null && Date.parse(prior.cooldown_until) > input.now.getTime();
    const escalated = prior !== null && SEVERITY_RANK[input.proposal.severity] > SEVERITY_RANK[prior.severity];
    let decision = "accepted";
    let reason = "eligible";
    let status = "accepted_pending_publish";
    let resultDigest = candidateResultDigest;
    let cooldownUntil = new Date(input.now.getTime() + cooldownMs(dependencies)).toISOString();
    let basisDigest = prior?.decision_digest ?? null;

    if (!input.evidence.eligible) {
      decision = "suppressed";
      reason = "evidence_ineligible";
      status = "suppressed";
      cooldownUntil = null;
      basisDigest = null;
      resultDigest = suppressionResultDigest(input, reason, basisDigest);
    } else if (activeCooldown && !escalated) {
      decision = "suppressed";
      reason = "cooldown_active";
      status = "suppressed";
      cooldownUntil = prior.cooldown_until;
      resultDigest = suppressionResultDigest(input, reason, basisDigest);
    }

    const currentValue = validateCurrent(withDecisionDigest({
      schema: ADVISORY_DECISION_SCHEMA,
      ...input.operation,
      proposal_digest: input.proposalDigest,
      dedupe_key_digest: input.dedupeKeyDigest,
      evidence_fingerprint: input.evidence.fingerprint,
      category: input.proposal.category,
      severity: input.proposal.severity,
      decision,
      reason,
      status,
      basis_digest: basisDigest,
      result_digest: resultDigest,
      decided_at: input.now.toISOString(),
      updated_at: input.now.toISOString(),
      cooldown_until: cooldownUntil,
    }));
    await createFile(paths.current, serialize(currentValue), dependencies);
    return publicCurrent(currentValue);
  });
}

export async function confirmAdvisoryPublished({
  stateRoot,
  targetId,
  operationId,
  publishResult,
  now = new Date(),
} = {}, dependencies = {}) {
  validateTargetInput(stateRoot, targetId);
  requireDigest(operationId, "operation ID");
  const timestamp = requireDate(now);
  const paths = await pathsFor(stateRoot, targetId);
  return transaction(paths, dependencies, async () => {
    const current = await requireCurrent(paths.current, dependencies);
    requireClockNotBefore(timestamp, current, []);
    requirePublishResult(publishResult, current);
    if (current.operation_id !== operationId || current.target_id !== targetId || current.decision !== "accepted") {
      fail("E_ADVISORY_PUBLISH_MISMATCH", "publish receiptがcurrent decisionと一致しません");
    }
    if (current.status === "accepted_published") return publicCurrent(current);
    if (current.status !== "accepted_pending_publish") {
      fail("E_ADVISORY_PUBLISH_MISMATCH", "suppressed decisionをpublishedへ進められません");
    }
    const next = validateCurrent(withDecisionDigest({
      ...current,
      status: "accepted_published",
      updated_at: timestamp.toISOString(),
    }));
    await replaceFile(paths.current, serialize(next), dependencies);
    return publicCurrent(next);
  });
}

export async function preflightAdvisoryFinalization({
  stateRoot,
  targetId,
  operationId,
  resultDigest,
  now = new Date(),
} = {}, dependencies = {}) {
  const input = normalizeFinalization({ stateRoot, targetId, operationId, resultDigest, now });
  const paths = await pathsFor(stateRoot, targetId);
  return transaction(paths, dependencies, async () => {
    const current = await readCurrent(paths.current, dependencies);
    const history = await readHistory(paths.history, dependencies);
    requireClockNotBefore(input.now, current, history.entries);
    if (current === null) {
      finalizedReplay(history.entries, input);
      return preflightResult("already_finalized", history.entries.length, 0);
    }
    requireFinalizableCurrent(current, input);
    const existing = history.entries.find((entry) => entry.operation_id === input.operationId) ?? null;
    if (existing !== null) {
      requireHistoryMatchesCurrent(existing, current, input);
      return preflightResult("ready", history.entries.length, 0);
    }
    const plan = retentionPlan(history.entries, current, input.now, dependencies);
    return preflightResult("ready", plan.retained.length, history.entries.length - plan.retained.length);
  });
}

export async function finalizeAdvisoryDecision({
  stateRoot,
  targetId,
  operationId,
  resultDigest,
  now = new Date(),
} = {}, dependencies = {}) {
  const input = normalizeFinalization({ stateRoot, targetId, operationId, resultDigest, now });
  const paths = await pathsFor(stateRoot, targetId);
  return transaction(paths, dependencies, async () => {
    const current = await readCurrent(paths.current, dependencies);
    const history = await readHistory(paths.history, dependencies);
    requireClockNotBefore(input.now, current, history.entries);
    const existing = history.entries.find((entry) => entry.operation_id === operationId) ?? null;

    if (current === null) return finalizedReplay(history.entries, input);
    requireFinalizableCurrent(current, input);
    if (existing !== null) {
      requireHistoryMatchesCurrent(existing, current, input);
      await removeFile(paths.current, dependencies);
      return finalizationResult("recovered");
    }

    const plan = retentionPlan(history.entries, current, input.now, dependencies);
    const entry = historyEntry(current, input.now);
    const nextHistory = validateHistory({
      schema: ADVISORY_HISTORY_SCHEMA,
      entries: [...plan.retained, entry].sort(compareHistory),
    });
    await writeHistory(paths.history, nextHistory, history.exists, dependencies);
    await removeFile(paths.current, dependencies);
    return finalizationResult("finalized");
  });
}

export async function readCurrentAdvisoryDecision({ stateRoot, targetId } = {}, dependencies = {}) {
  validateTargetInput(stateRoot, targetId);
  const paths = await pathsFor(stateRoot, targetId);
  const current = await readCurrent(paths.current, dependencies);
  return current === null ? null : publicCurrent(current);
}

export async function readAdvisoryDecisionHistory({ stateRoot, targetId } = {}, dependencies = {}) {
  validateTargetInput(stateRoot, targetId);
  const paths = await pathsFor(stateRoot, targetId);
  const history = await readHistory(paths.history, dependencies);
  return structuredClone(history.value);
}

export async function inspectAdvisoryDecisionLock({ stateRoot, targetId } = {}) {
  validateTargetInput(stateRoot, targetId);
  const paths = await pathsFor(stateRoot, targetId);
  return inspectPrivateLock(paths.lock);
}

export async function recoverAdvisoryDecisionLock({ stateRoot, targetId, expectedNonce } = {}) {
  validateTargetInput(stateRoot, targetId);
  if (typeof expectedNonce !== "string" || expectedNonce.length === 0) {
    fail("E_ADVISORY_LOCK_NONCE_REQUIRED", "semantic decision lockのexpected nonceが必要です");
  }
  const paths = await pathsFor(stateRoot, targetId);
  return recoverPrivateLock(paths.lock, expectedNonce);
}

function normalizePreparation({ stateRoot, operation, proposal, snapshot, candidateResultDigest, now }) {
  validateTargetInput(stateRoot, operation?.target_id);
  requirePlain(operation, "operation", "E_ADVISORY_DECISION_INPUT_INVALID");
  requireExactKeys(operation, OPERATION_KEYS, "operation", "E_ADVISORY_DECISION_INPUT_INVALID");
  validateOperation(operation);
  if (typeof candidateResultDigest !== "string" || !HEX.test(candidateResultDigest)) {
    fail("E_ADVISORY_DECISION_INPUT_INVALID", "candidate result digestが不正です");
  }
  const output = parseObserverAiOutput(JSON.stringify({
    schema: "observer.ai_output.v1",
    outcome: "advisory",
    proposal,
  }));
  if (new Set(output.proposal.evidence_refs).size !== output.proposal.evidence_refs.length) {
    fail("E_ADVISORY_PROPOSAL_REF_DUPLICATE", "proposal evidence refが重複しています");
  }
  const outputDigest = `sha256:${observerAiOutputDigest(output)}`;
  if (operation.output_digest !== outputDigest) {
    fail("E_ADVISORY_DECISION_INPUT_INVALID", "operation output digestがproposalと一致しません");
  }
  validateEvidenceSnapshot(snapshot);
  if (snapshot.context.target_id !== operation.target_id || snapshot.context.watch_id !== operation.watch_id ||
      snapshot.context.cycle_id !== operation.cycle_id) {
    fail("E_ADVISORY_DECISION_INPUT_INVALID", "snapshot contextがoperation identityと一致しません");
  }
  if (buildCycleInput(snapshot).input_digest !== operation.input_digest) {
    fail("E_ADVISORY_DECISION_INPUT_INVALID", "snapshot digestがoperation input digestと一致しません");
  }
  const evidence = evidenceAdmissibility(output.proposal, snapshot);
  const timestamp = requireDate(now);
  return {
    now: timestamp,
    operation: structuredClone(operation),
    candidateResultDigest,
    proposal: output.proposal,
    proposalDigest: hashValue("observer.advisory-proposal.v1", output.proposal),
    dedupeKeyDigest: hashValue("observer.advisory-dedupe-key.v1", output.proposal.dedupe_key),
    evidence,
  };
}

function normalizeFinalization({ stateRoot, targetId, operationId, resultDigest, now }) {
  validateTargetInput(stateRoot, targetId);
  requireDigest(operationId, "operation ID");
  if (typeof resultDigest !== "string" || !HEX.test(resultDigest)) {
    fail("E_ADVISORY_FINALIZE_INVALID", "finalization result digestが不正です");
  }
  return { targetId, operationId, resultDigest, now: requireDate(now) };
}

function evidenceAdmissibility(proposal, snapshot) {
  const entries = [];
  for (const section of ["turns", "plan", "git", "tests"]) {
    for (const entry of snapshot[section].entries) entries.push({ section, entry });
  }
  const refs = entries.map(({ entry }) => entry.ref);
  if (new Set(refs).size !== refs.length) {
    fail("E_ADVISORY_SNAPSHOT_REF_AMBIGUOUS", "snapshot evidence refが一意ではありません");
  }
  const byRef = new Map(entries.map((value) => [value.entry.ref, value]));
  const chosen = proposal.evidence_refs.map((ref) => byRef.get(ref) ?? null);
  const eligible = chosen.every((value) => value !== null && value.entry.available === true &&
    value.entry.truncated === false && value.entry.redacted === false);
  if (!eligible) return { eligible: false, fingerprint: null };
  const tuples = chosen
    .map(({ section, entry }) => ({ section, ref: entry.ref, source_digest: entry.source_digest }))
    .sort((left, right) => left.section.localeCompare(right.section) || left.ref.localeCompare(right.ref));
  return { eligible: true, fingerprint: hashValue("observer.advisory-evidence.v1", tuples) };
}

function suppressionResultDigest(input, reason, basisDigest) {
  return hashValue("observer.advisory-suppression.v1", {
    operation_id: input.operation?.operation_id,
    proposal_digest: input.proposalDigest,
    evidence_fingerprint: input.evidence.fingerprint,
    reason,
    basis_digest: basisDigest,
  }).slice("sha256:".length);
}

function latestAccepted(entries, dedupeKeyDigest) {
  return entries
    .filter((entry) => entry.decision === "accepted" && entry.dedupe_key_digest === dedupeKeyDigest)
    .sort((left, right) => right.decided_at.localeCompare(left.decided_at) ||
      right.operation_id.localeCompare(left.operation_id))[0] ?? null;
}

function retentionPlan(entries, current, now, dependencies) {
  const retention = retentionMs(dependencies);
  const maximum = maxHistory(dependencies);
  const cutoff = now.getTime() - retention;
  let retained = entries.filter((entry) => {
    const activeCooldown = entry.decision === "accepted" && Date.parse(entry.cooldown_until) > now.getTime();
    return activeCooldown || Date.parse(entry.finalized_at) >= cutoff;
  });
  retained.sort(compareHistory);
  while (retained.length >= maximum) {
    const removable = retained.findIndex((entry) =>
      !(entry.decision === "accepted" && Date.parse(entry.cooldown_until) > now.getTime()));
    if (removable === -1) {
      fail("E_ADVISORY_HISTORY_SATURATED", "active cooldown receiptだけでsemantic historyが飽和しています");
    }
    retained.splice(removable, 1);
  }
  if (current === null) fail("E_ADVISORY_FINALIZE_INVALID", "current decisionがありません");
  return { retained };
}

function requireCurrentReplay(current, input) {
  const expected = {
    target_id: input.operation?.target_id,
    watch_id: input.operation?.watch_id,
    generation_id: input.operation?.generation_id,
    cycle_id: input.operation?.cycle_id,
    input_digest: input.operation?.input_digest,
    output_digest: input.operation?.output_digest,
    operation_id: input.operation?.operation_id,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (current[key] !== value) fail("E_ADVISORY_DECISION_REPLAY_CONFLICT", "current decision identityが一致しません");
  }
  if (current.proposal_digest !== input.proposalDigest || current.dedupe_key_digest !== input.dedupeKeyDigest ||
      current.evidence_fingerprint !== input.evidence.fingerprint || current.category !== input.proposal.category ||
      current.severity !== input.proposal.severity) {
    fail("E_ADVISORY_DECISION_REPLAY_CONFLICT", "current decision inputが一致しません");
  }
  if (current.decision === "accepted" && current.result_digest !== input.candidateResultDigest) {
    fail("E_ADVISORY_DECISION_REPLAY_CONFLICT", "current decision result digestが一致しません");
  }
}

function requirePublishResult(value, current) {
  requirePlain(value, "publish result", "E_ADVISORY_PUBLISH_MISMATCH");
  const expectedKeys = ["contentDigest", "messageId", "operationId", "status", "targetId"];
  requireExactKeys(value, expectedKeys, "publish result", "E_ADVISORY_PUBLISH_MISMATCH");
  const messageId = `obs-${current.operation_id.slice("sha256:".length)}`;
  if (value.operationId !== current.operation_id || value.messageId !== messageId ||
      value.targetId !== current.target_id || value.contentDigest !== `sha256:${current.result_digest}` ||
      value.status !== "published") {
    fail("E_ADVISORY_PUBLISH_MISMATCH", "publish resultがcurrent decisionと一致しません");
  }
}

function requireFinalizableCurrent(current, input) {
  if (current.target_id !== input.targetId || current.operation_id !== input.operationId ||
      current.result_digest !== input.resultDigest || !["accepted_published", "suppressed"].includes(current.status)) {
    fail("E_ADVISORY_FINALIZE_INVALID", "current decisionをfinalizeできません");
  }
}

function finalizedReplay(entries, input) {
  const matches = entries.filter((entry) => entry.operation_id === input.operationId);
  if (matches.length === 0) fail("E_ADVISORY_DECISION_NOT_FOUND", "semantic decisionがありません");
  if (matches.length !== 1 || matches[0].target_id !== input.targetId || matches[0].result_digest !== input.resultDigest) {
    fail("E_ADVISORY_FINALIZE_CONFLICT", "finalized decisionが要求identityと一致しません");
  }
  return finalizationResult("already_finalized");
}

function requireHistoryMatchesCurrent(entry, current, input) {
  if (entry.target_id !== input.targetId || entry.operation_id !== input.operationId ||
      entry.result_digest !== input.resultDigest) {
    fail("E_ADVISORY_FINALIZE_CONFLICT", "history decisionが要求identityと一致しません");
  }
  for (const key of HISTORY_ENTRY_KEYS.filter((key) => key !== "finalized_at")) {
    if (entry[key] !== current[key]) fail("E_ADVISORY_FINALIZE_CONFLICT", "historyとcurrent decisionが一致しません");
  }
}

function historyEntry(current, now) {
  const value = {};
  for (const key of HISTORY_ENTRY_KEYS) {
    value[key] = key === "finalized_at" ? now.toISOString() : current[key];
  }
  return validateHistoryEntry(value);
}

function withDecisionDigest(value) {
  const content = { ...value, decision_digest: null };
  content.decision_digest = decisionDigest(content);
  return content;
}

function decisionDigest(value) {
  const immutable = {};
  for (const key of HISTORY_ENTRY_KEYS) {
    if (!["decision_digest", "finalized_at"].includes(key)) immutable[key] = value[key];
  }
  return hashValue("observer.advisory-decision.v1", immutable);
}

function validateCurrent(value) {
  requirePlain(value, "current decision", "E_ADVISORY_DECISION_STATE_INVALID");
  requireExactKeys(value, CURRENT_KEYS, "current decision", "E_ADVISORY_DECISION_STATE_INVALID");
  if (value.schema !== ADVISORY_DECISION_SCHEMA || !STATUSES.has(value.status)) stateInvalid();
  validateSharedDecision(value);
  if (value.status.startsWith("accepted") !== (value.decision === "accepted")) stateInvalid();
  if ((value.decision === "accepted") !== (value.reason === "eligible")) stateInvalid();
  if (value.decision === "accepted" && value.cooldown_until === null) stateInvalid();
  if (value.reason === "evidence_ineligible" && value.evidence_fingerprint !== null) stateInvalid();
  timestamp(value.updated_at);
  if (Date.parse(value.updated_at) < Date.parse(value.decided_at)) stateInvalid();
  const expected = decisionDigest(value);
  if (value.decision_digest !== expected) stateInvalid();
  return value;
}

function validateHistory(value) {
  requirePlain(value, "semantic history", "E_ADVISORY_HISTORY_INVALID");
  requireExactKeys(value, ["entries", "schema"], "semantic history", "E_ADVISORY_HISTORY_INVALID");
  if (value.schema !== ADVISORY_HISTORY_SCHEMA || !Array.isArray(value.entries) ||
      value.entries.length > ADVISORY_HISTORY_MAX_ENTRIES) {
    fail("E_ADVISORY_HISTORY_INVALID", "semantic history schemaが不正です");
  }
  const entries = value.entries.map(validateHistoryEntry);
  if (new Set(entries.map((entry) => entry.operation_id)).size !== entries.length) {
    fail("E_ADVISORY_HISTORY_INVALID", "semantic history operation IDが重複しています");
  }
  for (let index = 1; index < entries.length; index += 1) {
    if (compareHistory(entries[index - 1], entries[index]) > 0) {
      fail("E_ADVISORY_HISTORY_INVALID", "semantic historyがfinalized_at順ではありません");
    }
  }
  return { schema: ADVISORY_HISTORY_SCHEMA, entries };
}

function validateHistoryEntry(value) {
  requirePlain(value, "history entry", "E_ADVISORY_HISTORY_INVALID");
  requireExactKeys(value, HISTORY_ENTRY_KEYS, "history entry", "E_ADVISORY_HISTORY_INVALID");
  validateSharedDecision(value);
  if (value.decision_digest !== decisionDigest(value)) {
    fail("E_ADVISORY_HISTORY_INVALID", "history decision digestが一致しません");
  }
  timestamp(value.finalized_at);
  if (Date.parse(value.finalized_at) < Date.parse(value.decided_at)) {
    fail("E_ADVISORY_HISTORY_INVALID", "history finalized_atがdecisionより前です");
  }
  return value;
}

function validateSharedDecision(value) {
  validateOperation(value);
  for (const key of ["proposal_digest", "dedupe_key_digest", "decision_digest"]) requireDigest(value[key], key);
  if (value.evidence_fingerprint !== null) requireDigest(value.evidence_fingerprint, "evidence fingerprint");
  if (value.basis_digest !== null) requireDigest(value.basis_digest, "basis digest");
  if (!Object.hasOwn(SEVERITY_RANK, value.severity) || !CATEGORY_SET.has(value.category) ||
      !DECISIONS.has(value.decision) || !REASONS.has(value.reason) || typeof value.result_digest !== "string" ||
      !HEX.test(value.result_digest)) stateInvalid();
  timestamp(value.decided_at);
  if (value.cooldown_until !== null) {
    timestamp(value.cooldown_until);
    if (Date.parse(value.cooldown_until) <= Date.parse(value.decided_at)) stateInvalid();
  }
  if (value.reason === "eligible" && (value.decision !== "accepted" || value.evidence_fingerprint === null ||
      value.cooldown_until === null)) stateInvalid();
  if (value.reason === "evidence_ineligible" && (value.decision !== "suppressed" ||
      value.evidence_fingerprint !== null || value.basis_digest !== null || value.cooldown_until !== null)) stateInvalid();
  if (value.reason === "cooldown_active" && (value.decision !== "suppressed" ||
      value.evidence_fingerprint === null || value.basis_digest === null || value.cooldown_until === null)) stateInvalid();
}

function validateOperation(value) {
  if (!TARGET.test(value.target_id) || !WATCH.test(value.watch_id) || !DIGEST.test(value.generation_id) ||
      !CYCLE.test(value.cycle_id) || !DIGEST.test(value.input_digest) || !DIGEST.test(value.output_digest) ||
      !DIGEST.test(value.operation_id)) {
    fail("E_ADVISORY_DECISION_INPUT_INVALID", "semantic decision operation identityが不正です");
  }
}

function requireClockNotBefore(now, current, entries) {
  const times = entries.flatMap((entry) => [entry.decided_at, entry.finalized_at]);
  if (current !== null) times.push(current.decided_at, current.updated_at);
  if (times.some((value) => Date.parse(value) > now.getTime())) {
    fail("E_ADVISORY_CLOCK_ROLLBACK", "semantic decision clockが耐久stateより後退しています");
  }
}

async function pathsFor(stateRoot, targetId) {
  const directory = await ensureStatePath(stateRoot, "watches", targetId);
  return {
    current: join(directory, "semantic-decision.json"),
    history: join(directory, "semantic-history.json"),
    lock: join(directory, "semantic-decision.lock"),
  };
}

async function transaction(paths, dependencies, operation) {
  const acquire = dependencies.acquirePrivateLock ?? acquirePrivateLock;
  const release = await acquire(paths.lock);
  try {
    return await operation();
  } finally {
    await release();
  }
}

async function readCurrent(path, dependencies) {
  const value = await readOptional(path, dependencies);
  return value === null ? null : validateCurrent(value);
}

async function requireCurrent(path, dependencies) {
  const current = await readCurrent(path, dependencies);
  if (current === null) fail("E_ADVISORY_DECISION_NOT_FOUND", "current semantic decisionがありません");
  return current;
}

async function readHistory(path, dependencies) {
  const value = await readOptional(path, dependencies);
  if (value === null) {
    const empty = { schema: ADVISORY_HISTORY_SCHEMA, entries: [] };
    return { exists: false, value: empty, entries: empty.entries };
  }
  const history = validateHistory(value);
  return { exists: true, value: history, entries: history.entries };
}

async function readOptional(path, dependencies) {
  const read = dependencies.readPrivateJson ?? readPrivateJson;
  try {
    return await read(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function writeHistory(path, history, exists, dependencies) {
  const serialized = serialize(history);
  if (Buffer.byteLength(serialized, "utf8") > HISTORY_MAX_BYTES) {
    fail("E_ADVISORY_HISTORY_SATURATED", "semantic history byte上限を超えています");
  }
  if (exists) return replaceFile(path, serialized, dependencies);
  return createFile(path, serialized, dependencies);
}

function createFile(path, data, dependencies) {
  return (dependencies.atomicCreatePrivateFile ?? atomicCreatePrivateFile)(path, data);
}

function replaceFile(path, data, dependencies) {
  return (dependencies.atomicReplacePrivateFile ?? atomicReplacePrivateFile)(path, data);
}

function removeFile(path, dependencies) {
  return (dependencies.removePrivateFile ?? removePrivateFile)(path);
}

function validateTargetInput(stateRoot, targetId) {
  if (typeof stateRoot !== "string" || !isAbsolute(stateRoot) || typeof targetId !== "string" || !TARGET.test(targetId)) {
    fail("E_ADVISORY_DECISION_INPUT_INVALID", "semantic decision state rootまたはtargetが不正です");
  }
}

function requireDate(value) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    fail("E_ADVISORY_CLOCK_INVALID", "semantic decision clockが不正です");
  }
  return value;
}

function timestamp(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    stateInvalid();
  }
}

function requireDigest(value, field) {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    fail("E_ADVISORY_DECISION_INPUT_INVALID", `${field}が不正です`);
  }
}

function requirePlain(value, field, code) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail(code, `${field}はplain objectである必要があります`);
  }
}

function requireExactKeys(value, keys, field, code) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(code, `${field}に未知または不足fieldがあります`);
  }
}

function stateInvalid() {
  fail("E_ADVISORY_DECISION_STATE_INVALID", "semantic decision stateが不正です");
}

function publicCurrent(value) {
  return structuredClone(value);
}

function finalizationResult(outcome) {
  return { schema: "observer.advisory_finalization.v1", outcome };
}

function preflightResult(outcome, retainedCount, removedCount) {
  return {
    schema: "observer.advisory_finalization_preflight.v1",
    outcome,
    retained_count: retainedCount,
    removed_count: removedCount,
  };
}

function compareHistory(left, right) {
  return left.finalized_at.localeCompare(right.finalized_at) || left.operation_id.localeCompare(right.operation_id);
}

function cooldownMs(dependencies) {
  const value = dependencies.cooldownMs ?? ADVISORY_COOLDOWN_MS;
  if (!Number.isSafeInteger(value) || value <= 0) fail("E_ADVISORY_POLICY_INVALID", "cooldown設定が不正です");
  return value;
}

function retentionMs(dependencies) {
  const value = dependencies.retentionMs ?? ADVISORY_HISTORY_RETENTION_MS;
  if (!Number.isSafeInteger(value) || value <= 0) fail("E_ADVISORY_POLICY_INVALID", "retention設定が不正です");
  return value;
}

function maxHistory(dependencies) {
  const value = dependencies.maxHistory ?? ADVISORY_HISTORY_MAX_ENTRIES;
  if (!Number.isSafeInteger(value) || value <= 0 || value > ADVISORY_HISTORY_MAX_ENTRIES) {
    fail("E_ADVISORY_POLICY_INVALID", "history cap設定が不正です");
  }
  return value;
}

function hashValue(domain, value) {
  return `sha256:${createHash("sha256").update(`${domain}\0${canonicalize(value)}`, "utf8").digest("hex")}`;
}

function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function serialize(value) {
  return `${JSON.stringify(value)}\n`;
}
