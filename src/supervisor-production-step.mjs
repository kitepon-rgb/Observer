import { createHash } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";

import { applyCycleOutput, finalizeCycleApplication } from "./cycle-application.mjs";
import { buildCycleInput } from "./cycle-input.mjs";
import { collectEvidenceSnapshot } from "./evidence-collector.mjs";
import { generationParentEpochId, readGenerationState } from "./generation-store.mjs";
import {
  cleanupCodexModelOperation,
  issueCodexModelOperation,
  recoverCodexModelOperation,
} from "./codex-model-operation.mjs";
import { ObserverError, fail } from "./observer-error.mjs";
import {
  acquirePrivateLock,
  assertPrivateDirectory,
  assertWithin,
  inspectPrivateLock,
  recoverPrivateLock,
} from "./private-state.mjs";
import { runSupervisorCycle } from "./supervisor-cycle.mjs";
import { readCycleState } from "./cycle-store.mjs";
import { readWatchHostBinding } from "./watch-store.mjs";

export const SUPERVISOR_PRODUCTION_RESULT_SCHEMA = "observer.supervisor_production_result.v1";

const TARGET = /^p_[a-f0-9]{64}$/;
const WATCH = /^w_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export async function runSupervisorProductionStep({
  stateRoot,
  target,
  watchId,
  client,
  providerRuntime = null,
  planRefs = [],
  testReceipts = [],
  timeoutSeconds = 3600,
  signal,
} = {}, dependencies = {}) {
  validateRequest({ stateRoot, target, watchId, client, planRefs, testReceipts, timeoutSeconds });
  const acquire = dependencies.acquirePrivateLock ?? acquirePrivateLock;
  let release;
  try {
    release = await acquire(await supervisorLockPath(stateRoot, target.targetId));
  } catch (error) {
    if (error instanceof ObserverError && error.code === "E_CONSUMER_LOCKED") {
      fail("E_SUPERVISOR_ALREADY_RUNNING", "同じtargetのSupervisor stepが既に進行中です");
    }
    throw error;
  }

  let primary = null;
  try {
    const binding = await (dependencies.readWatchHostBinding ?? readWatchHostBinding)({
      stateRoot,
      targetId: target.targetId,
      watchId,
    });
    const generation = await (dependencies.readGenerationState ?? readGenerationState)({
      stateRoot,
      targetId: target.targetId,
    });
    validateRuntimeIdentity({ binding, generation, target, watchId });
    if (!providerAvailable(generation.provider, providerRuntime)) {
      return unavailable(generation.provider);
    }
    const runtime = validateProviderRuntime(providerRuntime, generation.provider, binding);
    let cycleInput = null;
    const run = dependencies.runSupervisorCycle ?? runSupervisorCycle;
    const result = await run({
      stateRoot,
      target,
      watchId,
      client,
      timeoutSeconds,
      signal,
      prepareCycleInput: async ({ cycle_id: cycleId, proposed_state: proposedState, turns }) => {
        validateProposedParent({ proposedState, generation, target, watchId, cycleId });
        const cycleState = await (dependencies.readCycleState ?? readCycleState)({ stateRoot, targetId: target.targetId });
        const pending = cycleState?.pending_cycle;
        if (!pending || pending.status !== "prepared" || pending.cycle_id !== cycleId ||
            JSON.stringify(pending.proposed_state) !== JSON.stringify(proposedState)) {
          fail("E_SUPERVISOR_PENDING_MISMATCH", "prepared cycleがevidence inputと一致しません");
        }
        const evidence = await (dependencies.collectEvidenceSnapshot ?? collectEvidenceSnapshot)({
          context: {
            after_cursor_sha256: pending.base_cursor === null ? null : cursorDigest(pending.base_cursor),
            cycle_id: cycleId,
            parent_host: proposedState.host,
            parent_thread_sha256: proposedState.thread_sha256,
            target_id: target.targetId,
            through_cursor_sha256: cursorDigest(proposedState.cursor),
            watch_id: watchId,
          },
          turns,
          project_root: target.projectRoot,
          plan_refs: planRefs,
          test_receipts: testReceipts,
        }, dependencies.evidenceDependencies);
        cycleInput = (dependencies.buildCycleInput ?? buildCycleInput)(evidence);
        return cycleInput;
      },
      issueModelOperation: ({ operation, value }) => (dependencies.issueCodexModelOperation ?? issueCodexModelOperation)({
        stateRoot,
        operation,
        value,
        runtime: { thread_id: runtime.threadId, cwd: runtime.runtimeRoot },
      }, {
        threadRead: (params) => runtime.session.request("thread/read", params),
        turnStart: (params) => runtime.session.request("turn/start", params),
      }),
      recoverModelOperation: ({ operation }) => (dependencies.recoverCodexModelOperation ?? recoverCodexModelOperation)({
        stateRoot,
        operation,
        threadRead: (params) => runtime.session.request("thread/read", params),
      }),
      cleanupProviderOperation: ({ operation }) => (dependencies.cleanupCodexModelOperation ?? cleanupCodexModelOperation)({ stateRoot, operation }),
      applyCycle: ({ operation, output }) => {
        if (cycleInput === null) fail("E_SUPERVISOR_CYCLE_INPUT_MISSING", "cycle applicationへcanonical inputを再構成できません");
        return (dependencies.applyCycleOutput ?? applyCycleOutput)({ stateRoot, operation, output, cycleInput, now: currentDate(dependencies) });
      },
      finalizeAppliedCycle: ({ operation }) => (dependencies.finalizeCycleApplication ?? finalizeCycleApplication)({ stateRoot, operation }),
    });
    return productionResult(result, generation.provider);
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    try {
      await release();
    } catch (error) {
      if (primary !== null) throw new AggregateError([primary, error], "Supervisor stepとlock解放が失敗しました");
      throw error;
    }
  }
}

export async function inspectSupervisorProductionLock({ stateRoot, targetId } = {}, dependencies = {}) {
  return (dependencies.inspectPrivateLock ?? inspectPrivateLock)(await supervisorLockPath(stateRoot, targetId));
}

export async function recoverSupervisorProductionLock({ stateRoot, targetId, expectedNonce } = {}, dependencies = {}) {
  if (typeof expectedNonce !== "string" || expectedNonce.length === 0) {
    fail("E_SUPERVISOR_LOCK_NONCE_REQUIRED", "expected Supervisor lock nonceが必要です");
  }
  return (dependencies.recoverPrivateLock ?? recoverPrivateLock)(await supervisorLockPath(stateRoot, targetId), expectedNonce);
}

function validateRequest({ stateRoot, target, watchId, client, planRefs, testReceipts, timeoutSeconds }) {
  if (typeof stateRoot !== "string" || !isAbsolute(stateRoot) || !isPlainObject(target) ||
      target.schema !== "observer.project_target.v1" || !TARGET.test(target.targetId) || !isAbsolute(target.projectRoot) ||
      !WATCH.test(watchId) || !client || typeof client.read !== "function" || typeof client.wait !== "function" ||
      !Array.isArray(planRefs) || !Array.isArray(testReceipts) || !Number.isSafeInteger(timeoutSeconds) ||
      timeoutSeconds < 1 || timeoutSeconds > 3600) {
    fail("E_SUPERVISOR_PRODUCTION_INPUT_INVALID", "Supervisor production step入力が不正です");
  }
}

function validateRuntimeIdentity({ binding, generation, target, watchId }) {
  if (!isPlainObject(binding) || binding.schema !== "observer.watch_host_binding.v1" || binding.status !== "active" ||
      binding.target_id !== target.targetId || binding.watch_id !== watchId || binding.project_root !== target.projectRoot ||
      !["claude", "codex"].includes(binding.provider) || !isPlainObject(generation) || generation.status !== "active" ||
      generation.target_id !== target.targetId || generation.watch_id !== watchId || generation.provider !== binding.provider) {
    fail("E_SUPERVISOR_RUNTIME_IDENTITY_MISMATCH", "active watchとgenerationが一致しません");
  }
}

function providerAvailable(provider, runtime) {
  return provider === "codex" && isPlainObject(runtime) && runtime.provider === "codex";
}

function validateProviderRuntime(runtime, provider, binding) {
  if (provider !== "codex" || !isPlainObject(runtime) || Object.keys(runtime).sort().join(",") !== "provider,runtime_root,session" ||
      runtime.provider !== "codex" || typeof runtime.runtime_root !== "string" || !isAbsolute(runtime.runtime_root) ||
      !runtime.session || typeof runtime.session.request !== "function" || binding.launch_handle?.kind !== "codex.thread" ||
      typeof binding.launch_handle.value !== "string") {
    fail("E_SUPERVISOR_PROVIDER_RUNTIME_INVALID", "Codex provider runtimeが不正です");
  }
  return { session: runtime.session, runtimeRoot: runtime.runtime_root, threadId: binding.launch_handle.value };
}

function validateProposedParent({ proposedState, generation, target, watchId, cycleId }) {
  if (!isPlainObject(proposedState) || proposedState.status !== "ready" || proposedState.target_id !== target.targetId ||
      proposedState.project_root !== target.projectRoot || proposedState.host !== generation.provider ||
      generationParentEpochId(proposedState.host, proposedState.thread_sha256) !== generation.parent_epoch_id ||
      typeof proposedState.cursor !== "string" || !/^c_[a-f0-9]{64}$/.test(cycleId) || !WATCH.test(watchId)) {
    fail("E_SUPERVISOR_PARENT_REBIND_REQUIRED", "proposed parentはcurrent generationと一致しません");
  }
}

async function supervisorLockPath(stateRoot, targetId) {
  if (typeof stateRoot !== "string" || !isAbsolute(stateRoot) || !TARGET.test(targetId)) {
    fail("E_SUPERVISOR_PRODUCTION_INPUT_INVALID", "Supervisor lock identityが不正です");
  }
  const root = resolve(stateRoot);
  const watches = assertWithin(root, join(root, "watches"));
  const target = assertWithin(root, join(watches, targetId));
  await assertPrivateDirectory(root);
  await assertPrivateDirectory(watches);
  await assertPrivateDirectory(target);
  return join(target, "supervisor-step.lock");
}

function cursorDigest(cursor) {
  return createHash("sha256").update(`observer.cursor.v1\0${cursor}`, "utf8").digest("hex");
}

function unavailable(provider) {
  return { schema: SUPERVISOR_PRODUCTION_RESULT_SCHEMA, status: "provider_unavailable", provider, cycle_id: null };
}

function productionResult(value, provider) {
  if (!isPlainObject(value) || !["timeout", "rollover_required", "model_result_unknown", "model_pending", "committed"].includes(value.status)) {
    fail("E_SUPERVISOR_PRODUCTION_RESULT_INVALID", "Supervisor cycle resultが不正です");
  }
  const cycleId = value.status === "timeout" ? null : value.cycle_id;
  if (cycleId !== null && !/^c_[a-f0-9]{64}$/.test(cycleId)) {
    fail("E_SUPERVISOR_PRODUCTION_RESULT_INVALID", "Supervisor cycle IDが不正です");
  }
  return { schema: SUPERVISOR_PRODUCTION_RESULT_SCHEMA, status: value.status, provider, cycle_id: cycleId };
}

function currentDate(dependencies) {
  const value = dependencies.now?.() ?? new Date();
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) fail("E_SUPERVISOR_CLOCK_INVALID", "Supervisor clockが不正です");
  return date;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
