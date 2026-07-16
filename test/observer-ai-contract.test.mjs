import assert from "node:assert/strict";
import test from "node:test";

import {
  OBSERVER_AI_OUTPUT_MAX_BYTES,
  buildObserverAiPrompt,
  buildObserverAiResponseContract,
  observerAiOutputDigest,
  parseObserverAiOutput,
  resolveObserverProvider,
} from "../src/observer-ai-contract.mjs";
import { ObserverError } from "../src/observer-error.mjs";

const CHILD_START = Object.freeze({
  schema: "observer.child_start.v1",
  mode: "observe",
  provider: "codex",
  watch_id: "w_11111111-1111-4111-8111-111111111111",
  target_id: `p_${"a".repeat(64)}`,
  project_root: "/monitored/project",
  runtime_root: "/observer",
});

function proposal(overrides = {}) {
  return {
    body: "受け入れ条件に必要な回帰確認が未実施です。",
    category: "verification_gap",
    dedupe_key: "verification:focused-gate",
    evidence_refs: ["test:focused-gate-missing"],
    severity: "warning",
    suggested_action: "関連するfocused gateを一回実行する",
    title: "回帰確認が不足しています",
    ...overrides,
  };
}

function advisory(overrides = {}) {
  return { schema: "observer.ai_output.v1", outcome: "advisory", proposal: proposal(), ...overrides };
}

function expectCode(code) {
  return (error) => error instanceof ObserverError && error.code === code;
}

test("Observer providerは現在親と同じfamilyだけを返す", () => {
  assert.equal(resolveObserverProvider("claude"), "claude");
  assert.equal(resolveObserverProvider("codex"), "codex");
  assert.throws(() => resolveObserverProvider("other"), expectCode("E_OBSERVER_PROVIDER_INVALID"));
});

test("runtime promptはroot契約、固定二結果、child startだけを一つのprotocolへ束縛する", () => {
  const prompt = buildObserverAiPrompt(CHILD_START);
  const responseContract = buildObserverAiResponseContract();
  assert.match(prompt, /AGENTS\.md/);
  assert.match(prompt, /observer\.ai_output\.v1/);
  assert.match(prompt, /no_advisory/);
  assert.match(prompt, /既定はno_advisory/);
  assert.match(prompt, /実質的な影響/);
  assert.match(prompt, /親が認識して具体的な対処を開始していません/);
  assert.match(prompt, /単なる好み、別解、一般論/);
  assert.match(prompt, /助言候補は最大一件/);
  assert.match(prompt, /info \| warning \| review_required/);
  assert.match(prompt, /verification_gap/);
  assert.match(prompt, /Markdown、code fence/);
  assert.equal(prompt.endsWith(JSON.stringify(CHILD_START)), true);
  assert.equal((prompt.match(/"schema":"observer\.child_start\.v1"/g) ?? []).length, 1);
  assert.deepEqual(responseContract.default, { schema: "observer.ai_output.v1", outcome: "no_advisory" });
  assert.deepEqual(responseContract.variants.advisory.severity_allowed, ["info", "warning", "review_required"]);
  assert.match(prompt, new RegExp(responseContract.variants.advisory.category_allowed[0]));
  assert.throws(() => buildObserverAiPrompt({ ...CHILD_START, provider: "other" }), expectCode("E_OBSERVER_PROVIDER_INVALID"));
  assert.throws(() => buildObserverAiPrompt({ ...CHILD_START, extra: true }), expectCode("E_OBSERVER_AI_CHILD_START_INVALID"));
});

test("no_advisoryは理由や通常会話を持たないexact objectだけを受理する", () => {
  assert.deepEqual(parseObserverAiOutput('{"outcome":"no_advisory","schema":"observer.ai_output.v1"}'), {
    schema: "observer.ai_output.v1",
    outcome: "no_advisory",
  });
  assert.throws(
    () => parseObserverAiOutput(JSON.stringify({ schema: "observer.ai_output.v1", outcome: "no_advisory", reason: "問題ありません" })),
    expectCode("E_OBSERVER_AI_OUTPUT_INVALID"),
  );
});

test("advisoryは固定fieldの一proposalだけを正規化する", () => {
  const input = advisory();
  const parsed = parseObserverAiOutput(JSON.stringify(input));
  assert.deepEqual(parsed, input);
  assert.notEqual(parsed.proposal.evidence_refs, input.proposal.evidence_refs);
  assert.throws(() => parseObserverAiOutput(JSON.stringify(advisory({ proposal: [proposal(), proposal()] }))), expectCode("E_OBSERVER_AI_OUTPUT_INVALID"));
  assert.throws(() => parseObserverAiOutput(JSON.stringify(advisory({ extra: "conversation" }))), expectCode("E_OBSERVER_AI_OUTPUT_INVALID"));
});

test("自由文、Markdown、schema外値、証拠なし、制御文字、過大出力をfail closedにする", () => {
  for (const raw of ["問題ありません", "```json\n{}\n```", "[]", "{}", '{"schema":"observer.ai_output.v2","outcome":"no_advisory"}']) {
    assert.throws(() => parseObserverAiOutput(raw), expectCode("E_OBSERVER_AI_OUTPUT_INVALID"));
  }
  assert.throws(() => parseObserverAiOutput(JSON.stringify(advisory({ proposal: proposal({ evidence_refs: [] }) }))), expectCode("E_OBSERVER_AI_OUTPUT_INVALID"));
  assert.throws(() => parseObserverAiOutput(JSON.stringify(advisory({ proposal: proposal({ title: "bad\u0000title" }) }))), expectCode("E_OBSERVER_AI_OUTPUT_INVALID"));
  assert.throws(() => parseObserverAiOutput("x".repeat(OBSERVER_AI_OUTPUT_MAX_BYTES + 1)), expectCode("E_OBSERVER_AI_OUTPUT_LIMIT"));
});

test("result digestは入力JSONのkey順でなく正規化済み一結果に束縛される", () => {
  const ordered = JSON.stringify(advisory());
  const reordered = JSON.stringify({ proposal: proposal(), outcome: "advisory", schema: "observer.ai_output.v1" });
  assert.match(observerAiOutputDigest(ordered), /^[a-f0-9]{64}$/);
  assert.equal(observerAiOutputDigest(ordered), observerAiOutputDigest(reordered));
});
