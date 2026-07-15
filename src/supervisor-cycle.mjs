import { fail, ObserverError } from "./observer-error.mjs";
import {
  commitProcessedCycle,
  cycleIdFor,
  markCycleProcessed,
  prepareCycle,
  readCycleState,
} from "./cycle-store.mjs";
import { runFixedThroughReplay, runWatchCycle } from "./watch-cycle.mjs";

export const CYCLE_RESULT_SCHEMA = "observer.cycle_result.v1";
export const DEFAULT_PROJECTION_RETRIES = 3;

export async function runSupervisorCycle({
  stateRoot,
  target,
  watchId,
  client,
  processCycle,
  timeoutSeconds = 3600,
  projectionRetries = DEFAULT_PROJECTION_RETRIES,
  signal,
  store = defaultStore,
} = {}) {
  if (typeof processCycle !== "function") fail("E_SUPERVISOR_CALLBACK", "cycle callbackが不正です");
  if (!Number.isSafeInteger(projectionRetries) || projectionRetries < 0) fail("E_SUPERVISOR_RETRY_CONFIG", "projection retry設定が不正です");
  throwIfAborted(signal);
  const cycleState = await store.readCycleState({ stateRoot, targetId: target?.targetId });
  const { committed_state: committed, pending_cycle: pending } = cycleState;

  if (pending?.status === "processed") {
    const state = await store.commitProcessedCycle({ stateRoot, targetId: target.targetId, watchId, cycleId: pending.cycle_id });
    return { status: "committed", proposed_state: state, cycle_id: pending.cycle_id, turns: [] };
  }

  let cycle;
  let pendingForCommit = pending;
  if (pending !== null && pending !== undefined) {
    requirePreparedBase({ committed, pending });
    cycle = await retryProjection(
      () => runFixedThroughReplay({ target, current: committed, throughCursor: pending.proposed_state.cursor, client, signal }),
      projectionRetries,
      signal,
    );
    requireReplayedPending({ target, pending, cycle });
  } else {
    cycle = await runNormalCycle({ target, current: committed, client, timeoutSeconds, projectionRetries, signal });
  }

  if (cycle.status === "timeout") return { status: "timeout", proposed_state: committed, turns: [] };
  if (!['oriented', 'changed'].includes(cycle.status) || cycle.proposed_state === null) {
    fail("E_SUPERVISOR_CYCLE", "supervisor cycle結果が不正です");
  }

  const prepared = pendingForCommit ?? await store.prepareCycle({
    stateRoot,
    targetId: target.targetId,
    watchId,
    baseState: committed,
    proposedState: cycle.proposed_state,
  });
  const expectedCycleId = cycleIdFor(target.targetId, committed?.cursor ?? null, cycle.proposed_state.cursor);
  if (prepared.cycle_id !== expectedCycleId || !sameParentState(prepared.proposed_state, cycle.proposed_state)) {
    fail("E_CYCLE_PENDING_CONFLICT", "prepared cycleがreplayed cycleと一致しません");
  }

  const result = await processCycle({
    cycle_id: prepared.cycle_id,
    target,
    proposed_state: cycle.proposed_state,
    turns: cycle.turns,
    signal,
  });
  validateCycleResult(result);
  await store.markCycleProcessed({
    stateRoot,
    targetId: target.targetId,
    watchId,
    cycleId: prepared.cycle_id,
    resultDigest: result.result_digest,
  });
  const state = await store.commitProcessedCycle({ stateRoot, targetId: target.targetId, watchId, cycleId: prepared.cycle_id });
  return { status: "committed", proposed_state: state, cycle_id: prepared.cycle_id, turns: cycle.turns };
}

export function validateCycleResult(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).length !== 2 || value.schema !== CYCLE_RESULT_SCHEMA || typeof value.result_digest !== "string" || !/^[a-f0-9]{64}$/.test(value.result_digest)) {
    fail("E_CYCLE_RESULT_INVALID", "cycle callback resultが不正です");
  }
  return value;
}

async function retryProjection(run, retries, signal) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    throwIfAborted(signal);
    const cycle = await run();
    if (cycle.status !== "projection_pending") return cycle;
  }
  fail("E_SUPERVISOR_PROJECTION_PENDING", "Throughline projectionが期限内に確定しません");
}

async function runNormalCycle({ target, current, client, timeoutSeconds, projectionRetries, signal }) {
  const first = await runWatchCycle({ target, current, client, timeoutSeconds, signal });
  if (first.status !== "projection_pending") return first;
  if (typeof first.fixed_through_cursor === "string") {
    return retryAfterPending(
      () => runFixedThroughReplay({ target, current, throughCursor: first.fixed_through_cursor, client, signal }),
      projectionRetries,
      signal,
    );
  }
  return retryAfterPending(
    () => runWatchCycle({ target, current, client, timeoutSeconds, signal }),
    projectionRetries,
    signal,
  );
}

async function retryAfterPending(run, retries, signal) {
  for (let attempt = 0; attempt < retries; attempt++) {
    throwIfAborted(signal);
    const cycle = await run();
    if (cycle.status !== "projection_pending") return cycle;
  }
  fail("E_SUPERVISOR_PROJECTION_PENDING", "Throughline projectionが期限内に確定しません");
}

function requirePreparedBase({ committed, pending }) {
  if (pending.status !== "prepared" || (committed?.cursor ?? null) !== pending.base_cursor) {
    fail("E_CYCLE_BASE_MISMATCH", "committed cursorがprepared cycleと一致しません");
  }
}

function requireReplayedPending({ target, pending, cycle }) {
  if (!['oriented', 'changed'].includes(cycle.status) || cycle.proposed_state === null ||
    !sameParentState(cycle.proposed_state, pending.proposed_state) ||
    cycleIdFor(target.targetId, pending.base_cursor, cycle.proposed_state.cursor) !== pending.cycle_id) {
    fail("E_CYCLE_PENDING_CONFLICT", "prepared cycleをfixed cursorで再構成できません");
  }
}

function sameParentState(left, right) { return JSON.stringify(left) === JSON.stringify(right); }

function throwIfAborted(signal) {
  if (signal?.aborted) throw new ObserverError("E_THROUGHLINE_CANCELLED", "Throughline待機が取消されました");
}

const defaultStore = { readCycleState, prepareCycle, markCycleProcessed, commitProcessedCycle };
