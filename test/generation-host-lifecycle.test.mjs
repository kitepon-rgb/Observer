import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  activateNextGenerationHost,
  authorizeNextGenerationHostStart,
  confirmGenerationHostTerminal,
  readGenerationHostRecoveryContext,
  readGenerationHostRolloverStatus,
  prepareGenerationHostStop,
  recordNextGenerationHostSpawn,
} from "../src/generation-host-lifecycle.mjs";
import {
  activateGeneration,
  completeGenerationCycle,
  initializeGeneration,
  readGenerationState,
  reserveGenerationInput,
} from "../src/generation-store.mjs";
import { ObserverError } from "../src/observer-error.mjs";
import {
  activateWatch,
  attachWatchLaunchHandle,
  reserveActiveWatch,
} from "../src/watch-store.mjs";

const TARGET = { schema: "observer.project_target.v1", targetId: `p_${"a".repeat(64)}`, projectRoot: "/project" };
const WATCH_UUID = "11111111-1111-4111-8111-111111111111";
const WATCH_ID = `w_${WATCH_UUID}`;
const OLD_JOB = "job-old";
const NEW_JOB = "job-new";
const T0 = new Date("2026-07-15T06:00:00.000Z");
const T1 = new Date("2026-07-15T06:01:00.000Z");
const CYCLE = `c_${"c".repeat(64)}`;
const NEXT_CYCLE = `c_${"d".repeat(64)}`;
const INPUT = `sha256:${"e".repeat(64)}`;
const RESULT = `sha256:${"f".repeat(64)}`;

function receipt(outcome, value = OLD_JOB) {
  return {
    schema: "observer.host_receipt.v1",
    provider: "claude",
    watch_id: WATCH_ID,
    target_id: TARGET.targetId,
    outcome,
    handle: { kind: "claude.job", value },
  };
}

function launchRequest() {
  return {
    schema: "observer.parent_launch_request.v1",
    provider: "claude",
    watch_id: WATCH_ID,
    target_id: TARGET.targetId,
    project_root: TARGET.projectRoot,
    runtime_root: "/observer",
    required_handle_kind: "claude.job",
    host: {
      kind: "claude.background_agent.v1",
      agent: "observer",
      name: "observer-aaaaaaaaaaaa-11111111-1111-4111-8111-111111111111",
      cwd: "/observer",
    },
    child_start: {
      schema: "observer.child_start.v1",
      mode: "observe",
      provider: "claude",
      watch_id: WATCH_ID,
      target_id: TARGET.targetId,
      project_root: TARGET.projectRoot,
      runtime_root: "/observer",
    },
  };
}

function expectCode(code) {
  return (error) => error instanceof ObserverError && error.code === code;
}

async function setup() {
  const stateRoot = await mkdtemp(join(tmpdir(), "observer-generation-host-"));
  await chmod(stateRoot, 0o700);
  const starting = await reserveActiveWatch(
    { stateRoot, target: TARGET, provider: "claude" },
    { randomUUID: () => WATCH_UUID, now: () => T0 },
  );
  await attachWatchLaunchHandle({
    stateRoot,
    targetId: TARGET.targetId,
    watchId: starting.watch_id,
    launchHandle: { kind: "claude.job", value: OLD_JOB },
  }, { now: () => T0 });
  await activateWatch({
    stateRoot,
    targetId: TARGET.targetId,
    watchId: starting.watch_id,
    launchHandle: { kind: "claude.job", value: OLD_JOB },
  }, { now: () => T0 });
  await initializeGeneration({
    stateRoot,
    targetId: TARGET.targetId,
    watchId: WATCH_ID,
    provider: "claude",
    parentThreadSha256: "b".repeat(64),
    readyReceipt: receipt("ready"),
  }, { now: () => T0 });
  await reserveGenerationInput({
    stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID, cycleId: CYCLE,
    inputDigest: INPUT, modelVisibleBytes: 262_144,
  }, { now: () => T1 });
  await completeGenerationCycle({
    stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID, cycleId: CYCLE,
    inputDigest: INPUT, modelVisibleBytes: 262_144, resultDigest: RESULT,
  }, { now: () => T1 });
  const planned = await reserveGenerationInput({
    stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID, cycleId: NEXT_CYCLE,
    inputDigest: `sha256:${"a".repeat(64)}`, modelVisibleBytes: 1,
  }, { now: () => T1 });
  assert.equal(planned.outcome, "planned_rollover");
  return stateRoot;
}

async function rawWatch(stateRoot) {
  return JSON.parse(await readFile(join(stateRoot, "watches", TARGET.targetId, "current.json"), "utf8"));
}

async function rawJournal(stateRoot) {
  return JSON.parse(await readFile(join(stateRoot, "watches", TARGET.targetId, "generation-host-rollover.json"), "utf8"));
}

test("record-first rolloverはwatchをactiveのまま旧terminalから新handle activationへ進める", async () => {
  const stateRoot = await setup();
  assert.equal(await readGenerationHostRolloverStatus({ stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID }), null);
  const prepared = await prepareGenerationHostStop({ stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID }, { now: () => T1 });
  assert.equal(prepared.action, "issue_once");
  assert.deepEqual(prepared.stop_request.handle, { kind: "claude.job", value: OLD_JOB });
  assert.equal((await rawWatch(stateRoot)).status, "active");
  assert.equal((await readGenerationState({ stateRoot, targetId: TARGET.targetId })).status, "stopping");
  assert.equal((await prepareGenerationHostStop({ stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID }, { now: () => T1 })).action, "observe_only");
  const rollover = await readGenerationHostRolloverStatus({ stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID });
  assert.equal(rollover.schema, "observer.generation_host_rollover_status.v1");
  assert.equal(rollover.status, "stop_authorized");
  assert.equal(rollover.action, "observe_terminal");
  assert.equal(JSON.stringify(rollover).includes(OLD_JOB), false);

  const terminal = await confirmGenerationHostTerminal({
    stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID, terminalReceipt: receipt("stopped"),
  }, { now: () => T1 });
  assert.equal(terminal.generation_status, "terminal_confirmed");
  const authorized = await authorizeNextGenerationHostStart({
    stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID, launchRequest: launchRequest(),
  }, { now: () => T1 });
  assert.equal(authorized.action, "issue_once");
  assert.equal(authorized.sequence, 2);
  assert.equal((await authorizeNextGenerationHostStart({
    stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID, launchRequest: launchRequest(),
  }, { now: () => T1 })).action, "recover_only");

  const spawned = await recordNextGenerationHostSpawn({
    stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID, spawnReceipt: receipt("spawned", NEW_JOB),
  }, { now: () => T1 });
  assert.equal(spawned.action, "spawn_observed");
  assert.equal((await rawWatch(stateRoot)).launch_handle.value, NEW_JOB);
  assert.equal((await recordNextGenerationHostSpawn({
    stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID, spawnReceipt: receipt("spawned", NEW_JOB),
  }, { now: () => T1 })).action, "spawn_recovered");

  const activated = await activateNextGenerationHost({
    stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID, readyReceipt: receipt("ready", NEW_JOB),
  }, { now: () => T1 });
  assert.equal(activated.generation.status, "active");
  assert.equal(activated.generation.sequence, 2);
  assert.equal(JSON.stringify(activated.generation).includes(NEW_JOB), false);
  await assert.rejects(rawJournal(stateRoot), { code: "ENOENT" });
  assert.equal(await readGenerationHostRolloverStatus({ stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID }), null);
  assert.equal((await rawWatch(stateRoot)).status, "active");
});

test("stop authorization後のcrashはstopを再認可せずgeneration不足分だけ適用する", async () => {
  const stateRoot = await setup();
  await assert.rejects(
    prepareGenerationHostStop({ stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID }, {
      now: () => T1,
      requestGenerationStop: async () => { throw new Error("crash after journal"); },
    }),
    /crash after journal/,
  );
  assert.equal((await rawJournal(stateRoot)).status, "stop_authorized");
  assert.equal((await readGenerationState({ stateRoot, targetId: TARGET.targetId })).status, "rollover_requested");
  const recovered = await prepareGenerationHostStop({ stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID }, { now: () => T1 });
  assert.equal(recovered.action, "observe_only");
  assert.equal((await readGenerationState({ stateRoot, targetId: TARGET.targetId })).status, "stopping");
});

test("next start authorization後のcrashはrecover_onlyとなりspawnを再認可しない", async () => {
  const stateRoot = await setup();
  await prepareGenerationHostStop({ stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID }, { now: () => T1 });
  await confirmGenerationHostTerminal({ stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID, terminalReceipt: receipt("stopped") }, { now: () => T1 });
  await assert.rejects(
    authorizeNextGenerationHostStart({ stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID, launchRequest: launchRequest() }, {
      now: () => T1,
      beginNextGeneration: async () => { throw new Error("crash after authorization"); },
    }),
    /crash after authorization/,
  );
  assert.equal((await rawJournal(stateRoot)).status, "spawn_authorized");
  const recovered = await authorizeNextGenerationHostStart({ stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID, launchRequest: launchRequest() }, { now: () => T1 });
  assert.equal(recovered.action, "recover_only");
  assert.equal((await readGenerationState({ stateRoot, targetId: TARGET.targetId })).status, "starting");
});

test("next start authorization後は別のvalid runtime rootを拒否し元requestだけrecover_onlyにする", async () => {
  const stateRoot = await setup();
  await prepareGenerationHostStop({ stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID }, { now: () => T1 });
  await confirmGenerationHostTerminal({ stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID, terminalReceipt: receipt("stopped") }, { now: () => T1 });
  const original = launchRequest();
  await assert.rejects(
    authorizeNextGenerationHostStart({ stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID, launchRequest: original }, {
      now: () => T1,
      beginNextGeneration: async () => { throw new Error("crash after launch authorization"); },
    }),
    /crash after launch authorization/,
  );
  const alternate = launchRequest();
  alternate.runtime_root = "/observer-alternate";
  alternate.host.cwd = "/observer-alternate";
  alternate.child_start.runtime_root = "/observer-alternate";
  await assert.rejects(
    authorizeNextGenerationHostStart({ stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID, launchRequest: alternate }, { now: () => T1 }),
    expectCode("E_GENERATION_HOST_LAUNCH_REQUEST_CONFLICT"),
  );
  const recovered = await authorizeNextGenerationHostStart({
    stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID, launchRequest: original,
  }, { now: () => T1 });
  assert.equal(recovered.action, "recover_only");
  assert.equal((await rawJournal(stateRoot)).launch_request_digest.startsWith("sha256:"), true);
  assert.equal(JSON.stringify(await rawJournal(stateRoot)).includes("/observer"), false);
});

test("spawn receipt後のcrashはjournal handleから旧→新CASだけを回復する", async () => {
  const stateRoot = await setup();
  await prepareGenerationHostStop({ stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID }, { now: () => T1 });
  await confirmGenerationHostTerminal({ stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID, terminalReceipt: receipt("stopped") }, { now: () => T1 });
  await authorizeNextGenerationHostStart({ stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID, launchRequest: launchRequest() }, { now: () => T1 });
  await assert.rejects(
    recordNextGenerationHostSpawn({ stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID, spawnReceipt: receipt("spawned", NEW_JOB) }, {
      now: () => T1,
      compareAndSwapWatchLaunchHandle: async () => { throw new Error("crash before CAS"); },
    }),
    /crash before CAS/,
  );
  assert.equal((await rawJournal(stateRoot)).status, "spawn_observed");
  assert.equal((await rawWatch(stateRoot)).launch_handle.value, OLD_JOB);
  const recovered = await recordNextGenerationHostSpawn({ stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID, spawnReceipt: receipt("spawned", NEW_JOB) }, { now: () => T1 });
  assert.equal(recovered.action, "spawn_observed");
  assert.equal((await rawWatch(stateRoot)).launch_handle.value, NEW_JOB);
});

test("旧terminal／spawn／readyのhandle不一致をfail closedにする", async () => {
  const stateRoot = await setup();
  await prepareGenerationHostStop({ stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID }, { now: () => T1 });
  await assert.rejects(
    confirmGenerationHostTerminal({ stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID, terminalReceipt: receipt("stopped", "other-job") }, { now: () => T1 }),
    expectCode("E_GENERATION_HOST_TERMINAL_HANDLE_MISMATCH"),
  );
  await confirmGenerationHostTerminal({ stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID, terminalReceipt: receipt("stopped") }, { now: () => T1 });
  await authorizeNextGenerationHostStart({ stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID, launchRequest: launchRequest() }, { now: () => T1 });
  await recordNextGenerationHostSpawn({ stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID, spawnReceipt: receipt("spawned", NEW_JOB) }, { now: () => T1 });
  await assert.rejects(
    activateNextGenerationHost({ stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID, readyReceipt: receipt("ready", "third-job") }, { now: () => T1 }),
    expectCode("E_GENERATION_HOST_READY_HANDLE_MISMATCH"),
  );
  assert.equal((await readGenerationState({ stateRoot, targetId: TARGET.targetId })).status, "starting");
});

test("activation後・journal cleanup前のcrashは同じreadyだけで冪等回復する", async () => {
  const stateRoot = await setup();
  await prepareGenerationHostStop({ stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID }, { now: () => T1 });
  await confirmGenerationHostTerminal({ stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID, terminalReceipt: receipt("stopped") }, { now: () => T1 });
  await authorizeNextGenerationHostStart({ stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID, launchRequest: launchRequest() }, { now: () => T1 });
  await recordNextGenerationHostSpawn({ stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID, spawnReceipt: receipt("spawned", NEW_JOB) }, { now: () => T1 });
  await activateGeneration({
    stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID, readyReceipt: receipt("ready", NEW_JOB),
  }, { now: () => T1 });
  const recovered = await activateNextGenerationHost({
    stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID, readyReceipt: receipt("ready", NEW_JOB),
  }, { now: () => T1 });
  assert.equal(recovered.generation.status, "active");
  await assert.rejects(rawJournal(stateRoot), { code: "ENOENT" });
});

test("recovery contextはraw handle／receipt／launch本文を出さずstatusをnext actionへ固定する", async () => {
  const stateRoot = await setup();
  await prepareGenerationHostStop({ stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID }, { now: () => T1 });
  const stopping = await readGenerationHostRecoveryContext({ stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID });
  assert.deepEqual(stopping, {
    schema: "observer.generation_host_recovery_context.v1",
    provider: "claude",
    watch_id: WATCH_ID,
    target_id: TARGET.targetId,
    status: "stop_authorized",
    from_generation_id: stopping.from_generation_id,
    from_sequence: 1,
    to_generation_id: null,
    to_sequence: null,
    action: "observe_terminal",
  });
  assert.equal(JSON.stringify(stopping).includes(OLD_JOB), false);

  await confirmGenerationHostTerminal({ stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID, terminalReceipt: receipt("stopped") }, { now: () => T1 });
  const terminal = await readGenerationHostRecoveryContext({
    stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID, launchRequest: launchRequest(),
  }, { now: () => T1 });
  assert.equal(terminal.action, "authorize_start");
  assert.equal(JSON.stringify(terminal).includes("/observer"), false);
  assert.equal(JSON.stringify(terminal).includes("receipt"), false);

  await authorizeNextGenerationHostStart({ stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID, launchRequest: launchRequest() }, { now: () => T1 });
  const authorized = await readGenerationHostRecoveryContext({
    stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID, launchRequest: launchRequest(),
  }, { now: () => T1 });
  assert.equal(authorized.action, "recover_spawn");
  assert.equal(authorized.to_sequence, 2);

  await recordNextGenerationHostSpawn({
    stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID, spawnReceipt: receipt("spawned", NEW_JOB),
  }, { now: () => T1 });
  const spawned = await readGenerationHostRecoveryContext({
    stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID, launchRequest: launchRequest(),
  }, { now: () => T1 });
  assert.equal(spawned.action, "recover_ready");
  assert.equal(JSON.stringify(spawned).includes(NEW_JOB), false);
});

test("terminal_observed以降のrecovery contextはlaunch request digest完全一致を要求する", async () => {
  const stateRoot = await setup();
  await prepareGenerationHostStop({ stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID }, { now: () => T1 });
  await confirmGenerationHostTerminal({ stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID, terminalReceipt: receipt("stopped") }, { now: () => T1 });
  const original = launchRequest();
  await readGenerationHostRecoveryContext({ stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID, launchRequest: original }, { now: () => T1 });

  const alternate = launchRequest();
  alternate.runtime_root = "/observer-alternate";
  alternate.host.cwd = "/observer-alternate";
  alternate.child_start.runtime_root = "/observer-alternate";
  await assert.rejects(
    readGenerationHostRecoveryContext({ stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID, launchRequest: alternate }, { now: () => T1 }),
    expectCode("E_GENERATION_HOST_LAUNCH_REQUEST_CONFLICT"),
  );
  await assert.rejects(
    readGenerationHostRecoveryContext({ stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID }),
    expectCode("E_GENERATION_HOST_LAUNCH_REQUEST_REQUIRED"),
  );
});
