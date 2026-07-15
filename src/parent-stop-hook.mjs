import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";

import {
  claimCurrentParentMessage,
  finishClaim,
  recoverClaimAsDeliveryUnknown,
} from "./mailbox-consumer.mjs";
import { validateMessage } from "./message-schema.mjs";
import { fail, ObserverError } from "./observer-error.mjs";

export const ADVISORY_MAX_BYTES = 16 * 1024;

const PROVIDERS = new Set(["claude", "codex"]);
const IDENTIFIER_MAX_BYTES = 256;
const FIELD_LIMITS = Object.freeze({ title: 512, body: 8192, suggestedAction: 2048, evidence: 3072 });
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;

function assertProvider(provider) {
  if (!PROVIDERS.has(provider)) fail("E_PARENT_STOP_PROVIDER_INVALID", "parent Stop providerが不正です");
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function validIdentifier(value) {
  return typeof value === "string"
    && value.length > 0
    && Buffer.byteLength(value, "utf8") <= IDENTIFIER_MAX_BYTES
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function hookEventDigest(provider, sessionId, correlationId, stopHookActive) {
  const digest = createHash("sha256")
    .update(`${provider}\0${sessionId}\0${correlationId}\0${stopHookActive ? "1" : "0"}`, "utf8")
    .digest("hex");
  return `hook-${digest}`;
}

export function parseParentStopPayload(provider, payload) {
  assertProvider(provider);
  if (!isPlainObject(payload)
    || payload.hook_event_name !== "Stop"
    || !validIdentifier(payload.session_id)
    || typeof payload.cwd !== "string"
    || !isAbsolute(payload.cwd)
    || typeof payload.stop_hook_active !== "boolean") {
    fail("E_PARENT_STOP_PAYLOAD_INVALID", "parent Stop payloadが不正です");
  }

  let correlationId = "none";
  if (provider === "codex") {
    if (!validIdentifier(payload.turn_id)) fail("E_PARENT_STOP_PAYLOAD_INVALID", "Codex Stop turn_idが不正です");
    correlationId = payload.turn_id;
  } else if (payload.prompt_id !== undefined && payload.prompt_id !== null) {
    if (!validIdentifier(payload.prompt_id)) fail("E_PARENT_STOP_PAYLOAD_INVALID", "Claude Stop prompt_idが不正です");
    correlationId = payload.prompt_id;
  }

  return {
    projectRoot: payload.cwd,
    threadId: payload.session_id,
    hookEventId: hookEventDigest(provider, payload.session_id, correlationId, payload.stop_hook_active),
    stopHookActive: payload.stop_hook_active,
  };
}

function normalizeText(value) {
  return value.replace(/\r\n?/gu, "\n").replace(CONTROL_CHARACTERS, " ");
}

function clipUtf8(value, maxBytes) {
  const normalized = normalizeText(value);
  if (Buffer.byteLength(normalized, "utf8") <= maxBytes) return normalized;
  const suffix = "…";
  const budget = maxBytes - Buffer.byteLength(suffix, "utf8");
  let bytes = 0;
  let result = "";
  for (const character of normalized) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > budget) break;
    result += character;
    bytes += size;
  }
  return `${result}${suffix}`;
}

function renderEvidence(refs) {
  const lines = [];
  let used = 0;
  for (const ref of refs) {
    const line = `- ${clipUtf8(ref, 512)}`;
    const size = Buffer.byteLength(`${line}\n`, "utf8");
    if (used + size > FIELD_LIMITS.evidence) break;
    lines.push(line);
    used += size;
  }
  return lines.length === 0 ? "- 参照なし" : lines.join("\n");
}

export function renderObserverAdvisory(message) {
  validateMessage(message, { now: new Date(Date.parse(message.created_at)) });
  const rendered = [
    "Observerからの助言です。親として内容を評価し、必要な場合だけ現在の作業へ反映してください。",
    "",
    `重要度: ${message.severity}`,
    `分類: ${message.category}`,
    `件名: ${clipUtf8(message.title, FIELD_LIMITS.title)}`,
    "",
    "内容:",
    clipUtf8(message.body, FIELD_LIMITS.body),
    "",
    "根拠:",
    renderEvidence(message.evidence_refs),
    "",
    "推奨する次の一手:",
    clipUtf8(message.suggested_action, FIELD_LIMITS.suggestedAction),
  ].join("\n");
  if (Buffer.byteLength(rendered, "utf8") > ADVISORY_MAX_BYTES) {
    fail("E_PARENT_STOP_ADVISORY_LIMIT", "bounded advisoryの上限を超えました");
  }
  return rendered;
}

export function buildParentStopOutput(provider, advisory) {
  assertProvider(provider);
  if (typeof advisory !== "string" || advisory.length === 0 || Buffer.byteLength(advisory, "utf8") > ADVISORY_MAX_BYTES) {
    fail("E_PARENT_STOP_ADVISORY_INVALID", "parent Stop advisoryが不正です");
  }
  if (provider === "claude") {
    return { hookSpecificOutput: { hookEventName: "Stop", additionalContext: advisory } };
  }
  return { decision: "block", reason: advisory };
}

export async function runParentStopHook({ provider, payload, stateRoot, now = new Date() } = {}, dependencies = {}) {
  const normalized = parseParentStopPayload(provider, payload);
  if (normalized.stopHookActive) return { status: "continued_turn", route_status: null, stale_receipt_count: 0 };

  const claimMessage = dependencies.claimCurrentParentMessage ?? claimCurrentParentMessage;
  const finalize = dependencies.finishClaim ?? finishClaim;
  const recover = dependencies.recoverClaimAsDeliveryUnknown ?? recoverClaimAsDeliveryUnknown;
  const emit = dependencies.emitHookOutput;
  if (typeof emit !== "function") fail("E_PARENT_STOP_EMITTER_REQUIRED", "hook stdout emitterが必要です");

  const claimed = await claimMessage({
    stateRoot,
    projectRoot: normalized.projectRoot,
    parentProvider: provider,
    threadId: normalized.threadId,
    hookEventId: normalized.hookEventId,
    now,
  });
  if (claimed.claim === null) {
    return {
      status: "no_message",
      route_status: claimed.route.status,
      stale_receipt_count: claimed.stale_receipts.length,
    };
  }

  const claim = claimed.claim.claim;
  try {
    const advisory = renderObserverAdvisory(claimed.claim.message);
    const serialized = `${JSON.stringify(buildParentStopOutput(provider, advisory))}\n`;
    await emit(serialized);
    await finalize({ claim, stateRoot, result: "emitted_unacked", now });
    return {
      status: "emitted_unacked",
      route_status: claimed.route.status,
      stale_receipt_count: claimed.stale_receipts.length,
      message_id: claim.messageId,
    };
  } catch (error) {
    try {
      await recover({ stateRoot, targetId: claim.targetId, messageId: claim.messageId, now });
    } catch (recoveryError) {
      throw new ObserverError("E_PARENT_STOP_RECOVERY_FAILED", "claim済みmessageをdelivery_unknownへ回収できません", {
        cause_code: typeof error?.code === "string" ? error.code : "E_INTERNAL",
        recovery_code: typeof recoveryError?.code === "string" ? recoveryError.code : "E_INTERNAL",
      });
    }
    throw error;
  }
}
