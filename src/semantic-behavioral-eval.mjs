import { createHash } from "node:crypto";

import { buildCycleInput } from "./cycle-input.mjs";
import { buildEvidenceSnapshot } from "./evidence-snapshot.mjs";
import { CATEGORIES, SEVERITIES } from "./message-schema.mjs";
import { buildObserverAiPrompt, parseObserverAiOutput } from "./observer-ai-contract.mjs";
import { ObserverError, fail } from "./observer-error.mjs";

export const SEMANTIC_EVAL_SUITE_SCHEMA = "observer.semantic_behavioral_eval_suite.v1";
export const SEMANTIC_EVAL_REFERENCE_SCHEMA = "observer.semantic_behavioral_reference.v1";
export const SEMANTIC_EVAL_REPORT_SCHEMA = "observer.semantic_behavioral_eval_report.v1";

const CRITERIA = new Set([
  "healthy_progress",
  "preference_only",
  "general_advice",
  "evidence_missing",
  "already_addressed",
  "resolved",
  "material_verification_gap",
  "direct_contract_breach",
]);
const SUPPRESSION_CRITERIA = new Set([
  "healthy_progress",
  "preference_only",
  "general_advice",
  "evidence_missing",
  "already_addressed",
  "resolved",
]);
const CASE_ID = /^[a-z][a-z0-9_]{2,63}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const SEVERITY_RANK = Object.freeze({ info: 0, warning: 1, review_required: 2 });
const CASE_KEYS = Object.freeze(["criterion", "evidence", "expected", "id"]);
const EVIDENCE_KEYS = Object.freeze(["git", "plan", "tests", "turns"]);

export async function runSemanticBehavioralEval({ suite, childStart, evaluate } = {}) {
  const normalized = validateSemanticEvalSuite(suite);
  if (typeof evaluate !== "function") fail("E_SEMANTIC_EVAL_INPUT_INVALID", "semantic evaluator callbackが必要です");
  const runtimePrompt = buildObserverAiPrompt(childStart);
  const results = [];

  for (const fixture of normalized.cases) {
    const snapshot = snapshotFor(fixture, childStart);
    requireExpectedRefsAdmissible(fixture, snapshot);
    const cycleInput = buildCycleInput(snapshot);
    const raw = await evaluate({
      schema: "observer.semantic_eval_request.v1",
      runtime_prompt: runtimePrompt,
      cycle_input: cycleInput.value,
    }, { caseId: fixture.id, criterion: fixture.criterion });
    let output;
    try {
      output = parseObserverAiOutput(raw);
    } catch (error) {
      if (!(error instanceof ObserverError) || !error.code.startsWith("E_OBSERVER_AI_OUTPUT")) throw error;
      results.push(caseResult(fixture.id, ["output_invalid"]));
      continue;
    }
    results.push(caseResult(fixture.id, compareOutput(fixture, snapshot, output)));
  }

  const failed = results.filter((result) => result.outcome === "failed").length;
  return {
    schema: SEMANTIC_EVAL_REPORT_SCHEMA,
    total: results.length,
    passed: results.length - failed,
    failed,
    cases: results,
  };
}

export function validateSemanticEvalSuite(value) {
  plain(value, "semantic eval suite");
  exact(value, ["cases", "schema"], "semantic eval suite");
  if (value.schema !== SEMANTIC_EVAL_SUITE_SCHEMA || !Array.isArray(value.cases) || value.cases.length < 8) {
    invalid("semantic eval suite schemaまたはcase数が不正です");
  }
  const cases = value.cases.map(validateCase);
  if (new Set(cases.map((fixture) => fixture.id)).size !== cases.length) invalid("semantic eval case IDが重複しています");
  const criteria = new Set(cases.map((fixture) => fixture.criterion));
  for (const criterion of CRITERIA) if (!criteria.has(criterion)) invalid(`semantic eval criterionが不足しています: ${criterion}`);
  return { schema: SEMANTIC_EVAL_SUITE_SCHEMA, cases };
}

export function referenceEvaluatorFromOracle(value, suite) {
  const normalizedSuite = validateSemanticEvalSuite(suite);
  plain(value, "semantic eval reference", "E_SEMANTIC_EVAL_REFERENCE_INVALID");
  exact(value, ["outputs", "schema"], "semantic eval reference");
  if (value.schema !== SEMANTIC_EVAL_REFERENCE_SCHEMA || !Array.isArray(value.outputs)) {
    fail("E_SEMANTIC_EVAL_REFERENCE_INVALID", "semantic eval reference schemaが不正です");
  }
  const outputs = new Map();
  for (const entry of value.outputs) {
    plain(entry, "semantic eval reference output", "E_SEMANTIC_EVAL_REFERENCE_INVALID");
    exact(entry, ["case_id", "raw_output"], "semantic eval reference output", "E_SEMANTIC_EVAL_REFERENCE_INVALID");
    if (!CASE_ID.test(entry.case_id) || typeof entry.raw_output !== "string" || entry.raw_output.length === 0 ||
        Buffer.byteLength(entry.raw_output, "utf8") > 16 * 1024 || outputs.has(entry.case_id)) {
      fail("E_SEMANTIC_EVAL_REFERENCE_INVALID", "semantic eval reference outputが不正です");
    }
    outputs.set(entry.case_id, entry.raw_output);
  }
  const expectedIds = new Set(normalizedSuite.cases.map((fixture) => fixture.id));
  if (outputs.size !== expectedIds.size || [...outputs.keys()].some((caseId) => !expectedIds.has(caseId))) {
    fail("E_SEMANTIC_EVAL_REFERENCE_INVALID", "semantic eval reference case集合がsuiteと一致しません");
  }
  return async (_request, { caseId } = {}) => {
    if (!outputs.has(caseId)) fail("E_SEMANTIC_EVAL_REFERENCE_MISSING", "semantic eval reference outputがありません");
    return outputs.get(caseId);
  };
}

function validateCase(value) {
  plain(value, "semantic eval case");
  exact(value, CASE_KEYS, "semantic eval case");
  if (!CASE_ID.test(value.id) || !CRITERIA.has(value.criterion)) invalid("semantic eval case identityが不正です");
  const evidence = validateEvidence(value.evidence);
  const expected = validateExpected(value.expected, evidence);
  requireCriterionExpectation(value.criterion, expected);
  return { id: value.id, criterion: value.criterion, evidence, expected };
}

function requireCriterionExpectation(criterion, expected) {
  if (SUPPRESSION_CRITERIA.has(criterion) && expected.outcome !== "no_advisory") {
    invalid(`suppression criterionはno_advisoryである必要があります: ${criterion}`);
  }
  if (criterion === "material_verification_gap" &&
      (expected.outcome !== "advisory" || expected.category !== "verification_gap" ||
       SEVERITY_RANK[expected.min_severity] < SEVERITY_RANK.warning)) {
    invalid("material verification gapの期待契約が不正です");
  }
  if (criterion === "direct_contract_breach" &&
      (expected.outcome !== "advisory" || expected.category !== "acceptance_mismatch" ||
       expected.min_severity !== "review_required")) {
    invalid("direct contract breachの期待契約が不正です");
  }
}

function validateEvidence(value) {
  plain(value, "semantic eval evidence");
  exact(value, EVIDENCE_KEYS, "semantic eval evidence");
  for (const key of EVIDENCE_KEYS) if (!Array.isArray(value[key])) invalid(`semantic eval evidence.${key}がarrayではありません`);

  const turns = value.turns.map((entry) => exactStrings(entry, ["assistant", "completed_at", "user"], "turn", true));
  const plan = value.plan.map((entry) => exactStrings(entry, ["content", "ref"], "plan"));
  const git = value.git.map((entry) => exactStrings(entry, ["content", "ref"], "git"));
  const tests = value.tests.map((entry) => {
    const normalized = exactStrings(entry, ["command_ref", "observed_at", "outcome", "ref"], "test", true);
    if (!["passed", "failed", "skipped"].includes(normalized.outcome)) invalid("semantic eval test outcomeが不正です");
    return normalized;
  });
  const refs = [...plan, ...git, ...tests].map((entry) => entry.ref);
  if (new Set(refs).size !== refs.length) invalid("semantic eval evidence refが重複しています");
  return { turns, plan, git, tests };
}

function validateExpected(value, evidence) {
  plain(value, "semantic eval expected");
  if (value.outcome === "no_advisory") {
    exact(value, ["outcome"], "no_advisory expected");
    return { outcome: "no_advisory" };
  }
  exact(value, ["category", "evidence_refs", "min_severity", "outcome"], "advisory expected");
  if (value.outcome !== "advisory" || !CATEGORIES.includes(value.category) || !SEVERITIES.includes(value.min_severity) ||
      !Array.isArray(value.evidence_refs) || value.evidence_refs.length === 0 ||
      value.evidence_refs.some((ref) => typeof ref !== "string") ||
      new Set(value.evidence_refs).size !== value.evidence_refs.length) invalid("semantic eval advisory expectedが不正です");
  const availableRefs = new Set([...evidence.plan, ...evidence.git, ...evidence.tests].map((entry) => entry.ref));
  if (value.evidence_refs.some((ref) => !availableRefs.has(ref))) invalid("semantic eval expected refがevidenceにありません");
  return {
    outcome: "advisory",
    category: value.category,
    min_severity: value.min_severity,
    evidence_refs: [...value.evidence_refs],
  };
}

function snapshotFor(fixture, childStart) {
  const parentThread = sha256(`parent:${fixture.id}`);
  const cycleHex = sha256(`cycle:${fixture.id}`);
  const context = {
    target_id: childStart.target_id,
    watch_id: childStart.watch_id,
    parent_host: childStart.provider,
    parent_thread_sha256: parentThread,
    cycle_id: `c_${cycleHex}`,
    after_cursor_sha256: sha256(`after:${fixture.id}`),
    through_cursor_sha256: sha256(`through:${fixture.id}`),
  };
  return buildEvidenceSnapshot({
    context,
    turns: fixture.evidence.turns.map((entry, index) => ({
      user: entry.user,
      assistant: entry.assistant,
      user_sha256: sha256(entry.user),
      assistant_sha256: sha256(entry.assistant),
      origin_sha256: sha256(`origin:${fixture.id}:${index}`),
      source_sha256: sha256(`turn:${fixture.id}:${index}`),
      thread_sha256: parentThread,
      host: childStart.provider,
      completed_at: entry.completed_at,
      truncated: false,
    })),
    plan: fixture.evidence.plan.map((entry) => contentEvidence(fixture.id, "plan", entry)),
    git: fixture.evidence.git.map((entry) => contentEvidence(fixture.id, "git", entry)),
    tests: fixture.evidence.tests.map((entry) => ({
      ref: entry.ref,
      source_digest: digest(`test:${fixture.id}:${entry.ref}:${entry.command_ref}:${entry.outcome}`),
      available: true,
      command_ref: entry.command_ref,
      outcome: entry.outcome,
      observed_at: entry.observed_at,
      unavailable_code: null,
    })),
  });
}

function contentEvidence(caseId, section, entry) {
  return {
    ref: entry.ref,
    source_digest: digest(`${section}:${caseId}:${entry.ref}:${entry.content}`),
    available: true,
    content: entry.content,
    unavailable_code: null,
  };
}

function compareOutput(fixture, snapshot, output) {
  const reasons = [];
  if (output.outcome !== fixture.expected.outcome) reasons.push("outcome_mismatch");
  if (output.outcome !== "advisory") return reasons;
  const admissibleRefs = new Set([
    ...snapshot.turns.entries,
    ...snapshot.plan.entries,
    ...snapshot.git.entries,
    ...snapshot.tests.entries,
  ].filter((entry) => entry.available && !entry.truncated && !entry.redacted).map((entry) => entry.ref));
  if (new Set(output.proposal.evidence_refs).size !== output.proposal.evidence_refs.length ||
      output.proposal.evidence_refs.some((ref) => !admissibleRefs.has(ref))) reasons.push("inadmissible_evidence_ref");
  if (fixture.expected.outcome !== "advisory") return reasons;
  if (output.proposal.category !== fixture.expected.category) reasons.push("category_mismatch");
  if (SEVERITY_RANK[output.proposal.severity] < SEVERITY_RANK[fixture.expected.min_severity]) {
    reasons.push("severity_below_minimum");
  }
  if (fixture.expected.evidence_refs.some((ref) => !output.proposal.evidence_refs.includes(ref))) {
    reasons.push("evidence_ref_missing");
  }
  return [...new Set(reasons)].sort();
}

function requireExpectedRefsAdmissible(fixture, snapshot) {
  if (fixture.expected.outcome !== "advisory") return;
  const admissibleRefs = new Set([
    ...snapshot.turns.entries,
    ...snapshot.plan.entries,
    ...snapshot.git.entries,
    ...snapshot.tests.entries,
  ].filter((entry) => entry.available && !entry.truncated && !entry.redacted).map((entry) => entry.ref));
  if (fixture.expected.evidence_refs.some((ref) => !admissibleRefs.has(ref))) {
    invalid("semantic eval expected refがadmissible snapshot evidenceではありません");
  }
}

function caseResult(caseId, reasons) {
  return {
    case_id: caseId,
    outcome: reasons.length === 0 ? "passed" : "failed",
    reason_codes: [...reasons],
  };
}

function exactStrings(value, keys, field, timestampFields = false) {
  plain(value, `semantic eval ${field}`);
  exact(value, keys, `semantic eval ${field}`);
  for (const key of keys) {
    if (typeof value[key] !== "string" || value[key].length === 0) invalid(`semantic eval ${field}.${key}が不正です`);
  }
  const normalized = structuredClone(value);
  if (timestampFields) {
    for (const key of keys.filter((name) => name.endsWith("_at"))) {
      if (!Number.isFinite(Date.parse(value[key])) || new Date(value[key]).toISOString() !== value[key]) {
        invalid(`semantic eval ${field}.${key} timestampが不正です`);
      }
    }
  }
  return normalized;
}

function plain(value, field, code = "E_SEMANTIC_EVAL_SUITE_INVALID") {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail(code, `${field}はplain objectである必要があります`);
  }
}

function exact(value, keys, field, code = "E_SEMANTIC_EVAL_SUITE_INVALID") {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(code, `${field}に未知または不足fieldがあります`);
  }
}

function invalid(message) {
  fail("E_SEMANTIC_EVAL_SUITE_INVALID", message);
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function digest(value) {
  const result = `sha256:${sha256(value)}`;
  if (!DIGEST.test(result)) fail("E_SEMANTIC_EVAL_SUITE_INVALID", "semantic eval digestを生成できません");
  return result;
}
