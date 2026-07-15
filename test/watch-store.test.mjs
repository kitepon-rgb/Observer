import assert from "node:assert/strict";
import { lstat, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ObserverError } from "../src/observer-error.mjs";
import { acquirePrivateLock, ensureStatePath } from "../src/private-state.mjs";
import {
  activateWatch,
  attachWatchLaunchHandle,
  compareAndSwapWatchLaunchHandle,
  completeWatchStop,
  inspectWatchTransactionLock,
  readWatchStatus,
  readWatchHostBinding,
  recordWatchFaultAfterChildExit,
  recordWatchFaultBeforeChildStart,
  recoverWatchTransactionLock,
  requestWatchStop,
  reserveActiveWatch,
} from "../src/watch-store.mjs";

const TARGET = { schema: "observer.project_target.v1", targetId: `p_${"a".repeat(64)}`, projectRoot: "/repo" };
const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const T0 = new Date("2026-07-15T00:00:00.000Z");
const T1 = new Date("2026-07-15T00:01:00.000Z");

function expectCode(code) {
  return (error) => error instanceof ObserverError && error.code === code;
}

async function box() {
  return mkdtemp(join(tmpdir(), "observer-watch-"));
}

test("未登録targetのstatus読取はstate directoryを作らない", async () => {
  const stateRoot = await box();
  assert.equal(await readWatchStatus({ stateRoot, targetId: TARGET.targetId }), null);
  await assert.rejects(lstat(join(stateRoot, "watches")), { code: "ENOENT" });
});

test("provider childより先にstartingを予約し、active watchの二重起動を拒否する", async () => {
  const stateRoot = await box();
  const starting = await reserveActiveWatch({ stateRoot, target: TARGET, provider: "codex" }, { randomUUID: () => UUID_A, now: () => T0 });
  assert.equal(starting.watch_id, `w_${UUID_A}`);
  assert.equal(starting.status, "starting");
  assert.equal("launch_handle" in starting, false);
  await assert.rejects(
    reserveActiveWatch({ stateRoot, target: TARGET, provider: "codex" }, { randomUUID: () => UUID_B, now: () => T1 }),
    expectCode("E_WATCH_ALREADY_ACTIVE"),
  );
});

test("launch handleをactive前に耐久化し、公開statusへ出さずwatch IDとhandleのCASを要求する", async () => {
  const stateRoot = await box();
  const starting = await reserveActiveWatch({ stateRoot, target: TARGET, provider: "claude" }, { randomUUID: () => UUID_A, now: () => T0 });
  await assert.rejects(
    activateWatch({ stateRoot, targetId: TARGET.targetId, watchId: `w_${UUID_B}`, launchHandle: { kind: "claude.job", value: "job-secret" } }, { now: () => T1 }),
    expectCode("E_WATCH_STATE_CHANGED"),
  );
  const launching = await attachWatchLaunchHandle({
    stateRoot,
    targetId: TARGET.targetId,
    watchId: starting.watch_id,
    launchHandle: { kind: "claude.job", value: "job-private-1" },
  }, { now: () => T1 });
  assert.equal(launching.status, "launching");
  assert.equal("launch_handle" in launching, false);
  await assert.rejects(
    activateWatch({ stateRoot, targetId: TARGET.targetId, watchId: starting.watch_id, launchHandle: { kind: "claude.job", value: "other-job" } }, { now: () => T1 }),
    expectCode("E_WATCH_LAUNCH_HANDLE_MISMATCH"),
  );
  await assert.rejects(
    requestWatchStop({
      stateRoot,
      targetId: TARGET.targetId,
      watchId: starting.watch_id,
      expectedLaunchHandle: { kind: "claude.job", value: "other-job" },
    }, { now: () => T1 }),
    expectCode("E_WATCH_LAUNCH_HANDLE_MISMATCH"),
  );
  assert.equal((await readWatchStatus({ stateRoot, targetId: TARGET.targetId })).status, "launching");
  const active = await activateWatch({
    stateRoot,
    targetId: TARGET.targetId,
    watchId: starting.watch_id,
    launchHandle: { kind: "claude.job", value: "job-private-1" },
  }, { now: () => T1 });
  assert.equal(active.status, "active");
  assert.equal("launch_handle" in active, false);
  assert.deepEqual(await readWatchStatus({ stateRoot, targetId: TARGET.targetId }), active);
});

test("stopはstoppingを保持して再試行でき、確認後だけhandleを消してstoppedへ閉じる", async () => {
  const stateRoot = await box();
  const starting = await reserveActiveWatch({ stateRoot, target: TARGET, provider: "codex" }, { randomUUID: () => UUID_A, now: () => T0 });
  await attachWatchLaunchHandle({ stateRoot, targetId: TARGET.targetId, watchId: starting.watch_id, launchHandle: { kind: "codex.agent", value: "/root/observer" } }, { now: () => T1 });
  await activateWatch({ stateRoot, targetId: TARGET.targetId, watchId: starting.watch_id, launchHandle: { kind: "codex.agent", value: "/root/observer" } }, { now: () => T1 });
  const stop = await requestWatchStop({ stateRoot, targetId: TARGET.targetId, watchId: starting.watch_id }, { now: () => T1 });
  assert.equal(stop.status.status, "stopping");
  assert.deepEqual(stop.launchHandle, { kind: "codex.agent", value: "/root/observer" });
  const retry = await requestWatchStop({ stateRoot, targetId: TARGET.targetId, watchId: starting.watch_id }, { now: () => T1 });
  assert.deepEqual(retry, stop);
  const stopped = await completeWatchStop({ stateRoot, targetId: TARGET.targetId, watchId: starting.watch_id }, { now: () => T1 });
  assert.equal(stopped.status, "stopped");
  await assert.rejects(requestWatchStop({ stateRoot, targetId: TARGET.targetId, watchId: starting.watch_id }), expectCode("E_WATCH_TRANSITION_INVALID"));
});

test("terminal stateからの再startは観測済みprevious watch IDを要求する", async () => {
  const stateRoot = await box();
  const first = await reserveActiveWatch({ stateRoot, target: TARGET, provider: "codex" }, { randomUUID: () => UUID_A, now: () => T0 });
  await recordWatchFaultBeforeChildStart({ stateRoot, targetId: TARGET.targetId, watchId: first.watch_id, faultCode: "E_CYCLE_FAILED" }, { now: () => T1 });
  await assert.rejects(
    reserveActiveWatch({ stateRoot, target: TARGET, provider: "codex" }, { randomUUID: () => UUID_B, now: () => T1 }),
    expectCode("E_WATCH_STATE_CHANGED"),
  );
  const second = await reserveActiveWatch({ stateRoot, target: TARGET, provider: "codex", expectedPreviousWatchId: first.watch_id }, { randomUUID: () => UUID_B, now: () => T1 });
  assert.equal(second.watch_id, `w_${UUID_B}`);
  assert.equal(second.status, "starting");
});

test("faultは固定codeだけを残し、clock rollbackと不正handleを拒否する", async () => {
  const stateRoot = await box();
  const starting = await reserveActiveWatch({ stateRoot, target: TARGET, provider: "claude" }, { randomUUID: () => UUID_A, now: () => T1 });
  await assert.rejects(
    activateWatch({ stateRoot, targetId: TARGET.targetId, watchId: starting.watch_id, launchHandle: { kind: "claude.job", value: "bad\nvalue" } }, { now: () => T1 }),
    expectCode("E_WATCH_LAUNCH_HANDLE_INVALID"),
  );
  await assert.rejects(
    recordWatchFaultBeforeChildStart({ stateRoot, targetId: TARGET.targetId, watchId: starting.watch_id, faultCode: "raw failure text" }, { now: () => T1 }),
    expectCode("E_WATCH_FAULT_CODE_INVALID"),
  );
  await assert.rejects(
    recordWatchFaultBeforeChildStart({ stateRoot, targetId: TARGET.targetId, watchId: starting.watch_id, faultCode: "E_FAILED" }, { now: () => T0 }),
    expectCode("E_WATCH_CLOCK_ROLLBACK"),
  );
  const faulted = await recordWatchFaultBeforeChildStart({ stateRoot, targetId: TARGET.targetId, watchId: starting.watch_id, faultCode: "E_FAILED" }, { now: () => T1 });
  assert.equal(faulted.fault_code, "E_FAILED");
  assert.equal("launch_handle" in faulted, false);
});

test("handle耐久化後はpre-child faultで消せず、child exit確認用遷移だけがfaultへ閉じる", async () => {
  const stateRoot = await box();
  const starting = await reserveActiveWatch({ stateRoot, target: TARGET, provider: "claude" }, { randomUUID: () => UUID_A, now: () => T0 });
  await attachWatchLaunchHandle({
    stateRoot,
    targetId: TARGET.targetId,
    watchId: starting.watch_id,
    launchHandle: { kind: "claude.job", value: "job-private-1" },
  }, { now: () => T1 });
  await assert.rejects(
    recordWatchFaultBeforeChildStart({ stateRoot, targetId: TARGET.targetId, watchId: starting.watch_id, faultCode: "E_FAILED" }, { now: () => T1 }),
    expectCode("E_WATCH_TRANSITION_INVALID"),
  );
  assert.equal((await readWatchStatus({ stateRoot, targetId: TARGET.targetId })).status, "launching");
  const faulted = await recordWatchFaultAfterChildExit({ stateRoot, targetId: TARGET.targetId, watchId: starting.watch_id, faultCode: "E_FAILED" }, { now: () => T1 });
  assert.equal(faulted.status, "faulted");
});

test("残留transaction lockは観測nonce一致時だけ明示回復する", async () => {
  const stateRoot = await box();
  const directory = await ensureStatePath(stateRoot, "watches", TARGET.targetId);
  await acquirePrivateLock(join(directory, "transaction.lock"));
  const observed = await inspectWatchTransactionLock({ stateRoot, targetId: TARGET.targetId });
  assert.equal(typeof observed.nonce, "string");
  await assert.rejects(
    recoverWatchTransactionLock({ stateRoot, targetId: TARGET.targetId, expectedNonce: UUID_A }),
    expectCode("E_LOCK_OWNERSHIP_MISMATCH"),
  );
  assert.equal(await recoverWatchTransactionLock({ stateRoot, targetId: TARGET.targetId, expectedNonce: observed.nonce }), true);
  assert.equal(await inspectWatchTransactionLock({ stateRoot, targetId: TARGET.targetId }), null);
});

test("active watch handleは旧→新CASだけを許しpublic statusへraw handleを出さない", async () => {
  const stateRoot = await box();
  const starting = await reserveActiveWatch({ stateRoot, target: TARGET, provider: "claude" }, { randomUUID: () => UUID_A, now: () => T0 });
  const oldHandle = { kind: "claude.job", value: "job-old" };
  const newHandle = { kind: "claude.job", value: "job-new" };
  await attachWatchLaunchHandle({ stateRoot, targetId: TARGET.targetId, watchId: starting.watch_id, launchHandle: oldHandle }, { now: () => T0 });
  await activateWatch({ stateRoot, targetId: TARGET.targetId, watchId: starting.watch_id, launchHandle: oldHandle }, { now: () => T0 });
  const binding = await readWatchHostBinding({ stateRoot, targetId: TARGET.targetId, watchId: starting.watch_id });
  assert.deepEqual(binding.launch_handle, oldHandle);
  const swapped = await compareAndSwapWatchLaunchHandle({
    stateRoot, targetId: TARGET.targetId, watchId: starting.watch_id,
    expectedLaunchHandle: oldHandle, nextLaunchHandle: newHandle,
  }, { now: () => T1 });
  assert.equal(swapped.outcome, "swapped");
  assert.equal("launch_handle" in swapped.status, false);
  const retry = await compareAndSwapWatchLaunchHandle({
    stateRoot, targetId: TARGET.targetId, watchId: starting.watch_id,
    expectedLaunchHandle: oldHandle, nextLaunchHandle: newHandle,
  }, { now: () => T1 });
  assert.equal(retry.outcome, "already_swapped");
  await assert.rejects(
    compareAndSwapWatchLaunchHandle({
      stateRoot, targetId: TARGET.targetId, watchId: starting.watch_id,
      expectedLaunchHandle: { kind: "claude.job", value: "third" },
      nextLaunchHandle: { kind: "claude.job", value: "fourth" },
    }, { now: () => T1 }),
    expectCode("E_WATCH_LAUNCH_HANDLE_CAS_MISMATCH"),
  );
});
