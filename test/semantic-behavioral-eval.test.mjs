import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { ObserverError } from "../src/observer-error.mjs";
import {
  SEMANTIC_EVAL_REPORT_SCHEMA,
  referenceEvaluatorFromOracle,
  runSemanticBehavioralEval,
  validateSemanticEvalSuite,
} from "../src/semantic-behavioral-eval.mjs";

const SUITE_URL = new URL("./fixtures/semantic-behavioral-suite.json", import.meta.url);
const REFERENCE_URL = new URL("./fixtures/semantic-behavioral-reference.json", import.meta.url);
const CHILD_START = Object.freeze({
  schema: "observer.child_start.v1",
  provider: "codex",
  target_id: `p_${"a".repeat(64)}`,
  watch_id: "w_11111111-1111-4111-8111-111111111111",
  project_root: "/tmp/semantic-eval-project",
  runtime_root: "/tmp/semantic-eval-runtime",
  mode: "observe",
});

async function fixture(url) {
  return JSON.parse(await readFile(url, "utf8"));
}

function expectCode(code) {
  return (error) => error instanceof ObserverError && error.code === code;
}

function replaceOutput(reference, caseId, transform) {
  const changed = structuredClone(reference);
  const entry = changed.outputs.find((value) => value.case_id === caseId);
  entry.raw_output = transform(entry.raw_output);
  return changed;
}

async function reportFor(reference) {
  const suite = await fixture(SUITE_URL);
  return runSemanticBehavioralEval({
    suite,
    childStart: CHILD_START,
    evaluate: referenceEvaluatorFromOracle(reference, suite),
  });
}

test("8-case reference oracleはsuppression 6種とadvisory 2種をstrict greenにする", async () => {
  const suite = await fixture(SUITE_URL);
  const reference = await fixture(REFERENCE_URL);
  const report = await runSemanticBehavioralEval({
    suite,
    childStart: CHILD_START,
    evaluate: referenceEvaluatorFromOracle(reference, suite),
  });

  assert.equal(report.schema, SEMANTIC_EVAL_REPORT_SCHEMA);
  assert.deepEqual({ total: report.total, passed: report.passed, failed: report.failed }, {
    total: 8,
    passed: 8,
    failed: 0,
  });
  assert.equal(report.cases.filter((entry) => entry.outcome === "passed").length, 8);
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes("raw_output"), false);
  assert.equal(serialized.includes("runtime_prompt"), false);
  assert.equal(serialized.includes("cycle_input"), false);
  assert.equal(serialized.includes("credential fileがstage"), false);
});

test("evaluator requestは固定promptとcanonical cycle request一件だけを渡す", async () => {
  const requests = [];
  const suite = await fixture(SUITE_URL);
  const reference = referenceEvaluatorFromOracle(await fixture(REFERENCE_URL), suite);
  const report = await runSemanticBehavioralEval({
    suite,
    childStart: CHILD_START,
    evaluate: async (request, metadata) => {
      requests.push(request);
      assert.deepEqual(Object.keys(metadata).sort(), ["caseId", "criterion"]);
      return reference(request, metadata);
    },
  });
  assert.equal(report.failed, 0);
  assert.equal(requests.length, 8);
  for (const request of requests) {
    assert.deepEqual(Object.keys(request).sort(), ["cycle_input", "runtime_prompt", "schema"]);
    assert.equal(request.schema, "observer.semantic_eval_request.v1");
    const cycle = JSON.parse(request.cycle_input);
    assert.equal(cycle.schema, "observer.cycle_request.v1");
    assert.equal(cycle.instruction, "analyze_evidence_snapshot");
    assert.match(request.runtime_prompt, /既定はno_advisory/);
    assert.match(request.runtime_prompt, /親が認識して具体的な対処を開始していません/);
    assert.match(request.runtime_prompt, /単なる好み、別解、一般論/);
  }
});

test("suiteはcase網羅、exact field、一意ID、expected evidence refをfail closedにする", async () => {
  const suite = await fixture(SUITE_URL);
  assert.deepEqual(validateSemanticEvalSuite(suite), suite);

  const duplicate = structuredClone(suite);
  duplicate.cases[1].id = duplicate.cases[0].id;
  assert.throws(() => validateSemanticEvalSuite(duplicate), expectCode("E_SEMANTIC_EVAL_SUITE_INVALID"));

  const unknown = structuredClone(suite);
  unknown.cases[0].extra = true;
  assert.throws(() => validateSemanticEvalSuite(unknown), expectCode("E_SEMANTIC_EVAL_SUITE_INVALID"));

  const missingRef = structuredClone(suite);
  missingRef.cases.find((entry) => entry.id === "material_verification_gap").expected.evidence_refs = ["test:not-present"];
  assert.throws(() => validateSemanticEvalSuite(missingRef), expectCode("E_SEMANTIC_EVAL_SUITE_INVALID"));

  const missingCriterion = structuredClone(suite);
  missingCriterion.cases = missingCriterion.cases.filter((entry) => entry.criterion !== "preference_only");
  assert.throws(() => validateSemanticEvalSuite(missingCriterion), expectCode("E_SEMANTIC_EVAL_SUITE_INVALID"));

  const invertedSuppression = structuredClone(suite);
  invertedSuppression.cases.find((entry) => entry.id === "preference_only").expected = structuredClone(
    suite.cases.find((entry) => entry.id === "material_verification_gap").expected,
  );
  assert.throws(() => validateSemanticEvalSuite(invertedSuppression), expectCode("E_SEMANTIC_EVAL_SUITE_INVALID"));

  const weakenedContract = structuredClone(suite);
  weakenedContract.cases.find((entry) => entry.id === "direct_contract_breach").expected.min_severity = "warning";
  assert.throws(() => validateSemanticEvalSuite(weakenedContract), expectCode("E_SEMANTIC_EVAL_SUITE_INVALID"));

  const redactedExpected = structuredClone(suite);
  redactedExpected.cases.find((entry) => entry.id === "direct_contract_breach").evidence.git[0].content +=
    ` sk-proj-${"x".repeat(24)}`;
  await assert.rejects(runSemanticBehavioralEval({
    suite: redactedExpected,
    childStart: CHILD_START,
    evaluate: referenceEvaluatorFromOracle(await fixture(REFERENCE_URL), redactedExpected),
  }), expectCode("E_SEMANTIC_EVAL_SUITE_INVALID"));
});

test("outcome/category/severity/evidence ref mutationをcase failureとして検出する", async (context) => {
  const reference = await fixture(REFERENCE_URL);
  const noAdvisory = JSON.stringify({ schema: "observer.ai_output.v1", outcome: "no_advisory" });

  const mutations = [
    {
      name: "suppression outcome",
      caseId: "healthy_progress",
      reason: "outcome_mismatch",
      transform: () => reference.outputs.find((entry) => entry.case_id === "material_verification_gap").raw_output,
    },
    {
      name: "required advisory outcome",
      caseId: "material_verification_gap",
      reason: "outcome_mismatch",
      transform: () => noAdvisory,
    },
    {
      name: "category",
      caseId: "material_verification_gap",
      reason: "category_mismatch",
      transform: (raw) => raw.replace('"category":"verification_gap"', '"category":"plan_drift"'),
    },
    {
      name: "severity",
      caseId: "material_verification_gap",
      reason: "severity_below_minimum",
      transform: (raw) => raw.replace('"severity":"warning"', '"severity":"info"'),
    },
    {
      name: "evidence ref",
      caseId: "material_verification_gap",
      reason: "evidence_ref_missing",
      transform: (raw) => raw.replace('"test:focused-failed"', '"file:docs/plan.md"'),
    },
    {
      name: "free text",
      caseId: "material_verification_gap",
      reason: "output_invalid",
      transform: () => "問題ありません",
    },
  ];

  for (const mutation of mutations) {
    await context.test(mutation.name, async () => {
      const report = await reportFor(replaceOutput(reference, mutation.caseId, mutation.transform));
      assert.equal(report.failed, 1);
      const failed = report.cases.find((entry) => entry.case_id === mutation.caseId);
      assert.equal(failed.outcome, "failed");
      assert.equal(failed.reason_codes.includes(mutation.reason), true);
    });
  }
});

test("reference oracleは重複case、unknown field、欠損caseを成功へ丸めない", async () => {
  const reference = await fixture(REFERENCE_URL);
  const duplicate = structuredClone(reference);
  duplicate.outputs.push(structuredClone(duplicate.outputs[0]));
  const suite = await fixture(SUITE_URL);
  assert.throws(() => referenceEvaluatorFromOracle(duplicate, suite), expectCode("E_SEMANTIC_EVAL_REFERENCE_INVALID"));

  const unknown = structuredClone(reference);
  unknown.outputs[0].extra = true;
  assert.throws(() => referenceEvaluatorFromOracle(unknown, suite), expectCode("E_SEMANTIC_EVAL_REFERENCE_INVALID"));

  const missing = structuredClone(reference);
  missing.outputs = missing.outputs.filter((entry) => entry.case_id !== "resolved");
  assert.throws(() => referenceEvaluatorFromOracle(missing, suite), expectCode("E_SEMANTIC_EVAL_REFERENCE_INVALID"));

  const extra = structuredClone(reference);
  extra.outputs.push({ case_id: "unexpected_case", raw_output: extra.outputs[0].raw_output });
  assert.throws(() => referenceEvaluatorFromOracle(extra, suite), expectCode("E_SEMANTIC_EVAL_REFERENCE_INVALID"));
});
