import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { applyCycleOutput, finalizeCycleApplication } from "../src/cycle-application.mjs";
import { buildCycleInput } from "../src/cycle-input.mjs";
import { buildEvidenceSnapshot } from "../src/evidence-snapshot.mjs";
import { ensureMailbox } from "../src/mailbox-store.mjs";
import {
  acceptModelOperation,
  applyModelOperation,
  completeModelOperation,
  dispatchModelOperation,
  prepareModelOperation,
  readModelOperation,
  reserveModelOperation,
} from "../src/model-operation-store.mjs";

const NOW = new Date("2099-07-15T00:00:00.000Z");
const TARGET_ID = `p_${"a".repeat(64)}`;
const WATCH_ID = "w_11111111-1111-4111-8111-111111111111";
const GENERATION_ID = `sha256:${"b".repeat(64)}`;
const CYCLE_ID = `c_${"c".repeat(64)}`;
const PROVIDER_RECEIPT = `sha256:${"e".repeat(64)}`;
const THREAD_SHA256 = "f".repeat(64);
const CYCLE_INPUT = buildCycleInput(buildEvidenceSnapshot({
  context: {
    after_cursor_sha256: "1".repeat(64),
    cycle_id: CYCLE_ID,
    parent_host: "codex",
    parent_thread_sha256: THREAD_SHA256,
    target_id: TARGET_ID,
    through_cursor_sha256: "2".repeat(64),
    watch_id: WATCH_ID,
  },
  turns: [],
  plan: [],
  git: [],
  tests: [],
}));
const ADVISORY = {
  schema: "observer.ai_output.v1",
  outcome: "advisory",
  proposal: {
    body: "同じ失敗経路が繰り返されています。",
    category: "repeated_failure",
    dedupe_key: "failure:stable",
    evidence_refs: ["git:unstaged_diff", "test:focused"],
    severity: "warning",
    suggested_action: "失敗scopeだけを再検証する",
    title: "同じ失敗経路を反復しています",
  },
};
const NO_ADVISORY = { schema: "observer.ai_output.v1", outcome: "no_advisory" };

async function setup(output, { createdAt = NOW } = {}) {
  const stateRoot = await mkdtemp(join(tmpdir(), "observer-cycle-application-"));
  const targetRoot = join(stateRoot, "watches", TARGET_ID);
  await mkdir(targetRoot, { recursive: true, mode: 0o700 });
  await chmod(stateRoot, 0o700);
  await chmod(join(stateRoot, "watches"), 0o700);
  await chmod(targetRoot, 0o700);
  const identity = {
    stateRoot,
    targetId: TARGET_ID,
    watchId: WATCH_ID,
    generationId: GENERATION_ID,
    cycleId: CYCLE_ID,
    inputDigest: CYCLE_INPUT.input_digest,
    modelVisibleBytes: CYCLE_INPUT.model_visible_bytes,
    provider: "codex",
  };
  const clock = { now: () => createdAt };
  const prepared = await prepareModelOperation(identity, clock);
  await reserveModelOperation(identity, {
    ...clock,
    readGenerationState: async () => ({
      provider: "codex",
      watch_id: WATCH_ID,
      generation_id: GENERATION_ID,
      status: "active",
      pending_reservation: null,
    }),
    reserveGenerationInput: async () => ({ outcome: "reserved" }),
  });
  await dispatchModelOperation({ stateRoot, targetId: TARGET_ID, operationId: prepared.operation_id }, clock);
  await acceptModelOperation({
    stateRoot,
    targetId: TARGET_ID,
    operationId: prepared.operation_id,
    providerOperationReceiptDigest: PROVIDER_RECEIPT,
  }, clock);
  await completeModelOperation({
    stateRoot,
    targetId: TARGET_ID,
    operationId: prepared.operation_id,
    rawOutput: JSON.stringify(output),
  }, clock);
  return {
    stateRoot,
    output,
    operation: publicOperation(await readModelOperation({ stateRoot, targetId: TARGET_ID })),
  };
}

function publicOperation(durable) {
  return {
    schema: "observer.model_operation_receipt.v1",
    action: "recover_only",
    provider: durable.provider,
    operation_id: durable.operation_id,
    target_id: durable.target_id,
    watch_id: durable.watch_id,
    generation_id: durable.generation_id,
    cycle_id: durable.cycle_id,
    input_digest: durable.input_digest,
    model_visible_bytes: durable.model_visible_bytes,
    status: durable.status,
    provider_operation_receipt_digest: durable.provider_operation_receipt_digest,
  };
}

async function markApplied(fixture, result) {
  await applyModelOperation({
    stateRoot: fixture.stateRoot,
    targetId: TARGET_ID,
    operationId: fixture.operation.operation_id,
    appliedResult: result,
  }, { now: () => NOW });
  const durable = await readModelOperation({ stateRoot: fixture.stateRoot, targetId: TARGET_ID });
  return {
    ...publicOperation(durable),
    applied_result: durable.applied_result,
    completed_output_digest: durable.completed_output_digest,
  };
}

test("no-advisoryはMailboxを作らずdurable outputから同じresultを再構成する", async () => {
  const fixture = await setup(NO_ADVISORY);
  const input = { ...fixture, cycleInput: CYCLE_INPUT, now: NOW };
  const first = await applyCycleOutput(input);
  const replay = await applyCycleOutput(input);
  assert.deepEqual(replay, first);
  assert.match(first.result_digest, /^[a-f0-9]{64}$/);

  const finalized = await finalizeCycleApplication({
    stateRoot: fixture.stateRoot,
    operation: await markApplied(fixture, first),
  });
  assert.deepEqual(finalized, { schema: "observer.cycle_application_finalization.v1", outcome: "no_op" });
});

test("advisoryは決定的messageを一度だけpublishしapplied後だけreceiptをcleanupする", async () => {
  const fixture = await setup(ADVISORY);
  const input = { ...fixture, cycleInput: CYCLE_INPUT, now: NOW };
  const first = await applyCycleOutput(input);
  const replay = await applyCycleOutput(input);
  assert.deepEqual(replay, first);

  const mailbox = await ensureMailbox(fixture.stateRoot, TARGET_ID);
  const inbox = await readdir(mailbox.inbox);
  assert.equal(inbox.length, 1);
  const message = JSON.parse(await readFile(join(mailbox.inbox, inbox[0]), "utf8"));
  assert.equal(message.created_at, NOW.toISOString());
  assert.equal(message.expires_at, "2099-07-16T00:00:00.000Z");
  assert.equal(message.target.thread_sha256, THREAD_SHA256);
  assert.equal(message.content_digest, `sha256:${first.result_digest}`);
  assert.equal(JSON.stringify(first).includes(ADVISORY.proposal.body), false);

  const operation = await markApplied(fixture, first);
  assert.deepEqual(await finalizeCycleApplication({ stateRoot: fixture.stateRoot, operation }), {
    schema: "observer.cycle_application_finalization.v1",
    outcome: "cleaned",
  });
  assert.deepEqual(await finalizeCycleApplication({ stateRoot: fixture.stateRoot, operation }), {
    schema: "observer.cycle_application_finalization.v1",
    outcome: "already_cleaned",
  });
  assert.deepEqual(await readdir(mailbox["publish-receipts"]), []);
});

test("identity、canonical output、threadをdurable operationと独立検証する", async () => {
  const fixture = await setup(ADVISORY);
  const base = { ...fixture, cycleInput: CYCLE_INPUT, now: NOW };
  await assert.rejects(applyCycleOutput({ ...base, operation: { ...fixture.operation, cycle_id: `c_${"0".repeat(64)}` } }), {
    code: "E_CYCLE_APPLICATION_IDENTITY_MISMATCH",
  });
  await assert.rejects(applyCycleOutput({ ...base, output: NO_ADVISORY }), {
    code: "E_CYCLE_APPLICATION_OUTPUT_MISMATCH",
  });
  const otherThreadInput = buildCycleInput(buildEvidenceSnapshot({
    context: {
      ...JSON.parse(CYCLE_INPUT.value).evidence.context,
      parent_thread_sha256: "0".repeat(64),
    },
    turns: [], plan: [], git: [], tests: [],
  }));
  await assert.rejects(applyCycleOutput({ ...base, cycleInput: otherThreadInput }), {
    code: "E_CYCLE_INPUT_RECEIPT_MISMATCH",
  });
});

test("期限切れadvisoryを現在時刻の新messageへ置き換えない", async () => {
  const fixture = await setup(ADVISORY);
  await assert.rejects(applyCycleOutput({
    ...fixture,
    cycleInput: CYCLE_INPUT,
    now: new Date(NOW.getTime() + 2 * 24 * 60 * 60 * 1000),
  }), { code: "E_CYCLE_APPLICATION_EXPIRED" });
});
