import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  activateReboundGeneration,
  authorizeGenerationParentRebind,
  authorizeReboundGenerationStart,
  confirmGenerationParentRebindTerminal,
  prepareGenerationParentRebindStop,
  readGenerationParentRebindRecoveryContext,
  readGenerationParentRebindStatus,
  recordReboundGenerationSpawn,
} from "../src/generation-parent-rebind.mjs";
import { generationParentEpochId, initializeGeneration, readGenerationState } from "../src/generation-store.mjs";
import { ObserverError } from "../src/observer-error.mjs";
import { buildGenerationLaunchRequest } from "../src/parent-launch.mjs";
import {
  activateWatch,
  attachWatchLaunchHandle,
  readWatchHostBinding,
  reserveActiveWatch,
} from "../src/watch-store.mjs";

const TARGET = { schema: "observer.project_target.v1", targetId: `p_${"a".repeat(64)}`, projectRoot: "/repo" };
const WATCH_ID = "w_11111111-1111-4111-8111-111111111111";
const CYCLE_ID = `c_${"c".repeat(64)}`;
const OLD_PARENT = "b".repeat(64);
const NEW_PARENT = "d".repeat(64);
const OLD_HANDLE = { kind: "claude.job", value: "job-old" };
const NEW_HANDLE = { kind: "codex.thread", value: "11111111-1111-7111-8111-111111111111" };
const T0 = new Date("2026-07-16T00:00:00.000Z");
const T1 = new Date("2026-07-16T00:01:00.000Z");

function receipt(provider, outcome, handle) {
  return { schema: "observer.host_receipt.v1", provider, target_id: TARGET.targetId, watch_id: WATCH_ID, outcome, handle };
}

function proposed(overrides = {}) {
  return {
    schema: "observer.parent_state.v1",
    target_id: TARGET.targetId,
    project_root: TARGET.projectRoot,
    status: "ready",
    host: "codex",
    thread_sha256: NEW_PARENT,
    cursor: "cursor-new-parent",
    ...overrides,
  };
}

function expectCode(code) { return (error) => error instanceof ObserverError && error.code === code; }

async function setup() {
  const stateRoot = await mkdtemp(join(tmpdir(), "observer-parent-rebind-"));
  const starting = await reserveActiveWatch({ stateRoot, target: TARGET, provider: "claude" }, {
    randomUUID: () => WATCH_ID.slice(2), now: () => T0,
  });
  await attachWatchLaunchHandle({ stateRoot, targetId: TARGET.targetId, watchId: starting.watch_id, launchHandle: OLD_HANDLE }, { now: () => T0 });
  await activateWatch({ stateRoot, targetId: TARGET.targetId, watchId: starting.watch_id, launchHandle: OLD_HANDLE }, { now: () => T0 });
  await initializeGeneration({
    stateRoot,
    targetId: TARGET.targetId,
    watchId: WATCH_ID,
    provider: "claude",
    parentThreadSha256: OLD_PARENT,
    readyReceipt: receipt("claude", "ready", OLD_HANDLE),
  }, { now: () => T0 });
  return stateRoot;
}

test("parent rebind coreはauthorization→旧terminal→new epoch activationを同じwatchで進める", async () => {
  const stateRoot = await setup();
  const first = await authorizeGenerationParentRebind({
    stateRoot, target: TARGET, watchId: WATCH_ID, cycleId: CYCLE_ID, proposedParent: proposed(),
  }, { now: () => T1 });
  assert.equal(first.schema, "observer.generation_parent_rebind_result.v1");
  assert.equal(first.outcome, "recorded");
  assert.equal(first.authorization.to_parent_epoch_id, generationParentEpochId("codex", NEW_PARENT));
  assert.equal((await readGenerationState({ stateRoot, targetId: TARGET.targetId })).status, "rebind_required");
  const retry = await authorizeGenerationParentRebind({
    stateRoot, target: TARGET, watchId: WATCH_ID, cycleId: CYCLE_ID, proposedParent: proposed(),
  }, { now: () => T1 });
  assert.equal(retry.outcome, "existing");
  assert.deepEqual(retry.authorization, first.authorization);

  const raw = await readFile(join(stateRoot, "watches", TARGET.targetId, "parent-rebind.json"), "utf8");
  assert.equal(raw.includes(OLD_HANDLE.value), false);
  assert.equal(raw.includes(NEW_PARENT), false);
  assert.equal(JSON.stringify(await readGenerationParentRebindStatus({ stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID })).includes(OLD_HANDLE.value), false);

  const legacy = JSON.parse(raw);
  delete legacy.stop_command_receipt_digest;
  await writeFile(join(stateRoot, "watches", TARGET.targetId, "parent-rebind.json"), `${JSON.stringify(legacy)}\n`);

  const stopping = await prepareGenerationParentRebindStop({ stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID }, { now: () => T1 });
  assert.equal(stopping.outcome, "issue_once");
  assert.deepEqual(stopping.stop_request.handle, OLD_HANDLE);
  assert.equal(JSON.parse(await readFile(join(stateRoot, "watches", TARGET.targetId, "parent-rebind.json"), "utf8")).stop_command_receipt_digest, null);
  assert.equal((await prepareGenerationParentRebindStop({ stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID }, { now: () => T1 })).outcome, "observe_only");
  const stoppingRetry = await authorizeGenerationParentRebind({
    stateRoot, target: TARGET, watchId: WATCH_ID, cycleId: CYCLE_ID, proposedParent: proposed(),
  }, { now: () => T1 });
  assert.equal(stoppingRetry.outcome, "existing");
  assert.deepEqual(stoppingRetry.authorization, first.authorization);

  const stopped = receipt("claude", "stopped", OLD_HANDLE);
  const stopCommandReceipt = { schema: "aiterm.pty-close-result.v1", session_id: "claude_old", outcome: "closed" };
  await confirmGenerationParentRebindTerminal({ stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID, terminalReceipt: stopped, stopCommandReceipt }, { now: () => T1 });
  await confirmGenerationParentRebindTerminal({ stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID, terminalReceipt: stopped, stopCommandReceipt }, { now: () => T1 });
  const terminalJournal = JSON.parse(await readFile(join(stateRoot, "watches", TARGET.targetId, "parent-rebind.json"), "utf8"));
  assert.match(terminalJournal.stop_command_receipt_digest, /^sha256:[a-f0-9]{64}$/);
  await assert.rejects(confirmGenerationParentRebindTerminal({
    stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID, terminalReceipt: stopped,
    stopCommandReceipt: { ...stopCommandReceipt, outcome: "already_closed" },
  }, { now: () => T1 }), expectCode("E_PARENT_REBIND_RECEIPT_CONFLICT"));
  const launchRequest = buildGenerationLaunchRequest({ target: TARGET, watchId: WATCH_ID, provider: "codex", runtimeRoot: "/observer" });
  const authorized = await authorizeReboundGenerationStart({
    stateRoot, target: TARGET, watchId: WATCH_ID, authorization: first.authorization, launchRequest,
  }, { now: () => T1 });
  assert.equal(authorized.outcome, "issue_once");
  assert.equal((await readGenerationParentRebindRecoveryContext({
    stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID, authorization: first.authorization, launchRequest,
  })).status, "spawn_authorized");
  const otherRuntimeRequest = buildGenerationLaunchRequest({ target: TARGET, watchId: WATCH_ID, provider: "codex", runtimeRoot: "/other-observer" });
  await assert.rejects(readGenerationParentRebindRecoveryContext({
    stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID, authorization: first.authorization, launchRequest: otherRuntimeRequest,
  }), expectCode("E_PARENT_REBIND_RECEIPT_CONFLICT"));
  assert.equal((await authorizeReboundGenerationStart({
    stateRoot, target: TARGET, watchId: WATCH_ID, authorization: first.authorization, launchRequest,
  }, { now: () => T1 })).outcome, "recover_only");

  const spawned = receipt("codex", "spawned", NEW_HANDLE);
  await recordReboundGenerationSpawn({ stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID, spawnReceipt: spawned }, { now: () => T1 });
  await recordReboundGenerationSpawn({ stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID, spawnReceipt: spawned }, { now: () => T1 });
  const reboundBinding = await readWatchHostBinding({ stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID });
  assert.equal(reboundBinding.provider, "codex");
  assert.deepEqual(reboundBinding.launch_handle, NEW_HANDLE);

  const activated = await activateReboundGeneration({
    stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID, readyReceipt: receipt("codex", "ready", NEW_HANDLE),
  }, { now: () => T1 });
  assert.equal(activated.outcome, "activated");
  const generation = await readGenerationState({ stateRoot, targetId: TARGET.targetId });
  assert.equal(generation.status, "active");
  assert.equal(generation.provider, "codex");
  assert.equal(generation.sequence, 1);
  assert.equal(generation.parent_epoch_id, generationParentEpochId("codex", NEW_PARENT));
  assert.equal(await readGenerationParentRebindStatus({ stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID }), null);
});

test("parent rebind coreはterminal前startと異なるauthorization／receiptをfail loudにする", async () => {
  const stateRoot = await setup();
  const authorized = await authorizeGenerationParentRebind({
    stateRoot, target: TARGET, watchId: WATCH_ID, cycleId: CYCLE_ID, proposedParent: proposed(),
  }, { now: () => T1 });
  const launchRequest = buildGenerationLaunchRequest({ target: TARGET, watchId: WATCH_ID, provider: "codex", runtimeRoot: "/observer" });
  await assert.rejects(authorizeReboundGenerationStart({
    stateRoot, target: TARGET, watchId: WATCH_ID, authorization: authorized.authorization, launchRequest,
  }, { now: () => T1 }), expectCode("E_PARENT_REBIND_TRANSITION_INVALID"));
  await assert.rejects(authorizeGenerationParentRebind({
    stateRoot, target: TARGET, watchId: WATCH_ID, cycleId: CYCLE_ID, proposedParent: proposed({ thread_sha256: "e".repeat(64) }),
  }, { now: () => T1 }), expectCode("E_PARENT_REBIND_AUTHORIZATION_CONFLICT"));
  await prepareGenerationParentRebindStop({ stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID }, { now: () => T1 });
  await assert.rejects(confirmGenerationParentRebindTerminal({
    stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID,
    terminalReceipt: receipt("claude", "stopped", { kind: "claude.job", value: "other-job" }),
  }, { now: () => T1 }), expectCode("E_PARENT_REBIND_RECEIPT_CONFLICT"));
});

test("same-provider rebindはauthorization crashを回収しold→new handle CASを冪等化する", async () => {
  const stateRoot = await setup();
  const initial = await readGenerationState({ stateRoot, targetId: TARGET.targetId });
  const sameProviderParent = proposed({ host: "claude", thread_sha256: "e".repeat(64) });
  const authorized = await authorizeGenerationParentRebind({
    stateRoot, target: TARGET, watchId: WATCH_ID, cycleId: CYCLE_ID, proposedParent: sameProviderParent,
  }, {
    now: () => T1,
    authorizeGenerationRebind: async () => ({ ...initial, status: "rebind_required", rollover_reason: "parent_rebind" }),
  });
  assert.equal((await readGenerationState({ stateRoot, targetId: TARGET.targetId })).status, "active");
  const stop = await prepareGenerationParentRebindStop({ stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID }, { now: () => T1 });
  assert.equal(stop.outcome, "issue_once");
  assert.equal((await readGenerationState({ stateRoot, targetId: TARGET.targetId })).status, "stopping");
  await confirmGenerationParentRebindTerminal({
    stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID, terminalReceipt: receipt("claude", "stopped", OLD_HANDLE),
  }, { now: () => T1 });
  const launchRequest = buildGenerationLaunchRequest({ target: TARGET, watchId: WATCH_ID, provider: "claude", runtimeRoot: "/observer" });
  await authorizeReboundGenerationStart({
    stateRoot, target: TARGET, watchId: WATCH_ID, authorization: authorized.authorization, launchRequest,
  }, { now: () => T1 });
  const nextHandle = { kind: "claude.job", value: "job-new" };
  const spawned = receipt("claude", "spawned", nextHandle);
  await recordReboundGenerationSpawn({ stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID, spawnReceipt: spawned }, { now: () => T1 });
  await recordReboundGenerationSpawn({ stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID, spawnReceipt: spawned }, { now: () => T1 });
  assert.deepEqual((await readWatchHostBinding({ stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID })).launch_handle, nextHandle);
  await activateReboundGeneration({
    stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID, readyReceipt: receipt("claude", "ready", nextHandle),
  }, { now: () => T1 });
  const generation = await readGenerationState({ stateRoot, targetId: TARGET.targetId });
  assert.equal(generation.provider, "claude");
  assert.equal(generation.sequence, 1);
  assert.equal(generation.parent_epoch_id, generationParentEpochId("claude", sameProviderParent.thread_sha256));
});
