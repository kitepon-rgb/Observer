import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";

import { CATEGORIES, SEVERITIES } from "./message-schema.mjs";
import { fail } from "./observer-error.mjs";

export const OBSERVER_AI_OUTPUT_SCHEMA = "observer.ai_output.v1";
export const OBSERVER_AI_OUTPUT_MAX_BYTES = 16 * 1024;

const PROVIDERS = new Set(["claude", "codex"]);
const NO_ADVISORY_KEYS = Object.freeze(["outcome", "schema"]);
const ADVISORY_KEYS = Object.freeze(["outcome", "proposal", "schema"]);
const PROPOSAL_KEYS = Object.freeze([
  "body",
  "category",
  "dedupe_key",
  "evidence_refs",
  "severity",
  "suggested_action",
  "title",
]);
const CHILD_START_KEYS = Object.freeze([
  "mode",
  "project_root",
  "provider",
  "runtime_root",
  "schema",
  "target_id",
  "watch_id",
]);
const TARGET_ID_RE = /^p_[a-f0-9]{64}$/;
const WATCH_ID_RE = /^w_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DISALLOWED_CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

export function resolveObserverProvider(parentProvider) {
  if (!PROVIDERS.has(parentProvider)) {
    fail("E_OBSERVER_PROVIDER_INVALID", "現在親のproviderをObserver providerへ解決できません");
  }
  return parentProvider;
}

export function buildObserverAiPrompt(childStart) {
  validateChildStart(childStart);
  const noAdvisory = JSON.stringify({ schema: OBSERVER_AI_OUTPUT_SCHEMA, outcome: "no_advisory" });
  const advisory = JSON.stringify({
    schema: OBSERVER_AI_OUTPUT_SCHEMA,
    outcome: "advisory",
    proposal: {
      body: "REPLACE_WITH_BOUNDED_MATERIAL_IMPACT",
      category: "REPLACE_WITH_ALLOWED_CATEGORY",
      dedupe_key: "REPLACE_WITH_STABLE_DEDUPE_KEY",
      evidence_refs: ["REPLACE_WITH_BOUNDED_EVIDENCE_REF"],
      severity: "REPLACE_WITH_ALLOWED_SEVERITY",
      suggested_action: "REPLACE_WITH_ONE_ACTION",
      title: "REPLACE_WITH_CONCRETE_CLAIM",
    },
  });
  return [
    "Observer rootのAGENTS.mdを静的な製品役割の正本として適用してください。",
    "次のobserver.child_start.v1をexact検証し、許可されたread-only surfaceだけで監視してください。",
    `各観測cycleの最終出力はJSON object一件だけです。正常進行は ${noAdvisory}`,
    `助言候補は最大一件で ${advisory}`,
    `severityの許可値: ${SEVERITIES.join(" | ")}`,
    `categoryの許可値: ${CATEGORIES.join(" | ")}`,
    "Markdown、code fence、前後の説明、複数候補、通常会話、実装結果を出力してはいけません。",
    JSON.stringify(childStart),
  ].join("\n");
}

export function parseObserverAiOutput(raw) {
  if (typeof raw !== "string" || raw.length === 0 || Buffer.byteLength(raw, "utf8") > OBSERVER_AI_OUTPUT_MAX_BYTES) {
    fail("E_OBSERVER_AI_OUTPUT_LIMIT", "Observer AI出力が空または上限超過です");
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    fail("E_OBSERVER_AI_OUTPUT_INVALID", "Observer AI出力はJSON object一件である必要があります");
  }
  requirePlainObject(value, "Observer AI output");
  if (value.schema !== OBSERVER_AI_OUTPUT_SCHEMA) {
    fail("E_OBSERVER_AI_OUTPUT_INVALID", "Observer AI出力schemaが不正です");
  }
  if (value.outcome === "no_advisory") {
    requireExactKeys(value, NO_ADVISORY_KEYS, "no_advisory output");
    return { schema: OBSERVER_AI_OUTPUT_SCHEMA, outcome: "no_advisory" };
  }
  if (value.outcome !== "advisory") {
    fail("E_OBSERVER_AI_OUTPUT_INVALID", "Observer AI出力outcomeが不正です");
  }
  requireExactKeys(value, ADVISORY_KEYS, "advisory output");
  return {
    schema: OBSERVER_AI_OUTPUT_SCHEMA,
    outcome: "advisory",
    proposal: validateProposal(value.proposal),
  };
}

export function observerAiOutputDigest(output) {
  const normalized = typeof output === "string" ? parseObserverAiOutput(output) : validateParsedOutput(output);
  return createHash("sha256").update(canonicalize(normalized), "utf8").digest("hex");
}

function validateParsedOutput(value) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    fail("E_OBSERVER_AI_OUTPUT_INVALID", "Observer AI出力をJSONへ正規化できません");
  }
  return parseObserverAiOutput(serialized);
}

function validateProposal(value) {
  requirePlainObject(value, "advisory proposal");
  requireExactKeys(value, PROPOSAL_KEYS, "advisory proposal");
  requireBoundedString(value.title, "proposal.title", 512);
  requireBoundedString(value.body, "proposal.body", 8192);
  requireBoundedString(value.suggested_action, "proposal.suggested_action", 2048);
  requireBoundedString(value.dedupe_key, "proposal.dedupe_key", 256);
  if (!SEVERITIES.includes(value.severity) || !CATEGORIES.includes(value.category)) {
    fail("E_OBSERVER_AI_OUTPUT_INVALID", "advisory proposalのseverityまたはcategoryが不正です");
  }
  if (!Array.isArray(value.evidence_refs) || value.evidence_refs.length === 0 || value.evidence_refs.length > 16) {
    fail("E_OBSERVER_AI_OUTPUT_INVALID", "advisory proposalのevidence_refsは1〜16件である必要があります");
  }
  for (const ref of value.evidence_refs) requireBoundedString(ref, "proposal.evidence_refs[]", 512);
  return {
    body: value.body,
    category: value.category,
    dedupe_key: value.dedupe_key,
    evidence_refs: [...value.evidence_refs],
    severity: value.severity,
    suggested_action: value.suggested_action,
    title: value.title,
  };
}

function validateChildStart(value) {
  requirePlainObject(value, "child start", "E_OBSERVER_AI_CHILD_START_INVALID");
  requireExactKeys(value, CHILD_START_KEYS, "child start", "E_OBSERVER_AI_CHILD_START_INVALID");
  if (value.schema !== "observer.child_start.v1" || value.mode !== "observe") {
    fail("E_OBSERVER_AI_CHILD_START_INVALID", "Observer child start schemaが不正です");
  }
  resolveObserverProvider(value.provider);
  if (!TARGET_ID_RE.test(value.target_id) || !WATCH_ID_RE.test(value.watch_id) ||
      !isSafeAbsolutePath(value.project_root) || !isSafeAbsolutePath(value.runtime_root)) {
    fail("E_OBSERVER_AI_CHILD_START_INVALID", "Observer child start identityが不正です");
  }
  return value;
}

function isSafeAbsolutePath(value) {
  return typeof value === "string" && isAbsolute(value) && !DISALLOWED_CONTROL_RE.test(value);
}

function requirePlainObject(value, field, code = "E_OBSERVER_AI_OUTPUT_INVALID") {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail(code, `${field}はplain objectである必要があります`);
  }
}

function requireExactKeys(value, expected, field, code = "E_OBSERVER_AI_OUTPUT_INVALID") {
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(code, `${field}に未知または不足fieldがあります`, { actual, expected });
  }
}

function requireBoundedString(value, field, maxBytes) {
  if (typeof value !== "string" || value.trim().length === 0 || Buffer.byteLength(value, "utf8") > maxBytes || DISALLOWED_CONTROL_RE.test(value)) {
    fail("E_OBSERVER_AI_OUTPUT_INVALID", `${field}が空、上限超過、または制御文字を含みます`);
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
