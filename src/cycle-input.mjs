import { createHash } from "node:crypto";

import { validateEvidenceSnapshot } from "./evidence-snapshot.mjs";
import { fail } from "./observer-error.mjs";

export const CYCLE_REQUEST_SCHEMA = "observer.cycle_request.v1";
export const CYCLE_INPUT_SCHEMA = "observer.cycle_input.v1";
export const CYCLE_REQUEST_INSTRUCTION = "analyze_evidence_snapshot";
export const CYCLE_REQUEST_OUTPUT_SCHEMA = "observer.ai_output.v1";
export const CYCLE_INPUT_MAX_BYTES = 262_144;

const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;

export function buildCycleInput(evidence) {
  validateEvidenceSnapshot(evidence);
  const value = canonicalize({
    schema: CYCLE_REQUEST_SCHEMA,
    instruction: CYCLE_REQUEST_INSTRUCTION,
    output_schema: CYCLE_REQUEST_OUTPUT_SCHEMA,
    evidence: structuredClone(evidence),
  });
  return receiptFor(value);
}

export function validateCycleInputReceipt({ value, inputDigest, modelVisibleBytes } = {}) {
  const receipt = inspectCycleInputValue(value);
  if (receipt.input_digest !== inputDigest || receipt.model_visible_bytes !== modelVisibleBytes) {
    fail("E_CYCLE_INPUT_RECEIPT_MISMATCH", "cycle inputのdigestまたはbyte数が一致しません");
  }
  return receipt;
}

export function inspectCycleInputValue(value) {
  if (typeof value !== "string" || value.length === 0) {
    fail("E_CYCLE_INPUT_VALUE_INVALID", "cycle input valueはcanonical JSON文字列である必要があります");
  }
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > CYCLE_INPUT_MAX_BYTES) fail("E_CYCLE_INPUT_VALUE_LIMIT", "cycle input valueが上限を超えています");

  let request;
  try {
    request = JSON.parse(value);
  } catch {
    fail("E_CYCLE_INPUT_VALUE_INVALID", "cycle input valueはJSON object一件である必要があります");
  }
  if (!plain(request) || Object.keys(request).sort().join(",") !== "evidence,instruction,output_schema,schema" ||
      request.schema !== CYCLE_REQUEST_SCHEMA || request.instruction !== CYCLE_REQUEST_INSTRUCTION ||
      request.output_schema !== CYCLE_REQUEST_OUTPUT_SCHEMA) {
    fail("E_CYCLE_INPUT_VALUE_INVALID", "cycle request schemaが不正です");
  }
  validateEvidenceSnapshot(request.evidence);
  if (canonicalize(request) !== value) fail("E_CYCLE_INPUT_VALUE_INVALID", "cycle input valueがcanonical JSONではありません");
  return receiptFor(value);
}

function receiptFor(value) {
  const modelVisibleBytes = Buffer.byteLength(value, "utf8");
  if (modelVisibleBytes > CYCLE_INPUT_MAX_BYTES) fail("E_CYCLE_INPUT_VALUE_LIMIT", "cycle input valueが上限を超えています");
  const inputDigest = `sha256:${createHash("sha256").update(`${CYCLE_INPUT_SCHEMA}\0${value}`, "utf8").digest("hex")}`;
  if (!DIGEST_RE.test(inputDigest)) fail("E_CYCLE_INPUT_VALUE_INVALID", "cycle input digestを生成できません");
  return { schema: CYCLE_INPUT_SCHEMA, input_digest: inputDigest, model_visible_bytes: modelVisibleBytes, value };
}

function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (plain(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function plain(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
