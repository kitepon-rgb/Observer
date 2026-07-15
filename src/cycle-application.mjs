import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";

import { validateCycleInputReceipt } from "./cycle-input.mjs";
import {
  cleanupOperationPublishReceipt,
  operationMessageId,
  publishOperationMessage,
} from "./mailbox-store.mjs";
import { sealMessage } from "./message-schema.mjs";
import { readModelOperation } from "./model-operation-store.mjs";
import { observerAiOutputDigest, parseObserverAiOutput } from "./observer-ai-contract.mjs";
import { fail } from "./observer-error.mjs";

export const CYCLE_APPLICATION_FINALIZATION_SCHEMA = "observer.cycle_application_finalization.v1";
export const CYCLE_APPLICATION_TTL_MS = 24 * 60 * 60 * 1000;

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const HEX = /^[a-f0-9]{64}$/;
const THREAD = /^[a-f0-9]{64}$/;
const OPERATION_KEYS = Object.freeze([
  "action",
  "cycle_id",
  "generation_id",
  "input_digest",
  "model_visible_bytes",
  "operation_id",
  "provider",
  "provider_operation_receipt_digest",
  "schema",
  "status",
  "target_id",
  "watch_id",
]);
const IDENTITY_FIELDS = Object.freeze([
  ["provider", "provider"],
  ["operation_id", "operation_id"],
  ["target_id", "target_id"],
  ["watch_id", "watch_id"],
  ["generation_id", "generation_id"],
  ["cycle_id", "cycle_id"],
  ["input_digest", "input_digest"],
  ["model_visible_bytes", "model_visible_bytes"],
  ["provider_operation_receipt_digest", "provider_operation_receipt_digest"],
]);

export async function applyCycleOutput({ stateRoot, operation, output, cycleInput, now = new Date() } = {}, dependencies = {}) {
  validateApplicationInput({ stateRoot, operation, cycleInput, now }, "completed");
  const canonicalOutput = parseObserverAiOutput(JSON.stringify(output));
  const context = cycleContext(cycleInput, operation);
  const durable = await readDurableOperation({ stateRoot, operation, expectedStatus: "completed" }, dependencies);
  const outputDigest = `sha256:${observerAiOutputDigest(canonicalOutput)}`;
  if (durable.completed_output_digest !== outputDigest || JSON.stringify(durable.completed_output) !== JSON.stringify(canonicalOutput)) {
    fail("E_CYCLE_APPLICATION_OUTPUT_MISMATCH", "cycle outputがdurable operationと一致しません");
  }

  if (canonicalOutput.outcome === "no_advisory") {
    return cycleResult(noAdvisoryDigest(operation.operation_id, durable.completed_output_digest));
  }

  const createdAt = new Date(durable.created_at);
  const expiresAt = new Date(createdAt.getTime() + CYCLE_APPLICATION_TTL_MS);
  if (expiresAt.getTime() <= now.getTime()) {
    fail("E_CYCLE_APPLICATION_EXPIRED", "advisory messageの決定的有効期限を過ぎています");
  }
  const proposal = canonicalOutput.proposal;
  const message = sealMessage({
    schema_version: 1,
    message_id: operationMessageId(operation.operation_id),
    producer: { kind: "observer", producer_id: "observer" },
    target: { project_target_id: operation.target_id, thread_sha256: context.parent_thread_sha256 },
    created_at: createdAt.toISOString(),
    expires_at: expiresAt.toISOString(),
    severity: proposal.severity,
    category: proposal.category,
    dedupe_key: proposal.dedupe_key,
    title: proposal.title,
    body: proposal.body,
    evidence_refs: [...proposal.evidence_refs],
    suggested_action: proposal.suggested_action,
  });
  const publish = dependencies.publishOperationMessage ?? publishOperationMessage;
  const published = await publish({ stateRoot, operationId: operation.operation_id, message, now });
  if (published?.operationId !== operation.operation_id || published?.messageId !== message.message_id ||
      published?.targetId !== operation.target_id || published?.contentDigest !== message.content_digest ||
      published?.status !== "published") {
    fail("E_CYCLE_APPLICATION_PUBLISH_MISMATCH", "Mailbox publish receiptがcycle applicationと一致しません");
  }
  return cycleResult(message.content_digest.slice("sha256:".length));
}

export async function finalizeCycleApplication({ stateRoot, operation } = {}, dependencies = {}) {
  validateFinalizationInput({ stateRoot, operation });
  const durable = await readDurableOperation({ stateRoot, operation, expectedStatus: "applied" }, dependencies);
  if (!durable.applied_result || durable.applied_result.result_digest !== operation.applied_result.result_digest ||
      durable.completed_output_digest !== operation.completed_output_digest) {
    fail("E_CYCLE_APPLICATION_RESULT_MISMATCH", "applied cycle resultがdurable operationと一致しません");
  }

  if (durable.completed_output.outcome === "no_advisory") {
    const expected = noAdvisoryDigest(operation.operation_id, durable.completed_output_digest);
    if (operation.applied_result.result_digest !== expected) {
      fail("E_CYCLE_APPLICATION_RESULT_MISMATCH", "no-advisory result digestが一致しません");
    }
    return finalization("no_op");
  }

  const cleanup = dependencies.cleanupOperationPublishReceipt ?? cleanupOperationPublishReceipt;
  const contentDigest = `sha256:${operation.applied_result.result_digest}`;
  const cleaned = await cleanup({
    stateRoot,
    targetId: operation.target_id,
    operationId: operation.operation_id,
    messageId: operationMessageId(operation.operation_id),
    contentDigest,
  });
  if (cleaned?.operationId !== operation.operation_id || cleaned?.targetId !== operation.target_id ||
      cleaned?.messageId !== operationMessageId(operation.operation_id) || cleaned?.contentDigest !== contentDigest ||
      typeof cleaned.cleaned !== "boolean" || typeof cleaned.replayed !== "boolean") {
    fail("E_CYCLE_APPLICATION_FINALIZATION_MISMATCH", "Mailbox cleanup receiptがcycle applicationと一致しません");
  }
  return finalization(cleaned.cleaned ? "cleaned" : "already_cleaned");
}

async function readDurableOperation({ stateRoot, operation, expectedStatus }, dependencies) {
  const read = dependencies.readModelOperation ?? readModelOperation;
  const durable = await read({ stateRoot, targetId: operation.target_id });
  if (!isPlainObject(durable) || durable.status !== expectedStatus) {
    fail("E_CYCLE_APPLICATION_STATE_MISMATCH", `${expectedStatus} durable operationが必要です`);
  }
  for (const [publicField, durableField] of IDENTITY_FIELDS) {
    if (operation[publicField] !== durable[durableField]) {
      fail("E_CYCLE_APPLICATION_IDENTITY_MISMATCH", "cycle application identityがdurable operationと一致しません");
    }
  }
  return durable;
}

function validateApplicationInput({ stateRoot, operation, cycleInput, now }, expectedStatus) {
  validateStateRoot(stateRoot);
  validateOperation(operation, expectedStatus, "recover_only");
  if (!isPlainObject(cycleInput) || Object.keys(cycleInput).sort().join(",") !== "input_digest,model_visible_bytes,schema,value" ||
      cycleInput.schema !== "observer.cycle_input.v1") {
    fail("E_CYCLE_APPLICATION_INPUT_INVALID", "cycle input receiptが不正です");
  }
  validateCycleInputReceipt({
    value: cycleInput.value,
    inputDigest: operation.input_digest,
    modelVisibleBytes: operation.model_visible_bytes,
  });
  if (cycleInput.input_digest !== operation.input_digest || cycleInput.model_visible_bytes !== operation.model_visible_bytes) {
    fail("E_CYCLE_APPLICATION_INPUT_INVALID", "cycle input receiptがoperationと一致しません");
  }
  validateNow(now);
}

function cycleContext(cycleInput, operation) {
  const context = JSON.parse(cycleInput.value).evidence.context;
  if (!isPlainObject(context) || context.target_id !== operation.target_id || context.watch_id !== operation.watch_id ||
      context.cycle_id !== operation.cycle_id || context.parent_host !== operation.provider ||
      !THREAD.test(context.parent_thread_sha256)) {
    fail("E_CYCLE_APPLICATION_IDENTITY_MISMATCH", "cycle input contextがoperationと一致しません");
  }
  return context;
}

function validateFinalizationInput({ stateRoot, operation }) {
  validateStateRoot(stateRoot);
  if (!isPlainObject(operation)) fail("E_CYCLE_APPLICATION_INPUT_INVALID", "finalization operationが不正です");
  const expectedKeys = [...OPERATION_KEYS, "applied_result", "completed_output_digest"].sort();
  const actualKeys = Object.keys(operation).sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    fail("E_CYCLE_APPLICATION_INPUT_INVALID", "finalization operation fieldが不正です");
  }
  validateOperationShape(operation, "applied", "recover_only");
  if (!isPlainObject(operation.applied_result) || Object.keys(operation.applied_result).sort().join(",") !== "result_digest,schema" ||
      operation.applied_result.schema !== "observer.cycle_result.v1" || !HEX.test(operation.applied_result.result_digest) ||
      !DIGEST.test(operation.completed_output_digest)) {
    fail("E_CYCLE_APPLICATION_INPUT_INVALID", "finalization resultが不正です");
  }
}

function validateOperation(operation, expectedStatus, expectedAction) {
  if (!isPlainObject(operation) || Object.keys(operation).sort().join(",") !== [...OPERATION_KEYS].sort().join(",")) {
    fail("E_CYCLE_APPLICATION_INPUT_INVALID", "cycle operation fieldが不正です");
  }
  validateOperationShape(operation, expectedStatus, expectedAction);
}

function validateOperationShape(operation, expectedStatus, expectedAction) {
  if (operation.schema !== "observer.model_operation_receipt.v1" || operation.status !== expectedStatus ||
      operation.action !== expectedAction || !["claude", "codex"].includes(operation.provider) ||
      !DIGEST.test(operation.operation_id) || !DIGEST.test(operation.generation_id) || !DIGEST.test(operation.input_digest) ||
      !DIGEST.test(operation.provider_operation_receipt_digest) || !/^p_[a-f0-9]{64}$/.test(operation.target_id) ||
      !/^w_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(operation.watch_id) ||
      !/^c_[a-f0-9]{64}$/.test(operation.cycle_id) || !Number.isSafeInteger(operation.model_visible_bytes) ||
      operation.model_visible_bytes < 0) {
    fail("E_CYCLE_APPLICATION_INPUT_INVALID", "cycle operation identityが不正です");
  }
}

function noAdvisoryDigest(operationId, outputDigest) {
  return createHash("sha256")
    .update(["observer.no_advisory_apply.v1", operationId, outputDigest].join("\0"), "utf8")
    .digest("hex");
}

function cycleResult(resultDigest) {
  return { schema: "observer.cycle_result.v1", result_digest: resultDigest };
}

function finalization(outcome) {
  return { schema: CYCLE_APPLICATION_FINALIZATION_SCHEMA, outcome };
}

function validateStateRoot(value) {
  if (typeof value !== "string" || !isAbsolute(value)) fail("E_CYCLE_APPLICATION_INPUT_INVALID", "state rootが不正です");
}

function validateNow(value) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) fail("E_CYCLE_APPLICATION_INPUT_INVALID", "application時刻が不正です");
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
