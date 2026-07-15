import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ADVISORY_MAX_BYTES,
  buildParentStopOutput,
  parseParentStopPayload,
  renderObserverAdvisory,
  runParentStopHook,
} from "../src/parent-stop-hook.mjs";
import { sealMessage } from "../src/message-schema.mjs";

const NOW = new Date("2026-07-15T06:00:00.000Z");
const THREAD = "019f6328-1111-7222-8333-444444444444";
const CLAIM = {
  messageId: "message-1",
  contentDigest: `sha256:${"a".repeat(64)}`,
  targetId: `p_${"b".repeat(64)}`,
  threadSha256: "c".repeat(64),
  hookEventId: `hook-${"d".repeat(64)}`,
  claimedAt: NOW.toISOString(),
};

function payload(provider, overrides = {}) {
  return {
    session_id: THREAD,
    cwd: "/Users/kite/Developer/dotagents",
    hook_event_name: "Stop",
    stop_hook_active: false,
    last_assistant_message: "完了しました",
    ...(provider === "codex" ? { turn_id: "turn-1" } : { prompt_id: "prompt-1", background_tasks: [], session_crons: [] }),
    ...overrides,
  };
}

function message(overrides = {}) {
  return sealMessage({
    schema_version: 1,
    message_id: "message-1",
    producer: { kind: "observer", producer_id: "watch-1" },
    target: { project_target_id: CLAIM.targetId, thread_sha256: CLAIM.threadSha256 },
    created_at: "2026-07-15T05:59:00.000Z",
    expires_at: "2099-07-15T07:00:00.000Z",
    severity: "warning",
    category: "verification_gap",
    dedupe_key: "verification-gap-1",
    title: "回帰確認が不足しています",
    body: "変更した公開契約に対するfocused testがまだありません。",
    evidence_refs: ["docs/plan.md#gate", "test/example.test.mjs"],
    suggested_action: "公開契約を固定するfocused testを一度実行してください。",
    ...overrides,
  });
}

function expectCode(code) {
  return (error) => error?.code === code;
}

test("Claude/Codex Stop payloadをraw ID非永続の共通route入力へ正規化する", () => {
  const claude = parseParentStopPayload("claude", payload("claude"));
  assert.equal(claude.projectRoot, "/Users/kite/Developer/dotagents");
  assert.equal(claude.threadId, THREAD);
  assert.match(claude.hookEventId, /^hook-[a-f0-9]{64}$/);
  assert.equal(claude.stopHookActive, false);

  const codex = parseParentStopPayload("codex", payload("codex"));
  assert.equal(codex.threadId, THREAD);
  assert.notEqual(codex.hookEventId, claude.hookEventId);
  assert.throws(() => parseParentStopPayload("codex", payload("codex", { turn_id: undefined })), expectCode("E_PARENT_STOP_PAYLOAD_INVALID"));
  assert.throws(() => parseParentStopPayload("claude", payload("claude", { hook_event_name: "SubagentStop" })), expectCode("E_PARENT_STOP_PAYLOAD_INVALID"));
  assert.throws(() => parseParentStopPayload("claude", payload("claude", { cwd: "relative" })), expectCode("E_PARENT_STOP_PAYLOAD_INVALID"));
});

test("ClaudeはadditionalContext、Codexはblock reasonだけを正式wireに使う", () => {
  const advisory = "Observerからの助言です。";
  assert.deepEqual(buildParentStopOutput("claude", advisory), {
    hookSpecificOutput: { hookEventName: "Stop", additionalContext: advisory },
  });
  assert.deepEqual(buildParentStopOutput("codex", advisory), { decision: "block", reason: advisory });
});

test("advisoryを固定順・制御文字なし・16 KiB以下へboundする", () => {
  const rendered = renderObserverAdvisory(message({
    title: `題名\u0000${"題".repeat(160)}`,
    body: `本文\u0007${"本".repeat(2600)}`,
    evidence_refs: Array.from({ length: 16 }, (_, index) => `e${index}-${"根".repeat(160)}`),
    suggested_action: `対応${"進".repeat(650)}`,
  }));
  assert.ok(Buffer.byteLength(rendered, "utf8") <= ADVISORY_MAX_BYTES);
  assert.doesNotMatch(rendered, /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u);
  assert.ok(rendered.indexOf("件名:") < rendered.indexOf("内容:"));
  assert.ok(rendered.indexOf("内容:") < rendered.indexOf("根拠:"));
  assert.ok(rendered.indexOf("根拠:") < rendered.indexOf("推奨する次の一手:"));
});

test("continued turnとMailboxなしはstdoutを出さずclaimしないfast pathになる", async () => {
  let claims = 0;
  let emissions = 0;
  const dependencies = {
    claimCurrentParentMessage: async () => { claims += 1; return { route: { status: "current" }, claim: null, stale_receipts: [] }; },
    emitHookOutput: async () => { emissions += 1; },
  };
  const continued = await runParentStopHook({ provider: "codex", payload: payload("codex", { stop_hook_active: true }), stateRoot: "/state", now: NOW }, dependencies);
  assert.equal(continued.status, "continued_turn");
  assert.equal(claims, 0);
  const empty = await runParentStopHook({ provider: "codex", payload: payload("codex"), stateRoot: "/state", now: NOW }, dependencies);
  assert.equal(empty.status, "no_message");
  assert.equal(claims, 1);
  assert.equal(emissions, 0);
});

for (const provider of ["claude", "codex"]) {
  test(`${provider}はcurrent messageを一度だけ出力してemitted_unackedへfinalizeする`, async () => {
    const emitted = [];
    const finished = [];
    const result = await runParentStopHook({ provider, payload: payload(provider), stateRoot: "/state", now: NOW }, {
      claimCurrentParentMessage: async (input) => {
        assert.equal(input.parentProvider, provider);
        assert.equal(input.threadId, THREAD);
        return { route: { status: "current" }, claim: { message: message(), claim: CLAIM }, stale_receipts: [] };
      },
      emitHookOutput: async (serialized) => emitted.push(serialized),
      finishClaim: async (input) => { finished.push(input); return { result: input.result }; },
      recoverClaimAsDeliveryUnknown: async () => assert.fail("recoveryは呼ばれない"),
    });
    assert.equal(result.status, "emitted_unacked");
    assert.equal(emitted.length, 1);
    const output = JSON.parse(emitted[0]);
    const advisory = provider === "claude" ? output.hookSpecificOutput.additionalContext : output.reason;
    assert.match(advisory, /回帰確認が不足しています/);
    assert.deepEqual(finished.map((item) => item.result), ["emitted_unacked"]);
  });
}

test("claim後のstdout失敗はdelivery_unknownへ回収し本文を再配送しない", async () => {
  const recovered = [];
  await assert.rejects(runParentStopHook({ provider: "codex", payload: payload("codex"), stateRoot: "/state", now: NOW }, {
    claimCurrentParentMessage: async () => ({ route: { status: "current" }, claim: { message: message(), claim: CLAIM }, stale_receipts: [] }),
    emitHookOutput: async () => { throw Object.assign(new Error("EPIPE"), { code: "EPIPE" }); },
    finishClaim: async () => assert.fail("正常finalizeは呼ばれない"),
    recoverClaimAsDeliveryUnknown: async (input) => { recovered.push(input); return { result: "delivery_unknown" }; },
  }), (error) => error?.code === "EPIPE");
  assert.deepEqual(recovered, [{ stateRoot: "/state", targetId: CLAIM.targetId, messageId: CLAIM.messageId, now: NOW }]);
});

test("delivery_unknown回収まで失敗した時はclaimed receiptを隠さず専用errorにする", async () => {
  await assert.rejects(runParentStopHook({ provider: "claude", payload: payload("claude"), stateRoot: "/state", now: NOW }, {
    claimCurrentParentMessage: async () => ({ route: { status: "current" }, claim: { message: message(), claim: CLAIM }, stale_receipts: [] }),
    emitHookOutput: async () => { throw new Error("write failed"); },
    recoverClaimAsDeliveryUnknown: async () => { throw new Error("recovery failed"); },
  }), expectCode("E_PARENT_STOP_RECOVERY_FAILED"));
});
