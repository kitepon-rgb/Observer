import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  confirmAdvisoryPublished,
  finalizeAdvisoryDecision,
  preflightAdvisoryFinalization,
  prepareAdvisoryDecision,
  readAdvisoryDecisionHistory,
  readCurrentAdvisoryDecision,
  validateAdvisoryDecisionReceipt,
  validateAdvisoryFinalizationPreflightReceipt,
  validateAdvisoryFinalizationReceipt,
} from "../src/advisory-semantic-decision.mjs";
import { buildCycleInput } from "../src/cycle-input.mjs";
import { buildEvidenceSnapshot } from "../src/evidence-snapshot.mjs";
import { observerAiOutputDigest } from "../src/observer-ai-contract.mjs";
import { ObserverError } from "../src/observer-error.mjs";
import { removePrivateFile } from "../src/private-state.mjs";

const TARGET_ID = `p_${"a".repeat(64)}`;
const WATCH_ID = "w_11111111-1111-4111-8111-111111111111";
const GENERATION_ID = `sha256:${"b".repeat(64)}`;
const PARENT_THREAD = "c".repeat(64);
const T0 = new Date("2026-07-16T00:00:00.000Z");

function hex(label) {
  return createHash("sha256").update(label, "utf8").digest("hex");
}

function at(milliseconds) {
  return new Date(T0.getTime() + milliseconds);
}

async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), "observer-semantic-"));
  await chmod(root, 0o700);
  return root;
}

function proposal(overrides = {}) {
  return {
    title: "検証不足を確認してください",
    body: "関連gateの証拠がないため、完了判定を保留する必要があります。",
    suggested_action: "focused gateを実行し、結果を確認してください。",
    dedupe_key: "verification-gap:focused-gate",
    severity: "info",
    category: "verification_gap",
    evidence_refs: ["git:working-tree"],
    ...overrides,
  };
}

function operationFor(proposalValue, index = 1) {
  const output = { schema: "observer.ai_output.v1", outcome: "advisory", proposal: proposalValue };
  return {
    target_id: TARGET_ID,
    watch_id: WATCH_ID,
    generation_id: GENERATION_ID,
    cycle_id: `c_${hex(`cycle:${index}`)}`,
    input_digest: `sha256:${hex(`input:${index}`)}`,
    operation_id: `sha256:${hex(`operation:${index}`)}`,
    output_digest: `sha256:${observerAiOutputDigest(output)}`,
  };
}

function gitEvidence(index = 1, overrides = {}) {
  return {
    ref: "git:working-tree",
    source_digest: `sha256:${hex(`git:${index}`)}`,
    available: true,
    content: `diff evidence ${index}`,
    unavailable_code: null,
    ...overrides,
  };
}

function snapshotFor(operation, git = [gitEvidence()]) {
  const snapshot = buildEvidenceSnapshot({
    context: {
      target_id: operation.target_id,
      watch_id: operation.watch_id,
      parent_host: "codex",
      parent_thread_sha256: PARENT_THREAD,
      cycle_id: operation.cycle_id,
      after_cursor_sha256: null,
      through_cursor_sha256: hex(`through:${operation.cycle_id}`),
    },
    turns: [],
    plan: [],
    git,
    tests: [],
  });
  operation.input_digest = buildCycleInput(snapshot).input_digest;
  return snapshot;
}

function candidate(index = 1) {
  return hex(`candidate:${index}`);
}

function publishReceipt(decision) {
  return {
    operationId: decision.operation_id,
    messageId: `obs-${decision.operation_id.slice("sha256:".length)}`,
    targetId: decision.target_id,
    contentDigest: `sha256:${decision.result_digest}`,
    status: "published",
  };
}

function finalizationReceipt(outcome, decision) {
  return {
    schema: "observer.advisory_finalization.v1",
    outcome,
    target_id: decision.target_id,
    operation_id: decision.operation_id,
    result_digest: decision.result_digest,
  };
}

function preflightReceipt(outcome, decision, retainedCount, removedCount) {
  return {
    schema: "observer.advisory_finalization_preflight.v1",
    outcome,
    decision: decision.decision,
    target_id: decision.target_id,
    operation_id: decision.operation_id,
    result_digest: decision.result_digest,
    retained_count: retainedCount,
    removed_count: removedCount,
  };
}

function expectCode(code) {
  return (error) => error instanceof ObserverError && error.code === code;
}

async function prepareAccepted({ root, proposalValue, operation, snapshot, result = candidate(), now = T0, dependencies } = {}) {
  const decision = await prepareAdvisoryDecision({
    stateRoot: root,
    operation,
    proposal: proposalValue,
    snapshot,
    candidateResultDigest: result,
    now,
  }, dependencies);
  assert.equal(decision.decision, "accepted");
  assert.equal(decision.status, "accepted_pending_publish");
  return decision;
}

async function publishAndFinalize({ root, decision, now = T0, dependencies } = {}) {
  const published = await confirmAdvisoryPublished({
    stateRoot: root,
    targetId: decision.target_id,
    operationId: decision.operation_id,
    publishResult: publishReceipt(decision),
    now,
  }, dependencies);
  return finalizeAdvisoryDecision({
    stateRoot: root,
    targetId: published.target_id,
    operationId: published.operation_id,
    resultDigest: published.result_digest,
    now,
  }, dependencies);
}

test("accepted currentはsame operationだけexact replayし、raw proposal値を保存しない", async () => {
  const root = await temporaryRoot();
  const proposalValue = proposal({
    dedupe_key: "private-dedupe-marker",
    evidence_refs: ["git:private-evidence-marker"],
  });
  const operation = operationFor(proposalValue);
  const snapshot = snapshotFor(operation, [gitEvidence(1, { ref: "git:private-evidence-marker" })]);
  const input = {
    stateRoot: root,
    operation,
    proposal: proposalValue,
    snapshot,
    candidateResultDigest: candidate(),
    now: T0,
  };

  const first = await prepareAdvisoryDecision(input);
  assert.equal(first.status, "accepted_pending_publish");
  assert.deepEqual(await prepareAdvisoryDecision(input), first);
  await assert.rejects(
    prepareAdvisoryDecision({ ...input, candidateResultDigest: candidate(2) }),
    expectCode("E_ADVISORY_DECISION_REPLAY_CONFLICT"),
  );

  const otherProposal = proposal({ title: "別の判断" });
  const otherOperation = operationFor(otherProposal, 2);
  await assert.rejects(
    prepareAdvisoryDecision({
      ...input,
      operation: otherOperation,
      proposal: otherProposal,
      snapshot: snapshotFor(otherOperation),
    }),
    expectCode("E_ADVISORY_DECISION_REPLAY_CONFLICT"),
  );

  const raw = await readFile(join(root, "watches", TARGET_ID, "semantic-decision.json"), "utf8");
  assert.equal(raw.includes("private-dedupe-marker"), false);
  assert.equal(raw.includes("git:private-evidence-marker"), false);
  assert.equal(raw.includes(proposalValue.body), false);
});

test("proposal duplicate、snapshot ambiguous、snapshot identity mismatchをfail loudにする", async () => {
  const root = await temporaryRoot();
  const duplicateProposal = proposal({ evidence_refs: ["git:working-tree", "git:working-tree"] });
  const duplicateOperation = operationFor(duplicateProposal);
  await assert.rejects(
    prepareAdvisoryDecision({
      stateRoot: root,
      operation: duplicateOperation,
      proposal: duplicateProposal,
      snapshot: snapshotFor(duplicateOperation),
      candidateResultDigest: candidate(),
      now: T0,
    }),
    expectCode("E_ADVISORY_PROPOSAL_REF_DUPLICATE"),
  );

  const proposalValue = proposal();
  const operation = operationFor(proposalValue, 2);
  const ambiguous = snapshotFor(operation, [gitEvidence(1), gitEvidence(2)]);
  await assert.rejects(
    prepareAdvisoryDecision({
      stateRoot: root,
      operation,
      proposal: proposalValue,
      snapshot: ambiguous,
      candidateResultDigest: candidate(),
      now: T0,
    }),
    expectCode("E_ADVISORY_SNAPSHOT_REF_AMBIGUOUS"),
  );

  const mismatched = structuredClone(snapshotFor(operation));
  const otherOperation = operationFor(proposalValue, 3);
  await assert.rejects(
    prepareAdvisoryDecision({
      stateRoot: root,
      operation: otherOperation,
      proposal: proposalValue,
      snapshot: mismatched,
      candidateResultDigest: candidate(),
      now: T0,
    }),
    expectCode("E_ADVISORY_DECISION_INPUT_INVALID"),
  );
});

test("missing/unavailable/truncated/redacted evidenceはsuppressed receiptだけを残す", async (context) => {
  const cases = [
    {
      name: "missing",
      proposal: proposal({ evidence_refs: ["git:missing"] }),
      git: [gitEvidence()],
    },
    {
      name: "unavailable",
      proposal: proposal(),
      git: [gitEvidence(1, { available: false, content: null, unavailable_code: "COLLECTOR_UNAVAILABLE" })],
    },
    {
      name: "truncated",
      proposal: proposal(),
      git: [gitEvidence(1, { content: "x".repeat(12 * 1024) })],
    },
    {
      name: "redacted",
      proposal: proposal(),
      git: [gitEvidence(1, { content: `credential sk-proj-${"x".repeat(24)}` })],
    },
  ];

  for (const [index, fixture] of cases.entries()) {
    await context.test(fixture.name, async () => {
      const root = await temporaryRoot();
      const operation = operationFor(fixture.proposal, index + 1);
      const result = await prepareAdvisoryDecision({
        stateRoot: root,
        operation,
        proposal: fixture.proposal,
        snapshot: snapshotFor(operation, fixture.git),
        candidateResultDigest: candidate(index + 1),
        now: T0,
      });
      assert.equal(result.decision, "suppressed");
      assert.equal(result.reason, "evidence_ineligible");
      assert.equal(result.status, "suppressed");
      assert.match(result.result_digest, /^[a-f0-9]{64}$/);
      assert.notEqual(result.result_digest, candidate(index + 1));
      assert.equal(result.evidence_fingerprint, null);
    });
  }
});

test("publish receiptをexact検証し、pendingからpublishedへ冪等遷移する", async () => {
  const root = await temporaryRoot();
  const proposalValue = proposal();
  const operation = operationFor(proposalValue);
  const decision = await prepareAccepted({
    root,
    proposalValue,
    operation,
    snapshot: snapshotFor(operation),
  });

  await assert.rejects(
    confirmAdvisoryPublished({
      stateRoot: root,
      targetId: TARGET_ID,
      operationId: operation.operation_id,
      publishResult: { ...publishReceipt(decision), contentDigest: `sha256:${candidate(9)}` },
      now: at(1000),
    }),
    expectCode("E_ADVISORY_PUBLISH_MISMATCH"),
  );
  const published = await confirmAdvisoryPublished({
    stateRoot: root,
    targetId: TARGET_ID,
    operationId: operation.operation_id,
    publishResult: publishReceipt(decision),
    now: at(1000),
  });
  assert.equal(published.status, "accepted_published");
  assert.deepEqual(await confirmAdvisoryPublished({
    stateRoot: root,
    targetId: TARGET_ID,
    operationId: operation.operation_id,
    publishResult: publishReceipt(decision),
    now: at(1000),
  }), published);
});

test("finalizationはpendingを拒否し、historyを0600で作ってexact replayする", async () => {
  const root = await temporaryRoot();
  const proposalValue = proposal({ dedupe_key: "raw-finalize-key", evidence_refs: ["git:raw-finalize-ref"] });
  const operation = operationFor(proposalValue);
  const decision = await prepareAccepted({
    root,
    proposalValue,
    operation,
    snapshot: snapshotFor(operation, [gitEvidence(1, { ref: "git:raw-finalize-ref" })]),
  });

  await assert.rejects(
    finalizeAdvisoryDecision({
      stateRoot: root,
      targetId: TARGET_ID,
      operationId: operation.operation_id,
      resultDigest: decision.result_digest,
      now: at(1000),
    }),
    expectCode("E_ADVISORY_FINALIZE_INVALID"),
  );
  assert.deepEqual(await publishAndFinalize({ root, decision, now: at(2000) }),
    finalizationReceipt("finalized", decision));
  assert.equal(await readCurrentAdvisoryDecision({ stateRoot: root, targetId: TARGET_ID }), null);
  assert.deepEqual(await finalizeAdvisoryDecision({
    stateRoot: root,
    targetId: TARGET_ID,
    operationId: operation.operation_id,
    resultDigest: decision.result_digest,
    now: at(2000),
  }), finalizationReceipt("already_finalized", decision));

  const directory = join(root, "watches", TARGET_ID);
  const historyPath = join(directory, "semantic-history.json");
  assert.equal((await lstat(directory)).mode & 0o777, 0o700);
  assert.equal((await lstat(historyPath)).mode & 0o777, 0o600);
  const raw = await readFile(historyPath, "utf8");
  assert.equal(raw.includes("raw-finalize-key"), false);
  assert.equal(raw.includes("git:raw-finalize-ref"), false);
});

test("history write後のcrashは同一operationだけをrecoveredへ収束させる", async () => {
  const root = await temporaryRoot();
  const proposalValue = proposal();
  const operation = operationFor(proposalValue);
  const decision = await prepareAccepted({ root, proposalValue, operation, snapshot: snapshotFor(operation) });
  const published = await confirmAdvisoryPublished({
    stateRoot: root,
    targetId: TARGET_ID,
    operationId: operation.operation_id,
    publishResult: publishReceipt(decision),
    now: at(1000),
  });
  let failOnce = true;
  const dependencies = {
    async removePrivateFile(path) {
      if (failOnce) {
        failOnce = false;
        throw Object.assign(new Error("injected remove failure"), { code: "E_INJECTED_REMOVE" });
      }
      return removePrivateFile(path);
    },
  };

  await assert.rejects(
    finalizeAdvisoryDecision({
      stateRoot: root,
      targetId: TARGET_ID,
      operationId: operation.operation_id,
      resultDigest: published.result_digest,
      now: at(2000),
    }, dependencies),
    (error) => error.code === "E_INJECTED_REMOVE",
  );
  assert.notEqual(await readCurrentAdvisoryDecision({ stateRoot: root, targetId: TARGET_ID }), null);
  assert.equal((await readAdvisoryDecisionHistory({ stateRoot: root, targetId: TARGET_ID })).entries.length, 1);
  assert.deepEqual(await preflightAdvisoryFinalization({
    stateRoot: root,
    targetId: TARGET_ID,
    operationId: operation.operation_id,
    resultDigest: published.result_digest,
    now: at(2000),
  }), preflightReceipt("ready", published, 1, 0));
  assert.deepEqual(await finalizeAdvisoryDecision({
    stateRoot: root,
    targetId: TARGET_ID,
    operationId: operation.operation_id,
    resultDigest: published.result_digest,
    now: at(2000),
  }), finalizationReceipt("recovered", published));
  assert.deepEqual(await preflightAdvisoryFinalization({
    stateRoot: root,
    targetId: TARGET_ID,
    operationId: operation.operation_id,
    resultDigest: published.result_digest,
    now: at(2000),
  }), preflightReceipt("already_finalized", published, 1, 0));
});

test("60分cooldownはsame/lower severityを抑止し、severity escalationを通す", async () => {
  const root = await temporaryRoot();
  const firstProposal = proposal({ severity: "warning" });
  const firstOperation = operationFor(firstProposal, 1);
  const first = await prepareAccepted({
    root,
    proposalValue: firstProposal,
    operation: firstOperation,
    snapshot: snapshotFor(firstOperation),
  });
  await publishAndFinalize({ root, decision: first, now: at(1000) });

  const sameProposal = proposal({ severity: "info" });
  const sameOperation = operationFor(sameProposal, 2);
  const suppressed = await prepareAdvisoryDecision({
    stateRoot: root,
    operation: sameOperation,
    proposal: sameProposal,
    snapshot: snapshotFor(sameOperation, [gitEvidence(2)]),
    candidateResultDigest: candidate(2),
    now: at(30 * 60 * 1000),
  });
  assert.equal(suppressed.decision, "suppressed");
  assert.equal(suppressed.reason, "cooldown_active");
  await finalizeAdvisoryDecision({
    stateRoot: root,
    targetId: TARGET_ID,
    operationId: suppressed.operation_id,
    resultDigest: suppressed.result_digest,
    now: at(30 * 60 * 1000),
  });

  const escalatedProposal = proposal({ severity: "review_required" });
  const escalatedOperation = operationFor(escalatedProposal, 3);
  const escalated = await prepareAccepted({
    root,
    proposalValue: escalatedProposal,
    operation: escalatedOperation,
    snapshot: snapshotFor(escalatedOperation, [gitEvidence(3)]),
    result: candidate(3),
    now: at(31 * 60 * 1000),
  });
  assert.equal(escalated.reason, "eligible");
});

test("cooldown終了後はsame key/same evidenceを再acceptする", async () => {
  const root = await temporaryRoot();
  const proposalValue = proposal();
  const firstOperation = operationFor(proposalValue, 1);
  const first = await prepareAccepted({
    root,
    proposalValue,
    operation: firstOperation,
    snapshot: snapshotFor(firstOperation),
  });
  await publishAndFinalize({ root, decision: first, now: at(1000) });

  const nextOperation = operationFor(proposalValue, 2);
  const next = await prepareAccepted({
    root,
    proposalValue,
    operation: nextOperation,
    snapshot: snapshotFor(nextOperation),
    result: candidate(2),
    now: at(60 * 60 * 1000),
  });
  assert.equal(next.decision, "accepted");
});

test("durable clockより前のprepareを拒否する", async () => {
  const root = await temporaryRoot();
  const firstProposal = proposal();
  const firstOperation = operationFor(firstProposal, 1);
  const first = await prepareAccepted({
    root,
    proposalValue: firstProposal,
    operation: firstOperation,
    snapshot: snapshotFor(firstOperation),
  });
  await publishAndFinalize({ root, decision: first, now: at(2000) });

  const nextProposal = proposal({ dedupe_key: "different-key" });
  const nextOperation = operationFor(nextProposal, 2);
  await assert.rejects(
    prepareAdvisoryDecision({
      stateRoot: root,
      operation: nextOperation,
      proposal: nextProposal,
      snapshot: snapshotFor(nextOperation),
      candidateResultDigest: candidate(2),
      now: at(1000),
    }),
    expectCode("E_ADVISORY_CLOCK_ROLLBACK"),
  );
});

test("preflightは非変更でretention pruningを予告し、active cooldown saturationを拒否する", async () => {
  const root = await temporaryRoot();
  const shortPolicy = { cooldownMs: 1000, retentionMs: 1000, maxHistory: 2 };
  for (let index = 1; index <= 2; index += 1) {
    const proposalValue = proposal({ dedupe_key: `key-${index}` });
    const operation = operationFor(proposalValue, index);
    const decision = await prepareAccepted({
      root,
      proposalValue,
      operation,
      snapshot: snapshotFor(operation, [gitEvidence(index)]),
      result: candidate(index),
      now: at(index * 2000),
      dependencies: shortPolicy,
    });
    await publishAndFinalize({ root, decision, now: at(index * 2000 + 100), dependencies: shortPolicy });
  }
  const thirdProposal = proposal({ dedupe_key: "key-3" });
  const thirdOperation = operationFor(thirdProposal, 3);
  const third = await prepareAccepted({
    root,
    proposalValue: thirdProposal,
    operation: thirdOperation,
    snapshot: snapshotFor(thirdOperation, [gitEvidence(3)]),
    result: candidate(3),
    now: at(6000),
    dependencies: shortPolicy,
  });
  const thirdPublished = await confirmAdvisoryPublished({
    stateRoot: root,
    targetId: TARGET_ID,
    operationId: third.operation_id,
    publishResult: publishReceipt(third),
    now: at(6100),
  }, shortPolicy);
  const before = await readFile(join(root, "watches", TARGET_ID, "semantic-history.json"), "utf8");
  assert.deepEqual(await preflightAdvisoryFinalization({
    stateRoot: root,
    targetId: TARGET_ID,
    operationId: thirdPublished.operation_id,
    resultDigest: thirdPublished.result_digest,
    now: at(6100),
  }, shortPolicy), preflightReceipt("ready", thirdPublished, 0, 1));
  assert.equal(await readFile(join(root, "watches", TARGET_ID, "semantic-history.json"), "utf8"), before);
  await assert.rejects(
    preflightAdvisoryFinalization({
      stateRoot: root,
      targetId: TARGET_ID,
      operationId: thirdPublished.operation_id,
      resultDigest: thirdPublished.result_digest,
      now: at(6100),
    }, { ...shortPolicy, maxHistoryBytes: 1 }),
    expectCode("E_ADVISORY_HISTORY_SATURATED"),
  );
  assert.equal(await readFile(join(root, "watches", TARGET_ID, "semantic-history.json"), "utf8"), before);

  const saturatedRoot = await temporaryRoot();
  const saturatedPolicy = { maxHistory: 1 };
  const protectedProposal = proposal({ dedupe_key: "protected-1" });
  const protectedOperation = operationFor(protectedProposal, 11);
  const protectedDecision = await prepareAccepted({
    root: saturatedRoot,
    proposalValue: protectedProposal,
    operation: protectedOperation,
    snapshot: snapshotFor(protectedOperation),
    result: candidate(11),
    dependencies: saturatedPolicy,
  });
  await publishAndFinalize({ root: saturatedRoot, decision: protectedDecision, now: at(1000), dependencies: saturatedPolicy });

  const blockedProposal = proposal({ dedupe_key: "protected-2" });
  const blockedOperation = operationFor(blockedProposal, 12);
  const blockedDecision = await prepareAccepted({
    root: saturatedRoot,
    proposalValue: blockedProposal,
    operation: blockedOperation,
    snapshot: snapshotFor(blockedOperation),
    result: candidate(12),
    now: at(2000),
    dependencies: saturatedPolicy,
  });
  const blockedPublished = await confirmAdvisoryPublished({
    stateRoot: saturatedRoot,
    targetId: TARGET_ID,
    operationId: blockedDecision.operation_id,
    publishResult: publishReceipt(blockedDecision),
    now: at(2000),
  }, saturatedPolicy);
  await assert.rejects(
    preflightAdvisoryFinalization({
      stateRoot: saturatedRoot,
      targetId: TARGET_ID,
      operationId: blockedPublished.operation_id,
      resultDigest: blockedPublished.result_digest,
      now: at(2000),
    }, saturatedPolicy),
    expectCode("E_ADVISORY_HISTORY_SATURATED"),
  );
});

test("history decision digest改竄とoperation extra fieldをfail closedにする", async () => {
  const root = await temporaryRoot();
  const proposalValue = proposal();
  const operation = operationFor(proposalValue);
  await assert.rejects(
    prepareAdvisoryDecision({
      stateRoot: root,
      operation: { ...operation, extra: true },
      proposal: proposalValue,
      snapshot: snapshotFor(operation),
      candidateResultDigest: candidate(),
      now: T0,
    }),
    expectCode("E_ADVISORY_DECISION_INPUT_INVALID"),
  );

  const decision = await prepareAccepted({ root, proposalValue, operation, snapshot: snapshotFor(operation) });
  await publishAndFinalize({ root, decision, now: at(1000) });
  const historyPath = join(root, "watches", TARGET_ID, "semantic-history.json");
  const history = JSON.parse(await readFile(historyPath, "utf8"));
  history.entries[0].decision_digest = `sha256:${"f".repeat(64)}`;
  const { atomicReplacePrivateFile } = await import("../src/private-state.mjs");
  await atomicReplacePrivateFile(historyPath, `${JSON.stringify(history)}\n`);
  await assert.rejects(
    readAdvisoryDecisionHistory({ stateRoot: root, targetId: TARGET_ID }),
    expectCode("E_ADVISORY_HISTORY_INVALID"),
  );
});

test("integration receipt validatorはidentity fieldと未知fieldをexact検証する", async () => {
  const root = await temporaryRoot();
  const proposalValue = proposal();
  const operation = operationFor(proposalValue);
  const decision = await prepareAccepted({ root, proposalValue, operation, snapshot: snapshotFor(operation) });
  assert.deepEqual(validateAdvisoryDecisionReceipt(decision), decision);
  assert.throws(
    () => validateAdvisoryDecisionReceipt({ ...decision, extra: true }),
    expectCode("E_ADVISORY_DECISION_STATE_INVALID"),
  );

  const published = await confirmAdvisoryPublished({
    stateRoot: root,
    targetId: TARGET_ID,
    operationId: operation.operation_id,
    publishResult: publishReceipt(decision),
    now: at(1000),
  });
  const preflight = await preflightAdvisoryFinalization({
    stateRoot: root,
    targetId: TARGET_ID,
    operationId: operation.operation_id,
    resultDigest: published.result_digest,
    now: at(1000),
  });
  assert.deepEqual(validateAdvisoryFinalizationPreflightReceipt(preflight), preflight);
  assert.throws(
    () => validateAdvisoryFinalizationPreflightReceipt({ ...preflight, target_id: `p_${"f".repeat(63)}` }),
    expectCode("E_ADVISORY_PREFLIGHT_RECEIPT_INVALID"),
  );

  const finalized = await finalizeAdvisoryDecision({
    stateRoot: root,
    targetId: TARGET_ID,
    operationId: operation.operation_id,
    resultDigest: published.result_digest,
    now: at(1000),
  });
  assert.deepEqual(validateAdvisoryFinalizationReceipt(finalized), finalized);
  assert.throws(
    () => validateAdvisoryFinalizationReceipt({ ...finalized, extra: true }),
    expectCode("E_ADVISORY_FINALIZATION_RECEIPT_INVALID"),
  );
});
