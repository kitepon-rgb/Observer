import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildEvidenceSnapshot } from "../src/evidence-snapshot.mjs";
import { generationParentEpochId } from "../src/generation-store.mjs";
import { acquirePrivateLock } from "../src/private-state.mjs";
import {
  inspectSupervisorProductionLock,
  recoverSupervisorProductionLock,
  runSupervisorProductionStep,
} from "../src/supervisor-production-step.mjs";

const TARGET_ID = `p_${"a".repeat(64)}`;
const WATCH_ID = "w_11111111-1111-4111-8111-111111111111";
const THREAD_ID = "019f62a1-1111-7111-8111-111111111111";
const THREAD_SHA = "b".repeat(64);
const GENERATION_ID = `sha256:${"c".repeat(64)}`;
const CYCLE_ID = `c_${"d".repeat(64)}`;
const TARGET = { schema: "observer.project_target.v1", targetId: TARGET_ID, projectRoot: "/project" };
const PROPOSED = {
  schema: "observer.parent_state.v1",
  target_id: TARGET_ID,
  project_root: TARGET.projectRoot,
  status: "ready",
  host: "codex",
  thread_sha256: THREAD_SHA,
  cursor: "tlc1.through",
};
const BINDING = {
  schema: "observer.watch_host_binding.v1",
  watch_id: WATCH_ID,
  target_id: TARGET_ID,
  project_root: TARGET.projectRoot,
  provider: "codex",
  status: "active",
  launch_handle: { kind: "codex.thread", value: THREAD_ID },
};
const GENERATION = {
  status: "active",
  target_id: TARGET_ID,
  watch_id: WATCH_ID,
  provider: "codex",
  generation_id: GENERATION_ID,
  parent_epoch_id: generationParentEpochId("codex", THREAD_SHA),
};
const CLIENT = { read: async () => assert.fail(), wait: async () => assert.fail() };
const SESSION = { request: async () => assert.fail() };
const TEST_STATE_ROOT = await mkdtemp(join(tmpdir(), "observer-supervisor-step-"));
await mkdir(join(TEST_STATE_ROOT, "watches", TARGET_ID), { recursive: true, mode: 0o700 });
await chmod(TEST_STATE_ROOT, 0o700);
await chmod(join(TEST_STATE_ROOT, "watches"), 0o700);
await chmod(join(TEST_STATE_ROOT, "watches", TARGET_ID), 0o700);

function request(overrides = {}) {
  return {
    stateRoot: TEST_STATE_ROOT,
    target: TARGET,
    watchId: WATCH_ID,
    client: CLIENT,
    providerRuntime: { provider: "codex", runtime_root: "/observer", session: SESSION },
    planRefs: [],
    testReceipts: [],
    ...overrides,
  };
}

function baseDependencies(overrides = {}) {
  let released = 0;
  const dependencies = {
    acquirePrivateLock: async () => async () => { released += 1; },
    readWatchHostBinding: async () => BINDING,
    readGenerationState: async () => GENERATION,
    readCycleState: async () => ({
      committed_state: null,
      pending_cycle: {
        status: "prepared",
        cycle_id: CYCLE_ID,
        base_cursor: "tlc1.after",
        proposed_state: PROPOSED,
      },
    }),
    collectEvidenceSnapshot: async (input) => buildEvidenceSnapshot({
      context: input.context,
      turns: input.turns,
      plan: [],
      git: [],
      tests: [],
    }),
    ...overrides,
  };
  return { dependencies, released: () => released };
}

test("Codex一stepはcanonical inputを作りprovider／application callbackを同じidentityへroutingする", async () => {
  const calls = [];
  const { dependencies, released } = baseDependencies({
    issueCodexModelOperation: async (input) => {
      calls.push(["issue", input]);
      return { schema: "observer.model_operation_callback.v1", outcome: "accepted", provider_operation_receipt_digest: `sha256:${"e".repeat(64)}` };
    },
    recoverCodexModelOperation: async (input) => {
      calls.push(["recover", input]);
      return { schema: "observer.model_operation_callback.v1", outcome: "pending" };
    },
    cleanupCodexModelOperation: async (input) => {
      calls.push(["cleanup", input]);
      return { schema: "observer.model_operation_cleanup.v1", outcome: "cleaned" };
    },
    applyCycleOutput: async (input) => {
      calls.push(["apply", input]);
      return { schema: "observer.cycle_result.v1", result_digest: "f".repeat(64) };
    },
    finalizeCycleApplication: async (input) => {
      calls.push(["finalize", input]);
      return { schema: "observer.cycle_application_finalization.v1", outcome: "no_op" };
    },
    runSupervisorCycle: async (input) => {
      const cycleInput = await input.prepareCycleInput({ cycle_id: CYCLE_ID, proposed_state: PROPOSED, turns: [] });
      assert.equal(JSON.parse(cycleInput.value).evidence.context.parent_thread_sha256, THREAD_SHA);
      const operation = {
        schema: "observer.model_operation_receipt.v1",
        action: "issue_once",
        provider: "codex",
        operation_id: `sha256:${"1".repeat(64)}`,
        target_id: TARGET_ID,
        watch_id: WATCH_ID,
        generation_id: GENERATION_ID,
        cycle_id: CYCLE_ID,
        input_digest: cycleInput.input_digest,
        model_visible_bytes: cycleInput.model_visible_bytes,
        status: "dispatching",
        provider_operation_receipt_digest: null,
      };
      await input.issueModelOperation({ operation, value: cycleInput.value });
      await input.recoverModelOperation({ operation: { ...operation, action: "recover_only", status: "accepted", provider_operation_receipt_digest: `sha256:${"e".repeat(64)}` } });
      await input.cleanupProviderOperation({ operation: { ...operation, action: "cleanup_only", status: "completed", provider_operation_receipt_digest: `sha256:${"e".repeat(64)}`, completed_output_digest: `sha256:${"2".repeat(64)}` } });
      await input.applyCycle({ operation: { ...operation, action: "recover_only", status: "completed", provider_operation_receipt_digest: `sha256:${"e".repeat(64)}` }, output: { schema: "observer.ai_output.v1", outcome: "no_advisory" } });
      await input.finalizeAppliedCycle({ operation: { ...operation, action: "recover_only", status: "applied", provider_operation_receipt_digest: `sha256:${"e".repeat(64)}`, applied_result: { schema: "observer.cycle_result.v1", result_digest: "f".repeat(64) }, completed_output_digest: `sha256:${"2".repeat(64)}` } });
      return { status: "committed", cycle_id: CYCLE_ID, turns: [{ secret: "not returned" }] };
    },
  });
  const result = await runSupervisorProductionStep(request(), dependencies);
  assert.deepEqual(result, {
    schema: "observer.supervisor_production_result.v1",
    status: "committed",
    provider: "codex",
    cycle_id: CYCLE_ID,
  });
  assert.deepEqual(calls.map(([name]) => name), ["issue", "recover", "cleanup", "apply", "finalize"]);
  assert.equal(calls[0][1].runtime.thread_id, THREAD_ID);
  assert.equal(calls[0][1].runtime.cwd, "/observer");
  assert.equal(calls[3][1].cycleInput.input_digest, calls[0][1].operation.input_digest);
  assert.equal(released(), 1);
});

test("ClaudeまたはCodex runtime欠損はwait／pending cycleより前にprovider_unavailableを返す", async () => {
  for (const provider of ["claude", "codex"]) {
    let ran = 0;
    const binding = {
      ...BINDING,
      provider,
      launch_handle: provider === "codex" ? BINDING.launch_handle : { kind: "claude.job", value: "job-1" },
    };
    const generation = {
      ...GENERATION,
      provider,
      parent_epoch_id: generationParentEpochId(provider, THREAD_SHA),
    };
    const { dependencies, released } = baseDependencies({
      readWatchHostBinding: async () => binding,
      readGenerationState: async () => generation,
      runSupervisorCycle: async () => { ran += 1; },
    });
    const result = await runSupervisorProductionStep(request({ providerRuntime: null }), dependencies);
    assert.deepEqual(result, { schema: "observer.supervisor_production_result.v1", status: "provider_unavailable", provider, cycle_id: null });
    assert.equal(ran, 0);
    assert.equal(released(), 1);
  }
});

test("proposed parentがgeneration epochと違えばprovider request前にrebind requiredで止める", async () => {
  let issued = 0;
  const switched = { ...PROPOSED, thread_sha256: "0".repeat(64) };
  const { dependencies, released } = baseDependencies({
    readCycleState: async () => ({ pending_cycle: { status: "prepared", cycle_id: CYCLE_ID, base_cursor: "tlc1.after", proposed_state: switched } }),
    issueCodexModelOperation: async () => { issued += 1; },
    runSupervisorCycle: async (input) => input.prepareCycleInput({ cycle_id: CYCLE_ID, proposed_state: switched, turns: [] }),
  });
  await assert.rejects(runSupervisorProductionStep(request(), dependencies), { code: "E_SUPERVISOR_PARENT_REBIND_REQUIRED" });
  assert.equal(issued, 0);
  assert.equal(released(), 1);
});

test("target固有lockは並走拒否しinspectしたnonceだけで明示回復する", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "observer-supervisor-lock-"));
  const targetRoot = join(stateRoot, "watches", TARGET_ID);
  await mkdir(targetRoot, { recursive: true, mode: 0o700 });
  await chmod(stateRoot, 0o700);
  await chmod(join(stateRoot, "watches"), 0o700);
  await chmod(targetRoot, 0o700);
  const lockPath = join(targetRoot, "supervisor-step.lock");
  await acquirePrivateLock(lockPath);
  const owner = await inspectSupervisorProductionLock({ stateRoot, targetId: TARGET_ID });
  assert.equal(typeof owner.nonce, "string");
  await assert.rejects(recoverSupervisorProductionLock({ stateRoot, targetId: TARGET_ID, expectedNonce: "wrong" }), {
    code: "E_LOCK_OWNERSHIP_MISMATCH",
  });
  assert.equal(await recoverSupervisorProductionLock({ stateRoot, targetId: TARGET_ID, expectedNonce: owner.nonce }), true);
  assert.equal(await inspectSupervisorProductionLock({ stateRoot, targetId: TARGET_ID }), null);
});
