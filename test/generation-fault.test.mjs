import assert from "node:assert/strict";
import { chmod, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  confirmGenerationFaultTerminal,
  prepareGenerationFaultStop,
  readGenerationFaultStatus,
  recordGenerationFault,
} from "../src/generation-fault.mjs";
import {
  authorizeGenerationRebind,
  initializeGeneration,
  readGenerationState,
  requestGenerationRebindStop,
} from "../src/generation-store.mjs";
import { ObserverError } from "../src/observer-error.mjs";
import { activateWatch, attachWatchLaunchHandle, readWatchStatus, reserveActiveWatch } from "../src/watch-store.mjs";

const TARGET = { schema: "observer.project_target.v1", targetId: `p_${"a".repeat(64)}`, projectRoot: "/project" };
const WATCH_ID = "w_11111111-1111-4111-8111-111111111111";
const HANDLE = { kind: "claude.job", value: "raw-fault-job" };
const T0 = new Date("2026-07-16T00:00:00.000Z");
const T1 = new Date("2026-07-16T00:01:00.000Z");

function receipt({ provider = "claude", watchId = WATCH_ID, targetId = TARGET.targetId, handle = HANDLE, outcome = "stopped" } = {}) {
  return { schema: "observer.host_receipt.v1", provider, target_id: targetId, watch_id: watchId, outcome, handle };
}

function expectCode(code) { return (error) => error instanceof ObserverError && error.code === code; }

async function setup() {
  const stateRoot = await mkdtemp(join(tmpdir(), "observer-generation-fault-"));
  await chmod(stateRoot, 0o700);
  await reserveActiveWatch({ stateRoot, target: TARGET, provider: "claude" }, {
    randomUUID: () => WATCH_ID.slice(2), now: () => T0,
  });
  await attachWatchLaunchHandle({ stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID, launchHandle: HANDLE }, { now: () => T0 });
  await activateWatch({ stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID, launchHandle: HANDLE }, { now: () => T0 });
  await initializeGeneration({
    stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID, provider: "claude",
    parentThreadSha256: "b".repeat(64), readyReceipt: receipt({ outcome: "ready" }),
  }, { now: () => T0 });
  return stateRoot;
}

test("active faultはrecord-firstでstopを一度だけ認可し、terminal receipt後だけgeneration/watch/journalをfaultedへ閉じる", async () => {
  const stateRoot = await setup();
  const recorded = await recordGenerationFault({
    stateRoot, target: TARGET, watchId: WATCH_ID, faultCode: "E_OBSERVER_PROVIDER_TERMINATED",
  }, { now: () => T1 });
  assert.equal(recorded.status, "fault_recorded");
  assert.equal(recorded.action, "authorize_stop");
  assert.equal((await readGenerationState({ stateRoot, targetId: TARGET.targetId })).status, "fault_required");
  assert.equal((await readWatchStatus({ stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID })).status, "active");

  const status = await readGenerationFaultStatus({ stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID });
  assert.equal(status.status, "fault_recorded");
  assert.equal(status.action, "authorize_stop");
  assert.equal(JSON.stringify(status).includes(HANDLE.value), false);

  const first = await prepareGenerationFaultStop({ stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID }, { now: () => T1 });
  assert.equal(first.action, "issue_once");
  assert.deepEqual(first.stop_request.handle, HANDLE);
  assert.equal((await prepareGenerationFaultStop({ stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID }, { now: () => T1 })).action, "observe_only");
  assert.equal((await readGenerationState({ stateRoot, targetId: TARGET.targetId })).status, "fault_stopping");

  await assert.rejects(confirmGenerationFaultTerminal({
    stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID, terminalReceipt: receipt({ handle: { kind: "claude.job", value: "other" } }),
  }, { now: () => T1 }), expectCode("E_GENERATION_FAULT_RECEIPT_MISMATCH"));
  await confirmGenerationFaultTerminal({ stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID, terminalReceipt: receipt() }, { now: () => T1 });
  await confirmGenerationFaultTerminal({ stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID, terminalReceipt: receipt() }, { now: () => T1 });
  assert.equal((await readGenerationState({ stateRoot, targetId: TARGET.targetId })).status, "faulted");
  assert.equal((await readWatchStatus({ stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID })).status, "faulted");
  assert.equal((await readGenerationFaultStatus({ stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID })).status, "faulted");
});

test("stop発行済みsourceはfault後にstopを再送せず、identity/fault conflictをfail closedにする", async () => {
  const stateRoot = await setup();
  const generation = await readGenerationState({ stateRoot, targetId: TARGET.targetId });
  await authorizeGenerationRebind({ stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID, expectedGenerationId: generation.generation_id }, { now: () => T1 });
  await requestGenerationRebindStop({ stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID, expectedGenerationId: generation.generation_id }, { now: () => T1 });
  await recordGenerationFault({ stateRoot, target: TARGET, watchId: WATCH_ID, faultCode: "E_OBSERVER_MODEL_RESULT_UNKNOWN" }, { now: () => T1 });
  assert.equal((await prepareGenerationFaultStop({ stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID }, { now: () => T1 })).action, "observe_only");
  await assert.rejects(recordGenerationFault({
    stateRoot, target: TARGET, watchId: WATCH_ID, faultCode: "E_OBSERVER_PROVIDER_TERMINATED",
  }, { now: () => T1 }), expectCode("E_GENERATION_FAULT_CONFLICT"));
  await assert.rejects(confirmGenerationFaultTerminal({
    stateRoot, targetId: TARGET.targetId, watchId: "w_22222222-2222-4222-8222-222222222222", terminalReceipt: receipt(),
  }, { now: () => T1 }));
});

test("terminal receipt耐久化後のcrashは同じreceiptだけでgeneration/watch faultを回収する", async () => {
  const stateRoot = await setup();
  await recordGenerationFault({
    stateRoot, target: TARGET, watchId: WATCH_ID, faultCode: "E_OBSERVER_SUPERVISOR_FAILED",
  }, { now: () => T1 });
  await prepareGenerationFaultStop({ stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID }, { now: () => T1 });
  await assert.rejects(confirmGenerationFaultTerminal({
    stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID, terminalReceipt: receipt(),
  }, {
    now: () => T1,
    completeGenerationFault: async () => { throw new ObserverError("E_TEST_CRASH", "simulated crash"); },
  }), expectCode("E_TEST_CRASH"));
  assert.equal((await readGenerationFaultStatus({ stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID })).status, "terminal_observed");
  assert.equal((await readGenerationState({ stateRoot, targetId: TARGET.targetId })).status, "fault_terminal_confirmed");
  assert.equal((await readWatchStatus({ stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID })).status, "active");
  assert.equal((await prepareGenerationFaultStop({ stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID }, { now: () => T1 })).action, "observe_only");
  await confirmGenerationFaultTerminal({
    stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID, terminalReceipt: receipt(),
  }, { now: () => T1 });
  assert.equal((await readGenerationState({ stateRoot, targetId: TARGET.targetId })).status, "faulted");
  assert.equal((await readWatchStatus({ stateRoot, targetId: TARGET.targetId, watchId: WATCH_ID })).status, "faulted");
});
