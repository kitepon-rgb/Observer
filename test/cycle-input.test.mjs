import assert from "node:assert/strict";
import test from "node:test";

import { buildCycleInput, inspectCycleInputValue, validateCycleInputReceipt } from "../src/cycle-input.mjs";
import { buildEvidenceSnapshot } from "../src/evidence-snapshot.mjs";
import { buildObserverAiResponseContract } from "../src/observer-ai-contract.mjs";
import { ObserverError } from "../src/observer-error.mjs";

const evidence = buildEvidenceSnapshot({
  context: {
    after_cursor_sha256: "a".repeat(64),
    cycle_id: `c_${"b".repeat(64)}`,
    parent_host: "codex",
    parent_thread_sha256: "c".repeat(64),
    target_id: `p_${"d".repeat(64)}`,
    through_cursor_sha256: "e".repeat(64),
    watch_id: "w_11111111-1111-4111-8111-111111111111",
  },
  turns: [], plan: [], git: [], tests: [],
});

const expectCode = (code) => (error) => error instanceof ObserverError && error.code === code;

test("evidence snapshotをcanonical cycle requestへ変換しdigestとUTF-8 byte数を固定する", () => {
  const input = buildCycleInput(evidence);
  assert.equal(input.schema, "observer.cycle_input.v1");
  assert.match(input.input_digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(input.model_visible_bytes, Buffer.byteLength(input.value, "utf8"));
  assert.deepEqual(inspectCycleInputValue(input.value), input);
  assert.deepEqual(validateCycleInputReceipt({
    value: input.value,
    inputDigest: input.input_digest,
    modelVisibleBytes: input.model_visible_bytes,
  }), input);
  const request = JSON.parse(input.value);
  assert.equal(request.schema, "observer.cycle_request.v1");
  assert.equal(request.instruction, "analyze_evidence_snapshot");
  assert.equal(request.output_schema, "observer.ai_output.v1");
  assert.deepEqual(request.response_contract, buildObserverAiResponseContract());
  assert.deepEqual(request.response_contract.default, {
    schema: "observer.ai_output.v1",
    outcome: "no_advisory",
  });
  assert.equal(request.response_contract.format, "single_json_object");
  assert.deepEqual(request.response_contract.variants.advisory.severity_allowed, ["info", "warning", "review_required"]);
  assert.equal(request.response_contract.prohibited.includes("code_fence"), true);
  assert.deepEqual(request.evidence, evidence);
});

test("非canonical JSON、未知field、receipt mismatchをfail closedにする", () => {
  const input = buildCycleInput(evidence);
  assert.throws(() => inspectCycleInputValue(`${input.value}\n`), expectCode("E_CYCLE_INPUT_VALUE_INVALID"));
  const request = JSON.parse(input.value);
  assert.throws(() => inspectCycleInputValue(JSON.stringify({ ...request, extra: true })), expectCode("E_CYCLE_INPUT_VALUE_INVALID"));
  const weakened = structuredClone(request);
  weakened.response_contract.prohibited = weakened.response_contract.prohibited.filter((value) => value !== "code_fence");
  assert.throws(() => inspectCycleInputValue(JSON.stringify(weakened)), expectCode("E_CYCLE_INPUT_VALUE_INVALID"));
  assert.throws(() => validateCycleInputReceipt({
    value: input.value,
    inputDigest: `sha256:${"f".repeat(64)}`,
    modelVisibleBytes: input.model_visible_bytes,
  }), expectCode("E_CYCLE_INPUT_RECEIPT_MISMATCH"));
});
